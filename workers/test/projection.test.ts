import { abortAllDurableObjects, env, reset, runInDurableObject, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { RequestsDO } from "../src/requests/do";
import { ProjectionPublisher, type ProjectionBatch } from "../src/requests/projection";
import { ThreadDO } from "../src/thread";
import { threadView } from "../src/admin/read-views";
import { ModelAlarm, MODEL_PROVIDERS } from "../src/models";
import { snapshot } from "../src/requests/snapshot";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { seedChatTranscript } from "./fixtures/chat-transcript";

describe("admin projection sync", () => {
  afterEach(async()=>{vi.restoreAllMocks();await reset();await abortAllDurableObjects();});
  const admin=(path:string)=>worker.fetch(new Request("https://test"+path,{headers:{Authorization:"Bearer test"}}),{...env,ADMIN_TOKEN:"test"});
  it("未同步的查询返回待同步，不唤醒执行 DO",async()=>{
    const sync=vi.spyOn(ThreadDO.prototype,"syncAdminView");const alarm=vi.spyOn(ThreadDO.prototype,"alarm");
    const response=await admin("/admin/threads/owner/chat");expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"view_pending"});
    expect((await worker.fetch(new Request("https://test/healthz"),env)).status).toBe(200);
    expect(sync).not.toHaveBeenCalled();expect(alarm).not.toHaveBeenCalled();
  });
  it("聊天与记忆增量同步，管理查询不回调执行对象",async()=>{
    const owner=env.THREAD.getByName("owner"),view=threadView(env,"owner");
    // submitWeb acknowledges queueing, not completion. Deliberately exceed Vitest's default 1s
    // poll budget, retaining the real alarm -> model -> send_message -> projection chain.
    const faux=fauxProvider({models:[{id:"test"}],tokensPerSecond:Infinity});
    faux.setResponses([async()=>{
      await new Promise(resolve=>setTimeout(resolve,1250));
      return fauxAssistantMessage(fauxToolCall("send_message",{text:"合成延迟同步"}),{stopReason:"toolUse"});
    },fauxAssistantMessage("done")]);
    vi.spyOn(MODEL_PROVIDERS.faux,"create").mockReturnValue(faux.provider);
    expect(await owner.submitWeb("owner","projection-test","展示同步")).toMatchObject({status:"queued"});
    await expect.poll(async()=>{
      try{return(await view.chatView("owner")).messages.some(m=>m.role==="assistant"&&m.text==="合成延迟同步");}
      catch(error){if(error instanceof Error&&error.message.includes("view_pending"))return false;throw error;}
    },{timeout:10_000}).toBe(true);
    await owner.saveMemory("owner",null,{kind:"fact",text:"这是展示同步测试"});
    await owner.syncAdminView("owner");
    const sync=vi.spyOn(ThreadDO.prototype,"syncAdminView").mockRejectedValue(new Error("execution_read_forbidden"));
    const alarm=vi.spyOn(ThreadDO.prototype,"alarm").mockRejectedValue(new Error("execution_read_forbidden"));
    for(const path of ["/admin/threads/owner/chat","/admin/threads/owner/history","/admin/events?thread=owner","/admin/memory/list?ns=owner","/admin/overview","/admin/health"]){expect((await admin(path)).status,path).toBe(200);}
    expect((await view.memoryList("owner",{})).items.some(row=>row.text==="这是展示同步测试")).toBe(true);
    expect(sync).not.toHaveBeenCalled();expect(alarm).not.toHaveBeenCalled();
  });
  it("alarm 出站保留字节与流，取消已排队请求不会发到上游",async()=>{
    await runInDurableObject(env.THREAD.getByName("transport-test"),async(_instance,state)=>{
      const gate=new ModelAlarm(state),upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{
        expect([...new Uint8Array(init!.body as ArrayBuffer)]).toEqual([1,2,3]);
        return new Response("data: done\n\n",{headers:{"content-type":"text/event-stream"}});
      });
      const response=gate.fetch("https://chatgpt.com/backend-api/codex/responses",{method:"POST",body:new Uint8Array([1,2,3])});
      await new Promise(resolve=>setTimeout(resolve,0));gate.dispatch();
      expect(await(await response).text()).toBe("data: done\n\n");
      const controller=new AbortController();
      const cancelled=gate.fetch("https://chatgpt.com/backend-api/codex/responses",{signal:controller.signal}).then(()=>false,()=>true);
      expect(gate.pending).toBe(true);controller.abort();gate.dispatch();
      expect(await cancelled).toBe(true);
      expect(upstream).toHaveBeenCalledTimes(1);await state.storage.deleteAlarm();
    });
  });
  
  it("同步失败保留变更，执行对象重启后补齐且更新删除不会留下旧记忆",async()=>{
    const owner=env.THREAD.getByName("owner"),view=threadView(env,"owner");
    const fail=vi.spyOn(RequestsDO.prototype,"applyProjection").mockRejectedValue(new Error("display_offline"));
    await owner.saveMemory("owner",null,{kind:"fact",text:"需要同步的记忆"});
    const error = await owner.syncAdminView("owner").then(() => "", error => error.message);
    expect(error).toContain("view_sync_failed");
    expect(await runInDurableObject(owner,(_instance,state)=>state.storage.sql.exec("SELECT 1 FROM admin_projection_changes").toArray().length)).toBeGreaterThan(0);
    fail.mockRestore();await evictDurableObject(owner);await runDurableObjectAlarm(owner);
    await expect.poll(async()=>{try{return(await view.memoryView("owner","需要同步")).memories.length;}catch{return 0;}}).toBe(1);
    await runInDurableObject(owner,(_instance,state)=>state.storage.sql.exec("UPDATE memories SET text='已经更新的记忆' WHERE id=1").toArray());
    await owner.syncAdminView("owner");
    expect((await view.memoryView("owner","需要同步")).memories).toEqual([]);
    expect((await view.memoryView("owner","已经更新")).memories).toHaveLength(1);
    await runInDurableObject(owner,(_instance,state)=>state.storage.sql.exec("DELETE FROM memories WHERE id=1").toArray());
    await owner.syncAdminView("owner");expect((await view.memoryList("owner",{})).items).toEqual([]);
  });
  
  it("子任务列表先按真实活动排序再截取，较早创建的活跃任务不会被挤掉",async()=>{
    const owner=env.THREAD.getByName("owner"),now=Date.now(),activeId="00000000-0000-0000-0000-000000000000";
    await owner.syncAdminView("owner");
    await runInDurableObject(owner,(_instance,state)=>{
      for(let i=0;i<51;i++)state.storage.sql.exec(
        "INSERT INTO subagents(id,task,created_at,status,identity_json,origin_json,timeout_ms,deadline) VALUES(?,?,?,'running','{}','{}',0,0)",
        "00000000-0000-0000-0000-"+String(i).padStart(12,"0"),"排序测试",now-10000+i);
    });
    await owner.syncAdminView("owner");
    const registry=env.REQUESTS.getByName("main");
    await registry.recordAgent({thread:"owner",actor:activeId,summary:"旧任务的新进展",description:{kind:"progress",text:"重新核对",updatedAt:now-5000},status:"running",version:1,updatedAt:now-5000});
    await registry.record({request:{id:crypto.randomUUID(),startedAt:now,thread:"owner",actor:activeId,purpose:"subagent",provider:"faux",model:"test",status:"running",endedAt:null,inputTokens:null,outputTokens:null,cacheRead:null,cacheWrite:null,reasoningTokens:null,durationMs:null,contextWindow:1000},context:snapshot({messages:[]})});
    const response=await admin("/admin/threads/owner/subagents"),list=await response.json<{id:string;lastActiveAt:number}[]>();
    expect(response.status).toBe(200);expect(list).toHaveLength(50);
    expect(list[0]).toMatchObject({id:activeId,lastActiveAt:now});
    expect(list.at(-1)?.id).toBe("00000000-0000-0000-0000-000000000002");
  });
  
  it("在飞投影期间写入维护 KV 后仍会同步最新 info",async()=>{
    await runInDurableObject(env.THREAD.getByName("owner"),async(_instance,state)=>{
      const applied:ProjectionBatch[]=[],agingAt=1_700_000_000_000,consolidateAt=1_700_000_001_000;
      let entered!:()=>void,release!:()=>void;
      const reached=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
      const fakeEnv={...env,REQUESTS:{getByName:()=>({
        applyProjection:async(batch:ProjectionBatch)=>{
          applied.push(batch);
          // 1) 在中间批次（complete:false）RPC 期间写入 KV，尾部重读 info 应立即带上。
          if(applied.length===1)await state.storage.put("maint:aging_last_run",agingAt);
          // 2) 在 complete:true RPC 期间写入 KV 并并发 flush，应触发续跑补发最新 info。
          if(applied.length===2){entered();await gate;}
        },
      })}} as unknown as typeof env;
      state.storage.sql.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)");
      const publisher=new ProjectionPublisher(state,fakeEnv,async()=>"thread:owner",async()=>{});
      publisher.install();
      state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (1, 'memory_consolidate', '{}')");
      const first=publisher.flush();
      await reached;
      await state.storage.put("maint:consolidate_last_run",consolidateAt);
      const second=publisher.flush();
      release();
      await Promise.all([first,second]);
      expect(applied[1]).toMatchObject({complete:true,info:{agingLastRun:agingAt,consolidateLastRun:null}});
      expect(applied.at(-1)).toMatchObject({complete:true,info:{agingLastRun:agingAt,consolidateLastRun:consolidateAt}});
    });
  });
});

