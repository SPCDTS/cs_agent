import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { classifyError, logDiag, type DiagRecord } from "../src/shared/diagnostics";
import { safeError } from "../src/mcp/connection";
import { createSubagentCapabilityHost } from "../src/mcp/delegated";
import { hydrateCatalogs, ModelAlarm, modelEgressDiagnostics, openModels, remoteCredentials } from "../src/models";
import { captureModels } from "../src/requests/capture";
import { threadView } from "../src/admin/read-views";
import { snapshot } from "../src/requests/snapshot";

const TOKEN = "test-admin-only";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

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
    for (let i = 1; i <= 1005; i++) {
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
      { outcome: "ok", exceptions: [], logs: [], eventTimestamp: 2000, scriptName: "cs-agent", event: null } as unknown as TraceItem,
      { outcome: "exception", exceptions: [], logs: [], eventTimestamp: 2000, scriptName: "cs-agent", event: { consumedEvents: [] } } as unknown as TraceItem,
      ...Array.from({ length: 25 }, (_, i) => ({
        outcome: "exceededCpu",
        exceptions: [{ name: "Error", message: "sensitive", timestamp: 2001 + i }],
        logs: [],
        eventTimestamp: 2001 + i,
        scriptName: "cs-agent",
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

    const usage = await store.usage({ since: now - 60_000, until: now + 1000, thread: "owner", limit: 20 });
    expect(usage.summary).toMatchObject({
      requests: 1,
      reasoningTokens: 60,
      avgDuration: 800,
      avgTtft: 180,
    });
    expect(Number(usage.summary.costUsd)).toBeCloseTo(0.0042, 6);

    const trace = await store.turnTrace("owner", ["turn:web:t1"], 0);
    expect(trace.timings).toHaveLength(1);
    expect(trace.timings?.[0]).toMatchObject({ queueWaitMs: 100, totalMs: 1100, origin: "web" });
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
