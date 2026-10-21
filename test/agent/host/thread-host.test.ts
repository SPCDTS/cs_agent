import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { HostInputDoc, ThreadHostDoc } from "../../../src/agent/host/docs.js";
import { ThreadHost, STALL_MS } from "../../../src/agent/host/thread-host.js";
import type { HostCallbacks, InputRef, StartTurnResult, ThreadAdapter, ThreadKey, TurnContext, TurnEnded } from "../../../src/agent/host/types.js";

const ctx = BACKGROUND_CONTEXT;
const G = "group:42" as ThreadKey, H = "group:43" as ThreadKey, P = "private:7" as ThreadKey;
const OWNERS = ["1001", "1002"];

/** 记录调用的假后端：回合由测试显式结束或唤醒。 */
class FakeAdapter implements ThreadAdapter {
  host!: HostCallbacks;
  starts: { threadKey: ThreadKey; keys: string[]; ctx: TurnContext; turnId: string }[] = [];
  steers: { threadKey: ThreadKey; turnId: string; key: string; reply: string }[] = [];
  interrupts: ThreadKey[] = [];
  /** 后端认为仍在进行的回合 */
  live = new Map<ThreadKey, string>();
  recoverAs: (threadKey: ThreadKey) => "alive" | "lost" = () => "alive";
  failStart?: string;
  /** 开轮挂起（模拟开轮请求发出后进程崩溃） */
  hangStart = false;
  /** 后端已有宿主尚未确认的唤醒回合：开轮时不收输入，回报该回合 */
  busyWake?: string;
  abandoned: { threadKey: ThreadKey; turnId: string }[] = [];
  /** 放弃回合时后端的处理：aborted = 工作被中止 */
  abandonAs: "aborted" | "detached" = "detached";
  /** 开轮只收下这些输入（其余应回到队列） */
  acceptOnly?: string[];
  /** 开轮时后端内部重试前复核被拒 */
  denyOnRetry = false;
  private n = 0;

  async startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], turnCtx: TurnContext): Promise<StartTurnResult> {
    if (this.hangStart) return new Promise<never>(() => {});
    if (this.failStart) throw new Error(this.failStart);
    if (this.denyOnRetry && turnCtx.admit && !await turnCtx.admit()) return { denied: true };
    if (this.busyWake) {
      const turnId = this.busyWake;
      this.busyWake = undefined;
      this.live.set(threadKey, turnId);
      this.host.onTurnStarted(threadKey, turnId, "backend");
      return { backendTurnId: turnId };
    }
    const turnId = `t${++this.n}`;
    this.live.set(threadKey, turnId);
    const { admit: _admit, ...plain } = turnCtx;
    const accepted = this.acceptOnly;
    this.acceptOnly = undefined;
    this.starts.push({ threadKey, keys: inputs.map(i => i.inboundKey).filter(k => !accepted || accepted.includes(k)), ctx: plain, turnId });
    // 真实后端会在 startTurn 返回前就回报 turn/started
    this.host.onTurnStarted(threadKey, turnId, "host");
    return accepted ? { turnId, accepted } : { turnId };
  }
  async steer(threadKey: ThreadKey, turnId: string, input: InputRef) {
    const reply = this.live.get(threadKey) === turnId ? "ok" as const : "no_active_turn" as const;
    this.steers.push({ threadKey, turnId, key: input.inboundKey, reply });
    return reply;
  }
  async interrupt(threadKey: ThreadKey) { this.interrupts.push(threadKey); }
  async recoverTurn(threadKey: ThreadKey) { return this.recoverAs(threadKey); }
  async abandon(threadKey: ThreadKey, turnId: string) { this.abandoned.push({ threadKey, turnId }); return this.abandonAs; }

  /** 后端回合结束，但结束事件暂不送达（插话竞态） */
  endSilently(threadKey: ThreadKey) { const id = this.live.get(threadKey)!; this.live.delete(threadKey); return id; }
  complete(threadKey: ThreadKey, status: "completed" | "failed" = "completed", turnId = this.live.get(threadKey)!) {
    this.live.delete(threadKey);
    this.host.onTurnCompleted(threadKey, turnId, { status });
  }
  wake(threadKey: ThreadKey) {
    const turnId = `w${++this.n}`;
    this.live.set(threadKey, turnId);
    this.host.onTurnStarted(threadKey, turnId, "backend");
    return turnId;
  }
  keysOf(threadKey?: ThreadKey) { return this.starts.filter(s => !threadKey || s.threadKey === threadKey).map(s => s.keys); }
}

