/**
 * QQ 消息 → 规则分流 → durable 任务（设计 §4.1 / §4.7）：
 * 1. admit：createConversation(ownerless) 的同一 commit 内写入 TicketDoc（含分流结果 route/prefix/prompt）
 *    与 Session 级 DispatchDoc 条目（scope、递增 seq）。
 * 2. 顺序：同一 scope 严格 FIFO（上一条处理完、回复发出后才开始下一条），不同 scope 并行，
 *    同时运行的总数 ≤ concurrency。任务在轮到它时才创建（pi-durable 一创建就会调度）。
 * 3. 运行：按 route 创建生图任务或 agent 任务（任务 id 记入 DispatchDoc），waitForTask 等待终态。
 * 4. 只有票据进入终态（sent/uncertain，含兜底回复已发出）才从 DispatchDoc 删除；基础设施错误时保留索引，
 *    attempts 累计，重启后 recover() 按 seq 顺序继续（仍受 scope FIFO 与并发上限约束）；
 *    attempts ≥ MAX_ATTEMPTS 时直接发兜底回复并清除。
 * 5. 任务结束而票据仍 pending（任务失败）→ 发一次兜底回复。
 * 6. recover() 还与 QQBridge 的 pending 票据对账：admit 已落盘但派发索引未写入的票据，用票据里保存的来源与原文
 *    重建消息重新派发。v2 遗留条目（无任务）先中止其旧的模型会话，再按原文重新分流。
 * 7. 统一上下文（可选 history）：收到消息即写入机器人"处理中"行；终态后按 TicketDoc 更新为"已回复"/"失败"。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, TaskId } from "@earendil-works/pi-durable";
import type { InboundMessage, QQBridge, ReplyTicketRecord } from "../qq/types.js";
import { DispatchDoc, TicketDoc, type DispatchEntry, type TicketSource } from "./docs.js";
import { log } from "../log.js";
import { scopeOf } from "../context/access.js";
import type { BotAction, ContextStore } from "../context/store.js";
import { FALLBACK_REPLY } from "./replies.js";
import { DEFAULT_IMAGE_PREFIXES, legacyRouteText, routeMessage } from "./router.js";
import type { CsTasks, TaskResult } from "./tasks.js";

export { FALLBACK_REPLY } from "./replies.js";
/** 同一票据最多运行次数；达到即放弃运行，改发兜底回复 */
export const MAX_ATTEMPTS = 3;

export type DispatchBridge = Pick<QQBridge, "reply" | "getTicket" | "listPendingTickets">;
/** 统一上下文存储中派发器用到的写入口 */
export type DispatchHistory = Pick<ContextStore, "recordPending" | "completeReply">;

export interface DispatcherOptions {
  harness: Harness;
  bridge: DispatchBridge;
  tasks: CsTasks;
  concurrency: number;
  imagePrefixes?: readonly string[];
  /** 写入消息库机器人行的 codex 推理强度（CODEX_REASONING_EFFORT） */
  codexEffort?: string;
  context?: Context;
  history?: DispatchHistory;
}

/** 从持久化票据重建入站消息（仅用于崩溃对账；段信息不保存，置空）。 */
export function inboundFromTicket(rec: ReplyTicketRecord): InboundMessage {
  return {
    message_id: rec.source_message_id,
    time: Math.floor(Date.parse(rec.created_at) / 1000) || 0,
    message_type: rec.message_type,
    user_id: rec.user_id,
    group_id: rec.group_id,
    self_id: rec.self_id,
    nickname: rec.source_nickname,
    text: rec.source_text,
    // 旧行没有保存分流文本：按旧规则从渲染文本推导（仅限迁移前的票据）
    route_text: rec.source_route_text ?? legacyRouteText(rec.source_text),
    truncated: false,
    mentioned_self: rec.message_type === "group",
    segments: [],
  };
}

/** sent/uncertain 为终态；sending 只会因发送中途崩溃而残留，QQBridge 不会再发送它，同样视为终态 */
const isTerminal = (status: string | undefined) => status === "sent" || status === "uncertain" || status === "sending";
const short = (t: string) => t.slice(0, 12);
const sourceScope = (s: TicketSource) => (s.type === "group" ? `group:${s.group_id}` : `private:${s.user_id}`);

export class Dispatcher {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  /** 每个 scope 的队尾：新消息排在它后面（FIFO） */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly ctx: Context;
  private readonly prefixes: readonly string[];

  constructor(private readonly opts: DispatcherOptions) {
    this.ctx = opts.context ?? BACKGROUND_CONTEXT;
    this.prefixes = opts.imagePrefixes ?? DEFAULT_IMAGE_PREFIXES;
  }

