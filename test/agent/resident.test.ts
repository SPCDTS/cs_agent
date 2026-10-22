import { describe, expect, it, vi } from "vitest";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { TURN_NOTICES } from "../../src/agent/replies.js";
import type { ReplyStore } from "../../src/qq/reply-store.js";
import { call, gate, isChild, lastUser, reply, residentRig, toolResults, waitUntil, type Brain } from "./resident-fixture.js";

/** 收到指定正文的用户输入时调用 send_message 回复；工具结果之后收尾。 */
function echoBrain(extra?: (ctx: TranscriptContext, input: string, signal: AbortSignal | undefined) => ReturnType<Brain> | undefined): Brain {
  return (ctx, signal) => {
    const end = ctx.messages.at(-1)!;
    if (end.role === "toolResult") return reply("结束");
    const input = lastUser(ctx);
    const custom = extra?.(ctx, input, signal);
    if (custom) return custom;
    return call(["send_message", { text: "收到：" + input.split("\n").at(-1) }]);
  };
}

describe("常驻 agent：输入 → ThreadHost → pi 回合 → send_message", () => {
  it("群里 @ 开一轮：回复发往本群并 @ 发送者，输入标记 done，Outbox 行键绑定会话", async () => {
    const r = await residentRig({ brain: echoBrain() });
    const key = await r.say("5", "你好");
    await r.idle();
    expect(r.texts("7")).toEqual(["收到：你好"]);
    expect(r.mentions()).toEqual(["5"]);
    expect(r.bridge.inbox.getInbound(key)).toMatchObject({ state: "done", thread_key: "group:7" });
    const turnId = r.bridge.inbox.getInbound(key)!.turn_id!;
    expect(turnId).toMatch(/^pi:\d+:\d+$/);
    const rows = r.bridge.outbox.listOutboxByTurn(turnId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key.startsWith("group:7:")).toBe(true);
    expect(rows[0]).toMatchObject({ thread_key: "group:7", input_key: key, status: "sent", system: false, proactive: false });
    // 消息库：机器人行引用本轮输入
    const hist = r.history.message({ kind: "scope", scope: "group:7" }, rows[0]!.message_id!);
    expect(hist?.row.reply_to_id).toBe(r.bridge.inbox.getInbound(key)!.message_id);
  });

  it("同一群两个人：第二人的消息排队到第一人这轮结束后再开新一轮", async () => {
    const slow = gate();
    const seen: string[] = [];
    const r = await residentRig({ brain: echoBrain((ctx, input) => {
      if (ctx.messages.at(-1)!.role !== "user") return undefined;
      seen.push(input.split("\n").at(-1)!);
      return input.endsWith("慢") ? (async () => { await slow.wait(); return call(["send_message", { text: "慢好了" }]); })() : undefined;
    }) });
    await r.say("5", "慢");
    await waitUntil(() => slow.entered === 1);
    await r.say("6", "我也问");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(seen).toEqual(["慢"]);
    expect(r.host.thread("group:7")).toMatchObject({ busy: true, turnSender: "5", pending: [{ sender: "6" }] });
    slow.open();
    await r.idle();
    expect(seen).toEqual(["慢", "我也问"]);
    expect(r.texts("7")).toEqual(["慢好了", "收到：我也问"]);
    // 每轮第一条发往本群的消息 @ 本轮发送者
    expect(r.mentions()).toEqual(["5", "6"]);
  });

  it("同一发送者插话进当前回合（pi steer），不开新一轮", async () => {
    const slow = gate();
    const contexts: string[][] = [];
    const r = await residentRig({ brain: (ctx) => {
      const end = ctx.messages.at(-1)!;
      if (end.role === "toolResult") {
        contexts.push(ctx.messages.filter(m => m.role === "user").map(m => lastUserText(m)));
        return reply("结束");
      }
      if (lastUser(ctx).endsWith("慢")) return (async () => { await slow.wait(); return call(["send_message", { text: "第一条" }]); })();
      return call(["send_message", { text: "其他" }]);
    } });
    const first = await r.say("5", "慢");
    await waitUntil(() => slow.entered === 1);
    const second = await r.say("5", "补充一句");
    expect(r.host.thread("group:7")?.turnInputs.map(i => i.inboundKey)).toEqual([first, second]);
    slow.open();
    await r.idle();
    expect(r.bridge.inbox.getInbound(first)!.turn_id).toBe(r.bridge.inbox.getInbound(second)!.turn_id);
    expect(contexts.at(-1)!.some(t => t.includes("补充一句"))).toBe(true);
  });

});