const rigs: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });

async function rig(options: { concurrency?: number; now?: () => number; admit?: (threadKey: ThreadKey, input: InputRef) => Promise<boolean> } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-thread-host-"));
  let harness!: Harness, host!: ThreadHost, adapter!: FakeAdapter;
  const ended: TurnEnded[] = [];
  const delivered: { turnId: string; keys: string[] }[] = [];
  const open = async (fresh = new FakeAdapter()) => {
    harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, "agent.sqlite")),
      { registry: createRegistry(), models: createModels() }, ctx);
    adapter = fresh;
    host = new ThreadHost({
      store: harness, adapter, concurrency: options.concurrency ?? 4, owners: OWNERS, now: options.now, admit: options.admit,
      events: {
        turnEnded: e => ended.push(e),
        inputsDelivered: (_t, turnId, inputs) => delivered.push({ turnId, keys: inputs.map(i => i.inboundKey) }),
      },
    });
    adapter.host = host;
  };
  await open();
  const r = {
    get harness() { return harness; }, get host() { return host; }, get adapter() { return adapter; }, ended, delivered,
    user: (threadKey: ThreadKey, key: string, sender: string) => host.deliver(threadKey, { inboundKey: key, kind: "user", sender }),
    scheduled: (threadKey: ThreadKey, key: string, creator = "qq:1001") => host.deliver(threadKey, { inboundKey: key, kind: "scheduled", sender: creator }),
    settle: () => host.idle(),
    /** 模拟进程重启：丢弃宿主与后端，重新打开同一数据库后恢复 */
    async restart(next = new FakeAdapter(), settle = true) {
      if (settle) await host.idle();
      await harness.close(ctx);
      await open(next);
      await host.recover();
      await host.idle();
    },
    async close() { await harness.close(ctx).catch(() => {}); rmSync(dir, { recursive: true, force: true }); },
  };
  rigs.push(r);
  return r;
}

