import type { SummaryObserver, RecallObserver, SummarySource, RecallRecord } from '../../context/observer.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureMemoryTables } from '../schema.js';
import type { SummaryRow } from '../../context/store.js';
import { log } from '../../shared/log.js';

/** 埋点只降级自身，不能向工具或整理路径抛出存储错误。 */
export class MemoryInstrumentation implements SummaryObserver, RecallObserver {
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
