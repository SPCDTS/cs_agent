import { describe, expect, it, vi } from "vitest";
import { TURN_NOTICES } from "../../src/agent/replies.js";
import { CodexScript } from "./codex-fixture.js";
import { gate, residentRig, type ResidentRig } from "./resident-fixture.js";

/**
 * codex 常驻 app-server 的端到端（设计 §5）：ThreadHost → BackendRouter → CodexBackend → CodexRunner → 内存版 app-server；
 * 工具调用模拟 im / qq_context MCP：以线程令牌和 _meta（callId、回合元数据）访问 loopback 网关，身份在调用时从宿主求出。
 */
const G = "group:7";

async function codexRig(script = new CodexScript(), extra: Parameters<typeof residentRig>[0] = {}) {
  return residentRig({ backend: "codex", codex: script, ...extra });
}

describe("codex 常驻：开轮、插话、排队", () => {
  it("开一轮：turn/start 带本轮输入与推理强度；回合内经 loopback 发往本群并 @ 发送者；Outbox 行键为 <会话>:<callId>", async () => {
    const results: unknown[] = [];
    const script = new CodexScript();
    let r!: ResidentRig;
    script.onTurn = async turn => {
      script.toolCall(turn, "exec-1");
      results.push(await r.codexSend(G, { text: "codex 回复" }, { callId: "exec-1", threadId: turn.threadId }));
    };
    r = await codexRig(script);
    const key = await r.say("5", "问 codex");
    await r.idle();
    expect(results).toEqual([expect.objectContaining({ status: "sent", already_sent: false })]);
    expect(r.texts("7")).toEqual(["codex 回复"]);
    expect(r.mentions()).toEqual(["5"]);
    expect(script.turns).toHaveLength(1);
    expect(script.turns[0]).toMatchObject({ effort: "high" });
    expect(script.turns[0]!.text).toContain("问 codex");
    expect(r.bridge.inbox.getInbound(key)).toMatchObject({ state: "done", turn_id: "codex:turn-1" });
    expect(r.bridge.outbox.listOutboxByTurn("codex:turn-1")).toMatchObject([{ key: `${G}:exec-1`, status: "sent", input_key: key }]);
  });

  it("同一发送者的后续消息插话进当前回合（turn/steer 带 expectedTurnId），不开新一轮", async () => {
    const slow = gate();
    const script = new CodexScript();
    script.onTurn = () => slow.wait();
    const r = await codexRig(script);
    await r.say("5", "第一条");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-1"));
    const second = await r.say("5", "第二条");
    expect(script.steers).toMatchObject([{ turnId: "turn-1" }]);
    expect(script.steers[0]!.text).toContain("第二条");
    expect(r.bridge.inbox.getInbound(second)).toMatchObject({ state: "delivered", turn_id: "codex:turn-1" });
    slow.open();
    await r.idle();
    expect(script.turns).toHaveLength(1);
    expect(r.bridge.inbox.getInbound(second)!.state).toBe("done");
  });

  it("插话被拒（not_steerable）：消息排队，本轮结束后单独开一轮", async () => {
    const slow = gate();
    const script = new CodexScript();
    script.onTurn = turn => turn.turnId === "turn-1" ? slow.wait() : undefined;
    script.steerReply = () => ({ error: { code: -32600, message: "cannot steer a review turn" } });
    const r = await codexRig(script);
    await r.say("5", "第一条");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-1"));
    await r.say("5", "第二条");
    expect(r.host.thread(G)?.pending).toMatchObject([{ sender: "5" }]);
    slow.open();
    await r.idle();
    expect(script.turns.map(t => t.text.split("\n").at(-1))).toEqual(["第一条", "第二条"]);
  });

  it("他人的消息排队，本轮结束后按到达顺序开新一轮", async () => {
    const slow = gate();
    const script = new CodexScript();
    script.onTurn = turn => turn.turnId === "turn-1" ? slow.wait() : undefined;
    const r = await codexRig(script);
    await r.say("5", "慢");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-1"));
    await r.say("6", "我也问");
    expect(script.steers).toEqual([]);
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnSender: "5", pending: [{ sender: "6" }] });
    slow.open();
    await r.idle();
    expect(script.turns.map(t => t.text.split("\n").at(-1))).toEqual(["慢", "我也问"]);
    expect(r.host.thread(G)).toMatchObject({ busy: false });
  });

  it("回合失败（turn/completed 非 completed、不再重试的 error）按 §8.1 提示", async () => {
    const script = new CodexScript();
    script.auto = false;
    script.onTurn = turn => {
      turn.child.notify("error", { threadId: turn.threadId, turnId: turn.turnId, willRetry: false, error: { message: "provider exploded" } });
      script.complete(turn, "failed");
    };
    const r = await codexRig(script);
    const key = await r.say("5", "会失败");
    await r.idle();
    expect(r.texts("7")).toEqual([TURN_NOTICES.failed]);
    expect(await r.host.inputOutcome(key)).toEqual({ status: "failed", turnId: "codex:turn-1" });
  });
});

