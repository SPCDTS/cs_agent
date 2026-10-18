import type { SummaryRow } from '../../context/store.js';
import type { ObsStore } from '../store.js';
import { SessionError } from '../sessions/types.js';
import type { SummaryVersion } from './types.js';

interface VersionRow {
  id: number; summary_id: number; scope: string; level: 'day' | 'week'; period_start: number; period_end: number;
  created_at: number; batch_id: string; model: string | null; provider: string | null; usage_json: string;
  input_message_ids_json: string; input_summary_ids_json: string; input_chars: number; kept_chars: number;
  text_sha256: string; text: string; replaced_by: number | null; replaced_at: number | null;
}
function version(row: VersionRow): SummaryVersion {
  const { scope: _scope, usage_json, input_message_ids_json, input_summary_ids_json, ...fields } = row;
  return { ...fields, period_start: row.period_start * 1000, period_end: row.period_end * 1000,
    usage: JSON.parse(usage_json), input_message_ids: JSON.parse(input_message_ids_json), input_summary_ids: JSON.parse(input_summary_ids_json) };
}
export function summaryLineage(store: ObsStore, id: number) {
  if (store.degraded) return { lineage: null, snapshot: undefined };
  const versions = store.db.prepare('SELECT * FROM summary_versions WHERE summary_id=? ORDER BY id LIMIT 10001').all(id) as unknown as VersionRow[];
  if (!versions.length) return { lineage: null, snapshot: undefined };
  const replaced = store.db.prepare(`SELECT * FROM summary_versions WHERE replaced_by IN
    (SELECT id FROM summary_versions WHERE summary_id=?) ORDER BY period_start,id LIMIT 10001`).all(id) as unknown as VersionRow[];
  if (versions.length > 10000 || replaced.length > 10000) throw new SessionError(413, '摘要版本过多');
  const latest = versions.at(-1)!;
  const snapshot: SummaryRow = { id, scope: latest.scope, level: latest.level, period_start: latest.period_start,
    period_end: latest.period_end, text: latest.text, created_at: latest.created_at / 1000, msg_count: 0 };
  return { lineage: { versions: versions.map(version), replaced: replaced.map(version) }, snapshot };
}
