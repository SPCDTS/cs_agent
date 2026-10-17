/**
 * QQ 消息 → 独立 durable conversation：
 * 1. createConversation(ownerless) 的同一 commit 内写入 TicketDoc 与 Session 级 DispatchDoc（ticket→conversationId）。
 * 2. submit({type:"input", requestId: ticket})，等待结束。
 * 3. 只有票据进入终态（sent/uncertain，含兜底回复已发出）才从 DispatchDoc 删除；基础设施错误时保留索引，
 *    并在索引里累计 attempts，重启后 recover() 继续；attempts ≥ MAX_ATTEMPTS 时直接发兜底回复并清除。
 * 4. 并发上限 = concurrency；超出的排队（排队项已持久化在 DispatchDoc，重启后 recover() 继续）。
 * 5. 若会话结束但票据仍是 pending（模型没回复/失败），发送一次兜底回复。
 * 6. recover() 还会与 QQBridge 的 pending 票据对账：admit 已落盘但派发索引未写入（两者之间崩溃）的票据，
 *    用票据里保存的来源与原文重建消息重新派发。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, ModelRef } from "@earendil-works/pi-durable";
import type { InboundMessage, QQBridge, ReplyTicketRecord } from "../qq/types.js";
import { DispatchDoc, TicketDoc, type TicketSource } from "./docs.js";
import { log } from "../log.js";

export const FALLBACK_REPLY = "抱歉，这条消息处理失败了，请稍后再试。";
/** 同一票据最多运行次数；recover 时达到即放弃运行，改发兜底回复 */
export const MAX_ATTEMPTS = 3;

export type DispatchBridge = Pick<QQBridge, "reply" | "getTicket" | "listPendingTickets">;

export interface DispatcherOptions {
  harness: Harness;
  bridge: DispatchBridge;
  model: ModelRef;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  concurrency: number;
  context?: Context;
}

export function buildUserContent(msg: InboundMessage): string {
  const where = msg.message_type === "group" ? `群聊(${msg.group_id})` : "私聊";
  const who = msg.nickname ? `${msg.nickname}(${msg.user_id})` : msg.user_id;
  const note = msg.truncated ? "\n[消息过长，已截断]" : "";
  return `[QQ ${where}，发送者 ${who}]\n${msg.text}${note}`;
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
    truncated: false,
    mentioned_self: rec.message_type === "group",
    segments: [],
  };
}

/** sent/uncertain 为终态；sending 只会因发送中途崩溃而残留，QQBridge 不会再发送它，同样视为终态 */
const isTerminal = (status: string | undefined) => status === "sent" || status === "uncertain" || status === "sending";

export class Dispatcher {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly ctx: Context;

  constructor(private readonly opts: DispatcherOptions) {
    this.ctx = opts.context ?? BACKGROUND_CONTEXT;
  }

  /** 收到授权消息：持久化后排队执行；同一 ticket 重复投递时复用。 */
  dispatch(msg: InboundMessage, ticket: string): Promise<void> {
    return this.track(ticket, "dispatch failed", () =>
      this.register(msg, ticket).then((conversationId) => this.run(ticket, conversationId)),
    );
  }

  /**
   * 启动时：继续 DispatchDoc 中所有未完成的票据（attempts 达上限的直接兜底），
   * 再与 QQBridge 的 pending 票据对账，补派发没有索引的票据。返回处理的票据数。
   */
  async recover(): Promise<number> {
    const state = await this.opts.harness.snapshot(DispatchDoc, this.ctx);
    const indexed = state?.pending ?? {};
    let count = 0;
    for (const [ticket, entry] of Object.entries(indexed)) {
      if (this.inflight.has(ticket)) continue;
      count++;
      if ((entry.attempts ?? 0) >= MAX_ATTEMPTS) {
        log.warn("ticket exceeded max attempts, giving up", { ticket: ticket.slice(0, 12), attempts: entry.attempts });
        void this.track(ticket, "give-up failed", () => this.giveUp(ticket));
      } else {
        void this.track(ticket, "recover failed", () => this.run(ticket, entry.conversationId as ConversationId));
      }
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
        log.warn("orphan ticket without source text, sending fallback", { ticket: rec.ticket_id.slice(0, 12) });
        void this.track(rec.ticket_id, "orphan fallback failed", async () => {
          await this.fallbackIfUnreplied(rec.ticket_id);
        });
      } else {
        log.warn("orphan pending ticket without dispatch index, re-dispatching", { ticket: rec.ticket_id.slice(0, 12) });
        void this.dispatch(inboundFromTicket(rec), rec.ticket_id);
      }
    }
    if (count) log.info("recovering pending tickets", { indexed: Object.keys(indexed).length, orphans: orphans.length });
    return count;
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  private track(ticket: string, label: string, work: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(ticket);
    if (existing) return existing;
    const p = work()
      .catch((err) => log.error(label, { ticket: ticket.slice(0, 12), error: err }))
      .finally(() => this.inflight.delete(ticket));
    this.inflight.set(ticket, p);
    return p;
  }

