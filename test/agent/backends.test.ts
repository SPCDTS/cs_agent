import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexBackend, codexObserver } from "../../src/agent/backends/codex.js";
import { FIXTURES, tmp } from "./helpers.js";
import { describe, expect, it, vi } from "vitest";
import { CodexRunner, CodexTimeoutError, type AskOptions } from "../../src/agent/codex/runner.js";
import { backendNameFor, createBackendSelector, parseBackendOverrides } from "../../src/agent/backends/select.js";
import type { AgentBackend } from "../../src/agent/backends/types.js";
import type { HostCallbacks, InputRef, TurnStatus } from "../../src/agent/host/types.js";
import type { InboundRecord, TurnBinding } from "../../src/channel/types.js";
import { IMAGE_SUCCESS_REPLY } from "../../src/agent/replies.js";
import { PENDING_IMAGE_JOBS } from "../../src/media/gen/image-pending.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const codex: AgentBackend = { name: "codex" };

describe("backend selection (§4.3)", () => {
  it("parses AGENT_BACKEND_OVERRIDES", () => {
    expect(parseBackendOverrides("group:200000001=pi, private:10000001=codex")).toEqual({
      "group:200000001": "pi",
      "private:10000001": "codex",
    });
    expect(parseBackendOverrides("")).toEqual({});
    expect(parseBackendOverrides(undefined)).toEqual({});
  });

  it("rejects malformed override entries", () => {
    expect(() => parseBackendOverrides("group:1=claude")).toThrow(/后端非法/);
    expect(() => parseBackendOverrides("room:1=pi")).toThrow(/scope 非法/);
    expect(() => parseBackendOverrides("group:1")).toThrow(/scope 非法/);
  });

  it("override wins over the global default", () => {
    const o = parseBackendOverrides("group:7=pi");
    expect(backendNameFor("group:7", "codex", o)).toBe("pi");
    expect(backendNameFor("group:8", "codex", o)).toBe("codex");
    expect(backendNameFor("private:1", "pi", {})).toBe("pi");
  });

  it("selector returns the registered backend and rejects an unregistered one", () => {
    const sel = createBackendSelector({ defaultBackend: "codex", overrides: {}, backends: { codex } });
    expect(sel.select("group:8")).toBe(codex);
    const missing = createBackendSelector({ defaultBackend: "pi", overrides: {}, backends: { codex } });
    expect(() => missing.select("group:1")).toThrow(/not registered/);
  });
});

/** 输入记录桩：键 → InboundRecord；binding 按会话最后一条输入给出地址。 */
function fakeTurns(records: InboundRecord[]) {
  const byKey = new Map(records.map(r => [r.key, r]));
  return {
    binding: (threadKey: string): TurnBinding => {
      const last = [...records].reverse().find(r => r.thread_key === threadKey);
      return { threadKey, identity: { kind: "wake" }, scope: last?.scope ?? threadKey, inputs: [], ...(last ? { inputKey: last.key } : {}) };
    },
    records: (inputs: readonly Pick<InputRef, "inboundKey">[]) => inputs.map(i => byKey.get(i.inboundKey)!),
    render: async (recs: readonly InboundRecord[]) => ({
      text: recs.map(r => r.text).join("\n\n"), images: recs.flatMap(r => r.images),
      source: { type: recs.at(-1)!.message_type, user_id: recs.at(-1)!.user_id, group_id: recs.at(-1)!.group_id, nickname: recs.at(-1)!.nickname },
    }),
  };
}

function record(key: string, user: string, group: string | null, threadKey = group ? `group:${group}` : `private:${user}`): InboundRecord {
  return { key, kind: "user", seq: 1, scope: group ? `group:${group}` : `private:${user}`, thread_key: threadKey, self_id: "2", user_id: user,
    group_id: group, message_type: group ? "group" : "private", message_id: "m-" + key, nickname: "用户", text: "问题 " + key, route_text: "问题 " + key,
    time: 1_760_000_000, images: [], attachments: [], created_at: new Date().toISOString(), state: "queued" };
}

