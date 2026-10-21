import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { log } from "../shared/log.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, DEFAULT_COMPACTION_POLICY, watchEvents,
  type AgentEventStream, type Conversation, type Cursor, type EntryId, type EntryRecord, type Harness, type Storage } from "@earendil-works/pi-durable";
import { usageCost, usageFields } from "../shared/usage.js";
import { ContextUsageStore, type ContextUsage, type ContextUsageHistory, type ContextRequestUsage } from "./context-usage.js";

/** pi-durable README / CompactionPolicy：backgroundTokens 是阻塞阈值以下的提前量。 */
export function piContextCapacity(windowTokens: number, reserveTokens = DEFAULT_COMPACTION_POLICY.reserveTokens,
  backgroundTokens = DEFAULT_COMPACTION_POLICY.backgroundTokens): Pick<ContextUsage, "windowTokens" | "compaction"> {
  return { windowTokens, compaction: { background: windowTokens - reserveTokens - backgroundTokens,
    reserve: windowTokens - reserveTokens } };
}

/** 每条已提交的助手消息记一次请求；回合完成后由后端统一更新线程状态。 */
export class PiContextObserver {
  private pending: Promise<void> = Promise.resolve();
  private lastAssistant = 0;
  private lastCompaction = 0;
  private lastEntry = 0;
  private request?: ContextRequestUsage;

  private constructor(private readonly stream: AgentEventStream, readonly backfilled: boolean,
    private readonly capacity: Pick<ContextUsage, "windowTokens" | "compaction">,
    private readonly conv: Conversation, private readonly key: string, private readonly store: ContextUsageStore) {}

  updateCapacity(next: Pick<ContextUsage, "windowTokens" | "compaction">): void { Object.assign(this.capacity, next); }