describe("ThreadHost 投递规则（§4.2）", () => {
  it("空闲 → 开新一轮，回合信息带发送者", async () => {
    const r = await rig();
    expect(await r.user(G, "m1", "500")).toBe("queued");
    await r.settle();
    expect(r.adapter.starts).toMatchObject([{ threadKey: G, keys: ["m1"], ctx: { kind: "user", sender: "500" } }]);
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnId: "t1", turnKind: "user", turnSender: "500" });
    expect(r.delivered).toEqual([{ turnId: "t1", keys: ["m1"] }]);
  });

  it("忙且同一发送者 → 插话进当前回合，不开新轮", async () => {
    const r = await rig();
    await r.user(G, "m1", "500"); await r.settle();
    expect(await r.user(G, "m2", "500")).toBe("steered");
    expect(r.adapter.steers).toEqual([{ threadKey: G, turnId: "t1", key: "m2", reply: "ok" }]);
    expect(r.adapter.starts).toHaveLength(1);
    expect(r.host.thread(G)!.turnInputs.map(i => i.inboundKey)).toEqual(["m1", "m2"]);
    r.adapter.complete(G); await r.settle();
    expect(r.ended).toMatchObject([{ turnId: "t1", status: "completed", kind: "user", sender: "500" }]);
    expect(r.ended[0]!.inputs.map(i => i.inboundKey)).toEqual(["m1", "m2"]);
    expect((await r.harness.snapshot(HostInputDoc, "m2", ctx))?.state).toBe("done");
  });

  it("owner 的多个账号算同一发送者：插话；他人排队", async () => {
    const r = await rig();
    await r.user(P, "m1", OWNERS[0]!); await r.settle();
    expect(await r.user(P, "m2", OWNERS[1]!)).toBe("steered");
    expect(await r.user(P, "m3", "500")).toBe("queued");
    expect(r.host.thread(P)!.pending.map(i => i.inboundKey)).toEqual(["m3"]);
  });

  it("忙且不同发送者 → 排队，本轮结束后按到达顺序各开一轮", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    expect(await r.user(G, "b1", "B")).toBe("queued");
    expect(await r.user(G, "c1", "C")).toBe("queued");
    expect(r.adapter.steers).toEqual([]);
    r.adapter.complete(G); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["a1"], ["b1"]]);
    expect(r.host.currentIdentity(G)).toEqual({ kind: "user", sender: "B" });
    r.adapter.complete(G); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["a1"], ["b1"], ["c1"]]);
  });

  it("插话被拒（回合恰好结束）→ 结束事件到达后开新一轮", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    const turnId = r.adapter.endSilently(G);
    expect(await r.user(G, "a2", "A")).toBe("queued");
    expect(r.adapter.steers).toMatchObject([{ key: "a2", reply: "no_active_turn" }]);
    expect(r.adapter.starts).toHaveLength(1);
    r.host.onTurnCompleted(G, turnId, { status: "completed" }); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["a1"], ["a2"]]);
    expect(r.ended[0]!.inputs.map(i => i.inboundKey)).toEqual(["a1"]);
  });

  it("插话被拒时更早到达的他人消息先开轮，被拒输入随后", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    await r.user(G, "b1", "B");
    const turnId = r.adapter.endSilently(G);
    expect(await r.user(G, "a2", "A")).toBe("queued");
    r.host.onTurnCompleted(G, turnId, { status: "completed" }); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["a1"], ["b1"]]);
    // B 的回合进行中，A 的消息不能插进 B 的回合
    expect(await r.user(G, "a3", "A")).toBe("queued");
    r.adapter.complete(G); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["a1"], ["b1"], ["a2", "a3"]]);
  });

  it("定时任务：空闲开轮（定时身份），忙时排队且不插话、不与用户消息合并", async () => {
    const r = await rig();
    await r.scheduled(G, "s1"); await r.settle();
    expect(r.adapter.starts[0]).toMatchObject({ keys: ["s1"], ctx: { kind: "scheduled", sender: "qq:1001" } });
    expect(r.host.currentIdentity(G)).toEqual({ kind: "scheduled", creator: "qq:1001" });
    // 定时回合中用户消息排队（定时回合不是用户回合）
    expect(await r.user(G, "m1", "1001")).toBe("queued");
    r.adapter.complete(G); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["s1"], ["m1"]]);
    // 用户回合中定时任务排队，等空闲；其后的用户消息不并入定时回合
    expect(await r.scheduled(G, "s2")).toBe("queued");
    expect(await r.user(G, "m2", "B")).toBe("queued");
    expect(r.adapter.steers).toEqual([]);
    r.adapter.complete(G); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["s1"], ["m1"], ["s2"]]);
    r.adapter.complete(G); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["s1"], ["m1"], ["s2"], ["m2"]]);
  });

  it("排队输入：同一发送者的连续消息合并为一轮，遇到他人或定时即止", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    for (const [key, sender] of [["b1", "B"], ["b2", "B"], ["c1", "C"], ["b3", "B"]] as const) await r.user(G, key, sender);
    await r.user(G, "o1", OWNERS[0]!); await r.user(G, "o2", OWNERS[1]!);
    await r.scheduled(G, "s1"); await r.user(G, "o3", OWNERS[0]!);
    const order: string[][] = [];
    for (let i = 0; i < 6; i++) { r.adapter.complete(G); await r.settle(); }
    order.push(...r.adapter.keysOf(G));
    expect(order).toEqual([["a1"], ["b1", "b2"], ["c1"], ["b3"], ["o1", "o2"], ["s1"], ["o3"]]);
  });

  it("唤醒回合：后端开轮 → 忙（唤醒身份），用户消息排队到唤醒回合结束", async () => {
    const r = await rig();
    const turnId = r.adapter.wake(G); await r.settle();
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnId, turnKind: "wake", turnInputs: [] });
    expect(r.host.thread(G)!.turnSender).toBeUndefined();
    expect(r.host.currentIdentity(G)).toEqual({ kind: "wake" });
    expect(await r.host.takeMention(G)).toBe(false);
    expect(await r.user(G, "m1", "A")).toBe("queued");
    r.adapter.complete(G); await r.settle();
    expect(r.ended[0]).toMatchObject({ turnId, kind: "wake", status: "completed", inputs: [] });
    expect(r.adapter.keysOf(G)).toEqual([["m1"]]);
  });

  it("忙时收到另一个唤醒回合：上一轮按已结束处理，身份收窄为唤醒", async () => {
    const r = await rig({ concurrency: 1 });
    await r.user(G, "a1", "A"); await r.settle();
    const turnId = r.adapter.wake(G); await r.settle();
    expect(r.ended).toMatchObject([{ turnId: "t1", status: "completed", sender: "A" }]);
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnId, turnKind: "wake" });
    expect(r.host.status().active).toBe(1);
    r.host.onTurnCompleted(G, "t1", { status: "completed" }); await r.settle();
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnId });
    // 被取代的回合交给适配器放弃（codex 中止 exec、pi 降为唤醒身份）
    expect(r.adapter.abandoned).toEqual([{ threadKey: G, turnId: "t1" }]);
  });

  it("被取代回合的后端工作被中止（codex）：按 lost 结束（触发中断提示），输入不重放", async () => {
    const r = await rig();
    r.adapter.abandonAs = "aborted";
    await r.user(G, "a1", "A"); await r.settle();
    r.adapter.wake(G); await r.settle();
    expect(r.ended).toMatchObject([{ turnId: "t1", status: "lost", sender: "A", inputs: [{ inboundKey: "a1" }] }]);
    expect(await r.host.inputOutcome("a1")).toEqual({ status: "lost", turnId: "t1" });
    expect(r.host.thread(G)!.pending).toEqual([]);
  });

  it("开轮时后端只收下部分输入：只有收下的标记 delivered，其余放回队列，回合结束后再开轮", async () => {
    const r = await rig();
    // h0 进行中；E 的两条排队，下一轮合并为 [h1, h2]，后端只收下 h1
    await r.user(H, "h0", "D"); await r.settle();
    await r.user(H, "h1", "E"); await r.user(H, "h2", "E"); await r.settle();
    r.adapter.acceptOnly = ["h1"];
    r.adapter.complete(H); await r.settle();
    expect(r.host.thread(H)).toMatchObject({ busy: true, turnInputs: [{ inboundKey: "h1" }], pending: [{ inboundKey: "h2" }] });
    expect(r.delivered.at(-1)!.keys).toEqual(["h1"]);
    expect(await r.host.inputState("h2")).toBe("queued");
    r.adapter.complete(H); await r.settle();
    expect(r.adapter.keysOf(H)).toEqual([["h0"], ["h1"], ["h2"]]);
  });

  it("定时输入：后端内部重试开轮前复核被拒 → 不开轮，以 failed 结束", async () => {
    let allow = true;
    const r = await rig({ admit: async () => allow });
    r.adapter.denyOnRetry = true;
    const admitOnce = r.adapter.startTurn.bind(r.adapter);
    // 首次复核通过后撤销授权，后端重试前再复核
    r.adapter.startTurn = async (threadKey, inputs, ctx) => { allow = false; return admitOnce(threadKey, inputs, ctx); };
    await r.scheduled(G, "s1"); await r.settle();
    expect(r.ended).toMatchObject([{ kind: "scheduled", status: "failed", inputs: [{ inboundKey: "s1" }] }]);
    expect(r.adapter.starts).toEqual([]);
    expect(r.host.status().active).toBe(0);
  });

  it("开轮时后端回报已有唤醒回合：输入不送入，按唤醒回合接管（唤醒身份），输入排到其后", async () => {
    const r = await rig();
    r.adapter.busyWake = "w9";
    await r.user(G, "m1", "1001"); await r.settle();
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnId: "w9", turnKind: "wake", turnInputs: [], pending: [{ inboundKey: "m1" }] });
    expect(r.host.thread(G)!.turnSender).toBeUndefined();
    expect(r.host.currentIdentity(G)).toEqual({ kind: "wake" });
    expect(await r.host.takeMention(G)).toBe(false);
    expect(r.delivered).toEqual([]);
    expect(await r.host.inputState("m1")).toBe("queued");
    r.adapter.complete(G, "completed", "w9"); await r.settle();
    expect(r.ended[0]).toMatchObject({ turnId: "w9", kind: "wake", inputs: [] });
    expect(r.adapter.starts).toMatchObject([{ keys: ["m1"], ctx: { kind: "user", sender: "1001" } }]);
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnKind: "user", turnSender: "1001" });
    expect(r.host.status().active).toBe(1);
  });

  it("定时输入开轮前复核：拒绝 → 不开轮，以 failed 结束该输入，继续下一条", async () => {
    const admitted: string[] = [];
    const r = await rig({ admit: async (_t, input) => { admitted.push(input.inboundKey); return input.inboundKey !== "s1"; } });
    await r.user(G, "a1", "A"); await r.settle();
    await r.scheduled(G, "s1"); await r.scheduled(G, "s2");
    expect(admitted).toEqual([]);
    r.adapter.complete(G); await r.settle();
    expect(admitted).toEqual(["s1", "s2"]);
    expect(r.ended[1]).toMatchObject({ kind: "scheduled", status: "failed", inputs: [{ inboundKey: "s1" }] });
    expect(r.ended[1]!.turnId).toBeUndefined();
    expect(await r.host.inputState("s1")).toBe("done");
    expect(r.adapter.keysOf(G)).toEqual([["a1"], ["s2"]]);
    expect(r.host.status().active).toBe(1);
  });

  it("回合结果与输入 done 同一提交持久化（inputOutcome）", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    expect(await r.host.inputOutcome("a1")).toBeUndefined();
    r.adapter.complete(G, "failed"); await r.settle();
    expect(await r.host.inputOutcome("a1")).toEqual({ status: "failed", turnId: "t1" });
    await r.restart();
    expect(await r.host.inputOutcome("a1")).toEqual({ status: "failed", turnId: "t1" });
  });

  it("开轮失败 → 以 failed 结束这些输入，继续下一条排队输入", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    await r.user(G, "b1", "B"); await r.user(G, "c1", "C");
    r.adapter.failStart = "backend down";
    r.adapter.complete(G); await r.settle();
    expect(r.ended.slice(1).map(e => [e.inputs[0]!.inboundKey, e.status, e.error])).toEqual([
      ["b1", "failed", "backend down"], ["c1", "failed", "backend down"]]);
    expect(r.host.thread(G)).toMatchObject({ busy: false, pending: [] });
    expect(r.host.status().active).toBe(0);
  });

  it("过期或重复的结束事件不影响当前回合", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    r.host.onTurnCompleted(G, "nope", { status: "failed" }); await r.settle();
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnId: "t1" });
    r.adapter.complete(G, "completed", "t1"); r.host.onTurnCompleted(G, "t1", { status: "completed" }); await r.settle();
    expect(r.ended).toHaveLength(1);
  });
});

