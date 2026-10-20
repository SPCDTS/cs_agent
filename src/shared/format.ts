/**
 * 与 src/agent/context-usage.ts 的 ContextUsage 结构一致（数据侧由该模块维护）。
 * 这里保留结构类型，面板只依赖 all()/get() 两个读方法。
 */
export interface ContextUsage {
  backend: 'codex' | 'pi';
  key: string;
  usedTokens: number;
  cachedTokens?: number;
  windowTokens: number;
  effectiveWindowTokens?: number;
  compaction?: { background: number; reserve: number };
  turns: number;
  lastCompactionAt?: number;
  updatedAt: number;
  source: 'turn' | 'estimate' | 'compact';
}
export interface ContextUsageView {
  all(): ContextUsage[];
  get(backend: ContextUsage['backend'], key: string): ContextUsage | undefined | null;
}

export const STALE_MS = 24 * 3600_000;
export const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 从（已脱敏的）事件 detail 中取出白名单字段；不合法返回 null。 */
export function toContextUsage(d: Record<string, unknown>): ContextUsage | null {
  if ((d.backend !== 'codex' && d.backend !== 'pi') || typeof d.key !== 'string' || !d.key || d.key.length > 64) return null;
  if (!num(d.usedTokens) || !num(d.windowTokens)) return null;
  const c = d.compaction && typeof d.compaction === 'object' ? d.compaction as Record<string, unknown> : null;
  return {
    backend: d.backend, key: d.key, usedTokens: Math.max(0, d.usedTokens), windowTokens: Math.max(0, d.windowTokens),
    ...(num(d.cachedTokens) ? { cachedTokens: d.cachedTokens } : {}),
    ...(num(d.effectiveWindowTokens) && d.effectiveWindowTokens > 0 ? { effectiveWindowTokens: d.effectiveWindowTokens } : {}),
    ...(c && num(c.background) && num(c.reserve) ? { compaction: { background: c.background, reserve: c.reserve } } : {}),
    turns: num(d.turns) ? d.turns : 0,
    ...(num(d.lastCompactionAt) ? { lastCompactionAt: d.lastCompactionAt } : {}),
    updatedAt: num(d.updatedAt) ? d.updatedAt : Date.now(),
    source: d.source === 'compact' ? 'compact' : d.source === 'estimate' ? 'estimate' : 'turn',
  };
}

export const fmtInt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** 12,345 → 12.3k；400,000 → 400k；1,050,000 → 1.05M */
export function fmtShort(n: number): string {
  const trim = (s: string) => s.replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return trim((n / 1000).toFixed(n < 10_000 ? 1 : 0)) + 'k';
  return trim((n / 1_000_000).toFixed(2)) + 'M';
}
export const ratio = (used: number, window: number) => window > 0 ? used / window * 100 : 0;
export const usageWindow = (u: ContextUsage) => u.backend === 'codex' && num(u.effectiveWindowTokens) && u.effectiveWindowTokens > 0 ? u.effectiveWindowTokens : u.windowTokens;
/** 进度条宽度/位置用的整数百分比（0–100）。 */
export const clampPct = (p: number) => Math.max(0, Math.min(100, Math.round(p)));
export const fmtPct = (p: number) => (p > 0 && p < 1 ? '<1' : String(Math.round(p))) + '%';
export const tier = (p: number) => p > 85 ? 'hot' : p >= 60 ? 'warn' : 'ok';

/** codex 在前、pi 在后，同一后端内按占比降序。 */
export function sortUsage(list: ContextUsage[]): ContextUsage[] {
  const order = (u: ContextUsage) => u.backend === 'codex' ? 0 : 1;
  return [...list].sort((a, b) => order(a) - order(b) || ratio(b.usedTokens, usageWindow(b)) - ratio(a.usedTokens, usageWindow(a)) || a.key.localeCompare(b.key));
}

export const hoursAgo = (ts: number, now: number) => Math.max(0, Math.floor((now - ts) / 3600_000));
