import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { CodexRunner } from "../../src/agent/codex/runner.js";
import { catalogContextWindow } from "../../src/agent/codex/model-catalog.js";
import { readRolloutContextUsage, ROLLOUT_USAGE_MAX_BYTES } from "../../src/agent/codex/context-usage.js";
import { log } from "../../src/shared/log.js";
import { loadConfig } from "../../src/config.js";
import { trace } from "../../src/shared/trace.js";
import { FIXTURES, tmp } from "./helpers.js";

const stores: ContextUsageStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });
const open = (dir = tmp("context-usage-"), debounce = 10) => {
  const store = new ContextUsageStore(dir, debounce); stores.push(store); return store;
};
const usage = { usedTokens: 1234, cachedTokens: 1000, windowTokens: 500000 };

describe("上下文占用存储", () => {
  it("压缩样本保留计数和容量，清除旧缓存，历史回填不能覆盖较新压缩", async () => {
    const dir = tmp("context-compact-"), store = open(dir);
    store.recordTurn("codex", "owner", { ...usage, effectiveWindowTokens: 475000 });
    store.recordCompaction("codex", "owner", "@context", { usedTokens: 0 });
    const compact = store.get("codex", "owner")!;
    expect(compact).toMatchObject({ usedTokens: 0, source: "compact", turns: 1, effectiveWindowTokens: 475000 });
    expect(compact.cachedTokens).toBeUndefined();
    expect(store.backfill("codex", "owner", { usedTokens: 100, turns: 9, updatedAt: compact.updatedAt - 1 })).toBe(false);
    expect(store.backfill("codex", "owner", { usedTokens: 100, turns: 9, updatedAt: compact.updatedAt })).toBe(false);
    await store.flush(); expect(open(dir).get("codex", "owner")).toEqual(compact);
    store.recordTurn("codex", "owner", usage);
    expect(store.get("codex", "owner")).toMatchObject({ ...usage, turns: 2, source: "turn" });
  });

  it("旧记录无有效窗口仍可重载，新值持久化且只计数时保留；重置和容量变更后丢弃旧实测窗口", async () => {
    const dir = tmp('context-effective-'), store = open(dir);
    store.recordTurn('codex', 'owner', usage); await store.flush();
    expect(open(dir).get('codex', 'owner')?.effectiveWindowTokens).toBeUndefined();
    const old = store.get('codex', 'owner')!;
    expect(store.backfill('codex', 'owner', { usedTokens: 1, turns: 1, updatedAt: old.updatedAt - 1, effectiveWindowTokens: 475000 })).toBe(true);
    expect(store.get('codex', 'owner')).toEqual({ ...old, effectiveWindowTokens: 475000 });
    store.recordTurn('codex', 'owner', { ...usage, effectiveWindowTokens: 475000 }); await store.flush();
    expect(open(dir).get('codex', 'owner')).toMatchObject({ windowTokens: 500000, effectiveWindowTokens: 475000 });
    store.recordTurn('codex', 'owner', { windowTokens: 500000 });
    expect(store.get('codex', 'owner')?.effectiveWindowTokens).toBe(475000);
    store.ensure('codex', 'owner', { windowTokens: 600000 });
    expect(store.get('codex', 'owner')?.effectiveWindowTokens).toBeUndefined();
    store.recordTurn('codex', 'owner', { ...usage, effectiveWindowTokens: 475000 });
    store.reset('codex', 'owner');
    expect(store.get('codex', 'owner')?.effectiveWindowTokens).toBeUndefined();
    for (const n of [0, -1, NaN, Infinity]) expect(() => store.recordTurn('codex', 'owner', { ...usage, effectiveWindowTokens: n })).toThrow('非法上下文用量');
  });
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
    for (let n = 0; n < 5; n++) store.recordTurn("codex", "group:1", { ...usage, usedTokens: n });
    await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
    await store.flush();
    const json = JSON.parse(await fs.readFile(path.join(dir, "context-usage.json"), "utf8"));
    expect(Object.keys(json)).toEqual(["codex:group:1"]);
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

  it("只计数时保留用量快照，新键保持零占用估算，后续采样不重复计数", () => {
    const store = open();
    store.recordTurn("codex", "group:1", { windowTokens: 500000 });
    expect(store.get("codex", "group:1")).toMatchObject({ usedTokens: 0, turns: 1, source: "estimate" });
    store.recordTurn("codex", "group:1", usage);
    const prior = store.get("codex", "group:1")!;
    store.recordTurn("codex", "group:1", { windowTokens: 500000 });
    expect(store.get("codex", "group:1")).toEqual({ ...prior, turns: 3 });
    store.recordTurn("codex", "group:1", { windowTokens: 500000, usedTokens: 0 });
    expect(store.get("codex", "group:1")).toMatchObject({ usedTokens: 0, turns: 4, source: "turn" });
    expect(store.get("codex", "group:1")!.cachedTokens).toBeUndefined();
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
    sandbox: "workspace-write", timeoutMs: 10000, contextUsage: store, model: "codex/gpt-6.1-sol", contextWindow: fallback,
    env: { FAKE_CODEX_ROLLOUT_USAGE: JSON.stringify({ input_tokens: 1000, cached_input_tokens: 750 }), FAKE_CODEX_CATALOG_LOG: catalogLog, FAKE_CODEX_USAGE: JSON.stringify({ input_tokens: 1000, cached_input_tokens: 750, output_tokens: 200 }), ...env } });
  return { dir, store, runner, catalogLog };
}

describe("codex 上下文采集", () => {
  it('rollout 取已完成回合最近的有效窗口，跳过未完成尾部、无值和非法值', async () => {
    const file = path.join(tmp('rollout-effective-'), 'events.jsonl');
    const record = (payload: unknown) => ({ timestamp: '2026-10-18T00:00:00Z', type: 'event_msg', payload });
    const rows = [record({ type: 'task_started' }),
      record({ type: 'token_count', info: { model_context_window: 400000, last_token_usage: { input_tokens: 10 } } }),
      record({ type: 'token_count', info: { model_context_window: 475000 } }),
      record({ type: 'token_count', info: { model_context_window: 0, last_token_usage: { input_tokens: 20 } } }),
      record({ type: 'task_complete' }), record({ type: 'task_started' }),
      record({ type: 'token_count', info: { model_context_window: 999999, last_token_usage: { input_tokens: 30 } } })];
    await fs.writeFile(file, rows.map(r => JSON.stringify(r)).join('\n'), 'utf8');
    expect(await readRolloutContextUsage(file)).toMatchObject({ usedTokens: 20, effectiveWindowTokens: 475000, turns: 1 });
    for (const invalid of [undefined, '475000', -1]) {
      await fs.writeFile(file, [record({ type: 'task_started' }), record({ type: 'token_count', info: { model_context_window: invalid,
        last_token_usage: { input_tokens: 20 } } }), record({ type: 'task_complete' })].map(r => JSON.stringify(r)).join('\n'), 'utf8');
      expect((await readRolloutContextUsage(file))?.effectiveWindowTokens).toBeUndefined();
    }
  });

  it('回合结束和启动回填均保留 rollout 有效窗口与目录名义窗口', async () => {
    const { runner, store } = runnerSetup({ FAKE_CODEX_MODEL_CONTEXT_WINDOW: '475000' });
    await runner.ask('window', { threadKey: 'owner' });
    expect(store.get('codex', 'owner')).toMatchObject({ usedTokens: 1000, windowTokens: 500000, effectiveWindowTokens: 475000 });
    const copy = open(tmp('context-backfill-effective-'));
    const restarted = new CodexRunner({ ...runner.opts, contextUsage: copy });
    await restarted.initializeContextUsage();
    expect(copy.get('codex', 'owner')).toMatchObject({ windowTokens: 500000, effectiveWindowTokens: 475000 });
  });
  it("启动恢复最后完成回合的用量和时间，重置不复活归档", async () => {
    const { runner, store, dir } = runnerSetup();
    const sessions = path.join(dir, "codex", "sessions", "2026", "10", "17");
    await fs.mkdir(sessions, { recursive: true });
    const file = path.join(sessions, "rollout-history.jsonl");
    await fs.copyFile(path.join(FIXTURES, "context-rollout.jsonl"), file);
    await fs.writeFile(path.join(dir, "codex-threads.json"), JSON.stringify({ owner: { thread_id: "history" } }), "utf8");
    const summary = vi.spyOn(log, "info");
    await Promise.all([runner.initializeContextUsage(), runner.initializeContextUsage()]);
    expect(store.get("codex", "owner")).toMatchObject({ usedTokens: 321, cachedTokens: 123,
      turns: 2, source: "turn", updatedAt: Date.parse("2026-10-17T10:01:02Z"), windowTokens: 500000 });
    expect(summary.mock.calls.filter(([message]) => message === "context usage backfilled")).toHaveLength(1);
    expect(await runner.rolloutSize("history")).toBe((await fs.stat(file)).size);
    await runner.resetThread("owner");
    expect(store.get("codex", "owner")).toMatchObject({ usedTokens: 0, turns: 0, source: "estimate" });
  });

  it("rollout 缺失或无合法用量时保留估算记录", async () => {
    const { runner, store, dir } = runnerSetup();
    await fs.writeFile(path.join(dir, "codex-threads.json"), JSON.stringify({ owner: { thread_id: "missing" }, "group:1": { thread_id: "empty" } }), "utf8");
    const sessions = path.join(dir, "codex", "sessions"); await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "empty.jsonl"), '{"type":"turn.completed","usage":{"input_tokens":-1}}\n', "utf8");
    await runner.initializeContextUsage();
    for (const key of ["owner", "group:1"]) expect(store.get("codex", key)).toMatchObject({ usedTokens: 0, turns: 0, source: "estimate" });
    await expect(readRolloutContextUsage(path.join(dir, "missing"))).resolves.toBeUndefined();
  });

  it("损坏尾部不抛错，倒序读取总量不超过 2 MiB", async () => {
    const file = path.join(tmp("rollout-tail-"), "tail.jsonl");
    const fixture = await fs.readFile(path.join(FIXTURES, "context-rollout.jsonl"), "utf8");
    await fs.writeFile(file, 'x'.repeat(ROLLOUT_USAGE_MAX_BYTES + 100) + '\n{broken}\n' + fixture + '\n{"type":', "utf8");
    const realOpen = fs.open.bind(fs);
    let readBytes = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
        readBytes += length;
        return read(buffer, offset, length, position);
      }) as typeof handle.read);
      return handle;
    });
    await expect(readRolloutContextUsage(file)).resolves.toMatchObject({ usedTokens: 321, cachedTokens: 123, turns: 2, truncated: true });
    expect(readBytes).toBe(ROLLOUT_USAGE_MAX_BYTES);
  });

  it("turn.completed 只计数，缺少 last_token_usage 时不能采用累计量", async () => {
    const file = path.join(tmp("rollout-events-"), "events.jsonl");
    await fs.writeFile(file, [
      { timestamp: "2026-10-17T00:00:00Z", type: "turn.completed", usage: { input_tokens: 42, cached_input_tokens: 12 } },
      { timestamp: "2026-10-18T00:00:00Z", type: "turn.completed", usage: { input_tokens: "invalid" } },
    ].map(row => JSON.stringify(row)).join("\n"), "utf8");
    expect(await readRolloutContextUsage(file)).toBeUndefined();
  });

  it("历史回填不覆盖更新的已落盘用量，容量刷新不改变历史时间", () => {
    const store = open(); store.recordTurn("codex", "owner", usage);
    const prior = store.get("codex", "owner")!;
    store.ensure("codex", "owner", { windowTokens: 600000 });
    expect(store.backfill("codex", "owner", { usedTokens: 1, turns: 1, updatedAt: prior.updatedAt - 1 })).toBe(false);
    expect(store.get("codex", "owner")).toMatchObject({ usedTokens: usage.usedTokens, updatedAt: prior.updatedAt, windowTokens: 600000 });
  });

  it("精确匹配 slug.context_window，忽略最大窗口与百分比", () => {
    expect(catalogContextWindow(JSON.stringify({ models: [
      { slug: "other", context_window: 10 },
      { slug: "codex/gpt-6.1-sol", context_window: 500000, max_context_window: 872000, effective_context_window_percent: 95 },
    ] }), "codex/gpt-6.1-sol")).toBe(500000);
    expect(catalogContextWindow('{"models":[]}', "missing")).toBeUndefined();
    expect(catalogContextWindow('{"models":[{"slug":"bad","context_window":-1}]}', "bad")).toBeUndefined();
  });

  it.each([
    { FAKE_CODEX_CATALOG_FAIL: "1" },
    { FAKE_CODEX_CATALOG: JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol", context_window: 272000 }, { slug: "other", context_window: 272000 }] }) },
  ])("命令失败或离线目录时采用只读模型缓存：%j", async env => {
    const { runner, dir } = runnerSetup(env, 654321);
    const home = path.join(dir, "codex"); await fs.mkdir(home, { recursive: true });
    const cacheFile = path.join(home, "models_cache.json");
    const cache = JSON.stringify({ fetched_at: "2026-10-18T00:00:00Z", etag: "fixture", client_version: "0.163.0", identity: "fixture",
      models: [{ slug: "other", context_window: 100000 }, { slug: "codex/gpt-6.1-sol", context_window: 500000 }] });
    await fs.writeFile(cacheFile, cache, "utf8");
    const before = await fs.stat(cacheFile);
    const info = vi.spyOn(log, "info");
    expect(await runner.initializeContextUsage()).toBe(500000);
    expect(info).toHaveBeenCalledWith("codex context window", { model: "codex/gpt-6.1-sol", windowTokens: 500000, source: "cache.context_window" });
    expect(await fs.readFile(cacheFile, "utf8")).toBe(cache);
    expect((await fs.stat(cacheFile)).mtimeMs).toBe(before.mtimeMs);
  });

  it("正常目录的模型窗口不被不同的缓存值覆盖", async () => {
    const { runner, dir } = runnerSetup({ FAKE_CODEX_CATALOG: JSON.stringify({ models: [
      { slug: "codex/gpt-6.1-sol", context_window: 500000 }, { slug: "other", context_window: 272000 },
    ] }) });
    const home = path.join(dir, "codex"); await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol", context_window: 600000 }] }), "utf8");
    const info = vi.spyOn(log, "info");
    expect(await runner.initializeContextUsage()).toBe(500000);
    expect(info).toHaveBeenCalledWith("codex context window", expect.objectContaining({ source: "catalog.context_window" }));
  });

  it.each(['{broken', '{"models":[{"slug":"other","context_window":500000}]}',
    '{"models":[{"slug":"codex/gpt-6.1-sol","context_window":-1}]}'])('缓存不可用时保留目录值或配置回退：%s', async cache => {
    for (const failed of [false, true]) {
      const { runner, dir } = runnerSetup(failed ? { FAKE_CODEX_CATALOG_FAIL: "1" } : {
        FAKE_CODEX_CATALOG: JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol", context_window: 272000 }] }),
      }, 654321);
      const home = path.join(dir, "codex"); await fs.mkdir(home, { recursive: true });
      await fs.writeFile(path.join(home, "models_cache.json"), cache, "utf8");
      expect(await runner.initializeContextUsage()).toBe(failed ? 654321 : 272000);
    }
  });

  it("离线目录与缓存值相同时仍标为目录来源", async () => {
    const catalog = JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol", context_window: 272000 }] });
    const { runner, dir } = runnerSetup({ FAKE_CODEX_CATALOG: catalog });
    const home = path.join(dir, "codex"); await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "models_cache.json"), catalog, "utf8");
    const info = vi.spyOn(log, "info");
    expect(await runner.initializeContextUsage()).toBe(272000);
    expect(info).toHaveBeenCalledWith("codex context window", expect.objectContaining({ source: "catalog.context_window" }));
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
    await runner.ask("one", { threadKey: "group:1" });
    const zeroes: number[] = [];
    store.subscribe(u => zeroes.push(u.turns));
    if (reason === "size") {
      const session = path.join(dir, "codex", "sessions"); await fs.mkdir(session, { recursive: true });
      await fs.writeFile(path.join(session, "rollout-thread-123.jsonl"), "oversize", "utf8");
      runner.opts.rolloutMaxMb = 0.000001;
    } else await fs.writeFile(path.join(dir, "codex-threads.json"), JSON.stringify({ "group:1": {
      thread_id: reason === "missing" ? "missing-old" : "thread-123", created_at: reason === "age" ? "2000-01-01T00:00:00Z" : new Date().toISOString(),
    } }), "utf8");
    await runner.ask("new", { threadKey: "group:1" });
    expect(zeroes).toEqual([0, 1]);
    expect(store.get("codex", "group:1")!.turns).toBe(1);
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
    await runner.ask("fallback", { threadKey: "group:1" });
    expect(store.get("codex", "group:1")!.windowTokens).toBe(654321);
  });

  it("没有目录与覆盖值时默认 400000，缺失用量仍统计已完成回合", async () => {
    const { runner, store } = runnerSetup({ FAKE_CODEX_CATALOG_FAIL: "1", FAKE_CODEX_USAGE: "{}", FAKE_CODEX_ROLLOUT_USAGE: "" });
    expect(await runner.initializeContextUsage()).toBe(400000);
    await runner.ask("no-usage", { threadKey: "group:1" });
    expect(store.get("codex", "group:1")).toMatchObject({ usedTokens: 0, source: "estimate", turns: 1 });
    await runner.initializeContextUsage();
    expect(store.get("codex", "group:1")).toMatchObject({ windowTokens: 400000, source: "estimate", turns: 1 });
    expect(loadConfig({}).CODEX_CONTEXT_WINDOW).toBe(400000);
    expect(() => loadConfig({ CODEX_CONTEXT_WINDOW: "0" })).toThrow();
  });
});
