import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createModels, createProvider, createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { ObsStore } from '../../src/obs/store.js';
import { trace } from '../../src/shared/trace.js';
import { CodexBackend } from '../../src/agent/backends/codex.js';
import { PiBackend, type PiBackendOptions } from '../../src/agent/backends/pi.js';
import { ContextStore } from '../../src/context/store.js';
import { observeItem } from '../../src/agent/backends/codex.js';
import { CodexScript, codexRunnerRig } from '../agent/codex-fixture.js';
import type { InboundMessage, InboundRecord } from '../../src/channel/types.js';
import { DeepSeekWeb } from '../../src/agent/pi-tools/web.js';
import { startAlerts } from '../../src/obs/alerts.js';
import { runAging } from '../../src/context/aging.js';
import { Metrics } from '../../src/obs/metrics.js';
import { usageCost } from '../../src/shared/usage.js';
const clean:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{trace.attach(undefined);for(const fn of clean.splice(0).reverse())await fn();});
/**
 * 会话宿主的最小替身：一条私聊输入、user 身份；回合 id 固定为 name，工具与模型事件记在 turn:<name>。
 * 返回 run(text) 开一轮并等回合结束。
 */
function hostStub(name:string){
  const records=new Map<string,InboundRecord>();
  // pi 回合的 id 以适配器为准（宿主当前回合须与 pi 当前 run 一致），开轮后写回
  const state:{turnId?:string}={turnId:name};
  const turns={
    binding:(threadKey:string)=>({threadKey,identity:{kind:'user' as const,sender:'1'},scope:'private:1',...(state.turnId?{turnId:state.turnId}:{}),inputs:[...records.keys()],inputKey:[...records.keys()].at(-1)}),
    records:(inputs:readonly {inboundKey:string}[])=>inputs.map(i=>records.get(i.inboundKey)!),
    render:async(recs:readonly InboundRecord[])=>({text:recs.map(r=>r.text).join('\n'),images:[],source:{type:'private' as const,user_id:'1',group_id:null,nickname:'测试'}}),
  };
  return {turns,records,state};
}
async function piTurn(pi:PiBackend,stub:ReturnType<typeof hostStub>,key:string,text:string){
  stub.records.set(key,{key,kind:'user',seq:stub.records.size+1,scope:'private:1',thread_key:'private:1',self_id:'2',user_id:'1',group_id:null,message_type:'private',
    message_id:key,nickname:'测试',text,route_text:text,time:1,images:[],attachments:[],created_at:new Date().toISOString(),state:'queued'});
  let done!:(status:string)=>void;const ended=new Promise<string>(r=>{done=r;});
  pi.bind({onTurnStarted:()=>{},onActivity:()=>{},onTurnCompleted:(_k,_t,result)=>done(result.status)});
  stub.state.turnId=undefined;
  const started=await pi.startTurn('private:1',[{inboundKey:key,kind:'user',sender:'1',seq:1,at:1}],{kind:'user',sender:'1'});
  if('turnId' in started)stub.state.turnId=started.turnId;
  return ended;
}
async function openPi(r:Awaited<ReturnType<typeof rig>>,name:string,extra:Partial<PiBackendOptions>={}){
  const stub=hostStub(name),model=r.faux.getModel();
  const pi=await PiBackend.open({dataDir:r.dir,models:r.models,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',store:r.context,storage:new MemoryStorage(),turns:stub.turns,...extra});
  clean.push(()=>pi.close());
  return {pi,stub,run:(key:string,text:string)=>piTurn(pi,stub,key,text)};
}
function codexStub(name:string){
  const stub=hostStub(name);
  stub.records.set('in-'+name,{key:'in-'+name,kind:'user',seq:1,scope:'private:1',thread_key:'private:1',self_id:'2',user_id:'1',group_id:null,message_type:'private',
    message_id:'1',nickname:'测试',text:'你好',route_text:'你好',time:1,images:[],attachments:[],created_at:new Date().toISOString(),state:'queued'});
  return stub;
}
/** 常驻 codex 适配器（内存版 app-server）；script.onTurn 在回合内发条目或写文件。 */
async function codexBackend(name:string,script:CodexScript,extra:Partial<ConstructorParameters<typeof CodexBackend>[0]>={}){
  const live=await codexRunnerRig({handlers:script.handlers});clean.push(()=>live.close());
  return new CodexBackend({runner:live.runner,tokens:{issue:()=>'a'.repeat(64),revoke:()=>undefined},imagesDir:path.join(live.dir,'images'),
    turns:codexStub(name).turns,...extra});
}
async function codexTurn(backend:CodexBackend){
  let done!:()=>void;const ended=new Promise<void>(r=>{done=r;});
  backend.attach({onTurnStarted:()=>{},onActivity:()=>{},onTurnCompleted:()=>done()});
  const {turnId}=await backend.startTurn('private:1',[],{kind:'user',sender:'1'}) as {turnId:string};
  await ended;return 'turn:'+turnId;
}
async function rig(){
  const dir=mkdtempSync(path.join(os.tmpdir(),'cs-obs-flow-')),store=new ObsStore(dir),context=new ContextStore(dir);trace.attach(store);
  clean.push(()=>rmSync(dir,{recursive:true,force:true}),()=>{store.close();context.close();});
  const models=createModels(),faux=fauxProvider({tokensPerSecond:Infinity});models.setProvider(faux.provider);
  const script=new CodexScript();
  script.onTurn=t=>{
    t.child.notify('item/started',{threadId:t.threadId,turnId:t.turnId,item:{id:'call1',type:'mcpToolCall',tool:'qq_recent',server:'qq_context',status:'inProgress',arguments:{limit:2}}});
    t.child.notify('item/completed',{threadId:t.threadId,turnId:t.turnId,item:{id:'call1',type:'mcpToolCall',tool:'qq_recent',server:'qq_context',status:'completed',durationMs:12}});
    t.child.notify('item/completed',{threadId:t.threadId,turnId:t.turnId,item:{id:'msg1',type:'agentMessage',text:'## 假回答'}});
  };
  const codex=await codexBackend('agent',script,{reasoningEffort:'high'});
  const msg=(text:string):InboundMessage=>({message_id:'1',time:Math.floor(Date.now()/1000),message_type:'private',user_id:'1',group_id:null,self_id:'2',nickname:'测试',text,route_text:text,images:[],segments:[],truncated:false,mentioned_self:false});
  return {dir,store,context,models,faux,msg,codex};
}
it('Codex 回合走适配层，记录完整阶段',async()=>{
  const r=await rig();const complete=vi.spyOn(r.models,'completeSimple');
  const agent=await codexTurn(r.codex);
  const stages=(t:string)=>r.store.events(t).map(e=>e.stage).filter((s,i,a)=>i===0||a[i-1]!==s);
  // 回合键 turn:<id>：适配层只记后端事件；输入、终态与发送由宿主事件和 Outbox 另记。
  expect(stages(agent)).toEqual(['dispatched','model_turn','tool:qq_recent','final_answer','model_turn']);
  expect(r.store.events(agent).find(e=>e.stage==='tool:qq_recent'&&e.status==='ok')?.duration_ms).toBe(12);
  expect(JSON.parse(r.store.events(agent).find(e=>e.stage==='dispatched')!.detail_json)).toMatchObject({backend:'codex',thread_key:'private:1',kind:'user',effort:'high'});
  expect(complete).not.toHaveBeenCalled();expect(r.faux.state.callCount).toBe(0);
  const events=r.store.events(agent);
  expect(events.filter(e=>e.stage==='model_turn')).toHaveLength(2);
  expect(events.some(e=>e.stage==='fallback'||e.stage==='delivery_note')).toBe(false);
  expect(events.find(e=>e.stage==='final_answer'&&JSON.parse(e.detail_json).text)?.detail_json).toContain('假回答');
});
it('app-server 条目解析 MCP 工具状态和耗时，最终回答单独记录',async()=>{
  const r=await rig();
  observeItem('items','started',{id:'m1',type:'mcpToolCall',tool:'test_tool',server:'x',arguments:{prompt:'中文'}});
  observeItem('items','completed',{id:'m1',type:'mcpToolCall',tool:'test_tool',server:'x',status:'failed',durationMs:42,error:'fake failure'});
  observeItem('items','completed',{id:'a1',type:'agentMessage',text:'假答案'});
  const rows=r.store.events('items');
  expect(rows.map(e=>[e.stage,e.status])).toEqual([['tool:test_tool','started'],['tool:test_tool','failed'],['final_answer','ok']]);
  expect(rows[1]).toMatchObject({duration_ms:42});
});
it('pi 每轮模型与工具 hook 记录用量、输入和结果，不需真实 API',async()=>{
  const r=await rig();r.faux.setResponses([fauxAssistantMessage(fauxToolCall('qq_recent',{}),{stopReason:'toolUse'}),fauxAssistantMessage('假模型完成')]);
  const p=await openPi(r,'pi-ticket');
  expect(await p.run('in-1','历史')).toBe('completed');
  const rows=r.store.events('turn:'+p.stub.state.turnId);expect(rows.filter(e=>e.stage==='model_turn'&&e.status==='started')).toHaveLength(2);
  expect(rows.filter(e=>e.stage==='model_turn'&&e.status==='ok')).toHaveLength(2);
  expect(rows.find(e=>e.stage==='tool:qq_recent'&&e.status==='ok')).toMatchObject({duration_ms:expect.any(Number)});
  expect(rows.filter(e=>e.stage==='model_turn'&&e.status==='ok').every(e=>'input_tokens' in JSON.parse(e.detail_json))).toBe(true);
});

it('真实 pi-durable 工具抛错 diagnostics 触发结构化鉴权告警，正文匹配不触发且告警限频',async()=>{
  const r=await rig();const send=vi.fn(async()=>({message_id:'alert'}));
  const alerts=startAlerts({enabled:true,owner:'1',trace,bridge:{status:()=>({ws_connected:true,disconnect_count:0,self_id:null,last_event_at:null}),sendOps:send}});clean.push(()=>alerts.stop());
  trace.event('noise','tool:web_search',{status:'failed',detail:{error:'HTTP 401'}});expect(send).not.toHaveBeenCalled();
  const web=new DeepSeekWeb();web.search=async()=>{throw Object.assign(new Error('HTTP 401 fake provider'),{status:401});};
  r.faux.setResponses([fauxAssistantMessage(fauxToolCall('web_search',{query:'test'}),{stopReason:'toolUse'}),fauxAssistantMessage('检索失败')]);
  const p=await openPi(r,'auth-tool',{web});
  await p.run('in-1','检索');
  const failed=r.store.events('turn:'+p.stub.state.turnId).find(e=>e.stage==='tool:web_search'&&e.status==='failed')!;
  const detail=JSON.parse(failed.detail_json);expect(detail.failure).toEqual({kind:'auth',provider:'deepseek',status:401});
  expect(detail.output.diagnostics[0]).toMatchObject({code:'tool_error',message:'HTTP 401 fake provider'});
  expect(send).toHaveBeenCalledTimes(1);
  observeItem('auth-codex','completed',{type:'mcpToolCall',id:'s1',tool:'search',server:'web',status:'failed',error:{message:'opaque',status:403}});
  expect(JSON.parse(r.store.events('auth-codex')[0]!.detail_json).failure.kind).toBe('auth');expect(send).toHaveBeenCalledTimes(1);
});
it('Codex 回合从 turn/start 到 turn/completed 记一次 model_turn 时长，结果写在 detail',async()=>{
  const r=await rig();
  const script=new CodexScript();script.onTurn=()=>new Promise(resolve=>setTimeout(resolve,60));
  const key=await codexTurn(await codexBackend('timing',script));
  const model=r.store.events(key).find(e=>e.stage==='model_turn'&&e.status==='ok')!;
  expect(model.duration_ms).toBeGreaterThanOrEqual(50);
  expect(JSON.parse(model.detail_json)).toMatchObject({backend:'codex',thread_key:'private:1',status:'completed'});
});
it('Codex 内置命令和搜索只保存白名单摘要，不存原始条目',async()=>{
  const r=await rig();
  observeItem('builtin','started',{id:'cmd',type:'commandExecution',command:'ls'});
  observeItem('builtin','completed',{id:'cmd',type:'commandExecution',command:'c'.repeat(300),exitCode:2,durationMs:25,aggregatedOutput:'forbidden-output',raw:'forbidden-raw'});
  observeItem('builtin','completed',{id:'search',type:'webSearch',query:'q'.repeat(300),results:'forbidden-results'});
  const all=r.store.events('builtin');expect(all[0]).toMatchObject({stage:'tool:command_execution',status:'started'});
  const rows=all.filter(e=>e.status!=='started');expect(rows[0]).toMatchObject({stage:'tool:command_execution',status:'failed',duration_ms:25});
  expect(JSON.parse(rows[0]!.detail_json)).toMatchObject({exit_code:2});
  expect(JSON.parse(rows[0]!.detail_json).command.length).toBe(200);expect(JSON.parse(rows[1]!.detail_json).query.length).toBe(200);
  expect(rows.map(e=>e.detail_json).join('')).not.toContain('forbidden-');
});
it('pi、衰老使用同一非零缓存 usage fixture，费用口径一致',async()=>{
  const r=await rig();const usage={input:100,output:20,cacheRead:30,cacheWrite:10,totalTokens:160,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const model={...r.faux.getModel(),provider:"deepseek"};
  const stream=()=>{
    const events=createAssistantMessageEventStream();
    const message={...fauxAssistantMessage('假回答'),provider:model.provider,model:model.id,usage};
    events.push({type:'done',reason:'stop',message});events.end(message);return events;
  };
  r.models.setProvider(createProvider({id:model.provider,models:[model],auth:{apiKey:{name:'fixture',resolve:async()=>({auth:{}})}},api:{stream,streamSimple:stream}}));
  const stub=hostStub('usage-pi');
  const pi=await PiBackend.open({dataDir:r.dir,models:r.models,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',store:r.context,storage:new MemoryStorage(),turns:stub.turns});clean.push(()=>pi.close());
  await piTurn(pi,stub,'in-1','hello');
  const now=Date.UTC(2026,9,21,3),day=Date.UTC(2026,9,20)/1000;
  for(let i=0;i<5;i++)r.context.ingest({...r.msg('历史'+i),message_id:'history'+i,time:day+i});
  const report=await runAging({store:r.context,models:r.models,model:()=>model,rawDays:30,summaryDays:180,hour:3,now:()=>now});expect(report.day_summaries).toBe(1);
  const metrics=new Metrics(r.store,{retentionDays:365,inputPrice:2,outputPrice:4});await metrics.flush();
  expect(r.store.db.prepare("SELECT value FROM metrics WHERE name='deepseek_estimated_cost'").get()?.value).toBeCloseTo(.00072);
  for(const ticket of ['turn:'+stub.state.turnId,'@aging']){
    const d=JSON.parse(r.store.events(ticket).find(e=>e.stage==='model_turn'&&e.status==='ok')!.detail_json);
    expect(d).toMatchObject({input_tokens:100,output_tokens:20,cache_read_tokens:30,cache_write_tokens:10});
    expect(usageCost({input:d.input_tokens,output:d.output_tokens,cacheRead:d.cache_read_tokens,cacheWrite:d.cache_write_tokens},2,4).cost).toBe(.00036);
  }
});
it('历史 relay 用量按通用模型事件聚合，缺缓存字段可读且重启不重复计费',async()=>{
  const r=await rig();
  const detail={operation:'relay',provider:'deepseek',model:'legacy-model',input_tokens:100,output_tokens:20};
  trace.event('legacy-usage','model_turn',{status:'started',detail});
  trace.event('legacy-usage','model_turn',{status:'ok',durationMs:20,detail});
  trace.event('legacy-usage','fallback',{status:'failed',detail:{operation:'relay',terminal:false}});
  trace.event('legacy-usage','reply_sent',{detail:{terminal:true}});
  const options={retentionDays:365,inputPrice:2,outputPrice:4};
  await new Metrics(r.store,options).flush();
  await new Metrics(r.store,options).flush(Date.now()+1);
  const total=(name:string)=>r.store.db.prepare('SELECT SUM(value) value FROM metrics WHERE name=?').get(name)?.value;
  expect(total('deepseek_input_tokens')).toBe(100);
  expect(total('deepseek_output_tokens')).toBe(20);
  expect(total('deepseek_estimated_cost')).toBeCloseTo(.00028);
  expect(r.store.degraded).toBe(false);
  expect(r.store.throughput(0)).toMatchObject({total:1,failed:0});
});