describe("ThreadHost 全局并发", () => {
  it("超出上限的开轮按跨会话到达顺序等待槽位；插话不占槽位", async () => {
    const r = await rig({ concurrency: 1 });
    await r.user(G, "g1", "A"); await r.settle();
    await r.user(P, "p1", "B");
    await r.user(H, "h1", "C");
    await r.settle();
    expect(r.adapter.starts.map(s => s.threadKey)).toEqual([G]);
    expect(r.host.status()).toMatchObject({ active: 1, waiting: 2 });
    // 槽位已满仍可插话
    expect(await r.user(G, "g2", "A")).toBe("steered");
    r.adapter.complete(G); await r.settle();
    expect(r.adapter.starts.map(s => s.threadKey)).toEqual([G, P]);
    r.adapter.complete(P); await r.settle();
    expect(r.adapter.starts.map(s => s.threadKey)).toEqual([G, P, H]);
    expect(r.host.status()).toMatchObject({ active: 1, waiting: 0 });
  });

  it("等槽位期间后端开了唤醒回合：开轮让给唤醒回合，结束后再开", async () => {
    const r = await rig({ concurrency: 1 });
    await r.user(G, "g1", "A"); await r.settle();
    await r.user(P, "p1", "B"); await r.settle();
    r.adapter.wake(P); await r.settle();
    r.adapter.complete(G); await r.settle();
    expect(r.adapter.keysOf(P)).toEqual([]);
    expect(r.host.currentIdentity(P)).toEqual({ kind: "wake" });
    r.adapter.complete(P); await r.settle();
    expect(r.adapter.keysOf(P)).toEqual([["p1"]]);
    expect(r.host.status().active).toBe(1);
  });
});

