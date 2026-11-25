import { abortAllDurableObjects, env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxProvider, fauxToolCall, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { MODEL_PROVIDERS } from "../src/models";
import worker from "../src/index";
import { threadView } from "../src/admin/read-views";
import type { AgentReadView } from "../src/requests/view";
import { input, connect, action, reply, syncedView } from "./helpers";

describe("web chat suite", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => { vi.restoreAllMocks(); sockets.splice(0).forEach(s=>s.close()); await reset(); await abortAllDurableObjects(); });
  const owner = () => env.THREAD.getByName("owner");
  function admin(method: string, body?: unknown) {
    return worker.fetch(new Request("https://test/admin/threads/owner/chat", { method, headers: { Authorization:"Bearer test", "Content-Type":"application/json" }, body: body===undefined?undefined:JSON.stringify(body) }), { ...env, ADMIN_TOKEN:"test" });
  }
  function fake(handler: FauxResponseFactory) {
    const faux=fauxProvider({ models:[{id:"test"}],tokensPerSecond:Infinity });
    const respond: FauxResponseFactory = async (...args) => { faux.setResponses([respond]); return handler(...args); };
    faux.setResponses([respond]);vi.spyOn(MODEL_PROVIDERS.faux,"create").mockReturnValue(faux.provider);
  }
  const latest = (messages: Parameters<FauxResponseFactory>[0]["messages"]) => {
    const user=messages.findLast(m=>m.role==="user");
    return typeof user?.content==="string"?user.content:JSON.stringify(user?.content);
  };
  describe("web chat continues QQ",()=>{
    it("shares the existing model transcript, writes only web output, and deduplicates commands",async()=>{
      const contexts:string[]=[];
      fake(ctx=>{
        contexts.push(JSON.stringify(ctx.messages));
        if(ctx.messages.at(-1)?.role==="toolResult")return fauxAssistantMessage("done");
        if(latest(ctx.messages).includes("网页"))return fauxAssistantMessage(fauxToolCall("send_message",{text:"记得你在 QQ 里说过海风"}),{stopReason:"toolUse"});
        return fauxAssistantMessage("已记下");
      });
      await owner().submit(input(1,"QQ 里的代号是海风",10000001));
      const command={requestId:crypto.randomUUID(),text:"网页里继续：我的代号是什么？"};
      expect((await admin("POST",command)).status).toBe(202);
      expect((await admin("POST",command)).status).toBe(202);
      expect((await admin("POST",{...command,text:"不同内容"})).status).toBe(409);
      await expect.poll(async()=> (await (await syncedView("owner")).chatView("owner")).messages.filter(m=>m.role==="assistant"&&m.source==="web").length).toBe(1);
      const page=await (await syncedView("owner")).chatView("owner");
      expect(page.messages.filter(m=>m.source==="web"&&m.role==="user")).toHaveLength(1);
      const web = page.messages.find(m=>m.id==="web:"+command.requestId)!;
      expect(web.turnId).toMatch(/^turn:/);
      const store=env.REQUESTS.getByName("main");
      await expect.poll(async()=> (await store.turnTrace("owner",[web.turnId!],0)).requests.filter(r=>r.status==="done").length).toBe(2);
      const trace=await store.turnTrace("owner",[web.turnId!],0);
      const traceResponse=await worker.fetch(new Request("https://test/admin/threads/owner/trace?turn="+encodeURIComponent(web.turnId!),{headers:{Authorization:"Bearer test"}}),{...env,ADMIN_TOKEN:"test"});
      expect(traceResponse.status).toBe(200);
      expect(trace.tools).toHaveLength(1);
      expect(trace.tools[0]).toMatchObject({name:"send_message",status:"done",binding:{inputId:web.id,turnId:web.turnId}});
      expect(JSON.stringify(trace)).not.toContain("记得你在 QQ 里说过海风");
      const request=trace.requests.find(r=>r.toolCalls?.some(t=>t.name==="send_message"))!;
      const detail=await store.detail(request.id);
      expect(detail?.tools[0]).not.toHaveProperty("result");
      expect((await store.toolDetail(trace.tools[0].id))?.result?.text).toContain('"status":"sent"');
      expect(detail?.related).toHaveLength(2);
      expect((await store.turnTrace("owner",[web.turnId!],trace.cursor)).requests).toEqual([]);
      const delta=await (await syncedView("owner")).chatView("owner",{after:Date.now()+1,pending:[web.id]});
      expect(delta.messages.map(m=>m.id)).toEqual([web.id]);
      expect(delta.messages[0].status).toBe("done");
      expect(contexts.some(t=>t.includes("海风")&&t.includes("网页里继续"))).toBe(true);
      await runInDurableObject(owner(),(_instance,state)=>{
        expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM outbox").one().n).toBe(0);
        expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM messages").one().n).toBe(1);
      });
      expect((await admin("POST",{...command,userId:"10000001"})).status).toBe(400);
      expect((await admin("POST",{requestId:crypto.randomUUID(),text:"  "})).status).toBe(400);
    });
    it("does not let QQ input steer a web run or change its delivery channel",async()=>{
      let started=false,release!:()=>void;
      const gate=new Promise<void>(r=>{release=r;});
      const seen:string[]=[];
      let textFieldDescription="";
      fake(async ctx=>{
        if(ctx.messages.at(-1)?.role==="toolResult")return fauxAssistantMessage("done");
        const sendTool=getCurrentTools(ctx.messages).find(t=>t.name==="send_message");
        textFieldDescription=String((sendTool?.parameters as {properties?:{text?:{description?:string}}})?.properties?.text?.description??"");
        const text=latest(ctx.messages);seen.push(getCurrentSystemPrompt(ctx.messages));
        if(text==="网页等待"){started=true;await gate;}
        return fauxAssistantMessage(fauxToolCall("send_message",{text:text==="网页等待"?"网页回复":"QQ回复"}),{stopReason:"toolUse"});
      });
      const {socket,frames}=await connect(sockets);
      await owner().submitWeb("owner",crypto.randomUUID(),"网页等待");await expect.poll(()=>started).toBe(true);
      const qq=owner().submit(input(2,"QQ 插话",10000001));
      release();
      const sent=await action(frames,0,"send_private_msg");
      expect(JSON.stringify(sent.params)).toContain("QQ回复");expect(JSON.stringify(sent.params)).not.toContain("网页回复");
      reply(socket,sent.echo);await qq;
      await expect.poll(async()=> (await (await syncedView("owner")).chatView("owner")).queued).toBe(0);
      expect((await (await syncedView("owner")).chatView("owner")).messages.filter(m=>m.source==="web"&&m.role==="assistant").map(m=>m.text)).toEqual(["网页回复"]);
      expect(seen[0]?.split("不向 QQ 发送")).toHaveLength(2);
      expect(seen[1]).not.toContain("本轮来自已通过管理口令认证的网页管理员");
      expect(seen[1]?.indexOf("<rules>")).toBe(0);
      expect(seen[1]!.indexOf("<codemode>")).toBeLessThan(seen[1]!.indexOf("<turn-identity>"));
      expect(seen[1]!.indexOf("<turn-identity>")).toBeLessThan(seen[1]!.indexOf("<time>"));
      expect(textFieldDescription).toContain("turn…search");
    });
    it("keeps a web-spawned subagent report on the web channel",async()=>{
      fake(ctx=>{
        if(!getCurrentTools(ctx.messages).some(t=>t.name==="subagent"))return fauxAssistantMessage("子任务查完了");
        if(ctx.messages.at(-1)?.role==="toolResult")return fauxAssistantMessage("done");
        const text=latest(ctx.messages);
        if(text.includes("[子 agent 完成]"))return fauxAssistantMessage(fauxToolCall("send_message",{text:"网页子任务已完成"}),{stopReason:"toolUse"});
        return fauxAssistantMessage(fauxToolCall("subagent",{action:"spawn",task:"测试网页子任务"}),{stopReason:"toolUse"});
      });
      await owner().submitWeb("owner",crypto.randomUUID(),"请在网页派出子任务");
      await expect.poll(async()=> (await (await syncedView("owner")).chatView("owner")).messages.some(m=>m.source==="web"&&m.text==="网页子任务已完成"),{timeout:10000}).toBe(true);
      await runInDurableObject(owner(),(_instance,state)=>{
        expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM outbox").one().n).toBe(0);
        expect(state.storage.sql.exec<{reply_channel:string}>("SELECT reply_channel FROM inbound WHERE kind='subagent'").one().reply_channel).toBe("web");
      });
    });

    it("persists open update_steps across subagent wakeups, redacts secrets on trace, and clears on completion or reset",async()=>{
      const subagentPrompts:string[]=[];
      const followupPrompts:string[]=[];
      let stage=0;
      fake(ctx=>{
        if(!getCurrentTools(ctx.messages).some(t=>t.name==="subagent"))return fauxAssistantMessage("服务正常");
        if(ctx.messages.at(-1)?.role==="toolResult")return fauxAssistantMessage("");
        const text=latest(ctx.messages);
        if(text.includes("[子 agent 完成]")){
          subagentPrompts.push(getCurrentSystemPrompt(ctx.messages));
          return fauxAssistantMessage([
            fauxToolCall("update_steps",{steps:[
              {title:"派子任务巡检",status:"done"},
              {title:"核查凭据状态",status:"done"},
              {title:"向用户发送巡检结论",status:"done"},
            ]}),
            fauxToolCall("send_message",{text:"全部巡检完成，一切正常"}),
          ],{stopReason:"toolUse"});
        }
        stage++;
        if(stage===1){
          return fauxAssistantMessage([
            fauxToolCall("update_steps",{steps:[
              {title:"派子任务巡检",status:"in_progress"},
              {title:"核查令牌 Bearer sk-secret1234567890abcdef",status:"pending"},
              {title:"向用户发送巡检结论",status:"pending"},
            ]}),
            fauxToolCall("subagent",{action:"spawn",task:"巡检服务状态"}),
          ],{stopReason:"toolUse"});
        }
        followupPrompts.push(getCurrentSystemPrompt(ctx.messages));
        return fauxAssistantMessage(fauxToolCall("send_message",{text:"新话题回复"}),{stopReason:"toolUse"});
      });

      await owner().submitWeb("owner",crypto.randomUUID(),"请按步骤巡检并汇报");
      await expect.poll(async()=> (await (await syncedView("owner")).chatView("owner")).messages.some(m=>m.source==="web"&&m.text==="全部巡检完成，一切正常"),{timeout:10000}).toBe(true);

      // 子任务汇报唤醒时，末尾 <turn-steps> 回显未完成步骤，指引主会话完成最后一步汇报
      expect(subagentPrompts[0]).toContain("<turn-steps>");
      expect(subagentPrompts[0]).toContain("1. [in_progress] 派子任务巡检");
      expect(subagentPrompts[0]).not.toContain("sk-secret1234567890abcdef");
      expect(subagentPrompts[0]).toContain("3. [pending] 向用户发送巡检结论");

      // trace 中的步骤标题严格先脱敏凭据再落盘展示
      const page=await (await syncedView("owner")).chatView("owner");
      const turns=[...new Set(page.messages.map(m=>m.turnId).filter((id):id is string=>!!id))];
      const trace=await env.REQUESTS.getByName("main").turnTrace("owner",turns,0);
      const stepTraces=trace.tools.filter(t=>t.name==="update_steps");
      expect(stepTraces.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(stepTraces)).not.toContain("sk-secret1234567890abcdef");
      expect(stepTraces.at(-1)?.steps).toEqual([
        {title:"派子任务巡检",status:"done"},
        {title:"核查凭据状态",status:"done"},
        {title:"向用户发送巡检结论",status:"done"},
      ]);

      // 等汇报回合彻底落定后，后续无关新话题不再注入旧 <turn-steps>
      await expect.poll(async()=> (await (await syncedView("owner")).chatView("owner")).active).toBe(0);
      await owner().submitWeb("owner",crypto.randomUUID(),"换个简单问题");
      await expect.poll(async()=> (await (await syncedView("owner")).chatView("owner")).messages.some(m=>m.source==="web"&&m.text==="新话题回复")).toBe(true);
      expect(followupPrompts[0]).not.toContain("<turn-steps>");
    });
  });
  
  it("QQ 排队消息经展示副本读取后可原样用于增量查询，并沿用同一 ID 更新终态",async()=>{
    const key="owner",sourceThread=env.THREAD.getByName(key);
    let started=false,release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    fake(async()=>{started=true;await gate;return fauxAssistantMessage("核对完成");});
    const running=sourceThread.submit(input(1,"等待核对的 QQ 消息",10000001));
    const get=async(query="")=>worker.fetch(new Request("https://test/admin/threads/"+key+"/chat"+query,{
      headers:{Authorization:"Bearer test"},
    }),{...env,ADMIN_TOKEN:"test"});
    try{
      await expect.poll(()=>started).toBe(true);
      await sourceThread.syncAdminView(key);
      const response=await get();expect(response.status).toBe(200);
      const first=await response.json<Awaited<ReturnType<AgentReadView["chatView"]>>>();
      const queued=first.messages.filter(message=>message.status==="queued");
      expect(queued).toHaveLength(1);
      expect(queued[0].id).toMatch(/^qq:\d+$/);
      const sourceId=await runInDurableObject(sourceThread,(_instance,state)=>state.storage.sql.exec<{id:number}>("SELECT id FROM messages").one().id);
      expect(queued[0].id).toBe("qq:"+sourceId);
      const params=new URLSearchParams({after:String(Math.max(...first.messages.map(message=>message.at))+1)});
      queued.forEach(message=>params.append("pending",message.id));
      const deltaResponse=await get("?"+params);expect(deltaResponse.status).toBe(200);
      const delta=await deltaResponse.json<Awaited<ReturnType<AgentReadView["chatView"]>>>();
      expect(delta.delta).toBe(true);expect(delta.messages).toEqual(queued);
      release();await running;await sourceThread.syncAdminView(key);
      const completedResponse=await get("?"+params);expect(completedResponse.status).toBe(200);
      const completed=await completedResponse.json<Awaited<ReturnType<AgentReadView["chatView"]>>>();
      expect(completed.messages.filter(m=>m.source==="qq")).toEqual([expect.objectContaining({id:queued[0].id,status:"done"})]);
      expect(completed.messages.filter(m=>m.source==="model")).toMatchObject([{text:"核对完成",turnId:queued[0].turnId}]);
    }finally{release();await running;}
  });
});