  /** 收到授权消息：立即持久化，按 scope 排队执行；同一 ticket 重复投递时复用。 */
  dispatch(msg: InboundMessage, ticket: string): Promise<void> {
    const scope = scopeOf(msg);
    this.withHistory("record pending failed", ticket, (h) =>
      h.recordPending(scope, ticket, msg.time, { replyTo: msg.message_id, selfId: msg.self_id }),
    );
    return this.track(ticket, "dispatch failed", () => {
      const registered = this.register(msg, ticket, scope);
      return this.enqueue(scope, async () => this.run(ticket, await registered));
    });
  }

  /**
   * 启动时：按 seq 顺序继续 DispatchDoc 中所有未完成的票据（attempts 达上限的直接兜底），
   * 再与 QQBridge 的 pending 票据对账，补派发没有索引的票据。返回处理的票据数。
   */
  async recover(): Promise<number> {
    const state = await this.opts.harness.snapshot(DispatchDoc, this.ctx);
    const indexed = state?.pending ?? {};
    const entries = Object.entries(indexed).sort(([, a], [, b]) => (a.seq ?? -1) - (b.seq ?? -1));
    let count = 0;
    for (const [ticket, entry] of entries) {
      if (this.inflight.has(ticket)) continue;
      count++;
      if ((entry.attempts ?? 0) >= MAX_ATTEMPTS) {
        log.warn("ticket exceeded max attempts, giving up", { ticket: short(ticket), attempts: entry.attempts });
        void this.track(ticket, "give-up failed", () => this.giveUp(ticket));
        continue;
      }
      const scope = entry.scope ?? (await this.legacyScope(ticket, entry));
      void this.track(ticket, "recover failed", () =>
        this.enqueue(scope, () => this.run(ticket, entry.conversationId as ConversationId)),
      );
    }

    let orphans: ReplyTicketRecord[] = [];
    try {
      orphans = (await this.opts.bridge.listPendingTickets()).filter(
        (r) => !indexed[r.ticket_id] && !this.inflight.has(r.ticket_id),
      );
    } catch (err) {
      log.error("list pending tickets failed", { error: err });
    }
    for (const rec of orphans) {
      count++;
      if (!rec.source_text.trim()) {
        // 迁移前的旧票据没有保存原文，无法重建：只发兜底回复
        log.warn("orphan ticket without source text, sending fallback", { ticket: short(rec.ticket_id) });
        void this.track(rec.ticket_id, "orphan fallback failed", async () => {
          await this.fallbackIfUnreplied(rec.ticket_id);
        });
      } else {
        log.warn("orphan pending ticket without dispatch index, re-dispatching", { ticket: short(rec.ticket_id) });
        void this.dispatch(inboundFromTicket(rec), rec.ticket_id);
      }
    }
    if (count) log.info("recovering pending tickets", { indexed: entries.length, orphans: orphans.length });
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
      .catch((err) => log.error(label, { ticket: short(ticket), error: err }))
      .finally(() => this.inflight.delete(ticket));
    this.inflight.set(ticket, p);
    return p;
  }