describe("ThreadHost 身份、@ 与看门狗", () => {
  it("currentIdentity：空闲 undefined，用户回合为发送者", async () => {
    const r = await rig();
    expect(r.host.currentIdentity(G)).toBeUndefined();
    await r.user(G, "a1", "A"); await r.settle();
    expect(r.host.currentIdentity(G)).toEqual({ kind: "user", sender: "A" });
    r.adapter.complete(G); await r.settle();
    expect(r.host.currentIdentity(G)).toBeUndefined();
  });

  it("takeMention：用户回合第一次返回发送者，之后 false；新一轮重新计；定时回合 false", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    const [first, second] = await Promise.all([r.host.takeMention(G), r.host.takeMention(G)]);
    expect([first, second]).toEqual(["A", false]);
    await r.user(G, "b1", "B");
    r.adapter.complete(G); await r.settle();
    expect(await r.host.takeMention(G)).toBe("B");
    await r.scheduled(G, "s1");
    r.adapter.complete(G); await r.settle();
    expect(await r.host.takeMention(G)).toBe(false);
  });

  it("stalled：进行中的回合超过阈值没有活动；onActivity 重新计时", async () => {
    let now = 1_000_000;
    const r = await rig({ now: () => now });
    await r.user(G, "a1", "A"); await r.user(P, "p1", "B"); await r.settle();
    now += STALL_MS - 1;
    r.host.onActivity(P);
    expect(r.host.stalled(now)).toEqual([]);
    now += 1;
    expect(r.host.stalled(now)).toEqual([G]);
    expect(r.host.stalled(now, 1)).toEqual([G, P]);
    await r.host.interrupt(G);
    expect(r.adapter.interrupts).toEqual([G]);
  });
});

