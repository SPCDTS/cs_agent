import { ownerScope } from "../shared/owners.js";
import { trace } from "../shared/trace.js";
/**
 * QQ 消息 → 规则分流 → durable 任务（设计 §4.1 / §4.7）：
 * 1. admit：createConversation(ownerless) 的同一 commit 内写入 TicketDoc（含分流结果 route/prefix/prompt）
 *    与 Session 级 DispatchDoc 条目（scope、bridge 票据 seq = admit 顺序）。
 * 2. 顺序：同一 scope 严格 FIFO——一张票据占据其 scope 队首直到终态：sent | uncertain（任务回复或兜底已发出 / 结果不确定）
 *    | failed（attempts 超过上限、兜底也发不出）；不同 scope 并行，同时运行的总数 ≤ concurrency。
 *    任务在轮到它时才创建（pi-durable 一创建就会调度）。
 * 3. 运行：按 route 创建生图任务或 agent 任务（任务 id 记入 DispatchDoc），waitForTask 等待终态。
 * 4. 任务结束而票据仍 pending（任务失败）→ 发一次兜底；兜底在发送前就失败 → 退避后在队首重试（attempts 累计落盘）。
 *    attempts 超过 MAX_ATTEMPTS → giveUp（同一队列与并发槽位）：标记 givenUp、中止任务并等待终态，再发兜底；
 *    仍发不出 → 条目标记 failed 并继续下一条。终态（sent/uncertain）才从 DispatchDoc 删除；
 *    进程退出时保留索引，重启后 recover() 把索引条目与孤儿票据按票据 seq 统一排序继续。
 * 5. 任务的外部副作用阶段（提交生图、codex 回合、回复）开始前检查票据仍 pending 且条目未 givenUp，否则以 failed 结束。
 * 6. recover() 还与 Channel 的 pending 票据对账：admit 已落盘但派发索引未写入的票据，用票据里保存的来源与原文
 *    重建消息重新派发（分页取尽全部 pending 票据）。v2 遗留条目（无任务）先中止其旧的模型会话，再按原文重新分流。
 * 7. 生图路径保留 pending/completed 历史钩子；agent 每条成功 Outbox 消息由 SendService 独立入库。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, TaskId } from "@earendil-works/pi-durable";
import type { InboundMessage, Channel, ReplyTicketRecord } from "../channel/types.js";
import { DispatchDoc, TicketDoc, type DispatchEntry } from "./docs.js";
import { type TicketSource, type TicketSettings } from "./backends/types.js";
import { log } from "../shared/log.js";
import { scopeOf } from "../context/access.js";
import type { BotAction, ContextStore } from "../context/store.js";
import { FALLBACK_REPLY } from "./replies.js";
import { DEFAULT_IMAGE_PREFIXES, routeMessage } from "./router.js";
import { inboundFromTicket, legacyRouteText } from "../channel/ticket.js";
import type { CsTasks, TaskResult } from "./tasks.js";
import { ScheduledRunDoc, type ScheduledRuntime } from "./schedule/run.js";

export { FALLBACK_REPLY } from "./replies.js";
/** 同一票据最多运行次数；达到即放弃运行，改发兜底回复 */
export const MAX_ATTEMPTS = 3;
/** 已发送正文的附件恢复最多额外运行三次，不能无限占用 FIFO。 */
export const MAX_FILE_REPLY_ATTEMPTS = MAX_ATTEMPTS + 3;
/** 启动对账时每页读取的 pending 票据数（分页直到取尽） */
const PENDING_PAGE = 200;

type DispatchBridge = Pick<Channel, "reply" | "getTicket" | "listPendingTickets" | "prepareIncoming">;
/** 统一上下文存储中派发器用到的写入口 */
export type DispatchHistory = Pick<ContextStore, "recordPending" | "completeReply">;

export interface DispatcherOptions {
  harness: Harness;
  bridge: DispatchBridge;
  tasks: CsTasks;
  concurrency: number;
  /** owner 私聊共用互斥队列，原始 scope 仍用于存储和投递。 */
  owners?: readonly string[];
  scheduled?: Pick<ScheduledRuntime, "ScheduledTask" | "finish">;
  imagePrefixes?: readonly string[];
  /** 兼容旧调用的派发默认推理强度；入队时写入快照，历史行不再现读 */
  codexEffort?: string | (() => string);
  context?: Context;
  history?: DispatchHistory;
  /** 票据仍 pending 时队首重试的退避基数（毫秒，第 n 次重试等待 n 倍），默认 5000 */
  retryDelayMs?: number;
}

