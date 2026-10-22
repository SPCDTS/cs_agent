/**
 * Inbox（设计 §4.1）：触发消息与定时输入的持久化入口，把输入按会话键交给 ThreadHost。
 * 1. 入站：bridge 已去重、落盘（queued）并下载附件；这里以 kind=user、发送者 = QQ 号投递给 ThreadHost
 *    （同一入站键重复投递是空操作）。
 * 2. 状态：后端收下（inputsDelivered）→ delivered；所在回合结束（turnEnded）→ done。
 * 3. 恢复：queued 的用户输入按到达顺序重新投递；宿主早已收下的输入只补齐状态（定时输入由定时执行侧恢复）。
 * 4. 工具绑定（§7.3）：工具调用时从宿主当前回合求出身份、发送地址与本轮输入，空闲或唤醒回合发往会话最近的输入地址。
 *    权限不在这里判断：由 host/identity.ts 的 runRights 按身份统一求出（会话基础权限 + 确证的人）。
 * 5. 呈现（§4.3）：每条输入一行来源头，引用、参考图照旧；定时输入原样（以 [定时任务] 开头）。
 */
import path from "node:path";
import type { Channel, InboundMessage, InboundRecord, TurnBinding } from "../channel/types.js";
import type { ContextStore } from "../context/store.js";
import { validateReferences } from "../media/references.js";
import { log } from "../shared/log.js";
import type { OwnerIds } from "../shared/owners.js";
import { trace } from "../shared/trace.js";
import type { TicketSource } from "./backends/types.js";
import { buildCodexPrompt } from "./codex/runner.js";
import type { InputRef, ThreadKey } from "./host/types.js";
import type { ThreadHost } from "./host/thread-host.js";

export type InboxChannel = Pick<Channel, "inbox"> & Partial<Pick<Channel, "prepareIncoming">>;

export interface InboxOptions {
  getChannel(): InboxChannel;
  getHost(): Pick<ThreadHost, "deliver" | "currentIdentity" | "thread" | "inputState">;
  owners?: OwnerIds | (() => OwnerIds);
  /** 查找 [引用] 正文 */
  store?: Pick<ContextStore, "message">;
  dataDir: string;
}

/** 一批输入呈现给模型的内容 */
export interface RenderedInputs {
  text: string;
  /** 已校验的参考图（各输入 incoming 目录内） */
  images: string[];
  /** 最后一条输入的来源（codex 召回令牌、标题） */
  source: TicketSource;
}

const PAGE = 200;

export class Inbox {
  constructor(private readonly opts: InboxOptions) {}

  private get channel() { return this.opts.getChannel(); }
  private owners(): OwnerIds { return typeof this.opts.owners === "function" ? this.opts.owners() : this.opts.owners; }

  /** bridge 的 message 事件：附件已就绪，投递给会话宿主。 */
  async receive(_message: InboundMessage, key: string): Promise<void> {
    const rec = this.channel.inbox.getInbound(key);
    if (!rec) throw new Error("入站记录不存在");
    await this.deliver(rec);
  }

  private async deliver(rec: InboundRecord): Promise<void> {
    const result = await this.opts.getHost().deliver(rec.thread_key as ThreadKey, {
      inboundKey: rec.key, kind: rec.kind, sender: rec.user_id,
    });
    trace.event("in:" + rec.key, "queued", { scope: rec.scope, detail: { thread_key: rec.thread_key, kind: rec.kind, result } });
  }

  /** 定时输入（§10）：由执行侧写入后投递，线程忙时排队等空闲。 */
  async deliverScheduled(key: string): Promise<void> {
    const rec = this.channel.inbox.getInbound(key);
    if (!rec || rec.kind !== "scheduled") throw new Error("定时输入不存在");
    await this.deliver(rec);
  }

  /**
   * 启动时（宿主恢复之后）调用：queued 的输入按到达顺序重新投递。
   * 宿主已有记录（投递后、标记前崩溃）的只补齐状态；未下载完的附件先补下载。
   */
  async recover(): Promise<number> {
    const queued: InboundRecord[] = [];
    for (let after = 0; ; ) {
      const page = this.channel.inbox.listInbound("queued", PAGE, after);
      queued.push(...page);
      if (page.length < PAGE) break;
      after = page.at(-1)!.seq;
    }
    for (const rec of queued) {
      // 定时输入由定时执行侧按创建者当时的授权恢复（ScheduledRuntime.recover）。
      if (rec.kind === "scheduled") continue;
      try {
        const state = await this.opts.getHost().inputState(rec.key);
        if (state === "delivered" || state === "done") {
          this.channel.inbox.markInbound([rec.key], state);
          continue;
        }
        const ready = rec.kind === "user" && rec.attachments.some(a => a.status === "pending")
          ? await this.channel.prepareIncoming?.(rec.key) ?? rec : rec;
        trace.event("in:" + rec.key, "recovered", { scope: rec.scope, detail: { text: rec.text, sender: rec.nickname } });
        await this.deliver(ready);
      } catch (error) {
        log.warn("inbound recovery failed", { key: rec.key.slice(0, 12), error });
      }
    }
    if (queued.length) log.info("inbound inputs recovered", { count: queued.length });
    return queued.length;
  }

