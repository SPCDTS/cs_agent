/**
 * 画像编辑与记忆任务页（docs/DASHBOARD.md §8.6）：/memory/profile/<ns> 与 /memory/jobs。
 * 数据来自 /api/memory/profile/<ns>、/api/memory/jobs 的同一份已脱敏 JSON；写操作是表单 POST（同源 + CSRF），成功 303 回原页。
 */
import type { MemoryBatchView, MemoryConsolidateBatch, MemoryJobsStatus, MemoryProfileView, MemoryProposalView } from '../memory/types.js';
import { crumbs } from './agents-pages.js';
import { extractCard, fmtUntil } from './memory-pages.js';
import { fmtInt } from '../../shared/format.js';
import { csrfField, empty, esc, fmtBytes, fmtMs, fmtTime, fmtWhen, kv, stamp, uri } from './html.js';

export const profileHref = (ns: string) => `/memory/profile/${uri(ns)}`;
const short = (v: string, n = 8) => v.length > n ? v.slice(0, n) : v;

/* ───────── /memory/profile/<ns> ───────── */

/** draft：保存失败时用户提交的草稿（经 esc 脱敏后只读展示，不丢失）。 */
export function profilePageBody(v: MemoryProfileView, csrf: string, draft?: string): string {
  let out = crumbs([['记忆', '/memory'], ['记忆任务', '/memory/jobs'], [`画像 · ${v.ns_label}`]]);
  out += `<form class="bar" method="get" action="/memory/profile"><label>命名空间<input name="ns" value="${esc(v.ns)}" maxlength="40" placeholder="owner、group:群号 或 private:QQ号" required></label><button class="quiet">打开</button></form>`;
  out += `<div class="sheet pad">${kv([['命名空间', `${esc(v.ns_label)} <small class="mono">${esc(v.ns)}</small>`],
    ['修改于', v.updated_at === null ? '<span class="faint">尚未创建</span>' : esc(fmtTime(v.updated_at))],
    ['大小', `${esc(fmtBytes(v.bytes))} / ${esc(fmtBytes(v.max_bytes))}${v.oversize ? ` ${stamp('超限', 'warn')}` : ''}`],
    ['revision', `<span class="mono">${esc(v.revision)}</span>`]], 'meta')}</div>`;
  if (v.oversize) out += `<div class="flash err" role="note">画像超过 ${esc(fmtBytes(v.max_bytes))} 上限，当前没有进入提示；请删减到上限以内再保存。</div>`;
  out += `<section><h2>画像 profile.md</h2>`;
  out += v.redacted_inside
    ? `<div class="flash err">画像中包含凭据样式的内容，面板只读展示脱敏版本；请在容器内直接编辑。</div><div class="sheet pad"><div class="sum-text">${esc(v.text)}</div></div>`
    : `<form method="post" action="${profileHref(v.ns)}" class="sheet pad">${csrfField(csrf)}<input type="hidden" name="revision" value="${esc(v.revision)}"><label>每轮进入该会话的系统提示（pi 的 memory 段、codex 的会话 AGENTS.md），写稳定的、每轮都该知道的内容。<textarea name="content" rows="18" spellcheck="false" data-count="profile-count">${esc(v.text)}</textarea></label><div class="hint"><span id="profile-count"></span>，上限 ${esc(fmtBytes(v.max_bytes))}；保存前检查凭据样式内容；他处（mem_profile、采纳提议）先改过会提示冲突。</div><p class="mt"><button>保存画像</button></p></form>`;
  out += '</section>';
  if (draft !== undefined) out += `<section><h2>未保存的草稿</h2><div class="sheet pad"><p class="hint">这是你刚才提交的内容，没有保存。对照上面的当前画像合并后再保存。</p><div class="sum-text">${esc(draft)}</div></div></section>`;
  return out;
}

/* ───────── /memory/jobs ───────── */

