import type { Context, Message, AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeContext, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { containsSecret } from "../memory/secrets";
import { htmlToText } from "../tools/web-page";

import { emptyTotals, type ContextAnalysis, type ContextItem } from "./context-types";
import type { ContextOrigin } from "./context-source";

export type TextPart = { text: string; chars: number; truncated: boolean };
export type ContentBlock = { kind: "text" | "toolCall" | "image" | "thinking"; start: number; end: number; id?: string; name?: string };
export type MessagePart = TextPart & { blocks?: ContentBlock[] };
export type ContextSnapshot = {
  analysis?: ContextAnalysis;
  system: TextPart; messages: (MessagePart & { role: string; toolName?: string; toolCallId?: string; isError?: boolean })[];
  tools: (TextPart & { name: string })[]; messageCount: number; toolCount: number; omittedMessages: number;
  chars: { system: number; messages: number; tools: number }; truncated: boolean;
};
// 不保存认证选项或二进制；含凭据的文本整块隐藏，正文总量另有上限。
export function safeText(text: string): string { return containsSecret(text) ? "[含凭据的内容已隐藏]" : text; }
export function boundedText(text: string, limit = 12_000): TextPart {
  const clean = safeText(text);
  return { text: clean.slice(0, limit), chars: text.length, truncated: clean.length > limit };
}
export function errorSummary(message: string, status?: number): string {
  const clean = safeText(message);
  const text = /<(?:!doctype\s+html|html)\b/i.test(clean) ? htmlToText(clean).text : clean;
  return [status === undefined ? "" : `HTTP ${status}`, text || "上游返回空错误"].filter(Boolean).join(" · ").slice(0, 1000);
}
// 仅在内存中关联引擎贡献与实际请求；不存储或输出这份消息键。
export const messageKey = (message: Message) => JSON.stringify([message.role, message.timestamp, textOf(message)]);
export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(block => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return "[推理内容省略]";
    if (block.type === "toolCall") return JSON.stringify({ toolCallId: block.id, name: block.name, arguments: block.arguments }, null, 2);
    return "[图片内容省略]";
  }).join("\n");
}
function withBlocks(message: Message, part: TextPart): MessagePart {
  if (part.text === "[含凭据的内容已隐藏]" || typeof message.content === "string") return part;
  let offset = 0;
  const blocks: ContentBlock[] = [];
  for (const block of message.content) {
    const text = block.type === "text" ? block.text : block.type === "thinking" ? "[推理内容省略]"
      : block.type === "toolCall" ? JSON.stringify({ toolCallId: block.id, name: block.name, arguments: block.arguments }, null, 2) : "[图片内容省略]";
    if (offset >= part.text.length) break;
    blocks.push({ kind: block.type, start: offset, end: Math.min(part.text.length, offset + text.length),
      ...(block.type === "toolCall" ? { id: block.id, name: block.name } : {}) });
    offset += text.length + 1;
  }
  return { ...part, blocks };
}
export function snapshot(input: Context, origin?: ContextOrigin): ContextSnapshot {
  const messages = normalizeContext(input).messages, system = getCurrentSystemPrompt(messages), tools = getCurrentTools(messages);
  let left = 96_000;
  const part = (text: string, max: number): TextPart => {
    const clean = safeText(text), count = Math.min(left, max); left -= Math.min(clean.length, count);
    return { text: clean.slice(0, count), chars: text.length, truncated: clean.length > count };
  };
  const nonSystem = messages.filter(message => message.role !== "system");
  const captured = nonSystem.slice(-100);
  const systemPart = part(system, 24_000);
  const toolParts = tools.slice(0, 100).map(tool => ({ name: tool.name, ...part(JSON.stringify(tool, null, 2), 4000) }));
  const messageParts = captured.toReversed().map(message => ({ role: message.role,
    ...(message.role === "toolResult" ? { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError } : {}), ...withBlocks(message, part(textOf(message), 12_000)) })).reverse();
  const totals = emptyTotals();
  totals.system = system.length;
  const fingerprint = (text: string) => {
    const clean = safeText(text); let a = 2166136261, b = 5381;
    for (let i = 0; i < clean.length; i++) { a = Math.imul(a ^ clean.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ clean.charCodeAt(i); }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16) + ":" + clean.length;
  };
  const items: ContextItem[] = [{ id: "system", key: "system:" + fingerprint(system), category: "system", chars: system.length,
    label: "系统提示", images: 0, bodyAvailable: true, truncated: systemPart.truncated }];
  tools.forEach((tool, index) => {
    const text = JSON.stringify(tool, null, 2), body = toolParts[index]; totals.tools += text.length;
    items.push({ id: "tool:" + index, key: "tool:" + fingerprint(text), category: "tools", chars: text.length, label: safeText(tool.name).slice(0, 120),
      images: 0, bodyAvailable: !!body, truncated: !body || body.truncated });
  });
  let imageCount = 0, retainedChars = 0, addedChars = 0;
  nonSystem.forEach((message, index) => {
    const text = textOf(message), tag = origin?.tags.get(messageKey(message));
    const category = tag?.summary ? "summary" : message.role === "toolResult" ? "result" : message.role === "assistant" ? "assistant" : "user";
    const images = typeof message.content === "string" ? 0 : message.content.filter(block => block.type === "image").length;
    const body = messageParts[index - (nonSystem.length - captured.length)];
    totals[category] += text.length; imageCount += images;
    if (tag?.phase === "retained") retainedChars += text.length;
    if (tag?.phase === "added") addedChars += text.length;
    items.push({ id: "message:" + index, key: category + ":" + message.timestamp + ":" + fingerprint(text), category, chars: text.length,
      label: tag?.summary ? "压缩后的历史摘要" : (index + 1) + ". " + (message.role === "toolResult" ? safeText(message.toolName).slice(0, 120) : message.role),
      images, bodyAvailable: !!body, truncated: !body || body.truncated, ...(tag?.phase ? { phase: tag.phase } : {}) });
  });
  const analysis: ContextAnalysis = { items, metrics: { version: 1, chars: totals, messageCount: nonSystem.length, toolCount: tools.length, imageCount,
    ...(origin?.head ? { head: origin.head } : {}),
    ...(origin?.head?.kind === "compaction" && origin.head.plan ? { retainedChars, addedChars } : {}) } };
  return { analysis, system: systemPart, messages: messageParts, tools: toolParts, messageCount: nonSystem.length, toolCount: tools.length,
    omittedMessages: nonSystem.length - captured.length,
    chars: { system: system.length, messages: nonSystem.reduce((n, m) => n + textOf(m).length, 0),
      tools: tools.reduce((n, tool) => n + JSON.stringify(tool, null, 2).length, 0) },
    truncated: nonSystem.length > 100 || tools.length > 100 || [systemPart, ...toolParts, ...messageParts].some(p => p.truncated) };
}
export function responseSnapshot(message: AssistantMessage): MessagePart {
  return withBlocks(message, boundedText(textOf(message), 24_000));
}
