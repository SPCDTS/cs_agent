/**
 * 观测 v2 的 Agent → 会话 → 回合页面（设计 §1、§3）。数据来自 /api/agents/* 的同一份 JSON
 * （http.ts 在服务端内部调用会话路由取得，已按会话脱敏规则处理）；这里只做渲染，所有文本经 esc。
 */
import type { Block, ObservedTurn, SessionRef } from '../sessions/types.js';
import { contextBar, fmtInt, type ContextUsage } from './context-bar.js';
import { BACKENDS, csrfField, empty, esc, fmtTime, kv, scopeLabel, stamp, statusStamp, time, uri } from './html.js';
import { blocksHtml, contextHref, contextLinks, qqLine, turnFacts, turnHref, turnMeta, turnStamp, type SessionCtx } from './turn-view.js';

export const PAGE_SIZE = 50;
export const PRELOAD_TURNS = 3;
export type Backend = 'codex' | 'pi';
export const isBackend = (v: string): v is Backend => v === 'codex' || v === 'pi';

export interface AgentSummary { backend: Backend; sessions_active: number; sessions_archived: number; last_turn_at: number | null; indexing: { indexing: boolean; files: number; done: number } }

/** 放进 <script type="application/json">：转义 < > & 与行分隔符，避免提前闭合标签。 */
export const scriptJson = (v: unknown) => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export const dataScript = (id: string, nonce: string, v: unknown) => `<script type="application/json" id="${id}" nonce="${nonce}">${scriptJson(v)}</script>`;

export const sessionsHref = (backend: string) => `/agents/${uri(backend)}/sessions`;
export const sessionHref = (backend: string, id: string) => `${sessionsHref(backend)}/${uri(id)}`;

