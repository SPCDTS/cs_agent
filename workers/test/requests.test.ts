import { env, reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream, type AssistantMessage, type StreamOptions } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { captureModels } from "../src/requests/capture";
import { snapshot, errorSummary } from "../src/requests/snapshot";
import { compareContext } from "../src/requests/context-store";
import { contextSource } from "../src/requests/context-source";
import { ExecutionStore } from "../src/requests/executions";
import { totalChars } from "../src/requests/context-types";
import { argumentPreview, toolResultSnapshot } from "../src/requests/tool-snapshot";
import type { RequestDetail, RequestQuery, ToolTrace } from "../src/requests/types";
import { readAgentTopology, type AgentTopology } from "../src/requests/topology";
import type { SubagentActivity } from "../src/subagent/activity";
import worker from "../src/index";

describe("requests core", () => {
  afterEach(() => reset());
  const query = (): RequestQuery => ({ since: Date.now() - 86400_000, until: Date.now() + 1000, limit: 40 });
  function detail(id: string, at = Date.now()): RequestDetail {
    return { request: { id, startedAt: at, endedAt: at + 10, thread: "owner", actor: "thread", purpose: "conversation", provider: "faux", model: "test",
      status: "done", inputTokens: 14, outputTokens: 3, cacheRead: 5, cacheWrite: 2, reasoningTokens: 2, durationMs: 10, contextWindow: 1000 },
      context: snapshot({ messages: [{ role: "user", content: "你好", timestamp: at }] }) };
  }
  describe("request observability", () => {
    it("普通写入不清扫历史，alarm清理过期正文及元数据且增量计数与更新一致", async () => {
      const store = env.REQUESTS.getByName("main"), now = Date.now(), item = detail("updated");
      await store.record({ ...item, request: { ...item.request, status: "running" } });
      item.context.messages[0]!.text = "更新后的较长正文";
      await store.record(item);
      const tool: ToolTrace = { id: "tool-updated", thread: "owner", binding: { turnId: "turn:updated", inputId: "web:updated", generation: 0 },
        callId: "call", name: "read", startedAt: now, endedAt: null, status: "running", arguments: { text: "{}", chars: 2, truncated: false } };
      await store.recordTool(tool);
      await store.recordTool({ ...tool, status: "done", result: { text: "完成", chars: 2, truncated: false } });
      await store.record(detail("expired"));
      await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec("UPDATE requests SET started=? WHERE id='expired'", now - 31 * 86400_000);
        state.storage.sql.exec("UPDATE request_details SET started=? WHERE id='updated'", now - 8 * 86400_000);
      });
      await store.record(detail("new"));
      expect((await store.detail("expired"))?.detailAvailable).toBe(true);
      expect((await store.detail("updated"))?.detailAvailable).toBe(true);
      const consistent = () => runInDurableObject(store, (_instance, state) => {
        const expected = state.storage.sql.exec(`SELECT (SELECT COUNT(*) FROM requests) AS request_count,
          (SELECT COALESCE(SUM(bytes),0) FROM request_details)+(SELECT COALESCE(SUM(bytes),0) FROM tool_traces) AS detail_bytes`).one();
        expect(state.storage.sql.exec("SELECT request_count,detail_bytes FROM request_retention WHERE id=1").one()).toEqual(expected);
      });
      await consistent();
      expect(await runDurableObjectAlarm(store)).toBe(true);
      await consistent();
      await runInDurableObject(store, async (_instance, state) => {
        expect(await state.storage.getAlarm()).not.toBeNull();
      });
      expect(await store.detail("expired")).toBeUndefined();
      expect((await store.detail("updated"))?.detailAvailable).toBe(false);
      expect((await store.toolDetail(tool.id))?.result?.text).toBe("完成");
    });
  
    it("跨过20000条及32MiB时逐出最旧正文，保留最新请求与准确容量计数", async () => {
      const store = env.REQUESTS.getByName("main"), now = Date.now(), seed = detail("seed", now - 1000);
      await store.record(seed); // 初始化旧表的增量计数迁移。
      seed.context.messages[0]!.text = "";
      const overhead = new TextEncoder().encode(JSON.stringify({ context: seed.context })).byteLength;
      seed.context.messages[0]!.text = "x".repeat(65_400 - overhead);
      const payload = JSON.stringify({ context: seed.context }), bytes = new TextEncoder().encode(payload).byteLength;
      await runInDurableObject(store, (_instance, state) => {
        const sql = state.storage.sql;
        sql.exec("DELETE FROM requests");
        sql.exec(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<20000)
          INSERT INTO requests(id,started,thread,model,purpose,status,record)
          SELECT 'seed:'||value,?,'owner','faux/test','conversation','done',json_set(?,'$.id','seed:'||value) FROM n`, now - 1000, JSON.stringify(seed.request));
        sql.exec(`INSERT INTO request_details(id,started,bytes,payload) SELECT id,started,?,? FROM requests ORDER BY seq LIMIT 512`, bytes, payload);
        expect(sql.exec<{ detail_bytes: number }>("SELECT detail_bytes FROM request_retention WHERE id=1").one().detail_bytes).toBeLessThan(33_554_432);
      });
      const newest = detail("newest", now); newest.context.messages[0]!.text = "y".repeat(256_000);
      await store.record(newest);
      await runInDurableObject(store, (_instance, state) => {
        const counters = state.storage.sql.exec<{ request_count: number; detail_bytes: number }>("SELECT request_count,detail_bytes FROM request_retention WHERE id=1").one();
        expect(counters.request_count).toBe(20000);
        expect(counters.detail_bytes).toBeLessThanOrEqual(33_554_432);
        expect(counters.detail_bytes).toBe(state.storage.sql.exec<{ bytes: number }>("SELECT SUM(bytes) AS bytes FROM request_details").one().bytes);
      });
      expect(await store.detail("seed:1")).toBeUndefined();
      expect((await store.detail("seed:10"))?.detailAvailable).toBe(false);
      expect((await store.detail("newest"))?.detailAvailable).toBe(true);
    });
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
      const searchFlags: boolean[] = [];
      const make = (_model: unknown, _context: unknown, options?: StreamOptions & { agentWebSearch?: boolean }) => {
        searchFlags.push(!!options?.agentWebSearch);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message });
        return stream;
      };
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
      expect(searchFlags).toEqual([true, true, false, true]); // completeSimple 是压缩请求
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
      const searchFlags: boolean[] = [];
      const make = (_m: unknown, _c: unknown, options?: StreamOptions & { agentWebSearch?: boolean }) => {
        searchFlags.push(!!options?.agentWebSearch);
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
      expect(searchFlags).toEqual([false, false]);
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
      for (const path of ["/admin/agent-topology", "/admin/agent-traces", "/admin/usage", "/admin/requests/"+crypto.randomUUID(), "/admin/threads/owner/chat", "/admin/threads/owner/progress", "/admin/tools/"+crypto.randomUUID()]) {
        expect((await worker.fetch(new Request("https://test"+path), { ...env, ADMIN_TOKEN:"test" })).status).toBe(401);
      }
      const call = (path: string) => worker.fetch(new Request("https://test"+path, { headers:{Authorization:"Bearer test"} }), { ...env, ADMIN_TOKEN:"test" });
      for (const q of ["status=unexpected", "since=NaN", "turn=bad", "thread=other", "since=0&until=9999999999999"]) expect((await call("/admin/agent-traces?"+q)).status).toBe(400);
      expect((await call("/admin/usage")).status).toBe(200);
      const id=crypto.randomUUID();
      for (const path of ["/admin/requests", "/admin/threads/owner/trace", "/admin/tools/"+id+"/execution", "/admin/subagents/"+id+"/transcript?thread=owner"]) {
        const response=await call(path);
        expect(response.status, path).toBe(404);
        expect(await response.text(), path).toBe("not found");
      }
      expect((await call("/admin/threads/owner/progress?turn=wrong")).status).toBe(400);
    });
    it("limits chat progress to the latest valid main-agent checklist and links usage filters to the same model call", async () => {
      const store=env.REQUESTS.getByName("main"), now=Date.now(), req=detail(crypto.randomUUID(),now);
      const binding={turnId:"turn:main",inputId:"web:main",generation:0};
      req.request.binding=binding;
      await store.record(req);
      await store.record({...req,request:{...req.request,id:crypto.randomUUID(),purpose:"compaction",model:"compact",status:"error"}});
      const first:ToolTrace={id:crypto.randomUUID(),thread:"owner",actor:"thread",binding,name:"update_steps",
        callId:"first",steps:[{title:"第一版",status:"pending"}],status:"done",startedAt:now,endedAt:now,
        arguments:{text:"should never appear",chars:19,truncated:false}};
      await store.recordTool(first);
      const steps=[{title:"已完成",status:"done" as const}];
      await store.recordTool({...first,id:crypto.randomUUID(),callId:"second",startedAt:now+1,steps});
      await store.recordTool({...first,id:crypto.randomUUID(),callId:"failed",startedAt:now+2,status:"error"});
      await store.recordTool({...first,id:crypto.randomUUID(),callId:"child",startedAt:now+3,actor:"child"});
      const active={...first,id:crypto.randomUUID(),callId:"read",name:"read",steps:undefined,status:"running" as const,endedAt:null};
      await store.recordTool(active);
      expect(await store.turnProgress("owner",[binding.turnId])).toEqual([{turnId:binding.turnId,active:true,steps}]);
      await store.recordTool({...active,status:"done",endedAt:now+4});
      expect(await store.turnProgress("owner",[binding.turnId])).toEqual([{turnId:binding.turnId,active:false,steps}]);
      expect(await store.turnProgress("group:123",[binding.turnId])).toEqual([]);
      expect((await store.agentTraces({...query(),model:"faux/test",purpose:"compaction",status:"error"})).traces).toEqual([]);
      const matches=await store.agentTraces({...query(),model:"faux/compact",purpose:"compaction",status:"error"});
      expect(matches.traces).toMatchObject([{root:binding.turnId,requests:2}]);
      expect(await store.requestSnapshot(req.request.id,true)).not.toHaveProperty("related");
      expect((await store.detail(req.request.id,true))?.related).toHaveLength(2);
    });
    it("按执行根和时间窗口限制账本读取，并保留旧请求的独立执行根", async () => {
      const store = env.REQUESTS.getByName("main"), now = Date.now();
      const root = { turnId: "turn:root", inputId: "web:root", generation: 0 };
      const child = { actor: "child", inputId: "task" };
      const legacy = detail("legacy", now);
      await store.record(legacy);
      await store.record({ ...legacy, request: { ...legacy.request, id: "child-model", actor: child.actor,
        binding: { ...root, inputId: child.inputId, turnId: "turn:child" } } });
      await store.recordTool({ id: "dispatch", name: "subagent", actor: "thread", thread: "owner", callId: "call",
        binding: root, dispatch: child, status: "done", startedAt: now, endedAt: now, arguments: {text:"{}", chars:2, truncated:false} });

      await runInDurableObject(store, (_instance, state) => {
        const sql = state.storage.sql;
        const batch = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<512) `;
        sql.exec(batch + `INSERT INTO requests(id,started,thread,turn_id,model,purpose,status,record)
          SELECT 'r'||i,1,'owner','outside','m','conversation','done','{}' FROM n`);
        sql.exec(batch + `INSERT INTO tool_traces(id,thread,turn_id,call_id,started,revision,record,bytes)
          SELECT 't'||i,'owner','outside','c'||i,1,0,'{}',0 FROM n`);
        sql.exec(batch + `INSERT INTO turn_timings(thread,input_id,turn_id,ended,revision,record)
          SELECT 'owner','i'||i,'outside',1,0,'{"receivedAt":1}' FROM n`);
        const ledger = new ExecutionStore(sql);
        const queries = vi.spyOn(sql, "exec");
        function bounded<T>(read: () => T): T {
          queries.mockClear();
          const result = read();
          const reads = queries.mock.results.reduce((n, call) => n + call.value.rowsRead, 0);
          expect(reads).toBeGreaterThan(0);
          expect(reads).toBeLessThan(150);
          return result;
        }
        try {
          const ids = bounded(() => ledger.detail("owner", root.turnId)).observations.map(row => row.id);
          expect(ids.sort()).toEqual(["child-model", "dispatch"]);
          const tail = bounded(() => ledger.detail("owner", root.turnId, {at: now, id: "model/child-model"}));
          expect(tail.observations.map(row => row.id)).toEqual(["dispatch"]);
          expect(bounded(() => ledger.analysis("owner", root.turnId)).groups).toMatchObject([{actor: child.actor, n:1}]);
          expect(ledger.detail("owner", "turn:child").observations).toEqual([]);
          expect(bounded(() => ledger.detail("owner", "request:legacy")).observations).toMatchObject([{id:"legacy"}]);
          for (const thread of [undefined, "owner"]) {
            const roots = bounded(() => ledger.list({ since: now, until: now, thread })).traces.map(trace => trace.root);
            expect(roots.sort()).toEqual(["request:legacy", root.turnId]);
          }
        } finally {
          queries.mockRestore();
        }
      });
    });
    it("keeps tool failures separate from model status and reads bodies only in detail", async () => {
      const store=env.REQUESTS.getByName("main"), request=detail(crypto.randomUUID());
      request.request.binding={turnId:"turn:test",inputId:"web:test",generation:0};
      request.request.toolCalls=[{id:"call1",name:"qq_image"}];
      await store.record(request);
      const tool:ToolTrace={id:crypto.randomUUID(),thread:"owner",binding:request.request.binding,callId:"call1",name:"qq_image",startedAt:Date.now(),endedAt:null,status:"running",arguments:{text:'{"message_id":"123"}',chars:20,truncated:false}};
      await store.recordTool(tool);
      const running=await store.agentTraceDetail("owner","turn:test");
      expect(running.observations.find(row=>row.id===tool.id)?.status).toBe("running");
      expect(JSON.stringify(running)).not.toContain("message_id");
      await store.recordTool({...tool,status:"error",endedAt:Date.now(),result:{text:"image unavailable",chars:17,truncated:false}});
      const ended=await store.agentTraceDetail("owner","turn:test");
      expect(ended.observations.find(row=>row.id===tool.id)?.status).toBe("error");
      const captured=await store.detail(request.request.id);
      expect(captured?.request.status).toBe("done");expect(captured?.tools[0].status).toBe("error");
      expect(captured?.tools[0]).not.toHaveProperty("result");
      expect((await store.agentTraceDetail("group:123","turn:test")).observations).toEqual([]);
      expect((await store.toolDetail(tool.id))?.arguments?.text).toContain("message_id");
    });
    it("reads progress for all 100 visible turns and isolates overlapping turn IDs by thread", async () => {
      const store=env.REQUESTS.getByName("main"), turns=Array.from({length:100},(_,i)=>"turn:visible:"+i);
      for (const turnId of [turns[0]!, turns[48]!, turns[99]!, "turn:outside"]) {
        const tool:ToolTrace={id:crypto.randomUUID(),thread:"owner",binding:{turnId,inputId:"web:"+turnId,generation:0},
          callId:"steps",name:"update_steps",startedAt:Date.now(),endedAt:Date.now(),status:"done",
          steps:[{title:turnId,status:"done"}],arguments:{text:"{}",chars:2,truncated:false}};
        await store.recordTool(tool);
        await store.recordTool({...tool,id:crypto.randomUUID(),thread:"group:12345",steps:[{title:"另一会话",status:"done"}]});
      }
      const params=new URLSearchParams();turns.forEach(turn=>params.append("turn",turn));
      const response=await worker.fetch(new Request("https://test/admin/threads/owner/progress?"+params,
        {headers:{Authorization:"Bearer test"}}),{...env,ADMIN_TOKEN:"test"});
      expect(response.status).toBe(200);
      const progress=await response.json<Awaited<ReturnType<typeof store.turnProgress>>>();
      expect(progress.map(row=>row.steps[0]?.title).sort()).toEqual([turns[0],turns[48],turns[99]].sort());
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
});

describe("requests context monitor", () => {
  afterEach(() => reset());
  const make = (text: string, at: number, actor = "thread"): RequestDetail => {
    const context = snapshot({ messages: [{ role: "user", content: text, timestamp: 100 }] });
    return { context, request: { id: crypto.randomUUID(), startedAt: at, endedAt: at + 10, thread: "owner", actor,
      purpose: actor === "thread" ? "conversation" : "subagent", provider: "faux", model: "test", status: "done", inputTokens: 100,
      outputTokens: 10, cacheRead: 0, cacheWrite: null, reasoningTokens: null, contextWindow: 1000, durationMs: 10, contextMetrics: context.analysis?.metrics } };
  };
  
  describe("上下文监控", () => {
    it("截断前统计全部消息与工具结果，正文仍脱敏且按原序号展开", async () => {
      const at = Date.now(), context = snapshot({ systemPrompt: "规则", messages: [
        ...Array.from({ length: 105 }, (_, i) => ({ role: "user" as const, content: "历史 " + i, timestamp: i })),
        { role: "toolResult", content: [{ type: "text", text: "结果".repeat(18000) }], toolCallId: "call", toolName: "env_job_get", isError: false, timestamp: at },
        { role: "user", content: "Authorization: Bearer never-store-this-secret", timestamp: at + 1 },
      ] });
      const metrics = context.analysis!.metrics;
      expect(metrics.messageCount).toBe(107);
      expect(metrics.chars.result).toBe(36000);
      expect(totalChars(metrics.chars)).toBe(context.chars.system + context.chars.tools + context.chars.messages);
      expect(context.analysis!.items.find(item => item.id === "message:0")?.bodyAvailable).toBe(false);
      const item = make("test", at); item.context = context; item.request.contextMetrics = metrics;
      const store = env.REQUESTS.getByName("main"); await store.record(item);
      expect((await store.contextPart(item.request.id, "message:105"))?.part).toMatchObject({ chars: 36000, truncated: true });
      expect((await store.contextPart(item.request.id, "message:106"))?.part.text).toContain("已隐藏");
      expect(await store.contextPart(item.request.id, "message:0")).toBeUndefined();
      expect(JSON.stringify(await store.contextInspection(item.request.id))).not.toContain("never-store-this-secret");
      expect(JSON.stringify(await store.detail(item.request.id, true))).not.toContain("历史 104");
    });
  
    it("相邻比较隔离 agent，重复消息按数量配对，清理正文后保留实测曲线", async () => {
      const store = env.REQUESTS.getByName("main"), now = Date.now(), child = crypto.randomUUID();
      const before = make("修改前", now - 400), other = make("其他 agent", now - 300, child), after = make("修改后", now - 200);
      await store.record(before); await store.record(other); await store.record(after);
      const inspection = await store.contextInspection(after.request.id);
      expect(inspection?.previous?.id).toBe(before.request.id);
      expect(inspection?.comparison?.added.find(item => item.category === "user")?.chars).toBe(3);
      expect((await store.contextTimeline("owner", child)).points.map(point => point.id)).toEqual([other.request.id]);
      const repeated = before.context.analysis!.items.find(item => item.category === "user")!;
      expect(compareContext([repeated, repeated], [repeated])).toMatchObject({ added: [], removed: [repeated], kept: 3 });
      await runInDurableObject(store, (_instance, state) => state.storage.sql.exec("DELETE FROM request_details"));
      expect((await store.contextInspection(after.request.id))?.analysis).toBeNull();
      expect((await store.contextTimeline("owner", "thread")).points.at(-1)).toMatchObject({ inputTokens: 100, cacheRead: 0, metrics: { messageCount: 1 } });
    });
  
    it.each(["thread", "child"])("真实 Harness 压缩及恢复后仍能识别摘要和保留内容：%s", async actor => {
      const store = env.REQUESTS.getByName("main"), context = BACKGROUND_CONTEXT, pending: Promise<unknown>[] = [];
      await runInDurableObject(env.THREAD.getByName("context-monitor-test-" + actor), async (_instance, state) => {
        const base = createModels(), faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
        faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("已处理，保留工作摘要。")));
        base.setProvider(faux.provider);
        const open = async () => {
          const storage = await openDurableObjectSqliteStorage(state.storage, { prefix: "monitor_" });
          const source = contextSource(state.storage, () => harness), registry = createRegistry(); registry.install(source.extension);
          const models = captureModels(base, env, { waitUntil: promise => { pending.push(promise); } },
            { thread: "owner", actor, purpose: actor === "thread" ? "conversation" : "subagent" }, undefined, source.origin);
          const harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false, keepRecentTokens: 80 } } }, context);
          const root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: "test" } } });
          return { harness, root };
        };
        let runtime = await open();
        try {
          for (let index = 0; index < 4; index++) await (await runtime.root.submit({ type: "input", content: "旧任务".repeat(400) + index }, context)).wait(context);
          const task = await runtime.root.compact(undefined, context); await runtime.harness.waitForTask(task, context); await runtime.root.waitForIdle(context);
          await runtime.harness.close(context); runtime = await open();
          await (await runtime.root.submit({ type: "input", content: "压缩后继续" }, context)).wait(context);
        } finally { await runtime.harness.close(context); }
      });
      await Promise.all(pending);
      const points = (await store.contextTimeline("owner", actor)).points, last = points.at(-1)!;
      expect(last.metrics?.head?.kind).toBe("compaction");
      expect(last.metrics?.chars.summary).toBeGreaterThan(0);
      expect(last.metrics?.retainedChars).toBeGreaterThan(0);
      expect(last.metrics?.addedChars).toBe("压缩后继续".length);
      expect((await store.contextInspection(last.id))?.comparison?.compactionApplied).toBe(true);
    });
  });
});

