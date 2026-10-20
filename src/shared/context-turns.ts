/**
 * 上下文监控的结构类型（设计 DESIGN-context-monitor §2）。判定函数在 src/obs/context-turns.ts；
 * 这里只放类型，供面板 UI 层在不依赖观测实现的前提下渲染。
 */
export interface ContextTurn {
  ts: number;
  ticket: string;
  used: number;
  cached: number;
  uncached: number;
  window: number;
  /** 占窗口的比例（0–1，可超过 1），不是百分数。 */
  pct: number;
  turns: number;
  source: 'turn' | 'compact' | 'estimate';
  mark?: 'miss' | 'partial' | 'first' | 'compact' | 'reset';
  reasons: string[];
  /** 与上一条实际 turn 的间隔；estimate 和 compact 不更新基准。 */
  gapMs?: number;
}
export interface ThreadContextSeries {
  backend: 'codex' | 'pi';
  key: string;
  turns: ContextTurn[];
  misses: number;
  window: number;
}
export interface ContextAnalysisOptions {
  missRatio?: number;
  partialRatio?: number;
  minPrevTokens?: number;
  gapMs?: number;
}