/** sent/uncertain 为终态；sending 只会因发送中途崩溃而残留，Channel 不会再发送它，同样视为终态 */
const isTerminal = (status: string | undefined) => status === "sent" || status === "uncertain" || status === "sending";
const short = (t: string) => t.slice(0, 12);
const sourceScope = (s: TicketSource) => (s.type === "group" ? `group:${s.group_id}` : `private:${s.user_id}`);

export class Dispatcher {
  private active = 0;
  private readonly scopeDepth = new Map<string, number>();
  private readonly runningScopes = new Set<string>();
  status() { return { active: this.active, slots: this.opts.concurrency, waiting: [...this.scopeDepth.values()].reduce((a,b) => a+b,0) - this.active,
    scopes: Object.fromEntries([...this.scopeDepth].map(([scope,n])=>[scope, n - Number(this.runningScopes.has(scope))])),
    running_scopes: [...this.runningScopes], tickets: [...this.inflight.keys()] }; }
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  /** 每个 scope 的队尾：新消息排在它后面（FIFO） */
  private readonly chains = new Map<string, Promise<void>>();
  /** 定时条目需异步读取 scope；仅串行化入队动作，执行仍按 scope 并行。 */
  private admissionTail = Promise.resolve();
  private readonly ctx: Context;
  private readonly prefixes: readonly string[];
  /** recover() 时打了中止标记的上次活任务：轮到其票据时先等它结束，再新建任务 */
  private readonly abortedAtRecovery = new Set<number>();

  constructor(private readonly opts: DispatcherOptions) {
    this.ctx = opts.context ?? BACKGROUND_CONTEXT;
    this.prefixes = opts.imagePrefixes ?? DEFAULT_IMAGE_PREFIXES;
  }

  /** 收到授权消息：立即持久化，按 scope 排队执行；同一 ticket 重复投递时复用。 */
  dispatch(msg: InboundMessage, ticket: string): Promise<void> {
    if (this.inflight.has(ticket)) return this.inflight.get(ticket)!;
    const scope = scopeOf(msg);
    const settings = this.opts.tasks.snapshotSettings(scope, typeof this.opts.codexEffort === "function" ? this.opts.codexEffort() : this.opts.codexEffort, this.effortMessage(msg, ticket));
    if (routeMessage(msg.route_text, this.prefixes, msg.images).route !== "agent") this.withHistory("record pending failed", ticket, (h) =>
      h.recordPending(scope, ticket, msg.time, { replyTo: msg.message_id, selfId: msg.self_id }),
    );
    return this.track(ticket, "dispatch failed", () => {
      const registered = this.opts.bridge.prepareIncoming
        ? this.opts.bridge.prepareIncoming(ticket).then(async rec => this.register(msg.attachments?.some(a => a.status === 'pending') && rec ? inboundFromTicket(rec) : msg, ticket, scope, false, await settings))
        : settings.then(value => this.register(msg, ticket, scope, false, value));
      return this.inAdmissionOrder(() => ({ done: this.enqueue(scope, async () => this.run(ticket, await registered)) }));
    });
  }

