/**
 * 记忆条目页（docs/DASHBOARD.md §8.4）：/memory/entries 列表与 /memory/entries/<id> 详情。
 * 数据来自 /api/memory/entries* 的同一份已脱敏 JSON；遗忘 / 恢复是表单 POST（同源 + CSRF），成功 303 回详情页。
 */
import type { MemoryEntry, MemoryEntryDetail, MemoryEntryPage } from '../memory/types.js';
import { crumbs } from './agents-pages.js';
import { fmtInt } from '../../shared/format.js';
import { csrfField, empty, esc, fmtTime, kv, stamp, uri } from './html.js';

export const ENTRY_KINDS: Record<string, string> = { fact: '事实', preference: '偏好', rule: '要求', commitment: '承诺', episode: '经历' };
export const ENTRY_STATUSES: Record<string, [string, 'ok' | 'idle' | 'warn' | 'fail']> = {
  active: ['有效', 'ok'], superseded: ['已取代', 'idle'], retired: ['已降级', 'idle'], orphaned: ['来源已撤回', 'warn'], forgotten: ['已遗忘', 'fail'],
};
export const entryHref = (id: number) => `/memory/entries/${id}`;
const statusStamp = (s: string) => { const [label, tone] = ENTRY_STATUSES[s] ?? [s, 'idle' as const]; return stamp(label, tone); };
const day = (ms: number | null) => ms === null ? '' : fmtTime(ms).slice(0, 10);

function timing(e: MemoryEntry): string {
  if (e.kind === 'commitment' && e.done_at !== null) return `已完成 ${day(e.done_at)}`;
  if (e.kind === 'commitment' && e.due_at !== null) return `截止 ${day(e.due_at)}`;
  if (e.since !== null && e.until !== null) return `${day(e.since)} 至 ${day(e.until)}`;
  if (e.since !== null) return `${day(e.since)} 起`;
  return e.until !== null ? `至 ${day(e.until)}` : '';
}

export interface EntryFilters { ns: string; kind: string; status: string; q: string; page: number }
export function entryFilters(q: URLSearchParams): EntryFilters {
  const page = Number(q.get('page') ?? '0');
  return { ns: q.get('ns') ?? '', kind: q.get('kind') ?? '', status: q.get('status') ?? '', q: (q.get('q') ?? '').trim(),
    page: Number.isSafeInteger(page) && page >= 0 ? page : 0 };
}
export function entryQuery(f: EntryFilters): string {
  const p = new URLSearchParams();
  for (const k of ['ns', 'kind', 'status', 'q'] as const) if (f[k]) p.set(k, f[k]);
  if (f.page) p.set('page', String(f.page));
  return p.toString();
}

function filterForm(f: EntryFilters, namespaces: MemoryEntryPage['namespaces']): string {
  const opt = (value: string, label: string, cur: string) => `<option value="${esc(value)}"${cur === value ? ' selected' : ''}>${esc(label)}</option>`;
  return `<form class="bar" method="get" action="/memory/entries">
<label>命名空间<select name="ns">${opt('', '全部', f.ns)}${namespaces.map(n => opt(n.ns, n.label, f.ns)).join('')}</select></label>
<label>种类<select name="kind">${opt('', '全部', f.kind)}${Object.entries(ENTRY_KINDS).map(([k, l]) => opt(k, `${l}（${k}）`, f.kind)).join('')}</select></label>
<label>状态<select name="status">${opt('', '全部', f.status)}${Object.entries(ENTRY_STATUSES).map(([k, [l]]) => opt(k, l, f.status)).join('')}</select></label>
<label>关键词<input name="q" value="${esc(f.q)}" maxlength="100" placeholder="子串匹配正文与 subject"></label>
<button>筛选</button>${f.ns || f.kind || f.status || f.q ? '<a class="btn quiet" href="/memory/entries">清除</a>' : ''}</form>`;
}

function actionForm(e: MemoryEntry, csrf: string): string {
  return e.status === 'forgotten'
    ? `<form method="post" action="/memory/entries/${e.id}/restore">${csrfField(csrf)}<button>恢复</button></form>`
    : `<form method="post" action="/memory/entries/${e.id}/forget">${csrfField(csrf)}<button class="danger">遗忘</button></form>`;
}

