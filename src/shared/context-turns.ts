/**
 * 上下文监控的结构类型（docs/DASHBOARD.md §5）。判定函数在 src/obs/context-turns.ts；
 * 这里只放类型，供面板 UI 层在不依赖观测实现的前提下渲染。
 */
export interface ContextTurn {
  ts: number;
  /** 请求所属的 trace 键（回合 turn:<id>；旧数据为旧版入站键）；压缩记录为线程级键。 */
  key: string;
  /** 回合内请求序号，从 1 起；压缩分隔为 0。 */
  seq: number;
  /** 同回合请求总数；截断窗口至少保留已知最大 seq，压缩分隔为 0。 */
  requests: number;
  /** 线程中的回合序号。旧记录从 turns 恢复。 */
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
  /** 当前返回窗口内的不同回合数，不包含压缩分隔。 */
  turnCount: number;
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
  /** 所属回合的 trace 键；旧事件里字段名为 ticket，读取时一律取事件行的 key 列 */
  trace_key: string;
  seq: number;
  turn: number;
  input: number;
  cached?: number;
  output?: number;
  window: number;
  effective_window?: number;
  at: number;
}
/** 回合预览摘要；字段口径与回合列表、线程回合摘要一致。 */
export interface TurnBrief {
  key: string;
  scope: string;
  /** 会话键 owner / group:<id> / private:<qq> */
  thread: string | null;
  /** 回合种类 user / scheduled / wake */
  kind: string | null;
  ts: number;
  status: string;
  sender: string | null;
  backend: string | null;
  duration_ms: number;
  text: string;
  reply: string;
  tools: number;
  /** 本轮发出的消息条数 */
  sends: number;
  settings?: Record<string, unknown>;
}
