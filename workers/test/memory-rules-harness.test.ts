import {env,reset,runInDurableObject} from "cloudflare:test";
import {afterEach,expect,it} from "vitest";
import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";
import {createModels} from "@earendil-works/pi-ai/models";
import {Type} from "typebox";
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {createRegistry,defineExtension,defineTool,Harness,section,hook,GenerationTask} from "@earendil-works/pi-durable";
import {openDurableObjectSqliteStorage,DurableObjectSqliteDatabase} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {MemoryStore} from "../src/memory/store";
import {RuleService,renderRules,RULE_UNAVAILABLE} from "../src/memory/rules";

afterEach(()=>reset());
it("real Workerd Harness refreshes after tool commit, compaction/reopen and explicit read degradation",async()=>{
 const stub=env.THREAD.getByName("owner");await stub.syncAdminView("owner");
 await runInDurableObject(stub,async(_instance,state)=>{
  const context=BACKGROUND_CONTEXT,store=new MemoryStore(new DurableObjectSqliteDatabase(state.storage),"owner");
  const rules=new RuleService(store,"private:10000001");
  const row=(await store.remember({kind:"rule",text:"OLD-APPROVED",author:"dashboard"})).row;
  const first=await rules.propose({id:row.id,expectedVersion:await store.revision(row.id),expectedBindingRevision:0,requestId:"first"});
  const saved=await rules.confirm({proposalId:first.id,payloadHash:first.payload_hash,requestId:"first-confirm"});
  const update=await rules.propose({id:row.id,expectedVersion:saved.memoryVersion,expectedBindingRevision:1,entry:{kind:"rule",text:"NEW-APPROVED"},requestId:"update"});
  const base=createModels(),faux=fauxProvider({models:[{id:"test"}],tokensPerSecond:Infinity});
  base.setProvider(faux.provider);
  const captured:string[]=[];let failed=false;
  const reply=()=>{faux.setResponses([transcript=>{captured.push(JSON.stringify(transcript));return fauxAssistantMessage("合成回复");}]);};
  const open=async()=>{
   const storage=await openDurableObjectSqliteStorage(state.storage,{prefix:"rule_harness_"}),registry=createRegistry();
   registry.install(defineExtension({name:"rules-test",
    sections:[section("memory-rules",()=>renderRules(async()=>{if(failed)throw Error("offline");return rules.read();}),{tag:false})],
    tools:[defineTool({name:"change_rule",description:"Synthetic trusted management action, test only",parameters:Type.Object({}),replay:"unsafe",execute:async()=>{
      await rules.confirm({proposalId:update.id,payloadHash:update.payload_hash,requestId:"tool-confirm"});
      return {output:[{type:"text",text:"committed"}]};
    }})]}));
   const harness=await Harness.open(storage,{models:base,registry,settings:{compaction:{enabled:false,keepRecentTokens:80}}},context);
   const root=await harness.root(context,{agent:{model:{provider:faux.provider.id,modelId:"test"}}});
   return {harness,root};
  };
  let runtime=await open();
  try{
   faux.setResponses([
    transcript=>{captured.push(JSON.stringify(transcript));return fauxAssistantMessage(fauxToolCall("change_rule",{}),{stopReason:"toolUse"});},
    transcript=>{captured.push(JSON.stringify(transcript));return fauxAssistantMessage("工具续轮");},
   ]);
   await(await runtime.root.submit({type:"input",content:"无规则关键词的新主题"},context)).wait(context);
   expect(captured[0]).toContain("OLD-APPROVED");expect(captured[1]).toContain("NEW-APPROVED");
   for(let i=0;i<3;i++){reply();await(await runtime.root.submit({type:"input",content:"长历史".repeat(400)+i},context)).wait(context);}
   reply();const task=await runtime.root.compact(undefined,context);await runtime.harness.waitForTask(task,context);await runtime.root.waitForIdle(context);
   await runtime.harness.close(context);runtime=await open();
   reply();await(await runtime.root.submit({type:"input",content:"压缩并重建后继续"},context)).wait(context);
   expect(captured.at(-1)).toContain("NEW-APPROVED");
   failed=true;reply();await(await runtime.root.submit({type:"input",content:"读故障"},context)).wait(context);
   expect(captured.at(-1)).toContain("unavailable");
   expect(captured.at(-1)).toContain("没有已核验的有效快照");
   expect(RULE_UNAVAILABLE).toContain("不是权限 fail-closed");
   failed=false;
   const current=(await rules.list())[0]!;
   await rules.revoke({id:row.id,expectedVersion:current.memory_version,expectedBindingRevision:current.revision,requestId:"last-revoke"});
   reply();await(await runtime.root.submit({type:"input",content:"撤销后继续"},context)).wait(context);
   // Verify persisted rule source, not the historic transcript: mid-conversation systems may retain old history.
   expect((await rules.read()).items).toEqual([]);
   await runtime.harness.close(context);runtime=await open();
   reply();await(await runtime.root.submit({type:"input",content:"再次恢复"},context)).wait(context);
   expect((await rules.read()).items).toEqual([]);
  }finally{await runtime.harness.close(context);}
 });
});