describe("sessions suite", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); await abortAllDurableObjects(); });
  const owner = () => env.THREAD.getByName("owner");
  function fake(handler: FauxResponseFactory) {
    const provider = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const respond: FauxResponseFactory = async (...args) => { provider.setResponses([respond]); return handler(...args); };
    provider.setResponses([respond]);
    vi.spyOn(MODEL_PROVIDERS.faux, "create").mockReturnValue(provider.provider);
  }
  function request(path: string, method = "GET", body?: unknown) {
    return worker.fetch(new Request("https://test/admin/threads/owner/" + path, {
      method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...env, ADMIN_TOKEN: "test" });
  }
  describe("session lifecycle", () => {
    it("archives the immutable transcript, resets context once, and preserves QQ history and memory", async () => {
      const contexts: string[] = [];
      fake(ctx => { contexts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage("已收到"); });
      await owner().submit(input(1, "重置前的海风代号", 10000001));
      const profile = (await (await syncedView("owner")).memoryView("owner", "")).profile;
      await owner().writeProfile("owner", "长期画像仍保留", profile.revision);
      const id = crypto.randomUUID();
      const first = await owner().resetSession("owner", id, "第一段对话");
      expect(first).toEqual({ status: "reset", generation: 1 });
      expect(await owner().resetSession("owner", id, "第一段对话")).toEqual(first);
      expect(await owner().resetSession("owner", id, "另一个名称")).toEqual({ error: "request_conflict" });
      await owner().submit(input(2, "新话题", 10000001));
      expect(contexts.at(-1)).not.toContain("重置前的海风代号");
      const history = await (await syncedView("owner")).sessionHistory("owner");
      expect(history.entries.filter(e => e.reset)).toHaveLength(1);
      expect(JSON.stringify(history.entries)).toContain("重置前的海风代号");
      expect((await (await syncedView("owner")).memoryView("owner", "")).profile.text).toBe("长期画像仍保留");
      await runInDurableObject(owner(), (_instance, state) => {
        expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM messages").one().n).toBe(2);
      });
    });
    it("refuses reset during a run and paginates history without duplicates", async () => {
      let release!: () => void, started = false;
      const gate = new Promise<void>(r => { release = r; });
      fake(async () => { started = true; await gate; return fauxAssistantMessage("结束"); });
      const pending = owner().submit(input(3, "正在处理", 10000001));
      await expect.poll(() => started).toBe(true);
      expect(await owner().resetSession("owner", crypto.randomUUID(), "")).toEqual({ error: "busy" });
      release(); await pending;
      for (let i = 4; i < 24; i++) await owner().submit(input(i, "历史" + i, 10000001));
      await owner().syncAdminView("owner");
      const page = await threadView(env,"owner").sessionHistory("owner");
      expect(page.entries).toHaveLength(10);
      expect(page.next).toBeTruthy();
      const older = await threadView(env,"owner").sessionHistory("owner", page.next);
      expect(older.entries).toHaveLength(10);
      expect(older.entries.some(e => page.entries.some(p => p.id === e.id))).toBe(false);
      expect((await request("history?cursor=!!!")).status).toBe(400);
    });
    it("runs native compaction and records a reset receipt for recovery", async () => {
      fake(() => fauxAssistantMessage("这里是可保留的摘要"));
      await owner().submit(input(1, "测试压缩", 10000001));
      const response = await request("compact", "POST", {});
      expect(response.status).toBe(202);
      await expect.poll(async () => (await (await syncedView("owner")).sessionHistory("owner")).compacting).toBe(false);
      const id = crypto.randomUUID();
      await owner().resetSession("owner", id, "恢复演练");
      await runInDurableObject(owner(), (_instance, state) => {
        state.storage.sql.exec("UPDATE session_resets SET status='pending' WHERE request_id=?", id);
      });
      await owner().resetSession("owner", id, "恢复演练");
      expect((await (await syncedView("owner")).sessionHistory("owner")).entries.filter(e => e.reset)).toHaveLength(1);
    });
  });
});
