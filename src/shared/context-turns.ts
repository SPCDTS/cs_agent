/**
 * 上下文监控的结构类型（设计 DESIGN-context-monitor §8）。判定函数在 src/obs/context-turns.ts；
 * 这里只放类型，供面板 UI 层在不依赖观测实现的前提下渲染。
 */
export interface ContextTurn {
  ts: number;
  ticket: string;
  /** 票据内请求序号，从 1 起；压缩分隔为 0。 */
  seq: number;
  /** 同票据请求总数；截断窗口至少保留已知最大 seq，压缩分隔为 0。 */
  requests: number;
  /** 线程中的票据回合序号。旧记录从 turns 恢复。 */
  turn?: number;
  used: number;
  cached: number;
  uncached: number;
  /** 请求输出 token 数；旧用量记录不提供。 */
  output?: number;
  window: number;
  /** 占窗口的比例（0–1，可超过 1），不是百分数。 */
  pct: number;
  turns: number;
  source: 'turn' | 'compact' | 'estimate';
  mark?: 'miss' | 'partial' | 'first' | 'compact' | 'reset';
  reasons: string[];
  /** 与上一条实际请求的间隔；estimate 和 compact 不更新基准。 */
  gapMs?: number;
}
export interface ThreadContextSeries {
  backend: 'codex' | 'pi';
  key: string;
  turns: ContextTurn[];
  /** 当前返回窗口内的请求数，不包含压缩分隔。 */
  requests: number;
  /** 当前返回窗口内的不同票据数，不包含压缩分隔。 */
  tickets: number;
  misses: number;
  window: number;
}
export interface ContextAnalysisOptions {
  missRatio?: number;
  partialRatio?: number;
  minPrevTokens?: number;
  gapMs?: number;
}
/** model_request 事件的原始 detail；at 是模型请求时间，单位毫秒。 */
export interface ModelRequestDetail {
  backend: 'codex' | 'pi';
  key: string;
  ticket: string;
  seq: number;
  turn: number;
  input: number;
  cached?: number;
  output?: number;
  window: number;
  effective_window?: number;
  at: number;
}
/** 票据预览摘要；字段口径与票据列表、线程回合摘要一致。 */
export interface TicketBrief {
  ticket: string;
  scope: string;
  ts: number;
  status: string;
  sender: string | null;
  route: string | null;
  backend: string | null;
  duration_ms: number;
  text: string;
  reply: string;
  tools: number;
  settings?: Record<string, unknown>;
}
