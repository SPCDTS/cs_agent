import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createProvider, createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { ObsStore } from '../../src/obs/store.js';
import { trace } from '../../src/shared/trace.js';
import { Dispatcher } from '../../src/agent/dispatch.js';
import { CodexBackend } from '../../src/agent/backends/codex.js';
import { PiBackend } from '../../src/agent/backends/pi.js';
import { createBackendSelector, PiBackendStub } from '../../src/agent/backends/select.js';
import { createTasks } from '../../src/agent/tasks.js';
import { openHarness } from '../../src/agent/harness.js';
import { createCsAgentExtension } from '../../src/agent/extension.js';
import { TRANSPARENT_PNG, UnknownJobError } from '../../src/media/gen/image-gen.js';
import { ContextStore } from '../../src/context/store.js';
import { CodexRunner } from '../../src/agent/codex/runner.js';
import { codexObserver } from '../../src/agent/backends/codex.js';
import { savePendingImage } from '../../src/media/gen/image-pending.js';
import { observeImages } from '../../src/media/gen/observed.js';
import type { InboundMessage, ReplyTicketRecord } from '../../src/channel/types.js';
import { DeepSeekWeb } from '../../src/agent/pi-tools/web.js';
import { startAlerts } from '../../src/obs/alerts.js';
import { runAging } from '../../src/context/aging.js';
import { Metrics } from '../../src/obs/metrics.js';
import { usageCost } from '../../src/shared/usage.js';
import { ImageEventSpool } from '../../src/media/gen/events.js';
import { Trace } from '../../src/shared/trace.js';
const clean:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{trace.attach(undefined);for(const fn of clean.splice(0).reverse())await fn();});
async function rig(){
  const dir=mkdtempSync(path.join(os.tmpdir(),'cs-obs-flow-')),store=new ObsStore(dir),context=new ContextStore(dir);trace.attach(store);
  clean.push(()=>rmSync(dir,{recursive:true,force:true}),()=>{store.close();context.close();});
  const models=createModels(),faux=fauxProvider({tokensPerSecond:Infinity});models.setProvider(faux.provider);
  const states=new Map<string,string>();
  const bridge={uploadFile:async()=>({file_id:"unused"}),getTicket:async(ticket:string)=>({ticket_id:ticket,seq:1,status:states.get(ticket)??'pending'}) as ReplyTicketRecord,
    listPendingTickets:async()=>[],reply:async(ticket:string)=>{states.set(ticket,'sent');return {message_id:'reply-'+ticket,already_sent:false,message_type:'private' as const,target_id:'1'};}};
  const image={name:'fake-comfy',submit:async()=>'prompt-fake',collect:async(_id:string,out:string)=>{mkdirSync(out,{recursive:true});const file=path.join(out,'result.png');writeFileSync(file,TRANSPARENT_PNG);return [file];},reconcile:async()=>({images:[] as string[]}),clearReferences:async()=>{}};
  const codex=new CodexBackend({imagesDir:path.join(dir,'images'),ticketsDir:path.join(dir,'tickets'),reasoningEffort:'high',runner:{ask:async(_prompt,o)=>{
    await o?.onAcquired?.();o?.onJsonEvent?.({type:'item.started',item:{id:'call1',type:'mcp_tool_call',tool:'qq_recent',server:'qq_context',arguments:{limit:2}}});
    o?.onJsonEvent?.({type:'item.completed',item:{id:'call1',type:'mcp_tool_call',tool:'qq_recent',status:'completed',duration_ms:12}});return '## 假回答';
  }}});
  const tasks=createTasks({getBridge:()=>bridge,imageBackend:image,imagesDir:path.join(dir,'images'),ticketsDir:path.join(dir,'tickets'),
    backends:createBackendSelector({defaultBackend:'codex',overrides:{},backends:{codex,pi:new PiBackendStub()}}),replyRetryDelayMs:1});
  const harness=await openHarness({models,extension:createCsAgentExtension(tasks),dbFile:path.join(dir,'agent.sqlite')},BACKGROUND_CONTEXT);clean.push(()=>harness.close(BACKGROUND_CONTEXT));
  const dispatcher=new Dispatcher({harness,bridge,tasks,concurrency:2,retryDelayMs:1});
  const msg=(text:string):InboundMessage=>({message_id:'1',time:Math.floor(Date.now()/1000),message_type:'private',user_id:'1',group_id:null,self_id:'2',nickname:'测试',text,route_text:text,images:[],segments:[],truncated:false,mentioned_self:false});
  return {dir,store,context,models,faux,bridge,image,dispatcher,msg,codex};
}
it('前缀图片票据和 Codex agent 票据通过真实 dispatcher/任务，记录完整阶段与终态',async()=>{
  const r=await rig();const complete=vi.spyOn(r.models,'completeSimple');await r.dispatcher.dispatch(r.msg('奶龙: 猫'),'image');await r.dispatcher.dispatch(r.msg('你好'),'agent');
  const stages=(t:string)=>r.store.events(t).map(e=>e.stage).filter((s,i,a)=>i===0||a[i-1]!==s);
  // received 由真实桥接层记录；这里直接调用派发器，从 admitted 开始。
  expect(stages('image')).toEqual(['admitted','routed','dispatched','phase:submit','image:submit','phase:submit','phase:collect','image:collect','phase:collect','phase:reply','reply_sent','phase:reply','reply_sent']);
  expect(stages('agent')).toEqual(['admitted','routed','dispatched','phase:handle','backend:codex','thread_wait','model_turn','tool:qq_recent','model_turn','backend:codex','phase:handle','late_images','postprocess','phase:reply','reply','reply_sent','phase:reply','reply_sent']);
  expect(r.store.events('image').find(e=>e.stage==='image:submit'&&e.status==='ok')?.detail_json).toContain('prompt-fake');
  expect(r.store.events('agent').find(e=>e.stage==='tool:qq_recent'&&e.status==='ok')?.duration_ms).toBe(12);
  expect(r.store.tickets().every(t=>t.status==='sent')).toBe(true);
  expect(complete).not.toHaveBeenCalled();expect(r.faux.state.callCount).toBe(0);
  const events=r.store.events('agent');
  expect(events.filter(e=>e.stage==='model_turn')).toHaveLength(2);
  expect(events.some(e=>e.stage==='fallback'||JSON.parse(e.detail_json).operation==='relay')).toBe(false);
  expect(events.find(e=>e.stage==='postprocess'&&JSON.parse(e.detail_json).sent_text)?.detail_json).toContain('假回答');
  expect(r.dispatcher.status()).toMatchObject({active:0,waiting:0,scopes:{},tickets:[]});
});
it('业务生图失败但错误回复已送出时，票据仍统计为失败',async()=>{
  const r=await rig();r.image.submit=async()=>{throw new Error('生图超时');};await r.dispatcher.dispatch(r.msg('奶龙: 猫'),'failed-image');
  expect(r.store.events('failed-image').at(-1)?.stage).toBe('failed');expect(r.store.throughput(0)).toMatchObject({total:1,failed:1});
  expect(r.store.tickets({status:'timeout'})).toHaveLength(1);
});
it('延迟收图、对账和恢复事件保留 prompt_id，agent 后端筛选不被图片后端覆盖',async()=>{
  const r=await rig();
  r.codex.handle=async(req)=>{
    const root=path.join(r.dir,'images',req.ticket),callDir=path.join(root,'call-1');mkdirSync(callDir,{recursive:true});
    await savePendingImage(root,{backend:'fake-comfy',filenamePrefix:'late',options:{prompt:'猫'},callDir,submittedAt:Date.now(),status:'submitted',prompt_id:'late-pid'});
    return {text:'稍等'};
  };
  await r.dispatcher.dispatch(r.msg('画张猫'),'late-ticket');
  expect(r.store.events('late-ticket').some(e=>e.stage==='image:collect'&&e.detail_json.includes('late-pid'))).toBe(true);
  expect(r.store.events('late-ticket').find(e=>e.stage==='reply_sent')!.detail_json).toContain('"images":1');
  expect(r.store.tickets({backend:'codex'})).toHaveLength(1);
  const observed=observeImages({...r.image,reconcile:async(_opts:unknown,_dir:string,_signal?:AbortSignal,onStep?:(step:{step:'history';status:'matched';prompt_id:string})=>Promise<void>)=>{
    await onStep?.({step:'history',status:'matched',prompt_id:'recovered-pid'});return {images:[],prompt_id:'recovered-pid'};
  }},'reconcile');
  await observed.reconcile({filenamePrefix:'late'},r.dir);
  expect(r.store.events('reconcile').map(e=>e.stage)).toEqual(['image:collect','recovered','image:collect']);
});
it('真实 runner 读取假子进程 JSONL，解析 MCP 工具状态和耗时',async()=>{
  const r=await rig(),file=path.join(r.dir,'fake-cli.mjs');
  writeFileSync(file,`process.stdin.resume();process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'item.started',item:{id:'m1',type:'mcp_tool_call',tool:'test_tool',arguments:{prompt:'中文'}}}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'m1',type:'mcp_tool_call',tool:'test_tool',status:'failed',duration_ms:42,error:'fake failure'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'假答案'}}));
  });`,'utf8');
  const runner=new CodexRunner({command:[process.execPath,file],codexHome:path.join(r.dir,'codex'),workspaceDir:path.join(r.dir,'ws'),threadsFile:path.join(r.dir,'threads.json'),sandbox:'read-only',timeoutMs:5000});
  expect(await runner.ask('仅假 CLI',{threadKey:'group:1',onJsonEvent:codexObserver('jsonl')})).toBe('假答案');
  expect(r.store.events('jsonl').at(-1)).toMatchObject({stage:'tool:test_tool',status:'failed',duration_ms:42});
});
it('Codex 用量观测保留线程累计量，不混入单次请求的 token 字段',async()=>{
  const r=await rig();
  codexObserver('total-usage')({type:'turn.completed',usage:{input_tokens:3000000,cached_input_tokens:2000000,output_tokens:10000}});
  const event=r.store.events('total-usage').find(e=>e.stage==='model_usage')!;
  expect(JSON.parse(event.detail_json)).toEqual({backend:'codex',total_input_tokens:3000000,total_cached_input_tokens:2000000,total_output_tokens:10000});
});
it('pi 每轮模型与工具 hook 记录用量、输入和结果，不需真实 API',async()=>{
  const r=await rig();r.faux.setResponses([fauxAssistantMessage(fauxToolCall('qq_recent',{}),{stopReason:'toolUse'}),fauxAssistantMessage('假模型完成')]);
  const model=r.faux.getModel();const pi=await PiBackend.open({dataDir:r.dir,models:r.models,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',store:r.context,imageBackend:r.image,storage:new MemoryStorage()});clean.push(()=>pi.close());
  const m=r.msg('历史');
  await pi.handle({ticket:'pi-ticket',scope:'private:1',threadKey:'private:1',access:'private:1',text:m.text,source:{type:'private',user_id:'1',group_id:null,nickname:'测试'}},{signal:new AbortController().signal,onEvent:()=>{}});
  const rows=r.store.events('pi-ticket');expect(rows.filter(e=>e.stage==='model_turn'&&e.status==='started')).toHaveLength(2);
  expect(rows.filter(e=>e.stage==='model_turn'&&e.status==='ok')).toHaveLength(2);
  expect(rows.find(e=>e.stage==='tool:qq_recent'&&e.status==='ok')).toMatchObject({duration_ms:expect.any(Number)});
  expect(rows.filter(e=>e.stage==='model_turn'&&e.status==='ok').every(e=>'input_tokens' in JSON.parse(e.detail_json))).toBe(true);
});

it('真实 pi-durable 工具抛错 diagnostics 触发结构化鉴权告警，正文匹配不触发且告警限频',async()=>{
  const r=await rig();const send=vi.fn(async()=>({message_id:'alert'}));
  const alerts=startAlerts({enabled:true,owner:'1',trace,bridge:{status:()=>({ws_connected:true,disconnect_count:0,self_id:null,last_event_at:null}),send}});clean.push(()=>alerts.stop());
  trace.event('noise','tool:web_search',{status:'failed',detail:{error:'HTTP 401'}});expect(send).not.toHaveBeenCalled();
  const web=new DeepSeekWeb();web.search=async()=>{throw Object.assign(new Error('HTTP 401 fake provider'),{status:401});};
  r.faux.setResponses([fauxAssistantMessage(fauxToolCall('web_search',{query:'test'}),{stopReason:'toolUse'}),fauxAssistantMessage('检索失败')]);
  const model=r.faux.getModel(),pi=await PiBackend.open({dataDir:r.dir,models:r.models,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',store:r.context,imageBackend:r.image,web,storage:new MemoryStorage()});clean.push(()=>pi.close());
  await pi.handle({ticket:'auth-tool',scope:'private:1',threadKey:'private:1',access:'private:1',text:'检索',source:{type:'private',user_id:'1',group_id:null,nickname:'测试'}},{signal:new AbortController().signal,onEvent:()=>{}});
  const failed=r.store.events('auth-tool').find(e=>e.stage==='tool:web_search'&&e.status==='failed')!;
  const detail=JSON.parse(failed.detail_json);expect(detail.failure).toEqual({kind:'auth',provider:'deepseek',status:401});
  expect(detail.output.diagnostics[0]).toMatchObject({code:'tool_error',message:'HTTP 401 fake provider'});
  expect(send).toHaveBeenCalledTimes(1);
  codexObserver('auth-codex')({type:'item.completed',item:{type:'mcp_tool_call',tool:'search',server:'web',status:'failed',error:{message:'opaque',status:403}}});
  expect(JSON.parse(r.store.events('auth-codex')[0]!.detail_json).failure.kind).toBe('auth');expect(send).toHaveBeenCalledTimes(1);
  r.image.submit=async()=>{throw Object.assign(new Error('opaque image error'),{status:403});};
  r.faux.setResponses([fauxAssistantMessage(fauxToolCall('generate_image',{prompt:'fake'}),{stopReason:'toolUse'}),fauxAssistantMessage('生图失败')]);
  await pi.handle({ticket:'auth-image',scope:'private:1',threadKey:'private:1',access:'private:1',text:'画图',source:{type:'private',user_id:'1',group_id:null,nickname:'测试'}},{signal:new AbortController().signal,onEvent:()=>{}});
  const imageFailure=r.store.events('auth-image').find(e=>e.stage==='tool:generate_image'&&e.status==='failed')!;
  expect(JSON.parse(imageFailure.detail_json).failure).toEqual({kind:'auth',provider:'comfy',status:403});expect(send).toHaveBeenCalledTimes(1);
});
it('Codex 排队时间与模型时间分别记录，backend span 保留总耗时',async()=>{
  const r=await rig();let now=1000;const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);clean.push(()=>clock.mockRestore());
  const backend=new CodexBackend({imagesDir:path.join(r.dir,'images'),ticketsDir:path.join(r.dir,'tickets'),runner:{ask:async(_prompt,opts)=>{
    now=1400;await opts?.onAcquired?.();now=1500;return '假答复';
  }}});
  await trace.span('timing','backend:codex',()=>backend.handle({ticket:'timing',scope:'private:1',threadKey:'private:1',access:'private:1',text:'hello',source:{type:'private',user_id:'1',group_id:null,nickname:'test'}},{signal:new AbortController().signal,onEvent:()=>{}}));
  const rows=r.store.events('timing');expect(rows.find(e=>e.stage==='thread_wait'&&e.status==='started')).toBeTruthy();expect(rows.find(e=>e.stage==='thread_wait'&&e.status==='ok')?.duration_ms).toBe(400);
  const model=rows.find(e=>e.stage==='model_turn'&&e.status==='ok')!;expect(model.duration_ms).toBe(100);
  expect(JSON.parse(model.detail_json)).toMatchObject({thread_wait_ms:400,model_ms:100});expect(rows.at(-1)?.duration_ms).toBe(500);
});
it('Codex 内置命令和搜索只保存白名单摘要，每轮最多 100 条且不存原始 JSONL',async()=>{
  const r=await rig(),observe=codexObserver('builtin');
  observe({type:'item.started',item:{id:'cmd',type:'command_execution'}});
  observe({type:'item.completed',raw:'forbidden-raw',item:{id:'cmd',type:'command_execution',command:'c'.repeat(300),exit_code:2,duration_ms:25,aggregated_output:'forbidden-output'}});
  for(let i=0;i<130;i++)observe({type:'item.completed',item:{id:'search'+i,type:'web_search',query:'q'.repeat(300),results:'forbidden-results'}});
  // 开始事件（实时视图用）单独一行，完成事件仍最多 100 条
  const all=r.store.events('builtin');expect(all[0]).toMatchObject({stage:'tool:command_execution',status:'started'});
  const rows=all.filter(e=>e.status!=='started');expect(rows).toHaveLength(100);expect(rows[0]).toMatchObject({stage:'tool:command_execution',status:'failed',duration_ms:25});
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
  const pi=await PiBackend.open({dataDir:r.dir,models:r.models,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',store:r.context,imageBackend:r.image,storage:new MemoryStorage()});clean.push(()=>pi.close());
  await pi.handle({ticket:'usage-pi',scope:'private:1',threadKey:'private:1',access:'private:1',text:'hello',source:{type:'private',user_id:'1',group_id:null,nickname:'test'}},{signal:new AbortController().signal,onEvent:()=>{}});
  const now=Date.UTC(2026,9,21,3),day=Date.UTC(2026,9,20)/1000;
  for(let i=0;i<5;i++)r.context.ingest({...r.msg('历史'+i),message_id:'history'+i,time:day+i});
  const report=await runAging({store:r.context,models:r.models,model,rawDays:30,summaryDays:180,hour:3,now:()=>now});expect(report.day_summaries).toBe(1);
  const metrics=new Metrics(r.store,{retentionDays:365,inputPrice:2,outputPrice:4});await metrics.flush();
  expect(r.store.db.prepare("SELECT value FROM metrics WHERE name='deepseek_estimated_cost'").get()?.value).toBeCloseTo(.00072);
  for(const ticket of ['usage-pi','@aging']){
    const d=JSON.parse(r.store.events(ticket).find(e=>e.stage==='model_turn'&&e.status==='ok')!.detail_json);
    expect(d).toMatchObject({input_tokens:100,output_tokens:20,cache_read_tokens:30,cache_write_tokens:10});
    expect(usageCost({input:d.input_tokens,output:d.output_tokens,cacheRead:d.cache_read_tokens,cacheWrite:d.cache_write_tokens},2,4).cost).toBe(.00036);
  }
});
it('lateImages 与终态回收都会摄取 MCP 旁路事件',async()=>{
  const r=await rig();
  r.codex.handle=async req=>{
    const dir=path.join(r.dir,'images',req.ticket);mkdirSync(dir,{recursive:true});
    new Trace(new ImageEventSpool(dir)).event(req.ticket,'image:submit',{detail:{prompt_id:'late-spool'}});
    return {text:'完成'};
  };
  await r.dispatcher.dispatch(r.msg('hello'),'spool-flow');
  expect(r.store.events('spool-flow').some(e=>e.stage==='image:submit'&&e.detail_json.includes('late-spool'))).toBe(true);
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
