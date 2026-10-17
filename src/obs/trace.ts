import type { ObsEvent, ObsStore } from './store.js';
export interface EventOptions { status?: string; durationMs?: number; detail?: unknown; scope?: string }
type Listener = (e: ObsEvent) => void;
export function errorCategory(error: unknown): string {
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
  dropped = 0;
  constructor(private store?: ObsStore) {}
  attach(store?: ObsStore): void { this.store = store; }
  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  event(ticket: string, stage: string, opts: EventOptions = {}): void {
    if (!this.store) return;
    try {
      const detail = opts.status === 'failed' && opts.detail && typeof opts.detail === 'object'
        ? { ...opts.detail, error_category: errorCategory((opts.detail as Record<string, unknown>).error) } : opts.detail;
      const event = this.store.append({ ticket, stage, scope: opts.scope ?? '', ts: Date.now(), status: opts.status ?? 'ok',
        duration_ms: opts.durationMs !== undefined && Number.isFinite(opts.durationMs) ? Math.max(0, opts.durationMs) : null, detail });
      for (const fn of this.listeners) { try { fn(event); } catch { this.dropped++; } }
    } catch { this.dropped++; }
  }
  async span<T>(ticket: string, stage: string, fn: () => Promise<T>, detail: Record<string, unknown> = {}, summarize?: (value: T) => object): Promise<T> {
    const start = Date.now();
    this.event(ticket, stage, { status: 'started', detail });
    try {
      const value = await fn();
      this.event(ticket, stage, { durationMs: Date.now() - start, detail: { ...detail, ...summarize?.(value) } });
      return value;
    } catch (error) {
      this.event(ticket, stage, { status: 'failed', durationMs: Date.now() - start, detail: { ...detail, error } });
      throw error;
    }
  }
}
export const trace = new Trace();
