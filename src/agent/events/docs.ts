import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { eventSourceSettingsSchema, type EventSourceSettings, type ExternalEvent } from "./types.js";

export type EventCounts = { delivered: number; sent: number; silent: number; failed: number; suppressed: number; deduped: number };
export const emptyCounts = (): EventCounts => ({ delivered: 0, sent: 0, silent: 0, failed: 0, suppressed: 0, deduped: 0 });
export type EventSourceState = {
  enabled: boolean; cursor: string | null; settings: EventSourceSettings; held: ExternalEvent[];
  /** 未确认游标与持久积压同提交；只有入站成功后才转为 cursor。 */
  pendingCursor?: string; mergeAt?: number; extraCount: number; extraKeys: string[];
  stats: {
    lastPollAt: number | null; lastPollStatus: "ok" | "failed" | "reset" | null;
    consecutivePollFailures: number; consecutiveTurnFailures: number; pausedReason?: string; blockedReason?: string; degraded: boolean;
    hourWindowStart: number; deliveredInHour: number; counts24h: EventCounts;
    /** 按小时滚动的有界统计桶，避免把累计值误称为 24 小时。 */
    buckets: { at: number; counts: EventCounts }[];
  };
};
export const newSourceState = (now: number): EventSourceState => ({
  enabled: true, cursor: null, settings: eventSourceSettingsSchema.parse({}), held: [], extraCount: 0, extraKeys: [],
  stats: { lastPollAt: null, lastPollStatus: null, consecutivePollFailures: 0, consecutiveTurnFailures: 0,
    degraded: false, hourWindowStart: now, deliveredInHour: 0, counts24h: emptyCounts(), buckets: [] },
});
export const EventsDoc = defineDoc<{ sources: Record<string, EventSourceState>; runs: string[] }>({
  kind: "cs.events", version: 1, scope: "session", initial: () => ({ sources: {}, runs: [] }),
});
export type EventRun = {
  source: string; eventKeys: string[]; events: ExternalEvent[]; deliveredAt: number; turnId?: string;
  extraCount: number; result?: { status: "sent" | "silent" | "failed"; at: number };
};
export const EventRunDoc = defineDocFamily<EventRun, Record<string, never>>({
  kind: "cs.events.run", version: 1, scope: "session", family: true,
  initial: () => ({ source: "", eventKeys: [], events: [], deliveredAt: 0, extraCount: 0 }),
});