describe("ThreadHost 持久化与重启恢复", () => {
  it("同一 inboundKey 重复投递是空操作（进行中、结束后、重启后）", async () => {
    const r = await rig();
    await r.user(G, "a1", "A");
    expect(await r.user(G, "a1", "A")).toBe("duplicate");
    await r.settle();
    expect(await r.user(G, "a1", "A")).toBe("duplicate");
    r.adapter.complete(G); await r.settle();
    expect(await r.user(G, "a1", "A")).toBe("duplicate");
    await r.restart();
    expect(await r.user(G, "a1", "A")).toBe("duplicate");
    expect(await r.user(H, "a1", "A")).toBe("duplicate");
    await r.settle();
    expect(r.adapter.starts).toEqual([]);
  });

  it("仍在的回合（pi）保留：身份、@ 记账与排队输入跨重启保持，回合结束后继续", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    expect(await r.host.takeMention(G)).toBe("A");
    await r.user(G, "b1", "B");
    const stored = await r.harness.snapshot(ThreadHostDoc, G, ctx);
    expect(stored).toMatchObject({ busy: true, turnId: "t1", turnSender: "A", mentioned: true });
    const next = new FakeAdapter();
    next.recoverAs = () => "alive";
    next.live.set(G, "t1");
    await r.restart(next);
    expect(r.ended).toEqual([]);
    expect(r.host.currentIdentity(G)).toEqual({ kind: "user", sender: "A" });
    expect(await r.host.takeMention(G)).toBe(false);
    expect(r.host.status().active).toBe(1);
    // 恢复后的回合仍可插话
    expect(await r.user(G, "a2", "A")).toBe("steered");
    next.complete(G); await r.settle();
    expect(r.ended[0]!.inputs.map(i => i.inboundKey)).toEqual(["a1", "a2"]);
    expect(next.keysOf(G)).toEqual([["b1"]]);
  });

  it("丢失的回合（codex）以 lost 结束，排队输入按到达顺序重新驱动", async () => {
    const r = await rig({ concurrency: 1 });
    await r.user(G, "a1", "A"); await r.settle();
    await r.user(H, "h1", "C"); await r.user(G, "b1", "B"); await r.user(P, "p1", "D");
    const next = new FakeAdapter();
    next.recoverAs = () => "lost";
    await r.restart(next);
    expect(r.ended).toMatchObject([{ threadKey: G, turnId: "t1", status: "lost", sender: "A" }]);
    expect((await r.harness.snapshot(HostInputDoc, "a1", ctx))?.state).toBe("done");
    expect(next.starts.map(s => s.keys)).toEqual([["h1"]]);
    next.complete(H); await r.settle();
    next.complete(next.starts[1]!.threadKey); await r.settle();
    expect(next.starts.map(s => s.keys)).toEqual([["h1"], ["b1"], ["p1"]]);
  });

  it("开轮请求未确认就重启：输入放回队列重新开轮", async () => {
    const r = await rig();
    await r.user(G, "a1", "A"); await r.settle();
    await r.user(G, "b1", "B");
    r.adapter.hangStart = true;
    r.adapter.complete(G);
    // 等到"开轮中"落盘（busy 但没有 turnId）
    for (let i = 0; i < 200 && !(await r.harness.snapshot(ThreadHostDoc, G, ctx))?.turnInputs.some(x => x.inboundKey === "b1"); i++) {
      await new Promise(res => setImmediate(res));
    }
    expect(await r.harness.snapshot(ThreadHostDoc, G, ctx)).toMatchObject({ busy: true });
    expect((await r.harness.snapshot(ThreadHostDoc, G, ctx))?.turnId).toBeUndefined();
    const next = new FakeAdapter();
    await r.restart(next, false);
    expect(next.starts).toMatchObject([{ threadKey: G, keys: ["b1"], ctx: { kind: "user", sender: "B" } }]);
    expect(r.ended).toHaveLength(1);
  });

  it("排队状态跨宿主重建保持", async () => {
    const r = await rig();
    await r.scheduled(G, "s1"); await r.settle();
    await r.user(G, "a1", "A"); await r.user(G, "a2", "A");
    await r.restart(Object.assign(new FakeAdapter(), { recoverAs: () => "alive" as const }));
    expect(r.host.thread(G)).toMatchObject({ busy: true, turnId: "t1", turnKind: "scheduled" });
    expect(r.host.thread(G)!.pending.map(i => i.inboundKey)).toEqual(["a1", "a2"]);
    r.host.onTurnCompleted(G, "t1", { status: "completed" }); await r.settle();
    expect(r.adapter.keysOf(G)).toEqual([["a1", "a2"]]);
  });
});
