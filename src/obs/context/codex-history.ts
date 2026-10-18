import { estimateTokens, preview, safeBody } from './tokens.js';
import type { HistoryMessage } from './types.js';
import { utf8Slice } from '../sessions/content.js';

export const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
export const str = (x: unknown): string | undefined => typeof x === 'string' ? x : undefined;
export const num = (x: unknown): number | undefined => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
export const time = (x: unknown): number | undefined => typeof x === 'string' ? num(Date.parse(x)) : num(x);
const parts = (x: unknown): unknown[] => Array.isArray(x) ? x : [];
const SUMMARY = 'Another language model started to solve this problem';
const USER_CONTEXT = /^(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>|<subagent_notification>|<user_shell_command>|<recommended_plugins>|<agent_message_board_notification>|<additional_context>|<internal_model_context>|<skill>)/i;
const DEV_CONTEXT = /^<(?:permissions instructions|model_switch|managed_developer_instructions|persistent_mode|apps_instructions|collaboration_mode|multi_agent_role|multi_agent_mode|environment|git_attribution|plugins_instructions|realtime|skills_instructions|tools|personality_spec|token_budget|context_window|rollout_budget)/i;

function textContent(value: unknown, modalities?: number): { text: string; hidden: boolean; modified?: boolean } {
  if (typeof value === 'string') return { text: value, hidden: false };
  if (!Array.isArray(value)) return { text: value === undefined ? '' : safeBody(value), hidden: false };
  let hidden = false, modified = false;
  const text = value.map(raw => {
    const p = object(raw);
    if (typeof p.text === 'string') return p.text;
    if (/image|audio|video/.test(String(p.type))) {
      if (modalities !== undefined && /image|audio/.test(String(p.type))) {
        const image = /image/.test(String(p.type));
        if (!(modalities & (image ? 1 : 2))) {
          modified = true;
          return image ? 'image content omitted because you do not support image input' : 'audio content omitted because you do not support audio input';
        }
      }
      hidden = true; return '[媒体正文不可估算]';
    }
    return '';
  }).filter(Boolean).join('\n');
  return { text, hidden, modified };
}