describe("群里 owner 多账号插话（§7.2）", () => {
  it("A 开轮、B 在第一条回复前插话：首条回复 @ 本轮发送者 A 并正常发出，input_key 仍为最新输入", async () => {
    const slow = gate();
    const results: string[][] = [];
    const r = await residentRig({ owners: ["1", "9"], brain: (ctx) => {
      const end = ctx.messages.at(-1)!;
      if (end.role === "toolResult") { results.push(toolResults(ctx)); return reply("结束"); }
      if (lastUser(ctx).endsWith("慢")) return (async () => { await slow.wait(); return call(["send_message", { text: "好" }]); })();
      return call(["send_message", { text: "其他" }]);
    } });
    const a = await r.say("1", "慢");
    await waitUntil(() => slow.entered === 1);
    const b = await r.say("9", "另一个号补充");
    expect(r.host.thread("group:7")?.turnInputs.map(i => i.inboundKey)).toEqual([a, b]);
    slow.open();
    await r.idle();
    expect(results.flat().some(t => t.includes("回复只能 @"))).toBe(false);
    expect(r.texts("7")[0]).toBe("好");
    expect(r.mentions()[0]).toBe("1");
    const rows = r.bridge.outbox.listOutboxByTurn(r.bridge.inbox.getInbound(a)!.turn_id!);
    expect(rows[0]).toMatchObject({ status: "sent", mention_user_id: "1", input_key: b });
  });

  it("bridge 拒绝发送（@ 对象不合法）时模型收到错误", async () => {
    const results: string[][] = [];
    const r = await residentRig({ brain: (ctx) => {
      const end = ctx.messages.at(-1)!;
      if (end.role === "toolResult") { results.push(toolResults(ctx)); return reply("结束"); }
      return call(["send_message", { text: "好" }]);
    } });
    // 模拟通道拒绝：@ 对象换成本轮之外的人
    const original = r.bridge.send.bind(r.bridge);
    r.bridge.send = (key, target, body, images, opts) => original(key, target, body, images, { ...opts, mention: "6" });
    await r.say("5", "你好");
    await r.idle();
    expect(r.sent).toEqual([]);
    expect(results.flat().some(t => t.includes("回复只能 @ 本轮发送者"))).toBe(true);
  });
});

describe("出错提示与看门狗（§8）", () => {
  it("回合失败发一条出错提示；10 分钟内同一会话不再重复", async () => {
    let now = Date.now();
    const r = await residentRig({ now: () => now, brain: () => reply("") , });
    r.brain.current = () => Object.assign(reply(""), { stopReason: "error" as const, errorMessage: "上游拒绝请求" });
    await r.say("5", "第一次");
    await r.idle();
    expect(r.texts("7")).toEqual([TURN_NOTICES.failed]);
    expect(r.mentions()).toEqual([null]);
    await r.say("5", "第二次");
    await r.idle();
    expect(r.texts("7")).toEqual([TURN_NOTICES.failed]);
    now += 11 * 60_000;
    await r.say("5", "第三次");
    await r.idle();
    expect(r.texts("7")).toEqual([TURN_NOTICES.failed, TURN_NOTICES.failed]);
  });

  it("看门狗：回合长时间没有事件即中止，并按回合失败提示", async () => {
    const stuck = gate();
    const r = await residentRig({ stallMs: 0, brain: async (_ctx, signal) => { await stuck.wait(signal); return reply(); } });
    await r.say("5", "卡住");
    await waitUntil(() => stuck.entered === 1);
    await waitUntil(() => !!r.host.thread("group:7")?.turnId);
    expect(await r.monitor.sweep()).toEqual(["group:7"]);
    await r.idle();
    expect(r.texts("7")).toEqual([TURN_NOTICES.failed]);
  });

  it("面板停止：中止当前回合，不发出错提示，排队输入随后照常处理", async () => {
    const stuck = gate();
    const r = await residentRig({ brain: echoBrain((ctx, input, signal) =>
      ctx.messages.at(-1)!.role === "user" && input.endsWith("卡住") ? (async () => { await stuck.wait(signal); return reply(); })() : undefined) });
    await r.say("5", "卡住");
    await waitUntil(() => stuck.entered === 1);
    await r.say("6", "下一位");
    await r.monitor.stop("group:7");
    stuck.open();
    await r.idle();
    expect(r.texts("7")).toEqual(["收到：下一位"]);
  });
});


