import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { CodexRunner } from "../../src/agent/codex-runner.js";
import { catalogContextWindow } from "../../src/agent/codex-model-catalog.js";
import { loadConfig } from "../../src/config.js";
import { trace } from "../../src/obs/trace.js";
import { FIXTURES, tmp } from "./helpers.js";

const stores: ContextUsageStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });
const open = (dir = tmp("context-usage-"), debounce = 10) => {
  const store = new ContextUsageStore(dir, debounce); stores.push(store); return store;
};
const usage = { usedTokens: 1234, cachedTokens: 1000, windowTokens: 500000 };

describe("上下文占用存储", () => {
  it("按 backend:key 隔离，订阅与 trace 每次更新发出副本，重置后保留容量", async () => {
    const store = open();
    const events: { ticket: string; detail: unknown }[] = [];
    const untap = trace.tap(e => { if (e.stage === "context_usage") events.push(e); });
    const listener = vi.fn(u => { u.usedTokens = 99999; });
    const unsubscribe = store.subscribe(listener);
    try {
      store.recordTurn("codex", "owner", usage, "ticket-one");
      store.recordTurn("pi", "owner", { ...usage, compaction: { background: 450000, reserve: 480000 } });
      store.recordCompaction("pi", "owner");
      expect(store.get("codex", "owner")).toMatchObject({ ...usage, turns: 1, source: "turn" });
      store.all()[0]!.usedTokens = 88;
      expect(store.get("codex", "owner")!.usedTokens).toBe(1234);
      expect(store.get("pi", "owner")!.lastCompactionAt).toBeTypeOf("number");
      store.reset("pi", "owner");
      expect(store.get("pi", "owner")).toMatchObject({ usedTokens: 0, cachedTokens: 0, turns: 0,
        windowTokens: 500000, compaction: { background: 450000, reserve: 480000 }, source: "estimate" });
      expect(store.get("pi", "owner")!.lastCompactionAt).toBeUndefined();
      expect(listener).toHaveBeenCalledTimes(4);
      expect(events.map(e => e.ticket)).toEqual(["ticket-one", "@context", "@context", "@context"]);
      expect(events[0]!.detail).toMatchObject({ usedTokens: 1234, backend: "codex", key: "owner" });
      unsubscribe(); store.reset("codex", "owner"); expect(listener).toHaveBeenCalledTimes(4);
    } finally { unsubscribe(); untap(); }
  });

  it("合并短时间写入，原子替换并重载，订阅异常不阻断保存", async () => {
    const dir = tmp("context-reload-");
    const store = open(dir, 20);
    const rename = vi.spyOn(fs, "rename");
    store.subscribe(() => { throw new Error("subscriber failed"); });
    for (let n = 0; n < 5; n++) store.recordTurn("codex", "shared", { ...usage, usedTokens: n });
    await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
    await store.flush();
    const json = JSON.parse(await fs.readFile(path.join(dir, "context-usage.json"), "utf8"));
    expect(Object.keys(json)).toEqual(["codex:shared"]);
    expect(open(dir).all()).toEqual(store.all());
    expect((await fs.readdir(dir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("写入失败保留旧文件，下一次 flush 重试最新状态", async () => {
    const dir = tmp("context-atomic-"); const store = open(dir, 60_000);
    store.recordTurn("codex", "owner", usage); await store.flush();
    store.recordTurn("codex", "owner", { ...usage, usedTokens: 2000 });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(store.flush()).rejects.toThrow("disk unavailable");
    expect(open(dir).get("codex", "owner")!.usedTokens).toBe(1234);
    await store.flush();
    expect(open(dir).get("codex", "owner")).toMatchObject({ usedTokens: 2000, turns: 2 });
    expect((await fs.readdir(dir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("忽略损坏文件与非法记录，不将非有限 token 写为 null", async () => {
    const dir = tmp("context-invalid-");
    await fs.writeFile(path.join(dir, "context-usage.json"), "{broken", "utf8");
    expect(open(dir).all()).toEqual([]);
    await fs.writeFile(path.join(dir, "context-usage.json"), JSON.stringify({ "pi:owner": { backend: "pi", key: "owner" } }), "utf8");
    const store = open(dir); expect(store.all()).toEqual([]);
    expect(() => store.recordTurn("pi", "owner", { ...usage, usedTokens: NaN })).toThrow("非法上下文用量");
  });
});

function runnerSetup(env: NodeJS.ProcessEnv = {}, fallback?: number) {
  const dir = tmp("context-codex-"); const store = open(dir);
  const catalogLog = path.join(dir, "catalog.jsonl");
  const runner = new CodexRunner({ command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"), threadsFile: path.join(dir, "codex-threads.json"),
    sandbox: "workspace-write", timeoutMs: 10000, contextUsage: store, model: "gpt-6.1-sol", contextWindow: fallback,
    env: { FAKE_CODEX_CATALOG_LOG: catalogLog, FAKE_CODEX_USAGE: JSON.stringify({ input_tokens: 1000, cached_input_tokens: 750, output_tokens: 200 }), ...env } });
  return { dir, store, runner, catalogLog };
}

describe("codex 上下文采集", () => {
  it("精确匹配 slug.context_window，忽略最大窗口与百分比", () => {
    expect(catalogContextWindow(JSON.stringify({ models: [
      { slug: "other", context_window: 10 },
      { slug: "gpt-6.1-sol", context_window: 500000, max_context_window: 872000, effective_context_window_percent: 95 },
    ] }), "gpt-6.1-sol")).toBe(500000);
    expect(catalogContextWindow('{"models":[]}', "missing")).toBeUndefined();
    expect(catalogContextWindow('{"models":[{"slug":"bad","context_window":-1}]}', "bad")).toBeUndefined();
  });

  it("启动与多个回合共用一次目录查询，JSONL 用量更新，不重复累加缓存", async () => {
    const { runner, store, catalogLog, dir } = runnerSetup();
    await Promise.all([runner.initializeContextUsage(), runner.initializeContextUsage()]);
    await runner.ask("one", { ticket: "one", threadKey: "owner" });
    await runner.ask("two", { ticket: "two", threadKey: "owner" });
    expect(store.get("codex", "owner")).toMatchObject({ usedTokens: 1000, cachedTokens: 750, windowTokens: 500000, turns: 2, source: "turn" });
    const calls = (await fs.readFile(catalogLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toEqual([{ argv: ["debug", "models"], codexHome: path.join(dir, "codex") }]);
    await runner.resetThread("owner");
    expect(store.get("codex", "owner")).toMatchObject({ usedTokens: 0, cachedTokens: 0, turns: 0, windowTokens: 500000, source: "estimate" });
    await runner.ask("fresh", { threadKey: "owner" });
    expect(store.get("codex", "owner")!.turns).toBe(1);
  });

  it.each(["age", "size", "missing"])("%s 轮换时先归零，再记录新线程的首轮", async reason => {
    const { dir, runner, store } = runnerSetup();
    await runner.ask("one");
    const zeroes: number[] = [];
    store.subscribe(u => zeroes.push(u.turns));
    if (reason === "size") {
      const session = path.join(dir, "codex", "sessions"); await fs.mkdir(session, { recursive: true });
      await fs.writeFile(path.join(session, "rollout-thread-123.jsonl"), "oversize", "utf8");
      runner.opts.rolloutMaxMb = 0.000001;
    } else await fs.writeFile(path.join(dir, "codex-threads.json"), JSON.stringify({ shared: {
      thread_id: reason === "missing" ? "missing-old" : "thread-123", created_at: reason === "age" ? "2000-01-01T00:00:00Z" : new Date().toISOString(),
    } }), "utf8");
    await runner.ask("new");
    expect(zeroes).toEqual([0, 1]);
    expect(store.get("codex", "shared")!.turns).toBe(1);
  });

  it("映射已清空而用量未刷盘时，启动修复旧占用，新线程从首轮计数", async () => {
    const { runner, store } = runnerSetup();
    store.recordTurn("codex", "owner", usage);
    await store.flush();
    await runner.initializeContextUsage();
    expect(store.get("codex", "owner")).toMatchObject({ usedTokens: 0, turns: 0, source: "estimate" });
    await runner.ask("fresh-after-reset", { threadKey: "owner" });
    expect(store.get("codex", "owner")).toMatchObject({ turns: 1, windowTokens: 500000 });
  });

  it.each([{ FAKE_CODEX_CATALOG_FAIL: "1" }, { FAKE_CODEX_CATALOG: "invalid-json" }, { FAKE_CODEX_CATALOG: '{"models":[]}' }])("目录失败回退环境配置 %j", async env => {
    const cfg = loadConfig({ CODEX_CONTEXT_WINDOW: "654321" });
    const { runner, store } = runnerSetup(env, cfg.CODEX_CONTEXT_WINDOW);
    await runner.ask("fallback");
    expect(store.get("codex", "shared")!.windowTokens).toBe(654321);
  });

  it("没有目录与覆盖值时默认 400000，缺失 usage 不编造真实回合", async () => {
    const { runner, store } = runnerSetup({ FAKE_CODEX_CATALOG_FAIL: "1", FAKE_CODEX_USAGE: "{}" });
    expect(await runner.initializeContextUsage()).toBe(400000);
    await runner.ask("no-usage");
    expect(store.get("codex", "shared")).toMatchObject({ source: "estimate", turns: 0 });
    await runner.initializeContextUsage();
    expect(store.get("codex", "shared")).toMatchObject({ windowTokens: 400000, source: "estimate", turns: 0 });
    expect(loadConfig({}).CODEX_CONTEXT_WINDOW).toBe(400000);
    expect(() => loadConfig({ CODEX_CONTEXT_WINDOW: "0" })).toThrow();
  });
});