export function crumbs(items: [string, string?][]): string {
  return `<nav class="crumbs" aria-label="位置">${items.map(([label, href]) => href ? `<a href="${href}">${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`).join('<span class="sep" aria-hidden="true">›</span>')}</nav>`;
}

const SESSION_STATUS: Record<string, [string, 'ok' | 'idle']> = { active: ['活动', 'ok'], archived: ['归档', 'idle'] };
export const sessionStamp = (s: string) => { const [l, t] = SESSION_STATUS[s] ?? [s, 'idle' as const]; return stamp(l, t); };
export const copyId = (id: string) => `<span class="idbox"><code class="mono sel">${esc(id)}</code><button type="button" class="quiet copy" data-copy="${esc(id)}" aria-label="复制 ID">复制</button></span>`;
/** codex 的 scope 是线程键（owner / shared），pi 是会话域。 */
export const sessionScope = (backend: string, scope?: string) => !scope ? '—' : backend === 'codex' ? (scope === 'owner' ? 'owner 线程' : scope === 'shared' ? '共享线程' : scope) : scopeLabel(scope);

/* ───────── /agents ───────── */

export interface ResetTarget { key: string; label: string; enabled: boolean }
export interface AgentCardInput {
  summary?: AgentSummary; error?: string;
  threads: ResetTarget[];
  usage: (key: string) => ContextUsage | null;
  extraUsageKeys?: string[];
}
const resetForm = (backend: Backend, csrf: string, t: ResetTarget) => t.enabled
  ? `<form method="post" action="/${backend}/reset" data-confirm="重置${esc(t.label)}？当前会话会归档，下一条消息从空白上下文开始。进行中的回合会先跑完。">${csrfField(csrf)}<input type="hidden" name="key" value="${esc(t.key)}"><button class="danger">重置</button></form>` : '';

function agentCard(backend: Backend, c: AgentCardInput, csrf: string): string {
  const s = c.summary, name = BACKENDS[backend] ?? backend;
  const idx = s?.indexing;
  const progress = !idx ? '—' : idx.indexing ? `索引中 ${fmtInt(idx.done)} / ${fmtInt(idx.files)}` : idx.files ? `已完成（${fmtInt(idx.files)} 个文件）` : '空闲';
  const keys = [...new Set([...c.threads.map(t => t.key), ...(c.extraUsageKeys ?? [])])];
  const rows = keys.map(k => {
    const t = c.threads.find(x => x.key === k);
    return `<div class="thread-row">${contextBar(backend, k, c.usage(k))}${t ? resetForm(backend, csrf, t) : ''}</div>`;
  }).join('');
  return `<section class="sheet pad flush agent-card" data-backend="${backend}"><h2><a href="${sessionsHref(backend)}">${esc(name)}</a> <small>${backend === 'codex' ? 'owner 与共享两条长期线程' : '每个会话域一个长期会话'}</small></h2>
${c.error ? `<div class="flash err">${esc(c.error)}</div>` : ''}<div class="agent-figs"><div><div class="figure">${s ? fmtInt(s.sessions_active) : '—'}</div><div class="muted">活动会话</div></div><div><div class="figure">${s ? fmtInt(s.sessions_archived) : '—'}</div><div class="muted">归档会话</div></div></div>
${kv([['最近回合', s?.last_turn_at ? time(s.last_turn_at) : '—'], ['索引进度', `<span class="${idx?.indexing ? 's-run' : ''}">${esc(progress)}</span>`]])}
<div class="thread-list mt">${rows || empty('还没有线程的占用记录。')}</div>
<p class="mt"><a class="btn" href="${sessionsHref(backend)}">查看会话列表</a>${backend === 'codex' ? ' <a class="btn quiet" href="/codex/agents-md">全局 AGENTS.md</a>' : ''}</p></section>`;
}

export function agentsBody(cards: Record<Backend, AgentCardInput>, csrf: string): string {
  return `<div class="grid cols-2">${agentCard('codex', cards.codex, csrf)}${agentCard('pi', cards.pi, csrf)}</div>
<p class="hint mt">占用条显示每条线程当前离上下文窗口还有多远；会话与回合正文来自 rollout / pi 公开接口的索引，只读。</p>`;
}

/* ───────── /agents/:backend/sessions ───────── */

export interface ListFilters { status: string; scope: string; since: string; page: number }
export function listQuery(f: ListFilters, page = f.page): string {
  const q = new URLSearchParams();
  if (f.status) q.set('status', f.status); if (f.scope) q.set('scope', f.scope); if (f.since) q.set('since', f.since);
  if (page) q.set('page', String(page));
  return q.toString();
}

export function sessionListBody(backend: Backend, rows: SessionRef[] | null, f: ListFilters, error?: string): string {
  const opt = (v: string, l: string) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${l}</option>`;
  let out = crumbs([['Agent', '/agents'], [BACKENDS[backend] ?? backend]]);
  out += `<form class="bar"><label>状态<select name="status">${opt('', '全部')}${opt('active', '活动')}${opt('archived', '归档')}</select></label>
<label>scope<input name="scope" placeholder="${backend === 'codex' ? 'owner 或 shared' : 'owner / group:123'}" value="${esc(f.scope)}"></label><label>更新于此后<input name="since" type="date" value="${esc(f.since)}"></label><button>筛选</button>${f.status || f.scope || f.since ? `<a class="btn quiet" href="${sessionsHref(backend)}">清除</a>` : ''}</form>`;
  if (error) out += `<div class="flash err" role="alert">${esc(error)}</div>`;
  if (!rows) return out;
  out += rows.length ? `<div class="sheet"><div class="wrap"><table class="list sessions"><thead><tr><th>会话</th><th>真实 ID</th><th>状态</th><th class="num">回合</th><th class="hide-sm">开始</th><th>更新</th></tr></thead><tbody>${rows.map(s => `<tr><td><a href="${sessionHref(backend, s.id)}">${esc(s.label && s.label !== s.id && s.label !== s.scope ? s.label : sessionScope(backend, s.scope))}</a>${s.label && s.label !== s.id && s.label !== s.scope ? `<br><small>${esc(sessionScope(backend, s.scope))}</small>` : ''}</td><td>${copyId(s.id)}</td><td>${sessionStamp(s.status)}</td><td class="num">${fmtInt(s.turns)}</td><td class="hide-sm">${esc(fmtTime(s.started))}</td><td>${time(s.updated)}</td></tr>`).join('')}</tbody></table></div></div>`
    : empty(f.page ? '这一页没有更多会话了。' : '没有符合条件的会话。索引可能仍在进行，稍后刷新；或清除筛选。');
  const link = (p: number) => { const q = listQuery(f, p); return `${sessionsHref(backend)}${q ? '?' + esc(q) : ''}`; };
  out += `<p class="hint mt">${f.page ? `<a href="${link(f.page - 1)}">上一页</a>　` : ''}第 ${f.page + 1} 页${rows.length === PAGE_SIZE ? `　<a href="${link(f.page + 1)}">下一页</a>` : ''}</p>`;
  return out;
}

/* ───────── /agents/:backend/sessions/:id ───────── */

export const byNewest = (turns: ObservedTurn[]) => [...turns].sort((a, b) => b.started - a.started);

function dirItem(c: SessionCtx, t: ObservedTurn, n: number): string {
  return `<li data-turn="${esc(t.turn)}"><a href="#t-${n}" data-open="t-${n}"><span class="excerpt">${esc(t.preview || '（无预览）')}</span></a><div class="dir-meta"><span class="th-status">${turnStamp(t.status)}</span>${t.delivery ? statusStamp(t.delivery.status) : ''}<span class="faint">${esc(fmtTime(t.started))}</span><span class="faint">工具 ${t.tools} · 请求 ${t.requests}</span></div></li>`;
}

export function turnSection(c: SessionCtx, t: ObservedTurn, n: number, blocks: Block[] | undefined, open: boolean): string {
  const facts = blocks ? turnFacts(blocks) : undefined;
  return `<details class="turn sheet" id="t-${n}" data-turn="${esc(t.turn)}"${open ? ' open' : ''}><summary class="turn-head"><span class="th-status">${turnStamp(t.status)}</span><span class="th-preview">${esc(t.preview || '（无预览）')}</span><span class="tm">${turnMeta(c, t, facts)}${qqLine(t)}</span></summary>
<div class="turn-bar"><a href="${turnHref(c, t.turn)}">回合详情</a>${contextLinks(c, t.turn)}</div><div class="turn-body"${blocks ? '' : ' data-lazy="1"'}>${blocks ? blocksHtml(blocks) || '<p class="faint placeholder">这个回合还没有正文块。</p>' : '<p class="faint placeholder">展开后读取正文…</p>'}</div></details>`;
}

export interface SessionPageInput {
  ctx: SessionCtx; session: SessionRef; turns: ObservedTurn[]; page: number;
  preload: Map<string, Block[]>; usage: ContextUsage | null; nonce: string;
}

export function sessionPageBody(i: SessionPageInput): string {
  const { ctx, session: s } = i;
  const all = byNewest(i.turns), total = all.length;
  const slice = all.slice(i.page * PAGE_SIZE, (i.page + 1) * PAGE_SIZE);
  const latest = all[0];
  let out = crumbs([['Agent', '/agents'], [BACKENDS[ctx.backend] ?? ctx.backend, sessionsHref(ctx.backend)], [s.label && s.label !== s.id ? s.label : sessionScope(ctx.backend, s.scope)]]);
  out += `<div class="sheet pad sess-head">${kv([['真实 ID', copyId(s.id)], ['状态', sessionStamp(s.status)], ['scope', esc(sessionScope(ctx.backend, s.scope))], ['回合', esc(fmtInt(s.turns))], ['开始', esc(fmtTime(s.started))], ['更新', time(s.updated)]], 'meta')}
${s.scope ? `<div class="mt">${contextBar(ctx.backend, s.scope, i.usage, { label: s.status === 'active' ? '当前上下文占用' : '该线程键当前的上下文占用（已归档会话之后的新会话）' })}</div>` : ''}
<p class="mt">${latest ? `<a class="btn" href="${contextHref(ctx, latest.turn, 'after')}">分析当前上下文</a>` : ''}${s.status === 'active' ? ' <span id="conn" class="conn">正在连接实时更新…</span>' : ' <span class="faint">归档会话，不再更新</span>'}</p></div>`;
  const index = new Map(all.map((t, k) => [t.turn, total - k]));
  out += `<div class="turns-layout"><nav class="tdir sheet" aria-label="回合目录"><h2>回合目录 <small>${total} 个</small></h2><ol id="tdir">${slice.map(t => dirItem(ctx, t, index.get(t.turn)!)).join('')}</ol></nav>
<div id="tstream" class="tstream">${total ? '' : `<div id="no-turns">${empty('这个会话还没有已索引的回合。索引在后台进行，稍后刷新。')}</div>`}${slice.map((t, k) => turnSection(ctx, t, index.get(t.turn)!, i.preload.get(t.turn), i.page === 0 && k === 0)).join('')}</div></div>`;
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages > 1) out += `<p class="hint mt">${i.page ? `<a href="?page=${i.page - 1}">较新的回合</a>　` : ''}第 ${i.page + 1} / ${pages} 页${i.page + 1 < pages ? `　<a href="?page=${i.page + 1}">更早的回合</a>` : ''}</p>`;
  return out + dataScript('agents-data', i.nonce, { backend: ctx.backend, session: s.id, active: s.status === 'active' && i.page === 0, window: ctx.window ?? null, base: total });
}

/* ───────── /agents/:backend/sessions/:id/turns/:turn ───────── */

export function turnPageBody(ctx: SessionCtx, s: SessionRef, t: ObservedTurn, blocks: Block[], neighbors: { newer?: string; older?: string }): string {
  const facts = turnFacts(blocks);
  let out = crumbs([['Agent', '/agents'], [BACKENDS[ctx.backend] ?? ctx.backend, sessionsHref(ctx.backend)], [s.label && s.label !== s.id ? s.label : sessionScope(ctx.backend, s.scope), sessionHref(ctx.backend, s.id)], ['回合']]);
  out += `<div class="sheet pad turn-detail-head"><div class="slip-top">${turnStamp(t.status)}<span class="mono faint">${esc(t.turn)}</span></div><div class="tm mt">${turnMeta(ctx, t, facts)}${qqLine(t)}</div>
<p class="mt">${contextLinks(ctx, t.turn)}</p><p class="hint">${facts.requests} 次模型请求，${t.tools} 次工具调用。上下文占用取最后一次请求的实测输入；"回合累计"是本回合全部请求之和。</p></div>`;
  out += `<section><h2>正文 <small>${blocks.length} 个块</small></h2><div class="turn-body full">${blocksHtml(blocks) || empty('这个回合还没有正文块。')}</div></section>`;
  out += `<p class="hint mt">${neighbors.newer ? `<a href="${turnHref(ctx, neighbors.newer)}">较新的回合</a>　` : ''}<a href="${sessionHref(ctx.backend, s.id)}">返回会话</a>${neighbors.older ? `　<a href="${turnHref(ctx, neighbors.older)}">较早的回合</a>` : ''}</p>`;
  return out;
}