  lastRequest(ticket: string): ContextRequestUsage | undefined {
    return this.request?.ticket === ticket ? { ...this.request } : undefined;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async consume(entry: EntryRecord, ticket: string): Promise<void> {
    this.lastEntry = Math.max(this.lastEntry, entry.id);
    if (AssistantEntry.is(entry) && entry.id > this.lastAssistant) {
      this.lastAssistant = entry.id;
      const message = entry.model?.find(m => m.role === "assistant");
      if (message?.role === "assistant") {
        this.request = { ticket, seq: (this.lastRequest(ticket)?.seq ?? 0) + 1,
          usedTokens: usageCost(message.usage).input, cachedTokens: usageFields(message.usage).cache_read_tokens,
          outputTokens: usageFields(message.usage).output_tokens, windowTokens: this.capacity.windowTokens, at: message.timestamp };
        this.store.recordRequest("pi", this.key, this.request);
      }
    } else if (CompactionEntry.is(entry) && entry.id > this.lastCompaction) {
      this.lastCompaction = entry.id;
      await refreshPiCompactionUsage(this.conv, this.key, this.store, ticket, entry.id);
    }
  }

  /** 回执可能先于监听送达；用已提交历史补齐至最终答案，并与监听串行去重。 */
  synchronize(ticket: string, answer: EntryId): Promise<void> {
    return this.enqueue(async () => {
      let cursor: Cursor | undefined;
      const minEntryId = (this.lastEntry + 1) as EntryId;
      if (minEntryId > answer) return;
      do {
        const page = await this.conv.entries({ minEntryId, maxEntryId: answer, order: "ascending" }, 256, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) await this.consume(entry, ticket);
        cursor = page.next;
      } while (cursor);
    });
  }

  /** keyOf 给出当前回合的观测键（turn:<id>），没有回合时记在 @context。 */
  static async open(harness: Harness, conv: Conversation, key: string, store: ContextUsageStore, storage: Storage,
    capacity: Pick<ContextUsage, "windowTokens" | "compaction">, ticket?: string, keyOf?: () => string | undefined): Promise<PiContextObserver> {
    const stream = await watchEvents(harness, conv.id, BACKGROUND_CONTEXT);
    store.ensure("pi", key, capacity, ticket);
    // 快照与监听原子注册，历史不重新发请求事件。
    const tail = stream.snapshot.entries.reduce((last, entry) => Math.max(last, entry.id), 0) as EntryId;
    const history = tail ? await readPiContextUsage(conv, tail, storage) : undefined;
    const backfilled = history ? store.backfill("pi", key, history, ticket) : false;
    const observer = new PiContextObserver(stream, backfilled, capacity, conv, key, store);
    observer.lastEntry = tail;
    observer.lastAssistant = stream.snapshot.entries.reduce((last, e) => AssistantEntry.is(e) ? Math.max(last, e.id) : last, 0);
    observer.lastCompaction = stream.snapshot.entries.reduce((last, e) => CompactionEntry.is(e) ? Math.max(last, e.id) : last, 0);
    stream.start(events => observer.enqueue(async () => {
      const ticket = keyOf?.() || "@context";
      for (const event of events) {
        if (event.type === "message_end" || event.type === "entry_appended") await observer.consume(event.entry, ticket);
        else if (event.type === "snapshot") for (const entry of event.entries) await observer.consume(entry, ticket);
      }
    }));
    return observer;
  }

  async close(): Promise<void> { await this.stream.stop(); await this.pending; }
}

/** 手动压缩和 observer 共用 pi-ai 的估算，摘要前的 assistant 用量不再代表当前上下文。 */
export async function refreshPiCompactionUsage(conv: Conversation, key: string, store: ContextUsageStore,
  ticket = "@context", at?: EntryId): Promise<void> {
  try {
    const view = await conv.context(BACKGROUND_CONTEXT, at === undefined ? undefined : { at });
    if (!view.entries.some(entry => CompactionEntry.is(entry))) return;
    store.recordCompaction("pi", key, ticket, { usedTokens: estimateContextTokens(view.messages).tokens });
  } catch {
    log.info("pi context usage unavailable after compaction; keeping previous usage", { key });
  }
}

/** 活动上下文会因压缩缩短；用公开历史分页接口恢复已完成票据数与最近成功压缩。 */
async function readPiContextUsage(conv: Conversation, tail: EntryId, storage: Storage): Promise<ContextUsageHistory | undefined> {
  try {
    return await conv.commit(async tx => {
      let cursor: Cursor | undefined;
      let turns = 0;
      let latest: Omit<ContextUsageHistory, "turns"> | undefined;
      let lastCompactionAt: number | undefined;
      do {
        const page = await tx.scanEntries({ conversationId: conv.id, maxEntryId: tail, order: "descending" }, 256, cursor);
        for (const entry of page.items) {
          if (AssistantEntry.is(entry)) {
            const message = entry.model?.find(m => m.role === "assistant");
            if (!latest && message?.role === "assistant" && message.usage &&
                Number.isFinite(message.timestamp) && message.timestamp >= 0) {
              latest = { usedTokens: usageCost(message.usage).input,
                cachedTokens: usageFields(message.usage).cache_read_tokens, updatedAt: message.timestamp };
            }
          } else if (CompactionEntry.is(entry) && lastCompactionAt === undefined) {
            const timestamp = entry.model?.[0]?.timestamp;
            if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) lastCompactionAt = timestamp;
          }
        }
        cursor = page.next;
      } while (cursor);
      // 工具循环有多条 assistant，但一条完成的 input 回执只代表一个票据回合。
      do {
        const page = await storage.scanSubmissions({ conversationId: conv.id, status: "done", order: "descending" }, 256, cursor, BACKGROUND_CONTEXT);
        for (const submission of page.items) {
          if (submission.type === "input" && submission.status === "done" && submission.answer <= tail) turns++;
        }
        cursor = page.next;
      } while (cursor);
      return latest && { ...latest, turns, lastCompactionAt };
    }, BACKGROUND_CONTEXT);
  } catch { return undefined; }
}
