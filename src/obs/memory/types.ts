import type { SessionAdapters } from "../sessions/http.js";
import type { RecallRecord } from "../../context/observer.js";
import type { AgingReport } from '../../context/aging.js';
export type { AgingReport } from '../../context/aging.js';
import type { ContextStore } from '../../context/store.js';
import type { ObsStore } from '../store.js';
import type { MemoryProposalRow, MemoryStore } from '../../context/memory/store.js';
import type { ProfileSnapshot } from '../../context/memory/profile.js';

export interface Retention {
  /** 原文保留天数的全局缺省（0 = 永不清理） */
  rawDays: number; summaryDays: number; hardMaxDays: number; dailyHour: number; tz: string;
  /** 按会话覆盖的原文保留天数（settings.json 的 history.rawDays）；只在 /api/memory 的输出里出现 */
  overrides?: Record<string, number>;
}
/** 按会话的原文保留天数（由 http.ts 从运行时设置构造，现读） */
export interface RawDaysSource {
  overrides(): Record<string, number>;
  forScope(scope: string): number;
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
  /** 按会话的原文保留天数；未提供时所有会话用 retention.rawDays */
  rawDays?: RawDaysSource;
  aging?: MemoryAging; archives?: MemoryArchives; maxChars?: number;
  now?: () => number;
  sessionAdapters?: SessionAdapters;
  /** 记忆条目（docs/MEMORY-DESIGN.md §10）；未接入时 /api/memory/entries* 为 404 */
  entries?: MemoryEntriesSource;
  /** 回合后抽取状态（/api/memory/extract）；未接入时为 404 */
  extract?: MemoryExtractSource;
  /** 画像编辑与夜间整理（/api/memory/profile/*、/api/memory/jobs）；未接入时为 404 */
  jobs?: MemoryJobsSource;
}
/** 面板读写记忆条目的入口：读走存储，遗忘 / 恢复走记忆服务（作者记为 dashboard）。 */
export interface MemoryEntriesSource {
  store: Pick<MemoryStore, 'browse' | 'get' | 'versions' | 'links' | 'namespaces'>;
  forget(id: number): unknown;
  restore(id: number): unknown;
  scopeLabel?(scope: string): string;
}
/** 回合后抽取的一次结果（agent/memory/extractor.ts 的 ExtractRecord，同形）；时间为毫秒。 */
export interface MemoryExtractRecord {
  turn_id: string; ns: string; at: number; status: 'ok' | 'skipped' | 'failed'; reason?: string;
  candidates: number; written: number; superseded: number; dropped: Record<string, number>; ms: number;
}
/** GET /api/memory/extract：队列长度、今日各命名空间次数、最近 10 次结果（最新在前）。 */
export interface MemoryExtractStatus {
  model: string; available: boolean; queue: number; running: string | null; daily_limit: number;
  today: { date: string; counts: Record<string, number> }; recent: MemoryExtractRecord[];
}
/** 面板读取抽取状态与设置页列出的命名空间（出现过的会话与已有记忆的命名空间）。 */
export interface MemoryExtractSource {
  status(): MemoryExtractStatus;
  namespaces(): string[];
}
/** 夜间整理一个批次的报告（agent/memory/consolidate.ts 的 ConsolidateBatchReport，同形）。 */
export interface MemoryConsolidateBatch {
  ns: string; batch_id: string; status: 'ok' | 'failed'; dedup: number;
  conflicts: { pairs: number; superseded: number; coexist: number; keep: number; protected: number; skipped?: string };
  orphaned: number; retired: number; proposal: string | null; usage: Record<string, number>; ms: number; errors: string[];
}
/** 一次整理运行的报告；时间为毫秒。 */
export interface MemoryConsolidateReport {
  status: 'ok' | 'failed' | 'closed'; started_at: number; ms: number; batches: MemoryConsolidateBatch[];
  totals: { dedup: number; superseded: number; orphaned: number; retired: number; proposals: number };
}
export interface MemoryConsolidateStatus {
  enabled: boolean; running: boolean; available: boolean; model: string; last_run: number | null; last_report: MemoryConsolidateReport | null;
}
/** 待确认的画像提议；current 为该命名空间当前画像，stale 表示画像已在提议生成后改过（采纳会 409）。时间为毫秒。 */
export interface MemoryProposalView {
  id: number; ns: string; ns_label: string; text: string; based_on_revision: string; batch_id: string; created_at: number;
  current: { text: string; revision: string } | null; stale: boolean;
}
export interface MemoryBatchView { batch_id: string; ns: string; ns_label: string; changes: number; at: number; rolled_back: boolean }
/** GET /api/memory/jobs：抽取状态、整理状态与下次计划、待确认提议、最近 10 个整理批次。 */
export interface MemoryJobsStatus {
  extract: MemoryExtractStatus | null;
  consolidate: MemoryConsolidateStatus & { next_run: number | null };
  proposals: MemoryProposalView[];
  batches: MemoryBatchView[];
}
/** GET /api/memory/profile/<ns>：画像原文（经统一脱敏）与 revision；redacted_inside 为原文含凭据样式内容（面板只读展示）。 */
export interface MemoryProfileView {
  ns: string; ns_label: string; text: string; revision: string; updated_at: number | null; bytes: number; max_bytes: number;
  oversize: boolean; redacted_inside: boolean;
}
/** 面板的画像编辑与夜间整理入口：读画像走 ProfileStore，写画像走记忆服务（作者 dashboard），整理与提议走整理器。 */
export interface MemoryJobsSource {
  profiles: { read(ns: string): Promise<ProfileSnapshot> };
  saveProfile(ns: string, text: string, revision: string): Promise<{ revision: string }>;
  consolidator: {
    status(): MemoryConsolidateStatus;
    trigger(): 'started' | 'running' | 'disabled';
    rollback(batchId: string): { restored: number; skipped: number };
    proposals(): MemoryProposalRow[];
    acceptProposal(id: number): Promise<{ revision: string }>;
    rejectProposal(id: number): Promise<void>;
  };
  store: Pick<MemoryStore, 'consolidateBatches'>;
  /** 下次整理的计划时间（毫秒，随衰老调度） */
  nextRun(): number | null;
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
  /** raw_until 为 null 表示该会话原文永不清理 */
  retention_edges: { raw_until: number | null; day_until: number; week_until: number };
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
