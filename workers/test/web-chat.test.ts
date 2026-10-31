import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxProvider, fauxToolCall, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { MODEL_PROVIDERS } from "../src/models";
import worker from "../src/index";
import { input, connect, action, reply } from "./helpers";
const sockets: WebSocket[] = [];
afterEach(async () => { vi.restoreAllMocks(); sockets.splice(0).forEach(s=>s.close()); await reset(); });
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
    await expect.poll(async()=> (await owner().chatView("owner")).messages.filter(m=>m.role==="assistant"&&m.source==="web").length).toBe(1);
    const page=await owner().chatView("owner");
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
    const delta=await owner().chatView("owner",{after:Date.now()+1,pending:[web.id]});
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
    fake(async ctx=>{
      if(ctx.messages.at(-1)?.role==="toolResult")return fauxAssistantMessage("done");
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
    await expect.poll(async()=> (await owner().chatView("owner")).queued).toBe(0);
    expect((await owner().chatView("owner")).messages.filter(m=>m.source==="web"&&m.role==="assistant").map(m=>m.text)).toEqual(["网页回复"]);
    expect(seen[0]).toContain("只把文字写入网页");expect(seen[1]).not.toContain("本轮来自已通过管理口令认证的网页管理员");
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
    await expect.poll(async()=> (await owner().chatView("owner")).messages.some(m=>m.source==="web"&&m.text==="网页子任务已完成"),{timeout:10000}).toBe(true);
    await runInDurableObject(owner(),(_instance,state)=>{
      expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM outbox").one().n).toBe(0);
      expect(state.storage.sql.exec<{reply_channel:string}>("SELECT reply_channel FROM inbound WHERE kind='subagent'").one().reply_channel).toBe("web");
    });
  });
});
