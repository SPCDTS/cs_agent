/**
 * QQ 消息 → 独立 durable conversation：
 * 1. createConversation(ownerless) 的同一 commit 内写入 TicketDoc 与 Session 级 DispatchDoc（ticket→conversationId）。
 * 2. submit({type:"input", requestId: ticket})，等待结束；结束后从 DispatchDoc 删除。
 * 3. 并发上限 = concurrency；超出的排队（排队项已持久化在 DispatchDoc，重启后 recover() 继续）。
 * 4. 若会话结束但票据仍是 pending（模型没回复/失败），发送一次兜底回复。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, ModelRef } from "@earendil-works/pi-durable";
import type { InboundMessage, QQBridge } from "../qq/types.js";
import { DispatchDoc, TicketDoc, type TicketSource } from "./docs.js";
import { log } from "../log.js";

export const FALLBACK_REPLY = "抱歉，这条消息处理失败了，请稍后再试。";

export interface DispatcherOptions {
  harness: Harness;
  bridge: Pick<QQBridge, "reply" | "getTicket">;
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
    const existing = this.inflight.get(ticket);
    if (existing) return existing;
    const p = this.register(msg, ticket)
      .then((conversationId) => this.run(ticket, conversationId))
      .catch((err) => log.error("dispatch failed", { ticket: ticket.slice(0, 12), error: err }))
      .finally(() => this.inflight.delete(ticket));
    this.inflight.set(ticket, p);
    return p;
  }

  /** 启动时：继续 DispatchDoc 中所有未完成的票据。 */
  async recover(): Promise<number> {
    const state = await this.opts.harness.snapshot(DispatchDoc, this.ctx);
    const entries = Object.entries(state?.pending ?? {});
    for (const [ticket, entry] of entries) {
      if (this.inflight.has(ticket)) continue;
      const p = this.run(ticket, entry.conversationId as ConversationId)
        .catch((err) => log.error("recover failed", { ticket: ticket.slice(0, 12), error: err }))
        .finally(() => this.inflight.delete(ticket));
      this.inflight.set(ticket, p);
    }
    if (entries.length) log.info("recovering pending tickets", { count: entries.length });
    return entries.length;
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
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
          (await tx.doc(DispatchDoc)).pending[ticket] = { conversationId, content };
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
    try {
      const conv = await harness.conversation(conversationId, this.ctx);
      const entry = (await harness.snapshot(DispatchDoc, this.ctx))?.pending[ticket];
      if (conv && entry) {
        const sub = await conv.submit({ type: "input", content: entry.content, requestId: ticket }, this.ctx);
        const settled = await sub.wait(this.ctx);
        log.info("conversation settled", {
          ticket: ticket.slice(0, 12),
          status: settled.status,
          ...(settled.status === "unanswered" ? { reason: (settled as { reason?: unknown }).reason } : {}),
        });
      }
      await this.fallbackIfUnreplied(ticket);
    } finally {
      this.release();
      await harness
        .commit(async (tx) => {
          delete (await tx.doc(DispatchDoc)).pending[ticket];
        }, this.ctx)
        .catch((err) => log.warn("dispatch cleanup failed", { error: err }));
    }
  }

  private async fallbackIfUnreplied(ticket: string): Promise<void> {
    const rec = await this.opts.bridge.getTicket(ticket).catch(() => null);
    if (rec?.status !== "pending") return;
    try {
      await this.opts.bridge.reply(ticket, FALLBACK_REPLY);
      log.warn("fallback reply sent", { ticket: ticket.slice(0, 12) });
    } catch (err) {
      log.error("fallback reply failed", { ticket: ticket.slice(0, 12), error: err });
    }
  }
}
