import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { ObsStore } from '../../src/obs/store.js';
import { trace } from '../../src/obs/trace.js';
import { Dispatcher } from '../../src/agent/dispatch.js';
import { CodexBackend } from '../../src/agent/backends/codex.js';
import { PiBackend } from '../../src/agent/backends/pi.js';
import { createBackendSelector, PiBackendStub } from '../../src/agent/backends/select.js';
import { createTasks } from '../../src/agent/tasks.js';
import { openHarness } from '../../src/agent/harness.js';
import { createCsAgentExtension } from '../../src/agent/extension.js';
import { TRANSPARENT_PNG, UnknownJobError } from '../../src/agent/image-gen.js';
import { ContextStore } from '../../src/context/store.js';
import { CodexRunner } from '../../src/agent/codex-runner.js';
import { codexObserver } from '../../src/agent/backends/codex.js';
import { savePendingImage } from '../../src/agent/image-pending.js';
import { observeImages } from '../../src/obs/image.js';
import type { InboundMessage, ReplyTicketRecord } from '../../src/qq/types.js';
const clean:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{trace.attach(undefined);for(const fn of clean.splice(0).reverse())await fn();});
async function rig(){
  const dir=mkdtempSync(path.join(os.tmpdir(),'cs-obs-flow-')),store=new ObsStore(dir),context=new ContextStore(dir);trace.attach(store);
  clean.push(()=>rmSync(dir,{recursive:true,force:true}),()=>{store.close();context.close();});
  const models=createModels(),faux=fauxProvider({tokensPerSecond:Infinity});models.setProvider(faux.provider);
  const states=new Map<string,string>();
  const bridge={getTicket:async(ticket:string)=>({ticket_id:ticket,seq:1,status:states.get(ticket)??'pending'}) as ReplyTicketRecord,
    listPendingTickets:async()=>[],reply:async(ticket:string)=>{states.set(ticket,'sent');return {message_id:'reply-'+ticket,already_sent:false,message_type:'private' as const,target_id:'1'};}};
  const image={name:'fake-comfy',submit:async()=>'prompt-fake',collect:async(_id:string,out:string)=>{mkdirSync(out,{recursive:true});const file=path.join(out,'result.png');writeFileSync(file,TRANSPARENT_PNG);return [file];},reconcile:async()=>({images:[] as string[]}),clearReferences:async()=>{}};
  const codex=new CodexBackend({imagesDir:path.join(dir,'images'),ticketsDir:path.join(dir,'tickets'),reasoningEffort:'high',runner:{ask:async(_prompt,o)=>{
    await o?.onAcquired?.();o?.onJsonEvent?.({type:'item.started',item:{id:'call1',type:'mcp_tool_call',tool:'qq_recent',server:'qq_context',arguments:{limit:2}}});
    o?.onJsonEvent?.({type:'item.completed',item:{id:'call1',type:'mcp_tool_call',tool:'qq_recent',status:'completed',duration_ms:12}});return '## 假回答';
  }}});
  const tasks=createTasks({getBridge:()=>bridge,imageBackend:image,imagesDir:path.join(dir,'images'),ticketsDir:path.join(dir,'tickets'),
    backends:createBackendSelector({defaultBackend:'codex',overrides:{},backends:{codex,pi:new PiBackendStub()}}),codexReplyMode:'direct',replyRetryDelayMs:1});
  const harness=await openHarness({models,extension:createCsAgentExtension(tasks),dbFile:path.join(dir,'agent.sqlite')},BACKGROUND_CONTEXT);clean.push(()=>harness.close(BACKGROUND_CONTEXT));
  const dispatcher=new Dispatcher({harness,bridge,tasks,concurrency:2,retryDelayMs:1});
  const msg=(text:string):InboundMessage=>({message_id:'1',time:Math.floor(Date.now()/1000),message_type:'private',user_id:'1',group_id:null,self_id:'2',nickname:'测试',text,route_text:text,images:[],segments:[],truncated:false,mentioned_self:false});
  return {dir,store,context,models,faux,bridge,image,dispatcher,msg,codex};
}
it('前缀图片票据和 Codex agent 票据通过真实 dispatcher/任务，记录完整阶段与终态',async()=>{
  const r=await rig();await r.dispatcher.dispatch(r.msg('奶龙: 猫'),'image');await r.dispatcher.dispatch(r.msg('你好'),'agent');
  const stages=(t:string)=>r.store.events(t).map(e=>e.stage).filter((s,i,a)=>i===0||a[i-1]!==s);
  expect(stages('image')).toEqual(['received','admitted','routed','dispatched','phase:submit','image:submit','phase:submit','phase:collect','image:collect','phase:collect','phase:reply','reply_sent','phase:reply','reply_sent']);
  expect(stages('agent')).toEqual(['received','admitted','routed','dispatched','phase:handle','backend:codex','model_turn','tool:qq_recent','model_turn','backend:codex','phase:handle','late_images','postprocess','phase:reply','reply_sent','phase:reply','reply_sent']);
  expect(r.store.events('image').find(e=>e.stage==='image:submit'&&e.status==='ok')?.detail_json).toContain('prompt-fake');
  expect(r.store.events('agent').find(e=>e.stage==='tool:qq_recent'&&e.status==='ok')?.duration_ms).toBe(12);
  expect(r.store.tickets().every(t=>t.status==='sent')).toBe(true);
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
  expect(await runner.ask('仅假 CLI',{onJsonEvent:codexObserver('jsonl')})).toBe('假答案');
  expect(r.store.events('jsonl').at(-1)).toMatchObject({stage:'tool:test_tool',status:'failed',duration_ms:42});
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
