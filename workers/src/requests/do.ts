import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { RequestDetail, RequestQuery, RequestRecord, ToolTrace, ToolSummary } from "./types";
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
      CREATE TABLE IF NOT EXISTS request_revision (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO request_revision VALUES(1,0);
      CREATE TABLE IF NOT EXISTS tool_traces (id TEXT PRIMARY KEY, thread TEXT NOT NULL, turn_id TEXT NOT NULL, call_id TEXT NOT NULL,
        started INTEGER NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, payload TEXT, bytes INTEGER NOT NULL,
        UNIQUE(thread,turn_id,call_id));
      CREATE INDEX IF NOT EXISTS tool_traces_turn ON tool_traces(thread,turn_id,revision);
    `);
    const columns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(requests)").toArray();
    if (!columns.some(c => c.name === "turn_id")) ctx.storage.sql.exec("ALTER TABLE requests ADD COLUMN turn_id TEXT");
    if (!columns.some(c => c.name === "revision")) ctx.storage.sql.exec("ALTER TABLE requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS requests_turn ON requests(thread,turn_id,revision)");
  }
  private revision() { return this.ctx.storage.sql.exec<{ revision: number }>("UPDATE request_revision SET revision=revision+1 WHERE id=1 RETURNING revision").one().revision; }
  async record(detail: RequestDetail): Promise<void> {
    const r = detail.request, sql = this.ctx.storage.sql;
    // 重投与乱序开始事件不会覆盖终态。
    const previous = sql.exec<{ status: string }>("SELECT status FROM requests WHERE id = ?", r.id).toArray()[0];
    if (previous && previous.status !== "running" && (previous.status !== "interrupted" || r.status === "running")) return;
    sql.exec(`INSERT INTO requests(id,started,thread,model,purpose,status,input_tokens,output_tokens,cache_read,duration,record,turn_id,revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens,cache_read=excluded.cache_read,duration=excluded.duration,record=excluded.record,turn_id=excluded.turn_id,revision=excluded.revision`,
      r.id, r.startedAt, r.thread, r.provider + "/" + r.model, r.purpose, r.status, r.inputTokens, r.outputTokens, r.cacheRead, r.durationMs, JSON.stringify(r), r.binding?.turnId ?? null, this.revision());
    const payload = JSON.stringify({ context: detail.context, response: detail.response });
    sql.exec("INSERT OR REPLACE INTO request_details(id,started,bytes,payload) VALUES(?,?,?,?)",
      r.id, r.startedAt, new TextEncoder().encode(payload).byteLength, payload);
    this.prune();
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  async recordTool(trace: ToolTrace) {
    const { arguments: args, result, ...summary } = trace, sql = this.ctx.storage.sql;
    const previous = sql.exec<{ record: string }>("SELECT record FROM tool_traces WHERE id=?", trace.id).toArray()[0];
    const previousStatus = previous ? (JSON.parse(previous.record) as ToolSummary).status : undefined;
    if (previousStatus && previousStatus !== "running" && (previousStatus !== "interrupted" || trace.status === "running")) return;
    const payload = JSON.stringify({ arguments: args, result });
    sql.exec(`INSERT INTO tool_traces(id,thread,turn_id,call_id,started,revision,record,payload,bytes) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record,payload=excluded.payload,bytes=excluded.bytes`,
      trace.id, trace.thread, trace.binding.turnId, trace.callId, trace.startedAt, this.revision(), JSON.stringify(summary), payload, new TextEncoder().encode(payload).byteLength);
    this.prune();
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  private prune() {
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec("DELETE FROM requests WHERE started < ? OR seq IN (SELECT seq FROM requests ORDER BY seq DESC LIMIT -1 OFFSET 20000)", now - 30 * DAY);
    sql.exec("DELETE FROM request_details WHERE started < ? OR id NOT IN (SELECT id FROM requests)", now - 7 * DAY);
    sql.exec("DELETE FROM tool_traces WHERE started < ? OR (started < ? AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.thread=tool_traces.thread AND r.turn_id=tool_traces.turn_id))", now - 30 * DAY, now - 3600_000);
    sql.exec("UPDATE tool_traces SET payload=NULL,bytes=0 WHERE payload IS NOT NULL AND started < ?", now - 7 * DAY);
    const expired = sql.exec<{ id: string; kind: string }>(`SELECT id,kind FROM (
      SELECT id,kind,SUM(bytes) OVER (ORDER BY started DESC,id DESC) AS total FROM (
        SELECT id,started,bytes,'request' AS kind FROM request_details UNION ALL
        SELECT id,started,bytes,'tool' AS kind FROM tool_traces WHERE payload IS NOT NULL)) WHERE total > 33554432`).toArray();
    for (const row of expired) {
      if (row.kind === "request") sql.exec("DELETE FROM request_details WHERE id=?", row.id);
      else sql.exec("UPDATE tool_traces SET payload=NULL,bytes=0 WHERE id=?", row.id);
    }
    const stale = sql.exec<{ id: string; record: string }>("SELECT id,record FROM requests WHERE status='running' AND started < ?", now - 3600_000).toArray();
    for (const row of stale) {
      const r: RequestRecord = JSON.parse(row.record); r.status = "interrupted";
      sql.exec("UPDATE requests SET status='interrupted',record=?,revision=? WHERE id=?", JSON.stringify(r), this.revision(), row.id);
    }
    for (const row of sql.exec<{ id: string; record: string }>("SELECT id,record FROM tool_traces WHERE started < ? AND json_extract(record,'$.status')='running'", now - 3600_000).toArray()) {
      const trace: ToolSummary = JSON.parse(row.record); trace.status = "interrupted";
      sql.exec("UPDATE tool_traces SET record=?,revision=? WHERE id=?", JSON.stringify(trace), this.revision(), row.id);
    }
  }
  override async alarm() {
    this.prune();
    if (this.ctx.storage.sql.exec("SELECT 1 FROM requests UNION ALL SELECT 1 FROM tool_traces LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  private filter(q: RequestQuery) {
    const where = ["started >= ?", "started <= ?"], args: (string | number)[] = [q.since, q.until];
    for (const [column, value] of [["thread", q.thread], ["model", q.model], ["status", q.status], ["purpose", q.purpose], ["turn_id", q.turnId]] as const) {
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
    const columns = "COUNT(*) AS requests, COALESCE(SUM(CASE WHEN status IN ('error','aborted','interrupted') THEN 1 ELSE 0 END),0) AS failed, COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) AS running, COUNT(input_tokens) AS measured, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read),0) AS cacheRead, COALESCE(SUM(CASE WHEN cache_read IS NOT NULL THEN input_tokens ELSE 0 END),0) AS cacheInputTokens, COUNT(cache_read) AS cacheMeasured, AVG(duration) AS avgDuration";
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
    const request: RequestRecord = JSON.parse(r.record);
    const tools = request.binding ? this.ctx.storage.sql.exec<{ record: string; available: number }>(
      "SELECT record,payload IS NOT NULL AS available FROM tool_traces WHERE thread=? AND turn_id=? ORDER BY started,id", request.thread, request.binding.turnId).toArray()
      .filter(row => { const t: ToolSummary = JSON.parse(row.record); return request.toolCalls?.some(call => call.id === t.callId || call.id === t.parentCallId); })
      .map(row => ({ ...JSON.parse(row.record) as ToolSummary, detailAvailable: !!row.available })) : [];
    const related = request.binding ? this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM requests WHERE thread=? AND turn_id=? ORDER BY started,seq", request.thread, request.binding.turnId).toArray().map(row => JSON.parse(row.record) as RequestRecord) : [];
    return { request, ...(d ? JSON.parse(d.payload) as Pick<RequestDetail, "context" | "response"> : {}), tools, related, detailAvailable: !!d };
  }
  toolDetail(id: string) {
    const row = this.ctx.storage.sql.exec<{ record: string; payload: string | null }>("SELECT record,payload FROM tool_traces WHERE id=?", id).toArray()[0];
    return row ? { ...JSON.parse(row.record) as ToolSummary, ...(row.payload ? JSON.parse(row.payload) as Pick<ToolTrace, "arguments" | "result"> : {}), detailAvailable: !!row.payload } : undefined;
  }
  turnTrace(thread: string, turns: string[], after: number) {
    if (!turns.length) return { requests: [], tools: [], cursor: after, more: false };
    const marks = turns.map(() => "?").join(","), sql = this.ctx.storage.sql;
    const filter = `thread=? AND turn_id IN (${marks}) AND revision>?`;
    const changed = sql.exec<{ kind: string; record: string; revision: number }>(
      `SELECT 'request' AS kind,record,revision FROM requests WHERE ${filter} UNION ALL
       SELECT 'tool' AS kind,record,revision FROM tool_traces WHERE ${filter} ORDER BY revision LIMIT 201`,
      thread, ...turns, after, thread, ...turns, after).toArray();
    const page = changed.slice(0, 200);
    return { requests: page.filter(r => r.kind === "request").map(r => JSON.parse(r.record) as RequestRecord),
      tools: page.filter(r => r.kind === "tool").map(r => JSON.parse(r.record) as ToolSummary),
      cursor: page.at(-1)?.revision ?? sql.exec<{ revision: number }>("SELECT revision FROM request_revision WHERE id=1").one().revision, more: changed.length > 200 };
  }
}
