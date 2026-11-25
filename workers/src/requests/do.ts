import { ExecutionStore, type TraceQuery } from "./executions";
import { PiStore } from "./pi-store";
import type { PiSpan } from "./execution-contracts";
import { ToolStore } from "./tool-store";
import { ContextStore, contextMetadata } from "./context-store";
import { ProjectionStore, viewName, type ProjectionBatch } from "./projection";
import { AgentReadView } from "./view";
import { subagentName, RETENTION_MS, type SubagentMeta } from "../subagent/model";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { RequestDetail, RequestFilters, RequestQuery, RequestRecord, ToolTrace, ToolSummary, TurnTiming } from "./types";
import { readAgentTopology, type AgentTopology } from "./topology";
import type { SubagentActivity } from "../subagent/activity";
import { RequestRetention, REQUEST_RETENTION } from "./retention";
import type { DiagQuery, DiagRecord } from "../shared/diagnostics";
const DAY = 86_400_000;
const MAX_DIAG_LOGS = 1000;
type Row = { seq: number; record: string; available: number };
export class RequestsDO extends DurableObject<Env> {
  private executions?: ExecutionStore;
  private executionStore() { return this.executions ??= new ExecutionStore(this.ctx.storage.sql); }
  agentTraces(q: TraceQuery) { return this.executionStore().list(q); }
  agentTraceAnalysis(thread: string,root: string) { return this.executionStore().analysis(thread,root); }
  agentTraceDetail(thread: string, root: string, cursor?: import("../admin/pagination").AdminCursor) { return this.executionStore().detail(thread,root,cursor); }
  async recordPiSpans(spans: PiSpan[]) {
    new PiStore(this.ctx.storage.sql).write(spans);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now()+86400_000);
  }
  piSpans(actor: string,input: string,before: number,request?: string) { return new PiStore(this.ctx.storage.sql).page(actor,input,before,request); }
  contextTimeline(...args: Parameters<ContextStore["timeline"]>) { return new ContextStore(this.ctx.storage.sql).timeline(...args); }
  contextInspection(id: string) { return new ContextStore(this.ctx.storage.sql).inspect(id); }
  contextPart(id: string, part: string) { return new ContextStore(this.ctx.storage.sql).part(id, part); }
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
      CREATE TABLE IF NOT EXISTS tool_traces (id TEXT PRIMARY KEY, thread TEXT NOT NULL, turn_id TEXT NOT NULL, call_id TEXT NOT NULL,
        started INTEGER NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, payload TEXT, bytes INTEGER NOT NULL,
        UNIQUE(thread,turn_id,call_id));
      CREATE INDEX IF NOT EXISTS tool_traces_turn ON tool_traces(thread,turn_id);
      CREATE TABLE IF NOT EXISTS agent_activity (thread TEXT NOT NULL, actor TEXT NOT NULL, updated INTEGER NOT NULL,
        version INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(thread,actor));
      CREATE INDEX IF NOT EXISTS agent_activity_updated ON agent_activity(updated);
      CREATE TABLE IF NOT EXISTS ops_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL,
        event TEXT NOT NULL, thread TEXT, turn_id TEXT, code TEXT, record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ops_logs_at ON ops_logs(at DESC, seq DESC);
      CREATE TABLE IF NOT EXISTS turn_timings (thread TEXT NOT NULL, input_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        ended INTEGER NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(thread, input_id));
      CREATE INDEX IF NOT EXISTS turn_timings_ended ON turn_timings(thread, ended DESC);
      CREATE INDEX IF NOT EXISTS turn_timings_all_ended ON turn_timings(ended DESC);
      CREATE INDEX IF NOT EXISTS turn_timings_turn ON turn_timings(thread, turn_id);
    `);
    const columns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(requests)").toArray();
    if (!columns.some(c => c.name === "turn_id")) ctx.storage.sql.exec("ALTER TABLE requests ADD COLUMN turn_id TEXT");
    if (!columns.some(c => c.name === "ttft_ms")) ctx.storage.sql.exec("ALTER TABLE requests ADD COLUMN ttft_ms INTEGER");
    if (!columns.some(c => c.name === "reasoning_tokens")) ctx.storage.sql.exec("ALTER TABLE requests ADD COLUMN reasoning_tokens INTEGER");
    if (!columns.some(c => c.name === "cost_usd")) ctx.storage.sql.exec("ALTER TABLE requests ADD COLUMN cost_usd REAL");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS tool_traces_actor_call ON tool_traces(thread,COALESCE(json_extract(record,'$.actor'),'thread'),call_id,started)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS requests_actor_started ON requests(thread,json_extract(record,'$.actor'),started,id)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS requests_turn ON requests(thread,turn_id)");
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
  mcpHealth(...args: Parameters<AgentReadView["mcpHealth"]>) { return this.readView().mcpHealth(...args); }
  async subagentList() {
    const view = this.readView(), scope = this.projection.status()!.scope;
    if (!scope.startsWith("thread:")) throw new Error("view_scope_mismatch");
    const topology = await this.env.REQUESTS.getByName("main").agentTopology();
    const activity = Object.fromEntries(topology.nodes.flatMap(node => node.kind === "subagent" && node.thread === scope.slice(7) && node.lastActiveAt !== null ? [[node.actor, node.lastActiveAt]] : []));
    return view.subagentList(activity);
  }
  workspaceChild(...args: Parameters<AgentReadView["workspaceChild"]>) { return this.readView().workspaceChild(...args); }
  async chatView(...args: Parameters<AgentReadView["chatView"]>) { return {...await this.readView().chatView(...args), syncedAt: this.projection.status()!.synced_at}; }
  async stats() { return {...await this.readView().stats(), syncedAt: this.projection.status()!.synced_at}; }
  modelHistory(...args: Parameters<AgentReadView["modelHistory"]>) { return this.readView().modelHistory(...args); }
  subagentConversation(...args: Parameters<AgentReadView["subagentConversation"]>) { return this.readView().subagentConversation(...args); }
  async subagentHistory(id: string, cursor?: string): Promise<Awaited<ReturnType<AgentReadView["subagentConversation"]>> | undefined> {
    return (await this.childView(id))?.subagentConversation(cursor);
  }
  private async childView(id: string): Promise<DurableObjectStub<RequestsDO> | undefined> {
    const state = this.projection.status(); if (!state?.scope.startsWith("thread:")) throw new Error("view_pending");
    const child = await this.readView().child(id); if (!child) return;
    if (child.ended_at !== null && Date.now() >= child.ended_at + RETENTION_MS) return;
    return this.env.REQUESTS.getByName(viewName(subagentName(state.scope.slice(7), id)));
  }

  async recordAgent(activity: SubagentActivity): Promise<void> {
    this.ctx.storage.sql.exec(`INSERT INTO agent_activity(thread,actor,updated,version,record) VALUES(?,?,?,?,?)
      ON CONFLICT(thread,actor) DO UPDATE SET updated=excluded.updated,version=excluded.version,record=excluded.record
      WHERE excluded.version>agent_activity.version`, activity.thread, activity.actor, activity.updatedAt, activity.version, JSON.stringify(activity));
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  private insertDiag(entry: DiagRecord): void {
    const sql = this.ctx.storage.sql;
    const seq = sql.exec<{ seq: number }>(
      "INSERT INTO ops_logs(at,level,event,thread,turn_id,code,record) VALUES(?,?,?,?,?,?,?) RETURNING seq",
      entry.at, entry.level, entry.event, entry.thread ?? null, entry.turnId ?? null, entry.code ?? null, JSON.stringify(entry),
    ).one().seq;
    if (seq > MAX_DIAG_LOGS) sql.exec("DELETE FROM ops_logs WHERE seq <= ?", seq - MAX_DIAG_LOGS);
  }
  async recordDiag(entry: DiagRecord): Promise<void> {
    this.insertDiag(entry);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  async recordDiagBatch(entries: DiagRecord[]): Promise<void> {
    if (!entries.length) return;
    this.ctx.storage.transactionSync(() => {
      for (const entry of entries.slice(0, 50)) this.insertDiag(entry);
    });
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  queryLogs(q: DiagQuery = {}): { logs: DiagRecord[]; next?: number } {
    const where: string[] = [], args: (string | number)[] = [];
    if (q.since !== undefined) { where.push("at >= ?"); args.push(q.since); }
    if (q.until !== undefined) { where.push("at <= ?"); args.push(q.until); }
    if (q.level) { where.push("level = ?"); args.push(q.level); }
    if (q.event) { where.push("event = ?"); args.push(q.event); }
    if (q.thread) { where.push("thread = ?"); args.push(q.thread); }
    if (q.turnId) { where.push("turn_id = ?"); args.push(q.turnId); }
    if (q.before !== undefined) { where.push("seq < ?"); args.push(q.before); }
    const limit = Math.min(200, Math.max(1, Math.trunc(q.limit ?? 50)));
    const rows = this.ctx.storage.sql.exec<{ seq: number; record: string }>(
      `SELECT seq, record FROM ops_logs${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`,
      ...args, limit + 1,
    ).toArray();
    const page = rows.slice(0, limit);
    return {
      logs: page.map(row => ({ ...JSON.parse(row.record) as DiagRecord, seq: row.seq })),
      ...(rows.length > limit ? { next: page.at(-1)!.seq } : {}),
    };
  }
  async record(detail: RequestDetail): Promise<void> {
    const r = detail.request, sql = this.ctx.storage.sql;
    if (r.startedAt < Date.now() - REQUEST_RETENTION.metadataMs) return;
    const retention = this.retention();
    // 重投与乱序开始事件不会覆盖终态。
    const previous = sql.exec<{ status: string }>("SELECT status FROM requests WHERE id = ?", r.id).toArray()[0];
    if (previous && previous.status !== "running" && (previous.status !== "interrupted" || r.status === "running")) return;
    sql.exec(`INSERT INTO requests(id,started,thread,model,purpose,status,input_tokens,output_tokens,cache_read,duration,record,turn_id,ttft_ms,reasoning_tokens,cost_usd)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens,cache_read=excluded.cache_read,duration=excluded.duration,record=excluded.record,turn_id=excluded.turn_id,
      ttft_ms=excluded.ttft_ms,reasoning_tokens=excluded.reasoning_tokens,cost_usd=excluded.cost_usd`,
      r.id, r.startedAt, r.thread, r.provider + "/" + r.model, r.purpose, r.status, r.inputTokens, r.outputTokens, r.cacheRead, r.durationMs, JSON.stringify(r), r.binding?.turnId ?? null, r.ttftMs ?? null, r.reasoningTokens ?? null, r.costUsd ?? null);
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
    // 已部署表的 revision 列必填，旧增量游标退役后新行统一写 0。
    sql.exec(`INSERT INTO tool_traces(id,thread,turn_id,call_id,started,revision,record,payload,bytes) VALUES(?,?,?,?,?,0,?,?,?)
      ON CONFLICT(id) DO UPDATE SET record=excluded.record,payload=excluded.payload,bytes=excluded.bytes`,
      trace.id, trace.thread, trace.binding.turnId, trace.callId, trace.startedAt, JSON.stringify(summary), payload, payload === null ? 0 : new TextEncoder().encode(payload).byteLength);
    if (summary.dispatch) this.executionStore().bind(summary);
    const more = retention.trim({ kind: "tool", id: trace.id });
    if (more || await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + (more ? 1000 : 3600_000));
  }
  async recordTurnTiming(timing: TurnTiming): Promise<void> {
    if (timing.endedAt < Date.now() - REQUEST_RETENTION.metadataMs) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO turn_timings(thread,input_id,turn_id,ended,revision,record) VALUES(?,?,?,?,0,?)
       ON CONFLICT(thread,input_id) DO UPDATE SET turn_id=excluded.turn_id,ended=excluded.ended,record=excluded.record`,
      timing.thread, timing.inputId, timing.turnId, timing.endedAt, JSON.stringify(timing),
    );
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
  recentTurns(thread?: string, limit = 20, excludeTurnId?: string): TurnTiming[] {
    const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
    const where: string[] = [], args: (string | number)[] = [];
    if (thread) { where.push("thread = ?"); args.push(thread); }
    if (excludeTurnId) { where.push("turn_id != ?"); args.push(excludeTurnId); }
    const rows = this.ctx.storage.sql.exec<{ record: string }>(
      `SELECT record FROM turn_timings${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY ended DESC LIMIT ?`,
      ...args, capped,
    ).toArray();
    return rows.map(r => JSON.parse(r.record) as TurnTiming);
  }
  private prune() {
    const sql = this.ctx.storage.sql, now = Date.now();
    const retention = this.retention();
    this.executionStore();
    sql.exec("DELETE FROM agent_dispatch WHERE at<? OR NOT EXISTS (SELECT 1 FROM tool_traces WHERE id=agent_dispatch.tool)",now-30*DAY);
    sql.exec("DELETE FROM agent_activity WHERE updated < ?", now - 30 * DAY);
    sql.exec("DELETE FROM ops_logs WHERE at < ?", now - 30 * DAY);
    sql.exec("DELETE FROM turn_timings WHERE ended < ?", now - 30 * DAY);
    sql.exec("DELETE FROM turn_timings WHERE rowid IN (SELECT rowid FROM turn_timings ORDER BY ended DESC LIMIT -1 OFFSET 20000)");
    sql.exec("DELETE FROM requests WHERE started < ?", now - 30 * DAY);
    sql.exec("DELETE FROM request_details WHERE started < ? OR id NOT IN (SELECT id FROM requests)", now - 7 * DAY);
    sql.exec("DELETE FROM tool_traces WHERE started < ? OR (started < ? AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.thread=tool_traces.thread AND r.turn_id=tool_traces.turn_id))", now - 30 * DAY, now - 3600_000);
    sql.exec("UPDATE tool_traces SET payload=NULL,bytes=0 WHERE payload IS NOT NULL AND started < ?", now - 7 * DAY);
    const stale = sql.exec<{ id: string; record: string }>("SELECT id,record FROM requests WHERE status='running' AND started < ?", now - 3600_000).toArray();
    for (const row of stale) {
      const r: RequestRecord = JSON.parse(row.record); r.status = "interrupted";
      sql.exec("UPDATE requests SET status='interrupted',record=? WHERE id=?", JSON.stringify(r), row.id);
    }
    for (const row of sql.exec<{ id: string; record: string }>("SELECT id,record FROM tool_traces WHERE started < ? AND json_extract(record,'$.status')='running'", now - 3600_000).toArray()) {
      const trace: ToolSummary = JSON.parse(row.record); trace.status = "interrupted";
      sql.exec("UPDATE tool_traces SET record=? WHERE id=?", JSON.stringify(trace), row.id);
    }
    return retention.trim();
  }
  override async alarm() {
    const native = new PiStore(this.ctx.storage.sql);
    if (native.exists()) {
      native.trim();
      if (native.hasRows()) await this.ctx.storage.setAlarm(Date.now()+86400_000);
      return;
    }
    if (this.projection.status()?.scope.startsWith("sub:")) {
      const row = await this.projection.db.get<{value:string}>("SELECT value FROM meta WHERE key='subagent'");
      const meta: SubagentMeta | undefined = row ? JSON.parse(row.value) : undefined;
      if (meta?.endedAt && meta.endedAt + RETENTION_MS <= Date.now()) await this.ctx.storage.deleteAll();
      else if (meta?.endedAt) await this.ctx.storage.setAlarm(meta.endedAt + RETENTION_MS);
      else await this.ctx.storage.deleteAlarm();
      return;
    }
    const more = this.prune();
    if (this.ctx.storage.sql.exec("SELECT 1 FROM requests UNION ALL SELECT 1 FROM tool_traces UNION ALL SELECT 1 FROM agent_activity UNION ALL SELECT 1 FROM ops_logs UNION ALL SELECT 1 FROM turn_timings LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + (more ? 1000 : 3600_000));
  }
  private filter(q: RequestFilters) {
    const where = ["started >= ?", "started <= ?"], args: (string | number)[] = [q.since, q.until];
    for (const [column, value] of [["thread", q.thread], ["model", q.model], ["status", q.status], ["purpose", q.purpose], ["turn_id", q.turnId]] as const) {
      if (value) { where.push(column + " = ?"); args.push(value); }
    }
    if (q.excludeTurnId) { where.push("(turn_id IS NULL OR turn_id != ?)"); args.push(q.excludeTurnId); }
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
  usage(q: RequestFilters) {
    const { where, args } = this.filter(q), sql = this.ctx.storage.sql;
    const columns = "COUNT(*) AS requests, COALESCE(SUM(CASE WHEN status IN ('error','aborted','interrupted') THEN 1 ELSE 0 END),0) AS failed, COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) AS running, COUNT(input_tokens) AS measured, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens, COALESCE(SUM(cache_read),0) AS cacheRead, COALESCE(SUM(CASE WHEN cache_read IS NOT NULL THEN input_tokens ELSE 0 END),0) AS cacheInputTokens, COUNT(cache_read) AS cacheMeasured, COALESCE(SUM(cost_usd),0) AS costUsd, AVG(duration) AS avgDuration, AVG(ttft_ms) AS avgTtft";
    const summary = sql.exec("SELECT " + columns + " FROM requests WHERE " + where, ...args).one();
    const bucket = q.until - q.since <= 2 * DAY ? 3600_000 : DAY;
    const series = sql.exec("SELECT CAST((started + 28800000) / ? AS INTEGER) * ? - 28800000 AS at, " + columns + " FROM requests WHERE " + where + " GROUP BY at ORDER BY at",
      bucket, bucket, ...args).toArray();
    const models = sql.exec("SELECT model, " + columns + " FROM requests WHERE " + where + " GROUP BY model ORDER BY inputTokens + outputTokens DESC", ...args).toArray();
    const first = sql.exec<{ at: number | null }>("SELECT MIN(started) AS at FROM requests").one().at;
    const choices = sql.exec<{ model: string }>("SELECT DISTINCT model FROM requests ORDER BY model").toArray().map(r => r.model);
    return { summary, series, models, choices, bucket, retainedSince: first, retention: { metadataDays: 30, detailsDays: 7, maxRequests: 20000, maxDetailBytes: 33554432 } };
  }
  requestSnapshot(id: string, metadataOnly = false) {
    const r = this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM requests WHERE id=?", id).toArray()[0];
    if (!r) return;
    const d = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM request_details WHERE id=?", id).toArray()[0];
    const request: RequestRecord = JSON.parse(r.record);
    const payload: Pick<RequestDetail, "context" | "response"> | undefined = d ? JSON.parse(d.payload) : undefined;
    return { request, context: payload ? metadataOnly ? contextMetadata(payload.context) : payload.context : undefined,
      response: payload?.response ? metadataOnly ? { ...payload.response, text: "" } : payload.response : undefined,
      responseAvailable: !!payload?.response, bodyDeferred: metadataOnly, detailAvailable: !!d };
  }
  detail(id: string, metadataOnly = false) {
    const snapshot = this.requestSnapshot(id, metadataOnly);
    if (!snapshot) return;
    const { request } = snapshot;
    const tools = new ToolStore(this.ctx.storage.sql).forRequest(request);
    const related = request.binding ? this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM requests WHERE thread=? AND turn_id=? ORDER BY started,seq", request.thread, request.binding.turnId).toArray().map(row => JSON.parse(row.record) as RequestRecord) : [];
    return { ...snapshot, tools, related };
  }
  toolDetail(id: string, metadataOnly = false): (ToolSummary & Partial<Pick<ToolTrace, "arguments" | "result" | "structuredResult">> & { bodyDeferred?: boolean; detailAvailable: boolean }) | undefined {
    const row = this.ctx.storage.sql.exec<{ record: string; payload: string | null }>("SELECT record,payload FROM tool_traces WHERE id=?", id).toArray()[0];
    if (!row) return undefined;
    const summary = JSON.parse(row.record) as ToolSummary;
    if (metadataOnly) return { ...summary, bodyDeferred: true, detailAvailable: !!row.payload };
    return { ...summary, ...(row.payload ? JSON.parse(row.payload) as Pick<ToolTrace, "arguments" | "result" | "structuredResult"> : {}), detailAvailable: !!row.payload };
  }
  turnProgress(thread: string, turns: string[]): import("./tool-types").TurnProgress[] {
    if (!turns.length) return [];
    const rows=this.ctx.storage.sql.exec<{turnId:string;active:number;steps:string|null}>(`
      SELECT t.value AS turnId,
        (EXISTS (SELECT 1 FROM requests r WHERE r.thread=? AND r.turn_id=t.value AND r.status='running')
         OR EXISTS (SELECT 1 FROM tool_traces k WHERE k.thread=? AND k.turn_id=t.value AND json_extract(k.record,'$.status')='running')) AS active,
        (SELECT json_extract(k.record,'$.steps') FROM tool_traces k WHERE k.thread=? AND k.turn_id=t.value
           AND json_extract(k.record,'$.name')='update_steps' AND COALESCE(json_extract(k.record,'$.actor'),'thread')='thread'
           AND json_extract(k.record,'$.status')!='error' AND json_type(k.record,'$.steps')='array'
         ORDER BY k.started DESC, k.rowid DESC LIMIT 1) AS steps
      FROM json_each(?) t`, thread,thread,thread,JSON.stringify(turns));
    return rows.toArray().filter(r=>r.active||r.steps).map(r=>({turnId:r.turnId,active:!!r.active,steps:r.steps?JSON.parse(r.steps):[]}));
  }
}
