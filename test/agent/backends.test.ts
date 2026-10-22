import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexBackend, type CodexBackendOptions } from "../../src/agent/backends/codex.js";
import { tmp } from "./helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexScript, codexRunnerRig } from "./codex-fixture.js";
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

describe("CodexBackend：常驻 app-server 适配器", () => {
  const rigs: { close(): Promise<void> }[] = [];
  afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });

  /** 宿主当前回合的桩：binding 按 current 表给出身份与回合 id。 */
  const setup = async (opts: { owners?: string[]; records?: InboundRecord[]; script?: CodexScript; extra?: Partial<CodexBackendOptions> } = {}) => {
    const script = opts.script ?? new CodexScript();
    const r = await codexRunnerRig({ handlers: script.handlers });
    rigs.push(r);
    const records = opts.records ?? [record("k1", "1", "7"), record("k2", "9", null, "owner")];
    const turns = fakeTurns(records);
    const current = new Map<string, { turnId?: string; identity: TurnBinding["identity"]; inputs?: string[] }>();
    const binding = turns.binding;
    turns.binding = (threadKey: string) => {
      const c = current.get(threadKey);
      return { ...binding(threadKey), ...(c ? { identity: c.identity, inputs: c.inputs ?? [], ...(c.turnId ? { turnId: c.turnId } : {}) } : {}) };
    };
    const tokens = { issue: vi.fn((key: string) => key.length.toString(16).padStart(64, "0")), revoke: vi.fn() };
    const h = fakeHost();
    const backend = new CodexBackend({ runner: r.runner, tokens, imagesDir: path.join(r.dir, "images"), turns, owners: opts.owners ?? ["9"],
      callWaitMs: 100, ...opts.extra });
    backend.attach(h.host);
    return { ...r, script, backend, tokens, current, ...h };
  };

  it("startTurn 加载线程（签发线程令牌）后 turn/start，返回 codex:<回合 id>；turn/completed 后回报 completed", async () => {
    const script = new CodexScript();
    script.auto = false;
    const s = await setup({ script });
    const started = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" },
      { backend: "codex", codexReasoningEffort: "low", codexModel: "codex/gpt-6-astra" });
    expect(started).toEqual({ turnId: "codex:turn-1" });
    expect(s.tokens.issue).toHaveBeenCalledWith("group:7");
    expect(s.loads()[0]!.config["mcp_servers.im.env.IM_TOKEN"]).toBe(s.tokens.issue.mock.results[0]!.value);
    expect(script.turns[0]).toMatchObject({ text: "问题 k1", effort: "low", model: "codex/gpt-6-astra" });
    expect(await s.backend.busy("group:7")).toBe(true);
    script.complete(script.turns[0]!);
    await vi.waitFor(() => expect(s.completed).toEqual([{ threadKey: "group:7", turnId: "codex:turn-1", status: "completed" }]));
    expect(await s.backend.busy("group:7")).toBe(false);
    // 同一会话下一轮复用已加载的线程，不再签发令牌
    script.auto = true;
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await s.backend.idle();
    expect(s.tokens.issue).toHaveBeenCalledTimes(1);
    expect(s.loads()).toHaveLength(1);
  });

  it("插话：当前回合 turn/steer；回合 id 不符或不可插话回报 no_active_turn；重启后回合丢失", async () => {
    const script = new CodexScript();
    script.auto = false;
    const s = await setup({ script });
    const { turnId } = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" }) as { turnId: string };
    expect(await s.backend.steer("group:7", turnId, ref("k1", "1"))).toBe("ok");
    expect(script.steers).toMatchObject([{ turnId: "turn-1", text: "问题 k1" }]);
    expect(await s.backend.steer("group:7", "codex:other", ref("k1", "1"))).toBe("no_active_turn");
    script.steerReply = () => ({ error: { code: -32600, message: "cannot steer a compact turn" } });
    expect(await s.backend.steer("group:7", turnId, ref("k1", "1"))).toBe("no_active_turn");
    expect(await s.backend.recoverTurn()).toBe("lost");
    script.complete(script.turns[0]!);
    await vi.waitFor(() => expect(s.completed).toHaveLength(1));
    expect(await s.backend.steer("group:7", turnId, ref("k1", "1"))).toBe("no_active_turn");
  });

  it("interrupt 发 turn/interrupt，回合以 failed（被中断）结束；不再重试的 error 并入失败", async () => {
    const script = new CodexScript();
    script.auto = false;
    const s = await setup({ script });
    const { turnId } = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" }) as { turnId: string };
    await s.backend.interrupt("group:7");
    await vi.waitFor(() => expect(s.completed).toEqual([{ threadKey: "group:7", turnId, status: "failed", error: "codex 回合被中断" }]));
    expect(s.requests("turn/interrupt")).toMatchObject([{ params: { threadId: "thr-1", turnId: "turn-1" } }]);
    const next = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" }) as { turnId: string };
    const turn = script.turns[1]!;
    turn.child.notify("error", { threadId: turn.threadId, turnId: turn.turnId, willRetry: false, error: { message: "boom" } });
    script.complete(turn);
    await vi.waitFor(() => expect(s.completed.at(-1)).toEqual({ threadKey: "group:7", turnId: next.turnId, status: "failed", error: "codex 回合出错" }));
  });

  it("工具调用的读取范围：owner 本人为 all（群里也是），其余为本会话；本轮参考图取本轮输入", async () => {
    const script = new CodexScript();
    script.auto = false;
    const records = [{ ...record("k1", "1", "7"), images: ["/data/incoming/k1/a.png"] }, record("k2", "9", null, "owner"), record("k3", "9", "7")];
    const s = await setup({ script, records });
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await s.backend.startTurn("owner", [ref("k2", "9")], { kind: "user", sender: "9" });
    const [g, o] = script.turns;
    s.current.set("group:7", { turnId: "codex:" + g!.turnId, identity: { kind: "user", sender: "1" }, inputs: ["k1"] });
    s.current.set("owner", { turnId: "codex:" + o!.turnId, identity: { kind: "user", sender: "9" } });
    // 真实调用的元数据：callId（mcpToolCall 条目 id）+ x-codex-turn-metadata 的 thread_id、turn_id
    let n = 0;
    const call = (turn: typeof g) => { const callId = `exec-${++n}`; script.toolCall(turn!, callId); return { callId, threadId: turn!.threadId, turnId: turn!.turnId }; };
    expect(await s.backend.resolveCall("group:7", call(g))).toMatchObject({ access: { kind: "scope", scope: "group:7" },
      session: g!.threadId, workdir: path.join(s.dir, "ws", "group_7"), imageDir: path.join(s.dir, "images", "group_7"), imageRefs: ["/data/incoming/k1/a.png"] });
    expect(await s.backend.resolveCall("owner", call(o))).toMatchObject({ access: { kind: "all" } });
    s.current.set("group:7", { turnId: "codex:" + g!.turnId, identity: { kind: "user", sender: "9" }, inputs: ["k3"] });
    expect(await s.backend.resolveCall("group:7", call(g))).toMatchObject({ access: { kind: "all" } });
    // owner 线程的唤醒回合读取 all（owner 线程只有 owner 本人的输入与定时任务）；群的唤醒回合只读本会话
    s.current.set("owner", { turnId: "codex:" + o!.turnId, identity: { kind: "wake" } });
    expect(await s.backend.resolveCall("owner", call(o))).toMatchObject({ access: { kind: "all" } });
    s.current.set("group:7", { turnId: "codex:" + g!.turnId, identity: { kind: "wake" } });
    expect(await s.backend.resolveCall("group:7", call(g))).toMatchObject({ access: { kind: "scope", scope: "group:7" } });
    const own = call(g);
    await expect(s.backend.resolveCall("owner", own)).rejects.toThrow();
    await expect(s.backend.resolveCall("private:5", own)).rejects.toThrow("未加载");
  });

  it("工具调用的归属只认服务端记录：必须带本线程 thread_id 与 callId，callId 的条目须属于本线程本回合；客户端给的 turn_id 不能单独成立", async () => {
    const script = new CodexScript();
    script.auto = false;
    const s = await setup({ script });
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await s.backend.startTurn("owner", [ref("k2", "9")], { kind: "user", sender: "9" });
    const [g, o] = script.turns;
    s.current.set("group:7", { turnId: "codex:" + g!.turnId, identity: { kind: "user", sender: "1" } });
    s.current.set("owner", { turnId: "codex:" + o!.turnId, identity: { kind: "user", sender: "9" } });
    script.toolCall(g!, "exec-ok");
    expect(await s.backend.resolveCall("group:7", { callId: "exec-ok", threadId: g!.threadId, turnId: g!.turnId })).toMatchObject({ turnId: "codex:" + g!.turnId });
    // 只有 turn_id：拒绝
    await expect(s.backend.resolveCall("group:7", { threadId: g!.threadId, turnId: g!.turnId })).rejects.toThrow();
    // 不存在的 callId 配上当前 turn_id：拒绝
    await expect(s.backend.resolveCall("group:7", { callId: "exec-forged", threadId: g!.threadId, turnId: g!.turnId })).rejects.toThrow();
    // 缺 thread_id：拒绝
    await expect(s.backend.resolveCall("group:7", { callId: "exec-ok", turnId: g!.turnId })).rejects.toThrow();
    // 别的会话的 callId 配上本会话的 thread_id / turn_id：拒绝
    script.toolCall(o!, "exec-owner");
    await expect(s.backend.resolveCall("group:7", { callId: "exec-owner", threadId: g!.threadId, turnId: g!.turnId })).rejects.toThrow();
    // 元数据的 turn_id 与条目所在回合不一致：拒绝
    await expect(s.backend.resolveCall("owner", { callId: "exec-owner", threadId: o!.threadId, turnId: g!.turnId })).rejects.toThrow();
  });

  it("压缩期间服务端开的回合按条目判定：contextCompaction 的回合吞掉，其他回合（子 agent 唤醒）照常交给宿主", async () => {
    const script = new CodexScript();
    const s = await setup({ script });
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await vi.waitFor(() => expect(s.completed).toHaveLength(1));
    const started: string[] = [];
    s.backend.attach({ ...s.host, onTurnStarted: (_k, turnId, by) => { started.push(`${turnId}:${by}`); } });
    const child = s.fake.last, threadId = script.turns[0]!.threadId;
    child.handlers["thread/compact/start"] = (_m, c) => {
      setImmediate(() => {
        // 唤醒回合先到（第一条条目是 userMessage），之后才是压缩回合
        c.notify("turn/started", { threadId, turn: { id: "wake-x", status: "inProgress" } });
        c.notify("item/started", { threadId, turnId: "wake-x", item: { type: "userMessage", id: "u1", content: [] } });
        c.notify("turn/completed", { threadId, turn: { id: "wake-x", status: "completed" } });
        c.notify("turn/started", { threadId, turn: { id: "compact-1", status: "inProgress" } });
        c.notify("item/completed", { threadId, turnId: "compact-1", item: { type: "contextCompaction", id: "cc" } });
        c.notify("turn/completed", { threadId, turn: { id: "compact-1", status: "completed" } });
      });
      return { result: {} };
    };
    expect(await s.backend.compactThread("group:7")).toBe("compacted");
    await s.backend.idle();
    expect(started).toEqual(["codex:wake-x:backend"]);
    expect(s.completed.map(c => c.turnId)).toEqual(["codex:turn-1", "codex:wake-x"]);
  });

  it("轮换检查等待期间到达的唤醒回合：不卸载线程、不作废令牌，开轮让给唤醒回合", async () => {
    const script = new CodexScript();
    const s = await setup({ script });
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await vi.waitFor(() => expect(s.completed).toHaveLength(1));
    let due!: (v: boolean) => void;
    vi.spyOn(s.runner, "rotationDue").mockImplementationOnce(() => new Promise(resolve => { due = resolve; }));
    const pending = s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await vi.waitFor(() => expect(due).toBeDefined());
    const wake = script.wake(script.turns[0]!.child, script.turns[0]!.threadId);
    await vi.waitFor(async () => expect(await s.backend.busy("group:7")).toBe(true));
    due(true);
    expect(await pending).toEqual({ backendTurnId: "codex:" + wake.turnId });
    expect(s.tokens.revoke).not.toHaveBeenCalled();
    expect(s.loads()).toHaveLength(1);
  });

  it("补收图片按会话串行、按任务幂等发送，只移除处理过的任务（新追加的留给下一次）", async () => {
    const script = new CodexScript();
    const dir = tmp("cs-codex-late2-");
    const threadDir = path.join(dir, "images", "group_7");
    const job = (id: string) => ({ prompt_id: id, backend: "stub", filenamePrefix: "cs-" + id, options: { prompt: id },
      callDir: path.join(threadDir, "call-" + id.length), submittedAt: Date.now(), status: "submitted" as const });
    const write = (jobs: ReturnType<typeof job>[]) => writeFileSync(path.join(threadDir, PENDING_IMAGE_JOBS), JSON.stringify(jobs));
    script.onTurn = () => { mkdirSync(path.join(threadDir, "call-1"), { recursive: true }); write([job("a")]); };
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const collect = vi.fn(async (id: string, out: string) => {
      if (id === "a") await gateA;
      mkdirSync(out, { recursive: true }); const file = path.join(out, id + ".png"); writeFileSync(file, PNG); return [file];
    });
    const system = vi.fn(async (..._args: unknown[]) => ({ status: "sent" as const, already_sent: false, message_id: "1", message_type: "group" as const, target_id: "7" }));
    const s = await setup({ script, extra: { imagesDir: path.join(dir, "images"), sendService: { system },
      imageBackend: { name: "stub", submit: async () => "p", reconcile: async () => ({ images: [] }), collect } } });
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    // A 还在收取时追加 B，并结束一个唤醒回合（第二次补收）
    mkdirSync(path.join(threadDir, "call-2"), { recursive: true });
    write([job("a"), job("bb")]);
    const wake = script.wake(script.turns[0]!.child, script.turns[0]!.threadId);
    script.complete(wake);
    await new Promise(resolve => setTimeout(resolve, 100));
    releaseA();
    await vi.waitFor(() => expect(s.completed).toHaveLength(2));
    await s.backend.idle();
    expect(collect.mock.calls.map(c => c[0]).sort()).toEqual(["a", "bb"]);
    const keys = system.mock.calls.map(c => (c[3] as { key?: string } | undefined)?.key);
    expect(keys.sort()).toEqual(["group:7:sys:img:cs-a", "group:7:sys:img:cs-bb"]);
    expect(existsSync(path.join(threadDir, PENDING_IMAGE_JOBS))).toBe(false);
  });
  it("image_gen 超时留下的任务在回合结束时补收，以系统消息发出并移除清单", async () => {
    const script = new CodexScript();
    const dir = tmp("cs-codex-late-");
    const threadDir = path.join(dir, "images", "group_7");
    const callDir = path.join(threadDir, "call-1");
    script.onTurn = () => {
      mkdirSync(callDir, { recursive: true });
      writeFileSync(path.join(threadDir, PENDING_IMAGE_JOBS), JSON.stringify([{ prompt_id: "late-1", backend: "stub",
        filenamePrefix: "cs-late-1", options: { prompt: "慢图" }, callDir, submittedAt: Date.now(), status: "submitted" }]));
    };
    const system = vi.fn(async () => ({ status: "sent" as const, already_sent: false, message_id: "1", message_type: "group" as const, target_id: "7" }));
    const collect = vi.fn(async (_id: string, out: string) => {
      mkdirSync(out, { recursive: true }); const file = path.join(out, "late.png"); writeFileSync(file, PNG); return [file];
    });
    const s = await setup({ script, extra: { imagesDir: path.join(dir, "images"), sendService: { system },
      imageBackend: { name: "stub", submit: async () => "p", reconcile: async () => ({ images: [] }), collect } } });
    const { turnId } = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" }) as { turnId: string };
    await vi.waitFor(() => expect(s.completed).toHaveLength(1));
    expect(collect).toHaveBeenCalledWith("late-1", expect.any(String), expect.any(AbortSignal), { prompt: "慢图" });
    expect(system).toHaveBeenCalledWith(expect.objectContaining({ threadKey: "group:7", scope: "group:7", turnId }), IMAGE_SUCCESS_REPLY,
      [expect.stringMatching(/late\.png$/)], { key: "group:7:sys:img:cs-late-1" });
    expect(existsSync(path.join(threadDir, PENDING_IMAGE_JOBS))).toBe(false);
    expect(s.completed).toEqual([{ threadKey: "group:7", turnId, status: "completed" }]);
  });

  it("条目与子 agent 活动刷新看门狗；app-server 掉线：回合按 lost 回报、令牌作废，下一轮 thread/resume 并重新签发", async () => {
    const script = new CodexScript();
    script.auto = false;
    const s = await setup({ script });
    const { turnId } = await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" }) as { turnId: string };
    const turn = script.turns[0]!;
    script.toolCall(turn, "exec-1");
    turn.child.notify("item/completed", { threadId: turn.threadId, turnId: turn.turnId, item: { type: "commandExecution", id: "c1", command: "ls", status: "completed", exitCode: 0 } });
    await vi.waitFor(() => expect(s.activity.length).toBeGreaterThanOrEqual(2));
    turn.child.exit(1);
    await vi.waitFor(() => expect(s.completed).toEqual([{ threadKey: "group:7", turnId, status: "lost", error: expect.stringContaining("掉线") }]));
    expect(s.tokens.revoke).toHaveBeenCalledWith("group:7");
    script.auto = true;
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    await s.backend.idle();
    expect(s.fake.last.requests("thread/resume")).toMatchObject([{ params: { threadId: "thr-1" } }]);
    expect(s.tokens.issue).toHaveBeenCalledTimes(2);
  });

  it("唤醒回合先到（宿主尚未确认）时开轮让给它：返回 backendTurnId", async () => {
    const script = new CodexScript();
    script.auto = false;
    const s = await setup({ script });
    await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" });
    script.complete(script.turns[0]!);
    await vi.waitFor(() => expect(s.completed).toHaveLength(1));
    const wake = script.wake(script.turns[0]!.child, script.turns[0]!.threadId);
    await vi.waitFor(async () => expect(await s.backend.busy("group:7")).toBe(true));
    expect(await s.backend.startTurn("group:7", [ref("k1", "1")], { kind: "user", sender: "1" })).toEqual({ backendTurnId: "codex:" + wake.turnId });
    expect(await s.backend.abandon("group:7", "codex:turn-1")).toEqual({ status: "completed" });
  });
});
