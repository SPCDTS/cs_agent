import { ensureMemoryTables } from './schema.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { redact, redactText } from '../shared/redact.js';
import { toContextUsage } from '../shared/format.js';
import { analyzeContextTurns, type ContextAnalysisOptions, type ContextEvent, type SystemEvent, type ThreadContextSeries } from './context-turns.js';

import type { ObsEvent } from '../shared/trace.js';
import type { TurnBrief } from '../shared/context-turns.js';
import { renameColumn } from '../shared/sqlite-migrate.js';
/** 回合列表的一行（trace 键 turn:<id> 的事件聚合）；status：completed / failed / lost / processing。 */
export interface TurnRow { key: string; scope: string; thread: string | null; kind: string | null; ts: number; updated: number; backend: string | null; status: string; sender: string | null; duration_ms: number }
export interface TurnFilters { status?: string; thread?: string; backend?: string; kind?: string; page?: number }
/** 管理事件独立按年龄保留，不参与普通 trace 键的预算。 */
const ADMIN_EVENT_SQL = "(key LIKE '@%' OR stage IN ('settings_changed','prompt_changed','thread_reset'))";
const CHAT_STAGES = ['received', 'recovered', 'queued', 'admitted', 'dispatched', 'steered', 'send_message', 'send_rejected', 'reply_sent', 'failed'].map(s => `'${s}'`).join(',');
type ContextRow = Pick<ObsEvent, 'ts' | 'key' | 'stage' | 'detail_json'>;
// 请求在回合结束时批量入库；排序、since 和原因区间必须使用请求自身时间。
const CONTEXT_TS_SQL = "CASE WHEN stage='model_request' THEN json_extract(detail_json,'$.at') ELSE ts END";
const CONTEXT_REQUEST_SQL = `(stage='model_request' OR (stage='context_usage'
  AND json_extract(detail_json,'$.source')='turn' AND events.key NOT LIKE '@%' AND NOT EXISTS (
    SELECT 1 FROM events request WHERE request.key=events.key AND request.stage='model_request'
    AND json_extract(request.detail_json,'$.backend')=json_extract(events.detail_json,'$.backend')
    AND json_extract(request.detail_json,'$.key')=json_extract(events.detail_json,'$.key'))))`;
