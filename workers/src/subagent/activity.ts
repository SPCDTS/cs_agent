import type { AssistantMessage } from "@earendil-works/pi-ai";
import { containsSecret } from "../memory/secrets";
import type { SubagentMeta, SubagentStatus } from "./model";

export type AgentDescription = { kind: "task" | "progress" | "result"; text: string; updatedAt: number };
export type SubagentActivity = {
  thread: string; actor: string; summary: string; description: AgentDescription;
  status: SubagentStatus; version: number; updatedAt: number;
};

/** 摘要只来自显式短句；旧任务退回第一句，不为展示额外请求模型。 */
export function shortSummary(text: string): string {
  if (containsSecret(text)) return "任务简介含敏感信息，已隐藏";
  const first = text.trim().split(/[\r\n。！？]/u, 1)[0]?.replace(/\s+/gu, " ").trim() ?? "";
  const chars = Array.from(first);
  return chars.length > 60 ? chars.slice(0, 59).join("") + "…" : first || "暂无任务简介";
}

/** 只取最终完整响应的显式首行，不读取 thinking，也不把任意回答猜成进度。 */
export function responseDescription(message: AssistantMessage, now: number): AgentDescription | undefined {
  if (message.stopReason === "error" || message.stopReason === "aborted") return;
  const text = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n").trim();
  const match = /^【(进度|结果)】\s*([^\r\n]+)/u.exec(text);
  if (!match) return;
  const hasTools = message.content.some(block => block.type === "toolCall");
  if (match[1] === "进度" && !hasTools || match[1] === "结果" && hasTools) return;
  return { kind: match[1] === "进度" ? "progress" : "result", text: shortSummary(match[2]), updatedAt: now };
}

export function subagentActivity(meta: SubagentMeta): SubagentActivity {
  const summary = shortSummary(meta.summary || meta.task), updatedAt = meta.activityAt ?? meta.endedAt ?? meta.createdAt;
  return { thread: meta.parent, actor: meta.id, summary, status: meta.status, version: meta.version, updatedAt,
    description: meta.progress ?? { kind: "task", text: summary, updatedAt } };
}

export const SUBAGENT_PROGRESS_RULE = "管理页需要简短任务进度：阶段变化时，在正常的工具调用前，正文第一行写‘【进度】’加一句 15–30 字中文动作简介；最终回答第一行写‘【结果】’加一句简短结果，之后正常给出完整回答。只描述实际完成或正在做的事，不写凭据或工具原始参数。不要为更新进度单独增加回合或工具调用，同一阶段无需重复。";
