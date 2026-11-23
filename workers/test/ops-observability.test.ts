import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { Context } from "@earendil-works/chord/context";
import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import { threadWithBindings } from "./thread-fixture";
import * as models from "../src/models";
import { snapshot } from "../src/requests/snapshot";
import { createOpsExtension } from "../src/tools/ops";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function scriptedModel(steps: { name: string; args: JsonObject }[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const offers: string[] = [], sections: string[] = [], outputs: string[] = [], captured = new Set<string>();
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    for (const message of transcript.messages) {
      if (message.role === "system") {
        offers.push(...(message.toolsAdded ?? []).map(t => t.name));
        if (message.sections?.codemode) sections.push(message.sections.codemode);
      }
      if (message.role === "toolResult" && !captured.has(message.toolCallId)) {
        captured.add(message.toolCallId);
        outputs.push(message.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      }
    }
    const next = steps.shift();
    return next ? fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(() => {
    const m = createModels();
    m.setProvider(faux.provider);
    return m;
  });
  return { offers, sections, outputs };
}

describe("cs-agent 自观测能力（ops_health 与 runtime-ops Code Mode 命名空间）", () => {
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
    expect(groupSeen.offers).not.toContain("ops_health");
    expect(groupSeen.sections.join("\n")).not.toContain("runtime-ops");
    expect(groupSeen.outputs[0]).toContain("tools.ops_usage does not exist");

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