function contextEvent(row: ContextRow): ContextEvent | undefined {
  const detail: unknown = JSON.parse(row.detail_json);
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
  const d = detail as Record<string, unknown>;
  if (row.stage === 'model_request') {
    const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if ((d.backend !== 'codex' && d.backend !== 'pi') || typeof d.key !== 'string' || !d.key || d.key.length > 64 ||
        !nonnegative(d.input) || !nonnegative(d.window) || d.window === 0 || !nonnegative(d.at) ||
        !nonnegative(d.seq) || !Number.isInteger(d.seq) || d.seq < 1 ||
        !nonnegative(d.turn) || !Number.isInteger(d.turn) || d.turn < 1) return;
    return { ts: d.at, key: row.key, kind: 'request', detail: {
      backend: d.backend, key: d.key, trace_key: row.key, seq: d.seq, turn: d.turn, input: d.input, window: d.window, at: d.at,
      ...(nonnegative(d.cached) ? { cached: d.cached } : {}),
      ...(nonnegative(d.output) ? { output: d.output } : {}),
      ...(nonnegative(d.effective_window) && d.effective_window > 0 ? { effective_window: d.effective_window } : {}),
    } };
  }
  const usage = toContextUsage(d);
  if (usage) return { ts: row.ts, key: row.key, kind: 'usage', detail: usage };
}
export class ObsStore {
  private database?: DatabaseSync;
  degraded = false;
  get db(): DatabaseSync { if (!this.database) throw new Error('观测存储已降级'); return this.database; }
  degrade(): void { this.degraded = true; try { this.database?.close(); } catch { /* 尽力关闭 */ } this.database = undefined; }
  constructor(dataDir: string, readonly eventCap = 500, readonly adminRetentionDays = 365) {
    try {
      mkdirSync(dataDir, { recursive: true });
      this.database = new DatabaseSync(path.join(dataDir, 'observability.sqlite'));
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
      // 旧库的 events.ticket 列改名 key（docs/DASHBOARD.md §9），历史数据保留；须先于下面按新列名建索引。
      renameColumn(this.db, 'events', 'ticket', 'key', { drop: ['events_ticket'], create: ['CREATE INDEX IF NOT EXISTS events_key ON events(key,id)'] });
      this.db.exec(`CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, scope TEXT NOT NULL, ts INTEGER NOT NULL,
        stage TEXT NOT NULL, status TEXT NOT NULL, duration_ms REAL, detail_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_key ON events(key,id);
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS metrics(ts INTEGER NOT NULL, name TEXT NOT NULL, labels_json TEXT NOT NULL, value REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS obs_state(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS metrics_ts ON metrics(ts);`);
      ensureMemoryTables(this.db);
      this.db.prepare('SELECT id,key,scope,ts,stage,status,duration_ms,detail_json FROM events LIMIT 0');
      this.db.prepare('SELECT ts,name,labels_json,value FROM metrics LIMIT 0');
      this.db.prepare('SELECT key,value FROM obs_state LIMIT 0');
    } catch { this.degrade(); }
  }
  append(e: Omit<ObsEvent, 'id' | 'detail_json'> & { detail?: unknown }): ObsEvent | undefined {
    if (this.degraded) return;
    let detail_json = JSON.stringify(redact(e.detail ?? {}));
    const scope = e.scope || (this.db.prepare('SELECT scope FROM events WHERE key=? AND scope<>? LIMIT 1').get(e.key, '') as { scope: string } | undefined)?.scope || '';
    const admin = e.key.startsWith('@') || ['settings_changed','prompt_changed','thread_reset'].includes(e.stage);
    if (admin) {
      const id = Number(this.db.prepare('INSERT INTO events(key,scope,ts,stage,status,duration_ms,detail_json) VALUES(?,?,?,?,?,?,?)')
        .run(e.key, scope, e.ts, e.stage, e.status, e.duration_ms, detail_json).lastInsertRowid);
      return { id, key: e.key, scope, ts: e.ts, stage: e.stage, status: e.status, duration_ms: e.duration_ms, detail_json };
    }
    const terminal = ['reply_sent','failed','fallback'].includes(e.stage) && (e.detail as { terminal?: boolean } | undefined)?.terminal === true;
    // 每种终态各预留一行与 1 KiB，摘要另预留一行；重复终态更新对应行。
    if (terminal) detail_json = JSON.stringify({ ...JSON.parse(detail_json), terminal: true });
    if (terminal && Buffer.byteLength(detail_json) > 1024) detail_json = JSON.stringify(redact({ terminal: true, failure: (e.detail as {failure?: unknown}).failure, truncated: true }));
    if (terminal) {
      const previous = this.db.prepare("SELECT id FROM events WHERE key=? AND stage=? AND json_extract(detail_json,'$.terminal')=1 LIMIT 1").get(e.key,e.stage) as {id:number} | undefined;
      if (previous) { this.db.prepare('DELETE FROM events WHERE id=?').run(previous.id); }
    }
    // 同一 Codex 调用的 started/updated 保留首条和最新条，最新条累计更新数。
    const detail = JSON.parse(detail_json);
    if (!terminal && e.status === 'started' && detail.backend === 'codex' && detail.call_id) {
      const progress = this.db.prepare("SELECT id,detail_json FROM events WHERE key=? AND stage=? AND status='started' AND json_extract(detail_json,'$.call_id')=? ORDER BY id").all(e.key,e.stage,String(detail.call_id)) as {id:number;detail_json:string}[];
      if (progress.length >= 2) {
        const last = progress[progress.length-1]!;
        const count = Number(JSON.parse(last.detail_json).count ?? 2) + 1;
        detail_json = JSON.stringify({...detail,count});
        const used = (this.db.prepare(`SELECT SUM(length(CAST(detail_json AS BLOB))) bytes FROM events WHERE key=? AND NOT ${ADMIN_EVENT_SQL}`).get(e.key) as {bytes:number}).bytes;
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
    const budget = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(length(CAST(detail_json AS BLOB))),0) bytes FROM events WHERE key=? AND NOT ${ADMIN_EVENT_SQL}`).get(e.key) as {n:number;bytes:number};
    if (!terminal && (budget.n >= Math.max(8,this.eventCap)-4 || budget.bytes+Buffer.byteLength(detail_json) > 256*1024-4096)) {
      const summary = this.db.prepare("SELECT id,detail_json FROM events WHERE key=? AND stage='events_dropped'").get(e.key) as {id:number;detail_json:string} | undefined;
      const dropped = Number(summary ? JSON.parse(summary.detail_json).dropped : 0)+1;
      const json = JSON.stringify({dropped});
      if (summary) this.db.prepare('UPDATE events SET ts=?,detail_json=? WHERE id=?').run(e.ts,json,summary.id);
      else this.db.prepare("INSERT INTO events(key,scope,ts,stage,status,duration_ms,detail_json) VALUES(?,?,?,'events_dropped','ok',NULL,?)").run(e.key,scope,e.ts,json);
      return;
    }
    const id = Number(this.db.prepare('INSERT INTO events(key,scope,ts,stage,status,duration_ms,detail_json) VALUES(?,?,?,?,?,?,?)')
      .run(e.key, scope, e.ts, e.stage, e.status, e.duration_ms, detail_json).lastInsertRowid);
    return { id, key: e.key, scope, ts: e.ts, stage: e.stage, status: e.status, duration_ms: e.duration_ms, detail_json };
  }
  events(key: string, options: number | { after?: number; limit?: number } = {}): ObsEvent[] {
    if (this.degraded) return [];
    const {after=0,limit=500} = typeof options === 'number' ? {limit:options} : options;
    return this.db.prepare('SELECT * FROM events WHERE key=? AND id>? ORDER BY id LIMIT ?').all(key,
      Number.isFinite(after) ? Math.max(0,Math.floor(after)) : 0, Number.isFinite(limit) ? Math.max(1,Math.min(2000,Math.floor(limit))) : 500) as unknown as ObsEvent[];
  }
  /** 回合（turn: 键）聚合：会话、种类、后端、发送者与结果（终态事件 detail.status，缺省按 stage）。 */
  private turnQuery(where = '1=1'): string { return `SELECT key, MAX(scope) scope, MIN(ts) ts, MAX(ts) updated,
    COALESCE(MAX(CASE WHEN stage IN ('reply_sent','failed') THEN json_extract(detail_json,'$.thread_key') END),
      MAX(CASE WHEN stage IN ('received','dispatched') THEN COALESCE(json_extract(detail_json,'$.thread_key'),json_extract(detail_json,'$.conversation_key')) END)) thread,
    COALESCE(MAX(CASE WHEN stage IN ('reply_sent','failed') THEN json_extract(detail_json,'$.kind') END),
      MAX(CASE WHEN stage='dispatched' THEN json_extract(detail_json,'$.kind') END),
      MAX(CASE WHEN stage='received' THEN json_extract(detail_json,'$.kind') END)) kind,
    MAX(CASE WHEN stage='dispatched' THEN json_extract(detail_json,'$.backend') END) backend,
    MAX(CASE WHEN stage='received' THEN NULLIF(json_extract(detail_json,'$.sender'),'') END) sender,
    COALESCE((SELECT COALESCE(json_extract(t.detail_json,'$.status'),CASE WHEN t.stage='failed' THEN 'failed' ELSE 'completed' END)
      FROM events t WHERE t.key=e.key AND t.stage IN ('failed','reply_sent') AND json_extract(t.detail_json,'$.terminal')=1 ORDER BY t.id DESC LIMIT 1),'processing') status,
    MAX(ts)-MIN(ts) duration_ms FROM events e WHERE key LIKE 'turn:%' AND ${where} GROUP BY key`; }
  /** 回合列表（最新在前，每页 50）；筛选 status / thread / backend / kind。 */
  turns(filters: TurnFilters = {}): TurnRow[] {
    if (this.degraded) return [];
    const args: SQLInputValue[] = [];
    const clauses = ['1=1'];
    for (const key of ['status', 'thread', 'backend', 'kind'] as const) if (filters[key]) { clauses.push(`${key}=?`); args.push(filters[key]!); }
    return this.db.prepare(`SELECT * FROM (${this.turnQuery()}) WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT 50 OFFSET ?`)
      .all(...args, Math.max(0, Math.floor(filters.page ?? 0)) * 50) as unknown as TurnRow[];
  }
  /** 有回合记录的会话，最近活动在前（回合页的会话列表）。 */
  threads(limit = 100): { thread: string; updated: number; turns: number }[] {
    if (this.degraded) return [];
    return this.db.prepare(`SELECT thread, MAX(updated) updated, COUNT(*) turns FROM (${this.turnQuery()}) WHERE thread IS NOT NULL GROUP BY thread ORDER BY updated DESC LIMIT ?`)
      .all(Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as { thread: string; updated: number; turns: number }[];
  }
  /**
   * 聊天视图：一批键（turn: / in:，最多 300 个）的输入、开轮、发送与终态事件；模型请求与已结束的工具调用只用于计数，
   * 正文换成 {}，避免整页读入工具输出。
   */
  chatEvents(keys: readonly string[]): ObsEvent[] {
    if (this.degraded || !keys.length) return [];
    const ids = [...new Set(keys)].slice(0, 300);
    return this.db.prepare(`SELECT id,key,scope,ts,stage,status,duration_ms,CASE WHEN stage IN (${CHAT_STAGES}) THEN detail_json ELSE '{}' END detail_json FROM events
      WHERE key IN (${ids.map(() => '?').join(',')}) AND (stage IN (${CHAT_STAGES}) OR stage='model_request' OR (stage LIKE 'tool:%' AND status<>'started')) ORDER BY id`).all(...ids) as unknown as ObsEvent[];
  }
  /** 最多 300 个不同回合；先限定聚合范围，再批量读取事件并在内存归并。旧版键（非 turn:）没有聚合行，不在结果里。 */
  turnBriefs(keys: readonly string[]): Map<string, TurnBrief> {
    const briefs = new Map<string, TurnBrief>();
    if (this.degraded || !keys.length) return briefs;
    const ids = [...new Set(keys)].slice(0, 300);
    const where = `key IN (${ids.map(() => '?').join(',')})`;
    const rows = this.db.prepare(this.turnQuery(where)).all(...ids) as unknown as TurnRow[];
    const events = this.db.prepare(`SELECT key,stage,status,detail_json FROM events WHERE ${where} ORDER BY id`)
      .all(...ids) as Pick<ObsEvent, 'key' | 'stage' | 'status' | 'detail_json'>[];
    const groups = new Map<string, { stage: string; status: string; detail: Record<string, unknown> }[]>();
    for (const event of events) {
      const parsed: unknown = JSON.parse(event.detail_json);
      const detail = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      const group = groups.get(event.key) ?? [];
      if (!groups.has(event.key)) groups.set(event.key, group);
      group.push({ stage: event.stage, status: event.status, detail });
    }
    for (const { key, scope, ts, status, sender, backend, thread, kind, duration_ms } of rows) {
      const group = groups.get(key) ?? [];
      const received = group.find(e => e.stage === 'received');
      // 回复取本轮最后一条发出的消息正文；没有发送时取模型的最终回答（未发送）。
      const sent = group.filter(e => e.stage === 'send_message' && typeof e.detail.text === 'string').at(-1);
      const answer = group.filter(e => e.stage === 'final_answer').at(-1);
      const reply = sent ? sent.detail.text : answer?.detail.text;
      const settings = group.filter(e => e.stage === 'dispatched').map(e => e.detail.settings)
        .find((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
      briefs.set(key, { key, scope, ts, status, sender, backend, thread, kind, duration_ms,
        text: received ? String(received.detail.text ?? '') : '', reply: typeof reply === 'string' ? reply : '',
        tools: group.filter(e => e.stage.toLowerCase().startsWith('tool:') && e.status !== 'started').length,
        sends: group.filter(e => e.stage === 'send_message').length,
        ...(settings ? { settings } : {}),
      });
    }
    return briefs;
  }
  /** since 之后结束的回合数与失败数（failed / lost），以及开轮的输入数（admitted）。 */
  throughput(since: number): { total: number; failed: number; error_rate: number; inbound: number } {
    if (this.degraded) return { total: 0, failed: 0, error_rate: 0, inbound: 0 };
    const row = this.db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(status IN ('failed','lost')),0) failed FROM (${this.turnQuery()}) WHERE updated>=? AND status<>'processing'`)
      .get(since) as { total: number; failed: number };
    const inbound = this.db.prepare("SELECT COUNT(DISTINCT key) n FROM events WHERE stage='admitted' AND ts>=?").get(since) as { n: number };
    return { ...row, error_rate: row.total ? row.failed / row.total : 0, inbound: inbound.n };
  }
  metric(ts: number, name: string, labels: object, value: number): void {
    if (!this.degraded && Number.isFinite(value)) this.db.prepare('INSERT INTO metrics VALUES(?,?,?,?)').run(ts, name, JSON.stringify(redact(labels)), value);
  }
  /**
   * 默认每线程 40 次请求、最多 200 次；只读取最近至多 2000 条请求/旧回合/压缩。
   * 线程按最近活动倒序，线程内按 ts/id 升序；截断边界不补读历史基准。
   * analysis 覆盖判定阈值（面板 ?miss=&partial= 临时覆盖，仅影响展示）。
   */
  contextSeries(opts: { limit?: number; since?: number; backend?: string; key?: string; analysis?: ContextAnalysisOptions } = {}): ThreadContextSeries[] {
    if (this.degraded) return [];
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(200, Math.floor(opts.limit!))) : 40;
    const clauses = [`(${CONTEXT_REQUEST_SQL} OR (stage='context_usage' AND json_extract(detail_json,'$.source')='compact'))`];
    const args: SQLInputValue[] = [];
    if (Number.isFinite(opts.since)) { clauses.push(`${CONTEXT_TS_SQL}>=?`); args.push(opts.since!); }
    for (const field of ['backend', 'key'] as const) if (opts[field] !== undefined) {
      clauses.push(`json_extract(detail_json,'$.${field}')=?`); args.push(opts[field]!);
    }
    // 去除重复回合后再取有界快照；压缩分隔不占每线程的请求预算。
    const rows = this.db.prepare(`SELECT ts,key,stage,detail_json FROM (
      SELECT id,ts,key,stage,detail_json FROM events INDEXED BY events_ts
      WHERE ${clauses.join(' AND ')} ORDER BY ts DESC,id DESC LIMIT 2000
    ) ORDER BY ${CONTEXT_TS_SQL} DESC,id DESC`).all(...args) as ContextRow[];
    const events = rows.flatMap(row => { const event = contextEvent(row); return event ? [event] : []; });
    const threadId = (event: ContextEvent) => JSON.stringify([event.detail.backend, event.detail.key]);
    const budget = Math.min(2000, new Set(events.map(threadId)).size * limit);
    const groups = new Map<string, ContextEvent[]>();
    const counts = new Map<string, number>();
    let requests = 0;
    for (const event of events) {
      const id = threadId(event);
      const isRequest = event.kind === 'request' || event.detail.source === 'turn';
      if (isRequest && requests++ >= budget) break;
      const count = counts.get(id) ?? 0;
      if (count >= limit) continue;
      const group = groups.get(id) ?? [];
      if (!groups.has(id)) groups.set(id, group);
      group.push(event);
      if (isRequest) counts.set(id, count + 1);
    }
    const retained = [...groups.values()].flat();
    if (!retained.length) return [];
    const start = Math.min(...retained.map(event => event.ts)), end = Math.max(...retained.map(event => event.ts));
    const systemRows = this.db.prepare(`SELECT ts,stage,detail_json FROM events INDEXED BY events_ts
      WHERE ts>=? AND ts<=? AND key='@settings' AND stage IN ('settings_changed','prompt_changed')
      ORDER BY ts DESC,id DESC LIMIT 500`).all(start, end) as Pick<ObsEvent, 'ts' | 'stage' | 'detail_json'>[];
    const system: SystemEvent[] = systemRows.reverse().flatMap(row => {
      const detail: unknown = JSON.parse(row.detail_json);
      return detail && typeof detail === 'object' && !Array.isArray(detail) ? [{ ts: row.ts, stage: row.stage, detail: detail as Record<string, unknown> }] : [];
    });
    const resetRows = this.db.prepare(`SELECT ts,stage,detail_json FROM events INDEXED BY events_ts
      WHERE ts>=? AND ts<=? AND stage='thread_reset' ORDER BY ts DESC,id DESC LIMIT 500`)
      .all(start, end) as Pick<ObsEvent, 'ts' | 'stage' | 'detail_json'>[];
    const resets: SystemEvent[] = resetRows.reverse().flatMap(row => {
      const detail: unknown = JSON.parse(row.detail_json);
      return detail && typeof detail === 'object' && !Array.isArray(detail) ? [{ ts: row.ts, stage: row.stage, detail: detail as Record<string, unknown> }] : [];
    });
    return [...groups.values()].map(events => {
      events.reverse();
      const { backend, key } = events[0].detail;
      // 保留线程重置事件供分析；设计的 reset 判定仍以回合计数回到 1 为准。
      const threadResets = resets.filter(event => event.detail.backend === backend &&
        (event.detail.key ?? event.detail[backend === 'codex' ? 'thread_key' : 'conversation_key']) === key);
      const turns = analyzeContextTurns(events, [...system, ...threadResets], opts.analysis);
      const requests = turns.filter(turn => turn.source === 'turn');
      return { backend, key, turns, requests: requests.length, turnCount: new Set(requests.map(turn => turn.key)).size,
        misses: turns.filter(turn => turn.mark === 'miss').length, window: turns.at(-1)!.window };
    });
  }
  /** 严格早于 beforeTs 的最近请求；同一 trace 键有请求时忽略旧用量记录，压缩与估算不作为基准。 */
  previousContextTurn(backend: 'codex' | 'pi', key: string, beforeTs: number): ContextEvent | undefined {
    if (this.degraded || !Number.isFinite(beforeTs)) return;
    const rows = this.db.prepare(`SELECT ts,key,stage,detail_json FROM events INDEXED BY events_ts
      WHERE ${CONTEXT_TS_SQL}<? AND ${CONTEXT_REQUEST_SQL} AND json_extract(detail_json,'$.backend')=?
      AND json_extract(detail_json,'$.key')=?
      ORDER BY ${CONTEXT_TS_SQL} DESC,CASE WHEN stage='model_request' THEN 1 ELSE 0 END DESC,id DESC`).iterate(beforeTs, backend, key);
    for (const row of rows) {
      const event = contextEvent(row as ContextRow);
      if (event) return event;
    }
  }
  /** 最近的系统事件（@ 开头的键，例如 @settings）。 */
  systemEvents(key: string, limit = 20): ObsEvent[] {
    if (this.degraded) return [];
    return this.db.prepare('SELECT * FROM events WHERE key=? ORDER BY id DESC LIMIT ?').all(key, Math.max(1, Math.min(200, limit))) as unknown as ObsEvent[];
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
