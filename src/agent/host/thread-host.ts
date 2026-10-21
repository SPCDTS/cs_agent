/**
 * 常驻 agent 的会话宿主（设计 §4.2、§7.2、§7.3、§8.2）：
 * 1. 每个会话键一份 `cs.thread-host` 文档，记录空闲/忙、当前回合、本轮输入与排队输入；内存镜像是唯一写入者。
 * 2. 投递：空闲 → 开新一轮；忙且本轮是同一发送者（owner 多账号算同一人）的用户回合 → 插话；
 *    插话被拒（回合恰好结束）→ 按到达序号排队；其余（他人消息、定时任务、定时/唤醒回合中的消息）→ 排队。
 * 3. 回合结束 → 空闲，按 seq 取下一批开新一轮：定时输入单独一轮；队首为用户消息时，
 *    紧随其后的同一发送者的连续用户消息并入同一轮（遇到他人或定时即止，不越过更早到达的他人消息）。
 * 4. 全局并发上限只限制进行中的回合数：开轮请求按输入的全局到达序号等待槽位，插话不占槽位；
 *    唤醒回合由后端发起，无法拒绝，照常计数（可能暂时超出上限）。
 * 5. 每个会话的操作（投递、开轮、插话、回合事件、@ 记账）在内存里串行；等待槽位不占用串行队列。
 * 6. 重启：恢复集合里的会话，忙且有 turnId 的由适配器判定回合是否仍在（pi 续跑；codex 丢失 → lost 结束）；
 *    忙但没有 turnId（开轮请求未确认）的输入放回队列重新开轮；排队输入按 seq 重新驱动。
 * 7. 每条输入以 inboundKey 幂等：`cs.thread-host.input` 文档存在即为重复投递。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Harness, Tx } from "@earendil-works/pi-durable";
import { log } from "../../shared/log.js";
import { isOwner, type OwnerIds } from "../../shared/owners.js";
import { HostInputDoc, ThreadHostDoc, ThreadHostIndexDoc, type ThreadHostState } from "./docs.js";
import type {
  DeliverResult, HostCallbacks, HostInput, InputRef, StartTurnResult, ThreadAdapter, ThreadHostEvents, ThreadKey,
  TurnEnded, TurnIdentity, TurnStatus,
} from "./types.js";

/** 看门狗默认阈值：回合连续 30 分钟没有任何事件视为卡死（§8.2） */
export const STALL_MS = 30 * 60_000;

export interface ThreadHostOptions {
  store: Pick<Harness, "snapshot" | "commit">;
  adapter: ThreadAdapter;
  /** 同时进行中的回合数上限；可传函数以便面板调整后即时生效 */
  concurrency: number | (() => number);
  /** owner 的多个 QQ 号算同一发送者 */
  owners?: OwnerIds | (() => OwnerIds);
  events?: ThreadHostEvents;
  /**
   * 定时输入开轮前的准入复核（§10）：排队期间创建者的授权可能已撤销或过期，开轮前（含重启恢复后）按当前授权重查。
   * 返回 false：不开轮，该输入按失败结束（拒绝记录与暂停由调用方在返回前持久化）。抛错按开轮失败处理。
   */
  admit?(threadKey: ThreadKey, input: InputRef): Promise<boolean>;
  now?: () => number;
  context?: Context;
}

/** 文档里可缺省的字段：写回时不在新状态里的要删除，不能残留上一轮的值。 */
const OPTIONAL = ["turnId", "turnKind", "turnSender", "lastActivityAt"] as const;

function idleState(s: ThreadHostState, pending = s.pending): ThreadHostState {
  return { threadKey: s.threadKey, busy: false, turnInputs: [], pending, mentioned: false };
}

function bySeq(refs: readonly InputRef[]): InputRef[] {
  return [...refs].sort((a, b) => a.seq - b.seq);
}

/** 全局槽位：等待者按输入 seq 升序取得槽位（跨会话的到达顺序）。 */
class Slots {
  active = 0;
  readonly waiters: { seq: number; resolve: () => void }[] = [];
  constructor(private readonly cap: () => number) {}

