import type { Static } from "typebox";
import type { ModelBreakdown } from "./execution-contracts";
import type { AdminCursor } from "../admin/pagination";
import { ADMIN_PAGE_SIZE } from "../admin/pagination";
import { reportKey } from "../subagent/model";
import type { Observation, TraceSummary } from "./execution-contracts";
import type { RequestFilters, RequestRecord, ToolSummary, TurnTiming } from "./types";

export type TraceQuery = Omit<RequestFilters, "excludeTurnId"> & {
  actor?: string;
  outcome?: string;
  search?: string;
  cursor?: AdminCursor;
};
// Views are projections over the existing ledger. Only confirmed dispatch edges add stored rows.
export class ExecutionStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_dispatch (
      thread TEXT NOT NULL, actor TEXT NOT NULL, input_id TEXT NOT NULL, parent_input TEXT NOT NULL,
      root_turn TEXT NOT NULL, tool TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(thread,actor,input_id));
      CREATE INDEX IF NOT EXISTS agent_dispatch_parent ON agent_dispatch(thread,parent_input);
      CREATE INDEX IF NOT EXISTS agent_dispatch_at ON agent_dispatch(at);
      CREATE VIEW IF NOT EXISTS agent_facts AS
        SELECT 'model' AS kind,id,thread,COALESCE(turn_id,'request:'||id) AS turn,
          COALESCE(json_extract(record,'$.actor'),'thread') AS actor,COALESCE(json_extract(record,'$.binding.inputId'),'') AS input_id,
          started,COALESCE(json_extract(record,'$.endedAt'),started) AS last,status,model AS label,
          input_tokens AS input,output_tokens AS output,cache_read AS cached,cost_usd AS cost FROM requests
        UNION ALL SELECT 'tool',id,thread,turn_id,COALESCE(json_extract(record,'$.actor'),'thread'),
          json_extract(record,'$.binding.inputId'),started,COALESCE(json_extract(record,'$.endedAt'),started),
          json_extract(record,'$.status'),json_extract(record,'$.name'),NULL,NULL,NULL,NULL FROM tool_traces
        UNION ALL SELECT 'turn',input_id,thread,turn_id,'thread',input_id,json_extract(record,'$.receivedAt'),ended,
          json_extract(record,'$.status'),json_extract(record,'$.origin'),NULL,NULL,NULL,NULL FROM turn_timings;
      CREATE VIEW IF NOT EXISTS agent_observations AS SELECT f.*,COALESCE(d.root_turn,f.turn) AS root,COALESCE(d.tool,'') AS dispatch
        FROM agent_facts f LEFT JOIN agent_dispatch d ON d.thread=f.thread AND d.actor=f.actor AND d.input_id=f.input_id`);
  }
  bind(tool: ToolSummary) {
    const edge = tool.dispatch;
    if (!edge || (tool.actor ?? "thread") !== "thread" || tool.name !== "subagent" || tool.status !== "done") return;
    const parent = this.sql
      .exec<{ root_turn: string }>(
        "SELECT root_turn FROM agent_dispatch WHERE thread=? AND actor='thread' AND input_id=?",
        tool.thread,
        tool.binding.inputId,
      )
      .toArray()[0];
    const root = parent?.root_turn ?? tool.binding.turnId;
    const insert = (actor: string, input: string) =>
      this.sql.exec(
        "INSERT OR IGNORE INTO agent_dispatch(thread,actor,input_id,parent_input,root_turn,tool,at) VALUES(?,?,?,?,?,?,?)",
        tool.thread,
        actor,
        input,
        tool.binding.inputId,
        root,
        tool.id,
        tool.startedAt,
      );
    insert(edge.actor, edge.inputId);
    const report = reportKey(edge.actor, edge.inputId);
    if (!insert("thread", report).rowsWritten) return;
    // A report can dispatch again before the original tool completion reaches the ledger.
    this.sql.exec(
      `WITH RECURSIVE descendants(actor,input_id) AS (
      SELECT actor,input_id FROM agent_dispatch WHERE thread=? AND parent_input=?
      UNION
      SELECT d.actor,d.input_id FROM descendants p JOIN agent_dispatch d
        ON p.actor='thread' AND d.thread=? AND d.parent_input=p.input_id
    ) UPDATE agent_dispatch SET root_turn=? WHERE thread=? AND root_turn<>?
      AND (actor,input_id) IN (SELECT actor,input_id FROM descendants)`,
      tool.thread,
      report,
      tool.thread,
      root,
      tool.thread,
      root,
    );
  }
  list(q: TraceQuery) {
    const where = ["started BETWEEN ? AND ?"],
      args: (number | string)[] = [q.since, q.until];
    if (q.thread) {
      where.push("thread=?");
      args.push(q.thread);
    }
    const having: string[] = [];
    const match: string[] = [];
    if (q.model || q.purpose || q.status) match.push("kind='model'");
    if (q.purpose) {
      match.push("EXISTS (SELECT 1 FROM requests m WHERE m.id=agent_observations.id AND m.purpose=?)");
      args.push(q.purpose);
    }
    for (const [column, value] of [["label", q.model], ["status", q.status], ["actor", q.actor], ["turn", q.turnId]] as const) {
      if (value) { match.push(column + "=?"); args.push(value); }
    }
    if (match.length) having.push("MAX(CASE WHEN " + match.join(" AND ") + " THEN 1 ELSE 0 END)=1");
    if (q.search) {
      having.push("MAX(instr(lower(thread||' '||root||' '||actor||' '||label||' '||id),lower(?)))>0");
      args.push(q.search);
    }
    if (q.outcome === "error") having.push("failures>0");
    if (q.outcome === "running") having.push("running>0");
    if (q.outcome === "done") having.push("failures=0 AND running=0");
    if (q.cursor) {
      having.push("(MIN(started)<? OR (MIN(started)=? AND thread||'/'||root>?))");
      args.push(q.cursor.at, q.cursor.at, q.cursor.id);
    }
    const rows = this.sql
      .exec<TraceSummary>(
        `SELECT thread,root,MIN(started) started,MAX(last) last,
      SUM(status='running') running,SUM(status IN ('error','failed','interrupted','aborted')) failures,
      SUM(kind='model') requests,SUM(kind='tool') tools,COUNT(DISTINCT CASE WHEN actor!='thread' THEN actor END) children,
      SUM(input) input,SUM(output) output,SUM(cost) cost,COUNT(cost) priced,SUM(cached) cached,
      SUM(CASE WHEN cached IS NOT NULL THEN input END) cacheInput,COUNT(cached) measured
      FROM agent_observations WHERE ${where.join(" AND ")} GROUP BY thread,root
      ${having.length ? "HAVING " + having.join(" AND ") : ""} ORDER BY MIN(started) DESC,thread||'/'||root LIMIT ?`,
        ...args,
        ADMIN_PAGE_SIZE + 1,
      )
      .toArray();
    const traces = rows.slice(0, ADMIN_PAGE_SIZE),
      last = traces.at(-1);
    return {
      traces,
      ...(rows.length > traces.length && last
        ? { next: JSON.stringify({ at: last.started, id: last.thread + "/" + last.root }) }
        : {}),
    };
  }
  analysis(thread: string, root: string) {
    const groups = this.sql
      .exec<Static<typeof ModelBreakdown>>(
        `WITH rounds AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY actor,turn ORDER BY started,id) AS ordinal
        FROM agent_observations WHERE thread=? AND root=? AND kind='model')
      SELECT actor,label AS model,CASE WHEN ordinal=1 THEN 'first' ELSE 'followup' END AS round,COUNT(*) AS n,
        SUM(input) input,SUM(output) output,SUM(cached) cached,SUM(CASE WHEN cached IS NOT NULL THEN input END) cacheInput,
        COUNT(cached) measured,AVG(CASE WHEN status!='running' THEN last-started END) ms,SUM(cost) cost,COUNT(cost) priced
        FROM rounds GROUP BY actor,label,round ORDER BY actor,model,round LIMIT 101`,
        thread,
        root,
      )
      .toArray();
    return { groups: groups.slice(0, 100), more: groups.length > 100 };
  }
  detail(thread: string, root: string, cursor?: AdminCursor) {
    // Fetch metadata only. Prompt, tool output and attachments remain behind their own detail endpoints.
    const rows = this.sql
      .exec<{
        id: string;
        kind: Observation["kind"];
        actor: string;
        turn: string;
        input_id: string;
        label: string;
        status: string;
        started: number;
        last: number;
        input: number | null;
        output: number | null;
        cached: number | null;
        cost: number | null;
        dispatch: string;
        record: string;
      }>(
        `
      WITH page AS (SELECT * FROM agent_observations WHERE thread=? AND root=?
        ${cursor ? "AND (started>? OR (started=? AND kind||'/'||id>?))" : ""} ORDER BY started,kind,id LIMIT 81)
      SELECT p.*,CASE p.kind WHEN 'model' THEN (SELECT record FROM requests WHERE id=p.id)
        WHEN 'tool' THEN (SELECT record FROM tool_traces WHERE id=p.id)
        ELSE (SELECT record FROM turn_timings WHERE thread=p.thread AND input_id=p.id) END AS record FROM page p ORDER BY started,kind,id`,
        thread,
        root,
        ...(cursor ? [cursor.at, cursor.at, cursor.id] : []),
      )
      .toArray();
    const observations: Observation[] = rows.slice(0, 80).map((r) => {
      const entry = JSON.parse(r.record);
      const model: RequestRecord | undefined = r.kind === "model" ? entry : undefined;
      const tool: ToolSummary | undefined = r.kind === "tool" ? entry : undefined;
      const turn: TurnTiming | undefined = r.kind === "turn" ? entry : undefined;
      return {
        id: r.id,
        kind: r.kind,
        actor: r.actor,
        turn: r.turn,
        inputId: r.input_id,
        label: r.label,
        status: r.status,
        started: r.started,
        ended: entry.endedAt ?? null,
        input: r.input,
        output: r.output,
        cached: r.cached,
        written: model?.cacheWrite ?? null,
        cost: r.cost,
        firstEvent: model?.ttftMs ?? null,
        alarmWait: model?.alarmWaitMs ?? null,
        reasoning: model?.reasoningTokens ?? null,
        ...(turn
          ? {
              timing: {
                queue: turn.queueWaitMs,
                firstVisible: turn.firstDeliveredAt === null ? null : turn.firstDeliveredAt - turn.receivedAt,
                delivery: turn.deliveryWaitMs,
              },
            }
          : {}),
        ...(tool?.dispatch ? { target: tool.dispatch } : {}),
        callId: tool?.callId ?? "",
        calls: (model?.toolCalls ?? []).map((c) => c.id),
        parentCall: tool?.parentCallId ?? "",
        dispatch: r.dispatch,
      };
    });
    const last = observations.at(-1);
    return {
      observations,
      ...(rows.length > 80 && last ? { next: JSON.stringify({ at: last.started, id: last.kind + "/" + last.id }) } : {}),
    };
  }
}
