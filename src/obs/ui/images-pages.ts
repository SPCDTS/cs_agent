import type { ImageDetail, ImageItem, ImagePage, ScopeSummary } from '../memory/types.js';
import { crumbs } from './agents-pages.js';
import { fmtInt } from './context-bar.js';
import { empty, esc, fmtBytes, fmtTime, kv, uri } from './html.js';
import { memoryScopeHref } from './memory-pages.js';

export const IMAGES_NOTE = '画廊只展示模型通过 qq_image 召回并入库的图片，不会主动下载';
const detailHref = (i: ImageItem) => `/memory/images/${uri(i.scope)}/${uri(i.message_id)}/${i.ordinal}`;
const timelineHref = (i: ImageItem) => memoryScopeHref(i.scope, { from: Math.max(0, i.message_ts - 3600_000), to: i.message_ts + 3600_000 }, '#messages');
const size = (i: ImageItem) => `${i.width !== null && i.height !== null ? `${i.width} × ${i.height}` : '尺寸未记录'} · ${i.bytes === null ? '字节数未知' : fmtBytes(i.bytes)}`;
const styles = (nonce: string) => `<style nonce="${esc(nonce)}">.image-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}.image-card{min-width:0;overflow-wrap:anywhere}.image-thumb{width:100%;height:200px;object-fit:contain}.image-missing{display:flex;align-items:center;justify-content:center;min-height:160px}.image-large{display:block;max-width:100%;max-height:75vh;margin:auto;object-fit:contain}.image-card p{margin:10px 0}.image-meta{overflow-wrap:anywhere}</style>`;
function picture(i: ImageItem, large = false): string {
  const href = large ? i.href : i.thumb_href;
  if (!i.present) return `<div class="image-missing faint">${i.status === 'skipped' ? '已跳过 · 未入库' : '文件已清理'}</div>`;
  if (!href || !/^\/media\/[a-f0-9]{64}$/i.test(href)) return '<div class="image-missing faint">图片不可用</div>';
  return `<img loading="lazy" class="${large ? 'image-large' : 'image-thumb'}" src="${esc(href)}" alt="图片 ${esc(i.ordinal)}">`;
}
function card(i: ImageItem): string {
  return `<article class="sheet pad image-card"><a href="${detailHref(i)}">${picture(i)}</a><p><b>${esc(i.sender_name)}</b> <span class="pill">${i.status === 'ok' ? '已入库' : '已跳过'}</span></p>
<p>${esc(fmtTime(i.message_ts))} · ${esc(i.scope)}</p><p>${esc(i.excerpt)}</p><p class="hint">${esc(size(i))}</p>
<a href="${detailHref(i)}">图片详情</a> · <a href="${timelineHref(i)}">消息时间线</a></article>`;
}

export function imagesPageBody(q: URLSearchParams, scopes: ScopeSummary[], result: ImagePage | { error: string }, nonce: string): string {
  const scope = q.get('scope') ?? '', status = q.get('status') ?? '', since = q.get('since') ?? '';
  let out = styles(nonce) + crumbs([['记忆', '/memory'], ['图片记忆']]);
  out += `<form class="bar" method="get" action="/memory/images"><label>会话域<select name="scope"><option value="">全部</option>${scopes.map(s => `<option value="${esc(s.scope)}"${s.scope === scope ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}${scope && !scopes.some(s => s.scope === scope) ? `<option value="${esc(scope)}" selected>${esc(scope)}</option>` : ''}</select></label>
<label>状态<select name="status"><option value="">全部</option><option value="ok"${status === 'ok' ? ' selected' : ''}>已入库</option><option value="skipped"${status === 'skipped' ? ' selected' : ''}>已跳过</option></select></label><label>起始日期（UTC）<input type="date" name="since" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(since) ? since : '')}"></label><button>筛选</button></form>`;
  if ('error' in result) return out + `<p class="flash err" role="alert">${esc(result.error)}</p>`;
  const r = result;
  out += `<p class="sheet pad">共 ${fmtInt(r.totals.ok + r.totals.skipped)} 张 · 已入库 ${fmtInt(r.totals.ok)} · 已跳过 ${fmtInt(r.totals.skipped)} · 总字节 ${fmtInt(r.totals.bytes)} B（${esc(fmtBytes(r.totals.bytes))}）</p>
<p class="hint">总计覆盖当前筛选的全部记录；字节仅计现存文件，同一图片被多条消息召回时按记录累加。尺寸和 MIME 未存储时不推测。</p>`;
  out += r.items.length ? `<div class="image-grid">${r.items.map(card).join('')}</div>` : empty('没有符合筛选条件的图片记录。');
  const pageHref = (n: number) => { const p = new URLSearchParams(q); p.set('page', String(n)); return '/memory/images?' + esc(p.toString()); };
  return out + `<nav class="phase-nav mt" aria-label="图片分页">${r.page ? `<a href="${pageHref(r.page - 1)}">上一页</a>` : ''}<span>第 ${fmtInt(r.page + 1)} 页</span>${r.has_more ? `<a href="${pageHref(r.page + 1)}">下一页</a>` : ''}</nav>`;
}

export function imageDetailBody(d: ImageDetail, nonce: string): string {
  const i = d.item;
  return styles(nonce) + crumbs([['记忆', '/memory'], ['图片记忆', '/memory/images'], [`图片 ${i.ordinal}`]]) +
    `<div class="sheet pad">${picture(i, true)}</div><section class="sheet pad image-meta">${kv([
      ['会话域', esc(i.scope)], ['消息 ID', esc(i.message_id)], ['序号', esc(i.ordinal)], ['发送者', esc(i.sender_name)],
      ['消息时间', esc(fmtTime(i.message_ts))], ['状态', i.status === 'ok' ? '已入库' : '已跳过'], ['文件', i.present ? '存在' : i.status === 'ok' ? '文件已清理' : '未入库'],
      ['尺寸 / 字节', esc(size(i))], ['MIME', esc(i.mime ?? '未记录')], ['SHA-256', esc(i.sha256 ?? '—')],
    ], 'meta')}<h2>所属消息摘要</h2><p>${esc(d.message.excerpt)}</p><p><a href="${timelineHref(i)}">消息时间线</a> · <a href="/memory/images?scope=${uri(i.scope)}">返回本会话画廊</a> · <a href="/memory/images">返回全部图片</a></p></section>
<section><h2>同消息其它图片 <small>${d.other_media.length} 张</small></h2>${d.other_media.length ? `<div class="image-grid">${d.other_media.map(card).join('')}</div>` : empty('这条消息没有其它图片。')}</section>`;
}
