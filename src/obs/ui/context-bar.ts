/**
 * 上下文占用进度条（设计 §8.5）。服务端渲染与 client.ts 的 CTX_JS 产生同一结构：
 * 宽度与阈值位置用 data-w / data-at（整数百分比）+ theme.ts 中生成的属性选择器表达，
 * 不写内联 style（CSP 禁止），无脚本时首屏也正确。
 */
import { BACKENDS, esc, scopeLabel } from './html.js';

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
  source: 'turn' | 'estimate';
}
export interface ContextUsageView {
  all(): ContextUsage[];
  get(backend: ContextUsage['backend'], key: string): ContextUsage | undefined | null;
}

export const STALE_MS = 24 * 3600_000;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
    source: d.source === 'estimate' ? 'estimate' : 'turn',
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
const clampPct = (p: number) => Math.max(0, Math.min(100, Math.round(p)));
export const fmtPct = (p: number) => (p > 0 && p < 1 ? '<1' : String(Math.round(p))) + '%';
const tier = (p: number) => p > 85 ? 'hot' : p >= 60 ? 'warn' : 'ok';

function ctxLabel(backend: string, key: string): string {
  const b = BACKENDS[backend] ?? backend;
  if (backend === 'codex') return `${b} · ${key === 'owner' ? 'owner 线程' : scopeLabel(key)}`;
  return `${b} · ${scopeLabel(key)}`;
}

/** codex 在前、pi 在后，同一后端内按占比降序。 */
export function sortUsage(list: ContextUsage[]): ContextUsage[] {
  const order = (u: ContextUsage) => u.backend === 'codex' ? 0 : 1;
  return [...list].sort((a, b) => order(a) - order(b) || ratio(b.usedTokens, usageWindow(b)) - ratio(a.usedTokens, usageWindow(a)) || a.key.localeCompare(b.key));
}

const tickTitle = (kind: 'bg' | 'rs', at: number, window: number) =>
  `${kind === 'bg' ? '后台压缩阈值' : '阻塞压缩阈值'}：${fmtInt(at)} tokens（${fmtPct(ratio(at, window))}）。` +
  (kind === 'bg' ? '越过后在回合结束时于后台压缩上下文，不阻塞回复。' : '越过后下一回合开始前必须先压缩，回复会等待压缩完成。');

const hoursAgo = (ts: number, now: number) => Math.max(0, Math.floor((now - ts) / 3600_000));

export interface BarOptions { mini?: boolean; label?: string; now?: number }

/** 一条进度条；u 缺省时渲染"暂无数据"占位（保留 data-ctx，便于 SSE 到达后原地填充）。 */
export function contextBar(backend: string, key: string, u: ContextUsage | null | undefined, o: BarOptions = {}): string {
  const now = o.now ?? Date.now();
  const label = o.label ?? ctxLabel(backend, key);
  const attrs = `data-ctx="${esc(backend + '|' + key)}"`;
  if (!u) {
    return o.mini
      ? `<div class="ctx ctx-mini ctx-none" ${attrs}><span class="ctx-track" role="progressbar" aria-label="${esc(label)} 上下文占用" aria-valuemin="0" aria-valuemax="100"><i class="ctx-fill" data-w="0"></i></span><span class="ctx-pct">—</span><span class="ctx-short">暂无占用数据</span></div>`
      : `<div class="ctx ctx-none" ${attrs}><div class="ctx-head"><span class="ctx-label">${esc(label)}</span><span class="ctx-pct">—</span></div><div class="ctx-track" role="progressbar" aria-label="${esc(label)} 上下文占用" aria-valuemin="0" aria-valuemax="100"><i class="ctx-fill" data-w="0"></i></div><div class="ctx-meta">暂无占用数据，下一回合结束后出现。</div></div>`;
  }
  const window = usageWindow(u), p = ratio(u.usedTokens, window), w = clampPct(p);
  const capacityTitle = u.backend === 'codex' && num(u.effectiveWindowTokens) && u.effectiveWindowTokens > 0
    ? `名义 ${fmtInt(u.windowTokens)} / 有效 ${fmtInt(window)}` : '';
  const stale = now - u.updatedAt > STALE_MS;
  const cls = `ctx ctx-t-${tier(p)}${u.source === 'estimate' ? ' ctx-est' : ''}${stale ? ' ctx-stale' : ''}${o.mini ? ' ctx-mini' : ''}`;
  const ticks = u.compaction && window > 0
    ? (['bg', 'rs'] as const).map(k => { const at = k === 'bg' ? u.compaction!.background : u.compaction!.reserve;
      return `<i class="ctx-tick ctx-${k}" data-at="${clampPct(ratio(at, window))}" title="${esc(tickTitle(k, at, window))}"></i>`; }).join('') : '';
  const aria = `role="progressbar" aria-label="${esc(label)} 上下文占用" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w}" aria-valuetext="${esc(`${fmtInt(u.usedTokens)} / ${fmtInt(window)} tokens，${fmtPct(p)}`)}"`;
  const track = (tag: string) => `<${tag} class="ctx-track" ${aria}><i class="ctx-fill" data-w="${w}"></i>${ticks}</${tag}>`;
  const short = `${fmtShort(u.usedTokens)} / ${fmtShort(window)}`;
  if (o.mini) {
    return `<div class="${cls}" ${attrs} title="${esc(`${label}：${fmtInt(u.usedTokens)} / ${fmtInt(window)} tokens${capacityTitle ? `；${capacityTitle}` : ''}`)}">${track('span')}<span class="ctx-pct">${fmtPct(p)}</span><span class="ctx-short">${esc(short)}</span></div>`;
  }
  const meta: string[] = [`第 ${fmtInt(u.turns)} 回合`];
  if (u.cachedTokens) meta.push(`缓存命中 ${fmtInt(u.cachedTokens)}`);
  if (u.compaction) meta.push(`压缩阈值 ${fmtPct(ratio(u.compaction.background, window))} / ${fmtPct(ratio(u.compaction.reserve, window))}`);
  if (u.source === 'estimate') meta.push('估算值（尚无真实回合用量）');
  meta.push(stale ? `上次更新 ${hoursAgo(u.updatedAt, now)} 小时前` : `更新于 ${new Date(u.updatedAt).toLocaleTimeString('zh-CN', { hour12: false, timeZone: process.env.TZ || undefined })}`);
  return `<div class="${cls}" ${attrs}${capacityTitle ? ` title="${esc(capacityTitle)}"` : ''}><div class="ctx-head"><span class="ctx-label">${esc(label)}</span><span class="ctx-num"><b class="ctx-used">${fmtInt(u.usedTokens)}</b> / <span class="ctx-win">${fmtInt(window)}</span> tokens</span><span class="ctx-short">${esc(short)}</span><span class="ctx-pct">${fmtPct(p)}</span></div>${track('div')}<div class="ctx-meta">${esc(meta.join('，'))}</div></div>`;
}
