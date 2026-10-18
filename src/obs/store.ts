import { ensureMemoryTables } from './memory/instrumentation.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { redact, redactText } from './redact.js';

export interface ObsEvent { id: number; ticket: string; scope: string; ts: number; stage: string; status: string; duration_ms: number | null; detail_json: string }
export interface TicketRow { ticket: string; scope: string; ts: number; updated: number; route: string | null; backend: string | null; status: string; sender: string | null; duration_ms: number }
export interface ThreadTurn { ticket: string; ts: number; started: number; text: string; reply: string; status: string; duration_ms: number; tools: number; input_tokens: number; output_tokens: number }
/** 管理事件独立按年龄保留，不参与普通票据预算。 */
const ADMIN_EVENT_SQL = "(ticket LIKE '@%' OR stage IN ('settings_changed','prompt_changed','thread_reset'))";
export class ObsStore {
  private database?: DatabaseSync;
  degraded = false;
  get db(): DatabaseSync { if (!this.database) throw new Error('观测存储已降级'); return this.database; }
  degrade(): void { this.degraded = true; try { this.database?.close(); } catch { /* 尽力关闭 */ } this.database = undefined; }
  constructor(dataDir: string, readonly eventCap = 500, readonly adminRetentionDays = 365) {
    try {
      mkdirSync(dataDir, { recursive: true });
      this.database = new DatabaseSync(path.join(dataDir, 'observability.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, scope TEXT NOT NULL, ts INTEGER NOT NULL,
        stage TEXT NOT NULL, status TEXT NOT NULL, duration_ms REAL, detail_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket,id);
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS metrics(ts INTEGER NOT NULL, name TEXT NOT NULL, labels_json TEXT NOT NULL, value REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS obs_state(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS metrics_ts ON metrics(ts);`);
      ensureMemoryTables(this.db);
      this.db.prepare('SELECT id,ticket,scope,ts,stage,status,duration_ms,detail_json FROM events LIMIT 0');
      this.db.prepare('SELECT ts,name,labels_json,value FROM metrics LIMIT 0');
      this.db.prepare('SELECT key,value FROM obs_state LIMIT 0');
    } catch { this.degrade(); }
  }
  append(e: Omit<ObsEvent, 'id' | 'detail_json'> & { detail?: unknown }): ObsEvent | undefined {
    if (this.degraded) return;
    let detail_json = JSON.stringify(redact(e.detail ?? {}));
    const scope = e.scope || (this.db.prepare('SELECT scope FROM events WHERE ticket=? AND scope<>? LIMIT 1').get(e.ticket, '') as { scope: string } | undefined)?.scope || '';
    const admin = e.ticket.startsWith('@') || ['settings_changed','prompt_changed','thread_reset'].includes(e.stage);
    if (admin) {
      const id = Number(this.db.prepare('INSERT INTO events(ticket,scope,ts,stage,status,duration_ms,detail_json) VALUES(?,?,?,?,?,?,?)')
        .run(e.ticket, scope, e.ts, e.stage, e.status, e.duration_ms, detail_json).lastInsertRowid);
      return { id, ticket: e.ticket, scope, ts: e.ts, stage: e.stage, status: e.status, duration_ms: e.duration_ms, detail_json };
    }
    const terminal = ['reply_sent','failed','fallback'].includes(e.stage) && (e.detail as { terminal?: boolean } | undefined)?.terminal === true;
    // 三种终态各预留一行与 1 KiB，摘要另预留一行；重复终态更新对应行。
    if (terminal) detail_json = JSON.stringify({ ...JSON.parse(detail_json), terminal: true });
    if (terminal && Buffer.byteLength(detail_json) > 1024) detail_json = JSON.stringify(redact({ terminal: true, failure: (e.detail as {failure?: unknown}).failure, truncated: true }));
    if (terminal) {
      const previous = this.db.prepare("SELECT id FROM events WHERE ticket=? AND stage=? AND json_extract(detail_json,'$.terminal')=1 LIMIT 1").get(e.ticket,e.stage) as {id:number} | undefined;
      if (previous) { this.db.prepare('DELETE FROM events WHERE id=?').run(previous.id); }
    }
    // 同一 Codex 调用的 started/updated 保留首条和最新条，最新条累计更新数。
    const detail = JSON.parse(detail_json);
    if (!terminal && e.status === 'started' && detail.backend === 'codex' && detail.call_id) {
      const progress = this.db.prepare("SELECT id,detail_json FROM events WHERE ticket=? AND stage=? AND status='started' AND json_extract(detail_json,'$.call_id')=? ORDER BY id").all(e.ticket,e.stage,String(detail.call_id)) as {id:number;detail_json:string}[];
      if (progress.length >= 2) {
        const last = progress[progress.length-1]!;
        const count = Number(JSON.parse(last.detail_json).count ?? 2) + 1;
        detail_json = JSON.stringify({...detail,count});
        const used = (this.db.prepare(`SELECT SUM(length(CAST(detail_json AS BLOB))) bytes FROM events WHERE ticket=? AND NOT ${ADMIN_EVENT_SQL}`).get(e.ticket) as {bytes:number}).bytes;
        const remaining = 256*1024-4096-used+Buffer.byteLength(last.detail_json);
        if (Buffer.byteLength(detail_json) > remaining) {
          // 预算不足时保留末条的时间、计数及有界摘要，首条仍保留原输入。
          detail_json = JSON.stringify({backend:'codex',call_id:detail.call_id,count,latest:redactText(JSON.stringify(detail),100)});
          if (Buffer.byteLength(detail_json) > remaining) detail_json = JSON.stringify({backend:'codex',call_id:detail.call_id,count});
        }
        this.db.prepare('UPDATE events SET ts=?,detail_json=? WHERE id=?').run(e.ts,detail_json,last.id);
        return { ...e, scope, id:last.id, detail_json };
      }
    }
    const budget = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(length(CAST(detail_json AS BLOB))),0) bytes FROM events WHERE ticket=? AND NOT ${ADMIN_EVENT_SQL}`).get(e.ticket) as {n:number;bytes:number};
    if (!terminal && (budget.n >= Math.max(8,this.eventCap)-4 || budget.bytes+Buffer.byteLength(detail_json) > 256*1024-4096)) {
      const summary = this.db.prepare("SELECT id,detail_json FROM events WHERE ticket=? AND stage='events_dropped'").get(e.ticket) as {id:number;detail_json:string} | undefined;
      const dropped = Number(summary ? JSON.parse(summary.detail_json).dropped : 0)+1;
      const json = JSON.stringify({dropped});
      if (summary) this.db.prepare('UPDATE events SET ts=?,detail_json=? WHERE id=?').run(e.ts,json,summary.id);
      else this.db.prepare("INSERT INTO events(ticket,scope,ts,stage,status,duration_ms,detail_json) VALUES(?,?,?,'events_dropped','ok',NULL,?)").run(e.ticket,scope,e.ts,json);
      return;
    }
    const id = Number(this.db.prepare('INSERT INTO events(ticket,scope,ts,stage,status,duration_ms,detail_json) VALUES(?,?,?,?,?,?,?)')
      .run(e.ticket, scope, e.ts, e.stage, e.status, e.duration_ms, detail_json).lastInsertRowid);
    return { id, ticket: e.ticket, scope, ts: e.ts, stage: e.stage, status: e.status, duration_ms: e.duration_ms, detail_json };
  }
  events(ticket: string, options: number | { after?: number; limit?: number } = {}): ObsEvent[] {
    if (this.degraded) return [];
    const {after=0,limit=500} = typeof options === 'number' ? {limit:options} : options;
    return this.db.prepare('SELECT * FROM events WHERE ticket=? AND id>? ORDER BY id LIMIT ?').all(ticket,
      Number.isFinite(after) ? Math.max(0,Math.floor(after)) : 0, Number.isFinite(limit) ? Math.max(1,Math.min(2000,Math.floor(limit))) : 500) as unknown as ObsEvent[];
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
    if (this.degraded) return [];
    const args: SQLInputValue[] = [];
    const clauses = ['1=1'];
    for (const key of ['status', 'scope', 'route', 'backend'] as const) if (filters[key]) { clauses.push(`${key}=?`); args.push(filters[key]!); }
    return this.db.prepare(`SELECT * FROM (${this.ticketQuery}) WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT 50 OFFSET ?`)
      .all(...args, Math.max(0, Math.floor(filters.page ?? 0)) * 50) as unknown as TicketRow[];
  }
  throughput(since: number): { total: number; failed: number; error_rate: number } {
    if (this.degraded) return { total: 0, failed: 0, error_rate: 0 };
    const row = this.db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(status IN ('failed','fallback','timeout')),0) failed FROM (${this.ticketQuery}) WHERE updated>=? AND status<>'processing'`)
      .get(since) as { total: number; failed: number };
    return { ...row, error_rate: row.total ? row.failed / row.total : 0 };
  }
  metric(ts: number, name: string, labels: object, value: number): void {
    if (!this.degraded && Number.isFinite(value)) this.db.prepare('INSERT INTO metrics VALUES(?,?,?,?)').run(ts, name, JSON.stringify(redact(labels)), value);
  }
  /**
   * 某个 codex 线程 / pi 会话最近 N 轮的摘要，只来自观测事件（不读 rollout 原文）：
   * codex 以 model_turn.thread_key 归属，pi 以 dispatched.conversation_key 归属。
   */
  threadTurns(backend: 'codex' | 'pi', key: string, limit = 10): ThreadTurn[] {
    if (this.degraded) return [];
    const [stage, field] = backend === 'codex' ? ['model_turn', '$.thread_key'] : ['dispatched', '$.conversation_key'];
    const rows = this.db.prepare(`SELECT ticket, MAX(ts) ts FROM events WHERE stage=? AND status<>'started' AND json_extract(detail_json,'$.backend')=?
      AND json_extract(detail_json,'${field}')=? GROUP BY ticket ORDER BY ts DESC LIMIT ?`).all(stage, backend, key, Math.max(1, Math.min(50, Math.floor(limit)))) as { ticket: string; ts: number }[];
    return rows.map(({ ticket, ts }) => {
      const events = this.events(ticket, { limit: 2000 });
      const detail = (e: ObsEvent) => JSON.parse(e.detail_json) as Record<string, unknown>;
      const received = events.find(e => e.stage === 'received' || (e.stage === 'recovered' && detail(e).text !== undefined));
      const terminal = events.filter(e => ['reply_sent', 'failed', 'fallback'].includes(e.stage) && detail(e).terminal === true).at(-1);
      const sent = events.filter(e => e.stage === 'postprocess' && e.status !== 'started').at(-1);
      const turn = events.filter(e => e.stage === 'model_turn' && e.status !== 'started').at(-1);
      let input = 0, output = 0;
      for (const e of events) if ((e.stage === 'model_turn' || e.stage === 'model_usage') && e.status !== 'started') {
        const d = detail(e); input += Number(d.input_tokens) || 0; output += Number(d.output_tokens) || 0;
      }
      const reply = terminal && typeof detail(terminal).reply === 'string' ? detail(terminal).reply : sent ? detail(sent).sent_text : turn ? detail(turn).raw_reply ?? detail(turn).reply : undefined;
      return { ticket, ts, started: events[0]?.ts ?? ts, text: received ? String(detail(received).text ?? '') : '',
        reply: typeof reply === 'string' ? reply : '', status: terminal ? (terminal.stage === 'reply_sent' ? 'sent' : terminal.stage) : 'processing',
        duration_ms: (terminal?.ts ?? ts) - (events[0]?.ts ?? ts), tools: events.filter(e => e.stage.startsWith('tool:') && e.status !== 'started').length,
        input_tokens: input, output_tokens: output };
    });
  }
  /** 最近的系统事件（@ 开头的票据，例如 @settings）。 */
  systemEvents(ticket: string, limit = 20): ObsEvent[] {
    if (this.degraded) return [];
    return this.db.prepare('SELECT * FROM events WHERE ticket=? ORDER BY id DESC LIMIT ?').all(ticket, Math.max(1, Math.min(200, limit))) as unknown as ObsEvent[];
  }
  latest(stage: string): ObsEvent | undefined { if (this.degraded) return; return this.db.prepare('SELECT * FROM events WHERE stage=? ORDER BY id DESC LIMIT 1').get(stage) as ObsEvent | undefined; }
  purge(days: number, now = Date.now()): { events: number; metrics: number } {
    if (this.degraded) return { events: 0, metrics: 0 };
    const cutoff = now - days * 86400_000;
    return { events: Number(this.db.prepare(`DELETE FROM events WHERE (NOT ${ADMIN_EVENT_SQL} AND ts<?) OR (${ADMIN_EVENT_SQL} AND ts<?)`).run(cutoff, now - this.adminRetentionDays * 86400_000).changes),
      metrics: Number(this.db.prepare('DELETE FROM metrics WHERE ts<?').run(cutoff).changes) };
  }
  close(): void { if (this.database?.isOpen) this.database.close(); }
}
