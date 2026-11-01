import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream, type AssistantMessage, type StreamOptions } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { captureModels } from "../src/requests/capture";
import { snapshot, errorSummary } from "../src/requests/snapshot";
import type { RequestDetail, RequestQuery, ToolTrace } from "../src/requests/types";
import { readAgentTopology, type AgentTopology } from "../src/requests/topology";
import type { SubagentActivity } from "../src/subagent/activity";
import worker from "../src/index";
afterEach(() => reset());
const query = (): RequestQuery => ({ since: Date.now() - 86400_000, until: Date.now() + 1000, limit: 40 });
function detail(id: string, at = Date.now()): RequestDetail {
  return { request: { id, startedAt: at, endedAt: at + 10, thread: "owner", actor: "thread", purpose: "conversation", provider: "faux", model: "test",
    status: "done", inputTokens: 14, outputTokens: 3, cacheRead: 5, cacheWrite: 2, reasoningTokens: 2, durationMs: 10, contextWindow: 1000 },
    context: snapshot({ messages: [{ role: "user", content: "你好", timestamp: at }] }) };
}
describe("request observability", () => {
  it("uses child lifecycle metadata across tool waits and ignores late progress after completion", async () => {
    const store = env.REQUESTS.getByName("main"), now = Date.now(), actor = crypto.randomUUID();
    const activity: SubagentActivity = { thread: "owner", actor, summary: "检查图片读取", description: { kind: "task", text: "检查图片读取", updatedAt: now }, status: "running", version: 1, updatedAt: now };
    await store.recordAgent(activity);
    expect((await store.agentTopology()).nodes.find(n => n.kind === "subagent")).toMatchObject({ activity: "active", status: "running", summary: "检查图片读取", description: { kind: "task" } });
    const done: SubagentActivity = { ...activity, version: 3, status: "done", description: { kind: "result", text: "已确认图片读取正常", updatedAt: now + 2 }, updatedAt: now + 2 };
    await store.recordAgent(done);
    await store.recordAgent({ ...activity, version: 2, description: { kind: "progress", text: "正在检查", updatedAt: now + 1 } });
    await runInDurableObject(store, (_instance, state) => {
      const row = state.storage.sql.exec<{ record: string }>("SELECT record FROM agent_activity WHERE actor=?", actor).one();
      expect(JSON.parse(row.record)).toEqual(done);
    });
    // 清掉详情仍能在下次采样读取简介，不把已完成子任务标为执行中。
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM request_details");
      expect(readAgentTopology(state.storage.sql, now + 10_001).nodes.find(n => n.kind === "subagent")).toMatchObject({ activity: "recent", status: "done", description: { kind: "result", text: "已确认图片读取正常" } });
    });
  });

  it("counts every stream/complete once, keeps stream events and usage semantics, and redacts secrets", async () => {
    const faux = fauxProvider({ models: [{ id: "test" }] }), base = createModels();
    const message = { ...fauxAssistantMessage("ok"), usage: { input: 7, output: 3, cacheRead: 5, cacheWrite: 2, reasoning: 2, totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const make = () => { const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); return stream; };
    base.setProvider({ ...faux.provider, stream: make, streamSimple: make });
    const pending: Promise<unknown>[] = [];
    const models = captureModels(base, env, { waitUntil: p => { pending.push(p); } }, { thread: "owner", actor: "thread", purpose: "conversation" });
    const input = { messages: [{ role: "user" as const, content: "Authorization: Bearer never-store-this", timestamp: Date.now() }] };
    const stream = models.streamSimple(faux.models[0], input);
    const events = []; for await (const event of stream) events.push(event.type);
    expect(events).toEqual(["start", "done"]); expect((await stream.result()).content).toEqual(message.content);
    await models.complete(faux.models[0], input);
    await models.completeSimple(faux.models[0], input);
    await models.stream(faux.models[0], input).result();
    await Promise.all(pending);
    const store = env.REQUESTS.getByName("main"), page = await store.list(query());
    expect(page.requests).toHaveLength(4);
    for (const r of page.requests) expect(r).toMatchObject({ inputTokens: 14, outputTokens: 3, cacheRead: 5, cacheWrite: 2, reasoningTokens: 2, status: "done" });
    expect(page.requests.filter(r => r.purpose === "compaction")).toHaveLength(1);
    const captured = await store.detail(page.requests[0].id);
    expect(JSON.stringify(captured)).not.toContain("never-store-this");
    expect(captured?.context?.messages[0].text).toContain("已隐藏");
    expect((await store.usage(query())).summary).toMatchObject({ requests: 4, measured: 4, inputTokens: 56, outputTokens: 12 });
  });
  it("distinguishes provider-reported zero from missing usage on failure", async () => {
    const faux = fauxProvider({ models: [{ id: "test" }] }), base = createModels();
    let reported = false;
    const make = (_m: unknown, _c: unknown, options?: StreamOptions) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = fauxAssistantMessage("", { stopReason: "error",
        errorMessage: "<html><head><style>" + ".hidden{display:none}".repeat(100) + "</style></head><body><h1>Request blocked</h1><p>Contact support.</p></body></html>" });
      void (async () => {
        await options?.onResponse?.({ status: 403, headers: { "content-type": "text/html", "set-cookie": "never-store-cookie" } }, faux.models[0]);
        if (reported) await options?.onProviderStreamEvent?.({ usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }, faux.models[0]);
        stream.push({ type: "error", reason: "error", error: message });
      })();
      return stream;
    };
    base.setProvider({ ...faux.provider, stream: make, streamSimple: make });
    const pending: Promise<unknown>[] = [];
    const models = captureModels(base, env, { waitUntil: p => { pending.push(p); } }, { thread: "owner", actor: "thread", purpose: "background" });
    const statuses: number[] = [];
    await models.complete(faux.models[0], { messages: [] }, { onResponse: value => { statuses.push(value.status); } }); await Promise.all(pending);
    reported = true; await models.completeSimple(faux.models[0], { messages: [] }); await Promise.all(pending);
    const rows = (await env.REQUESTS.getByName("main").list(query())).requests;
    expect(rows.map(r => r.inputTokens)).toEqual([0, null]);
    expect(rows.map(r => r.cacheRead)).toEqual([0, null]);
    expect(rows.every(r => r.status === "error")).toBe(true);
    expect(rows.map(r => r.error)).toEqual(["HTTP 403 · Request blocked\nContact support.", "HTTP 403 · Request blocked\nContact support."]);
    expect(statuses).toEqual([403]);
    expect(JSON.stringify(rows)).not.toContain("never-store-cookie");
  });
  it("keeps ordinary errors readable and redacts credentials before formatting", () => {
    expect(errorSummary("invalid model", 400)).toBe("HTTP 400 · invalid model");
    expect(errorSummary("Authorization: Bearer never-store-this", 401)).toBe("HTTP 401 · [含凭据的内容已隐藏]");
  });
  it("deduplicates terminal writes, pages without overlap, filters and ages details independently", async () => {
    const store = env.REQUESTS.getByName("main"), a = detail(crypto.randomUUID()), b = detail(crypto.randomUUID());
    await store.record(a); await store.record(b); await store.record(a);
    await store.record({ ...a, request: { ...a.request, status: "running", endedAt: null, inputTokens: null } });
    const first = await store.list({ ...query(), limit: 1 });
    const second = await store.list({ ...query(), limit: 1, before: first.next });
    expect(first.requests.map(r => r.id)).toEqual([b.request.id]); expect(second.requests.map(r => r.id)).toEqual([a.request.id]);
    expect(second.requests[0].status).toBe("done");
    expect((await store.list({ ...query(), thread: "group:123" })).requests).toEqual([]);
    const old = detail(crypto.randomUUID(), Date.now() - 8 * 86400_000); await store.record(old);
    expect((await store.detail(old.request.id))?.detailAvailable).toBe(false);
    expect((await store.usage({ ...query(), since: Date.now() - 10 * 86400_000 })).summary.requests).toBe(3);
    await runInDurableObject(store, (_instance, state) => { expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM request_details").one().n).toBe(2); });
  });
  it("guards every new route and validates queries", async () => {
    for (const path of ["/admin/agent-topology", "/admin/requests", "/admin/usage", "/admin/requests/"+crypto.randomUUID(), "/admin/threads/owner/chat", "/admin/threads/owner/trace", "/admin/tools/"+crypto.randomUUID()]) {
      expect((await worker.fetch(new Request("https://test"+path), { ...env, ADMIN_TOKEN:"test" })).status).toBe(401);
    }
    const call = (path: string) => worker.fetch(new Request("https://test"+path, { headers:{Authorization:"Bearer test"} }), { ...env, ADMIN_TOKEN:"test" });
    for (const q of ["status=unexpected", "since=NaN", "limit=101", "thread=other", "since=0&until=9999999999999"]) expect((await call("/admin/requests?"+q)).status).toBe(400);
    expect((await call("/admin/usage")).status).toBe(200);
    expect((await call("/admin/threads/owner/trace?turn=wrong")).status).toBe(400);
  });
  it("keeps tool failures separate from model status and reads bodies only in detail", async () => {
    const store=env.REQUESTS.getByName("main"), request=detail(crypto.randomUUID());
    request.request.binding={turnId:"turn:test",inputId:"web:test",generation:0};
    request.request.toolCalls=[{id:"call1",name:"qq_image"}];
    await store.record(request);
    const first=await store.turnTrace("owner",["turn:test"],0);
    const tool:ToolTrace={id:crypto.randomUUID(),thread:"owner",binding:request.request.binding,callId:"call1",name:"qq_image",startedAt:Date.now(),endedAt:null,status:"running",arguments:{text:'{"message_id":"123"}',chars:20,truncated:false}};
    await store.recordTool(tool);
    const running=await store.turnTrace("owner",["turn:test"],first.cursor);
    expect(running.requests).toEqual([]);expect(running.tools[0].status).toBe("running");
    expect(JSON.stringify(running)).not.toContain("message_id");
    await store.recordTool({...tool,status:"error",endedAt:Date.now(),result:{text:"image unavailable",chars:17,truncated:false}});
    const ended=await store.turnTrace("owner",["turn:test"],running.cursor);
    expect(ended.tools[0].status).toBe("error");
    const captured=await store.detail(request.request.id);
    expect(captured?.request.status).toBe("done");expect(captured?.tools[0].status).toBe("error");
    expect(captured?.tools[0]).not.toHaveProperty("result");
    expect((await store.turnTrace("group:123",["turn:test"],0)).tools).toEqual([]);
    expect((await store.toolDetail(tool.id))?.arguments?.text).toContain("message_id");
  });
  it("summarizes recent agents and their parents without loading request or tool bodies", async () => {
    const store=env.REQUESTS.getByName("main"),now=Date.now(),child=crypto.randomUUID(),otherChild=crypto.randomUUID();
    for(const [thread,actor,purpose,at,status] of [
      ["owner","thread","conversation",now-20000,"done"],
      ["owner","thread","background",now-10000,"error"],
      ["owner",child,"subagent",now-15000,"done"],
      ["owner",child,"compaction",now-5000,"running"],
      ["group:456",otherChild,"subagent",now-1000,"done"],
      ["private:123","thread","conversation",now-2000,"error"],
      ["private:999","thread","conversation",now-30*3600000,"done"],
    ] as const){
      const d=detail(crypto.randomUUID(),at);
      Object.assign(d.request,{thread,actor,purpose,status,endedAt:status==="running"?null:at+10});
      await store.record(d);
    }
    await store.recordTool({id:crypto.randomUUID(),thread:"owner",binding:{turnId:"turn:topology",inputId:"web:topology",generation:0},callId:"tool",name:"qq_image",startedAt:now,endedAt:null,status:"running",arguments:{text:"private arguments",chars:17,truncated:false}});
    const response=await worker.fetch(new Request("https://test/admin/agent-topology",{headers:{Authorization:"Bearer test"}}),{...env,ADMIN_TOKEN:"test"});
    expect(response.status).toBe(200);
    const data=await response.json<AgentTopology>();
    expect(data.nodes).toHaveLength(5);
    expect(data.nodes.find(n=>n.id==="thread:owner")).toMatchObject({parentId:null,activity:"active"});
    expect(data.nodes.find(n=>n.id===`sub:owner:${child}`)).toMatchObject({kind:"subagent",parentId:"thread:owner",activity:"active"});
    expect(data.nodes.find(n=>n.id==="thread:group:456")).toMatchObject({activity:"context",lastActiveAt:null});
    expect(data.nodes.find(n=>n.id==="thread:private:123")).toMatchObject({activity:"error"});
    expect(JSON.stringify(data)).not.toMatch(/private arguments|你好|contextWindow|inputTokens|toolCallId/);
    expect((await store.agentTopology()).sampledAt).toBe(data.sampledAt);
  });
});
