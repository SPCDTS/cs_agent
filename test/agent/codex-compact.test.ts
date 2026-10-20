import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { log } from "../../src/shared/log.js";
import { CodexRunner } from "../../src/agent/codex/runner.js";
import { RecallTokens } from "../../src/context/media-recall-server.js";
import { FIXTURES, tmp } from "./helpers.js";

const stores: ContextUsageStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });
const compacted = { type: "compacted", payload: { message: "摘要" } };
const tokenCount = { type: "event_msg", payload: { type: "token_count", info: {
  model_context_window: 475000, last_token_usage: { input_tokens: 0, total_tokens: 10701 },
} } };

function usageRig(rows?: unknown[]) {
  const r = rig();
  const store = new ContextUsageStore(r.dir); stores.push(store);
  r.runner.opts.contextUsage = store;
  writeFileSync(r.runner.opts.threadsFile, JSON.stringify({ owner: { thread_id: "existing" } }), "utf8");
  for (let i = 0; i < 3; i++) store.recordTurn("codex", "owner", { usedTokens: 64000, cachedTokens: 60000, windowTokens: 500000 });
  store.recordTurn("codex", "group:7", { usedTokens: 999, windowTokens: 500000 });
  if (rows) r.runner.opts.env!.FAKE_COMPACT_ROLLOUT = JSON.stringify(rows);
  return { ...r, store };
}

function rig(provider: "magpie" | "openai" = "openai") {
  const dir = tmp("cs-compact-"), codexHome = path.join(dir, "codex"), logFile = path.join(dir, "calls.jsonl");
  mkdirSync(codexHome);
  writeFileSync(path.join(codexHome, "config.toml"), `model_provider="${provider}"\n`, "utf8");
  const tokens = new RecallTokens({ recall: async () => ({ text: "ok", images: [] }) });
  const issue = vi.spyOn(tokens, "issue");
  const runner = new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-compact-codex.mjs")], provider, magpieKey: "test-gateway-key",
    codexHome, workspaceDir: path.join(dir, "ws"), threadsFile: path.join(dir, "threads.json"),
    sandbox: "workspace-write", timeoutMs: 10_000, recallTokens: tokens,
    env: { FAKE_CODEX_LOG: logFile, FAKE_CODEX_THREAD: "compact-thread", FAKE_CODEX_SLEEP_MS: "80", OBS_TOKEN: "must-not-leak" },
  });
  const calls = (): Record<string, any>[] => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { runner, issue, calls, dir, codexHome };
}

