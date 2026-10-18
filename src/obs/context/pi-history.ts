import type { Message } from '@earendil-works/pi-ai';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { CompactionEntry, type ContextView } from '@earendil-works/pi-durable';
import type { ContentRef, SessionAdapter } from '../sessions/types.js';
import { SessionError } from '../sessions/types.js';
import { utf8Slice } from '../sessions/content.js';
import { estimateTokens, MAX_BODY_BYTES, preview, safeBody, tokenizerName } from './tokens.js';
import type { HistoryMessage, HistoryResult } from './types.js';

export type PiContextAdapter = SessionAdapter & {
  context(id: string, at?: string): Promise<ContextView>;
  contextBoundary?(id: string, turn: string, phase: 'before' | 'after'): Promise<string>;
  contextRef?(id: string, entry: string, kind: string): Promise<ContentRef | undefined>;
};
export async function piHistory(adapter: PiContextAdapter, session: string, turn: string, phase: 'before' | 'after', current: boolean): Promise<HistoryResult> {
  if (typeof adapter.context !== 'function') throw new SessionError(503, 'Pi 历史上下文接口不可用');
  let at: string | undefined;
  if (!current) {
    if (adapter.contextBoundary) at = await adapter.contextBoundary(session, turn, phase);
    else if (phase === 'before') at = turn;
    else {
      const blocks = await adapter.blocks(session, turn);
      at = String(blocks.at(-1)?.meta?.entry ?? turn);
    }
  }
  const view = await adapter.context(session, at), messages: HistoryMessage[] = [], notes: string[] = [];
  const tokenizer = await tokenizerName(), fallback = tokenizer !== 'o200k_base';
  type Origin = { compaction: boolean; entry: string; single: boolean };
  const origin = new Map<Message, Origin>();
  view.contributions.forEach((contribution, i) => contribution.forEach(message => {
    const entry = view.entries[i];
    if (entry) origin.set(message, { compaction: CompactionEntry.is(entry), entry: String(entry.id), single: contribution.length === 1 });
  }));
  // 公开 source 可以序列化/复制 messages；匹配完整消息而非显示预览。
  const byValue = new Map<string, Origin | undefined>();
  for (const [message, entry] of origin) {
    const key = JSON.stringify(message);
    byValue.set(key, byValue.has(key) ? undefined : entry);
  }
  for (const message of view.messages) if (!origin.has(message)) {
    const found = byValue.get(JSON.stringify(message));
    if (found) origin.set(message, found);
  }
  const blocks = adapter.contextRef ? [] : (await Promise.all((await adapter.turns(session)).filter(t => Number(t.turn) <= Number(turn))
    .map(t => adapter.blocks(session, t.turn)))).flat();
  const add = async (kind: string, category: HistoryMessage['category'], value: unknown, message?: Message) => {
    const body = safeBody(value), count = await estimateTokens(body, message?.role ?? kind);
    const source = message ? origin.get(message) : undefined;
    const actualCategory = source?.compaction ? 'compaction' : category;
    const blockKind = actualCategory === 'compaction' ? 'compaction' : kind;
    // 组合消息、图片和思考不能借用某一文本块的 ref；适配器拒绝签发时也不能绕过它。
    const textOnly = message && (typeof message.content === 'string' || message.content.every(p => p.type === 'text'));
    const singleBlock = textOnly && (typeof message.content === 'string' || message.content.length === 1
      || message.role === 'toolResult' || actualCategory === 'compaction');
    const matches = source ? blocks.filter(b => b.meta?.entry === source.entry && b.kind === blockKind) : [];
    const ref = source?.single && singleBlock ? adapter.contextRef
      ? await adapter.contextRef(session, source.entry, blockKind)
      : matches.length === 1 ? matches[0].ref : undefined : undefined;
    const limited = utf8Slice(body, 0, MAX_BODY_BYTES);
    const fallbackMessage = message ? { ...message, content: typeof message.content === 'string' ? limited : [{ type: 'text', text: limited }] } as Message : undefined;
    messages.push({ kind, category: actualCategory, provenance: 'recorded', preview: preview(body),
      tokens: { estimated: fallback && fallbackMessage ? estimateMessageTokens(fallbackMessage) : count.tokens }, truncated: count.truncated,
      ts: message?.timestamp, ref, callId: message?.role === 'toolResult' ? message.toolCallId : undefined });
  };
  const system = getCurrentSystemPrompt(view.messages);
  if (system) await add('system', 'instructions', system);
  for (const tool of getCurrentTools(view.messages)) await add('tool_definition', 'tools', tool);
  for (const message of view.messages) {
    if (message.role === 'system') continue;
    const visible = typeof message.content === 'string' ? message.content : message.content.flatMap(part => {
      if (part.type === 'text') return [{ type: 'text', text: part.text }];
      if (part.type === 'toolCall') return [{ type: 'toolCall', text: safeBody({ name: part.name, arguments: part.arguments }) }];
      if (part.type === 'thinking' && !part.redacted) return [{ type: 'thinking', text: part.thinking }];
      return [{ type: 'unavailable', text: '[媒体或加密正文不可用]' }];
    });
    await add(message.role === 'toolResult' ? 'tool_result' : message.role, message.role === 'toolResult' ? 'tool_output' : 'history', visible, message);
    if (Array.isArray(message.content) && message.content.some(p => p.type === 'image' || p.type === 'thinking' && p.redacted))
      messages[messages.length - 1].hidden = true;
  }
  const last = view.messages.findLast(m => m.role === 'assistant');
  let measured: HistoryResult['measured'];
  if (last?.role === 'assistant') {
    const position = view.messages.lastIndexOf(last), usage = last.usage;
    const compactedAfter = view.messages.slice(position + 1).some(m => origin.get(m)?.compaction);
    const lastEntry = origin.get(last)?.entry;
    measured = { input: usage.input + usage.cacheRead + usage.cacheWrite, cached: usage.cacheRead,
      at: last.timestamp, stale: compactedAfter || (lastEntry !== undefined && Number(lastEntry) < Number(turn)), source: 'pi.context.assistant.usage' };
  }
  notes.push(`pi-ai estimateMessageTokens 对照总计：${view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)} token。`);
  notes.push('Pi context() 是已提交历史；系统与工具由公开 transcript API 折叠，下一次 prepare/provider 转换仍可能追加或改变请求。');
  if (fallback) notes.push('o200k_base 不可用，消息估算回退到 pi-ai estimateMessageTokens。');
  return { messages, measured, notes, tokenizer: fallback ? 'pi-ai estimateMessageTokens' : tokenizer };
}