function fakeHost() {
  const completed: { threadKey: string; turnId: string; status: TurnStatus; error?: string }[] = [];
  const activity: string[] = [];
  const host: HostCallbacks = {
    onTurnStarted: () => {},
    onTurnCompleted: (threadKey, turnId, result) => { completed.push({ threadKey, turnId, ...result }); },
    onActivity: threadKey => { activity.push(threadKey); },
  };
  return { host, completed, activity };
}

const ref = (inboundKey: string, sender: string): InputRef => ({ inboundKey, kind: "user", sender, seq: 1, at: Date.now() });

describe("CodexBackend 适配层（第 2 阶段：每轮一次 codex exec）", () => {
  const setup = (ask: (prompt: string, o: AskOptions) => Promise<string>, opts: { owners?: string[]; records?: InboundRecord[] } = {}) => {
    const dir = tmp("cs-codex-be-");
    const records = opts.records ?? [record("k1", "1", "7"), record("k2", "9", null, "owner")];
    const h = fakeHost();
    const backend = new CodexBackend({ runner: { ask: vi.fn(ask) }, imagesDir: path.join(dir, "images"), turns: fakeTurns(records), owners: opts.owners ?? ["9"] });
    backend.attach(h.host);
    return { dir, backend, ...h, ask: (backend as unknown as { opts: { runner: { ask: ReturnType<typeof vi.fn> } } }).opts.runner.ask };
  };

  it("startTurn 立即返回 codex: 回合 id，exec 在后台完成后回报 completed", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const s = setup(async () => { await gate; return "答复"; });
    const { turnId } = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    expect(turnId).toMatch(/^codex:[0-9a-f-]{36}$/);
    expect(s.completed).toEqual([]);
    release();
    await s.backend.idle();
    expect(s.completed).toEqual([{ threadKey: "group:7", turnId, status: "completed" }]);
    expect(s.ask).toHaveBeenCalledWith("问题 k1", expect.objectContaining({ turnId, threadKey: "group:7", senderIsOwner: false, qqAccess: "group:7" }));
  });

  it("codex 不插话：steer 一律 no_active_turn；重启后回合丢失", async () => {
    const s = setup(async () => "x");
    expect(await s.backend.steer()).toBe("no_active_turn");
    expect(await s.backend.recoverTurn()).toBe("lost");
  });

  it("超时（CodexTimeoutError）按回合失败回报", async () => {
    const s = setup(async () => { throw new CodexTimeoutError(10); });
    const { turnId } = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await s.backend.idle();
    expect(s.completed).toEqual([{ threadKey: "group:7", turnId, status: "failed", error: "timeout" }]);
  });

  it("interrupt 中止 exec 的 signal，回合以 failed 结束", async () => {
    const s = setup(async (_p, o) => new Promise<string>((_r, reject) => {
      o.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const { turnId } = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await vi.waitFor(() => expect(s.ask).toHaveBeenCalled());
    await s.backend.interrupt("group:7");
    await s.backend.idle();
    expect(s.completed).toEqual([{ threadKey: "group:7", turnId, status: "failed", error: "aborted" }]);
  });

  it("读取范围：owner 本人为 all 并可写技能，其余为本会话", async () => {
    const s = setup(async () => "ok");
    await s.backend.startTurn("owner", [ref("k2", "9")], { kind: "user", sender: "9" });
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await s.backend.idle();
    const calls = s.ask.mock.calls.map(([, o]) => o as AskOptions);
    expect(calls.find(o => o.threadKey === "owner")).toMatchObject({ qqAccess: "all", senderIsOwner: true });
    expect(calls.find(o => o.threadKey === "group:7")).toMatchObject({ qqAccess: "group:7", senderIsOwner: false });
    // owner 在群里发言时读取范围为 all
    const g = setup(async () => "ok");
    await g.backend.startTurn("group:7", [ref("k1", "9")], { kind: "user", sender: "9" });
    await g.backend.idle();
    expect(g.ask.mock.calls[0]![1]).toMatchObject({ qqAccess: "all", senderIsOwner: true });
  });

  it("image_gen 超时留下的任务在回合结束前补收，以系统消息发出并移除清单", async () => {
    const dir = tmp("cs-codex-late-");
    const threadDir = path.join(dir, "images", "group_7");
    const callDir = path.join(threadDir, "call-1");
    const system = vi.fn(async () => ({ status: "sent" as const, already_sent: false, message_id: "1", message_type: "group" as const, target_id: "7" }));
    const collect = vi.fn(async (_id: string, out: string) => {
      mkdirSync(out, { recursive: true }); const file = path.join(out, "late.png"); writeFileSync(file, PNG); return [file];
    });
    const h = fakeHost();
    const backend = new CodexBackend({
      runner: { ask: async () => {
        mkdirSync(callDir, { recursive: true });
        writeFileSync(path.join(threadDir, PENDING_IMAGE_JOBS), JSON.stringify([{ prompt_id: "late-1", backend: "stub",
          filenamePrefix: "cs-late-1", options: { prompt: "慢图" }, callDir, submittedAt: Date.now(), status: "submitted" }]));
        return "图片稍后发";
      } },
      imagesDir: path.join(dir, "images"), turns: fakeTurns([record("k1", "1", "7")]), sendService: { system }, imageBackend: { name: "stub", submit: async () => "p", reconcile: async () => ({ images: [] }), collect },
    });
    backend.attach(h.host);
    const { turnId } = await backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await backend.idle();
    expect(collect).toHaveBeenCalledWith("late-1", expect.any(String), expect.any(AbortSignal), { prompt: "慢图" });
    expect(system).toHaveBeenCalledWith(expect.objectContaining({ threadKey: "group:7", scope: "group:7", turnId }), IMAGE_SUCCESS_REPLY,
      [expect.stringMatching(/late\.png$/)]);
    expect(existsSync(path.join(threadDir, PENDING_IMAGE_JOBS))).toBe(false);
    expect(h.completed).toEqual([{ threadKey: "group:7", turnId, status: "completed" }]);
  });

  it("codexObserver 每个事件都刷新活动时间", () => {
    const onActivity = vi.fn();
    const observe = codexObserver("turn:codex:x", onActivity);
    observe({ type: "turn.started" });
    observe({ type: "item.started", item: { type: "command_execution", id: "c1", command: "ls" } });
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it("fake codex 端到端：附件目录按会话键，完成后进程滞留仍返回结果", async () => {
    const dir = tmp("cs-codex-grace-be-");
    const logFile = path.join(dir, "calls.jsonl");
    const runner = new CodexRunner({
      command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
      codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"),
      threadsFile: path.join(dir, "threads.json"), sandbox: "workspace-write", timeoutMs: 10000, exitGraceMs: 150,
      env: { FAKE_CODEX_LOG: logFile, FAKE_CODEX_SLEEP_AFTER_OUT_MS: "8000", FAKE_CODEX_IMAGES: "1" },
    });
    const h = fakeHost();
    const backend = new CodexBackend({ runner, imagesDir: path.join(dir, "images"), turns: fakeTurns([record("k2", "9", null, "owner")]), owners: ["9"] });
    backend.attach(h.host);
    const { turnId } = await backend.startTurn("owner", [ref("k2", "9")], { kind: "user", sender: "9" });
    await backend.idle();
    expect(h.completed).toEqual([{ threadKey: "owner", turnId, status: "completed" }]);
    const start = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n")[0]!);
    const arg = start.argv.find((a: string) => a.startsWith("mcp_servers.qq_context.env.QQ_ATTACH_DIR="));
    const attachDir = JSON.parse(arg.slice(arg.indexOf("=") + 1));
    expect(path.basename(attachDir)).toBe("owner");
    expect(existsSync(path.join(attachDir, "img_0.png"))).toBe(true);
    expect(start.argv).toContain('mcp_servers.qq_context.env.QQ_TICKET=' + JSON.stringify(turnId));
  });
});

