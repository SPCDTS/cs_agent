import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import { threadWithBindings } from "./thread-fixture";
import * as models from "../src/models";
import { snapshot } from "../src/requests/snapshot";
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
      "const usage = await tools.ops_usage({ hours: 24, thread: 'owner' });",
      "const reqs = await tools.ops_requests({ hours: 24, thread: 'owner', includeTimings: true });",
      `const inspected = await tools.ops_inspect({ kind: 'request', id: '${priorReqId}' });`,
      "const logs = await tools.ops_logs({ source: 'diag', level: 'error' });",
      "text('RESULT_JSON:' + JSON.stringify({",
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
      priorFound: true,
      hasSelfTurn: false,
      excludedTurnId: expect.stringMatching(/^turn:/),
      timingTurns: ["turn:prior"],
      inspectedModel: "gemini-3-flash-preview",
      bodyDeferred: true,
      logEvents: expect.arrayContaining(["mcp_refresh_failed"]),
    });
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
});
