/**
 * 召回记录页面（设计 §1 /memory/recalls、§5.3 三级证据，分组 O5）。数据来自 /api/memory/recalls[/:id]
 * （契约见 docs/O5-recall-api.md），http.ts 在服务端内部调用同一路由；这里只做渲染，所有文本经 esc。
 * 三级证据的颜色与检索检查器一致：① 检索命中 lv-1、② 工具实际返回 lv-2、③ 进入模型请求 lv-3。
 * 第三级只证明该回合里出现了匹配的工具调用，页面任何位置都不把"工具返回"写成"模型采用"。
 */
import type { RecallEvent, RequestEvidence, ScopeSummary } from '../memory/types.js';
import { crumbs } from './agents-pages.js';
import { fmtInt } from './context-bar.js';
import { BACKENDS, empty, esc, fmtMs, fmtTime, json, kv, stamp, uri } from './html.js';
import { scopeLabel } from '../../context/access.js';
import { memoryScopeHref, summaryHref } from './memory-pages.js';

export const RECALL_PAGE = 50;
export const RECALL_TOOLS = ['qq_recent', 'qq_search', 'qq_message'] as const;
export const IN_REQUEST_CAVEAT = '③ 证明的是该回合里出现了匹配的工具调用，不等于模型采用了内容';

export interface RecallList { items: RecallEvent[]; page: number; has_more: boolean }
export type EvidenceHit = ({ kind: 'message'; id: string } | { kind: 'summary'; id: number }) & { ts?: number; preview?: string; deleted?: true };
export interface RecallDetail extends RecallEvent {
  evidence: { hits: EvidenceHit[]; tool_returned: { count: number; chars: number; dropped: number }; in_request: RequestEvidence };
}

/* ───────── 过滤 → 接口参数 ───────── */

export interface RecallFilters { backend: string; tool: string; scope: string; session: string; ticket: string; since: string; turn: string; page: number }
const FILTER_KEYS = ['backend', 'tool', 'scope', 'session', 'ticket', 'since', 'turn'] as const;

/** 页面查询 → 过滤条件：空值视为未筛选（接口把显式空字符串当 400）；非法后端 / 工具丢弃；turn 只在有 session 时生效。 */
export function recallFilters(q: URLSearchParams): RecallFilters {
  const g = (k: string) => (q.get(k) ?? '').trim();
  const f: RecallFilters = { backend: g('backend'), tool: g('tool'), scope: g('scope'), session: g('session'), ticket: g('ticket'), since: g('since'), turn: g('turn'),
    page: Math.max(0, Math.min(1_000_000, Math.floor(Number(q.get('page')) || 0))) };
  if (f.backend !== 'codex' && f.backend !== 'pi') f.backend = '';
  if (!(RECALL_TOOLS as readonly string[]).includes(f.tool)) f.tool = '';
  if (!f.session) f.turn = '';
  return f;
}
/** 过滤条件 → 查询串（接口与翻页链接共用同一组参数）；page=0 时省略。 */
export function recallQuery(f: RecallFilters, page = f.page): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]);
  if (page) p.set('page', String(page));
  return p;
}
export function recallsHref(q: Partial<RecallFilters>): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (q[k]) p.set(k, q[k]!);
  const s = p.toString();
  return `/memory/recalls${s ? '?' + esc(s) : ''}`;
}
export const recallHref = (id: number) => `/memory/recalls/${uri(String(id))}`;

/* ───────── 公共小件 ───────── */