describe("codex 常驻：唤醒回合与工具调用的回合归属", () => {
  it("app-server 自己开的唤醒回合按唤醒身份：只能发往本会话、不 @、读取本会话范围", async () => {
    const script = new CodexScript();
    const r = await codexRig(script);
    await r.say("1", "owner 派了子 agent"); // owner 本人的回合
    await r.idle();
    const first = script.turns[0]!;
    const wake = script.wake(first.child, first.threadId);
    await vi.waitFor(() => expect(r.host.thread(G)).toMatchObject({ busy: true, turnId: "codex:" + wake.turnId, turnKind: "wake" }));
    expect(r.host.currentIdentity(G)).toEqual({ kind: "wake" });
    script.toolCall(wake, "exec-w1");
    await expect(r.codexSend(G, { text: "发往别处", target: "qq:group:8" }, { callId: "exec-w1", threadId: wake.threadId }))
      .rejects.toThrow("唤醒回合只能发往本会话");
    script.toolCall(wake, "exec-w2");
    expect(await r.codexContext(G, { callId: "exec-w2", threadId: wake.threadId }))
      .toMatchObject({ access: G, turn_id: "codex:" + wake.turnId, session: wake.threadId, image_refs: [] });
    script.toolCall(wake, "exec-w3");
    expect(await r.codexSend(G, { text: "子 agent 做完了" }, { callId: "exec-w3", threadId: wake.threadId })).toMatchObject({ status: "sent" });
    script.complete(wake);
    await r.idle();
    expect(r.texts("7")).toEqual(["子 agent 做完了"]);
    expect(r.mentions()).toEqual([null]);
  });

  it("owner 回合读取范围 all；子 agent 线程的调用、回合结束后的同一调用（过期回合）、没有归属的调用都被拒绝", async () => {
    const slow = gate();
    const script = new CodexScript();
    script.onTurn = () => slow.wait();
    const r = await codexRig(script, { callWaitMs: 200 });
    await r.say("1", "owner 问");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-1"));
    const turn = script.turns[0]!;
    script.toolCall(turn, "exec-1");
    expect(await r.codexContext(G, { callId: "exec-1", threadId: turn.threadId })).toMatchObject({ access: "all", turn_id: "codex:turn-1" });
    // 回合元数据直接给出 turn_id 时不必等条目
    expect(await r.codexContext(G, { turnId: turn.turnId, threadId: turn.threadId })).toMatchObject({ access: "all" });
    await expect(r.codexContext(G, { callId: "exec-x", threadId: "child-thread" })).rejects.toThrow("子 agent");
    slow.open();
    await r.idle();
    await expect(r.codexSend(G, { text: "迟到的发送" }, { callId: "exec-1", threadId: turn.threadId })).rejects.toThrow("本回合已结束");
    await expect(r.codexContext(G, { turnId: turn.turnId })).rejects.toThrow("本回合已结束");
    await expect(r.codexContext(G, {})).rejects.toThrow("缺少调用归属");
    expect(r.texts("7")).toEqual([]);
  });

  it("同一 callId 重放取回同一 Outbox 行，不重发", async () => {
    const slow = gate();
    const script = new CodexScript();
    script.onTurn = () => slow.wait();
    const r = await codexRig(script);
    await r.say("5", "发一次");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-1"));
    const turn = script.turns[0]!;
    script.toolCall(turn, "exec-same");
    const first = await r.codexSend(G, { text: "只发一次" }, { callId: "exec-same", threadId: turn.threadId });
    const again = await r.codexSend(G, { text: "只发一次" }, { callId: "exec-same", threadId: turn.threadId });
    expect(first).toMatchObject({ status: "sent", already_sent: false });
    expect(again).toMatchObject({ status: "sent", already_sent: true, message_id: first.message_id });
    slow.open();
    await r.idle();
    expect(r.texts("7")).toEqual(["只发一次"]);
  });

  it("线程令牌按会话签发：各写进本线程的 MCP 环境（没有身份、范围与生图目录）；令牌不能代表别的会话", async () => {
    const gates: ReturnType<typeof gate>[] = [];
    const script = new CodexScript();
    script.onTurn = () => { const g = gate(); gates.push(g); return g.wait(); };
    const r = await codexRig(script, { callWaitMs: 200 });
    await r.say("5", "群七", "7");
    await r.say("5", "群八", "8");
    await vi.waitFor(() => expect(script.turns).toHaveLength(2));
    const loads = r.codexSpawn.children.flatMap(c => c.requests("thread/start"))
      .map(m => m.params as { cwd: string; config: Record<string, unknown>; sandbox?: unknown });
    expect(loads).toHaveLength(2);
    const [a, b] = loads.map(l => l.config);
    expect(a!["mcp_servers.im.env.IM_TOKEN"]).toMatch(/^[a-f0-9]{64}$/);
    expect(a!["mcp_servers.qq_context.env.QQ_RECALL_TOKEN"]).toBe(a!["mcp_servers.im.env.IM_TOKEN"]);
    expect(a!["mcp_servers.im.env.IM_TOKEN"]).not.toBe(b!["mcp_servers.im.env.IM_TOKEN"]);
    for (const config of [a!, b!]) {
      expect(Object.keys(config).some(k => /QQ_ACCESS|IMAGE_TICKET_DIR|IMAGE_REFS|QQ_TICKET/.test(k))).toBe(false);
      expect(config).toMatchObject({ default_permissions: "cs_agent_scope", approval_policy: "never" });
    }
    // 命名权限与 sandbox_mode 互斥：不发 sandbox 参数
    expect(loads.every(l => l.sandbox === undefined)).toBe(true);
    const t7 = script.turns.find(t => t.text.includes("群七"))!, t8 = script.turns.find(t => t.text.includes("群八"))!;
    script.toolCall(t7!, "exec-7");
    // 群八的令牌拿群七回合的调用：令牌所属会话（群八）里没有这个调用 → 拒绝
    await expect(r.codexSend(G, { text: "冒充" }, { callId: "exec-7", threadId: t7!.threadId }, r.codexToken("group:8"))).rejects.toThrow();
    script.toolCall(t8!, "exec-8");
    expect(await r.codexSend("group:8", { text: "群八回复" }, { callId: "exec-8", threadId: t8!.threadId })).toMatchObject({ status: "sent" });
    for (const g of gates) g.open();
    await r.idle();
    expect(r.texts("7")).toEqual([]);
    expect(r.texts("8")).toEqual(["群八回复"]);
  });
});

