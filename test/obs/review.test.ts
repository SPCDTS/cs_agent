import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ObsStore } from '../../src/obs/store.js';
import { Trace } from '../../src/shared/trace.js';
import { Metrics } from '../../src/obs/metrics.js';
import { redactText, registerSecrets } from '../../src/shared/redact.js';
import { loadConfig } from '../../src/config.js';
import { publicHealth, loadObsToken } from '../../src/obs/token.js';
import { buildImageEnv } from '../../src/media/gen/image-gen.js';
import { buildCodexEnv, CodexRunner } from '../../src/agent/codex-runner.js';
import { ImageEventSpool, ingestImageEvents, IMAGE_EVENT_BYTES } from '../../src/obs/image-events.js';
const clean: (()=>void)[]=[];
afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
function rig(cap=500) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'cs-obs-review-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new ObsStore(dir,cap);clean.push(()=>store.close());
  return {dir,store,trace:new Trace(store)};
}
it('任何协议 URL 的 userinfo 脱敏，NapCat URL 拒绝内嵌凭据',()=>{
  for(const scheme of ['ws','wss','https','ftp','custom+service']){
    expect(redactText(`${scheme}://alice:p%40ss@example.com/path`)).not.toMatch(/alice|p%40ss/);
    expect(redactText(`${scheme}://alice@example.com/path`)).not.toContain('alice');
  }
  for(const key of ['NAPCAT_HTTP_URL','NAPCAT_WS_URL'])expect(()=>loadConfig({[key]:'wss://alice:pass@example.com'})).toThrow('不得包含');
});
it('口令原子发布仅记录一次，子进程白名单排除 OBS_TOKEN，健康 JSON 不含敏感详情',async()=>{
  const {dir}=rig();const logs:string[]=[];
  const tokens=await Promise.all(Array.from({length:4},()=>loadObsToken(dir,'',m=>logs.push(m))));
  expect(new Set(tokens).size).toBe(1);expect(logs).toEqual(['observability token generated at /data/obs-token']);
  expect(buildCodexEnv(dir,{OBS_TOKEN:'fake-secret',PATH:'fake-path'})).not.toHaveProperty('OBS_TOKEN');
  expect(buildImageEnv({baseEnv:{OBS_TOKEN:'fake-secret',PATH:'path'},comfyUrl:'http://127.0.0.1',comfyBin:'fake'})).not.toHaveProperty('OBS_TOKEN');
  const cli=path.join(dir,'fake-env.mjs');writeFileSync(cli,`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:String(!!process.env.OBS_TOKEN)}})));`,'utf8');
  const runner=new CodexRunner({command:[process.execPath,cli],codexHome:path.join(dir,'codex'),workspaceDir:path.join(dir,'ws'),threadsFile:path.join(dir,'threads.json'),sandbox:'read-only',timeoutMs:5000,env:{OBS_TOKEN:'fake-secret'}});
  expect(await runner.ask('fake CLI only', { threadKey: "group:1" })).toBe('false');
  const health=JSON.stringify(publicHealth({connected:true,degraded:true,comfy:{ok:false,error:'fake-secret',server:'http://private'},codex:{ok:true,error:'fake-secret'},threads:{owner:'thread-1'},pi:{count:0,keys:[]}}));
  expect(health).not.toMatch(/fake-secret|private/);expect(health).toContain('thread-1');expect(health).toContain('"degraded":true');
});
it.each(['corrupt','unwritable','schema'] as const)('观测数据库 %s 初始化失败降级为无操作存储',async(kind)=>{
  const {dir}=rig();const isolated=path.join(dir,'bad');mkdirSync(isolated);
  let target=isolated;
  if(kind==='corrupt')writeFileSync(path.join(isolated,'observability.sqlite'),'invalid sqlite');
  if(kind==='unwritable'){target=path.join(isolated,'file');writeFileSync(target,'blocks directory creation');}
  if(kind==='schema'){const db=new DatabaseSync(path.join(isolated,'observability.sqlite'));db.exec('CREATE TABLE events(wrong TEXT)');db.close();}
  const store=new ObsStore(target);clean.push(()=>store.close());expect(store.degraded).toBe(true);
  const trace=new Trace(store);expect(()=>trace.event('t','received')).not.toThrow();expect(store.events('t')).toEqual([]);
  expect(store.tickets()).toEqual([]);expect(store.latest('aging')).toBeUndefined();expect(store.throughput(0).total).toBe(0);
  const metrics=new Metrics(store,{retentionDays:30});await expect(metrics.flush()).resolves.toBeUndefined();await metrics.stop();
});
it('指标游标 schema 失败同样降级，不使构造或刷新抛出',async()=>{
  const {store}=rig();store.db.exec('DROP TABLE obs_state');const metrics=new Metrics(store,{retentionDays:30});
  expect(store.degraded).toBe(true);await expect(metrics.flush()).resolves.toBeUndefined();
});
it('票据事件和字节预算保留三种终态，摘要准确统计丢弃，游标无重复',()=>{
  const {store,trace}=rig(12);
  for(let i=0;i<40;i++)trace.event('t','received',{detail:{index:i}});
  for(const stage of ['reply_sent','failed','fallback'])trace.event('t',stage,{detail:{terminal:true}});
  const rows=store.events('t');expect(rows).toHaveLength(12);
  expect(JSON.parse(rows.find(e=>e.stage==='events_dropped')!.detail_json).dropped).toBe(32);
  expect(rows.slice(-3).map(e=>e.stage)).toEqual(['reply_sent','failed','fallback']);
  const first=store.events('t',{limit:5}),second=store.events('t',{after:first.at(-1)!.id,limit:5});
  expect(new Set([...first,...second].map(e=>e.id)).size).toBe(10);
  for(let i=0;i<30;i++)trace.event('bytes','payload',{detail:{fields:Array.from({length:100},()=> '汉'.repeat(500))}});
  trace.event('bytes','reply_sent',{detail:{terminal:true,reply:'汉'.repeat(500)}});
  const bounded=store.events('bytes');expect(bounded.reduce((n,e)=>n+Buffer.byteLength(e.detail_json),0)).toBeLessThanOrEqual(256*1024);
  expect(bounded.at(-1)?.stage).toBe('reply_sent');expect(bounded.some(e=>e.stage==='events_dropped')).toBe(true);
});
it('重复 Codex 进度保留首条、末条和更新次数',()=>{
  const {store,trace}=rig();
  for(let i=0;i<1000;i++)trace.event('progress','tool:test',{status:'started',detail:{backend:'codex',call_id:'call',input:'first-'+i}});
  trace.event('progress','tool:test',{detail:{backend:'codex',call_id:'call',output:'done'}});
  const rows=store.events('progress');expect(rows).toHaveLength(3);expect(rows[0]!.detail_json).toContain('first-0');expect(JSON.parse(rows[1]!.detail_json).count).toBe(1000);expect(JSON.parse(rows[1]!.detail_json).input).toBe('first-999');
});
it('子进程旁路文件经主进程秘密表脱敏后入库并删除，且 schema 拒绝伪造终态',async()=>{
  const {dir,store,trace}=rig();const ticket=path.join(dir,'images','child');mkdirSync(ticket,{recursive:true});
  const secret='only-main-knows-this-secret';registerSecrets([secret]);
  const event={ts:Date.now(),stage:'image:submit',status:'ok',duration_ms:3,detail:{prompt:'猫 '+secret,prompt_id:'p'}};
  execFileSync(process.execPath,['-e',`require('node:fs').appendFileSync(process.argv[1],process.argv[2],'utf8')`,path.join(ticket,'obs-events.jsonl'),JSON.stringify(event)+'\n'+JSON.stringify({...event,stage:'reply_sent'})+'\n']);
  await ingestImageEvents(ticket,trace);const rows=store.events('child');expect(rows).toHaveLength(1);expect(rows[0]!.ts).toBe(event.ts);expect(rows[0]!.detail_json).not.toContain(secret);expect(rows[0]!.detail_json).toContain('[已隐藏]');
  expect(existsSync(path.join(ticket,'obs-events.jsonl'))).toBe(false);
  expect(readFileSync(path.join(dir,'observability.sqlite-wal')).includes(Buffer.from(secret))).toBe(false);
});
it('MCP 事件写入最多 200 行 256 KiB，超大输入文件忽略并删除',async()=>{
  const {dir,store,trace}=rig();const ticket=path.join(dir,'images','bounded');mkdirSync(ticket,{recursive:true});
  const spool=new Trace(new ImageEventSpool(ticket));for(let i=0;i<400;i++)spool.event('ignored','image:collect',{detail:{i}});
  const file=path.join(ticket,'obs-events.jsonl'),raw=readFileSync(file);expect(raw.length).toBeLessThanOrEqual(IMAGE_EVENT_BYTES);expect(raw.toString().trim().split('\n')).toHaveLength(200);
  await ingestImageEvents(ticket,trace);expect(store.events('bounded')).toHaveLength(200);
  writeFileSync(file,'x'.repeat(IMAGE_EVENT_BYTES+1));await ingestImageEvents(ticket,trace);expect(existsSync(file)).toBe(false);expect(store.events('bounded')).toHaveLength(200);
  const denied=new Trace(new ImageEventSpool(path.join(dir,'missing','child')));expect(()=>denied.event('t','image:submit')).not.toThrow();
});
