import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { redact } from './redact.js';

export interface ObsEvent { id: number; ticket: string; scope: string; ts: number; stage: string; status: string; duration_ms: number | null; detail_json: string }
export interface TicketRow { ticket: string; scope: string; ts: number; updated: number; route: string | null; backend: string | null; status: string; sender: string | null; duration_ms: number }
export class ObsStore {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'observability.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, scope TEXT NOT NULL, ts INTEGER NOT NULL,
        stage TEXT NOT NULL, status TEXT NOT NULL, duration_ms REAL, detail_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket,id);
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS metrics(ts INTEGER NOT NULL, name TEXT NOT NULL, labels_json TEXT NOT NULL, value REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS obs_state(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS metrics_ts ON metrics(ts);`);
  }
  append(e: Omit<ObsEvent, 'id' | 'detail_json'> & { detail?: unknown }): ObsEvent {
    const detail_json = JSON.stringify(redact(e.detail ?? {}));
    const scope = e.scope || (this.db.prepare('SELECT scope FROM events WHERE ticket=? AND scope<>? LIMIT 1').get(e.ticket, '') as { scope: string } | undefined)?.scope || '';
    const id = Number(this.db.prepare('INSERT INTO events(ticket,scope,ts,stage,status,duration_ms,detail_json) VALUES(?,?,?,?,?,?,?)')
      .run(e.ticket, scope, e.ts, e.stage, e.status, e.duration_ms, detail_json).lastInsertRowid);
    return { id, ticket: e.ticket, scope, ts: e.ts, stage: e.stage, status: e.status, duration_ms: e.duration_ms, detail_json };
  }
  events(ticket: string, limit = 2000): ObsEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE ticket=? ORDER BY id LIMIT ?').all(ticket, limit) as unknown as ObsEvent[];
  }
  private ticketQuery = `SELECT ticket, MAX(scope) scope, MIN(ts) ts, MAX(ts) updated,
    MAX(CASE WHEN stage IN ('routed','recovered') THEN json_extract(detail_json,'$.route') END) route,
    COALESCE(MAX(CASE WHEN stage LIKE 'backend:%' THEN json_extract(detail_json,'$.backend') END),
      MAX(CASE WHEN stage='image:submit' THEN json_extract(detail_json,'$.backend') END)) backend,
    MAX(CASE WHEN stage IN ('received','recovered') THEN json_extract(detail_json,'$.sender') END) sender,
    COALESCE((SELECT CASE WHEN t.stage='failed' AND json_extract(t.detail_json,'$.failure')='timeout' THEN 'timeout'
      WHEN t.stage='failed' THEN 'failed' WHEN t.stage='fallback' THEN 'fallback' ELSE 'sent' END
      FROM events t WHERE t.ticket=e.ticket AND t.stage IN ('failed','fallback','reply_sent') AND json_extract(t.detail_json,'$.terminal')=1 ORDER BY t.id DESC LIMIT 1),'processing') status,
    MAX(ts)-MIN(ts) duration_ms FROM events e WHERE ticket NOT LIKE '@%' GROUP BY ticket`;
  tickets(filters: { status?: string; scope?: string; route?: string; backend?: string; page?: number } = {}): TicketRow[] {
    const args: SQLInputValue[] = [];
    const clauses = ['1=1'];
    for (const key of ['status', 'scope', 'route', 'backend'] as const) if (filters[key]) { clauses.push(`${key}=?`); args.push(filters[key]!); }
    return this.db.prepare(`SELECT * FROM (${this.ticketQuery}) WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT 50 OFFSET ?`)
      .all(...args, Math.max(0, Math.floor(filters.page ?? 0)) * 50) as unknown as TicketRow[];
  }
  throughput(since: number): { total: number; failed: number; error_rate: number } {
    const row = this.db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(status IN ('failed','fallback','timeout')),0) failed FROM (${this.ticketQuery}) WHERE updated>=? AND status<>'processing'`)
      .get(since) as { total: number; failed: number };
    return { ...row, error_rate: row.total ? row.failed / row.total : 0 };
  }
  metric(ts: number, name: string, labels: object, value: number): void {
    if (Number.isFinite(value)) this.db.prepare('INSERT INTO metrics VALUES(?,?,?,?)').run(ts, name, JSON.stringify(redact(labels)), value);
  }
  latest(stage: string): ObsEvent | undefined { return this.db.prepare('SELECT * FROM events WHERE stage=? ORDER BY id DESC LIMIT 1').get(stage) as ObsEvent | undefined; }
  purge(days: number, now = Date.now()): { events: number; metrics: number } {
    const cutoff = now - days * 86400_000;
    return { events: Number(this.db.prepare('DELETE FROM events WHERE ts<?').run(cutoff).changes),
      metrics: Number(this.db.prepare('DELETE FROM metrics WHERE ts<?').run(cutoff).changes) };
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
}
