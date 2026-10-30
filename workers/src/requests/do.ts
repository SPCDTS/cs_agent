import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { RequestDetail, RequestQuery, RequestRecord } from "./types";
const DAY = 86_400_000;
type Row = { seq: number; record: string; available: number };
export class RequestsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, started INTEGER NOT NULL,
        thread TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, duration INTEGER, record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_started ON requests(started);
      CREATE INDEX IF NOT EXISTS requests_thread ON requests(thread, started);
      CREATE TABLE IF NOT EXISTS request_details (id TEXT PRIMARY KEY, started INTEGER NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL);
    `);
  }
  async record(detail: RequestDetail): Promise<void> {
    const r = detail.request, sql = this.ctx.storage.sql;
    // 重投与乱序开始事件不会覆盖终态。
    const previous = sql.exec<{ status: string }>("SELECT status FROM requests WHERE id = ?", r.id).toArray()[0];
    if (previous && previous.status !== "running" && (previous.status !== "interrupted" || r.status === "running")) return;
    sql.exec(`INSERT INTO requests(id,started,thread,model,purpose,status,input_tokens,output_tokens,cache_read,duration,record)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens,cache_read=excluded.cache_read,duration=excluded.duration,record=excluded.record`,
      r.id, r.startedAt, r.thread, r.provider + "/" + r.model, r.purpose, r.status, r.inputTokens, r.outputTokens, r.cacheRead, r.durationMs, JSON.stringify(r));
    const payload = JSON.stringify({ context: detail.context, response: detail.response });
    sql.exec("INSERT OR REPLACE INTO request_details(id,started,bytes,payload) VALUES(?,?,?,?)",
      r.id, r.startedAt, new TextEncoder().encode(payload).byteLength, payload);
    this.prune();
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  private prune() {
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec("DELETE FROM requests WHERE started < ? OR seq IN (SELECT seq FROM requests ORDER BY seq DESC LIMIT -1 OFFSET 20000)", now - 30 * DAY);
    sql.exec("DELETE FROM request_details WHERE started < ? OR id NOT IN (SELECT id FROM requests)", now - 7 * DAY);
    sql.exec(`DELETE FROM request_details WHERE id IN (
      SELECT id FROM (SELECT id, SUM(bytes) OVER (ORDER BY started DESC, id DESC) AS total FROM request_details) WHERE total > 33554432)`);
    const stale = sql.exec<{ id: string; record: string }>("SELECT id,record FROM requests WHERE status='running' AND started < ?", now - 3600_000).toArray();
    for (const row of stale) {
      const r: RequestRecord = JSON.parse(row.record); r.status = "interrupted";
      sql.exec("UPDATE requests SET status='interrupted',record=? WHERE id=?", JSON.stringify(r), row.id);
    }
  }
  override async alarm() {
    this.prune();
    if (this.ctx.storage.sql.exec("SELECT 1 FROM requests LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  private filter(q: RequestQuery) {
    const where = ["started >= ?", "started <= ?"], args: (string | number)[] = [q.since, q.until];
    for (const [column, value] of [["thread", q.thread], ["model", q.model], ["status", q.status], ["purpose", q.purpose]] as const) {
      if (value) { where.push(column + " = ?"); args.push(value); }
    }
    return { where: where.join(" AND "), args };
  }
  list(q: RequestQuery) {
    const { where, args } = this.filter(q);
    const rows = this.ctx.storage.sql.exec<Row>("SELECT seq,record,EXISTS(SELECT 1 FROM request_details d WHERE d.id=requests.id) AS available FROM requests WHERE " +
      where + (q.before ? " AND seq < ?" : "") + " ORDER BY seq DESC LIMIT ?", ...args, ...(q.before ? [q.before] : []), q.limit + 1).toArray();
    const page = rows.slice(0, q.limit);
    return { requests: page.map(row => ({ ...JSON.parse(row.record) as RequestRecord, detailAvailable: !!row.available })),
      ...(rows.length > q.limit ? { next: page.at(-1)!.seq } : {}) };
  }
  usage(q: RequestQuery) {
    const { where, args } = this.filter(q), sql = this.ctx.storage.sql;
    const columns = "COUNT(*) AS requests, COALESCE(SUM(CASE WHEN status IN ('error','aborted','interrupted') THEN 1 ELSE 0 END),0) AS failed, COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) AS running, COUNT(input_tokens) AS measured, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read),0) AS cacheRead, AVG(duration) AS avgDuration";
    const summary = sql.exec("SELECT " + columns + " FROM requests WHERE " + where, ...args).one();
    const bucket = q.until - q.since <= 2 * DAY ? 3600_000 : DAY;
    const series = sql.exec("SELECT CAST((started + 28800000) / ? AS INTEGER) * ? - 28800000 AS at, " + columns + " FROM requests WHERE " + where + " GROUP BY at ORDER BY at",
      bucket, bucket, ...args).toArray();
    const models = sql.exec("SELECT model, " + columns + " FROM requests WHERE " + where + " GROUP BY model ORDER BY inputTokens + outputTokens DESC", ...args).toArray();
    const first = sql.exec<{ at: number | null }>("SELECT MIN(started) AS at FROM requests").one().at;
    const choices = sql.exec<{ model: string }>("SELECT DISTINCT model FROM requests ORDER BY model").toArray().map(r => r.model);
    return { summary, series, models, choices, bucket, retainedSince: first, retention: { metadataDays: 30, detailsDays: 7, maxRequests: 20000, maxDetailBytes: 33554432 } };
  }
  detail(id: string) {
    const r = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM requests WHERE id=?", id).toArray()[0];
    if (!r) return;
    const d = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM request_details WHERE id=?", id).toArray()[0];
    return { request: JSON.parse(r.record) as RequestRecord, ...(d ? JSON.parse(d.payload) as Pick<RequestDetail, "context" | "response"> : {}), detailAvailable: !!d };
  }
}
