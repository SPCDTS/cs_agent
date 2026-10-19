/** 记忆业务的观察者契约；存储实现由组合根注入，业务层不依赖观测层。 */
import type { SummaryRow } from './store.js';

export type RecallHit = { kind: 'message'; id: string } | { kind: 'summary'; id: number };
export interface RecallObservation {
  ts: number; tool: string; args: Record<string, unknown>; access: string; scope_hint: string | null;
  returned: RecallHit[]; returned_count: number; dropped_count: number; chars: number; max_chars: number;
  duration_ms: number; is_error: boolean;
}
export interface RecallRecord extends RecallObservation {
  backend: string; ticket?: string | null; session?: string | null; task_id?: string | null;
}
export interface SummarySource {
  batch_id: string; model?: string | null; provider?: string | null; usage?: unknown;
  input_message_ids?: string[]; input_summary_ids?: number[]; input_chars?: number; created_at?: number;
}

/** 摘要版本记录与整理事务所需的最小接口。 */
export interface SummaryObserver {
  transaction<T>(run: () => T): T;
  recordSummaryVersion(row: SummaryRow, source: SummarySource, replaced?: number[]): number | undefined;
  snapshotReplaced(row: SummaryRow, source: SummarySource): number | undefined;
}

/** 召回记录的存储结果用于关联 trace 事件。 */
export interface RecallObserver {
  recordRecall(event: RecallRecord): number | undefined;
}