/** 先投影为有界观测消息；不保存 reasoning 密文、图片数据或完整正文。 */
export async function codexMessage(raw: unknown, extra: Partial<HistoryMessage> = {}): Promise<HistoryMessage | undefined> {
  const outer = object(raw), p = Object.keys(object(outer.item)).length ? object(outer.item) : outer;
  const type = str(p.type) ?? 'other', role = str(p.role);
  if (['configuration_update', 'compaction_trigger', 'other'].includes(type)) return undefined;
  let category: HistoryMessage['category'] = 'history', kind = type, content: unknown = p.content;
  if (type === 'message') {
    kind = role ?? 'message';
    if (role === 'system' || role === 'developer') category = 'instructions';
  } else if (type === 'reasoning') { kind = 'thinking'; content = p.summary; }
  else if (['compaction', 'context_compaction'].includes(type)) { category = 'compaction'; content = p.summary ?? p.content; }
  else if (type === 'additional_tools') { category = 'tools'; content = safeBody(p.tools); }
  else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(type)) {
    category = 'tool_output'; kind = 'tool_result'; content = p.output ?? safeBody(p.tools);
  } else if (['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call'].includes(type)) {
    kind = 'tool_call'; content = safeBody({ name: p.name, arguments: typeof p.arguments === 'string' ? safeBody(p.arguments) : p.arguments,
      input: typeof p.input === 'string' ? safeBody(p.input) : p.input, action: p.action });
  } else if (type === 'web_search_call') { kind = 'tool_call'; content = safeBody({ name: 'web_search', action: p.action }); }
  else if (type === 'agent_message') { content = p.content; }
  else { content = p.text ?? p.message; category = 'other'; }
  const rendered = textContent(content), text = safeBody(rendered.text);
  const kinds = parts(object(p.internal_chat_message_metadata_passthrough).content_item_kinds);
  const summary = text.startsWith(SUMMARY) || kinds.includes('compaction.summary');
  if (summary) category = 'compaction';
  const contextual = type === 'message' && (typeof p.content === 'string' ? [p.content] : parts(p.content)).some(x => {
    const s = (typeof x === 'string' ? x : String(object(x).text ?? '')).trimStart();
    return (role === 'user' ? USER_CONTEXT : role === 'developer' ? DEV_CONTEXT : /$a/).test(s);
  });
  if (type === 'message' && role === 'user' && /^(?:# AGENTS\.md instructions|<user_instructions>)/i.test(text.trimStart()))
    category = 'instructions';
  const hidden = rendered.hidden || (type === 'reasoning' && !!p.encrypted_content)
    || (['compaction', 'context_compaction'].includes(type) || category === 'other') && !text;
  const estimated = text ? await estimateTokens(text, role ?? kind) : undefined;
  // 保存四种有界模态投影，最终模型切换也能在规范化最后一步应用过滤。
  const mediaViews: HistoryMessage['mediaViews'] = rendered.hidden ? {} : undefined;
  if (mediaViews) for (const mask of [0, 1, 2, 3]) {
    const filtered = textContent(content, mask), body = safeBody(filtered.text), count = await estimateTokens(body, role ?? kind);
    mediaViews[mask] = { preview: preview(body), tokens: { estimated: count.tokens }, hidden: filtered.hidden,
      provenance: filtered.modified ? 'reconstructed' : 'recorded' };
  }
  return { kind, role, itemType: type, category, provenance: text ? 'recorded' : hidden ? 'unavailable' : 'recorded',
    tokens: estimated ? { estimated: estimated.tokens } : hidden ? {} : { estimated: 4 }, preview: preview(text || '[正文不可用]'),
    id: str(p.id), callId: str(p.call_id), toolName: str(p.name), contextual,
    boundary: type === 'agent_message' || (type === 'message' && role === 'user' && !contextual && !summary),
    external: !p.call_id || type === 'tool_search_output' && p.execution === 'server',
    hidden, mediaViews, truncated: estimated?.truncated,
    ...(role === 'user' && !summary && !contextual ? { legacyText: { bytes: Buffer.byteLength(text),
      head: utf8Slice(text, 0, 80_000), tail: utf8Slice(text, Math.max(0, Buffer.byteLength(text) - 80_000), 80_000) } } : {}), ...extra };
}

export type HistoryRecord = {
  type: string; event?: string; turnId?: string; numTurns?: number; messages?: HistoryMessage[];
  replacement?: HistoryMessage[]; legacySummary?: HistoryMessage; ts?: number;
  file?: string; offset?: number; indexedTurn?: string;
  baseline?: HistoryMessage; tools?: HistoryMessage[]; window?: number;
  usage?: { input: number; cached?: number }; inputCheckpoint?: boolean;
  inputModalities?: string[]; historyMode?: string; hasWindowNumber?: boolean;
};

export async function projectRecord(raw: unknown, location?: { file: string; offset: number }): Promise<HistoryRecord> {
  const r = object(raw), p = object(r.payload), type = str(r.type) ?? '', ts = time(r.timestamp);
  const result: HistoryRecord = { type, event: str(p.type), turnId: str(p.turn_id), ts, ...location };
  if (type === 'response_item') {
    const message = await codexMessage(p, { ts, location });
    // history.rs 的 is_api_message 不保留原始 system 消息；基础指令另从元数据恢复。
    result.messages = message && message.role !== 'system' ? [message] : [];
  }
  if (type === 'compacted') {
    if (Array.isArray(p.replacement_history)) {
      result.replacement = (await Promise.all(p.replacement_history.map(item => codexMessage(item, { ts })))).filter((x): x is HistoryMessage => !!x);
      result.inputCheckpoint = p.window_number !== undefined && p.resume_metadata !== undefined && p.resume_metadata !== null;
      result.hasWindowNumber = p.window_number !== undefined;
    } else {
      result.legacySummary = await codexMessage({ type: 'message', role: 'user', content: str(p.message) || '(no summary available)' },
        { ts, category: 'compaction', provenance: 'reconstructed', boundary: false });
    }
  }
  if (type === 'turn_context' || type === 'session_meta') {
    if (Array.isArray(p.input_modalities)) result.inputModalities = p.input_modalities.filter((x): x is string => typeof x === 'string');
    result.historyMode = str(p.history_mode);
    const base = p.base_instructions;
    const content = typeof base === 'string' ? base : str(object(base).text);
    if (content) result.baseline = await codexMessage({ type: 'message', role: 'system', content }, { ts });
  }
  if (type === 'event_msg' && p.type === 'thread_settings_applied') {
    const tools = p.tools ?? object(p.settings).tools ?? p.mcp_tools;
    if (Array.isArray(tools)) result.tools = await Promise.all(tools.map(async tool => {
      const body = safeBody(tool), count = await estimateTokens(body, 'tool');
      return { kind: 'tool_definition', category: 'tools' as const, provenance: 'estimated' as const,
        preview: preview(body), tokens: { estimated: count.tokens }, toolName: str(object(tool).name), truncated: count.truncated };
    }));
  }
  const info = object(p.info), usage = object(info.last_token_usage);
  result.window = num(info.model_context_window) ?? num(p.model_context_window);
  if (type === 'event_msg' && p.type === 'token_count' && num(usage.input_tokens) !== undefined)
    result.usage = { input: num(usage.input_tokens)!, cached: num(usage.cached_input_tokens) };
  if (type === 'event_msg' && p.type === 'thread_rolled_back') result.numTurns = num(p.num_turns) ?? 0;
  return result;
}

/** 0.163.0：反向选存活检查点，再从其基线正向重放；中止本身不等于回滚。 */
export async function reconstructCodexHistory(records: readonly HistoryRecord[]): Promise<HistoryMessage[]> {
  let checkpoint = -1, pending = 0;
  const newest = records.findLastIndex(r => r.type === 'compacted');
  const paginated = records.findLast(r => r.historyMode)?.historyMode === 'paginated';
  const input = newest >= 0 && (records[newest].inputCheckpoint || paginated && records[newest].hasWindowNumber && records[newest].replacement) ? newest : -1;
  let segment: { id?: string; user: boolean; checkpoint: number } | undefined;
  const finish = () => {
    if (!segment) return;
    if (pending > 0) { if (segment.user) pending--; }
    else if (checkpoint < 0) checkpoint = segment.checkpoint;
    segment = undefined;
  };
  const preceding: Array<string | undefined> = [];
  let turn: string | undefined;
  for (const r of records) { if (r.event === 'task_started' || r.event === 'turn_started') turn = r.turnId; preceding.push(turn); }
  for (let i = records.length - 1; i > input; i--) {
    const r = records[i];
    if (r.event === 'thread_rolled_back') { pending += r.numTurns ?? 0; continue; }
    if (r.event === 'task_complete' || r.event === 'turn_aborted') {
      if (preceding[i] && r.turnId && preceding[i] !== r.turnId) continue;
      segment ??= { user: false, checkpoint: -1 }; segment.id ??= r.turnId;
    } else if (r.event === 'task_started' || r.event === 'turn_started') {
      if (!segment?.id || !r.turnId || segment.id === r.turnId) finish();
    } else if (r.type === 'compacted' || r.type === 'turn_context' || r.type === 'response_item' || r.event === 'user_message') {
      // 旧日志没有 task_started 时，以真实 user 消息边界划分片段。
      if (!preceding[i] && r.messages?.some(m => m.boundary) && segment?.user) finish();
      segment ??= { user: false, checkpoint: -1 };
      segment.id ??= r.turnId;
      segment.user ||= r.event === 'user_message' || !!r.messages?.some(m => m.boundary);
      if (r.replacement && segment.checkpoint < 0) segment.checkpoint = i;
    }
  }
  finish();
  if (checkpoint < 0) checkpoint = input;
  let history = checkpoint >= 0 ? [...records[checkpoint].replacement ?? []] : [];
  for (let i = checkpoint + 1; i < records.length; i++) {
    const r = records[i];
    if (r.messages) history.push(...r.messages);
    if (r.legacySummary) {
      const retained: HistoryMessage[] = [];
      let remaining = 20_000;
      for (const m of history.filter(m => m.boundary && m.role === 'user').reverse()) {
        const text = m.legacyText;
        if (!remaining || !text) break;
        const cost = Math.ceil(text.bytes / 4);
        if (cost <= remaining && !m.hidden) retained.push(m);
        else {
          const bytes = remaining * 4, left = Math.floor(bytes / 2), right = bytes - left;
          const body = text.bytes <= bytes ? text.head : utf8Slice(text.head, 0, left)
            + `…${Math.ceil((text.bytes - bytes) / 4)} tokens truncated…`
            + utf8Slice(text.tail, Math.max(0, Buffer.byteLength(text.tail) - right), right);
          const count = await estimateTokens(body, 'user');
          retained.push({ ...m, preview: preview(body), tokens: { estimated: count.tokens }, provenance: 'reconstructed',
            hidden: false, location: undefined, ref: undefined, mediaViews: undefined });
        }
        remaining = Math.max(0, remaining - cost);
      }
      history = [...retained.reverse(), r.legacySummary];
    }
    if (r.event === 'thread_rolled_back' && r.numTurns) {
      const boundaries = history.flatMap((m, j) => m.boundary ? [j] : []);
      if (boundaries.length) {
        let cut = boundaries[Math.max(0, boundaries.length - r.numTurns)];
        while (cut > boundaries[0] && history[cut - 1].contextual) cut--;
        history = history.slice(0, cut);
      }
    }
  }
  return normalizeCodexHistory(history, survivingRecords(records).findLast(r => r.inputModalities)?.inputModalities);
}

/** 恢复设置也遵循回滚后的存活回合，不能把已撤销回合的 turn_context 当作基线。 */
export function survivingRecords(records: readonly HistoryRecord[]): HistoryRecord[] {
  const segments: Array<{ user: boolean; explicit: boolean; records: HistoryRecord[] }> = [{ user: false, explicit: false, records: [] }];
  for (const r of records) {
    if (r.event === 'thread_rolled_back' && r.numTurns) {
      let remaining = r.numTurns;
      while (remaining && segments.length > 1) { if (segments.pop()!.user) remaining--; }
      if (remaining && segments[0].user) segments[0] = { user: false, explicit: false, records: [] };
      segments.push({ user: false, explicit: false, records: [] });
      continue;
    }
    const boundary = !!r.messages?.some(m => m.boundary) || r.event === 'user_message';
    const started = r.event === 'task_started' || r.event === 'turn_started';
    const last = segments.at(-1)!;
    if (started || boundary && !last.explicit && (last.user || last.records.length)) segments.push({ user: false, explicit: started, records: [] });
    const current = segments.at(-1)!;
    current.user ||= boundary; current.records.push(r);
  }
  return segments.flatMap(segment => segment.records);
}

const outputFor: Record<string, string> = { function_call: 'function_call_output', local_shell_call: 'function_call_output',
  custom_tool_call: 'custom_tool_call_output', tool_search_call: 'tool_search_output' };
export function normalizeCodexHistory(history: readonly HistoryMessage[], inputModalities?: readonly string[]): HistoryMessage[] {
  const calls = new Set(history.filter(m => outputFor[m.itemType ?? ''] && m.callId).map(m => `${outputFor[m.itemType!]}:${m.callId}`));
  const outputs = new Set(history.filter(m => m.kind === 'tool_result').map(m => `${m.itemType}:${m.callId}`));
  const paired = history.flatMap(m => {
    if (m.kind === 'tool_result' && !m.external && !calls.has(`${m.itemType}:${m.callId}`)) return [];
    const type = outputFor[m.itemType ?? ''];
    if (!type || !m.callId || outputs.has(`${type}:${m.callId}`)) return [m];
    return [m, { kind: 'tool_result', category: 'tool_output', provenance: 'reconstructed', itemType: type,
      callId: m.callId, tokens: { estimated: 6 }, preview: type === 'tool_search_output' ? '[]' : 'aborted' } as HistoryMessage];
  });
  if (!inputModalities) return paired;
  const mask = (inputModalities.includes('image') ? 1 : 0) | (inputModalities.includes('audio') ? 2 : 0);
  return paired.map(m => m.mediaViews?.[mask] ? { ...m, ...m.mediaViews[mask] } : m);
}
