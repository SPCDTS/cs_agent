import { ratio, usageWindow, type ContextUsage } from '../shared/format.js';
import type { ContextAnalysisOptions, ContextTurn } from '../shared/context-turns.js';

export type { ContextAnalysisOptions, ContextTurn, ThreadContextSeries } from '../shared/context-turns.js';
export interface ContextUsageEvent { ts: number; ticket: string; detail: ContextUsage }
export interface SystemEvent { ts: number; stage: string; detail: Record<string, unknown> }

/**
 * 同一线程按 ts 升序输入；不修改输入、不读取时钟或存储。
 * 系统原因取 (prev.ts, ts]，按时间排序并去重，再追加间隔、窗口原因。
 */
export function analyzeContextTurns(
  events: ContextUsageEvent[], system: SystemEvent[], opts: ContextAnalysisOptions = {},
): ContextTurn[] {
  const { missRatio = 0.5, partialRatio = 0.9, minPrevTokens = 4096, gapMs = 60 * 60_000 } = opts;
  const orderedSystem = [...system].sort((a, b) => a.ts - b.ts);
  const result: ContextTurn[] = [];
  let prev: ContextTurn | undefined;
  let previousSource: ContextTurn['source'] | undefined;
  for (const { ts, ticket, detail: usage } of events) {
    if (usage.source === 'estimate') continue;
    const window = usageWindow(usage);
    const cached = usage.cachedTokens ?? 0;
    const turn: ContextTurn = {
      ts, ticket, used: usage.usedTokens, cached, uncached: Math.max(0, usage.usedTokens - cached),
      window, pct: ratio(usage.usedTokens, window) / 100, turns: usage.turns, source: usage.source, reasons: [],
      ...(prev ? { gapMs: ts - prev.ts } : {}),
    };
    if (usage.source === 'compact') {
      turn.mark = 'compact';
    } else if (prev && prev.used < minPrevTokens) {
      // 先排除低于缓存粒度的基准，再处理压缩、重建与命中率。
    } else if (previousSource === 'compact') {
      turn.mark = 'compact';
    } else if (prev && usage.turns === 1) {
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
  return result;
}
