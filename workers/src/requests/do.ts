import { ToolStore } from "./tool-store";
import { ContextStore, contextMetadata } from "./context-store";
import { ProjectionStore, viewName, type ProjectionBatch } from "./projection";
import { AgentReadView } from "./view";
import { subagentName, RETENTION_MS, type SubagentMeta } from "../subagent/model";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { RequestDetail, RequestQuery, RequestRecord, ToolTrace, ToolSummary } from "./types";
import { readAgentTopology, type AgentTopology } from "./topology";
import type { SubagentActivity } from "../subagent/activity";
import { RequestRetention, REQUEST_RETENTION } from "./retention";
const DAY = 86_400_000;
type Row = { seq: number; record: string; available: number };
export class RequestsDO extends DurableObject<Env> {
  contextTimeline(...args: Parameters<ContextStore["timeline"]>) { return new ContextStore(this.ctx.storage.sql).timeline(...args); }
  contextInspection(id: string) { return new ContextStore(this.ctx.storage.sql).inspect(id); }
  contextPart(id: string, part: string) { return new ContextStore(this.ctx.storage.sql).part(id, part); }
  toolExecution(id: string) { return new ToolStore(this.ctx.storage.sql).execution(id); }
  private topologyCache?: AgentTopology;
  private retentionStore?: RequestRetention;
  private retention() { return this.retentionStore ??= new RequestRetention(this.ctx.storage); }
  private readonly projection = new ProjectionStore(this.ctx, this.env);
  projectionStatus() { const state = this.projection.status(); return { ready: !!state?.ready, syncedAt: state?.synced_at ?? null }; }
  private readView() { const state = this.projection.status(); if (!state?.ready) throw new Error("view_pending"); return new AgentReadView(this.projection, state.scope); }
  async applyProjection(batch: ProjectionBatch): Promise<void> {
    this.projection.apply(batch);
    if (batch.scope.startsWith("sub:")) {
      const row = await this.projection.db.get<{value:string}>("SELECT value FROM meta WHERE key='subagent'");
      const meta: SubagentMeta | undefined = row ? JSON.parse(row.value) : undefined;
      if (meta?.endedAt) await this.ctx.storage.setAlarm(meta.endedAt + RETENTION_MS);
      else await this.ctx.storage.deleteAlarm();
    }
  }
  async projectionBackfillNeeded() { return await this.ctx.storage.get("admin-projection-v1") !== true; }
  async projectionBackfillDone() { await this.ctx.storage.put("admin-projection-v1", true); }

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
      CREATE TABLE IF NOT EXISTS agent_activity (thread TEXT NOT NULL, actor TEXT NOT NULL, updated INTEGER NOT NULL,
        version INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(thread,actor));
      CREATE INDEX IF NOT EXISTS agent_activity_updated ON agent_activity(updated);
    `);
    const columns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(requests)").toArray();
    if (!columns.some(c => c.name === "turn_id")) ctx.storage.sql.exec("ALTER TABLE requests ADD COLUMN turn_id TEXT");
    if (!columns.some(c => c.name === "revision")) ctx.storage.sql.exec("ALTER TABLE requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS tool_traces_actor_call ON tool_traces(thread,COALESCE(json_extract(record,'$.actor'),'thread'),call_id,started)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS requests_actor_started ON requests(thread,json_extract(record,'$.actor'),started,id)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS requests_turn ON requests(thread,turn_id,revision)");
  }
  sessionHistory(...args: Parameters<AgentReadView["sessionHistory"]>) { return this.readView().sessionHistory(...args); }
  events(...args: Parameters<AgentReadView["events"]>) { return this.readView().events(...args); }
  memoryCandidates(...args: Parameters<AgentReadView["memoryCandidates"]>) { return this.readView().memoryCandidates(...args); }
  memoryList(...args: Parameters<AgentReadView["memoryList"]>) { return this.readView().memoryList(...args); }
  memoryDetail(...args: Parameters<AgentReadView["memoryDetail"]>) { return this.readView().memoryDetail(...args); }
  memoryJobs(...args: Parameters<AgentReadView["memoryJobs"]>) { return this.readView().memoryJobs(...args); }
  memoryProposals(...args: Parameters<AgentReadView["memoryProposals"]>) { return this.readView().memoryProposals(...args); }
  memoryView(...args: Parameters<AgentReadView["memoryView"]>) { return this.readView().memoryView(...args); }
  mcpAccess(...args: Parameters<AgentReadView["mcpAccess"]>) { return this.readView().mcpAccess(...args); }
  mcpApprovals(...args: Parameters<AgentReadView["mcpApprovals"]>) { return this.readView().mcpApprovals(...args); }
  mcpToolCounts(...args: Parameters<AgentReadView["mcpToolCounts"]>) { return this.readView().mcpToolCounts(...args); }
  async subagentList() {
    const view = this.readView(), scope = this.projection.status()!.scope;
    if (!scope.startsWith("thread:")) throw new Error("view_scope_mismatch");
    const topology = await this.env.REQUESTS.getByName("main").agentTopology();
    const activity = Object.fromEntries(topology.nodes.flatMap(node => node.kind === "subagent" && node.thread === scope.slice(7) && node.lastActiveAt !== null ? [[node.actor, node.lastActiveAt]] : []));
    return view.subagentList(activity);
  }
  workspaceChild(...args: Parameters<AgentReadView["workspaceChild"]>) { return this.readView().workspaceChild(...args); }
  transcriptSummary(...args: Parameters<AgentReadView["transcriptSummary"]>) { return this.readView().transcriptSummary(...args); }
  async chatView(...args: Parameters<AgentReadView["chatView"]>) { return {...await this.readView().chatView(...args), syncedAt: this.projection.status()!.synced_at}; }
  async stats() { return {...await this.readView().stats(), syncedAt: this.projection.status()!.synced_at}; }
  modelHistory(...args: Parameters<AgentReadView["modelHistory"]>) { return this.readView().modelHistory(...args); }
  subagentConversation(...args: Parameters<AgentReadView["subagentConversation"]>) { return this.readView().subagentConversation(...args); }
  async subagentHistory(id: string, cursor?: string): Promise<Awaited<ReturnType<AgentReadView["subagentConversation"]>> | undefined> {
    return (await this.childView(id))?.subagentConversation(cursor);
  }
  async subagentTranscript(id: string, limit: number): ReturnType<AgentReadView["transcriptSummary"]> {
    return (await this.childView(id))?.transcriptSummary(limit);
  }
  private async childView(id: string): Promise<DurableObjectStub<RequestsDO> | undefined> {
    const state = this.projection.status(); if (!state?.scope.startsWith("thread:")) throw new Error("view_pending");
    const child = await this.readView().child(id); if (!child) return;
    if (child.ended_at !== null && Date.now() >= child.ended_at + RETENTION_MS) return;
    return this.env.REQUESTS.getByName(viewName(subagentName(state.scope.slice(7), id)));
  }

  private revision() { return this.ctx.storage.sql.exec<{ revision: number }>("UPDATE request_revision SET revision=revision+1 WHERE id=1 RETURNING revision").one().revision; }
  async recordAgent(activity: SubagentActivity): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT INTO agent_activity(thread,actor,updated,version,record) VALUES(?,?,?,?,?)
      ON CONFLICT(thread,actor) DO UPDATE SET updated=excluded.updated,version=excluded.version,record=excluded.record
      WHERE excluded.version>agent_activity.version`, activity.thread, activity.actor, activity.updatedAt, activity.version, JSON.stringify(activity));
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  async record(detail: RequestDetail): Promise<void> {
    const r = detail.request, sql = this.ctx.storage.sql;
    if (r.startedAt < Date.now() - REQUEST_RETENTION.metadataMs) return;
    const retention = this.retention();
    // 重投与乱序开始事件不会覆盖终态。
    const previous = sql.exec<{ status: string }>("SELECT status FROM requests WHERE id = ?", r.id).toArray()[0];
    if (previous && previous.status !== "running" && (previous.status !== "interrupted" || r.status === "running")) return;
    sql.exec(`INSERT INTO requests(id,started,thread,model,purpose,status,input_tokens,output_tokens,cache_read,duration,record,turn_id,revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens,cache_read=excluded.cache_read,duration=excluded.duration,record=excluded.record,turn_id=excluded.turn_id,revision=excluded.revision`,
      r.id, r.startedAt, r.thread, r.provider + "/" + r.model, r.purpose, r.status, r.inputTokens, r.outputTokens, r.cacheRead, r.durationMs, JSON.stringify(r), r.binding?.turnId ?? null, this.revision());
    const payload = JSON.stringify({ context: detail.context, response: detail.response });
    if (r.startedAt >= Date.now() - REQUEST_RETENTION.detailsMs) sql.exec(`INSERT INTO request_details(id,started,bytes,payload) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET started=excluded.started,bytes=excluded.bytes,payload=excluded.payload`,
      r.id, r.startedAt, new TextEncoder().encode(payload).byteLength, payload);
    else sql.exec("DELETE FROM request_details WHERE id=?", r.id);
    const more = retention.trim({ kind: "request", id: r.id });
    if (more || await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + (more ? 1000 : 3600_000));
  }
  async recordTool(trace: ToolTrace) {
    const { arguments: args, result, structuredResult, ...summary } = trace, sql = this.ctx.storage.sql;
    if (trace.startedAt < Date.now() - REQUEST_RETENTION.metadataMs) return;
    const retention = this.retention();
    const previous = sql.exec<{ record: string }>("SELECT record FROM tool_traces WHERE id=?", trace.id).toArray()[0];
    const previousStatus = previous ? (JSON.parse(previous.record) as ToolSummary).status : undefined;
    if (previousStatus && previousStatus !== "running" && (previousStatus !== "interrupted" || trace.status === "running")) return;
    const payload = trace.startedAt >= Date.now() - REQUEST_RETENTION.detailsMs ? JSON.stringify({ arguments: args, result, structuredResult }) : null;
    sql.exec(`INSERT INTO tool_traces(id,thread,turn_id,call_id,started,revision,record,payload,bytes) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record,payload=excluded.payload,bytes=excluded.bytes`,
      trace.id, trace.thread, trace.binding.turnId, trace.callId, trace.startedAt, this.revision(), JSON.stringify(summary), payload, payload === null ? 0 : new TextEncoder().encode(payload).byteLength);
    const more = retention.trim({ kind: "tool", id: trace.id });
    if (more || await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + (more ? 1000 : 3600_000));
  }
  private prune() {
    const sql = this.ctx.storage.sql, now = Date.now();
    const retention = this.retention();
    sql.exec("DELETE FROM agent_activity WHERE updated < ?", now - 30 * DAY);
    sql.exec("DELETE FROM requests WHERE started < ?", now - 30 * DAY);
    sql.exec("DELETE FROM request_details WHERE started < ? OR id NOT IN (SELECT id FROM requests)", now - 7 * DAY);
    sql.exec("DELETE FROM tool_traces WHERE started < ? OR (started < ? AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.thread=tool_traces.thread AND r.turn_id=tool_traces.turn_id))", now - 30 * DAY, now - 3600_000);
    sql.exec("UPDATE tool_traces SET payload=NULL,bytes=0 WHERE payload IS NOT NULL AND started < ?", now - 7 * DAY);
    const stale = sql.exec<{ id: string; record: string }>("SELECT id,record FROM requests WHERE status='running' AND started < ?", now - 3600_000).toArray();
    for (const row of stale) {
      const r: RequestRecord = JSON.parse(row.record); r.status = "interrupted";
      sql.exec("UPDATE requests SET status='interrupted',record=?,revision=? WHERE id=?", JSON.stringify(r), this.revision(), row.id);
    }
    for (const row of sql.exec<{ id: string; record: string }>("SELECT id,record FROM tool_traces WHERE started < ? AND json_extract(record,'$.status')='running'", now - 3600_000).toArray()) {
      const trace: ToolSummary = JSON.parse(row.record); trace.status = "interrupted";
      sql.exec("UPDATE tool_traces SET record=?,revision=? WHERE id=?", JSON.stringify(trace), this.revision(), row.id);
    }
    return retention.trim();
  }
  override async alarm() {
    if (this.projection.status()?.scope.startsWith("sub:")) {
      const row = await this.projection.db.get<{value:string}>("SELECT value FROM meta WHERE key='subagent'");
      const meta: SubagentMeta | undefined = row ? JSON.parse(row.value) : undefined;
      if (meta?.endedAt && meta.endedAt + RETENTION_MS <= Date.now()) await this.ctx.storage.deleteAll();
      else if (meta?.endedAt) await this.ctx.storage.setAlarm(meta.endedAt + RETENTION_MS);
      else await this.ctx.storage.deleteAlarm();
      return;
    }
    const more = this.prune();
    if (this.ctx.storage.sql.exec("SELECT 1 FROM requests UNION ALL SELECT 1 FROM tool_traces UNION ALL SELECT 1 FROM agent_activity LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + (more ? 1000 : 3600_000));
  }
  private filter(q: RequestQuery) {
    const where = ["started >= ?", "started <= ?"], args: (string | number)[] = [q.since, q.until];
    for (const [column, value] of [["thread", q.thread], ["model", q.model], ["status", q.status], ["purpose", q.purpose], ["turn_id", q.turnId]] as const) {
      if (value) { where.push(column + " = ?"); args.push(value); }
    }
    return { where: where.join(" AND "), args };
  }
  agentTopology(): AgentTopology {
    const now = Date.now();
    if (!this.topologyCache || now - this.topologyCache.sampledAt >= 10_000) this.topologyCache = readAgentTopology(this.ctx.storage.sql, now);
    return this.topologyCache;
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
  detail(id: string, metadataOnly = false) {
    const r = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM requests WHERE id=?", id).toArray()[0];
    if (!r) return;
    const d = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM request_details WHERE id=?", id).toArray()[0];
    const request: RequestRecord = JSON.parse(r.record);
    const tools = new ToolStore(this.ctx.storage.sql).forRequest(request);
    const related = request.binding ? this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM requests WHERE thread=? AND turn_id=? ORDER BY started,seq", request.thread, request.binding.turnId).toArray().map(row => JSON.parse(row.record) as RequestRecord) : [];
    const payload: Pick<RequestDetail, "context" | "response"> | undefined = d ? JSON.parse(d.payload) : undefined;
    return { request, context: payload ? metadataOnly ? contextMetadata(payload.context) : payload.context : undefined,
      response: payload?.response ? metadataOnly ? { ...payload.response, text: "" } : payload.response : undefined,
      responseAvailable: !!payload?.response, bodyDeferred: metadataOnly, tools, related, detailAvailable: !!d };
  }
  toolDetail(id: string) {
    const row = this.ctx.storage.sql.exec<{ record: string; payload: string | null }>("SELECT record,payload FROM tool_traces WHERE id=?", id).toArray()[0];
    return row ? { ...JSON.parse(row.record) as ToolSummary, ...(row.payload ? JSON.parse(row.payload) as Pick<ToolTrace, "arguments" | "result" | "structuredResult"> : {}), detailAvailable: !!row.payload } : undefined;
  }
  turnTrace(thread: string, turns: string[], after: number) {
    if (!turns.length) return { requests: [], tools: [], cursor: after, more: false };
    const turnIds = JSON.stringify(turns), sql = this.ctx.storage.sql;
    // 整个回合列表只占一个绑定参数，避免两段 UNION 在 49 个回合时超过 Cloudflare SQLite 的 100 参数上限。
    const filter = "thread=? AND turn_id IN (SELECT value FROM json_each(?)) AND revision>?";
    const changed = sql.exec<{ kind: string; record: string; revision: number }>(
      `SELECT 'request' AS kind,record,revision FROM requests WHERE ${filter} UNION ALL
       SELECT 'tool' AS kind,record,revision FROM tool_traces WHERE ${filter} ORDER BY revision LIMIT 201`,
      thread, turnIds, after, thread, turnIds, after).toArray();
    const page = changed.slice(0, 200);
    return { requests: page.filter(r => r.kind === "request").map(r => JSON.parse(r.record) as RequestRecord),
      tools: page.filter(r => r.kind === "tool").map(r => JSON.parse(r.record) as ToolSummary),
      cursor: page.at(-1)?.revision ?? sql.exec<{ revision: number }>("SELECT revision FROM request_revision WHERE id=1").one().revision, more: changed.length > 200 };
  }
}