  // ───────────── 宿主事件 ─────────────

  onDelivered(turnId: string, inputs: readonly InputRef[]): void {
    this.channel.inbox.markInbound(inputs.map(i => i.inboundKey), "delivered", turnId);
    for (const input of inputs) trace.event("in:" + input.inboundKey, "delivered", { detail: { turn: turnId } });
  }

  onDone(inputs: readonly InputRef[]): void {
    this.channel.inbox.markInbound(inputs.map(i => i.inboundKey), "done");
  }

  // ───────────── 读取 ─────────────

  get(key: string): InboundRecord | null { return this.channel.inbox.getInbound(key); }

  records(inputs: readonly Pick<InputRef, "inboundKey">[]): InboundRecord[] {
    return inputs.map(input => {
      const rec = this.get(input.inboundKey);
      if (!rec) throw new Error("输入记录不存在：" + input.inboundKey.slice(0, 12));
      return rec;
    });
  }

  /** 会话的默认发送地址：群与私聊即本身；owner 线程取首个 owner 的私聊。 */
  private defaultScope(threadKey: string): string {
    if (threadKey !== "owner") return threadKey;
    const owners = this.owners(), first = typeof owners === "string" ? owners : owners?.[0];
    if (!first) throw new Error("owner 线程缺少 owner 账号");
    return `private:${first}`;
  }

  /**
   * 工具调用时的本轮绑定（§7.3）：身份取自宿主当前回合（唤醒回合带确证继承的人）；
   * 宿主空闲（后端仍在收尾）按没有继承的唤醒回合处理，即只有会话基础权限（只会更严格）。
   * 发送地址为本轮最后一条输入的会话，唤醒回合为会话最近一条输入的会话。
   */
  binding(threadKey: string): TurnBinding {
    const host = this.opts.getHost(), state = host.thread(threadKey as ThreadKey);
    const identity = host.currentIdentity(threadKey as ThreadKey) ?? { kind: "wake" as const };
    const inputs = state?.busy ? state.turnInputs.map(i => i.inboundKey) : [];
    const last = inputs.length ? this.get(inputs.at(-1)!) : this.channel.inbox.latestInbound(threadKey);
    return {
      threadKey, identity, inputs,
      ...(state?.busy && state.turnId ? { turnId: state.turnId } : {}),
      scope: last?.scope ?? this.defaultScope(threadKey),
      ...(last ? { inputKey: last.key } : {}),
    };
  }

  /** 每条输入的来源头与正文；多条之间空一行。参考图按输入各自的 incoming 目录校验。 */
  async render(records: readonly InboundRecord[]): Promise<RenderedInputs> {
    const parts: string[] = [], images: string[] = [];
    for (const rec of records) {
      if (rec.kind === "scheduled") { parts.push(rec.text); continue; }
      const source = sourceOf(rec);
      let quote: { message_id: string; nickname: string; text: string } | undefined;
      if (rec.reply_to && this.opts.store) {
        try {
          const hit = this.opts.store.message({ kind: "scope", scope: rec.scope }, rec.reply_to);
          if (hit) quote = { message_id: hit.row.message_id, nickname: hit.row.is_self ? "我" : hit.row.nickname || hit.row.user_id, text: hit.row.text };
        } catch (error) {
          log.warn("quote lookup failed", { key: rec.key.slice(0, 12), error });
        }
      }
      let refs: string[] = [];
      if (rec.image_error) parts.push(buildCodexPrompt(source, rec.text, { time: rec.time, ...(quote ? { quote } : {}) }) + `\n[参考图] ${rec.image_error}`);
      else {
        refs = await validateReferences(rec.images.slice(0, 3), rec.images, path.join(this.opts.dataDir, "incoming", rec.key));
        parts.push(buildCodexPrompt(source, rec.text, { time: rec.time, ...(quote ? { quote } : {}) }) +
          (refs.length ? "\n[本轮参考图]\n" + refs.join("\n") : ""));
      }
      images.push(...refs);
    }
    const last = records.at(-1)!;
    return { text: parts.join("\n\n"), images, source: sourceOf(last) };
  }
}

/** 输入记录 → 来源头所需的来源（定时输入的来源为创建者）。 */
export function sourceOf(rec: InboundRecord): TicketSource {
  return { type: rec.message_type, user_id: rec.user_id, group_id: rec.group_id,
    ...(rec.group_name ? { group_name: rec.group_name } : {}), nickname: rec.nickname };
}
