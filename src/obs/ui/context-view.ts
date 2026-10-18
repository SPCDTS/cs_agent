/**
 * 上下文结构分析页（设计 §4）的渲染。数据来自 GET /api/agents/:backend/sessions/:id/context（分组 O3 实现），
 * 这里按约定的 ContextAnalysis 结构渲染头部、构成表与逐消息表；实测与估算分开，来源用标签区分，
 * 没有来源的数字显示"—"而不是 0。分析接口缺席（404/501/503）时给出"分析引擎暂不可用"。
 */
import { fmtInt, fmtPct, ratio } from './context-bar.js';
import { empty, esc, fmtBytes, fmtTime, stamp, type Tone } from './html.js';
import { contextHref, turnHref, type SessionCtx } from './turn-view.js';

export type Provenance = 'recorded' | 'reconstructed' | 'estimated' | 'unavailable';
export type ContextAnalysis = {
  backend: 'codex' | 'pi'; session: string; at: { turn: string; phase: 'before' | 'after' }; generatedAt: number;
  window: { tokens: number; source: string };
  measured?: { input: number; cached?: number; at: number; stale: boolean; source: string };
  estimated: { total: number; tokenizer: string };
  unexplained?: number;
  categories: Array<{ key: 'instructions' | 'tools' | 'history' | 'tool_output' | 'compaction' | 'other'; label: string; items: number;
    tokens: { estimated?: number; measured?: number }; provenance: Provenance; note?: string }>;
  messages: Array<{ index: number; kind: string; category: string; provenance: string; tokens: { estimated?: number; measured?: number };
    preview: string; ref?: { session: string; offset: number; length: number; bytes: number }; ts?: number; callId?: string }>;
  notes: string[];
};

export const PROVENANCE: Record<string, [string, Tone]> = {
  recorded: ['已记录', 'ok'], reconstructed: ['重建', 'warn'], estimated: ['估算', 'queue'], unavailable: ['不可用', 'idle'],
};
export const provStamp = (p: string) => { const [l, t] = PROVENANCE[p] ?? [p || '未知', 'idle' as Tone]; return stamp(l, t); };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const tok = (v: unknown) => num(v) ? fmtInt(v) : '—';
const pctBar = (value: number | undefined, window: number) => {
  if (!num(value) || window <= 0) return '<span class="faint">—</span>';
  const p = ratio(value, window), w = Math.max(0, Math.min(100, Math.round(p)));
  return `<span class="pbar"><span class="ctx-track" role="img" aria-label="占窗口 ${esc(fmtPct(p))}"><i class="ctx-fill" data-w="${w}"></i></span><span class="pbar-n">${esc(fmtPct(p))}</span></span>`;
};

export const PHASE_LABEL = { before: '回合请求发出前', after: '回合结束后' } as const;

/** 可选的阶段切换与返回回合链接。 */
function phaseNav(ctx: SessionCtx, turn: string, phase: 'before' | 'after'): string {
  const link = (p: 'before' | 'after') => p === phase ? `<span class="pill on" aria-current="true">${PHASE_LABEL[p]}</span>` : `<a class="pill" href="${contextHref(ctx, turn, p)}">${PHASE_LABEL[p]}</a>`;
  return `<div class="phase-nav">${link('before')}${link('after')}<a href="${turnHref(ctx, turn)}">查看该回合</a></div>`;
}

export function contextUnavailable(ctx: SessionCtx, turn: string, phase: 'before' | 'after', status: number, message?: string): string {
  return `${phaseNav(ctx, turn, phase)}<section class="flush">${empty(`分析引擎暂不可用（HTTP ${status}）。${message ? esc(message) + '。' : ''}上下文结构分析由分组 O3 提供，部署后此页自动显示构成表与逐消息表。`)}</section>`;
}

export function contextError(ctx: SessionCtx, turn: string, phase: 'before' | 'after', status: number, message: string): string {
  return `${phaseNav(ctx, turn, phase)}<div class="flash err" role="alert">分析失败（HTTP ${status}）：${esc(message)}</div>`;
}

