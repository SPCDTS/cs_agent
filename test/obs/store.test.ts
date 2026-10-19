import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsStore } from '../../src/obs/store.js';
import { Trace } from '../../src/shared/trace.js';
import { Metrics } from '../../src/obs/metrics.js';
import { registerSecrets } from '../../src/shared/redact.js';
import { startAlerts } from '../../src/obs/alerts.js';

const clean: (()=>void)[]=[];
afterEach(()=>{vi.useRealTimers(); for(const fn of clean.splice(0).reverse())fn();});
function rig(){const dir=mkdtempSync(path.join(os.tmpdir(),'cs-obs-'));const store=new ObsStore(dir);clean.push(()=>rmSync(dir,{recursive:true,force:true}),()=>store.close());return {dir,store,trace:new Trace(store)};}
describe('观测存储',()=>{
  it('WAL 写入、跨连接读取、scope 继承、筛选、分页、保留清理',()=>{
    const {dir,store,trace}=rig();
    expect(store.db.prepare('PRAGMA journal_mode').get()).toMatchObject({journal_mode:'wal'});
    for(let i=0;i<53;i++){
      trace.event('t'+i,'received',{scope:'group:7',detail:{sender:'测试'}});
      trace.event('t'+i,'routed',{detail:{route:'agent'}});
      trace.event('t'+i,'backend:pi',{durationMs:10,detail:{backend:'pi'}});
      trace.event('t'+i,'reply_sent',{detail:{terminal:true}});
    }
    const reader=new ObsStore(dir);try{expect(reader.events('t0')).toHaveLength(4);}finally{reader.close();}
    expect(store.events('t0').every(e=>e.scope==='group:7')).toBe(true);
    expect(store.tickets({scope:'group:7',status:'sent',route:'agent',backend:'pi'})).toHaveLength(50);
    expect(store.tickets({page:1})).toHaveLength(3);
    expect(store.tickets({scope:"' OR 1=1 --"})).toEqual([]);
    expect(store.throughput(0)).toEqual({total:53,failed:0,error_rate:0});
    store.metric(1,'old',{},1);
    store.append({ticket:'old',scope:'',ts:1,stage:'failed',status:'failed',duration_ms:null});
    expect(store.purge(30)).toEqual({events:1,metrics:1});
    expect(store.events('t0')).toHaveLength(4);
  });
  it('秘密先脱敏后截断，数据库和 WAL 不保存假 token',async()=>{
    const {dir,store,trace}=rig();const secret='fake-obs-credential-123456789';registerSecrets([secret]);
    trace.event('redact','received',{detail:{token:secret,tokens:'opaque-credential-value',keys:['opaque-key-value'],nested:{api_key:secret},prompt:'猫'.repeat(490)+secret,reply:secret+'字'.repeat(700),error:new Error('Bearer '+secret)}});
    const raw=store.events('redact')[0]!.detail_json;
    expect(raw).not.toContain(secret);expect(raw).not.toContain('opaque-');expect(JSON.parse(raw).prompt.length).toBeLessThanOrEqual(500);expect(JSON.parse(raw).reply.length).toBeLessThanOrEqual(500);
    expect(readFileSync(path.join(dir,'observability.sqlite-wal')).includes(Buffer.from(secret))).toBe(false);
    expect(readFileSync(path.join(dir,'observability.sqlite')).includes(Buffer.from(secret))).toBe(false);
    await expect(trace.span('redact','tool:test',async()=>{throw new Error(secret);})).rejects.toThrow(secret);
    expect(store.events('redact').at(-1)).toMatchObject({status:'failed'});
    expect(store.events('redact').at(-1)!.detail_json).not.toContain(secret);
    store.close();expect(()=>trace.event('x','failed')).not.toThrow();expect(trace.dropped).toBe(1);
  });
  it('每分钟指标包含其他进程连接，p50/p95、成功率和用量费用准确且不重复',async()=>{
    const {dir,store,trace}=rig();
    const metrics=new Metrics(store,{retentionDays:30,inputPrice:2,outputPrice:4,gauges:async()=>[{name:'queue_depth',value:2}]});
    for(const ms of [10,20,100])trace.event('t','tool:test',{durationMs:ms,status:ms===100?'failed':'ok'});
    const writer=new ObsStore(dir);writer.append({ticket:'t',scope:'',ts:Date.now(),stage:'image:collect',status:'ok',duration_ms:80,detail:{prompt_id:'pid'}});writer.close();
    trace.event('t','model_turn',{detail:{provider:'deepseek',input_tokens:100,output_tokens:20,cache_read_tokens:10}});
    await metrics.flush();
    const rows=store.db.prepare('SELECT * FROM metrics').all();
    const metric=(name:string)=>rows.find(r=>r.name===name && String(r.labels_json).includes('tool:test'))?.value;
    expect(metric('duration_p50_ms')).toBe(20);expect(metric('duration_p95_ms')).toBe(100);expect(metric('success_rate')).toBeCloseTo(2/3);
    expect(rows.find(r=>r.name==='deepseek_estimated_cost')?.value).toBeCloseTo(.0003);
    expect(rows.some(r=>String(r.labels_json).includes('image:collect'))).toBe(true);
    await metrics.flush();expect(store.db.prepare("SELECT COUNT(*) n FROM metrics WHERE name='calls'").get()).toMatchObject({n:2});
    const reopened=new Metrics(store,{retentionDays:30});await reopened.flush();
    expect(store.db.prepare("SELECT COUNT(*) n FROM metrics WHERE name='calls'").get()).toMatchObject({n:2});
  });
  it('告警默认关闭；连续失败、鉴权失败与 WS 离线共用限频',async()=>{
    vi.useFakeTimers();const {trace}=rig();let online=false;const send=vi.fn(async()=>({message_id:'fake'}));
    const bridge={status:()=>({ws_connected:online,disconnect_count:1,self_id:null,last_event_at:null}),send};
    const disabled=startAlerts({enabled:false,owner:'1',bridge,trace});
    trace.event('a','backend:codex',{status:'failed',detail:{failure:{kind:'auth',provider:'test',status:401}}});expect(send).not.toHaveBeenCalled();disabled.stop();
    const alerts=startAlerts({enabled:true,owner:'1',bridge,trace});clean.push(()=>alerts.stop());
    for(const t of ['a','b','c'])trace.event(t,'failed',{detail:{terminal:true}});
    expect(send).toHaveBeenCalledTimes(1);expect(send).toHaveBeenLastCalledWith('private','1',expect.stringContaining('连续三条'));
    trace.event('auth','backend:codex',{status:'failed',detail:{failure:{kind:'auth',provider:'test',status:401}}});expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31*60_000);expect(send).toHaveBeenCalledTimes(2);
    online=true;await vi.advanceTimersByTimeAsync(31*60_000);expect(send).toHaveBeenCalledTimes(2);
    trace.event('auth2','backend:pi',{status:'failed',detail:{failure:{kind:'auth',provider:'test',status:401}}});expect(send).toHaveBeenCalledTimes(3);
  });
});
