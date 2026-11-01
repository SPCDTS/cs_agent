import type { AgentDescription, SubagentActivity } from "../subagent/activity";
import type { SubagentStatus } from "../subagent/model";

const DAY = 86_400_000;
const HOUR = 3_600_000;
type Activity = "active" | "recent" | "error" | "context";
export type AgentNode = { id: string; thread: string; activity: Activity; lastActiveAt: number | null } & (
  | { kind: "thread"; parentId: null }
  | { kind: "subagent"; parentId: string; actor: string; status: SubagentStatus | null; summary: string | null; description: AgentDescription | null }
);
export type AgentTopology = { nodes: AgentNode[]; since: number; sampledAt: number };

/** 仅聚合现有元数据；父子关系来自采集时绑定的 thread / actor，不访问任务或消息正文。 */
export function readAgentTopology(sql: SqlStorage, now: number): AgentTopology {
  const since = now - DAY;
  const rows = sql.exec<{ thread: string; actor: string; at: number; active: number; failed: number }>(`
    WITH activity AS (
      SELECT thread,json_extract(record,'$.actor') AS actor,
        MAX(started,COALESCE(json_extract(record,'$.endedAt'),started)) AS at,
        status='running' AND started>=? AS active,status IN ('error','aborted','interrupted') AS failed
        FROM requests WHERE started>=?
      UNION ALL
      SELECT thread,'thread' AS actor,MAX(started,COALESCE(json_extract(record,'$.endedAt'),started)) AS at,
        json_extract(record,'$.status')='running' AND started>=? AS active,
        json_extract(record,'$.status') IN ('error','interrupted') AS failed FROM tool_traces WHERE started>=?
    ), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY thread,actor ORDER BY at DESC,failed DESC) AS rank FROM activity
    )
    SELECT thread,actor,MAX(at) AS at,MAX(active) AS active,MAX(CASE WHEN rank=1 THEN failed ELSE 0 END) AS failed
      FROM ranked GROUP BY thread,actor HAVING MAX(at)>=? ORDER BY at DESC,thread,actor
  `, now - HOUR, since - HOUR, now - HOUR, since - HOUR, since).toArray();
  const nodes = new Map<string, AgentNode>();
  for (const row of rows) {
    const parentId = "thread:" + row.thread;
    const activity = row.active ? "active" : row.failed ? "error" : "recent";
    if (row.actor === "thread") {
      nodes.set(parentId, { id: parentId, thread: row.thread, kind: "thread", parentId: null, activity, lastActiveAt: row.at });
    } else {
      if (!nodes.has(parentId)) nodes.set(parentId, { id: parentId, thread: row.thread, kind: "thread", parentId: null, activity: "context", lastActiveAt: null });
      const id = `sub:${row.thread}:${row.actor}`;
      nodes.set(id, { id, thread: row.thread, kind: "subagent", parentId, actor: row.actor, activity, lastActiveAt: row.at, status: null, summary: null, description: null });
    }
  }
  // 子任务的状态跨模型请求与工具执行；显式生命周期覆盖请求片段的推测状态。
  for (const row of sql.exec<{ record: string }>("SELECT record FROM agent_activity WHERE updated>=? ORDER BY thread,actor", since)) {
    const record: SubagentActivity = JSON.parse(row.record), parentId = "thread:" + record.thread, id = `sub:${record.thread}:${record.actor}`;
    if (!nodes.has(parentId)) nodes.set(parentId, { id: parentId, thread: record.thread, kind: "thread", parentId: null, activity: "context", lastActiveAt: null });
    nodes.set(id, { id, thread: record.thread, kind: "subagent", parentId, actor: record.actor,
      activity: record.status === "running" ? "active" : record.status === "failed" ? "error" : "recent",
      lastActiveAt: record.updatedAt, status: record.status, summary: record.summary, description: record.description });
  }
  return { nodes: [...nodes.values()], since, sampledAt: now };
}