describe("唤醒回合不被用户输入升级（§7.3）", () => {
  it("宿主尚未确认唤醒 run 时 owner 来消息：输入不并入唤醒 run，唤醒工作保持派出者（成员）的身份，消息排到其后", async () => {
    const wakeGate = gate();
    const results: string[][] = [];
    const r = await residentRig({ owners: ["1"], brain: (ctx) => {
      if (isChild(ctx)) return reply("晴，25 度");
      const end = ctx.messages.at(-1)!;
      if (end.role === "toolResult") { results.push(toolResults(ctx)); return reply("收尾"); }
      const input = lastUser(ctx);
      if (input.startsWith("[子 agent 完成]")) return (async () => { await wakeGate.wait(); return call(["send_message", { text: "转告", target: "qq:group:8" }]); })();
      if (input.endsWith("新消息")) return call(["send_message", { text: "收到新消息" }]);
      return call(["subagent", { action: "spawn", name: "w", task: "查天气" }]);
    } });
    // 宿主暂不处理后端开的回合（模拟唤醒事件还在路上）
    const deferred: (() => void)[] = [];
    const onTurnStarted = r.host.onTurnStarted.bind(r.host);
    r.host.onTurnStarted = (threadKey, turnId, by, identity) => {
      if (by === "backend") deferred.push(() => onTurnStarted(threadKey, turnId, by, identity));
      else onTurnStarted(threadKey, turnId, by, identity);
    };
    // 成员 5 派出子 agent（没有 send 授权）；之后 owner 来消息
    await r.say("5", "查一下天气");
    await waitUntil(() => wakeGate.entered === 1, 15_000);
    await r.host.idle();
    expect(r.host.thread("group:7")?.busy).toBe(false);
    const late = await r.say("1", "新消息");
    await r.host.idle();
    // 输入没有并入唤醒 run：宿主按唤醒回合接管（继承派出者 5，不升级为 owner），消息排队
    expect(r.host.thread("group:7")).toMatchObject({ busy: true, turnKind: "wake", pending: [{ inboundKey: late }] });
    expect(r.host.currentIdentity("group:7")).toEqual({ kind: "wake", inherited: { kind: "user", person: "5", owner: false } });
    wakeGate.open();
    for (const fire of deferred.splice(0)) fire();
    await r.idle(15_000);
    expect(r.texts("8")).toEqual([]);
    // 成员没有 send 授权：本轮工具 schema 不含 target（执行时也会按继承身份拒绝），发往别处失败
    expect(results.some(rs => rs.some(t => t.includes("target") && !t.startsWith("{")))).toBe(true);
    // 新消息在唤醒回合结束后单独一轮，身份为 owner
    expect(r.texts("7")).toEqual(["收到新消息"]);
    expect(r.mentions()).toEqual(["1"]);
    expect(r.bridge.inbox.getInbound(late)).toMatchObject({ state: "done" });
  });
});

describe("重启恢复", () => {
  it("pi 回合跨重启续跑；排队的输入重启后重新驱动", async () => {
    const slow = gate();
    const r = await residentRig({ brain: echoBrain((ctx, input, signal) =>
      ctx.messages.at(-1)!.role === "user" && input.endsWith("慢") ? (async () => { await slow.wait(signal); return call(["send_message", { text: "慢好了" }]); })() : undefined) });
    await r.say("5", "慢");
    await waitUntil(() => slow.entered === 1);
    const queued = await r.say("6", "排队的");
    await r.restart();
    slow.open();
    await r.idle(20_000);
    expect(r.texts("7")).toContain("收到：排队的");
    expect(r.bridge.inbox.getInbound(queued)!.state).toBe("done");
  });

  it("Outbox 按调用键幂等：同一 callKey 重放不重发", async () => {
    const r = await residentRig({ brain: () => reply() });
    const key = await r.say("5", "你好");
    await r.idle();
    const binding = { ...r.inbox.binding("group:7"), access: { kind: "scope" as const, scope: "group:7" }, workdir: r.dir };
    const first = await r.sendService.send(binding, { text: "一次" }, "call-1");
    const again = await r.sendService.send(binding, { text: "一次" }, "call-1");
    expect(first.already_sent).toBe(false);
    expect(again).toMatchObject({ already_sent: true, message_id: first.message_id });
    expect(r.texts("7")).toEqual(["一次"]);
    expect(r.bridge.outbox.getOutbox("group:7:call-1")).toMatchObject({ status: "sent", input_key: key });
  });
});