describe("CodexRunner.compactThread", () => {
  it("压缩后立即读取 rollout 的 total_tokens，保留回合数并发布、持久化新估算", async () => {
    const r = usageRig([
      { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 64000 } } } },
      { timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "task_complete" } },
      compacted, tokenCount,
    ]);
    const other = r.store.get("codex", "group:7");
    const listener = vi.fn(); r.store.subscribe(listener);
    expect(await r.runner.compactThread("owner")).toBe("compacted");
    const usage = r.store.get("codex", "owner")!;
    expect(usage).toMatchObject({ usedTokens: 10701, source: "compact", turns: 3, windowTokens: 500000,
      effectiveWindowTokens: 475000, lastCompactionAt: expect.any(Number) });
    expect(usage.cachedTokens).toBeUndefined();
    expect(r.store.get("codex", "group:7")).toEqual(other);
    expect(listener).toHaveBeenCalledExactlyOnceWith(usage);
    await r.store.flush();
    const reloaded = new ContextUsageStore(r.dir); stores.push(reloaded);
    expect(reloaded.get("codex", "owner")).toEqual(usage);
    await new CodexRunner({ ...r.runner.opts, contextUsage: reloaded }).initializeContextUsage();
    expect(reloaded.get("codex", "owner")).toEqual(usage);
  });

  it.each([
    undefined, [compacted], [tokenCount], [tokenCount, compacted],
    [{ ...compacted, timestamp: "2026-01-01T00:00:00Z" }, { ...tokenCount, timestamp: "2026-01-01T00:00:01Z" }],
    [compacted, { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0, total_tokens: -1 } } } }],
  ])("压缩后的用量缺失、无效或陈旧时保留原记录：%j", async rows => {
    const r = usageRig(rows);
    const before = r.store.get("codex", "owner"), info = vi.spyOn(log, "info");
    expect(await r.runner.compactThread("owner")).toBe("compacted");
    expect(r.store.get("codex", "owner")).toEqual(before);
    expect(info).toHaveBeenCalledWith("codex context usage unavailable after compaction; keeping previous usage", expect.any(Object));
  });

  it("刷新异常不把已成功的压缩变为失败，原记录不变", async () => {
    const r = usageRig([compacted, tokenCount]);
    const before = r.store.get("codex", "owner");
    vi.spyOn(r.store, "recordCompaction").mockImplementationOnce(() => { throw new Error("sample failed"); });
    const info = vi.spyOn(log, "info");
    expect(await r.runner.compactThread("owner")).toBe("compacted");
    expect(r.store.get("codex", "owner")).toEqual(before);
    expect(info).toHaveBeenCalledWith("codex context usage refresh failed after compaction; keeping previous usage", expect.any(Object));
  });

  it("没有对应线程时 unchanged，不启动进程或创建会话", async () => {
    const r = rig();
    expect(await r.runner.compactThread("owner")).toBe("unchanged");
    expect(await r.runner.compactThread("private:9")).toBe("unchanged");
    expect(r.calls()).toEqual([]);
    expect(r.issue).not.toHaveBeenCalled();
    await expect(r.runner.compactThread("shared" as "owner")).rejects.toThrow("非法");
  });

  it.each(["magpie", "openai"] as const)("在 %s 回合后串行压缩，复用配置和环境，不申请 MCP 令牌", async provider => {
    const r = rig(provider);
    const turn = r.runner.ask("first", { threadKey: "owner", ticket: "compact-before", qqAccess: "all" });
    const compact = r.runner.compactThread("owner");
    const next = r.runner.ask("second", { threadKey: "owner", ticket: "compact-after", qqAccess: "all" });
    expect(await turn).toBe("answer to: first");
    expect(await compact).toBe("compacted");
    expect(await next).toBe("answer to: second");
    const calls = r.calls(), start = calls.find(c => c.phase === "compact-start")!;
    expect(calls.map(c => c.phase)).toEqual(["start", "end", "compact-start", "rpc", "rpc", "rpc", "start", "end"]);
    expect(start.t).toBeGreaterThanOrEqual(calls[1].t);
    expect(start.argv).toEqual(["app-server"]);
    expect(start.config).toBe(`model_provider="${provider}"\n`);
    expect(start.env.CODEX_HOME).toBe(r.codexHome);
    expect(start.env.CODEX_MAGPIE_KEY).toBe(provider === "magpie" ? "test-gateway-key" : undefined);
    expect(start.env.OBS_TOKEN).toBeUndefined();
    expect(calls.filter(c => c.phase === "rpc")).toEqual([
      { phase: "rpc", method: "initialize", params: { clientInfo: { name: "cs_agent_compact", version: "0.1.0" } } },
      { phase: "rpc", method: "thread/resume", params: { threadId: "compact-thread" } },
      { phase: "rpc", method: "thread/compact/start", params: { threadId: "compact-thread" } },
    ]);
    expect(r.issue).toHaveBeenCalledTimes(2);
    expect(await r.runner.readThreadIds()).toEqual({ owner: "compact-thread" });
    expect(calls.filter(c => c.phase === "start")[1].argv).toContain("resume");
  });

  it("压缩失败保留映射，并释放同键队列供重置使用", async () => {
    const r = rig();
    writeFileSync(r.runner.opts.threadsFile, JSON.stringify({ owner: { thread_id: "existing" } }), "utf8");
    r.runner.opts.env!.FAKE_COMPACT_FAIL = "1";
    const failed = r.runner.compactThread("owner");
    const reset = r.runner.resetThread("owner");
    await expect(failed).rejects.toThrow("thread/compact/start");
    expect(await reset).toBe("existing");
    expect(await r.runner.compactThread("owner")).toBe("unchanged");
  });
});