  acquire(seq: number): Promise<void> {
    return new Promise(resolve => {
      const at = this.waiters.findIndex(w => w.seq > seq);
      this.waiters.splice(at < 0 ? this.waiters.length : at, 0, { seq, resolve });
      this.drain();
    });
  }

  /** 后端自己开的回合（唤醒、重启后仍在的回合）：不等待，直接计数。 */
  force(): void { this.active++; }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private drain(): void {
    while (this.waiters.length && this.active < Math.max(1, this.cap())) {
      this.active++;
      this.waiters.shift()!.resolve();
    }
  }
}

export class ThreadHost implements HostCallbacks {
  private readonly ctx: Context;
  private readonly now: () => number;
  private readonly slots: Slots;
  /** 会话状态的内存镜像（已加载的会话）；每次提交成功后整体替换 */
  private readonly threads = new Map<string, ThreadHostState>();
  /** 每个会话的串行队尾 */
  private readonly chains = new Map<string, Promise<void>>();
  /** 已发出开轮请求（等待槽位或正在开轮）的会话，避免重复开轮 */
  private readonly starting = new Set<string>();
  /** 当前占用槽位的会话 */
  private readonly holding = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly opts: ThreadHostOptions) {
    this.ctx = opts.context ?? BACKGROUND_CONTEXT;
    this.now = opts.now ?? Date.now;
    const cap = opts.concurrency;
    this.slots = new Slots(typeof cap === "function" ? cap : () => cap);
  }

  // ───────────── 输入 ─────────────

  /**
   * 投递一条输入；返回时输入已持久化，并已插话进当前回合或进入队列（空闲时随即开轮）。
   * 同一 inboundKey 再次投递返回 duplicate，不产生任何变化。
   */
  deliver(threadKey: ThreadKey, input: HostInput): Promise<DeliverResult> {
    const result = this.serial(threadKey, async () => {
      const s = await this.load(threadKey);
      let ref: InputRef | undefined;
      let next: ThreadHostState | undefined;
      await this.opts.store.commit(async tx => {
        const doc = await tx.doc(HostInputDoc, input.inboundKey, threadKey);
        if (doc.state !== "new") return;
        const index = await tx.doc(ThreadHostIndexDoc);
        ref = { inboundKey: input.inboundKey, kind: input.kind, sender: input.sender, seq: index.nextSeq++, at: this.now() };
        Object.assign(doc, { threadKey, seq: ref.seq, state: "queued" });
        next = { ...s, pending: bySeq([...s.pending, ref]) };
        await this.write(tx, next);
      }, this.ctx);
      if (!ref || !next) return "duplicate" as const;
      this.threads.set(threadKey, next);
      if (!this.canSteer(next, ref)) return "queued" as const;
      const turnId = next.turnId!;
      let steered: "ok" | "no_active_turn";
      try {
        steered = await this.opts.adapter.steer(threadKey, turnId, ref);
      } catch (error) {
        log.warn("thread host steer failed, queued instead", { thread: threadKey, input: ref.inboundKey, error });
        steered = "no_active_turn";
      }
      // 插话被拒：输入留在队列（按 seq），等回合结束事件后再开轮
      if (steered !== "ok") return "queued" as const;
      const cur = this.threads.get(threadKey)!;
      await this.save(threadKey, {
        ...cur, pending: cur.pending.filter(p => p.inboundKey !== ref!.inboundKey), turnInputs: [...cur.turnInputs, ref],
      }, tx => this.markInputs(tx, threadKey, [ref!], "delivered"));
      this.emit("inputsDelivered", threadKey, turnId, [ref]);
      return "steered" as const;
    });
    return result.then(r => { this.pump(threadKey); return r; });
  }

  /** 忙、已拿到 turnId、本轮是用户回合、输入是同一发送者的用户消息 */
  private canSteer(s: ThreadHostState, ref: InputRef): boolean {
    return s.busy && !!s.turnId && s.turnKind === "user" && ref.kind === "user" && this.sameSender(s.turnSender, ref.sender);
  }

  /** owner 的多个账号算同一人 */
  sameSender(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const owners = typeof this.opts.owners === "function" ? this.opts.owners() : this.opts.owners;
    return isOwner(owners, a) && isOwner(owners, b);
  }

  /** 定时输入单独一轮；用户消息合并其后同一发送者的连续用户消息。 */
  private batch(pending: readonly InputRef[]): InputRef[] {
    const head = pending[0]!;
    if (head.kind !== "user") return [head];
    const out = [head];
    for (const ref of pending.slice(1)) {
      if (ref.kind !== "user" || !this.sameSender(head.sender, ref.sender)) break;
      out.push(ref);
    }
    return out;
  }

  // ───────────── 开轮 ─────────────

  /** 空闲且有排队输入时发出开轮请求（每个会话同一时间只有一个）。 */
  private pump(threadKey: ThreadKey): void {
    const s = this.threads.get(threadKey);
    if (!s || s.busy || !s.pending.length || this.starting.has(threadKey)) return;
    this.starting.add(threadKey);
    this.track(this.startNext(threadKey, s.pending[0]!.seq));
  }

  private async startNext(threadKey: ThreadKey, seq: number): Promise<void> {
    let acquired = false, used = false;
    try {
      await this.slots.acquire(seq);
      acquired = true;
      await this.serial(threadKey, async () => {
        this.starting.delete(threadKey);
        const s = await this.load(threadKey);
        // 等槽位期间后端开了唤醒回合：本轮让给它，结束后再开
        if (s.busy || !s.pending.length) return;
        const inputs = this.batch(s.pending);
        const head = inputs[0]!;
        const keys = new Set(inputs.map(i => i.inboundKey));
        const begun: ThreadHostState = {
          ...s, busy: true, turnKind: head.kind, turnSender: head.sender, turnInputs: inputs,
          pending: s.pending.filter(p => !keys.has(p.inboundKey)), mentioned: false, lastActivityAt: this.now(),
        };
        delete begun.turnId;
        // 先落盘"开轮中"：崩溃后据缺少 turnId 判定未确认，输入放回队列
        await this.save(threadKey, begun);
        used = true;
        this.holding.add(threadKey);
        let started: StartTurnResult;
        try {
          // 定时输入开轮前按创建者当前授权复核（排队期间可能已撤销或过期）；适配器内部重试前再经 ctx.admit 复核
          const admit = head.kind === "scheduled" && this.opts.admit ? () => this.opts.admit!(threadKey, head) : undefined;
          started = admit && !await admit() ? { denied: true }
            : await this.opts.adapter.startTurn(threadKey, inputs, { kind: head.kind, sender: head.sender, ...(admit ? { admit } : {}) });
        } catch (error) {
          log.warn("thread host start turn failed", { thread: threadKey, inputs: [...keys], error });
          await this.finish(threadKey, begun, "failed", error instanceof Error ? error.message : String(error));
          return;
        }
        if ("denied" in started) {
          log.warn("thread host scheduled input denied at turn start", { thread: threadKey, input: head.inboundKey });
          await this.finish(threadKey, begun, "failed", "定时任务创建者已无权限");
          return;
        }
        const cur = this.threads.get(threadKey)!;
        if ("backendTurnId" in started) {
          // 后端已有本宿主尚未确认的回合（唤醒）：按唤醒回合接管（身份为唤醒，不升级为本轮发送者），输入放回队列等它结束
          log.warn("thread host start yielded to backend turn", { thread: threadKey, turn: started.backendTurnId, inputs: [...keys] });
          const wake: ThreadHostState = {
            ...cur, turnId: started.backendTurnId, turnKind: "wake", turnInputs: [], pending: bySeq([...inputs, ...cur.pending]),
            mentioned: false, lastActivityAt: this.now(),
          };
          delete wake.turnSender;
          await this.save(threadKey, wake);
          return;
        }
        const turnId = started.turnId, accepted = started.accepted;
        // 只有后端真正收下的输入算送达；其余放回队列，本轮结束后再开轮（不能随本轮一起被标记 done）
        const delivered = accepted ? inputs.filter(i => accepted.includes(i.inboundKey)) : inputs;
        const back = inputs.filter(i => !delivered.includes(i));
        if (back.length) log.warn("thread host start accepted part of the batch", { thread: threadKey, turn: turnId, requeued: back.map(i => i.inboundKey) });
        await this.save(threadKey, { ...cur, turnId, turnInputs: delivered, pending: bySeq([...back, ...cur.pending]) },
          tx => this.markInputs(tx, threadKey, delivered, "delivered"));
        this.emit("inputsDelivered", threadKey, turnId, delivered);
      });
    } finally {
      this.starting.delete(threadKey);
      if (acquired && !used) this.slots.release();
    }
    // 开轮失败或让给唤醒回合后，队列里仍可能有输入
    this.pump(threadKey);
  }

  /** 回合结束：清空本轮、输入标记 done（同一提交记下回合结果）、归还槽位，并通知外层。 */
  private async finish(threadKey: ThreadKey, s: ThreadHostState, status: TurnStatus, error?: string): Promise<void> {
    const cur = this.threads.get(threadKey) ?? s;
    await this.save(threadKey, idleState(cur), tx => this.markInputs(tx, threadKey, s.turnInputs, "done",
      { status, ...(s.turnId ? { turnId: s.turnId } : {}) }));
    if (this.holding.delete(threadKey)) this.slots.release();
    const event: TurnEnded = {
      threadKey, kind: s.turnKind ?? "wake", inputs: s.turnInputs, status,
      ...(s.turnId ? { turnId: s.turnId } : {}), ...(s.turnSender ? { sender: s.turnSender } : {}), ...(error ? { error } : {}),
    };
    this.emit("turnEnded", event);
  }

  // ───────────── 适配器回调 ─────────────

  onTurnStarted(threadKey: ThreadKey, turnId: string, initiatedBy: "host" | "backend"): void {
    this.track(this.serial(threadKey, async () => {
      const s = await this.load(threadKey);
      if (s.busy && s.turnId === turnId) { this.touch(s); return; }
      if (initiatedBy === "host") return; // 不是本宿主当前的回合：过期事件
      if (s.busy) {
        // 没收到上一轮的结束事件就开了唤醒回合（实际只发生在会话混用后端时：codex 回合进行中出现 pi 唤醒；
        // pi 自己的唤醒 run 总在上一轮结束事件之后回报）。上一轮交给适配器放弃——其后端工作不能再以该回合的身份行事：
        // 工作被中止（codex exec）→ 按 lost 结束，外层发中断提示（§8.1，照常限频），输入不自动重放（与重启丢失一致，避免重复副作用）；
        // 工作继续（pi run 降为唤醒身份）→ 按 completed 结束。
        log.warn("thread host wake turn superseded active turn", { thread: threadKey, previous: s.turnId, turnId });
        let status: TurnStatus = "completed";
        if (s.turnId && this.opts.adapter.abandon) {
          try {
            if (await this.opts.adapter.abandon(threadKey, s.turnId) === "aborted") status = "lost";
          } catch (error) {
            log.warn("thread host abandon superseded turn failed", { thread: threadKey, turn: s.turnId, error });
          }
        }
        await this.finish(threadKey, s, status, "superseded by backend turn");
      }
      const cur = this.threads.get(threadKey)!;
      const wake: ThreadHostState = {
        ...cur, busy: true, turnId, turnKind: "wake", turnInputs: [], mentioned: false, lastActivityAt: this.now(),
      };
      delete wake.turnSender;
      await this.save(threadKey, wake);
      if (!this.holding.has(threadKey)) { this.holding.add(threadKey); this.slots.force(); }
    }));
  }

  onTurnCompleted(threadKey: ThreadKey, turnId: string, result: { status: TurnStatus; error?: string }): void {
    this.track(this.serial(threadKey, async () => {
      const s = await this.load(threadKey);
      if (!s.busy || s.turnId !== turnId) return; // 过期或重复的结束事件
      await this.finish(threadKey, s, result.status, result.error);
    }).then(() => this.pump(threadKey)));
  }

  onActivity(threadKey: ThreadKey): void {
    const s = this.threads.get(threadKey);
    if (s?.busy) this.touch(s);
  }

  /** 活动时间只在内存刷新（逐条落盘代价太高）；重启后对仍在的回合重新计时。 */
  private touch(s: ThreadHostState): void {
    s.lastActivityAt = this.now();
  }

  // ───────────── 工具与面板 ─────────────

  /** 本轮身份（§7.3）；空闲返回 undefined。开轮请求未确认时已可用（工具可能先于 startTurn 返回运行）。 */
  currentIdentity(threadKey: ThreadKey): TurnIdentity | undefined {
    const s = this.threads.get(threadKey);
    if (!s?.busy) return undefined;
    if (s.turnKind === "user" && s.turnSender) return { kind: "user", sender: s.turnSender };
    if (s.turnKind === "scheduled" && s.turnSender) return { kind: "scheduled", creator: s.turnSender };
    return { kind: "wake" };
  }

  /**
   * 群会话本轮第一条发往本群的消息 @ 发送者（§7.2）：用户回合第一次调用返回发送者，之后返回 false；
   * 定时与唤醒回合始终 false。只由"发往本群"的发送调用。
   */
  takeMention(threadKey: ThreadKey): Promise<string | false> {
    return this.serial(threadKey, async () => {
      const s = this.threads.get(threadKey);
      if (!s?.busy || s.turnKind !== "user" || s.mentioned || !s.turnSender) return false;
      await this.save(threadKey, { ...s, mentioned: true });
      return s.turnSender;
    });
  }

  /** 看门狗：进行中的回合超过阈值没有任何事件。调用方随后 interrupt 并按 §8.1 提示。 */
  stalled(now: number, thresholdMs = STALL_MS): ThreadKey[] {
    const out: ThreadKey[] = [];
    for (const [key, s] of this.threads) {
      if (s.busy && s.turnId && now - (s.lastActivityAt ?? 0) >= thresholdMs) out.push(key as ThreadKey);
    }
    return out;
  }

  /** 面板"停止"、看门狗：回合结束仍由适配器的 onTurnCompleted 驱动。 */
  interrupt(threadKey: ThreadKey): Promise<void> {
    return this.opts.adapter.interrupt(threadKey);
  }

  /** 输入的投递状态（Inbox 恢复对账用）；宿主从未收到的输入返回 undefined。 */
  async inputState(inboundKey: string): Promise<"queued" | "delivered" | "done" | undefined> {
    const doc = await this.opts.store.snapshot(HostInputDoc, inboundKey, this.ctx);
    return doc && doc.state !== "new" ? doc.state : undefined;
  }

  /** 已结束输入所在回合的结果（与 done 同一提交写入）；未结束或没有记录返回 undefined。 */
  async inputOutcome(inboundKey: string): Promise<{ status: TurnStatus; turnId?: string } | undefined> {
    const doc = await this.opts.store.snapshot(HostInputDoc, inboundKey, this.ctx);
    if (doc?.state !== "done" || !doc.status) return undefined;
    return { status: doc.status, ...(doc.turnId ? { turnId: doc.turnId } : {}) };
  }

  /** 观测用的只读副本 */
  thread(threadKey: ThreadKey): Readonly<ThreadHostState> | undefined {
    const s = this.threads.get(threadKey);
    return s && structuredClone(s);
  }

  status() {
    return {
      active: this.slots.active, waiting: this.slots.waiters.length,
      busy: [...this.threads].filter(([, s]) => s.busy).map(([key]) => key),
    };
  }

  // ───────────── 恢复 ─────────────

  /**
   * 启动时调用一次（在适配器开始回报事件之前）。
   * 仍在的回合继续占槽位并重新计时；丢失的回合以 lost 结束；未确认的开轮输入放回队列；
   * 最后按各会话队首 seq 依次请求开轮（槽位按 seq 分配，跨会话保持到达顺序）。
   */
  async recover(): Promise<void> {
    const index = await this.opts.store.snapshot(ThreadHostIndexDoc, this.ctx);
    const keys = Object.keys(index?.active ?? {}) as ThreadKey[];
    for (const key of keys) {
      await this.serial(key, async () => {
        const s = await this.load(key);
        if (!s.busy) return;
        if (!s.turnId) {
          await this.save(key, idleState(s, bySeq([...s.turnInputs, ...s.pending])));
          return;
        }
        let state: "alive" | "lost";
        try {
          state = await this.opts.adapter.recoverTurn(key, s.turnId);
        } catch (error) {
          log.warn("thread host recover turn failed, treated as lost", { thread: key, turn: s.turnId, error });
          state = "lost";
        }
        if (state === "alive") {
          this.touch(s);
          this.holding.add(key);
          this.slots.force();
          return;
        }
        await this.finish(key, s, "lost");
      });
    }
    const queued = keys.map(key => this.threads.get(key)!).filter(s => !s.busy && s.pending.length)
      .sort((a, b) => a.pending[0]!.seq - b.pending[0]!.seq);
    for (const s of queued) this.pump(s.threadKey as ThreadKey);
  }

  /** 等待所有进行中的宿主操作结束（等待槽位的开轮请求除外）；测试与关闭用。 */
  async idle(): Promise<void> {
    while (this.inflight.size > this.slots.waiters.length) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  // ───────────── 内部 ─────────────

  private async load(threadKey: string): Promise<ThreadHostState> {
    const cached = this.threads.get(threadKey);
    if (cached) return cached;
    const stored = await this.opts.store.snapshot(ThreadHostDoc, threadKey, this.ctx);
    const s: ThreadHostState = stored ? structuredClone(stored) as ThreadHostState
      : { threadKey, busy: false, turnInputs: [], pending: [], mentioned: false };
    // 串行队列保证同一会话不会并发加载；仍以已有镜像为准
    if (!this.threads.has(threadKey)) this.threads.set(threadKey, s);
    return this.threads.get(threadKey)!;
  }

  private async save(threadKey: string, next: ThreadHostState, extra?: (tx: Tx) => Promise<void>): Promise<void> {
    await this.opts.store.commit(async tx => {
      await this.write(tx, next);
      await extra?.(tx);
    }, this.ctx);
    this.threads.set(threadKey, next);
  }

  /** 整体写回会话文档，并同步恢复集合（忙或有排队才需要恢复）。 */
  private async write(tx: Tx, next: ThreadHostState): Promise<void> {
    const doc = await tx.doc(ThreadHostDoc, next.threadKey, next.threadKey);
    const value = structuredClone(next);
    for (const key of OPTIONAL) if (value[key] === undefined) { delete value[key]; delete doc[key]; }
    Object.assign(doc, value);
    const index = await tx.doc(ThreadHostIndexDoc);
    if (next.busy || next.pending.length) index.active[next.threadKey] = true;
    else delete index.active[next.threadKey];
  }

  private async markInputs(tx: Tx, threadKey: string, refs: readonly InputRef[], state: "delivered" | "done",
    outcome?: { status: TurnStatus; turnId?: string }): Promise<void> {
    for (const ref of refs) Object.assign(await tx.doc(HostInputDoc, ref.inboundKey, threadKey), { state, ...outcome });
  }

  private serial<T>(threadKey: string, work: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(threadKey) ?? Promise.resolve()).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(threadKey, tail);
    void tail.then(() => { if (this.chains.get(threadKey) === tail) this.chains.delete(threadKey); });
    return run;
  }

  private track(work: Promise<unknown>): void {
    const p: Promise<void> = work
      .then(() => undefined, error => { log.error("thread host operation failed", { error }); })
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private emit<K extends keyof ThreadHostEvents>(name: K, ...args: Parameters<NonNullable<ThreadHostEvents[K]>>): void {
    try {
      (this.opts.events?.[name] as ((...a: unknown[]) => void) | undefined)?.(...args);
    } catch (error) {
      log.warn("thread host event listener failed", { event: name, error });
    }
  }
}
