import { ratio, usageWindow, type ContextUsage } from '../shared/format.js';
import type { ContextAnalysisOptions, ContextTurn, ModelRequestDetail } from '../shared/context-turns.js';

export type { ContextAnalysisOptions, ContextTurn, ThreadContextSeries } from '../shared/context-turns.js';
/** kind 缺省兼容旧用量调用；存储查询始终显式返回 kind。 */
export interface ContextUsageEvent { ts: number; key: string; kind?: 'usage'; detail: ContextUsage }
export interface ContextRequestEvent { ts: number; key: string; kind: 'request'; detail: ModelRequestDetail }
export type ContextEvent = ContextUsageEvent | ContextRequestEvent;

/** 旧页面适配与分析共用字段映射；请求时间以 at 为准。 */
export function asContextUsageEvent(event: ContextEvent): ContextUsageEvent {
  if (event.kind !== 'request') return event;
  const d = event.detail;
  return { ts: d.at, key: event.key, kind: 'usage', detail: {
    backend: d.backend, key: d.key, usedTokens: d.input, cachedTokens: d.cached,
    windowTokens: d.window, effectiveWindowTokens: d.effective_window, turns: d.turn, updatedAt: d.at, source: 'turn',
  } };
}
export interface SystemEvent { ts: number; stage: string; detail: Record<string, unknown> }

/**
 * 同一线程按 ts 升序输入；不修改输入、不读取时钟或存储。
 * 系统原因取 (prev.ts, ts]，按时间排序并去重，再追加间隔、窗口原因。
 */
export function analyzeContextTurns(
  events: ContextEvent[], system: SystemEvent[], opts: ContextAnalysisOptions = {},
): ContextTurn[] {
  const { missRatio = 0.5, partialRatio = 0.9, minPrevTokens = 4096, gapMs = 60 * 60_000 } = opts;
  const orderedSystem = [...system].sort((a, b) => a.ts - b.ts);
  const result: ContextTurn[] = [];
  const requestKeys = new Set(events.filter(event => event.kind === 'request').map(event => event.key));
  let prev: ContextTurn | undefined;
  let previousSource: ContextTurn['source'] | undefined;
  for (const event of events) {
    const { ts, key, detail: usage } = asContextUsageEvent(event);
    if (event.kind !== 'request' && usage.source === 'turn' && requestKeys.has(key)) continue;
    if (usage.source === 'estimate') continue;
    if (event.kind !== 'request' && usage.source === 'turn' && key.startsWith('@')) continue;
    const window = usageWindow(usage);
    const cached = usage.cachedTokens ?? 0;
    const turn: ContextTurn = {
      ts, key, seq: usage.source === 'compact' ? 0 : event.kind === 'request' ? event.detail.seq : 1,
      requests: 0, turn: usage.turns, used: usage.usedTokens, cached, uncached: Math.max(0, usage.usedTokens - cached),
      window, pct: ratio(usage.usedTokens, window) / 100, turns: usage.turns, source: usage.source, reasons: [],
      ...(event.kind === 'request' && event.detail.output !== undefined ? { output: event.detail.output } : {}),
      ...(prev ? { gapMs: ts - prev.ts } : {}),
    };
    if (usage.source === 'compact') {
      turn.mark = 'compact';
    } else if (prev && prev.used < minPrevTokens) {
      // 先排除低于缓存粒度的基准，再处理压缩、重建与命中率。
    } else if (previousSource === 'compact') {
      turn.mark = 'compact';
    } else if (prev && turn.turn === 1 && turn.seq === 1) {
      turn.mark = 'reset';
    } else if (!prev) {
      turn.mark = 'first';
    } else {
      // 可缓存前缀不可能超过本轮输入：上下文在两轮之间被压缩变短（旧版本没有 compact 记录）时，基准取较小者。
      const expected = Math.min(prev.used, usage.usedTokens);
      const hitRatio = expected > 0 ? cached / expected : 1;
      if (hitRatio < missRatio) turn.mark = 'miss';
      else if (hitRatio < partialRatio) turn.mark = 'partial';
      if (turn.mark) {
        const add = (reason: string) => { if (!turn.reasons.includes(reason)) turn.reasons.push(reason); };
        for (const event of orderedSystem) {
          if (event.ts <= prev.ts || event.ts > ts) continue;
          if (event.stage === 'settings_changed' && Array.isArray(event.detail.changed) &&
              event.detail.changed.some(field => ['codexModel', 'piModel', 'agentBackend'].includes(field))) add('切换模型');
          if (event.stage === 'prompt_changed') add('提示词变更');
        }
        if (turn.gapMs! > gapMs) add(`间隔 ${Math.round(turn.gapMs! / 60_000)} 分钟`);
        if (window !== prev.window) add('窗口变化');
        if (!turn.reasons.length) add('未知（可能是服务端缓存过期或驱逐）');
      }
    }
    result.push(turn);
    previousSource = usage.source;
    if (usage.source === 'turn') prev = turn;
  }
  const counts = new Map<string, number>();
  for (const turn of result) if (turn.source === 'turn') counts.set(turn.key, Math.max((counts.get(turn.key) ?? 0) + 1, turn.seq));
  for (const turn of result) if (turn.source === 'turn') turn.requests = counts.get(turn.key)!;
  return result;
}
