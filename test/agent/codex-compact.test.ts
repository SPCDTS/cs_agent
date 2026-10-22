import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { log } from "../../src/shared/log.js";
import { CodexBackend } from "../../src/agent/backends/codex.js";
import type { InputRef } from "../../src/agent/host/types.js";
import { CodexScript, codexRunnerRig } from "./codex-fixture.js";
import { tmp } from "./helpers.js";

const stores: ContextUsageStore[] = [];
const rigs: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const r of rigs.splice(0)) await r.close();
});
const compacted = { type: "compacted", payload: { message: "摘要" } };
const tokenCount = { type: "event_msg", payload: { type: "token_count", info: {
  model_context_window: 475000, last_token_usage: { input_tokens: 0, total_tokens: 10701 },
} } };

/**
 * 面板压缩经常驻 app-server：thread/compact/start 后，服务端以一个压缩回合（或只发 contextCompaction 条目）完成；
 * rows：压缩时追加到线程 rollout 的记录（缺省时间戳为当前）。
 */
async function rig(opts: { rows?: unknown[]; fail?: boolean; usage?: boolean } = {}) {
  const dir = tmp("cs-compact-");
  const store = opts.usage ? new ContextUsageStore(dir) : undefined;
  if (store) stores.push(store);
  const script = new CodexScript();
  const base = script.handlers;
  script.handlers = () => ({ ...base(),
    "thread/compact/start": (m, child) => {
      if (opts.fail) return { error: { code: -32603, message: "fake failure" } };
      const threadId = String(m.params!.threadId);
      setImmediate(() => {
        if (opts.rows) {
          const sessions = path.join(dir, "codex", "sessions");
          mkdirSync(sessions, { recursive: true });
          const rows = opts.rows.map(row => ({ timestamp: new Date().toISOString(), ...(row as object) }));
          appendFileSync(path.join(sessions, `rollout-${threadId}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
        }
        // 压缩以服务端回合进行：压缩锁持有到该回合结束
        child.notify("turn/started", { threadId, turn: { id: "compact-turn", status: "inProgress" } });
        child.notify("item/completed", { threadId, turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction" } });
        child.notify("turn/completed", { threadId, turn: { id: "compact-turn", status: "completed" } });
      });
      return { result: {} };
    },
  });
  const r = await codexRunnerRig({ dir, handlers: script.handlers, ...(store ? { contextUsage: store } : {}) });
  rigs.push(r);
  const host = { started: [] as string[], completed: [] as string[] };
  const turns = {
    binding: (threadKey: string) => ({ threadKey, identity: { kind: "user" as const, sender: "9" }, scope: "private:9", inputs: [] }),
    records: () => [],
    render: async () => ({ text: "问题", images: [], source: { type: "private" as const, user_id: "9", group_id: null, nickname: "测试" } }),
  };
  const tokens = { issue: vi.fn(() => "a".repeat(64)), revoke: vi.fn() };
  const backend = new CodexBackend({ runner: r.runner, tokens, imagesDir: path.join(dir, "images"), turns, compactTimeoutMs: 2_000 });
  backend.attach({ onTurnStarted: (_k, turnId) => host.started.push(turnId), onActivity: () => undefined,
    onTurnCompleted: (_k, turnId) => host.completed.push(turnId) });
  return { ...r, script, backend, host, store, tokens };
}
const input: InputRef = { inboundKey: "k", kind: "user", sender: "9", seq: 1, at: 0 };

describe("CodexBackend.compactThread", () => {
  it("压缩后立即读取 rollout 的 total_tokens，保留回合数并发布、持久化新估算；压缩回合不交给宿主", async () => {
    const r = await rig({ usage: true, rows: [
      { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 64000 } } } },
      { timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "task_complete" } },
      compacted, tokenCount,
    ] });
    await r.backend.startTurn("owner", [input], { kind: "user", sender: "9" });
    await vi.waitFor(() => expect(r.host.completed).toHaveLength(1));
    for (let i = 0; i < 3; i++) r.store!.recordTurn("codex", "owner", { usedTokens: 64000, cachedTokens: 60000, windowTokens: 500000 });
    r.store!.recordTurn("codex", "group:7", { usedTokens: 999, windowTokens: 500000 });
    const other = r.store!.get("codex", "group:7");
    const turnsBefore = r.store!.get("codex", "owner")!.turns;
    expect(await r.backend.compactThread("owner")).toBe("compacted");
    const usage = r.store!.get("codex", "owner")!;
    expect(usage).toMatchObject({ usedTokens: 10701, source: "compact", turns: turnsBefore, effectiveWindowTokens: 475000, lastCompactionAt: expect.any(Number) });
    expect(usage.cachedTokens).toBeUndefined();
    expect(r.store!.get("codex", "group:7")).toEqual(other);
    expect(r.requests("thread/compact/start")).toMatchObject([{ params: { threadId: "thr-1" } }]);
    await r.backend.idle();
    expect(r.host.started).toEqual(["codex:turn-1"]);
    expect(r.host.completed).toEqual(["codex:turn-1"]);
    expect(await r.backend.busy("owner")).toBe(false);
  });

  it.each([
    undefined, [compacted], [tokenCount],
    [{ ...compacted, timestamp: "2026-01-01T00:00:00Z" }, { ...tokenCount, timestamp: "2026-01-01T00:00:01Z" }],
    [compacted, { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0, total_tokens: -1 } } } }],
  ])("压缩后的用量缺失、无效或陈旧时保留原记录：%j", async rows => {
    const r = await rig({ usage: true, ...(rows ? { rows } : {}) });
    writeFileSync(path.join(r.dir, "codex-threads.json"), JSON.stringify({ owner: { thread_id: "existing" } }), "utf8");
    r.store!.recordTurn("codex", "owner", { usedTokens: 64000, cachedTokens: 60000, windowTokens: 500000 });
    const before = r.store!.get("codex", "owner"), info = vi.spyOn(log, "info");
    expect(await r.backend.compactThread("owner")).toBe("compacted");
    expect(r.store!.get("codex", "owner")).toEqual(before);
    expect(info).toHaveBeenCalledWith("codex context usage unavailable after compaction; keeping previous usage", expect.any(Object));
  });

  it("刷新异常不把已成功的压缩变为失败，原记录不变", async () => {
    const r = await rig({ usage: true, rows: [compacted, tokenCount] });
    writeFileSync(path.join(r.dir, "codex-threads.json"), JSON.stringify({ owner: { thread_id: "existing" } }), "utf8");
    r.store!.recordTurn("codex", "owner", { usedTokens: 64000, windowTokens: 500000 });
    const before = r.store!.get("codex", "owner");
    vi.spyOn(r.store!, "recordCompaction").mockImplementationOnce(() => { throw new Error("sample failed"); });
    const info = vi.spyOn(log, "info");
    expect(await r.backend.compactThread("owner")).toBe("compacted");
    expect(r.store!.get("codex", "owner")).toEqual(before);
    expect(info).toHaveBeenCalledWith("codex context usage refresh failed after compaction; keeping previous usage", expect.any(Object));
  });

  it("没有对应线程时 unchanged，不加载线程也不签发令牌", async () => {
    const r = await rig();
    expect(await r.backend.compactThread("owner")).toBe("unchanged");
    expect(await r.backend.compactThread("private:9")).toBe("unchanged");
    expect(r.loads()).toEqual([]);
    expect(r.tokens.issue).not.toHaveBeenCalled();
    await expect(r.backend.compactThread("shared" as "owner")).rejects.toThrow("非法");
  });

  it("会话有进行中的回合时拒绝压缩；压缩失败保留映射，之后仍可重置", async () => {
    const r = await rig();
    r.script.auto = false;
    await r.backend.startTurn("owner", [input], { kind: "user", sender: "9" });
    await expect(r.backend.compactThread("owner")).rejects.toThrow("正在处理");
    await expect(r.backend.resetThread("owner")).rejects.toThrow("正在处理");
    r.script.complete(r.script.turns[0]!);
    await vi.waitFor(() => expect(r.host.completed).toHaveLength(1));
    await r.backend.idle();

    const failing = await rig({ fail: true });
    writeFileSync(path.join(failing.dir, "codex-threads.json"), JSON.stringify({ owner: { thread_id: "existing" } }), "utf8");
    await expect(failing.backend.compactThread("owner")).rejects.toThrow("thread/compact/start");
    expect(await failing.runner.readThreadIds()).toEqual({ owner: "existing" });
    expect(await failing.backend.resetThread("owner")).toBe("existing");
    expect(await failing.backend.compactThread("owner")).toBe("unchanged");
  });
});
