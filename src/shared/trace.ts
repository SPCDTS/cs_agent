import { redact } from './redact.js';
/** 实时视图收到的事件：与入库同一份脱敏，不经存储（存储降级或预算丢弃时实时视图仍可见）。 */
/** key 为 trace 键：turn:<回合 id>、in:<入站键>、thr:<会话键>，或 @ 开头的系统键（@settings 等）。 */
export interface LiveEvent { key: string; scope: string; ts: number; stage: string; status: string; duration_ms: number | null; detail: Record<string, unknown> }
export interface EventOptions { ts?: number; status?: string; durationMs?: number; detail?: unknown; scope?: string }
export interface ObsEvent { id: number; key: string; scope: string; ts: number; stage: string; status: string; duration_ms: number | null; detail_json: string }
export interface TraceStore {
  append(e: Omit<ObsEvent, 'id' | 'detail_json'> & { detail?: unknown }): ObsEvent | undefined;
}
type Listener = (e: ObsEvent) => void;
function errorCategory(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/401|403|unauthorized|authentication|invalid.api.key|鉴权|认证/i.test(text)) return 'auth';
  if (/timeout|timed out|超时|abort/i.test(text)) return 'timeout';
  if (/ECONN|ENOTFOUND|fetch failed|unavailable|不可用/i.test(text)) return 'unavailable';
  if (/refus|content.?(policy|filter)|拒绝|违规/i.test(text)) return 'refused';
  return 'failed';
}
/** 观测失败不影响业务副作用；丢失数供总览报告。 */
export class Trace {
  private listeners = new Set<Listener>();
  private taps = new Set<(e: LiveEvent) => void>();
  dropped = 0;
  constructor(private store?: TraceStore) {}
  attach(store?: TraceStore): void { this.store = store; }
  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /** 进程内实时事件总线：每次 event() 同步推送（先于入库），供面板 /live 的 SSE 使用。 */
  tap(fn: (e: LiveEvent) => void): () => void { this.taps.add(fn); return () => { this.taps.delete(fn); }; }
  event(key: string, stage: string, opts: EventOptions = {}): void {
    if (!this.store && !this.taps.size) return;
    try {
      const detail = opts.status === 'failed' && opts.detail && typeof opts.detail === 'object'
        ? { ...opts.detail, error_category: errorCategory((opts.detail as Record<string, unknown>).error) } : opts.detail;
      const ts = opts.ts !== undefined && Number.isFinite(opts.ts) ? Math.max(0,opts.ts) : Date.now(), status = opts.status ?? 'ok';
      const duration_ms = opts.durationMs !== undefined && Number.isFinite(opts.durationMs) ? Math.max(0, opts.durationMs) : null;
      if (this.taps.size) {
        const red = redact(detail ?? {});
        const live: LiveEvent = { key, stage, scope: opts.scope ?? '', ts, status, duration_ms, detail: red && typeof red === 'object' && !Array.isArray(red) ? red as Record<string, unknown> : { value: red } };
        for (const fn of this.taps) { try { fn(live); } catch { /* 实时视图故障不影响业务 */ } }
      }
      if (!this.store) return;
      const event = this.store.append({ key, stage, scope: opts.scope ?? '', ts, status, duration_ms, detail });
      if (!event) { this.dropped++; return; }
      for (const fn of this.listeners) { try { fn(event); } catch { this.dropped++; } }
    } catch { this.dropped++; }
  }
  async span<T>(key: string, stage: string, fn: () => Promise<T>, detail: Record<string, unknown> = {}, summarize?: (value: T) => object): Promise<T> {
    const start = Date.now();
    this.event(key, stage, { status: 'started', detail });
    try {
      const value = await fn();
      this.event(key, stage, { durationMs: Date.now() - start, detail: { ...detail, ...summarize?.(value) } });
      return value;
    } catch (error) {
      this.event(key, stage, { status: 'failed', durationMs: Date.now() - start, detail: { ...detail, error } });
      throw error;
    }
  }
}
export const trace = new Trace();