describe("codex 常驻：崩溃恢复、停止、后端切换与压缩", () => {
  it("app-server 崩溃：进行中的回合按丢失结束并提示中断；下一轮 thread/resume 同一线程、换发新令牌", async () => {
    const script = new CodexScript();
    script.auto = false;
    const r = await codexRig(script);
    const key = await r.say("5", "很慢");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-1"));
    const oldToken = r.codexToken(G);
    const turn = script.turns[0]!;
    turn.child.exit(1);
    await r.idle();
    expect(r.texts("7")).toEqual([TURN_NOTICES.lost]);
    expect(await r.host.inputOutcome(key)).toEqual({ status: "lost", turnId: "codex:turn-1" });
    await expect(r.codexContext(G, { turnId: turn.turnId }, oldToken)).rejects.toThrow("令牌");
    script.auto = true;
    script.onTurn = async next => {
      script.toolCall(next, "exec-after");
      await r.codexSend(G, { text: "恢复了" }, { callId: "exec-after", threadId: next.threadId });
    };
    await r.say("5", "再来");
    await r.idle();
    expect(r.codexSpawn.children.length).toBeGreaterThanOrEqual(2);
    expect(r.codexSpawn.last.requests("thread/resume").map(m => (m.params as { threadId: string }).threadId)).toEqual([turn.threadId]);
    expect(r.codexToken(G)).not.toBe(oldToken);
    expect(r.texts("7")).toEqual([TURN_NOTICES.lost, "恢复了"]);
  });

  it("面板停止：turn/interrupt，回合结束不发出错提示；看门狗中止按失败提示", async () => {
    const script = new CodexScript();
    script.auto = false;
    let now = Date.now();
    const r = await codexRig(script, { now: () => now, stallMs: 60_000 });
    await r.say("5", "停下");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-1"));
    await r.monitor.stop(G);
    await r.idle();
    expect(r.codexSpawn.last.requests("turn/interrupt")).toMatchObject([{ params: { turnId: "turn-1" } }]);
    expect(r.texts("7")).toEqual([]);
    await r.say("5", "卡住");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-2"));
    now += 61_000;
    expect(await r.monitor.sweep()).toEqual([G]);
    await r.idle();
    expect(r.texts("7")).toEqual([TURN_NOTICES.failed]);
  });

  it("子 agent 仍在运行时不切换后端；子 agent 结束后下一条消息才切到 pi", async () => {
    let backend: "codex" | "pi" = "codex";
    const script = new CodexScript();
    const r = await residentRig({ backend: () => backend, codex: script });
    await r.say("5", "派子 agent");
    await r.idle();
    const parent = script.turns[0]!;
    // 主回合里派出的子 agent：父线程的 subAgentActivity 条目
    parent.child.notify("item/started", { threadId: parent.threadId, turnId: parent.turnId,
      item: { type: "subAgentActivity", id: "act-1", agentThreadId: "child-1", kind: "started" } });
    await vi.waitFor(async () => expect(await r.codex.busy(G)).toBe(true));
    backend = "pi";
    await r.say("5", "还在 codex");
    await r.idle();
    expect(script.turns).toHaveLength(2);
    expect(r.host.thread(G)).toMatchObject({ backend: "codex" });
    parent.child.notify("item/completed", { threadId: parent.threadId, turnId: script.turns[1]!.turnId,
      item: { type: "subAgentActivity", id: "act-2", agentThreadId: "child-1", kind: "completed" } });
    await vi.waitFor(async () => expect(await r.codex.busy(G)).toBe(false));
    const key = await r.say("5", "换到 pi");
    await r.idle();
    expect(script.turns).toHaveLength(2);
    expect(r.bridge.inbox.getInbound(key)!.turn_id).toMatch(/^pi:/);
  });

  it("面板压缩：会话空闲时经常驻 app-server thread/compact/start，压缩回合不交给宿主；忙时拒绝", async () => {
    const script = new CodexScript();
    const r = await codexRig(script);
    expect(await r.codex.compactThread(G)).toBe("unchanged");
    await r.say("5", "先聊一轮");
    await r.idle();
    const child = r.codexSpawn.last;
    const threadId = script.turns[0]!.threadId;
    child.handlers["thread/compact/start"] = (_m, c) => {
      setImmediate(() => {
        c.notify("turn/started", { threadId, turn: { id: "compact-1", status: "inProgress" } });
        c.notify("item/completed", { threadId, turnId: "compact-1", item: { type: "contextCompaction", id: "cc" } });
        c.notify("turn/completed", { threadId, turn: { id: "compact-1", status: "completed" } });
      });
      return { result: {} };
    };
    expect(await r.codex.compactThread(G)).toBe("compacted");
    await r.idle();
    expect(r.host.thread(G)).toMatchObject({ busy: false });
    expect(r.texts("7")).toEqual([]);
    script.auto = false;
    await r.say("5", "忙着");
    await vi.waitFor(() => expect(r.host.thread(G)?.turnId).toBe("codex:turn-2"));
    await expect(r.codex.compactThread(G)).rejects.toThrow("正在处理");
    script.complete(script.turns[1]!);
    await r.idle();
  });
});
