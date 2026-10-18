import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, DEFAULT_COMPACTION_POLICY, watchEvents,
  type AgentEventStream, type Conversation, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import { usageCost, usageFields } from "../obs/usage.js";
import { ContextUsageStore, type ContextUsage } from "./context-usage.js";
import { PiRequestDoc } from "./pi-tools/request.js";

/** pi-durable README / CompactionPolicy：backgroundTokens 是阻塞阈值以下的提前量。 */
export function piContextCapacity(windowTokens: number, reserveTokens = DEFAULT_COMPACTION_POLICY.reserveTokens,
  backgroundTokens = DEFAULT_COMPACTION_POLICY.backgroundTokens): Pick<ContextUsage, "windowTokens" | "compaction"> {
  return { windowTokens, compaction: { background: windowTokens - reserveTokens - backgroundTokens,
    reserve: windowTokens - reserveTokens } };
}

/** 只消费已提交的 assistant / compaction 条目，工具循环中的每次模型回合各计一次。 */
export class PiContextObserver {
  private constructor(private readonly stream: AgentEventStream) {}

  static async open(harness: Harness, conv: Conversation, key: string, store: ContextUsageStore,
    capacity: Pick<ContextUsage, "windowTokens" | "compaction">, ticket?: string): Promise<PiContextObserver> {
    const stream = await watchEvents(harness, conv.id, BACKGROUND_CONTEXT);
    store.ensure("pi", key, capacity, ticket);
    // 初始快照中的旧条目不重复累计；溢出快照只补记注册后出现的条目。
    let lastAssistant = stream.snapshot.entries.reduce((last, e) => AssistantEntry.is(e) ? Math.max(last, e.id) : last, 0);
    let lastCompaction = stream.snapshot.entries.reduce((last, e) => CompactionEntry.is(e) ? Math.max(last, e.id) : last, 0);
    const consume = (entry: EntryRecord, ticket: string) => {
      if (AssistantEntry.is(entry) && entry.id > lastAssistant) {
        lastAssistant = entry.id;
        const message = entry.model?.find(m => m.role === "assistant");
        if (message?.role === "assistant") {
          store.recordTurn("pi", key, { ...capacity, usedTokens: usageCost(message.usage).input,
            cachedTokens: usageFields(message.usage).cache_read_tokens }, ticket);
        }
      } else if (CompactionEntry.is(entry) && entry.id > lastCompaction) {
        lastCompaction = entry.id;
        // entry 无墙钟时间戳；记录摘要落入当前会话时的观测时间，不把 beforeCompact 当成功。
        store.recordCompaction("pi", key, ticket);
      }
    };
    stream.start(async events => {
      const bound = await harness.snapshot(PiRequestDoc, conv.id, BACKGROUND_CONTEXT);
      const ticket = bound?.ticket || "@context";
      for (const event of events) {
        if (event.type === "message_end" || event.type === "entry_appended") consume(event.entry, ticket);
        else if (event.type === "snapshot") for (const entry of event.entries) consume(entry, ticket);
      }
    });
    return new PiContextObserver(stream);
  }

  async close(): Promise<void> { await this.stream.stop(); }
}
