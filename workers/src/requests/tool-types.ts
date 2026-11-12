import { Type, type Static } from "typebox";

export const ToolSummary = Type.Object({
  id: Type.String(), thread: Type.String(), actor: Type.Optional(Type.String()),
  binding: Type.Object({ turnId: Type.String(), inputId: Type.String(), generation: Type.Number() }),
  callId: Type.String(), parentCallId: Type.Optional(Type.String()), name: Type.String(),
  argumentPreview: Type.Optional(Type.String()), startedAt: Type.Number(), endedAt: Type.Union([Type.Number(), Type.Null()]),
  status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error"), Type.Literal("interrupted")]),
  detailAvailable: Type.Optional(Type.Boolean()),
});
export type ToolSummary = Static<typeof ToolSummary>;
export const ExecutionReference = Type.Object({ id: Type.String(), label: Type.String(), calls: Type.Number(), failures: Type.Number() });
export type ExecutionReference = Static<typeof ExecutionReference>;
export const ToolExecution = Type.Object({ rootId: Type.String(), tools: Type.Array(ToolSummary), sourceRequestId: Type.Optional(Type.String()) });
export type ToolExecution = Static<typeof ToolExecution>;

/** 工具调用 ID 只在同一 actor / 回合内配对；相同名字的多次调用保留为独立节点。 */
export function toolChildren(tools: readonly ToolSummary[], parent: ToolSummary): ToolSummary[] {
  return tools.filter(tool => tool.parentCallId === parent.callId && tool.binding.turnId === parent.binding.turnId
    && (tool.actor ?? "thread") === (parent.actor ?? "thread"));
}
export function executionTools(tools: readonly ToolSummary[], root: ToolSummary): ToolSummary[] {
  const found: ToolSummary[] = [], seen = new Set<string>(), pending = [root];
  for (let tool = pending.shift(); tool; tool = pending.shift()) {
    if (seen.has(tool.id)) continue;
    seen.add(tool.id); found.push(tool); pending.push(...toolChildren(tools, tool));
  }
  return found;
}
export function executionReference(tools: readonly ToolSummary[], root: ToolSummary): ExecutionReference {
  const children = executionTools(tools, root).filter(tool => tool.id !== root.id), names = new Map<string, number>();
  for (const tool of children) names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
  const label = [...names].slice(0, 4).map(([name, count]) => name + (count > 1 ? " ×" + count : "")).join(" · ");
  return { id: root.id, label: label + (names.size > 4 ? " 等 " + names.size + " 种工具" : ""), calls: children.length,
    failures: children.filter(tool => tool.status === "error" || tool.status === "interrupted").length };
}