it("request checkpoint reopen preserves prepared cutoff; next prepare reads the newly approved version",async()=>{
 const stub=env.THREAD.getByName("owner");await stub.syncAdminView("owner");
 await runInDurableObject(stub,async(_instance,state)=>{
  const context=BACKGROUND_CONTEXT,store=new MemoryStore(new DurableObjectSqliteDatabase(state.storage),"owner"),rules=new RuleService(store,"private:10000001");
  const row=(await store.remember({kind:"rule",text:"CUTOFF-OLD",author:"dashboard"})).row;
  const p=await rules.propose({id:row.id,expectedVersion:await store.revision(row.id),expectedBindingRevision:0,requestId:"prepare"});
  const a=await rules.confirm({proposalId:p.id,payloadHash:p.payload_hash,requestId:"prepare-confirm"});
  const update=await rules.propose({id:row.id,expectedVersion:a.memoryVersion,expectedBindingRevision:1,entry:{kind:"rule",text:"CUTOFF-NEW"},requestId:"next"});
  const models=createModels(),faux=fauxProvider({models:[{id:"test"}],tokensPerSecond:Infinity});models.setProvider(faux.provider);
  const seen:string[]=[];let block=true,renders=0,entered!:()=>void;
  const prepared=new Promise<void>(resolve=>{entered=resolve;});
  const open=async()=>{
   const storage=await openDurableObjectSqliteStorage(state.storage,{prefix:"rule_checkpoint_"}),registry=createRegistry();
   registry.install(defineExtension({name:"checkpoint-test",
    sections:[section("memory-rules",()=>{renders++;return renderRules(()=>rules.read());},{tag:false})],
    hooks:[hook(GenerationTask,{beforeRequest:async(request,_api,c)=>{
     seen.push(JSON.stringify(request.messages));
     if(block){entered();await new Promise<void>((_resolve,reject)=>{
      if(c.abortSignal?.aborted)reject(c.abortSignal.reason);
      else c.abortSignal?.addEventListener("abort",()=>reject(c.abortSignal?.reason),{once:true});
     });}
    }})]}));
   const harness=await Harness.open(storage,{models,registry,settings:{compaction:{enabled:false}}},context);
   const root=await harness.root(context,{agent:{model:{provider:faux.provider.id,modelId:"test"}}});
   return {harness,root};
  };
  let runtime=await open();
  try{
   await runtime.root.submit({type:"input",content:"prepared request"},context);
   await prepared;expect(renders).toBe(1);expect(seen[0]).toContain("CUTOFF-OLD");
   await runtime.harness.close(context);
   await rules.confirm({proposalId:update.id,payloadHash:update.payload_hash,requestId:"next-confirm"});
   block=false;faux.setResponses([fauxAssistantMessage("恢复发送")]);runtime=await open();
   await runtime.root.waitForIdle(context);
   expect(renders).toBe(1);expect(seen.at(-1)).toContain("CUTOFF-OLD");expect(seen.at(-1)).not.toContain("CUTOFF-NEW");
   faux.setResponses([fauxAssistantMessage("下一准备")]);
   await(await runtime.root.submit({type:"input",content:"next prepare"},context)).wait(context);
   expect(renders).toBe(2);expect(seen.at(-1)).toContain("CUTOFF-NEW");
  }finally{await runtime.harness.close(context);}
 });
});
