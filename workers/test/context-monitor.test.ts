import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { snapshot } from "../src/requests/snapshot";
import { compareContext } from "../src/requests/context-store";
import { contextSource } from "../src/requests/context-source";
import { captureModels } from "../src/requests/capture";
import { totalChars } from "../src/requests/context-types";
import type { RequestDetail } from "../src/requests/types";

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