const PROPOSAL_RESULTS: Record<string, string> = { created: '生成了新提议', unchanged: '画像与条目未变，未重复生成', below_threshold: '偏好与要求不超过 30 条',
  no_model: '模型不可用', invalid_json: '输出形状不对', timeout: '模型超时', model_error: '模型出错', closed: '关闭时中止', oversize: '建议超过 4 KiB', secret: '建议含凭据样式内容',
  profile_unreadable: '画像不可读' };
const CONFLICT_SKIPS: Record<string, string> = { no_model: '模型不可用', invalid_json: '输出形状不对，整批跳过', timeout: '模型超时，整批跳过', model_error: '模型出错，整批跳过', closed: '关闭时中止' };

function batchLine(b: MemoryConsolidateBatch): string {
  const c = b.conflicts;
  const conflict = `冲突 ${fmtInt(c.pairs)} 对${c.skipped ? `（${CONFLICT_SKIPS[c.skipped] ?? c.skipped}）` : c.pairs ? `：取代 ${fmtInt(c.superseded)}、并存 ${fmtInt(c.coexist)}、保留 ${fmtInt(c.keep)}${c.protected ? `、未取代显式条目 ${fmtInt(c.protected)}` : ''}` : ''}`;
  return [`去重 ${fmtInt(b.dedup)}`, conflict, `孤立 ${fmtInt(b.orphaned)}`, `降级 ${fmtInt(b.retired)}`,
    ...(b.proposal ? [`画像提议：${PROPOSAL_RESULTS[b.proposal] ?? b.proposal}`] : [])].join(' · ');
}

function consolidateCard(c: MemoryJobsStatus['consolidate'], csrf: string, now: number): string {
  const r = c.last_report;
  const state = !c.enabled ? stamp('已关闭', 'idle') : c.running ? stamp('整理中', 'run') : stamp('空闲', 'idle');
  let out = `<section class="sheet pad flush"><h2>夜间整理 <small>每天在聊天记录整理之后运行：去重、近似冲突、孤立检查、降级、画像提议；开关在<a href="/settings#memory-extract">设置页</a></small></h2>
${kv([['当前', state], ['模型', c.available ? esc(c.model) : `${stamp('不可用', 'warn')} <small>近似冲突与画像提议跳过，其余步骤照常</small>`],
    ['上次完成', c.last_run === null ? '<span class="faint">从未运行</span>' : esc(fmtWhen(c.last_run, now))],
    ['下次计划', c.next_run === null ? '<span class="faint">未接入调度器</span>' : esc(fmtUntil(c.next_run, now))],
    ['上次结果', r ? `${r.status === 'ok' ? stamp('完成', 'ok') : stamp(r.status === 'closed' ? '中止' : '有失败', r.status === 'closed' ? 'warn' : 'fail')} ${esc(`去重 ${r.totals.dedup} · 取代 ${r.totals.superseded} · 孤立 ${r.totals.orphaned} · 降级 ${r.totals.retired} · 新提议 ${r.totals.proposals} · 耗时 ${fmtMs(r.ms) || '0 毫秒'}`)}` : '<span class="faint">没有报告</span>']], 'meta')}
<form method="post" action="/memory/consolidate/run" class="mt">${csrfField(csrf)}<button${c.enabled && !c.running ? '' : ' disabled'}>立即运行一次</button></form>`;
  if (r?.batches.length) out += `<div class="wrap mt"><table class="list"><thead><tr><th>命名空间</th><th>批次</th><th>各步计数</th><th class="num">耗时</th></tr></thead><tbody>${r.batches.map(b =>
    `<tr><td>${esc(b.ns)}</td><td class="mono" title="${esc(b.batch_id)}">${esc(short(b.batch_id))}</td><td>${b.status === 'failed' ? `${stamp('失败', 'fail')} ` : ''}${esc(batchLine(b))}${b.errors.length ? `<br><small class="s-warn">${esc(b.errors.join('；'))}</small>` : ''}</td><td class="num">${esc(fmtMs(b.ms) || '0 毫秒')}</td></tr>`).join('')}</tbody></table></div>`;
  return out + '</section>';
}