export function contextBody(ctx: SessionCtx, a: ContextAnalysis): string {
  const window = num(a.window?.tokens) ? a.window.tokens : 0;
  const m = a.measured;
  let out = phaseNav(ctx, a.at.turn, a.at.phase);
  out += `<div class="grid cols-3 ctx-figs">
<div class="sheet pad"><div class="muted">上下文窗口</div><div class="figure">${tok(window)}<small class="muted"> tokens</small></div><div class="faint">来源：${esc(a.window?.source ?? '—')}</div></div>
<div class="sheet pad"><div class="muted">实测输入${m?.stale ? ' ' + stamp('过期', 'warn') : ''}</div><div class="figure">${m ? tok(m.input) : '—'}${m ? `<small class="muted"> ${esc(fmtPct(ratio(m.input, window)))}</small>` : ''}</div><div class="faint">${m ? `${m.cached !== undefined ? `缓存 ${tok(m.cached)} · ` : ''}${esc(m.source)} · ${esc(fmtTime(m.at))}` : '没有可用的实测值'}</div></div>
<div class="sheet pad"><div class="muted">估算总计</div><div class="figure">${tok(a.estimated?.total)}<small class="muted"> ${esc(fmtPct(ratio(a.estimated?.total ?? 0, window)))}</small></div><div class="faint">分词器：${esc(a.estimated?.tokenizer ?? '—')}${num(a.unexplained) ? ` · 未解释差额 <b class="${a.unexplained < 0 ? 's-warn' : ''}">${a.unexplained > 0 ? '+' : ''}${esc(fmtInt(a.unexplained))}</b>` : ''}</div></div></div>`;
  const cats = a.categories ?? [];
  out += `<section><h2>构成 <small>百分比为占上下文窗口的比例；差额单独列出，不摊到任何类别</small></h2>${cats.length ? `<div class="sheet"><div class="wrap"><table class="list ctx-cats"><thead><tr><th>类别</th><th class="num">条目</th><th class="num">估算</th><th class="num">实测</th><th>来源</th><th>占比</th></tr></thead><tbody>${cats.map(c => `<tr data-cat="${esc(c.key)}"><td>${esc(c.label)}${c.note ? `<br><small>${esc(c.note)}</small>` : ''}</td><td class="num">${tok(c.items)}</td><td class="num">${c.provenance === 'unavailable' && !num(c.tokens?.estimated) ? '—' : tok(c.tokens?.estimated)}</td><td class="num">${tok(c.tokens?.measured)}</td><td>${provStamp(c.provenance)}</td><td>${pctBar(c.tokens?.measured ?? c.tokens?.estimated, window)}</td></tr>`).join('')}${num(a.unexplained) ? `<tr class="unexplained"><td>未解释差额<br><small>实测输入 − 估算总计</small></td><td class="num">—</td><td class="num">—</td><td class="num">${a.unexplained > 0 ? '+' : ''}${esc(fmtInt(a.unexplained))}</td><td>${provStamp('unavailable')}</td><td>${pctBar(Math.abs(a.unexplained), window)}</td></tr>` : ''}</tbody></table></div></div>` : empty('没有类别数据。')}</section>`;
  const msgs = a.messages ?? [];
  const catLabel = new Map(cats.map(c => [c.key as string, c.label]));
  out += `<section><h2>逐消息 <small>${msgs.length} 条</small></h2>${msgs.length ? `<div class="sheet"><div class="wrap"><table class="list ctx-msgs"><thead><tr><th class="num">#</th><th>类型</th><th class="hide-sm">类别</th><th>来源</th><th class="num">估算</th><th>内容</th></tr></thead><tbody>${msgs.map(x => `<tr><td class="num">${esc(x.index)}</td><td>${esc(x.kind)}${x.callId ? `<br><small class="mono">${esc(x.callId)}</small>` : ''}</td><td class="hide-sm">${esc(catLabel.get(x.category) ?? x.category)}</td><td>${provStamp(x.provenance)}</td><td class="num">${tok(x.tokens?.estimated)}${num(x.tokens?.measured) ? `<br><small>实测 ${tok(x.tokens.measured)}</small>` : ''}</td><td class="msg-cell"><div class="bt prose${x.ref ? ' partial' : ''}">${esc(x.preview)}</div>${x.ref ? `<div class="load-row"><button type="button" class="quiet load-full" data-session="${esc(x.ref.session)}" data-offset="${Number(x.ref.offset)}" data-length="${Number(x.ref.length)}">展开全文（${esc(fmtBytes(x.ref.bytes ?? x.ref.length))}）</button><span class="load-note" role="status"></span></div>` : ''}</td></tr>`).join('')}</tbody></table></div></div>` : empty('没有逐消息数据。')}</section>`;
  if (a.notes?.length) out += `<section><h2>说明</h2><ul class="notes">${a.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></section>`;
  out += `<p class="hint">生成于 ${esc(fmtTime(a.generatedAt))}。"重建"表示按当前文件推断、可能与当时不同；"不可用"的内容不计为 0。</p>`;
  return out;
}
