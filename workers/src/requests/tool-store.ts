import type { ContextItem } from "./context-types";
import type { ContextSnapshot } from "./snapshot";
import type { RequestRecord } from "./types";
import { executionReference, executionTools, type ToolExecution, type ToolSummary } from "./tool-types";

type ToolRow = { record: string; available: number };
const summary = (row: ToolRow): ToolSummary => ({ ...JSON.parse(row.record), detailAvailable: !!row.available });

/** 从现有工具表读取元数据；执行详情正文继续使用 /admin/tools/:id 懒加载。 */
export class ToolStore {
  constructor(private readonly sql: SqlStorage) {}
  private turns(thread: string, actor: string, turns: string[]) {
    return this.sql.exec<ToolRow>(`SELECT record,payload IS NOT NULL AS available FROM tool_traces
      WHERE thread=? AND COALESCE(json_extract(record,'$.actor'),'thread')=?
      AND turn_id IN (SELECT value FROM json_each(?)) ORDER BY started,id`, thread, actor, JSON.stringify(turns)).toArray().map(summary);
  }
  forRequest(request: RequestRecord): ToolSummary[] {
    if (!request.binding) return [];
    const tools = this.turns(request.thread, request.actor, [request.binding.turnId]);
    const calls = new Set(request.toolCalls?.map(call => call.id)), selected = new Map<string, ToolSummary>();
    for (const root of tools.filter(tool => !tool.parentCallId && calls.has(tool.callId)))
      for (const tool of executionTools(tools, root)) selected.set(tool.id, tool);
    return [...selected.values()];
  }
  execution(id: string): ToolExecution | undefined {
    const row = this.sql.exec<ToolRow>("SELECT record,payload IS NOT NULL AS available FROM tool_traces WHERE id=?", id).toArray()[0];
    if (!row) return;
    const root = summary(row), actor = root.actor ?? "thread";
    const tools = executionTools(this.turns(root.thread, actor, [root.binding.turnId]), root);
    const source = this.sql.exec<{ id: string }>(`SELECT id FROM requests WHERE thread=? AND turn_id=?
      AND json_extract(record,'$.actor')=? AND started<=?
      AND EXISTS (SELECT 1 FROM json_each(json_extract(record,'$.toolCalls')) WHERE json_extract(value,'$.id')=?)
      ORDER BY started DESC,seq DESC LIMIT 1`, root.thread, root.binding.turnId, actor, root.startedAt, root.callId).toArray()[0];
    return { rootId: root.id, tools, ...(source ? { sourceRequestId: source.id } : {}) };
  }
  annotate(request: RequestRecord, context: ContextSnapshot): ContextItem[] {
    const items = context.analysis?.items ?? [];
    // 升级前已经保存的最近 100 条正文仍能通过原 toolCallId 关联；不从脚本源码猜调用。
    const references = items.flatMap(item => {
      const index = /^message:(\d+)$/.exec(item.id);
      const message = index ? context.messages[Number(index[1]) - context.omittedMessages] : undefined;
      const callId = item.toolCallId ?? message?.toolCallId;
      return item.category === "result" && callId ? [{ item, callId }] : [];
    });
    if (!references.length) return items;
    const roots = this.sql.exec<ToolRow>(`SELECT record,payload IS NOT NULL AS available FROM tool_traces
      WHERE thread=? AND COALESCE(json_extract(record,'$.actor'),'thread')=? AND started<=?
      AND json_extract(record,'$.parentCallId') IS NULL AND call_id IN (SELECT value FROM json_each(?))
      ORDER BY started DESC,id DESC`, request.thread, request.actor, request.startedAt, JSON.stringify(references.map(ref => ref.callId))).toArray().map(summary);
    if (!roots.length) return items;
    const tools = this.turns(request.thread, request.actor, [...new Set(roots.map(root => root.binding.turnId))]);
    const byItem = new Map(references.map(({ item, callId }) => [item.id, roots.find(root => root.callId === callId && root.startedAt <= (item.at ?? request.startedAt))]));
    return items.map(item => { const root = byItem.get(item.id); return root ? { ...item, execution: executionReference(tools, root) } : item; });
  }
}
