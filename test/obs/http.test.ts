import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { Trace } from '../../src/obs/trace.js';
import { ContextStore } from '../../src/context/store.js';
import { loadConfig } from '../../src/config.js';
import { log, logBuffer } from '../../src/log.js';
import { TRANSPARENT_PNG } from '../../src/agent/image-gen.js';
import { formatRecent } from '../../src/context/format.js';
const clean:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
async function rig(token=''){
  const dir=mkdtempSync(path.join(os.tmpdir(),'cs-obs-http-'));const store=new ObsStore(dir),context=new ContextStore(dir),trace=new Trace(store);
  const config=loadConfig({DATA_DIR:dir,OBS_TOKEN:token,NAPCAT_TOKEN:'fake-napcat-secret'});
  trace.event('ticket1','received',{scope:'group:7',detail:{text:'原文 <script>坏</script>',sender:'用户'}});
  trace.event('ticket1','routed',{detail:{route:'image'}});
  trace.event('ticket1','reply_sent',{detail:{reply:'已完成',terminal:true}});
  mkdirSync(path.join(config.imagesDir,'ticket1','call-1'),{recursive:true});writeFileSync(path.join(config.imagesDir,'ticket1','call-1','result.png'),TRANSPARENT_PNG);
  context.ingest({message_id:'m',time:Math.floor(Date.now()/1000),message_type:'group',group_id:'7',user_id:'1',self_id:'2',nickname:'小明',text:'中文历史',route_text:'中文历史',truncated:false,mentioned_self:true,images:[],segments:[]});
  const dashboard=createDashboard({config,store,context,health:()=>({ws_connected:true}),queue:()=>({active:0}),codex:async()=>({owner:null}),pi:async()=>({count:0,keys:[]})});
  const server=createServer(dashboard.handle);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  clean.push(()=>{store.close();context.close();rmSync(dir,{recursive:true,force:true});},async()=>{dashboard.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {base,dir,store,context,config};
}
it('八个页面和票据详情可离线渲染；HTML 转义；共享上下文与配置脱敏',async()=>{
  const {base,context}=await rig();const sizes:Record<string,number>={};
  for(const [url,title] of Object.entries({'/':'运行总览','/tickets':'票据列表','/tickets/ticket1':'票据全链路','/logs':'实时日志','/context':'上下文检索','/codex':'Codex 线程','/pi':'Pi 会话','/config':'生效配置'})){
    const res=await fetch(base+url);const text=await res.text();expect(res.status).toBe(200);expect(text).toContain(title);expect(text).not.toContain('fake-napcat-secret');expect(text).not.toMatch(/https:\/\/.*(?:cdn|unpkg)/);sizes[url]=Buffer.byteLength(text);
    if(url==='/tickets/ticket1'){expect(text).toContain('&lt;script&gt;');expect(text).toContain('/images/ticket1/call-1/result.png');}
  }
  console.log('HTML_BYTES '+JSON.stringify(sizes));
  const text=await (await fetch(base+'/context?scope=group%3A7')).text();expect(text).toContain(formatRecent(context.recent({kind:'scope',scope:'group:7'},{limit:30}),2500,{ids:true}));
});
it('图片路由允许本票据位图，拒绝编码穿越、Windows 路径、链接和非图片',async()=>{
  const {base,config,dir}=await rig();expect((await fetch(base+'/images/ticket1/call-1/result.png')).status).toBe(200);
  writeFileSync(path.join(config.imagesDir,'ticket1','fake.png'),'not an image, padded');
  writeFileSync(path.join(dir,'outside.png'),TRANSPARENT_PNG);
  symlinkSync(dir,path.join(config.imagesDir,'ticket1','escape'),'junction');
  // node:http 保留原始路径，避免 fetch 的 URL 规范化掩盖漏洞。
  for(const p of ['/images/ticket1/%2e%2e/%2e%2e/outside.png','/images/ticket1/%2e%2e%5coutside.png','/images/ticket1/C%3A/outside.png','/images/ticket1/fake.png','/images/ticket1/escape/outside.png','/images/ticket1/%ZZ.png']){
    const status=await new Promise<number|undefined>((resolve,reject)=>{const req=request(base+p,res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});expect(status).toBe(404);
  }
});
it('口令保护页面、图片、SSE；正确口令换 HttpOnly cookie 并移除 URL 中的口令',async()=>{
  const {base}=await rig('fake-panel-secret');
  for(const url of ['/','/logs/stream','/images/ticket1/call-1/result.png'])expect((await fetch(base+url)).status).toBe(401);
  expect((await fetch(base+'/?token=wrong')).status).toBe(401);
  const login=await fetch(base+'/?token=fake-panel-secret',{redirect:'manual'});expect(login.status).toBe(303);expect(login.headers.get('location')).toBe('/');
  expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  const res=await fetch(base+'/',{headers:{Cookie:login.headers.get('set-cookie')!.split(';')[0]!}});expect(res.status).toBe(200);
  expect(await res.text()).not.toContain('fake-panel-secret');
});
it('SSE 实时发出过滤后的结构化日志；缓冲有界且脱敏',async()=>{
  const {base}=await rig();const abort=new AbortController();
  const res=await fetch(base+'/logs/stream?ticket=sse-ticket&level=info',{signal:abort.signal});expect(res.headers.get('content-type')).toBe('text/event-stream');
  const reader=res.body!.getReader();log.info('忽略',{ticket:'elsewhere'});log.info('实时中文',{ticket:'sse-ticket',token:'fake-sensitive'});
  const chunk=await reader.read();const text=new TextDecoder().decode(chunk.value);expect(text).toContain('实时中文');expect(text).not.toContain('fake-sensitive');expect(text).not.toContain('忽略');
  abort.abort();await reader.cancel().catch(()=>undefined);expect(logBuffer.recent().length).toBeLessThanOrEqual(1000);
});