  /** 排到 scope 队尾；轮到时再占用一个全局并发槽位。 */
  private enqueue(scope: string, work: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(scope) ?? Promise.resolve();
    const run = prev.then(() => this.withSlot(work));
    const tail = run.catch(() => undefined);
    this.chains.set(scope, tail);
    void tail.then(() => {
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

  private async register(msg: InboundMessage, ticket: string, scope: string): Promise<ConversationId> {
    const { harness } = this.opts;
    const known = (await harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
    if (known) return known.conversationId as ConversationId;
    const source: TicketSource = {
      type: msg.message_type,
      user_id: msg.user_id,
      group_id: msg.group_id,
      nickname: msg.nickname,
    };
    const reply = msg.segments.find((s) => s.type === "reply") as { data: { id?: string } } | undefined;
    const route = routeMessage(msg.route_text, this.prefixes);
    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: async (tx, conversationId) => {
          Object.assign(await tx.doc(TicketDoc, conversationId), {
            ticket, source, text: msg.text, time: msg.time, messageId: msg.message_id,
            route: route.route,
            ...(route.route !== "agent" ? { prefix: route.prefix } : {}),
            ...(route.route === "image" ? { prompt: route.prompt } : {}),
            ...(reply?.data.id ? { replyTo: reply.data.id } : {}),
          });
          const dispatch = await tx.doc(DispatchDoc);
          const seq = dispatch.nextSeq ?? 0;
          dispatch.nextSeq = seq + 1;
          dispatch.pending[ticket] = { conversationId, scope, seq, attempts: 0 };
        },
      },
      this.ctx,
    );
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
  private ensureTask(ticket: string): Promise<TaskId<TaskResult> | undefined> {
    const { ImageTask, AgentTask } = this.opts.tasks;
    return this.opts.harness.commit(async (tx) => {
      const entry = (await tx.doc(DispatchDoc)).pending[ticket];
      if (!entry) return undefined;
      if (entry.taskId !== undefined) {
        const rec = await tx.task(entry.taskId as TaskId);
        if (rec && rec.state.status !== "terminal") return rec.id as TaskId<TaskResult>;
      }
      const conversationId = entry.conversationId as ConversationId;
      const doc = await tx.doc(TicketDoc, conversationId);
      if (!doc.route) {
        // v2 遗留票据：按原文重新分流
        const r = routeMessage(legacyRouteText(doc.text), this.prefixes);
        doc.route = r.route;
        if (r.route !== "agent") doc.prefix = r.prefix;
        if (r.route === "image") doc.prompt = r.prompt;
      }
      const options = { ownership: { kind: "conversation" }, conversationId } as const;
      const id =
        doc.route === "agent"
          ? await tx.createTask(AgentTask, { ticket }, options)
          : await tx.createTask(ImageTask, { ticket }, options);
      entry.taskId = id as number;
      return id;
    }, this.ctx);
  }

  private async run(ticket: string, conversationId: ConversationId): Promise<void> {
    const { harness } = this.opts;
    let done = false;
    try {
      const attempts = await harness.commit(async (tx) => {
        const entry = (await tx.doc(DispatchDoc)).pending[ticket];
        if (!entry) return -1;
        entry.attempts = (entry.attempts ?? 0) + 1;
        return entry.attempts;
      }, this.ctx);
      if (attempts < 0) return; // 索引已被清除：已由其他路径完成
      // 已回复过的票据（重复投递）：不再运行任务
      const pre = await this.opts.bridge.getTicket(ticket).catch(() => undefined);
      if (pre === null || isTerminal(pre?.status)) {
        log.info("ticket already terminal, skipping", { ticket: short(ticket), status: pre?.status ?? "missing" });
        done = true;
        return;
      }
      const taskId = await this.ensureTask(ticket);
      if (taskId !== undefined) {
        const settled = await harness.waitForTask(taskId, this.ctx);
        const outcome = settled.state.outcome;
        log.info("ticket task settled", {
          ticket: short(ticket),
          task: settled.kind,
          status: outcome.status,
          attempts,
          ...(outcome.status === "failed" || outcome.status === "faulted" ? { error: outcome.error.message } : {}),
        });
      }
      const outcome = await this.fallbackIfUnreplied(ticket);
      done = outcome !== "pending";
      if (outcome === "terminal") await this.recordOutcome(ticket, conversationId);
      if (!done) log.warn("ticket still pending after run; keeping dispatch index", { ticket: short(ticket), attempts });
    } finally {
      // 基础设施错误（抛出）或票据仍 pending：保留索引，重启后 recover() 继续
      if (done) await this.clearIndex(ticket);
    }
  }

  /**
   * attempts 达上限：不再运行任务，发兜底回复后清除索引。
   * 若兜底在发送前就失败（票据仍 pending），保留索引，下次启动再试兜底。
   */
  private async giveUp(ticket: string): Promise<void> {
    if ((await this.fallbackIfUnreplied(ticket)) !== "pending") await this.clearIndex(ticket);
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
    if (!this.opts.history) return;
    try {
      const doc = await this.opts.harness.snapshot(TicketDoc, conversationId, this.ctx);
      const rec = await this.opts.bridge.getTicket(ticket);
      let action: BotAction = "reply";
      let detail: string | undefined;
      let ok = true;
      if (doc?.route === "image") {
        action = "generate_image";
        detail = doc.prompt;
        ok = doc.imageResult?.ok === true;
      } else if (doc?.route === "agent") {
        ok = doc.agentResult?.ok === true;
        if (doc.agentResult?.backend === "codex") {
          action = "ask_codex";
          detail = this.opts.codexEffort;
        }
      }
      this.withHistory("record reply failed", ticket, (h) =>
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

  private recordFallback(ticket: string, replyMessageId?: string): void {
    this.withHistory("record fallback failed", ticket, (h) =>
      h.completeReply(ticket, {
        action: "fallback",
        excerpt: FALLBACK_REPLY,
        status: "失败",
        ...(replyMessageId ? { reply_message_id: replyMessageId } : {}),
      }),
    );
  }

  private async clearIndex(ticket: string): Promise<void> {
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
    if (isTerminal(rec.status)) return "terminal";
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