  private async register(msg: InboundMessage, ticket: string): Promise<ConversationId> {
    const { harness } = this.opts;
    const known = (await harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
    if (known) return known.conversationId as ConversationId;
    const source: TicketSource = {
      type: msg.message_type,
      user_id: msg.user_id,
      group_id: msg.group_id,
      nickname: msg.nickname,
    };
    const content = buildUserContent(msg);
    const conv = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: this.opts.model, thinkingLevel: this.opts.thinkingLevel ?? "low" },
        init: async (tx, conversationId) => {
          Object.assign(await tx.doc(TicketDoc, conversationId), { ticket, source, text: msg.text });
          (await tx.doc(DispatchDoc)).pending[ticket] = { conversationId, content, attempts: 0 };
        },
      },
      this.ctx,
    );
    log.info("conversation created", { ticket: ticket.slice(0, 12), conversation: conv.id, type: msg.message_type });
    return conv.id;
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

  private async run(ticket: string, conversationId: ConversationId): Promise<void> {
    const { harness } = this.opts;
    await this.acquire();
    let done = false;
    try {
      const attempts = await harness.commit(async (tx) => {
        const entry = (await tx.doc(DispatchDoc)).pending[ticket];
        if (!entry) return -1;
        entry.attempts = (entry.attempts ?? 0) + 1;
        return entry.attempts;
      }, this.ctx);
      if (attempts < 0) return; // 索引已被清除：已由其他路径完成
      const conv = await harness.conversation(conversationId, this.ctx);
      const entry = (await harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
      if (conv && entry) {
        const sub = await conv.submit({ type: "input", content: entry.content, requestId: ticket }, this.ctx);
        const settled = await sub.wait(this.ctx);
        log.info("conversation settled", {
          ticket: ticket.slice(0, 12),
          status: settled.status,
          attempts,
          ...(settled.status === "unanswered" ? { reason: (settled as { reason?: unknown }).reason } : {}),
        });
      }
      done = await this.fallbackIfUnreplied(ticket);
      if (!done) log.warn("ticket still pending after run; keeping dispatch index", { ticket: ticket.slice(0, 12), attempts });
    } finally {
      // 基础设施错误（抛出）或票据仍 pending：保留索引，重启后 recover() 继续
      this.release();
      if (done) await this.clearIndex(ticket);
    }
  }

  /**
   * attempts 达上限：不再运行模型，发兜底回复后清除索引。
   * 若兜底在发送前就失败（票据仍 pending），保留索引，下次启动再试兜底——
   * 否则 pending 票据会在对账时被当作孤儿重新派发。
   */
  private async giveUp(ticket: string): Promise<void> {
    if (await this.fallbackIfUnreplied(ticket)) await this.clearIndex(ticket);
  }

  private async clearIndex(ticket: string): Promise<void> {
    await this.opts.harness
      .commit(async (tx) => {
        delete (await tx.doc(DispatchDoc)).pending[ticket];
      }, this.ctx)
      .catch((err) => log.warn("dispatch cleanup failed", { error: err }));
  }

  /**
   * 票据仍 pending 时发一次兜底回复。返回票据是否已处于终态（sent/uncertain）——
   * 只有终态才允许清除派发索引；读不到票据、或兜底在发送前就失败（仍 pending）都返回 false。
   */
  private async fallbackIfUnreplied(ticket: string): Promise<boolean> {
    const rec = await this.opts.bridge.getTicket(ticket).catch((err: unknown) => {
      log.error("get ticket failed", { ticket: ticket.slice(0, 12), error: err });
      return undefined;
    });
    if (rec === undefined) return false;
    if (rec === null) return true; // 票据不存在：没有可回复的目标，不再保留索引
    if (isTerminal(rec.status)) return true;
    try {
      await this.opts.bridge.reply(ticket, FALLBACK_REPLY);
      log.warn("fallback reply sent", { ticket: ticket.slice(0, 12) });
      return true;
    } catch (err) {
      log.error("fallback reply failed", { ticket: ticket.slice(0, 12), error: err });
      const after = await this.opts.bridge.getTicket(ticket).catch(() => undefined);
      return isTerminal(after?.status);
    }
  }
}
