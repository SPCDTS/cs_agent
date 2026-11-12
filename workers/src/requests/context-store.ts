import { ToolStore } from "./tool-store";
import type { ContextInspection, ContextItem, ContextRequestSummary, ContextTimeline } from "./context-types";
import type { ContextSnapshot, MessagePart } from "./snapshot";
import type { RequestDetail, RequestRecord } from "./types";
import { ADMIN_PAGE_SIZE, type AdminCursor } from "../admin/pagination";

type Row = { id: string; started: number; record: string };
const summary = (record: RequestRecord): ContextRequestSummary => ({ id: record.id, startedAt: record.startedAt, provider: record.provider, model: record.model,
  inputTokens: record.inputTokens, cacheRead: record.cacheRead, contextWindow: record.contextWindow, status: record.status,
  ...(record.contextMetrics ? { metrics: record.contextMetrics } : {}) });

export function compareContext(previous: ContextItem[], current: ContextItem[]) {
  const pending = new Map<string, ContextItem[]>();
  for (const item of previous) { const group = pending.get(item.key) ?? []; group.push(item); pending.set(item.key, group); }
  const added: ContextItem[] = []; let kept = 0;
  for (const item of current) { const match = pending.get(item.key)?.shift(); if (match) kept += item.chars; else added.push(item); }
  return { added, removed: [...pending.values()].flat(), kept };
}

/** 所有查询只使用 RequestsDO 已有的请求表，不读取或唤醒执行 DO。 */
export class ContextStore {
  constructor(private readonly sql: SqlStorage) {}
  private row(id: string) { return this.sql.exec<Row>("SELECT id,started,record FROM requests WHERE id=?", id).toArray()[0]; }
  private payload(id: string): Pick<RequestDetail, "context" | "response"> | undefined {
    const row = this.sql.exec<{ payload: string }>("SELECT payload FROM request_details WHERE id=?", id).toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  timeline(thread: string, actor: string, before?: AdminCursor): ContextTimeline {
    const pageSize = ADMIN_PAGE_SIZE;
    const rows = this.sql.exec<Row>(`SELECT id,started,record FROM requests WHERE thread=? AND json_extract(record,'$.actor')=?
      AND purpose IN ('conversation','subagent') ${before ? "AND (started<? OR (started=? AND id<?))" : ""}
      ORDER BY started DESC,id DESC LIMIT ?`, thread, actor, ...(before ? [before.at, before.at, before.id] : []), pageSize + 1).toArray();
    const page = rows.slice(0, pageSize), last = page.at(-1);
    return { points: page.map(row => summary(JSON.parse(row.record))).reverse(),
      ...(rows.length > pageSize && last ? { next: JSON.stringify({ at: last.started, id: last.id }) } : {}) };
  }
  inspect(id: string): ContextInspection | undefined {
    const row = this.row(id); if (!row) return;
    const current: RequestRecord = JSON.parse(row.record), payload = this.payload(id);
    const prior = this.sql.exec<Row>(`SELECT id,started,record FROM requests WHERE thread=? AND json_extract(record,'$.actor')=? AND purpose=?
      AND (started<? OR (started=? AND id<?)) ORDER BY started DESC,id DESC LIMIT 1`,
      current.thread, current.actor, current.purpose, current.startedAt, current.startedAt, current.id).toArray()[0];
    const previous: RequestRecord | undefined = prior ? JSON.parse(prior.record) : undefined;
    const tools = new ToolStore(this.sql), oldContext = previous ? this.payload(previous.id)?.context : undefined;
    const old = oldContext?.analysis && previous ? { ...oldContext.analysis, items: tools.annotate(previous, oldContext) } : undefined;
    const analysis = payload?.context.analysis ? { ...payload.context.analysis, items: tools.annotate(current, payload.context) } : undefined;
    const head = analysis?.metrics.head, previousHead = old?.metrics.head;
    return { current: summary(current), previous: previous ? summary(previous) : null, analysis: analysis ?? null,
      comparison: analysis && old ? { ...compareContext(old.items, analysis.items),
        reset: head?.kind === "reset" && head.id !== previousHead?.id,
        compactionApplied: head?.kind === "compaction" && head.id !== previousHead?.id } : null };
  }
  part(id: string, part: string): { part: MessagePart; paired: { id: string; part: MessagePart }[] } | undefined {
    const payload = this.payload(id); if (!payload) return;
    const selected = part === "response" ? payload.response : contextPart(payload.context, part);
    if (!selected) return;
    const calls = new Set(selected.blocks?.flatMap(block => block.kind === "toolCall" && block.id ? [block.id] : []) ?? []);
    return { part: selected, paired: payload.context.messages.flatMap(message => message.toolCallId && calls.has(message.toolCallId)
      ? [{ id: message.toolCallId, part: message }] : []) };
  }
}

export function contextPart(context: ContextSnapshot, id: string): MessagePart | undefined {
  if (id === "system") return context.system;
  const match = /^(message|tool):(\d+)$/.exec(id); if (!match) return;
  const index = Number(match[2]);
  return match[1] === "tool" ? context.tools[index] : context.messages[index - context.omittedMessages];
}

export function contextMetadata(context: ContextSnapshot): ContextSnapshot {
  return { ...context, analysis: undefined, system: { ...context.system, text: "" },
    messages: [], tools: [] };
}