export function entriesPageBody(f: EntryFilters, result: MemoryEntryPage | { error: string }, csrf: string): string {
  let out = crumbs([['记忆', '/memory'], ['记忆条目']]);
  if ('error' in result) return out + `<div class="flash err" role="alert">读取记忆条目失败：${esc(result.error)}</div>`;
  out += filterForm(f, result.namespaces);
  const filtered = !!(f.ns || f.kind || f.status || f.q);
  if (!result.items.length) return out + (result.page ? empty('这一页没有更多条目了。')
    : empty(filtered ? '没有符合条件的记忆条目。换个条件或<a href="/memory/entries">清除筛选</a>。'
      : '还没有记忆条目。模型在回合里调用 mem_remember 后出现在这里。'));
  out += `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>#</th><th>命名空间</th><th>种类</th><th>正文</th><th class="hide-sm">时效</th><th>状态</th><th class="hide-sm">作者</th><th class="hide-sm">更新</th><th class="num hide-sm">召回</th><th>操作</th></tr></thead><tbody>${result.items.map(e => `<tr>
<td><a href="${entryHref(e.id)}">#${e.id}</a></td><td>${esc(e.ns_label)}<br><small class="mono">${esc(e.ns)}</small></td><td>${esc(ENTRY_KINDS[e.kind] ?? e.kind)}</td>
<td>${esc(e.text)}${e.subject ? `<br><small>关于 ${esc(e.subject)}</small>` : ''}</td><td class="hide-sm"><small>${esc(timing(e)) || '—'}</small></td><td>${statusStamp(e.status)}</td>
<td class="hide-sm"><small class="mono">${esc(e.author)}</small></td><td class="hide-sm"><small>${esc(fmtTime(e.updated_at))}</small></td><td class="num hide-sm">${fmtInt(e.recall_count)}</td>
<td>${actionForm(e, csrf)}</td></tr>`).join('')}</tbody></table></div></div>`;
  const nav = [f.page > 0 ? `<a class="btn quiet" href="/memory/entries?${esc(entryQuery({ ...f, page: f.page - 1 }))}">上一页</a>` : '',
    result.has_more ? `<a class="btn quiet" href="/memory/entries?${esc(entryQuery({ ...f, page: f.page + 1 }))}">下一页</a>` : ''].filter(Boolean).join(' ');
  return out + `<p class="hint">共 ${fmtInt(result.total)} 条，最近更新在前。遗忘只做标记：条目不再进入检索与提示，版本保留，可随时恢复。</p>${nav ? `<p class="mt">${nav}</p>` : ''}`;
}

export function entryPageBody(d: MemoryEntryDetail, csrf: string): string {
  const e = d.entry, link = (id: number) => `<a href="${entryHref(id)}">#${id}</a>`;
  let out = crumbs([['记忆', '/memory'], ['记忆条目', '/memory/entries'], [`#${e.id}`]]);
  const source = e.source ? `${esc(e.source.label)}${e.source.message_id ? ` <span class="mono">#${esc(e.source.message_id)}</span>` : ''} <a href="${esc(e.source.timeline_href)}">时间线</a>` +
    (e.source.turn_id ? ` · <a class="mono" href="/turns/${uri(e.source.turn_id)}">回合 ${esc(e.source.turn_id.slice(0, 16))}</a>` : '') : '<span class="faint">—</span>';
  out += `<div class="sheet pad">${kv([['命名空间', `${esc(e.ns_label)} <small class="mono">${esc(e.ns)}</small>`], ['种类', esc(`${ENTRY_KINDS[e.kind] ?? e.kind}（${e.kind}）`)],
    ['状态', statusStamp(e.status)], ['关于', e.subject ? esc(e.subject) : '<span class="faint">—</span>'], ['时效', esc(timing(e)) || '<span class="faint">—</span>'],
    ['作者', `<span class="mono">${esc(e.author)}</span>`], ['来源', source], ['置信度', esc(String(e.confidence))],
    ['创建', esc(fmtTime(e.created_at))], ['更新', esc(fmtTime(e.updated_at))],
    ['召回', `${fmtInt(e.recall_count)} 次${e.last_recalled_at !== null ? `，最近 ${esc(fmtTime(e.last_recalled_at))}` : ''}`]], 'meta')}
<div class="mt">${actionForm(e, csrf)}</div></div>`;
  out += `<section><h2>正文</h2><div class="sheet pad"><div class="sum-text">${esc(e.text)}</div></div></section>`;
  const supersedes = d.links.filter(l => l.rel === 'supersedes');
  if (supersedes.length) out += `<section><h2>取代链</h2><div class="sheet pad"><ul>${supersedes.map(l =>
    `<li>${link(l.from_id)} 取代 ${link(l.to_id)} <small>${esc(fmtTime(l.created_at))}</small></li>`).join('')}</ul></div></section>`;
  out += `<section><h2>版本历史</h2>${d.versions.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>操作者</th><th>状态</th><th>正文</th><th>原因</th></tr></thead><tbody>${d.versions.map(v => `<tr>
<td><small>${esc(fmtTime(v.at))}</small></td><td><small class="mono">${esc(v.by)}</small></td><td>${v.status_before && v.status_before !== v.status_after ? `${esc(ENTRY_STATUSES[v.status_before]?.[0] ?? v.status_before)} → ` : ''}${esc(ENTRY_STATUSES[v.status_after]?.[0] ?? v.status_after)}</td>
<td>${v.status_before === null ? '新建' : v.text_changed ? '已修改' : '—'}</td><td>${esc(v.reason ?? '')}</td></tr>`).join('')}</tbody></table></div></div>` : empty('没有版本记录。')}</section>`;
  return out;
}