  /** 排程事务提交后唤醒已登记的运行，与消息共用 scope 队列和并发槽位。 */
  dispatchScheduled(ticket: string): Promise<void> {
    return this.track(ticket, "scheduled dispatch failed", () => this.inAdmissionOrder(async () => {
      const entry = (await this.opts.harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
      if (!entry) return { done: Promise.resolve() };
      if (entry.kind !== "scheduled" || !entry.scope || !this.opts.scheduled) throw new Error("定时执行器未绑定或派发条目无效");
      trace.event(ticket, "admitted", { scope: entry.scope, detail: { kind: "scheduled", conversation: entry.conversationId } });
      return { done: this.enqueue(await this.queueScope(entry, entry.scope), () => this.run(ticket, entry.conversationId as ConversationId)) };
    }));
  }

  /**
   * 启动时：DispatchDoc 中未完成的票据（attempts 达上限的直接兜底）与 Channel 中没有索引的 pending 票据（分页取尽）
   * 按票据 seq（bridge admit 顺序）统一排序后依次入队。返回处理的票据数。
   */
  async recover(): Promise<number> {
    const state = await this.opts.harness.snapshot(DispatchDoc, this.ctx);
    const indexed = state?.pending ?? {};
    type Item =
      | { kind: "indexed"; ticket: string; key: number; tie: number; entry: DispatchEntry }
      | { kind: "orphan"; ticket: string; key: number; tie: number; rec: ReplyTicketRecord };
    const items: Item[] = [];
    let failed = 0;
    for (const [ticket, entry] of Object.entries(indexed)) {
      if (this.inflight.has(ticket)) continue;
      if (entry.state === "failed") {
        await this.cleanupTicket(ticket);
        failed++; // 已终态（兜底也发不出）：不再处理，留作审计
        continue;
      }
      // pi-durable 一开启调度就会继续上次的活任务，绕过 scope FIFO：先给它们打中止标记（此时尚未调度），
      // 轮到该票据时等它以 aborted 结束，再新建任务（新任务跳过 TicketDoc 中已完成的阶段）。
      if (entry.taskId !== undefined) {
        try {
          if ((await this.opts.harness.abortTask(entry.taskId as TaskId, this.ctx)) === "marked") {
            this.abortedAtRecovery.add(entry.taskId);
          }
        } catch (err) {
          log.warn("abort live task at recovery failed", { ticket: short(ticket), task: entry.taskId, error: err });
        }
      }
      // 旧条目（本字段加入前写入）没有 ticketSeq：从票据表取；取不到时排在最后（同组内按旧的派发序号）
      const key = entry.ticketSeq ?? (await this.opts.bridge.getTicket(ticket).catch(() => undefined))?.seq ?? Number.MAX_SAFE_INTEGER;
      items.push({ kind: "indexed", ticket, key, tie: entry.seq ?? 0, entry });
    }
    let orphanCount = 0;
    try {
      // 分页取尽全部 pending 票据（游标 = 上一页最后一条的 seq）
      for (let after = 0; ; ) {
        const page = await this.opts.bridge.listPendingTickets(PENDING_PAGE, after);
        for (const rec of page) {
          if (indexed[rec.ticket_id] || this.inflight.has(rec.ticket_id)) continue;
          items.push({ kind: "orphan", ticket: rec.ticket_id, key: rec.seq, tie: 0, rec });
          orphanCount++;
        }
        if (page.length < PENDING_PAGE) break;
        const last = page[page.length - 1]!.seq;
        if (!(last > after)) break; // 防御：游标不前进时停止
        after = last;
      }
    } catch (err) {
      log.error("list pending tickets failed", { error: err });
    }
    // 索引中的票据与孤儿票据按 bridge admit 顺序（seq）统一排序后依次入队：scope 内 FIFO 由入队顺序保证
    items.sort((a, b) => a.key - b.key || a.tie - b.tie);

    let count = 0;
    for (const item of items) {
      count++;
      const { ticket } = item;
      if (item.kind === "indexed") {
        const entry = item.entry;
        // 达到上限的条目同样入队：run() 在队首走 giveUp（中止活任务 → 兜底），不在队外插队
        const scope = entry.scope ?? (await this.legacyScope(ticket, entry));
        const doc = await this.opts.harness.snapshot(TicketDoc, entry.conversationId as ConversationId, this.ctx).catch(() => undefined);
        trace.event(ticket, "recovered", { scope, detail: { kind: item.kind, text: doc?.text, route: doc?.route, sender: doc?.source.nickname } });
        const queueScope = await this.queueScope(entry, scope);
        void this.track(ticket, "recover failed", () =>
          this.inAdmissionOrder(() => ({ done: this.enqueue(queueScope, () => this.run(ticket, entry.conversationId as ConversationId)) })),
        );
        continue;
      }
      const rec = item.rec;
      if (rec.origin === "scheduled") {
        // SQLite 开票后、排程提交前崩溃：没有 durable 触发快照，禁止重建成入站消息。
        await this.opts.tasks.sendService.reconcile(ticket);
        await this.opts.tasks.sendService.settle(ticket);
        trace.event(ticket, "recovered", { detail: { terminal: true, reason: "scheduled_orphan", status: "interrupted" } });
        continue;
      }
      trace.event(ticket, "recovered", { scope: rec.message_type === "group" ? `group:${rec.group_id}` : `private:${rec.user_id}`, detail: { kind: item.kind } });
      if (!rec.source_text.trim()) {
        // 原文缺失也持久化派发条目；兜底未终态前一直占据 scope 队首。
        log.warn("orphan ticket without source text, registering fallback", { ticket: short(rec.ticket_id) });
        const scope = rec.message_type === "group" ? `group:${rec.group_id}` : `private:${rec.user_id}`;
        void this.track(ticket, "orphan fallback failed", () => {
          const registered = this.register(inboundFromTicket(rec), ticket, scope, true);
          return this.inAdmissionOrder(() => ({ done: this.enqueue(scope, async () => this.run(ticket, await registered)) }));
        });
      } else {
        log.warn("orphan pending ticket without dispatch index, re-dispatching", { ticket: short(rec.ticket_id) });
        void this.dispatch(inboundFromTicket(rec), rec.ticket_id);
      }
    }
    if (count || failed) log.info("recovering pending tickets", { indexed: count - orphanCount, orphans: orphanCount, failed_kept: failed });
    return count;
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  /** v2 遗留条目：先中止旧的模型会话（其工具已不存在），scope 取自票据文档。 */
  private async legacyScope(ticket: string, entry: DispatchEntry): Promise<string> {
    const id = entry.conversationId as ConversationId;
    if (entry.taskId === undefined) {
      try {
        const conv = await this.opts.harness.conversation(id, this.ctx);
        await conv?.abort(this.ctx);
        log.info("aborted legacy v2 conversation before re-running the ticket", { ticket: short(ticket), conversation: id });
      } catch (err) {
        log.warn("abort legacy conversation failed", { ticket: short(ticket), error: err });
      }
    }
    const doc = await this.opts.harness.snapshot(TicketDoc, id, this.ctx).catch(() => undefined);
    return doc?.source?.user_id ? sourceScope(doc.source) : `legacy:${ticket}`;
  }

  private track(ticket: string, label: string, work: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(ticket);
    if (existing) return existing;
    const p = work()
      .catch((err) => { trace.event(ticket, "failed", { status: "failed", detail: { error: err, terminal: false, recoverable: true } }); log.error(label, { ticket: short(ticket), error: err }); })
      .finally(() => this.inflight.delete(ticket));
    this.inflight.set(ticket, p);
    return p;
  }

  private inAdmissionOrder(work: () => { done: Promise<void> } | Promise<{ done: Promise<void> }>): Promise<void> {
    const admitted = this.admissionTail.then(work);
    this.admissionTail = admitted.then(() => undefined, () => undefined);
    return admitted.then(({ done }) => done);
  }

  private async queueScope(entry: DispatchEntry, scope: string): Promise<string> {
    if (entry.kind !== "scheduled") return scope;
    const run = await this.opts.harness.snapshot(ScheduledRunDoc, entry.conversationId as ConversationId, this.ctx);
    // 已开票的目标被冻结；即使重启后更换主账号，owner 定时回合仍需占用共享队列。
    return run?.conversation === "owner" ? "owner" : scope;
  }

  /** 排到 scope 队尾；轮到时再占用一个全局并发槽位。 */
  private enqueue(scope: string, work: () => Promise<void>): Promise<void> {
    // 所有入队入口（普通消息、定时任务、索引恢复和孤儿票据）在此统一映射。
    scope = ownerScope(this.opts.owners, scope);
    this.scopeDepth.set(scope, (this.scopeDepth.get(scope) ?? 0) + 1);
    const prev = this.chains.get(scope) ?? Promise.resolve();
    const run = prev.then(() => this.withSlot(async () => {
      this.runningScopes.add(scope);
      try { await work(); } finally { this.runningScopes.delete(scope); }
    }));
    const tail = run.catch(() => undefined);
    this.chains.set(scope, tail);
    void tail.then(() => {
      const depth = (this.scopeDepth.get(scope) ?? 1) - 1;
      if (depth) this.scopeDepth.set(scope, depth); else this.scopeDepth.delete(scope);
      if (this.chains.get(scope) === tail) this.chains.delete(scope);
    });
    return run;
  }

  private async withSlot(work: () => Promise<void>): Promise<void> {
    await this.acquire();
    try {
      await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.opts.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private effortMessage(msg: InboundMessage, ticket: string) {
    return { ticket, text: msg.text, hasImages: msg.images.length > 0 || msg.segments.some(s => s.type === "image"),
      hasQuote: msg.segments.some(s => s.type === "reply") };
  }

  private async register(msg: InboundMessage, ticket: string, scope: string, fallbackOnly = false, settings?: TicketSettings): Promise<ConversationId> {
    const { harness } = this.opts;
    const known = (await harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
    if (known) return known.conversationId as ConversationId;
    const source: TicketSource = {
      type: msg.message_type,
      user_id: msg.user_id,
      group_id: msg.group_id,
      ...(msg.group_name ? { group_name: msg.group_name } : {}),
      nickname: msg.nickname,
    };
    const reply = msg.segments.find((s) => s.type === "reply") as { data: { id?: string } } | undefined;
    const route = routeMessage(msg.route_text, this.prefixes, msg.images);
    // 唯一排序键：bridge admit 时分配的票据 seq（崩溃恢复时与孤儿票据统一排序）
    const ticketSeq = (await this.opts.bridge.getTicket(ticket).catch(() => undefined))?.seq;
    settings ??= await this.opts.tasks.snapshotSettings(scope, undefined, this.effortMessage(msg, ticket));
    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: async (tx, conversationId) => {
          Object.assign(await tx.doc(TicketDoc, conversationId), {
            ticket, source, text: msg.text, time: msg.time, messageId: msg.message_id,
            settings,
            source_images: msg.images, ...(msg.image_error ? { image_error: msg.image_error } : {}),
            route: route.route,
            ...(route.route !== "agent" ? { prefix: route.prefix } : {}),
            ...(route.route === "image" ? { prompt: route.prompt, imageOptions: route.options } : {}),
            ...(reply?.data.id ? { replyTo: reply.data.id } : {}),
          });
          const dispatch = await tx.doc(DispatchDoc);
          dispatch.pending[ticket] = { conversationId, scope, attempts: 0, ...(fallbackOnly ? { fallbackOnly } : {}), ...(ticketSeq !== undefined ? { ticketSeq } : {}) };
        },
      },
      this.ctx,
    );
    // 派发设置快照进观测，票据页据此显示后端 · 模型 · 档位（来源）。
    trace.event(ticket, "admitted", { scope, detail: { conversation: conv.id, settings } });
    trace.event(ticket, "routed", { scope, detail: route });
    log.info("message routed", {
      ticket: short(ticket),
      conversation: conv.id,
      scope,
      route: route.route,
      ...(route.route !== "agent" ? { prefix: route.prefix } : {}),
    });
    return conv.id;
  }

  /**
   * 票据当前的任务：DispatchDoc 记录的任务仍在运行则沿用（重启后继续），否则按 route 新建
   * （上一个任务已失败时也新建：新任务会跳过 TicketDoc 中已有结果的阶段）。条目已删除时返回 undefined。
   */
  private async ensureTask(ticket: string): Promise<TaskId<TaskResult> | undefined> {
    const { ImageTask, AgentTask } = this.opts.tasks;
    const known = (await this.opts.harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket]?.taskId;
    if (known !== undefined && this.abortedAtRecovery.has(known)) {
      await this.opts.harness.waitForTask(known as TaskId, this.ctx);
      this.abortedAtRecovery.delete(known);
    }
    return this.opts.harness.commit(async (tx) => {
      const entry = (await tx.doc(DispatchDoc)).pending[ticket];
      if (!entry || entry.fallbackOnly) return undefined;
      if (entry.taskId !== undefined) {
        const rec = await tx.task(entry.taskId as TaskId);
        if (rec && rec.state.status !== "terminal") return rec.id as TaskId<TaskResult>;
      }
      const conversationId = entry.conversationId as ConversationId;
      const doc = await tx.doc(TicketDoc, conversationId);
      if (!doc.route) {
        // v2 遗留票据：按原文重新分流
        const r = routeMessage(legacyRouteText(doc.text), this.prefixes, doc.source_images);
        doc.route = r.route;
        if (r.route !== "agent") doc.prefix = r.prefix;
        if (r.route === "image") { doc.prompt = r.prompt; doc.imageOptions = r.options; }
      }
      // 旧票据没有快照，无法重建历史设置；固定兼容值并持久化，恢复不读取热设置。
      doc.settings ??= { backend: doc.agentResult?.backend === "pi" ? "pi" : "codex", codexReasoningEffort: "high" };
      const options = { ownership: { kind: "conversation" }, conversationId } as const;
      if (entry.kind === "scheduled" && !this.opts.scheduled) throw new Error("定时执行器未绑定");
      const id =
        entry.kind === "scheduled" ? await tx.createTask(this.opts.scheduled!.ScheduledTask, { ticket }, options) :
        doc.route === "agent"
          ? await tx.createTask(AgentTask, { ticket }, options)
          : await tx.createTask(ImageTask, { ticket }, options);
      entry.taskId = id as number;
      return id;
    }, this.ctx);
  }

  /**
   * 在 scope 队首处理一张票据，直到它进入终态才返回（之后同 scope 的下一条才开始）：
   * - sent / uncertain：任务发出回复，或任务失败后兜底回复已发出 / 结果不确定 → 清除索引；
   * - failed：attempts 超过上限（giveUp：中止活任务、发兜底），兜底仍发不出（bridge 不可用）→ 条目标记 failed，不再阻塞 scope。
   * 每次尝试开始时 attempts +1（落盘）；票据仍 pending 时退避后在队首重试。harness 关闭（进程退出）时 attempts 提交失败、
   * 直接抛出并保留索引，重启后 recover() 继续。
   */
  private async hasUnfinishedFileReply(ticket: string, conversationId: ConversationId): Promise<boolean> {
    const doc = await this.opts.harness.snapshot(TicketDoc, conversationId, this.ctx);
    return doc?.route === "agent" && doc.replyCompleted !== true &&
      ((await this.opts.bridge.getTicket(ticket))?.status === "sent" ||
        this.opts.tasks.sendService.rows(ticket).some(row => row.status === "sent" && row.files.some(file => file.status === "pending")));
  }

  private async run(ticket: string, conversationId: ConversationId): Promise<void> {
    for (let local = 0; ; local++) {
      const entry = await this.opts.harness.commit(async (tx) => {
        const e = (await tx.doc(DispatchDoc)).pending[ticket];
        if (!e || e.state === "failed") return undefined;
        e.attempts = (e.attempts ?? 0) + 1;
        return { attempts: e.attempts, givenUp: e.givenUp === true };
      }, this.ctx);
      if (!entry) return; // 索引已清除（其他路径已完成）或已标记 failed
      if (entry.givenUp || entry.attempts > MAX_FILE_REPLY_ATTEMPTS ||
          (entry.attempts > MAX_ATTEMPTS && !await this.hasUnfinishedFileReply(ticket, conversationId))) {
        log.warn("ticket reached max attempts, giving up", { ticket: short(ticket), attempts: entry.attempts - 1 });
        await this.giveUp(ticket);
        return;
      }
      if (local > 0) await new Promise((r) => setTimeout(r, (this.opts.retryDelayMs ?? 5000) * local));
      try {
        if ((await this.attempt(ticket, conversationId, entry.attempts)) !== "pending") {
          await this.clearIndex(ticket);
          return;
        }
        log.warn("ticket still pending after attempt; retrying at the head of its scope", { ticket: short(ticket), attempts: entry.attempts });
      } catch (err) {
        // 基础设施错误：下一轮的 attempts 提交若也失败（harness 已关闭）则抛出、保留索引
        log.warn("ticket attempt failed", { ticket: short(ticket), attempts: entry.attempts, error: err });
      }
    }
  }

  /** 一次尝试：运行（或继续）任务并等待终态，票据仍 pending 时发一次兜底。返回 fallbackIfUnreplied 的结果。 */
  private async attempt(ticket: string, conversationId: ConversationId, attempts: number): Promise<"terminal" | "fallback" | "pending"> {
    const scheduled = (await this.opts.harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket]?.kind === "scheduled";
    if (scheduled && (await this.opts.harness.snapshot(TicketDoc, conversationId, this.ctx))?.replyCompleted) return "terminal";
    // 已回复过的票据（重复投递）：不再运行任务
    const pre = await this.opts.bridge.getTicket(ticket).catch(() => undefined);
    if (!scheduled && (pre === null || (isTerminal(pre?.status) && !await this.hasUnfinishedFileReply(ticket, conversationId)))) {
      if (pre) await this.recordOutcome(ticket, conversationId);
      log.info("ticket already terminal, skipping", { ticket: short(ticket), status: pre?.status ?? "missing" });
      return "terminal";
    }
    trace.event(ticket, "dispatched", { detail: { attempts } });
    const taskId = await this.ensureTask(ticket);
    if (taskId !== undefined) {
      const settled = await this.opts.harness.waitForTask(taskId, this.ctx);
      const outcome = settled.state.outcome;
      log.info("ticket task settled", {
        ticket: short(ticket),
        task: settled.kind,
        status: outcome.status,
        attempts,
        ...(outcome.status === "failed" || outcome.status === "faulted" ? { error: outcome.error.message } : {}),
      });
    }
    if (scheduled) {
      return (await this.opts.harness.snapshot(TicketDoc, conversationId, this.ctx))?.replyCompleted ? "terminal" : "pending";
    }
    // 文件回复尚未提交终态时保留索引；尤其不能因文字 sent 提前删除 manifest。
    if (await this.hasUnfinishedFileReply(ticket, conversationId)) return "pending";
    const outcome = await this.fallbackIfUnreplied(ticket);
    if (outcome === "terminal") await this.recordOutcome(ticket, conversationId);
    return outcome;
  }

  /**
   * 放弃运行（在该票据的 scope 队首、占用并发槽位执行，与正常运行同一路径）：
   * 1. 条目标记 givenUp（任务的每个外部副作用阶段先检查它，标记后不再产生副作用）；
   * 2. 经 harness 中止票据的任务并等待其终态；
   * 3. 发兜底回复。兜底仍发不出（bridge 不可用）→ 条目标记 failed（保留在索引里，重启对账不会把它当孤儿重跑），继续下一条。
   */
  private async giveUp(ticket: string): Promise<void> {
    const { harness } = this.opts;
    const taskId = await harness.commit(async (tx) => {
      const e = (await tx.doc(DispatchDoc)).pending[ticket];
      if (!e) return null;
      e.givenUp = true;
      return e.taskId ?? undefined;
    }, this.ctx);
    if (taskId === null) return;
    if (taskId !== undefined) {
      try {
        await harness.abortTask(taskId as TaskId, this.ctx);
        const settled = await harness.waitForTask(taskId as TaskId, this.ctx);
        this.abortedAtRecovery.delete(taskId);
        log.info("ticket task aborted before fallback", { ticket: short(ticket), task: taskId, status: settled.state.outcome.status });
      } catch (err) {
        // 无法确认任务已终态：不发兜底（条目保留 givenUp，下次再走 giveUp）
        log.warn("abort task before fallback failed; fallback deferred", { ticket: short(ticket), task: taskId, error: err });
        throw err;
      }
    }
    const entry = (await harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
    if (entry?.kind === "scheduled") {
      if (!this.opts.scheduled) throw new Error("定时执行器未绑定");
      await this.opts.scheduled.finish(harness, entry.conversationId as ConversationId, this.ctx, Date.now(), true);
      await this.clearIndex(ticket);
      return;
    }
    const fallback = await this.fallbackIfUnreplied(ticket);
    if (fallback !== "pending") {
      if (fallback === "terminal") {
        const entry = (await harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
        if (entry) await this.recordOutcome(ticket, entry.conversationId as ConversationId);
      }
      await this.clearIndex(ticket);
      return;
    }
    trace.event(ticket, "failed", { status: "failed", detail: { terminal: true, reason: "max_attempts" } });
    log.error("ticket failed: fallback could not be sent after max attempts; moving on", { ticket: short(ticket) });
    await harness.commit(async (tx) => {
      const e = (await tx.doc(DispatchDoc)).pending[ticket];
      if (e) e.state = "failed";
    }, this.ctx);
    await this.cleanupTicket(ticket);
    this.withHistory("record failure failed", ticket, (h) =>
      h.completeReply(ticket, { action: "fallback", excerpt: "", status: "失败" }),
    );
  }

  private withHistory(label: string, ticket: string, fn: (h: DispatchHistory) => unknown): void {
    if (!this.opts.history) return;
    try {
      fn(this.opts.history);
    } catch (err) {
      log.warn(label, { ticket: short(ticket), error: err });
    }
  }

  /** 票据已终态（非本次兜底）：按会话文档更新消息库中的机器人行。 */
  private async recordOutcome(ticket: string, conversationId: ConversationId): Promise<void> {
    try {
      const doc = await this.opts.harness.snapshot(TicketDoc, conversationId, this.ctx);
      const rec = await this.opts.bridge.getTicket(ticket);
      if (doc?.route === "agent") await this.opts.tasks.sendService.reconcile(ticket);
      let action: BotAction = "reply";
      let detail: string | undefined;
      let ok = true;
      if (doc?.route === "image") {
        action = "generate_image";
        detail = doc.prompt;
        ok = doc.imageResult?.ok === true;
      } else if (doc?.route === "agent") {
        ok = doc.agentResult?.ok === true;
        if (doc.settings?.backend === "codex") {
          action = "ask_codex";
          detail = doc.settings?.codexReasoningEffort;
        }
      }
      trace.event(ticket, rec?.status === "sent" && ok ? "reply_sent" : "failed", { status: rec?.status === "sent" && ok ? "ok" : "failed",
        detail: { terminal: true, ticket_status: rec?.status, route: doc?.route, backend: doc?.agentResult?.backend,
          failure: doc?.agentResult && !doc.agentResult.ok ? doc.agentResult.failure : doc?.imageResult && !doc.imageResult.ok ? doc.imageResult.failure : undefined,
          message_id: rec?.reply_message_id, reply: doc?.replyText, images: doc?.replyImages,
          files: doc?.fileUploads?.map(({ name, bytes, status }) => ({ name, bytes, status })) } });
      if (doc?.route !== "agent") this.withHistory("record reply failed", ticket, (h) =>
        h.completeReply(ticket, {
          action,
          ...(detail ? { detail } : {}),
          excerpt: doc?.replyText ?? "",
          image_count: doc?.replyImages ?? 0,
          status: rec?.status === "sent" && ok ? "已回复" : "失败",
          ...(rec?.reply_message_id ? { reply_message_id: rec.reply_message_id } : {}),
        }),
      );
    } catch (err) {
      log.warn("record reply failed", { ticket: short(ticket), error: err });
    }
  }

  private recordFallback(ticket: string, replyMessageId?: string, outbox = false): void {
    trace.event(ticket, "fallback", { status: "failed", detail: { terminal: true, message_id: replyMessageId, reply: FALLBACK_REPLY } });
    if (!outbox) this.withHistory("record fallback failed", ticket, (h) =>
      h.completeReply(ticket, {
        action: "fallback",
        excerpt: FALLBACK_REPLY,
        status: "失败",
        ...(replyMessageId ? { reply_message_id: replyMessageId } : {}),
      }),
    );
  }

  private async cleanupTicket(ticket: string): Promise<void> {
    const entry = (await this.opts.harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
    const doc = entry ? await this.opts.harness.snapshot(TicketDoc, entry.conversationId as ConversationId, this.ctx) : undefined;
    await this.opts.tasks.cleanupTicketWorkdir(ticket, doc?.remoteUploads);
    if (entry && doc?.remoteUploads?.length) await this.opts.harness.commit(async tx => {
      (await tx.doc(TicketDoc, entry.conversationId as ConversationId)).remoteUploads = [];
    }, this.ctx);
  }

  private async clearIndex(ticket: string): Promise<void> {
    // 先清理再删索引：发送已成功、但 reply 阶段清理前崩溃的票据也会走到这里。
    await this.cleanupTicket(ticket);
    await this.opts.harness
      .commit(async (tx) => {
        delete (await tx.doc(DispatchDoc)).pending[ticket];
      }, this.ctx)
      .catch((err) => log.warn("dispatch cleanup failed", { error: err }));
  }

  /**
   * 票据仍 pending 时发一次兜底回复。返回 "terminal"（此前已终态）/ "fallback"（本次兜底后终态）/
   * "pending"（读不到票据、或兜底在发送前就失败）——只有非 pending 才允许清除派发索引。
   */
  private async fallbackIfUnreplied(ticket: string): Promise<"terminal" | "fallback" | "pending"> {
    const rec = await this.opts.bridge.getTicket(ticket).catch((err: unknown) => {
      log.error("get ticket failed", { ticket: short(ticket), error: err });
      return undefined;
    });
    if (rec === undefined) return "pending";
    if (rec === null) return "terminal"; // 票据不存在：没有可回复的目标，不再保留索引
    if (rec.origin === "scheduled") return "pending"; // 定时回合只能经 recordRun 结算，绝不发兜底。
    if (isTerminal(rec.status)) return "terminal";
    const entry = (await this.opts.harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
    const doc = entry ? await this.opts.harness.snapshot(TicketDoc, entry.conversationId as ConversationId, this.ctx) : undefined;
    if (doc?.route === "agent" || entry?.fallbackOnly) {
      const service = this.opts.tasks.sendService;
      try {
        await service.reconcile(ticket);
        if (service.rows(ticket).some(row => row.status !== "pending")) {
          await service.settle(ticket); return "terminal";
        }
        await service.system(ticket, "fallback", FALLBACK_REPLY, [], undefined, doc?.agentResult?.ok === true);
        await service.settle(ticket);
        this.recordFallback(ticket, service.rows(ticket).find(row => row.status === "sent")?.message_id ?? undefined, true);
        return "fallback";
      } catch (error) {
        if (service.rows(ticket).some(row => row.status !== "pending")) {
          await service.settle(ticket); return "terminal";
        }
        log.error("outbox fallback failed", { ticket: short(ticket), error }); return "pending";
      }
    }
    try {
      const sent = await this.opts.bridge.reply(ticket, FALLBACK_REPLY);
      log.warn("fallback reply sent", { ticket: short(ticket) });
      this.recordFallback(ticket, sent.message_id);
      return "fallback";
    } catch (err) {
      log.error("fallback reply failed", { ticket: short(ticket), error: err });
      const after = await this.opts.bridge.getTicket(ticket).catch(() => undefined);
      if (!isTerminal(after?.status)) return "pending";
      this.recordFallback(ticket);
      return "fallback";
    }
  }
}
