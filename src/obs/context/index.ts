import { CodexSessionAdapter } from '../sessions/codex-adapter.js';
import { RESPONSE_BYTES } from '../sessions/content.js';
import { redactText } from '../redact.js';
import { SessionError } from '../sessions/types.js';
import { codexHistory } from './codex.js';
import { piHistory, type PiContextAdapter } from './pi-history.js';
import { TOKEN_NOTE, tokenizerName } from './tokens.js';
import type { AdapterSet, CategoryKey, ContextAnalysis, ContextOptions, HistoryMessage, HistoryResult, Provenance } from './types.js';
export type { ContextAnalysis, ContextOptions } from './types.js';

const labels: Record<CategoryKey, string> = { instructions: '指令', tools: '工具定义', history: '历史消息',
  tool_output: '工具输出', compaction: '压缩摘要', other: '其他 / 不可见' };
/** 契约字段 key/tokens/tokenizer 是固定元数据；任意正文已先做结构化脱敏，这里只脱敏字符串叶子。 */
function redactContext(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value, Number.MAX_SAFE_INTEGER);
  if (Array.isArray(value)) return value.map(redactContext);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactContext(item)]));
  return value;
}
function provenance(messages: HistoryMessage[]): Provenance {
  return (['unavailable', 'estimated', 'reconstructed', 'recorded'] as const).find(p => messages.some(m => m.provenance === p)) ?? 'unavailable';
}
export async function analyzeContext(adapters: AdapterSet, backend: 'codex' | 'pi', sessionId: string, options: ContextOptions = {}): Promise<ContextAnalysis> {
  if (options.phase !== undefined && options.phase !== 'before' && options.phase !== 'after') throw new SessionError(400, 'phase 必须是 before 或 after');
  if (options.at !== undefined && (!options.at || options.at.length > 256 || /[\\/\x00-\x1f\x7f]/.test(options.at))) throw new SessionError(400, 'at 无效');
  const adapter = adapters[backend];
  // 当前态必须先刷新回合目录，避免随后读取新 rollout 时仍使用旧的最后回合边界。
  await adapter?.refresh?.();
  const session = (await adapter?.listSessions())?.find(s => s.id === sessionId);
  if (!adapter || !session) throw new SessionError(404, '会话不存在');
  const turns = await adapter.turns(sessionId), current = options.at === undefined;
  const turn = options.at ?? turns.at(-1)?.turn ?? '', phase = current ? 'after' : options.phase ?? 'after';
  if (!current && !turns.some(t => t.turn === turn)) throw new SessionError(404, '回合不存在');
  let history: HistoryResult;
  if (backend === 'codex') {
    if (!(adapter instanceof CodexSessionAdapter)) throw new SessionError(503, 'Codex rollout 接口不可用');
    history = await codexHistory(adapter, sessionId, turn, phase, options);
  } else history = await piHistory(adapter as PiContextAdapter, sessionId, turn, phase, current);
  const configured = typeof options.windowTokens === 'number' ? options.windowTokens : options.windowTokens?.[backend];
  const stored = options.contextUsage?.all().find(u => u.backend === backend && u.key === session.scope)?.windowTokens;
  const capacity = configured ?? stored;
  const window = history.window ?? (capacity && capacity > 0 ? { tokens: capacity, source: configured ? 'configured.windowTokens' : 'context_usage.windowTokens' }
    : { tokens: backend === 'codex' ? 400000 : 200000, source: 'default (model window unavailable)' });
  const categories = (Object.keys(labels) as CategoryKey[]).map(key => {
    const items = history.messages.filter(m => m.category === key), available = items.filter(m => m.tokens.estimated !== undefined);
    return { key, label: labels[key], items: items.length, tokens: available.length ? { estimated: available.reduce((n, m) => n + m.tokens.estimated!, 0) } : {},
      provenance: provenance(items), ...(items.length ? {} : { note: '没有可见记录，不能据此认定实际占用为零。' }) };
  });
  const notes = [...history.notes, TOKEN_NOTE];
  const hidden = history.messages.filter(m => m.hidden).length;
  if (hidden) {
    const other = categories.find(c => c.key === 'other')!;
    other.provenance = 'unavailable'; other.note = `${hidden} 条消息含不可见正文；仅对可见部分估算。`;
  }
  if (history.messages.some(m => m.truncated)) notes.push('部分正文超过 2 MiB，估算仅覆盖上限内的内容。');
  const total = history.messages.reduce((sum, m) => sum + (m.tokens.estimated ?? 0), 0);
  const result: ContextAnalysis = { backend, session: sessionId, at: { turn, phase }, generatedAt: Date.now(), window,
    measured: history.measured, estimated: { total, tokenizer: history.tokenizer ?? await tokenizerName() },
    ...(history.measured ? { unexplained: history.measured.input - total } : {}), categories,
    messages: history.messages.map((m, index) => ({ index, kind: m.kind, category: m.category, provenance: m.provenance,
      tokens: m.tokens, preview: m.preview.slice(0, 240), ...(m.ref ? { ref: m.ref } : {}), ...(m.ts !== undefined ? { ts: m.ts } : {}), ...(m.callId ? { callId: m.callId } : {}) })),
    notes: [...new Set(notes)] };
  const safe = redactContext(result) as ContextAnalysis;
  safe.messages.forEach(m => { m.preview = redactText(m.preview, 240); });
  return safe;
}

/** 仅裁剪传输消息表；分类与总估算始终对应完整窗口。 */
export function boundedContext(analysis: ContextAnalysis): ContextAnalysis {
  const result = redactContext(analysis) as ContextAnalysis;
  result.messages.forEach(m => { m.preview = redactText(m.preview, 240); });
  const size = () => Buffer.byteLength(JSON.stringify(result));
  if (size() <= RESPONSE_BYTES) return result;
  result.messages = result.messages.map(m => ({ ...m, preview: m.preview.slice(0, 80) }));
  result.notes.push('响应超过 1 MiB，消息预览已缩短到 80 字符。');
  if (size() <= RESPONSE_BYTES) return result;
  const all = result.messages;
  result.notes.push('响应仍超过 1 MiB，逐消息表已截断；分类计数和 token 总量保留完整窗口统计。');
  let lo = 0, hi = all.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    result.messages = all.slice(0, mid);
    if (size() <= RESPONSE_BYTES) lo = mid; else hi = mid - 1;
  }
  result.messages = all.slice(0, lo);
  return result;
}