function proposalCard(p: MemoryProposalView, csrf: string, now: number): string {
  const current = p.current ? `<div class="sum-text">${p.current.text ? esc(p.current.text) : '<span class="faint">（画像为空）</span>'}</div>` : empty('当前画像读取失败。');
  return `<li class="sheet pad"><div class="hit-head"><b>提议 #${p.id}</b><span>${esc(p.ns_label)}</span><span class="faint">${esc(fmtWhen(p.created_at, now))}</span><span class="mono faint" title="${esc(p.batch_id)}">批次 ${esc(short(p.batch_id))}</span>${p.stale ? stamp('画像已变更', 'warn') : ''}</div>
${p.stale ? '<p class="hint s-warn">画像在提议生成之后已被修改：采纳会因版本冲突被拒绝。请刷新对照，必要时到画像页手动合并。</p>' : ''}
<div class="grid cols-2 mt"><div><h3>当前画像</h3>${current}</div><div><h3>建议改写</h3><div class="sum-text">${esc(p.text)}</div></div></div>
<div class="ops mt"><form method="post" action="/memory/proposals/${p.id}/accept">${csrfField(csrf)}<button${p.stale ? ' disabled' : ''}>采纳</button></form><form method="post" action="/memory/proposals/${p.id}/reject">${csrfField(csrf)}<button class="quiet">拒绝</button></form> <a class="btn quiet" href="${profileHref(p.ns)}">打开画像</a></div></li>`;
}

function batchTable(batches: MemoryBatchView[], csrf: string, now: number): string {
  if (!batches.length) return empty('还没有产生过变更的整理批次。');
  return `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>批次</th><th>命名空间</th><th class="num">变更</th><th>时间</th><th>操作</th></tr></thead><tbody>${batches.map(b => `<tr>
<td class="mono" title="${esc(b.batch_id)}">${esc(short(b.batch_id))}</td><td>${esc(b.ns_label)}<br><small class="mono">${esc(b.ns)}</small></td><td class="num">${fmtInt(b.changes)}</td><td><small>${esc(fmtWhen(b.at, now))}</small></td>
<td>${b.rolled_back ? stamp('已回退', 'idle') : `<form method="post" action="/memory/consolidate/${uri(b.batch_id)}/rollback">${csrfField(csrf)}<button class="danger">回退</button></form>`}</td></tr>`).join('')}</tbody></table></div></div>
<p class="hint">回退把该批次改过的条目恢复到整理前的状态与失效时间（正文不动），写一条 rollback 版本；批次之后又被改过的条目跳过；正在运行的批次不能回退。</p>`;
}

export function jobsPageBody(s: MemoryJobsStatus | { error: string }, csrf: string, now: number): string {
  let out = crumbs([['记忆', '/memory'], ['记忆任务']]);
  if ('error' in s) return out + `<div class="flash err" role="alert">读取记忆任务失败：${esc(s.error)}</div>`;
  out += extractCard(s.extract, now, { title: '回合后抽取' });
  out += consolidateCard(s.consolidate, csrf, now);
  out += `<section><h2>待确认的画像提议 <small>${s.proposals.length ? `${s.proposals.length} 条` : ''}</small></h2>${s.proposals.length
    ? `<ol class="lin-list">${s.proposals.map(p => proposalCard(p, csrf, now)).join('')}</ol>`
    : empty('没有待确认的提议。owner 的有效偏好与要求超过 30 条时，夜间整理会提出一份画像改写放在这里，不会自动写入。')}
<p class="hint"><a href="${profileHref('owner')}">编辑 owner 画像</a></p></section>`;
  out += `<section><h2>最近的整理批次 <small>最多 10 个</small></h2>${batchTable(s.batches, csrf, now)}</section>`;
  return out;
}
