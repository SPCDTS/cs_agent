import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { Context } from "@earendil-works/chord/context";
import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import worker from "../src/index";
import { classifyError, logDiag, type DiagRecord } from "../src/shared/diagnostics";
import { safeError } from "../src/mcp/connection";
import { createSubagentCapabilityHost } from "../src/mcp/delegated";
import * as models from "../src/models";
import { hydrateCatalogs, ModelAlarm, modelEgressDiagnostics, openModels } from "../src/models";
import { captureModels } from "../src/requests/capture";
import { threadView } from "../src/admin/read-views";
import { snapshot } from "../src/requests/snapshot";
import { createOpsExtension } from "../src/tools/ops";
import { threadWithBindings } from "./thread-fixture";
import { input } from "./helpers";

describe("diagnostics core", () => {
  const TOKEN = "test-admin-only";
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  
  describe("诊断分类与环形日志缓冲", () => {
    it("提取安全错误分类并排除自由文本与潜在凭据", () => {
      const timeout = new DOMException("operation timed out", "TimeoutError");
      expect(classifyError(timeout)).toEqual({ errorName: "TimeoutError", code: "timeout" });
  
      const coded = Object.assign(new Error("device_cloudflare_rate_limited"), { status: 429 });
      expect(classifyError(coded)).toEqual({ errorName: "Error", code: "device_cloudflare_rate_limited", status: 429 });
  
      const sensitive = new Error("Bearer sk-proj-1234567890abcdefghijklmnop failed with raw payload");
      const info = classifyError(sensitive);
      expect(info).toEqual({ errorName: "Error" });
      expect(JSON.stringify(info)).not.toContain("sk-proj");
  
      expect(classifyError(new Error("https://secret.example.com/v1?key=abc"))).toEqual({ errorName: "Error" });
  
      // 超过 200 字符的 3 段式 JWT 必须在截断前命中脱敏规则，不能因先 slice(0, 160) 漏掉第三段而泄露。
      const longJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "a".repeat(150) + ".c2lnbmF0dXJlX3BhcnRfdGhhdF9pc19iZXlvbmRfMTYwX2NoYXJz";
      const entry = logDiag(undefined, undefined, {
        event: "jwt_redact_check",
        detail: { token: longJwt, upstream: { status: 503 } },
      });
      expect(entry.detail).toEqual({ token: "[redacted]", upstream: 503 });
    });
  
    it("双写至 RequestsDO 环形表、支持按条件查询并维持 1000 条容量上限", async () => {
      const store = env.REQUESTS.getByName("main");
      await store.recordDiag({ at: 1001, level: "error", event: "synthetic_tick", thread: "group:200000001", code: "ok" });
      await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<995)
          INSERT INTO ops_logs(at,level,event,thread,turn_id,code,record)
          SELECT 1000+i, CASE WHEN i%2=0 THEN 'warn' ELSE 'error' END, 'synthetic_tick', 'group:200000001', NULL, 'ok',
            json_object('at',1000+i,'level',CASE WHEN i%2=0 THEN 'warn' ELSE 'error' END,'event','synthetic_tick','thread','group:200000001','code','ok')
          FROM n`);
      });
      for (let i = 996; i <= 1005; i++) {
        await store.recordDiag({
          at: 1000 + i,
          level: i % 2 === 0 ? "warn" : "error",
          event: i === 1005 ? "mcp_refresh_failed" : "synthetic_tick",
          thread: i === 1005 ? "owner" : "group:200000001",
          turnId: i === 1005 ? "turn:msg:1005" : undefined,
          code: i === 1005 ? "timeout" : "ok",
        });
      }
      const all = await store.queryLogs({ limit: 200 });
      expect(all.logs[0]).toMatchObject({ seq: 1005, event: "mcp_refresh_failed", thread: "owner", code: "timeout" });
      const oldest = await store.queryLogs({ before: 20, limit: 20 });
      expect(oldest.logs.every(row => (row.seq ?? 0) >= 6)).toBe(true);
  
      logDiag(env, undefined, {
        event: "admin_projection_failed",
        thread: "owner",
        error: new DOMException("slow", "TimeoutError"),
        detail: { secret: "Bearer sk-secret-token-value-1234567890", retries: 2 },
      });
      await expect.poll(async () => (await store.queryLogs({ event: "admin_projection_failed", limit: 5 })).logs.length).toBe(1);
      const res = await worker.fetch(new Request("https://test/admin/logs?thread=owner&level=error&limit=5", {
        headers: { Authorization: "Bearer " + TOKEN },
      }), { ...env, ADMIN_TOKEN: TOKEN });
      expect(res.status).toBe(200);
      const body = await res.json<{ logs: DiagRecord[] }>();
      expect(body.logs.map(l => l.event)).toEqual(["admin_projection_failed", "mcp_refresh_failed"]);
      expect(JSON.stringify(body)).not.toContain("sk-secret-token");
  
      expect((await worker.fetch(new Request("https://test/admin/logs"), { ...env, ADMIN_TOKEN: TOKEN })).status).toBe(401);
      for (const bad of ["level=debug", "limit=999", "thread=bad..key"]) {
        expect((await worker.fetch(new Request("https://test/admin/logs?" + bad, {
          headers: { Authorization: "Bearer " + TOKEN },
        }), { ...env, ADMIN_TOKEN: TOKEN })).status).toBe(400);
      }
    });
  
    it("Worker tail 仅捕获非 ok 平台终态、跳过 consumedEvents 自身事件并限制单批数量", async () => {
      const pending: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
      await worker.tail?.([
        { outcome: "ok", exceptions: [], logs: [], eventTimestamp: 2000, scriptName: "joule", event: null } as unknown as TraceItem,
        { outcome: "exception", exceptions: [], logs: [], eventTimestamp: 2000, scriptName: "joule", event: { consumedEvents: [] } } as unknown as TraceItem,
        ...Array.from({ length: 25 }, (_, i) => ({
          outcome: "exceededCpu",
          exceptions: [{ name: "Error", message: "sensitive", timestamp: 2001 + i }],
          logs: [],
          eventTimestamp: 2001 + i,
          scriptName: "joule",
          scriptVersion: { id: "v-test" },
          event: null,
        } as unknown as TraceItem)),
      ], env, ctx);
      await Promise.all(pending);
      const { logs } = await env.REQUESTS.getByName("main").queryLogs({ event: "platform_invocation_failed", limit: 50 });
      expect(logs).toHaveLength(20);
      expect(logs[0]).toMatchObject({ code: "exceededCpu", errorName: "Error", detail: { scriptVersion: "v-test" } });
      expect(JSON.stringify(logs[0])).not.toContain("sensitive");
    });
  
    it("细分 MCP 超时、委托 RPC 故障与出口探针超时，不再笼统归为协议错误或权限拒绝", async () => {
      expect(safeError(new DOMException("aborted", "TimeoutError")).code).toBe("timeout");
      expect(safeError({ code: -32001, message: "MCP request timed out" }).code).toBe("timeout");
  
      const delegated = createSubagentCapabilityHost({
        subagentMcp: async () => { throw new DOMException("parent slow", "TimeoutError"); },
        subagentSkill: async () => { throw new Error("denied"); },
      });
      const timedOut = await delegated.subagentMcp("sub-1", { name: "t", args: {}, operationId: "1" });
      expect(timedOut.output?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("timeout：MCP 调用未成功") });
      const denied = await delegated.subagentSkill("sub-1", { name: "s" });
      expect(denied.output?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("denied：MCP 调用未成功") });
  
      const egress = await modelEgressDiagnostics(async () => { throw new DOMException("probe timed out", "TimeoutError"); });
      expect(egress.probes.every(p => p.error === "timeout")).toBe(true);
    });
  
    it("聚合模型 TTFT/推理 Token/费用、回合端到端耗时、MCP 健康度与统一面板告警", async () => {
      const store = env.REQUESTS.getByName("main");
      const now = Date.now();
      await store.record({
        request: {
          id: "11111111-1111-4111-8111-111111111111",
          startedAt: now - 1000,
          endedAt: now - 200,
          durationMs: 800,
          ttftMs: 180,
          alarmWaitMs: 35,
          thread: "owner",
          binding: { turnId: "turn:web:t1", inputId: "web:t1", generation: 0 },
          actor: "thread",
          purpose: "conversation",
          provider: "google",
          model: "gemini-3.1-flash-lite-preview",
          status: "done",
          inputTokens: 500,
          outputTokens: 120,
          cacheRead: 200,
          cacheWrite: null,
          reasoningTokens: 60,
          costUsd: 0.0042,
          contextWindow: 1_048_576,
        },
        context: snapshot({ messages: [] }),
      });
      await store.recordTurnTiming({
        thread: "owner",
        turnId: "turn:web:t1",
        inputId: "web:t1",
        kind: "message",
        origin: "web",
        status: "done",
        receivedAt: now - 1200,
        admittedAt: now - 1100,
        queueWaitMs: 100,
        firstDeliveredAt: now - 150,
        deliveryWaitMs: 0,
        endedAt: now - 100,
        totalMs: 1100,
      });
  
      const usage = await store.usage({ since: now - 60_000, until: now + 1000, thread: "owner" });
      expect(usage.summary).toMatchObject({
        requests: 1,
        reasoningTokens: 60,
        avgDuration: 800,
        avgTtft: 180,
      });
      expect(Number(usage.summary.costUsd)).toBeCloseTo(0.0042, 6);
  
      const timings = (await store.agentTraceDetail("owner","turn:web:t1")).observations.filter(row=>row.kind==="turn");
      expect(timings).toHaveLength(1);
      expect(timings[0]).toMatchObject({timing:{queue:100},label:"web"});
      expect(timings[0]!.ended! - timings[0]!.started).toBe(1100);
      expect((await store.recentTurns("owner", 5))[0]?.turnId).toBe("turn:web:t1");
  
      const owner = env.THREAD.getByName("owner");
      await owner.syncAdminView("owner");
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, 'mcp_catalog', ?)", now - 500, JSON.stringify({ server: "notion", status: "ok", tools: 3 }));
        state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, 'mcp_call', ?)", now - 400, JSON.stringify({ server: "notion", tool: "search", ms: 120, result: "ok" }));
        state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, 'mcp_call', ?)", now - 300, JSON.stringify({ server: "notion", tool: "fetch", ms: 300, result: "not_started", code: "timeout" }));
      });
      await owner.syncAdminView("owner");
      const mcp = await threadView(env, "owner").mcpHealth();
      expect(mcp.notion).toMatchObject({ calls: 2, failed: 1, avgMs: 210, maxMs: 300, lastError: "not_started:timeout", catalogStatus: "ok" });
  
      const registry = env.REGISTRY.getByName("main");
      await registry.recordAlert({ kind: "schedule_paused", scope: "sched-1", origin: "web", episode: "1", message: "定时任务暂停" });
      await registry.recordAlert({ kind: "event_source", scope: "gmail", origin: "web", episode: "1", message: "Gmail 降级" });
      await registry.recordAlert({ kind: "sandbox_error", scope: "sandbox", origin: "web", episode: "1", message: "沙箱退出" });
      expect((await registry.alerts(10)).filter(a => a.closedAt === null)).toHaveLength(3);
      await registry.resolveAlert("schedule_paused", "sched-1", "web");
  
      const healthRes = await worker.fetch(new Request("https://test/admin/health", {
        headers: { Authorization: "Bearer " + TOKEN },
      }), { ...env, ADMIN_TOKEN: TOKEN });
      expect(healthRes.status).toBe(200);
      const health = await healthRes.json<{ sandbox: { status: string; bootCount: number }; alerts: { active: number }; mcp: { server: string; health?: { calls: number } }[] }>();
      expect(health.sandbox).toMatchObject({ status: "unavailable", bootCount: 0 });
      expect(health.alerts).toEqual({ active: 2 });
      expect(health.mcp.find(s => s.server === "notion")?.health).toMatchObject({ calls: 2, failed: 1 });
  
      // 大量已关闭告警不会挤掉较早的未关闭告警。
      for (let i = 0; i < 60; i++) {
        await registry.recordAlert({ kind: "event_source", scope: `closed-${i}`, origin: "web", episode: "1", message: "已恢复告警" });
        await registry.resolveAlert("event_source", `closed-${i}`, "web");
      }
      expect(await registry.activeAlertCount()).toBe(2);
      expect((await registry.activeAlerts(10)).map(a => a.scope).sort()).toEqual(["gmail", "sandbox"]);
    });
  
    it("通过真实 ModelAlarm + captureModels 链路记录 alarmWaitMs，且沙箱主动重置不误报异常退出或跨实例互关告警", async () => {
      await runInDurableObject(env.THREAD.getByName("alarm-wait-test"), async (_instance, state) => {
        const pending: Promise<unknown>[] = [];
        const trackedState = new Proxy(state, {
          get(target, prop) {
            if (prop === "waitUntil") return (p: Promise<unknown>) => { pending.push(p); target.waitUntil(p); };
            const v = Reflect.get(target, prop, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        const modelAlarm = new ModelAlarm(trackedState);
        vi.spyOn(state.storage, "setAlarm").mockImplementation(async () => {
          setTimeout(() => modelAlarm.dispatch(), 15);
        });
        const item = { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "pong" }] };
        const sse = [
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
        ].map(event => "data: " + JSON.stringify(event) + "\n\n").join("");
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
          sse,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ));
  
        const catalogs = hydrateCatalogs({ catalog: [{
          slug: "codex-alarm-test", display_name: "Codex Test", visibility: "list",
          context_window: 128_000, max_output_tokens: 4096, input_modalities: ["text"], supported_reasoning_levels: undefined,
        }] });
        const fakeJwt = [btoa('{"alg":"RS256"}'), btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } })), "sig"].join(".");
        const cred = {
          type: "oauth" as const,
          flow: "codex-native" as const,
          accountId: "acct_test",
          access: fakeJwt,
          refresh: "r",
          expires: Date.now() + 3600_000,
          clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
          subject: "sub",
          idToken: "idt",
          scope: "openid",
          hostId: "host",
          catalog: [{ slug: "codex-alarm-test", display_name: "Codex Test", visibility: "list" }],
        };
        const credentials = {
          read: async () => cred,
          list: async () => [],
          delete: async () => {},
          modify: async (_p: string, fn: (c: typeof cred | undefined) => unknown) => fn(cred) as never,
        };
        const baseModels = openModels(env, credentials, modelAlarm.fetch, () => catalogs);
        const captured = captureModels(baseModels, env, trackedState, { thread: "owner", actor: "thread", purpose: "conversation" });
        const codex = captured.getModel("openai-codex", "codex-alarm-test")!;
        const msg = await captured.complete(
          codex,
          { messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }] },
          { transport: "sse" },
        );
        expect(msg.errorMessage).toBeUndefined();
        expect(msg.stopReason).toBe("stop");
        await Promise.all(pending);
      });
  
      const { requests } = await env.REQUESTS.getByName("main").list({ since: 0, until: Date.now() + 1000, thread: "owner", limit: 5 });
      expect(requests).toHaveLength(1);
      expect(typeof requests[0]!.alarmWaitMs).toBe("number");
      expect(requests[0]!.alarmWaitMs!).toBeGreaterThanOrEqual(10);
      // 无定价订阅模型 costUsd 应为 null 而非误导性的 0。
      expect(requests[0]!.costUsd).toBeNull();
  
      // 验证 SandboxDO：主动 resetRuntime 不误记 exitCount 或 sandbox_error，异常退出按实例隔离告警 scope。
      const ownerSandbox = env.SANDBOX.getByName("owner");
      const groupSandbox = env.SANDBOX.getByName("group:200000001");
      await runInDurableObject(groupSandbox, async (instance, state) => {
        let rejectMonitor!: (reason?: unknown) => void;
        let running = false;
        Object.defineProperty(state, "container", {
          configurable: true,
          value: {
            get running() { return running; },
            images: { sandbox: "test" },
            start: () => { running = true; },
            setInactivityTimeout: async () => {},
            monitor: () => new Promise<void>((_resolve, reject) => { rejectMonitor = reject; }),
            destroy: async () => { running = false; rejectMonitor(new Error("destroyed")); },
          },
        });
        await (instance as unknown as { startRuntime(): Promise<unknown> }).startRuntime();
        rejectMonitor(new Error("oom_killed"));
        await expect.poll(async () => (await instance.telemetry()).exitCount).toBe(1);
      });
      expect(await env.REGISTRY.getByName("main").activeAlertCount()).toBe(1);
  
      await runInDurableObject(ownerSandbox, async (instance, state) => {
        let rejectMonitor!: (reason?: unknown) => void;
        let running = false;
        Object.defineProperty(state, "container", {
          configurable: true,
          value: {
            get running() { return running; },
            images: { sandbox: "test" },
            start: () => { running = true; },
            setInactivityTimeout: async () => {},
            monitor: () => new Promise<void>((_resolve, reject) => { rejectMonitor = reject; }),
            destroy: async () => { running = false; rejectMonitor(new Error("restore committed workspace")); },
          },
        });
        await (instance as unknown as { startRuntime(): Promise<unknown> }).startRuntime();
        await instance.resetRuntime();
        await expect.poll(async () => await instance.telemetry()).toMatchObject({ bootCount: 1, exitCount: 0 });
      });
      // owner 沙箱启动与主动重置不得误关 group 沙箱的未恢复告警，也不新增自身告警。
      expect(await env.REGISTRY.getByName("main").activeAlertCount()).toBe(1);
    });
  });
});

describe("ops observability tools", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  
  function scriptedModel(steps: { name: string; args: JsonObject }[]) {
    const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const offers: string[] = [], sections: string[] = [], outputs: string[] = [];
    const pendingCalls = new Set<string>();
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      const system = getCurrentSystemMessage(transcript.messages);
      offers.push(...(system?.toolsAdded ?? []).map(tool => tool.name));
      if (system?.sections?.codemode) sections.push(system.sections.codemode);
      for (const message of transcript.messages) {
        if (message.role === "toolResult" && pendingCalls.delete(message.toolCallId)) {
          outputs.push(message.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
        }
      }
      const next = steps.shift();
      if (!next) return fauxAssistantMessage("done");
      const call = fauxToolCall(next.name, next.args);
      pendingCalls.add(call.id);
      return fauxAssistantMessage(call, { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation(() => {
      const m = createModels();
      m.setProvider(faux.provider);
      return m;
    });
    return { offers, sections, outputs };
  }
  
  describe("Joule 自观测能力（ops_health 与 runtime-ops Code Mode 命名空间）", () => {
    it("向主人会话暴露顶层 ops_health 与 Code Mode runtime-ops，并默认过滤当前回合自身请求", async () => {
      const now = Date.now();
      const store = env.REQUESTS.getByName("main");
      const priorReqId = "22222222-2222-4222-8222-222222222222";
      await store.record({
        request: {
          id: priorReqId,
          startedAt: now - 5_000,
          endedAt: now - 4_200,
          durationMs: 800,
          ttftMs: 150,
          thread: "owner",
          binding: { turnId: "turn:prior", inputId: "msg:prior", generation: 0 },
          actor: "thread",
          purpose: "conversation",
          provider: "google",
          model: "gemini-3-flash-preview",
          status: "done",
          inputTokens: 400,
          outputTokens: 100,
          cacheRead: 100,
          cacheWrite: null,
          reasoningTokens: 40,
          costUsd: 0.0025,
          contextWindow: 1_048_576,
        },
        context: snapshot({ messages: [] }),
      });
      await store.recordTurnTiming({
        thread: "owner",
        turnId: "turn:prior",
        inputId: "msg:prior",
        kind: "message",
        origin: "qq",
        status: "done",
        receivedAt: now - 5_200,
        admittedAt: now - 5_000,
        queueWaitMs: 200,
        firstDeliveredAt: now - 4_100,
        deliveryWaitMs: 50,
        endedAt: now - 4_000,
        totalMs: 1_200,
      });
      await store.recordDiag({
        at: now - 3_000,
        level: "error",
        event: "mcp_refresh_failed",
        thread: "owner",
        code: "timeout",
      });
      await env.REGISTRY.getByName("main").recordAlert({
        kind: "event_source",
        scope: "gmail",
        origin: "web",
        episode: "ep-1",
        message: "Gmail 连续拉取失败",
      });
  
      const script = [
        "const access = await describeNamespace('access'), runtime = await describeNamespace('runtime-ops');",
        "await tools.edge_grant({from:'owner',to:'private:42'});",
        "const usage = await tools.ops_usage({ hours: 24, thread: 'owner' });",
        "const reqs = await tools.ops_requests({ hours: 24, thread: 'owner', includeTimings: true });",
        `const inspected = await tools.ops_inspect({ kind: 'request', id: '${priorReqId}' });`,
        "const logs = await tools.ops_logs({ source: 'diag', level: 'error' });",
        "text('RESULT_JSON:' + JSON.stringify({",
        "  access:access.tools, runtime:runtime.tools,",
        "  priorFound: reqs.requests.some(r => r.id === '" + priorReqId + "'),",
        "  hasSelfTurn: reqs.requests.some(r => r.binding?.turnId === reqs.excludedTurnId),",
        "  excludedTurnId: reqs.excludedTurnId,",
        "  timingTurns: reqs.timings.map(t => t.turnId),",
        "  inspectedModel: inspected.request?.model,",
        "  bodyDeferred: inspected.bodyDeferred,",
        "  logEvents: logs.logs.map(l => l.event),",
        "  reasoningTokens: usage.summary.reasoningTokens,",
        "}));",
      ].join("\n");
  
      const seen = scriptedModel([
        { name: "ops_health", args: {} },
        { name: "codemode", args: { code: script } },
      ]);
  
      const auditRows = await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        expect(await thread.submit(input(1, "查看运行状态", 10000001))).toEqual({ status: "done" });
        return state.storage.sql.exec<{ detail: string }>("SELECT detail FROM events WHERE kind = 'runtime_ops' ORDER BY rowid").toArray();
      });
  
      // 仅 ops_health 作为顶层模型工具暴露，其余 4 个工具收纳在 runtime-ops 命名空间。
      expect(seen.offers).toContain("ops_health");
      for (const hidden of ["ops_usage", "ops_requests", "ops_inspect", "ops_logs"]) {
        expect(seen.offers).not.toContain(hidden);
      }
      expect(seen.sections.join("\n")).toContain("runtime-ops");
      expect(seen.sections.join("\n")).toContain("ops_usage");
  
      const healthOut = JSON.parse(seen.outputs[0]!);
      expect(healthOut).toMatchObject({
        components: { worker: "ready" },
        alerts: { active: 1 },
        activeAlerts: [expect.objectContaining({ kind: "event_source", scope: "gmail" })],
      });
  
      expect(seen.outputs[1]).toContain("Script completed");
      const jsonLine = seen.outputs[1]!.split("\n").find(line => line.startsWith("RESULT_JSON:"))!;
      const codemodeOut = JSON.parse(jsonLine.slice("RESULT_JSON:".length));
      expect(codemodeOut).toMatchObject({
        access: expect.arrayContaining(["auth_grant","auth_revoke","auth_list","qq_chats","edge_list","edge_revoke","edge_grant"]),
        runtime: expect.arrayContaining(["ops_health","ops_usage","ops_requests","ops_inspect","ops_logs","sandbox_list","sandbox_create"]),
        priorFound: true,
        hasSelfTurn: false,
        excludedTurnId: expect.stringMatching(/^turn:/),
        timingTurns: ["turn:prior"],
        inspectedModel: "gemini-3-flash-preview",
        bodyDeferred: true,
        logEvents: expect.arrayContaining(["mcp_refresh_failed"]),
      });
      expect(await env.REGISTRY.getByName("main").edgeAllowed("owner","private:42")).toBe(true);
      expect(Number(codemodeOut.reasoningTokens)).toBeGreaterThanOrEqual(40);
      expect(auditRows.map(r => JSON.parse(r.detail))).toEqual([
        { tool: "ops_health", result: "ok" },
        { tool: "ops_usage", result: "ok" },
        { tool: "ops_requests", result: "ok" },
        { tool: "ops_inspect", result: "ok" },
        { tool: "ops_logs", result: "ok" },
      ]);
    });
  
    it("在群聊与外部事件自动回合中隐藏并拒绝自观测工具", async () => {
      const groupSeen = scriptedModel([
        { name: "codemode", args: { code: "text(String(Boolean(tools.ops_usage)));" } },
      ]);
      await runInDurableObject(env.THREAD.getByName("group:200000001"), async (_instance, state) => {
        const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        expect(await thread.submit(input(2, "看看日志", 10000001, 200000001, true))).toEqual({ status: "done" });
      });
      for (const hidden of ["ops_health", "auth_list", "auth_grant", "auth_revoke", "qq_chats", "edge_list", "edge_grant", "edge_revoke"]) {
        expect(groupSeen.offers).not.toContain(hidden);
      }
      expect(groupSeen.sections.join("\n")).not.toMatch(/^## access\b/m);
      expect(groupSeen.sections.join("\n")).not.toContain("runtime-ops");
      expect(groupSeen.outputs[0]).toContain("tools.ops_usage does not exist");
  
      const ownerSeen = scriptedModel([{ name: "ops_health", args: {} }]);
      await runInDurableObject(env.THREAD.getByName("owner"), async (instance, state) => {
        const thread = threadWithBindings(instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        expect(await thread.submit(input(3, "查看运行状态", 10000001))).toEqual({ status: "done" });
      });
      expect(ownerSeen.offers).toContain("ops_health");

      const eventSeen = scriptedModel([
        { name: "codemode", args: { code: "text(await tools.ops_usage({}));" } },
      ]);
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        const accepted = await thread.deliverEvent({
          messageId: "evt_test_1",
          selfId: "10000000",
          userId: "10000001",
          nickname: "系统事件",
          target: { kind: "private", userId: "10000001" },
          text: "外部事件触发",
          routeText: "外部事件触发",
          time: Math.floor(Date.now() / 1000),
          mentionedSelf: false,
          replyToId: null,
          imageCount: 0,
          kind: "event",
        });
        expect(accepted).toBe("accepted");
        await thread.alarm();
        await expect.poll(async () => await thread.eventOutcome("evt_test_1")).not.toBe("queued");
      });
      expect(eventSeen.offers).not.toContain("ops_health");
      expect(eventSeen.outputs[0]).toContain("denied");
    });
  
    it("验证内层 ops_denied、SQL 层 excludeTurnId 分页不跳页、跨会话 summaryOnly 隔离与未知会话保护", async () => {
      const audits: { tool: string; result: string }[] = [];
      const deniedExt = createOpsExtension({
        env,
        allowed: async () => false,
        currentTurnId: async () => undefined,
        audit: async detail => { audits.push(detail); },
      });
      const deniedHealth = await deniedExt.tools!.find(t => t.name === "ops_health")!.execute({} as never, {} as ToolExecutionApi, {} as Context);
      expect(deniedHealth.isError).toBe(true);
      expect(JSON.stringify(deniedHealth.output)).toContain("ops_denied");
      expect(audits).toEqual([{ tool: "ops_health", result: "denied" }]);
  
      const now = Date.now();
      const store = env.REQUESTS.getByName("main");
      // 插入 5 条请求，其中第 4 条属于当前回合 turn:self，验证 limit=2 两页遍历不丢记录。
      for (let i = 1; i <= 5; i++) {
        const isSelf = i === 4;
        const isGroup = i === 1;
        await store.record({
          request: {
            id: `00000000-0000-4000-8000-00000000000${i}`,
            startedAt: now - (10 - i) * 1000,
            endedAt: now - (10 - i) * 1000 + 200,
            durationMs: 200,
            thread: isGroup ? "group:200000001" : "owner",
            binding: { turnId: isSelf ? "turn:self" : `turn:t${i}`, inputId: `msg:${i}`, generation: 0 },
            actor: "thread",
            purpose: "conversation",
            provider: "faux",
            model: "test",
            status: "done",
            inputTokens: 10,
            outputTokens: 5,
            cacheRead: null,
            cacheWrite: null,
            reasoningTokens: null,
            contextWindow: 32000,
          },
          context: snapshot({ messages: [{ role: "user", content: isGroup ? "群内未受信全文内容" : "主人消息", timestamp: now }] }),
        });
      }
  
      const allowedExt = createOpsExtension({
        env,
        allowed: async () => true,
        currentTurnId: async () => "turn:self",
        audit: async () => {},
      });
      const call = async (name: string, args: Record<string, unknown>) => {
        const res = await allowedExt.tools!.find(t => t.name === name)!.execute(args as never, {} as ToolExecutionApi, {} as Context);
        return res.structuredOutput as Record<string, unknown>;
      };
  
      const p1 = await call("ops_requests", { hours: 1, limit: 2 });
      const p2 = await call("ops_requests", { hours: 1, limit: 2, before: p1.next });
      const seenIds = [...(p1.requests as { id: string }[]), ...(p2.requests as { id: string }[])].map(r => r.id.at(-1));
      expect(seenIds).toEqual(["5", "3", "2", "1"]);
      expect(p2.next).toBeUndefined();
  
      // 跨会话请求即使指定 summaryOnly: false 也必须强制仅返回摘要，不泄露群消息正文。
      const crossInspect = await call("ops_inspect", { kind: "request", id: "00000000-0000-4000-8000-000000000001", summaryOnly: false });
      expect(crossInspect).toMatchObject({ found: true, bodyDeferred: true, crossThreadRedacted: true });
      expect(JSON.stringify(crossInspect)).not.toContain("群内未受信全文内容");
  
      // 未知非 owner 会话不实例化空视图，直接返回 found: false。
      const unknownAudit = await call("ops_logs", { source: "audit", thread: "group:999999999" });
      expect(unknownAudit).toEqual({ source: "audit", thread: "group:999999999", found: false, events: [] });
    });
  });
});