function lastUserText(m: { content: unknown }): string {
  return typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map(c => c.text ?? "").join("");
}


describe("一轮只开一条输入（§4.2）", () => {

  it("开轮请求未确认就重启：重放同一条输入取回同一提交，回合结果取该提交的真实结果（失败照常回报）", async () => {
    const r = await residentRig({ brain: () => Object.assign(reply(""), { stopReason: "error" as const, errorMessage: "上游拒绝请求" }) });
    const msg = r.message("5", "会失败");
    const key = (r.bridge.inbox as ReplyStore).admit(msg, "group:7")!;
    r.history.ingest(msg);
    const input = { inboundKey: key, kind: "user" as const, sender: "5", seq: 100, at: 0 };
    const completed: { turnId: string; status: string }[] = [];
    const onTurnCompleted = r.host.onTurnCompleted.bind(r.host);
    r.host.onTurnCompleted = (threadKey, turnId, result) => { completed.push({ turnId, status: result.status }); onTurnCompleted(threadKey, turnId, result); };
    const first = await r.pi.startTurn("group:7", [input], { kind: "user", sender: "5" });
    await waitUntil(() => completed.length === 1);
    const again = await r.pi.startTurn("group:7", [input], { kind: "user", sender: "5" });
    expect(again).toEqual(first);
    await waitUntil(() => completed.length === 2);
    expect(completed).toEqual([{ turnId: (first as { turnId: string }).turnId, status: "failed" }, { turnId: (first as { turnId: string }).turnId, status: "failed" }]);
  });
});

describe("pi 会话仍有后台工作（后端切换判定）", () => {
  it("子 agent 在跑时 busy；汇报唤醒结束后不再 busy", async () => {
    const child = gate();
    const r = await residentRig({ brain: (ctx) => {
      if (isChild(ctx)) return (async () => { await child.wait(); return reply("晴"); })();
      if (ctx.messages.at(-1)!.role === "toolResult") return reply("收尾");
      if (lastUser(ctx).startsWith("[子 agent 完成]")) return reply("知道了");
      return call(["subagent", { action: "spawn", name: "w", task: "查天气" }]);
    } });
    expect(await r.pi.busy("group:7")).toBe(false);
    await r.say("5", "派个子 agent");
    await waitUntil(() => child.entered === 1, 15_000);
    await waitUntil(() => !r.host.thread("group:7")?.busy);
    expect(await r.pi.busy("group:7")).toBe(true);
    child.open();
    await vi.waitFor(async () => expect(await r.pi.busy("group:7")).toBe(false), { timeout: 15_000, interval: 20 });
    await r.idle(15_000);
  });

  it("busy 在一次一致的读取里判断：子 agent 汇报恰在读取之间唤醒主会话时仍为 busy", async () => {
    const child = gate(), wake = gate();
    const r = await residentRig({ brain: (ctx) => {
      if (isChild(ctx)) return (async () => { await child.wait(); return reply("晴"); })();
      if (ctx.messages.at(-1)!.role === "toolResult") return reply("收尾");
      if (lastUser(ctx).startsWith("[子 agent 完成]")) return (async () => { await wake.wait(); return reply("知道了"); })();
      return call(["subagent", { action: "spawn", name: "w", task: "查天气" }]);
    } });
    await r.say("5", "派个子 agent");
    await waitUntil(() => child.entered === 1, 15_000);
    await waitUntil(() => !r.host.thread("group:7")?.busy);
    // 第一次读取之后、第二次读取之前：子 agent 完成，汇报唤醒主会话（汇报登记随之清空）
    const snapshot = r.pi.harness.snapshot.bind(r.pi.harness);
    let reads = 0;
    (r.pi.harness as { snapshot: unknown }).snapshot = async (...args: Parameters<typeof snapshot>) => {
      const value = await snapshot(...args);
      if (++reads === 2) { child.open(); await waitUntil(() => wake.entered === 1, 15_000); await new Promise(res => setTimeout(res, 200)); }
      return value;
    };
    const busy = await r.pi.busy("group:7");
    (r.pi.harness as { snapshot: unknown }).snapshot = snapshot;
    child.open();
    expect(busy).toBe(true);
    wake.open();
    await r.idle(15_000);
  });
});


