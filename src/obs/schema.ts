import type { DatabaseSync } from 'node:sqlite';
import { renameColumn } from '../shared/sqlite-migrate.js';

/** 仅用于 observability.sqlite；独立进程与主进程重复调用均安全。 */
export function ensureMemoryTables(db: DatabaseSync): void {
  // 旧库的 recall_events.ticket（存宿主回合 id）改名 turn_id；须先于下面按新列名建索引。
  renameColumn(db, 'recall_events', 'ticket', 'turn_id', { drop: ['recall_events_ticket'],
    create: ['CREATE INDEX IF NOT EXISTS recall_events_turn ON recall_events(turn_id)'] });
  db.exec(`CREATE TABLE IF NOT EXISTS summary_versions(
    id INTEGER PRIMARY KEY AUTOINCREMENT, summary_id INTEGER NOT NULL, scope TEXT NOT NULL, level TEXT NOT NULL,
    period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, created_at INTEGER NOT NULL, batch_id TEXT NOT NULL,
    model TEXT, provider TEXT, usage_json TEXT NOT NULL, input_message_ids_json TEXT NOT NULL,
    input_summary_ids_json TEXT NOT NULL, input_chars INTEGER NOT NULL, kept_chars INTEGER NOT NULL,
    text_sha256 TEXT NOT NULL, text TEXT NOT NULL, replaced_by INTEGER, replaced_at INTEGER);
    CREATE INDEX IF NOT EXISTS summary_versions_summary ON summary_versions(summary_id,id);
    CREATE INDEX IF NOT EXISTS summary_versions_replaced ON summary_versions(replaced_by);
    CREATE INDEX IF NOT EXISTS summary_versions_created ON summary_versions(created_at);
    CREATE TABLE IF NOT EXISTS recall_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, backend TEXT NOT NULL, turn_id TEXT, session TEXT,
    task_id TEXT, tool TEXT NOT NULL, args_json TEXT NOT NULL, access TEXT NOT NULL, scope_hint TEXT,
    returned_json TEXT NOT NULL, returned_count INTEGER NOT NULL, dropped_count INTEGER NOT NULL,
    chars INTEGER NOT NULL, max_chars INTEGER NOT NULL, duration_ms INTEGER NOT NULL, is_error INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS recall_events_ts ON recall_events(ts);
    CREATE INDEX IF NOT EXISTS recall_events_turn ON recall_events(turn_id);
    CREATE INDEX IF NOT EXISTS recall_events_session_ts ON recall_events(session,ts);
    CREATE INDEX IF NOT EXISTS recall_events_scope_ts ON recall_events(scope_hint,ts);`);
}