describe("chat transcript projection", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); await abortAllDurableObjects(); });
  it("会话对话以本 root 已放置的 transcript 为准，并区分收件、发送回执和真实平台消息",async()=>{
    const owner=env.THREAD.getByName("owner");
    await owner.syncAdminView("owner");
    await runInDurableObject(owner,(_instance,state)=>{
      seedChatTranscript(state.storage.sql);
    });
    await owner.syncAdminView("owner");
    const read=async(query="")=>{
      const res=await worker.fetch(new Request("https://test/admin/threads/owner/chat"+query,{headers:{Authorization:"Bearer test"}}),{...env,ADMIN_TOKEN:"test"});
      expect(res.status).toBe(200);return await res.json() as {delta:boolean;revision:number;messages:{id:string;text:string;source:string;status:string;at:number}[]};
    };
    const {messages}=await read(),dump=JSON.stringify(messages);
    for(const text of ["收件合成正文","子报告合成正文","合成静默事件","发件合成正文","合成 QQ 消息","已放置的网页原文"])expect(dump).toContain(text);
    for(const text of ["合成网页消息","隐藏推理","隐藏系统","隐藏路径","内部策略","宿主说明","仅入箱:","别的会话正文","synthetic-secret-value","agent_credentials_forbidden"])expect(dump).not.toContain(text);
    expect(messages.filter(m=>m.id==="sent:agent:"+"a".repeat(64))).toHaveLength(1);
    expect(messages.filter(m=>m.source==="agent-out").map(m=>m.status)).toEqual(["accepted","failed"]);
    expect(messages.filter(m=>m.source==="model").map(m=>m.text)).toEqual(["合成模型回答"]);
    const pending=messages.find(m=>m.status==="waiting")!;
    expect((await read("?after="+(Date.now()+100000)+"&pending="+encodeURIComponent(pending.id))).messages.map(m=>m.id)).toEqual([pending.id]);
    expect(messages.map(m=>m.at)).toEqual(messages.map(m=>m.at).sort((a,b)=>a-b));
    const page=await read();expect(page.messages).toEqual(messages);
    // 老投影不能只按时间取增量，否则补写的旧 transcript 或消失的队列项会永远留错。
    const stale=await read("?after="+(Date.now()+100000)+"&revision="+(page.revision-1));
    expect(stale.delta).toBe(false);expect(stale.messages).toEqual(messages);
    expect(new Set(messages.map(m=>m.id)).size).toBe(messages.length);
    await runInDurableObject(owner,(_instance,state)=>{
      expect(state.storage.sql.exec<{text:string}>("SELECT text FROM messages").toArray().map(r=>r.text)).toEqual(["合成 QQ 消息"]);
      state.storage.sql.exec("DELETE FROM inbound WHERE message_id LIKE 'evt_github_%'");
    });
    await owner.syncAdminView("owner");
    const retained=(await read()).messages.find(m=>m.source==="github");
    expect(retained).toMatchObject({id:messages.find(m=>m.source==="github")!.id,status:null,text:expect.stringContaining("合成静默事件")});
  });
});