const TURN_HREF = /^\/agents\/(codex|pi)\/sessions\/[^/?#]+\/turns\/[^/?#]+$/;
/** turn_href 来自接口（已 URL 编码）；只接受回合页路径形状，其它情况不出链接。 */
export const safeTurnHref = (h: string | null | undefined) => h && TURN_HREF.test(h) ? esc(h) : '';
export const compactArgs = (args: unknown, max = 160) => {
  let s: string;
  try { s = JSON.stringify(args) ?? ''; } catch { s = String(args); }
  return s.length > max ? s.slice(0, max) + '…' : s;
};
export const backendBadge = (b: string) => `<span class="pill rc-be rc-${b === 'pi' ? 'pi' : 'codex'}">${esc(BACKENDS[b] ?? b)}</span>`;
export const accessLabel = (e: Pick<RecallEvent, 'access' | 'scope_hint'>) => e.access === 'all' ? '全域' : scopeLabel(e.access);
function charsGauge(chars: number, max: number): string {
  const cap = Math.max(1, max);
  return `<span class="rc-gauge"><meter min="0" max="${cap}" value="${Math.min(Math.max(0, chars), cap)}" aria-label="工具返回字数"></meter><small>${fmtInt(chars)} / ${fmtInt(max)}</small></span>`;
}
const dropped = (n: number) => n > 0 ? stamp(`裁掉 ${fmtInt(n)}`, 'warn') : '<span class="faint">0</span>';
const errorFlag = (e: RecallEvent) => e.is_error ? stamp('出错', 'fail') : '';
/** 命中所属 scope：单域调用用 scope_hint；全域调用无法从事件反推，返回空。 */
const hitScope = (e: RecallEvent) => e.scope_hint ?? (e.access !== 'all' ? e.access : '');

/* ───────── /memory/recalls ───────── */

function filterForm(f: RecallFilters, scopes: ScopeSummary[]): string {
  const opt = (value: string, label: string, cur: string) => `<option value="${esc(value)}"${cur === value ? ' selected' : ''}>${esc(label)}</option>`;
  const scopeOpts = scopes.map(s => opt(s.scope, s.label, f.scope)).join('') + (f.scope && !scopes.some(s => s.scope === f.scope) ? opt(f.scope, f.scope, f.scope) : '');
  const since = /^\d{4}-\d{2}-\d{2}$/.test(f.since) ? f.since : '';
  return `<form class="bar rc-filter" method="get" action="/memory/recalls">
<label>后端<select name="backend">${opt('', '全部', f.backend)}${opt('codex', 'Codex', f.backend)}${opt('pi', 'Pi', f.backend)}</select></label>
<label>工具<select name="tool">${opt('', '全部', f.tool)}${RECALL_TOOLS.map(t => opt(t, t, f.tool)).join('')}</select></label>
<label>会话域<select name="scope">${opt('', '全部', f.scope)}${scopeOpts}</select></label>
<label>会话<input name="session" value="${esc(f.session)}" placeholder="线程 ID / Pi 会话号"></label>
<label>票据<input name="ticket" value="${esc(f.ticket)}" placeholder="完整票据"></label>
<label>此后<input type="date" name="since" value="${esc(since)}"></label>${f.turn ? `<input type="hidden" name="turn" value="${esc(f.turn)}">` : ''}
<button>筛选</button>${FILTER_KEYS.some(k => f[k]) ? '<a class="btn quiet" href="/memory/recalls">清除</a>' : ''}</form>${f.turn ? `<p class="hint">只看会话 <span class="mono">${esc(f.session)}</span> 的回合 <span class="mono">${esc(f.turn)}</span>（按回合时间窗关联）。<a href="${recallsHref({ ...f, turn: '' })}">看整个会话</a></p>` : ''}${f.since && !since ? `<p class="hint">起始时间按接口原样传递：<span class="mono">${esc(f.since)}</span></p>` : ''}`;
}

function recallRow(e: RecallEvent): string {
  const turn = safeTurnHref(e.turn_href);
  const links = [e.ticket ? `<a class="mono" href="/tickets/${uri(e.ticket)}" title="${esc(e.ticket)}">${esc(e.ticket.slice(0, 12))}</a>` : '',
    turn ? `<a href="${turn}">回合</a>` : ''].filter(Boolean).join('<br>');
  return `<tr${e.is_error ? ' class="rc-err"' : ''}><td><a href="${recallHref(e.id)}">${esc(fmtTime(e.ts))}</a></td><td>${backendBadge(e.backend)}</td><td class="mono">${esc(e.tool)}</td>
<td class="rc-args"><code>${esc(compactArgs(e.args))}</code></td><td class="hide-sm">${esc(accessLabel(e))}${e.scope_hint ? `<br><small class="mono">${esc(e.scope_hint)}</small>` : ''}</td>
<td class="num">${fmtInt(e.returned_count)}</td><td class="num">${dropped(e.dropped_count)}</td><td class="hide-sm">${charsGauge(e.chars, e.max_chars)}</td>
<td class="num hide-sm">${esc(fmtMs(e.duration_ms) || '0 毫秒')}</td><td>${errorFlag(e) || '<span class="faint">—</span>'}</td><td>${links || '<span class="faint">—</span>'}</td><td><a href="${recallHref(e.id)}">详情</a></td></tr>`;
}

export function recallsPageBody(f: RecallFilters, scopes: ScopeSummary[], list: RecallList | { error: string }): string {
  let out = crumbs([['记忆', '/memory'], ['召回记录']]) + filterForm(f, scopes);
  if ('error' in list) return out + `<div class="flash err" role="alert">读取召回记录失败：${esc(list.error)}</div>`;
  const filtered = FILTER_KEYS.some(k => f[k]);
  out += list.items.length ? `<div class="sheet"><div class="wrap"><table class="list recalls"><thead><tr><th>时间</th><th>后端</th><th>工具</th><th>参数</th><th class="hide-sm">权限 / 域</th><th class="num">返回</th><th class="num">裁掉</th><th class="hide-sm">字数</th><th class="num hide-sm">耗时</th><th>错误</th><th>票据 / 回合</th><th>证据</th></tr></thead><tbody>${list.items.map(recallRow).join('')}</tbody></table></div></div>
<p class="hint">返回 / 裁掉：工具实际交给模型的条数，与查询到但因字数上限被裁掉的条数（不含被 limit 或时间条件排除的记录）。点"详情"查看三级证据。</p>`
    : list.page ? empty('这一页没有更多召回记录了。')
      : empty(filtered ? '没有符合条件的召回记录。换个条件或<a href="/memory/recalls">清除筛选</a>。'
        : '还没有召回记录。模型调用 qq_recent / qq_search / qq_message 查询聊天记录时，每次调用会出现在这里（保留 90 天）。');
  const link = (page: number) => { const s = recallQuery(f, page).toString(); return `/memory/recalls${s ? '?' + esc(s) : ''}`; };
  if (list.page || list.has_more) out += `<p class="hint mt">${list.page ? `<a href="${link(list.page - 1)}">较新</a>　` : ''}第 ${list.page + 1} 页（每页 ${RECALL_PAGE} 条，最新在上）${list.has_more ? `　<a href="${link(list.page + 1)}">更早</a>` : ''}</p>`;
  return out;
}

/* ───────── /memory/recalls/:id ───────── */

const IN_STATUS: Record<RequestEvidence['status'], [string, 'ok' | 'warn' | 'idle']> = {
  confirmed: ['已在回合中找到调用', 'ok'], not_found: ['回合中未找到匹配调用', 'warn'], unavailable: ['无法核对', 'idle'],
};
const KIND: Record<string, string> = { message: '消息', summary: '摘要' };

function hitItem(e: RecallEvent, h: EvidenceHit): string {
  const scope = hitScope(e);
  const href = h.kind === 'summary' ? summaryHref(h.id)
    : scope && h.ts !== undefined ? memoryScopeHref(scope, { from: Math.max(0, h.ts - 3600_000), to: h.ts + 3600_000 }, '#messages') : '';
  const at = h.ts !== undefined ? esc(fmtTime(h.ts)) : '<span class="faint">时间未知</span>';
  return `<li class="hit sheet pad"><div class="hit-head"><span class="lv lv-1">${esc(KIND[h.kind] ?? h.kind)}</span>${href ? `<a href="${href}">${at}</a>` : at}${h.deleted ? stamp('已清理', 'idle') : ''}<span class="mono faint">#${esc(h.id)}</span></div>
${h.deleted ? '<div class="hint">当前聊天库已没有这条记录（按保留期清理或被周摘要折叠）；调用当时的返回数字不受影响。</div>' : h.preview ? `<div class="hit-text">${esc(h.preview)}</div>` : ''}</li>`;
}

export function inRequestPanel(r: RequestEvidence, e: Pick<RecallEvent, 'turn_href'>): string {
  const [label, tone] = IN_STATUS[r.status] ?? [r.status, 'idle' as const];
  const turn = safeTurnHref(e.turn_href);
  const rows: [string, string][] = [['状态', stamp(label, tone)]];
  if (r.status === 'confirmed') {
    if (r.turn !== undefined) rows.push(['回合', turn ? `<a href="${turn}">${esc(r.turn)}</a>` : `<span class="mono">${esc(r.turn)}</span>`]);
    if (r.call_id) rows.push(['调用 ID', `<span class="mono">${esc(r.call_id)}</span>`]);
  } else if (turn) rows.push(['关联回合', `<a href="${turn}">打开回合</a>`]);
  return `<div class="ev-panel ev-3 ev-${esc(r.status)} sheet pad">${kv(rows)}<p class="mt">${esc(r.note)}</p></div>`;
}

export function recallDetailBody(d: RecallDetail): string {
  const turn = safeTurnHref(d.turn_href), ev = d.evidence, tr = ev.tool_returned;
  let out = crumbs([['记忆', '/memory'], ['召回记录', '/memory/recalls'], [`#${d.id}`]]);
  out += `<div class="sheet pad rc-head"><div class="slip-top">${backendBadge(d.backend)}<b class="mono">${esc(d.tool)}</b>${errorFlag(d)}<span class="mono faint">#${esc(d.id)}</span></div><div class="mt">${kv([
    ['调用时间', esc(fmtTime(d.ts))], ['耗时', esc(fmtMs(d.duration_ms) || '0 毫秒')],
    ['权限', `${esc(accessLabel(d))}${d.access !== 'all' ? ` <small class="mono">${esc(d.access)}</small>` : ''}`],
    ['会话', d.session ? `<a class="mono" href="/agents/${uri(d.backend)}/sessions/${uri(d.session)}">${esc(d.session)}</a>` : '<span class="faint">未记录（新线程首轮）</span>'],
    ['票据', d.ticket ? `<a class="mono" href="/tickets/${uri(d.ticket)}">${esc(d.ticket)}</a>` : '<span class="faint">—</span>'],
    ['回合', turn ? `<a href="${turn}">打开回合</a>` : '<span class="faint">无法定位</span>'],
    ...(d.task_id ? [['任务', `<span class="mono">${esc(d.task_id)}</span>`] as [string, string]] : []),
  ], 'meta')}</div><details class="mt"><summary>调用参数</summary>${json(d.args)}</details>
<p class="mt"><a href="/memory/recalls">返回召回记录</a>${d.session ? `　<a href="${recallsHref({ backend: d.backend, session: d.session })}">同会话的其它调用</a>` : ''}${hitScope(d) ? `　<a href="${recallsHref({ scope: hitScope(d) })}">同会话域的其它调用</a>` : ''}</p></div>`;
  out += `<div class="flash warn rc-caveat" role="note"><b>${esc(IN_REQUEST_CAVEAT)}。</b>三级证据依次是：数据库命中了什么 → 工具实际交给模型什么 → 该回合里是否出现了这次调用。</div>`;
  const hits = ev.hits.length ? `<ol class="hits">${ev.hits.map(h => hitItem(d, h)).join('')}</ol>` : empty('这次调用没有返回任何条目。');
  const over = tr.chars > d.max_chars;
  out += `<div class="grid cols-3 ev-cols">
<section><h2><span class="lv lv-1">①</span> 检索命中 <small>${fmtInt(ev.hits.length)} 条</small></h2><div class="ev-panel ev-1">${hits}</div>
<p class="hint">按工具返回顺序展开，预览取自当前聊天库（最多 240 字、已脱敏），不是调用当时的快照；被裁掉的命中无法重建。</p></section>
<section><h2><span class="lv lv-2">②</span> 工具实际返回</h2><div class="ev-panel ev-2 sheet pad tool-panel"><div class="gauge"><meter min="0" max="${Math.max(1, d.max_chars)}" value="${Math.min(tr.chars, Math.max(1, d.max_chars))}" aria-label="工具返回字数"></meter><span>${fmtInt(tr.chars)} / ${fmtInt(d.max_chars)} 字${over ? '（超出上限）' : ''}</span></div>
${kv([['返回条数', esc(fmtInt(tr.count))], ['裁掉条数', dropped(tr.dropped)]])}
<p class="hint mt">数字来自调用当时的埋点，之后清理原文不会改变它们。裁掉条数不含被 limit 或时间条件排除的记录。</p></div></section>
<section><h2><span class="lv lv-3">③</span> 进入模型请求</h2>${inRequestPanel(ev.in_request, d)}</section></div>`;
  return out;
}

/* ───────── 回合页"记忆调用" ───────── */

/** 回合页内的记忆调用列表；list 为 null 表示接口出错（只给一行提示，不影响回合页）。 */
export function turnRecallSection(list: RecallList | { error: string }, q: { backend: string; session: string; turn: string }): string {
  const head = '<h2>记忆调用';
  if ('error' in list) return `<section class="turn-recalls">${head}</h2><p class="hint err">记忆调用暂不可用：${esc(list.error)}</p></section>`;
  if (!list.items.length) return `<section class="turn-recalls">${head}</h2><p class="faint">无记忆调用</p></section>`;
  const more = list.has_more ? `<p class="hint"><a href="${recallsHref(q)}">查看全部</a>（超过 ${RECALL_PAGE} 条）</p>` : '';
  return `<section class="turn-recalls">${head} <small>${fmtInt(list.items.length)} 次</small></h2><div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>工具</th><th>参数</th><th class="num">返回</th><th class="num">裁掉</th><th>证据</th></tr></thead><tbody>${list.items.map(e => `<tr${e.is_error ? ' class="rc-err"' : ''}><td>${esc(fmtTime(e.ts))}</td><td class="mono">${esc(e.tool)}${e.is_error ? ' ' + errorFlag(e) : ''}</td><td class="rc-args"><code>${esc(compactArgs(e.args))}</code></td><td class="num">${fmtInt(e.returned_count)}</td><td class="num">${dropped(e.dropped_count)}</td><td><a href="${recallHref(e.id)}">详情</a></td></tr>`).join('')}</tbody></table></div></div>
${more}<p class="hint">按回合时间窗关联的 qq_recent / qq_search / qq_message 调用；详情页的第三级证据核对回合内是否出现了这次调用，不代表模型采用了返回内容。</p></section>`;
}