describe("requests tool execution", () => {
  afterEach(() => reset());
  
  it("历史 CodeMode 结果关联完整调用树并隔离 actor，执行正文不计入上下文", async () => {
    const store = env.REQUESTS.getByName("main"), now = Date.now(), binding = { turnId: "turn:tree", inputId: "web:test", generation: 0 };
    const source: RequestDetail = { request: { id: crypto.randomUUID(), thread: "owner", actor: "thread", purpose: "conversation", binding,
      provider: "test", model: "test", contextWindow: 1000, status: "done", startedAt: now - 100, endedAt: now - 90, durationMs: 10,
      inputTokens: 10, outputTokens: 10, cacheRead: 0, cacheWrite: null, reasoningTokens: null, toolCalls: [{ id: "same-call", name: "codemode" }] }, context: snapshot({ messages: [] }) };
    await store.record(source);
    const root: ToolTrace = { id: crypto.randomUUID(), thread: "owner", actor: "thread", binding, callId: "same-call", name: "codemode", startedAt: now - 80, endedAt: now - 20, status: "done", arguments: { text: "{}", chars: 2, truncated: false }, result: { text: "五字的输出", chars: 5, truncated: false } };
    const child: ToolTrace = { ...root, id: crypto.randomUUID(), callId: "child", parentCallId: root.callId, name: "read", result: { text: "原始长结果".repeat(100), chars: 500, truncated: false } };
    const grandchild: ToolTrace = { ...child, id: crypto.randomUUID(), callId: "grandchild", parentCallId: child.callId, name: "mcp_lookup", status: "error" };
    await store.recordTool(root); await store.recordTool(child); await store.recordTool(grandchild);
    const foreign: ToolTrace = { ...root, id: crypto.randomUUID(), actor: crypto.randomUUID(), binding: { ...binding, turnId: "turn:other-agent" }, startedAt: now - 10, name: "foreign" };
    await store.recordTool(foreign);
    const context = snapshot({ messages: [{ role: "toolResult", toolName: "codemode", toolCallId: root.callId, content: [{ type: "text", text: "五字的输出" }], isError: false, timestamp: now - 15 }] });
    const current: RequestDetail = { request: { ...source.request, id: crypto.randomUUID(), startedAt: now, endedAt: now + 10, toolCalls: [], contextMetrics: context.analysis?.metrics }, context };
    await store.record(current);
    expect((await store.detail(source.request.id))?.tools.map(tool => tool.id).sort()).toEqual([root.id, child.id, grandchild.id].sort());
    const result = await store.contextInspection(current.request.id);
    expect(result?.analysis?.metrics.chars.result).toBe(5);
    expect(result?.analysis?.items.find(item => item.category === "result")?.execution).toMatchObject({ id: root.id, calls: 2, failures: 1, label: "read · mcp_lookup" });
    expect(JSON.stringify(result)).not.toContain("原始长结果");
    const records=(await store.agentTraceDetail("owner",binding.turnId)).observations;
    expect(records.find(row=>row.id===source.request.id)?.calls).toContain(root.callId);
    expect(records.filter(row=>row.kind==="tool")).toHaveLength(3);
    await runInDurableObject(store, (_instance, state) => state.storage.sql.exec("UPDATE tool_traces SET payload=NULL,bytes=0"));
    expect((await store.toolDetail(root.id))?.detailAvailable).toBe(false);
    expect((await store.toolDetail(root.id))?.result).toBeUndefined();
  });
  
  it("结构化结果保留可读字段，凭据与图片正文隐藏，大小仍受原有截断限制", () => {
    const captured = toolResultSnapshot({ structuredOutput: { count: 3, image: { type: "image", data: "private-base64", mimeType: "image/png" }, value: "内容" } });
    expect(captured.structuredResult?.text).toContain('"count": 3');
    expect(captured.structuredResult?.text).not.toContain("private-base64");
    expect(toolResultSnapshot({ structuredOutput: { token: "private-token" } }).structuredResult?.text).toContain("已隐藏");
    expect(toolResultSnapshot({ structuredOutput: { content: "长".repeat(20000) } }).structuredResult?.truncated).toBe(true);
    expect(argumentPreview({ command: "curl -H 'Authorization: Bearer private-token'" })).toBe("含凭据的参数已隐藏");
  });
});
