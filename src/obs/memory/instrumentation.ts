import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SummaryRow } from '../../context/store.js';
import { log } from '../../shared/log.js';

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

/** 仅用于 observability.sqlite；独立进程与主进程重复调用均安全。 */
export function ensureMemoryTables(db: DatabaseSync): void {
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, backend TEXT NOT NULL, ticket TEXT, session TEXT,
    task_id TEXT, tool TEXT NOT NULL, args_json TEXT NOT NULL, access TEXT NOT NULL, scope_hint TEXT,
    returned_json TEXT NOT NULL, returned_count INTEGER NOT NULL, dropped_count INTEGER NOT NULL,
    chars INTEGER NOT NULL, max_chars INTEGER NOT NULL, duration_ms INTEGER NOT NULL, is_error INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS recall_events_ts ON recall_events(ts);
    CREATE INDEX IF NOT EXISTS recall_events_ticket ON recall_events(ticket);
    CREATE INDEX IF NOT EXISTS recall_events_session_ts ON recall_events(session,ts);
    CREATE INDEX IF NOT EXISTS recall_events_scope_ts ON recall_events(scope_hint,ts);`);
}

/** 埋点只降级自身，不能向工具或整理路径抛出存储错误。 */
export class MemoryInstrumentation {
  private constructor(private db?: DatabaseSync, private owned = false) {}
  static fromDb(db: DatabaseSync): MemoryInstrumentation {
    const writer = new MemoryInstrumentation(db);
    writer.safe(() => ensureMemoryTables(db));
    return writer;
  }
  static openOwn(dataDir: string): MemoryInstrumentation {
    const writer = new MemoryInstrumentation(undefined, true);
    writer.safe(() => {
      writer.db = new DatabaseSync(path.join(dataDir, 'observability.sqlite'));
      writer.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      ensureMemoryTables(writer.db);
    });
    return writer;
  }
  private safe<T>(run: () => T): T | undefined {
    try { return run(); } catch (error) { log.warn('memory instrumentation failed', { error }); return undefined; }
  }
  /** 同步整理期间用 savepoint 聚合版本写入；聊天库失败时回滚版本，埋点失败不重跑业务。 */
  transaction<T>(run: () => T): T {
    const active = this.safe(() => { this.db?.exec('SAVEPOINT memory_aging'); return !!this.db; });
    try {
      const result = run();
      if (active) this.safe(() => this.db!.exec('RELEASE memory_aging'));
      return result;
    } catch (error) {
      if (active) this.safe(() => this.db!.exec('ROLLBACK TO memory_aging; RELEASE memory_aging'));
      throw error;
    }
  }
  recordSummaryVersion(row: SummaryRow, source: SummarySource, replaced: number[] = []): number | undefined {
    return this.safe(() => {
      if (!this.db) return undefined;
      this.db.exec('SAVEPOINT memory_version');
      try {
        const now = source.created_at ?? Date.now();
        const id = Number(this.db.prepare(`INSERT INTO summary_versions(summary_id,scope,level,period_start,period_end,
          created_at,batch_id,model,provider,usage_json,input_message_ids_json,input_summary_ids_json,input_chars,kept_chars,text_sha256,text)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.scope, row.level, row.period_start, row.period_end,
          now, source.batch_id, source.model ?? null, source.provider ?? null, JSON.stringify(source.usage ?? null),
          JSON.stringify(source.input_message_ids ?? []), JSON.stringify(source.input_summary_ids ?? []), source.input_chars ?? 0,
          row.text.length, createHash('sha256').update(row.text).digest('hex'), row.text).lastInsertRowid);
        const update = this.db.prepare('UPDATE summary_versions SET replaced_by=?,replaced_at=? WHERE id=? AND replaced_by IS NULL');
        for (const old of replaced) update.run(id, now, old);
        this.db.exec('RELEASE memory_version');
        return id;
      } catch (error) {
        this.db.exec('ROLLBACK TO memory_version; RELEASE memory_version');
        throw error;
      }
    });
  }
  snapshotReplaced(row: SummaryRow, source: SummarySource): number | undefined {
    return this.safe(() => {
      const found = this.db?.prepare(`SELECT id FROM summary_versions WHERE summary_id=? AND scope=? AND level=?
        AND period_start=? AND period_end=? AND text_sha256=? AND replaced_by IS NULL ORDER BY id DESC LIMIT 1`)
        .get(row.id, row.scope, row.level, row.period_start, row.period_end, createHash('sha256').update(row.text).digest('hex')) as { id: number } | undefined;
      return found?.id ?? this.recordSummaryVersion(row, source);
    });
  }
  recordRecall(event: RecallRecord): number | undefined {
    return this.safe(() => {
      if (!this.db) return undefined;
      return Number(this.db.prepare(`INSERT INTO recall_events(ts,backend,ticket,session,task_id,tool,args_json,access,scope_hint,
        returned_json,returned_count,dropped_count,chars,max_chars,duration_ms,is_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(event.ts, event.backend, event.ticket || null, event.session || null, event.task_id || null, event.tool,
          JSON.stringify(event.args), event.access, event.scope_hint, JSON.stringify(event.returned), event.returned_count,
          event.dropped_count, event.chars, event.max_chars, event.duration_ms, Number(event.is_error)).lastInsertRowid);
    });
  }
  close(): void { if (this.owned) this.safe(() => this.db?.close()); }
}

export function purgeMemoryInstrumentation(db: DatabaseSync, days: number, now = Date.now()): { versions: number; recalls: number } {
  if (days <= 0) return { versions: 0, recalls: 0 };
  const cutoff = now - days * 86400_000;
  db.exec('SAVEPOINT memory_purge');
  try {
    const versions = Number(db.prepare('DELETE FROM summary_versions WHERE created_at<?').run(cutoff).changes);
    const recalls = Number(db.prepare('DELETE FROM recall_events WHERE ts<?').run(cutoff).changes);
    db.exec('RELEASE memory_purge');
    return { versions, recalls };
  } catch (error) { db.exec('ROLLBACK TO memory_purge; RELEASE memory_purge'); throw error; }
}
