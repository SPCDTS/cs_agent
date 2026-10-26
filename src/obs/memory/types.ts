import type { SessionAdapters } from "../sessions/http.js";
import type { RecallRecord } from "../../context/observer.js";
import type { AgingReport } from '../../context/aging.js';
export type { AgingReport } from '../../context/aging.js';
import type { ContextStore } from '../../context/store.js';
import type { ObsStore } from '../store.js';
import type { MemoryStore } from '../../context/memory/store.js';

export interface Retention {
  rawDays: number; summaryDays: number; hardMaxDays: number; dailyHour: number; tz: string;
}
export interface MemoryAging {
  /** 时间统一为毫秒；未提供调度器时 next_run 为 null。 */
  lastRun?(): number | undefined;
  nextRun(): number | undefined;
  running(): boolean;
  config: Retention;
}
export interface MemoryArchives { codex: string; pi: string }
export interface MemoryDeps {
  context: ContextStore; store: ObsStore; retention: Retention;
  aging?: MemoryAging; archives?: MemoryArchives; maxChars?: number;
  now?: () => number;
  sessionAdapters?: SessionAdapters;
  /** 记忆条目（docs/MEMORY-DESIGN.md §10）；未接入时 /api/memory/entries* 为 404 */
  entries?: MemoryEntriesSource;
}
/** 面板读写记忆条目的入口：读走存储，遗忘 / 恢复走记忆服务（作者记为 dashboard）。 */
export interface MemoryEntriesSource {
  store: Pick<MemoryStore, 'browse' | 'get' | 'versions' | 'links' | 'namespaces'>;
  forget(id: number): unknown;
  restore(id: number): unknown;
  scopeLabel?(scope: string): string;
}
/** 时间均为毫秒；source 为写入时本轮最后一条输入。 */
export interface MemoryEntry {
  id: number; ns: string; ns_label: string; kind: string; subject: string | null; text: string; status: string; author: string;
  since: number | null; until: number | null; due_at: number | null; done_at: number | null; confidence: number;
  created_at: number; updated_at: number; last_recalled_at: number | null; recall_count: number;
  source: { scope: string; label: string; message_id: string | null; turn_id: string | null; timeline_href: string } | null;
}
export interface MemoryEntryPage {
  items: MemoryEntry[]; total: number; page: number; has_more: boolean; namespaces: { ns: string; label: string }[];
}
export interface MemoryEntryVersion { id: number; at: number; by: string; reason: string | null; status_before: string | null; status_after: string; text_changed: boolean }
export interface MemoryEntryDetail {
  entry: MemoryEntry; versions: MemoryEntryVersion[];
  links: { from_id: number; to_id: number; rel: string; created_at: number }[];
}
export interface ScopeSummary {
  scope: string; label: string; messages: number; summaries: { day: number; week: number };
  first_ts: number; last_ts: number; bytes_estimate: number; pending_day_summaries: number; media_count: number;
}
export interface AgingStatus {
  last_run: number | null; last_report?: AgingReport; next_run: number | null; running: boolean; catch_up_needed: boolean;
}
export interface TrackBucket { start: number; end: number; count: number; senders: number; preview?: string }
export interface SummaryItem {
  id: number; kind: 'day' | 'week'; period_start: number; period_end: number; created_at: number;
  chars: number; preview: string; source_messages: number | null;
}
export interface ScopeTimeline {
  scope: string; label: string; range: { first_ts: number; last_ts: number };
  retention_edges: { raw_until: number; day_until: number; week_until: number };
  tracks: { raw: TrackBucket[]; day: SummaryItem[]; week: SummaryItem[] };
  gaps: { from: number; to: number; reason: 'purged' | 'no_records' }[];
}
export interface MessageItem {
  message_id: string; ts: number; sender: string; sender_name: string; text: string; truncated?: true;
  reply_to?: string; bot_status?: string; bot_action?: string; media: number;
}
export interface MessagePage {
  items: MessageItem[]; next_before?: number; next_before_id?: number;
}
export interface Hit {
  kind: 'message' | 'summary'; id: string | number; ts: number; scope: string; excerpt: string; matched_fields: string[];
}
export interface ArchiveRow {
  key: string; thread_id?: string; conversation?: number; created_at: number | null;
  archived_at: number | null; reason: string; session_href: string;
}
export interface CompactionRow { conversation: number | string; attempts: number; last_at: number; reasons: string[] }

export interface SummaryVersion {
  id: number; summary_id: number; level: 'day' | 'week'; period_start: number; period_end: number; created_at: number;
  batch_id: string; model: string | null; provider: string | null; usage: unknown;
  input_message_ids: string[]; input_summary_ids: number[]; input_chars: number; kept_chars: number;
  text_sha256: string; text: string; replaced_by: number | null; replaced_at: number | null;
}
export interface RecallEvent extends RecallRecord {
  id: number; turn_id: string | null; session: string | null; task_id: string | null; turn_href: string | null;
}
export interface RequestEvidence {
  status: 'confirmed' | 'not_found' | 'unavailable'; turn?: string; call_id?: string; note: string;
}

export interface ImageItem {
  scope: string; message_id: string; ordinal: number; status: 'ok' | 'skipped'; sha256: string | null;
  bytes: number | null; mime: string | null; width: number | null; height: number | null;
  message_ts: number; sender_name: string; excerpt: string; thumb_href: string | null; href: string | null; present: boolean;
}
export interface ImagePage { items: ImageItem[]; page: number; has_more: boolean; totals: { ok: number; skipped: number; bytes: number } }
export interface ImageDetail {
  item: ImageItem; message: { scope: string; message_id: string; ts: number; sender_name: string; excerpt: string };
  other_media: ImageItem[]; timeline_href: string;
}
