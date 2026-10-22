/**
 * 观测 v2 的记忆页面（docs/DASHBOARD.md §8）。数据来自 /api/memory/* 的同一份已脱敏 JSON
 * （http.ts 在服务端内部调用记忆路由取得）；这里只做渲染，所有文本经 esc。
 * 时间线由 /assets/memory.js 用本地 vis-timeline 绘制，数据经 <script type="application/json"> 传入。
 */
import { redactText } from '../../shared/redact.js';
import type { AgingReport, AgingStatus, ArchiveRow, CompactionRow, Hit, MessageItem, Retention, ScopeSummary, ScopeTimeline, SummaryVersion } from '../memory/types.js';
import { crumbs, dataScript } from './agents-pages.js';
import { fmtInt } from '../../shared/format.js';
import { empty, esc, fmtMs, fmtTime, fmtWhen, kv, stamp, uri } from './html.js';
import { scopeLabel } from '../../context/access.js';

const DAY = 86400_000;
export const MESSAGE_PAGE = 50;

export interface MemoryOverview { scopes: ScopeSummary[]; aging: AgingStatus; retention: Retention }
/** next_before_id：同秒内的行 id 决胜游标（接口新增；缺席时只用 next_before）。 */
export interface MessagePage { items: MessageItem[]; next_before?: number; next_before_id?: number }
export interface SummaryDetail {
  id: number; scope: string; kind: 'day' | 'week'; period_start: number; period_end: number;
  created_at: number; text: string; surviving_raw: number; deleted?: true;
  lineage: null | { versions: SummaryVersion[]; replaced: SummaryVersion[] };
}
/** 首页召回卡：最近 24 小时的事件数（一页 50 条，has_more 时显示 50+）；null 表示读取失败。 */
export interface RecallCount { count: number; more: boolean }
export interface SearchResult { hits: Hit[]; tool_text: string; tool_text_chars: number; max_chars: number; dropped: number }
export interface ArchivesResult { codex: ArchiveRow[]; pi: ArchiveRow[]; compactions: CompactionRow[] }

export const memoryScopeHref = (scope: string, q?: { from?: number | string; to?: number | string }, hash = '') => {
  const p = new URLSearchParams();
  if (q?.from !== undefined) p.set('from', String(q.from));
  if (q?.to !== undefined) p.set('to', String(q.to));
  const s = p.toString();
  return `/memory/scopes/${uri(scope)}${s ? '?' + esc(s) : ''}${hash}`;
};
export const summaryHref = (id: number | string) => `/memory/summaries/${uri(String(id))}`;
const KIND: Record<string, string> = { day: '日摘要', week: '周摘要', message: '消息', summary: '摘要' };
const when = (ms: number | null | undefined, now: number) => ms === null || ms === undefined ? '—' : esc(fmtWhen(ms, now));
const span = (a: number, b: number) => `${esc(fmtTime(a))} — ${esc(fmtTime(b))}`;
const chars = (n: number) => `${fmtInt(n)} 字`;

/** 未来时间：完整时间 + "约 N 小时后"（html.fmtWhen 只描述过去）。 */
export function fmtUntil(ms: number, now: number): string {
  const d = ms - now;
  if (d <= 0) return `${fmtTime(ms)}（已到计划时间）`;
  const rel = d < 3600_000 ? `约 ${Math.max(1, Math.round(d / 60_000))} 分钟后` : d < DAY ? `约 ${Math.round(d / 3600_000)} 小时后` : `约 ${Math.round(d / DAY)} 天后`;
  return `${fmtTime(ms)}（${rel}）`;
}

/* ───────── /memory ───────── */

function reportLine(r: AgingReport): string {
  return [`日摘要 ${fmtInt(r.day_summaries)}`, `周摘要 ${fmtInt(r.week_summaries)}`, `失败 ${fmtInt(r.failed)}`,
    `清理原文 ${fmtInt(r.purged_messages)}`, `清理摘要 ${fmtInt(r.purged_summaries)}`, `耗时 ${fmtMs(r.ms) || '0 毫秒'}`].join(' · ');
}

export function agingCard(o: MemoryOverview, now: number): string {
  const a = o.aging, r = o.retention;
  const state = a.running ? stamp('整理中', 'run') : stamp('空闲', 'idle');
  const catchUp = a.catch_up_needed ? `${stamp('需要补跑', 'warn')} <small>${a.last_run === null ? '从未成功运行' : '距上次成功运行已超过 24 小时'}；启动或下次计划时补跑</small>` : `${stamp('正常', 'ok')}`;
  return `<section class="sheet pad flush aging-card"><h2>聊天记录整理 <small>每天 ${esc(r.dailyHour)} 点（${esc(r.tz)}）生成日 / 周摘要并按保留期清理</small></h2>
${kv([
    ['当前', state], ['上次运行', when(a.last_run, now)],
    ['上次报告', a.last_report ? esc(reportLine(a.last_report)) : '<span class="faint">没有完整的整理报告</span>'],
    ['下次计划', a.next_run === null ? '<span class="faint">未接入调度器</span>' : esc(fmtUntil(a.next_run, now)) + (a.running ? ' <small>（执行中可能顺延）</small>' : '')],
    ['补跑', catchUp],
    ['保留策略', esc(`原文 ${r.rawDays} 天（未被摘要覆盖的最长 ${Math.max(r.rawDays, r.hardMaxDays)} 天），摘要 ${r.summaryDays} 天`)],
  ], 'meta')}</section>`;
}

export function memoryHomeBody(o: MemoryOverview, now: number, recalls?: RecallCount | null): string {
  let out = agingCard(o, now);
  out += `<section><h2>会话域 <small>${o.scopes.length ? `${o.scopes.length} 个，按 scope 排序` : ''}</small></h2>`;
  out += o.scopes.length ? `<div class="sheet"><div class="wrap"><table class="list mem-scopes"><thead><tr><th>会话域</th><th class="num">消息</th><th class="num">日 / 周摘要</th><th class="num">待整理日</th><th class="num hide-sm">媒体</th><th class="hide-sm">时间范围</th><th class="num hide-sm">体量</th><th>时间线</th></tr></thead><tbody>${o.scopes.map(s => `<tr>
<td><a href="${memoryScopeHref(s.scope)}">${esc(s.label)}</a><br><small class="mono">${esc(s.scope)}</small></td><td class="num">${fmtInt(s.messages)}</td><td class="num">${fmtInt(s.summaries.day)} / ${fmtInt(s.summaries.week)}</td>
<td class="num">${s.pending_day_summaries ? `<span class="s-warn">${fmtInt(s.pending_day_summaries)}</span>` : '0'}</td><td class="num hide-sm">${fmtInt(s.media_count)}</td>
<td class="hide-sm"><small>${span(s.first_ts, s.last_ts)}</small></td><td class="num hide-sm" title="消息与摘要正文字符数之和，不是文件大小">约 ${esc(fmtInt(s.bytes_estimate))} 字</td><td><a href="${memoryScopeHref(s.scope)}">查看</a></td></tr>`).join('')}</tbody></table></div></div>
<p class="hint">体量是消息与摘要正文的字符数之和（估计值，不是 UTF-8 字节或数据库文件大小）。待整理日：今天之前、当天至少 5 条、尚未被日 / 周摘要覆盖的日子。</p>`
    : empty('聊天记录库还没有任何会话域。收到第一条 QQ 消息后出现在这里。');
  out += '</section>';
  out += `<section><h2>工具</h2><div class="grid cols-3 mem-tools">
<a class="sheet pad tool-link" href="/memory/search"><b>检索检查器</b><small>检索命中 → 工具实际返回的对照</small></a>
<a class="sheet pad tool-link" href="/memory/archives"><b>线程归档</b><small>Codex / Pi 归档线程与 Pi 压缩记录</small></a>
<a class="sheet pad tool-link" href="/context"><b>上下文检索（旧）</b><small>qq_context 工具原样输出</small></a>
<a class="sheet pad tool-link" href="/memory/recalls"><b>召回记录</b><small>${recalls ? `最近 24 小时 ${fmtInt(recalls.count)}${recalls.more ? '+' : ''} 次工具召回` : recalls === null ? '最近 24 小时的数量暂不可用' : 'qq_recent / qq_search / qq_message 每次调用与三级证据'}</small></a>
<a class="sheet pad tool-link" href="/memory/images"><b>图片记忆</b><small>共 ${fmtInt(o.scopes.reduce((n, s) => n + s.media_count, 0))} 张（含已跳过）</small></a></div></section>`;
  return out;
}

/* ───────── /memory/scopes/:scope ───────── */

export type RangePreset = '3d' | '30d' | 'all';
/** 区间按钮 → 页面查询（与 API 的 from/to 一致）；"全部"不带参数，由 API 取全域范围。 */
export function rangeQuery(preset: RangePreset, now: number): { from?: number; to?: number } {
  if (preset === 'all') return {};
  return { from: now - (preset === '3d' ? 3 : 30) * DAY };
}
/** 页面原样转发给 API 的区间参数：只认 from / to，其它查询参数忽略。 */
export function rangeParams(q: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of ['from', 'to']) { const v = q.get(k); if (v !== null && v !== '') out.set(k, v); }
  return out;
}
/** 选中窗口 [from, to) → 消息接口的严格界限 after < ts < before（毫秒整数）。 */
export function messageWindow(from: number, to: number): { after?: number; before: number } {
  return from >= 1 ? { after: from - 1, before: to } : { before: to };
}

export function messageItem(m: MessageItem): string {
  const tags = [m.bot_status ? `<span class="pill">${esc(m.bot_status)}</span>` : '', m.bot_action ? `<span class="pill">${esc(m.bot_action)}</span>` : '',
    m.media ? `<span class="pill">媒体 ${fmtInt(m.media)}</span>` : '', m.reply_to ? `<span class="faint">回复 <span class="mono">${esc(m.reply_to)}</span></span>` : ''].filter(Boolean).join('');
  return `<li class="msg" data-ts="${m.ts}"><div class="msg-head"><time datetime="${new Date(m.ts).toISOString()}">${esc(fmtTime(m.ts))}</time><b>${esc(m.sender_name || m.sender || '—')}</b>${m.sender ? `<span class="mono faint">${esc(m.sender)}</span>` : ''}${tags}<span class="mono faint msg-id">#${esc(m.message_id)}</span></div>
<div class="msg-text">${esc(m.text)}</div>${m.truncated ? '<div class="hint">正文超过 2000 字，已截断。</div>' : ''}</li>`;
}

export interface ScopePageInput {
  timeline: ScopeTimeline; messages: MessagePage | { error: string; status: number }; nonce: string; now: number;
  params: URLSearchParams; vendor: boolean;
}
const isError = (m: ScopePageInput['messages']): m is { error: string; status: number } => 'error' in m;
export const MESSAGE_ERROR_HINT = '读取消息失败';

export function rangeControls(scope: string, params: URLSearchParams, now: number): string {
  const link = (preset: RangePreset, label: string) => {
    const on = preset === 'all' && !params.has('from') && !params.has('to');
    return `<a class="pill${on ? ' on' : ''}" href="${memoryScopeHref(scope, rangeQuery(preset, now))}" data-preset="${preset}">${label}</a>`;
  };
  const date = (k: string) => { const v = params.get(k) ?? ''; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; };
  return `<div class="phase-nav range-nav"><span class="muted">区间</span>${link('3d', '最近 3 天')}${link('30d', '最近 30 天')}${link('all', '全部')}
<form class="range-form" method="get" action="/memory/scopes/${uri(scope)}"><label>从<input type="date" name="from" value="${esc(date('from'))}" required></label><label>至（不含）<input type="date" name="to" value="${esc(date('to'))}" required></label><button class="quiet">应用</button></form></div>`;
}

export function scopePageBody(i: ScopePageInput): string {
  const t = i.timeline, e = t.retention_edges;
  let out = crumbs([['记忆', '/memory'], [t.label]]);
  out += `<div class="sheet pad">${kv([['scope', `<span class="mono">${esc(t.scope)}</span>`], ['查询区间', `${span(t.range.first_ts, t.range.last_ts)} <small>（左闭右开）</small>`],
    ['原文保留边界', esc(fmtTime(e.raw_until))], ['摘要保留边界', esc(fmtTime(e.day_until))],
    ['本区间', esc(`原文 ${fmtInt(t.tracks.raw.reduce((n, b) => n + b.count, 0))} 条（${t.tracks.raw.length} 个桶），日摘要 ${t.tracks.day.length}，周摘要 ${t.tracks.week.length}`)]], 'meta')}</div>`;
  out += rangeControls(t.scope, i.params, i.now);
  out += `<section class="flush"><div id="mtl" class="sheet mtl" aria-label="记忆时间线">${i.vendor ? '<p class="faint placeholder">正在绘制时间线…</p>' : '<p class="flash err">时间线组件（vis-timeline）未安装，下面仍可查看摘要与消息列表。</p>'}</div>
<div class="mtl-legend hint"><span><i class="lg lg-raw" aria-hidden="true"></i>原文（颜色越深越密）</span><span><i class="lg lg-day" aria-hidden="true"></i>日摘要</span><span><i class="lg lg-week" aria-hidden="true"></i>周摘要</span>
<span><i class="lg lg-purged" aria-hidden="true"></i>早于保留边界的空白（按策略推算）</span><span><i class="lg lg-none" aria-hidden="true"></i>无现存记录</span><span><i class="lg lg-edge" aria-hidden="true"></i>保留期边界</span></div>
<p class="hint">点击原文桶列出该桶内的消息，点击摘要打开摘要正文；拖动或滚轮缩放后可"列出可视范围内的消息"。保留边界是配置推算，不是实际删除证明；空白只表示当前没有记录，不能断言当时没有聊天。</p>
<p class="mtl-actions"><button type="button" class="quiet" id="mtl-visible" hidden>列出可视范围内的消息</button> <button type="button" class="quiet" id="mtl-reset" hidden>恢复整个查询区间</button></p></section>`;
  const sums = [...t.tracks.week, ...t.tracks.day].sort((a, b) => a.period_start - b.period_start);
  out += `<section><details><summary>摘要列表（日摘要 ${t.tracks.day.length}，周摘要 ${t.tracks.week.length}）</summary>${sums.length ? `<div class="sheet mt"><div class="wrap"><table class="list"><thead><tr><th>类型</th><th>区间</th><th class="num">字数</th><th>摘录</th></tr></thead><tbody>${sums.map(s => `<tr><td>${esc(KIND[s.kind])}</td><td><a href="${summaryHref(s.id)}">${span(s.period_start, s.period_end)}</a></td><td class="num">${fmtInt(s.chars)}</td><td><span class="excerpt">${esc(s.preview)}</span></td></tr>`).join('')}</tbody></table></div></div>` : empty('这个区间没有摘要。')}</details>
${t.gaps.length ? `<details class="mt"><summary>空白区间 ${t.gaps.length} 段</summary><ul class="notes mt">${t.gaps.map(g => `<li>${span(g.from, g.to)}：${g.reason === 'purged' ? '早于所有层的保留边界（按策略推算的过期区域）' : '无现存记录'}</li>`).join('')}</ul></details>` : ''}</section>`;
  const win = messageWindow(t.range.first_ts, t.range.last_ts);
  const m = i.messages;
  out += `<section id="messages"><h2>消息 <small id="msg-window">${span(t.range.first_ts, t.range.last_ts)}，最新在上</small></h2>
<ol id="msgs" class="msgs">${isError(m) ? '' : m.items.map(messageItem).join('')}</ol>
<div id="msg-empty"${!isError(m) && !m.items.length ? '' : ' hidden'}>${empty('这个窗口没有现存消息。')}</div>
<p id="msg-note" class="hint${isError(m) ? ' err' : ''}" role="status">${isError(m) ? esc(`${MESSAGE_ERROR_HINT}（HTTP ${m.status}：${m.error}）`) : ''}</p>
<p><button type="button" class="quiet" id="msg-more"${!isError(m) && m.next_before !== undefined ? '' : ' hidden'}>更早</button></p></section>`;
  out += dataScript('memory-data', i.nonce, { scope: t.scope, label: t.label, range: t.range, retention_edges: t.retention_edges, tracks: t.tracks, gaps: t.gaps,
    window: win, next_before: isError(m) ? null : m.next_before ?? null,
    next_before_id: isError(m) ? null : m.next_before_id ?? null, limit: MESSAGE_PAGE });
  return out;
}

/* ───────── /memory/summaries/:id ───────── */

export function summaryPageBody(s: SummaryDetail, label: string): string {
  const len = [...s.text].length, length = s.period_end - s.period_start;
  const pad = Math.max(DAY, length);
  let out = crumbs([['记忆', '/memory'], [label, memoryScopeHref(s.scope)], [`${KIND[s.kind] ?? s.kind} #${s.id}`]]);
  if (s.deleted) out += `<div class="flash warn" role="note"><b>这条${esc(KIND[s.kind] ?? s.kind)}已被折叠进周摘要并从聊天库删除。</b>下面是观测库保存的最后一个快照；生成时间为快照记录时间。</div>`;
  out += `<div class="sheet pad">${kv([['会话域', `<a href="${memoryScopeHref(s.scope)}">${esc(label)}</a> <small class="mono">${esc(s.scope)}</small>`], ['类型', esc(KIND[s.kind] ?? s.kind)],
    ['覆盖区间', `${span(s.period_start, s.period_end)} <small>（左闭右开）</small>`], ['生成于', esc(fmtTime(s.created_at))], ['字数', esc(chars(len))],
    ['尚存原文', `${esc(fmtInt(s.surviving_raw))} 条 <small>（区间内当前仍存在的原文，不等于生成摘要时的输入条数）</small>`]], 'meta')}
<p class="mt"><a class="btn" href="${memoryScopeHref(s.scope, { from: Math.max(0, s.period_start - pad), to: s.period_end + pad })}">在时间线上查看</a> <a class="btn quiet" href="${memoryScopeHref(s.scope, { from: s.period_start, to: s.period_end }, '#messages')}">这段时间的消息</a></p></div>`;
  out += `<section><h2>正文</h2><div class="sheet pad"><div class="sum-text">${esc(s.text)}</div></div></section>`;
  out += lineageSection(s.lineage);
  return out;
}

/** usage 是模型原样上报的对象：只列数值字段（tokens 计数），其它形状给紧凑 JSON。 */
export function usageText(u: unknown): string {
  if (u === null || u === undefined) return '';
  if (typeof u === 'object' && !Array.isArray(u)) {
    const nums = Object.entries(u as Record<string, unknown>).filter(([, v]) => typeof v === 'number');
    if (nums.length) return nums.map(([k, v]) => `${k} ${fmtInt(v as number)}`).join(' · ');
  }
  const t = JSON.stringify(u) ?? '';
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}
const short = (v: string, n: number) => v.length > n ? v.slice(0, n) : v;

function versionCard(v: SummaryVersion): string {
  const usage = usageText(v.usage);
  const model = v.model || v.provider ? esc([v.model, v.provider].filter(Boolean).join(' / ')) : '<span class="faint">未调用模型（沿用原文或历史快照）</span>';
  const msgs = v.input_message_ids.length
    ? `<details><summary>${fmtInt(v.input_message_ids.length)} 条</summary><p class="mono lin-ids">${v.input_message_ids.map(id => esc(id)).join(' ')}</p></details>` : '<span class="faint">0 条</span>';
  const sums = v.input_summary_ids.length ? v.input_summary_ids.map(id => `<a class="mono" href="${summaryHref(id)}">#${esc(id)}</a>`).join(' ') : '<span class="faint">—</span>';
  const replaced = v.replaced_by !== null ? `版本 <span class="mono">#${esc(v.replaced_by)}</span>${v.replaced_at !== null ? `，${esc(fmtTime(v.replaced_at))}` : ''}` : '<span class="faint">未被替换</span>';
  return `<li class="sheet pad lin-version"><div class="hit-head"><b>版本 #${esc(v.id)}</b><span class="pill">${esc(KIND[v.level] ?? v.level)}</span><span class="faint">${esc(fmtTime(v.created_at))}</span><span class="mono faint" title="${esc(v.batch_id)}">批次 ${esc(short(v.batch_id, 8))}</span></div>
<div class="mt">${kv([['区间', span(v.period_start, v.period_end)], ['模型', model], ['用量', usage ? esc(usage) : '<span class="faint">—</span>'],
    ['输入 → 保留', `${esc(chars(v.input_chars))} → ${esc(chars(v.kept_chars))}`], ['输入消息', msgs], ['输入摘要', sums],
    ['正文 SHA-256', `<span class="mono" title="${esc(v.text_sha256)}">${esc(short(v.text_sha256, 12))}</span>`], ['被替换', replaced]], 'meta')}</div></li>`;
}

export function lineageSection(l: SummaryDetail['lineage']): string {
  if (!l) return `<section><h2>血缘</h2>${empty('暂无血缘记录（埋点启用前生成，或已超过保留期）。没有记录不代表摘要没有来源。')}</section>`;
  let out = `<section><h2>血缘 <small>${l.versions.length} 个版本</small></h2>`;
  out += l.versions.length ? `<ol class="lin-list">${l.versions.map(versionCard).join('')}</ol>` : empty('这个摘要没有版本记录。');
  out += '<p class="hint">输入字数是发给整理模型的 user 输入长度（不含 system prompt），保留字数是落库正文长度；SHA-256 针对原始落库快照，不是脱敏后的显示文本。版本可能已按保留期清理，断开的血缘不代表没有来源。</p></section>';
  if (l.replaced.length) out += `<section><h2>被替换的日摘要快照 <small>${l.replaced.length} 条</small></h2><ol class="lin-list">${l.replaced.map(v => `<li class="sheet pad lin-version"><div class="hit-head"><a href="${summaryHref(v.summary_id)}">${esc(KIND[v.level] ?? v.level)} #${esc(v.summary_id)}</a><span>${span(v.period_start, v.period_end)}</span><span class="faint">版本 #${esc(v.id)} · ${esc(fmtTime(v.created_at))}</span><span class="mono faint" title="${esc(v.text_sha256)}">${esc(short(v.text_sha256, 12))}</span></div>
<details class="mt"><summary>快照正文（${esc(chars([...v.text].length))}）</summary><div class="sum-text mt">${esc(v.text)}</div></details></li>`).join('')}</ol></section>`;
  return out;
}

/* ───────── /memory/search ───────── */

const plain = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** 与接口相同的检索词：空白切分、去掉 LIKE 通配符、最多 5 个。 */
export const searchTerms = (q: string) => q.trim().slice(0, 100).split(/\s+/).map(t => t.replace(/[%_\\]/g, '')).filter(Boolean).slice(0, 5);
/**
 * 关键词高亮：整体脱敏一次，在脱敏后的原文上找命中区间（ASCII 大小写不敏感，与 SQLite LIKE 相同），
 * 再逐段 HTML 转义并把命中段包进 <mark>。不在已转义的字符串上替换，避免切进实体。
 */
export function highlight(text: string, terms: string[], limit = 100_000): string {
  const t = redactText(text, limit);
  const fold = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());
  const hay = fold(t), marks: [number, number][] = [];
  for (const term of terms.map(fold).filter(Boolean)) {
    for (let at = hay.indexOf(term); at >= 0; at = hay.indexOf(term, at + term.length)) marks.push([at, at + term.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) { const last = merged.at(-1); if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push([...m]); }
  let out = '', pos = 0;
  for (const [a, b] of merged) { out += plain(t.slice(pos, a)) + `<mark>${plain(t.slice(a, b))}</mark>`; pos = b; }
  return out + plain(t.slice(pos));
}


export interface SearchForm { scope: string; q: string; days: string; limit: string }
export function searchForm(f: SearchForm, scopes: ScopeSummary[]): string {
  return `<form class="bar search-form" method="get" action="/memory/search"><label>会话域<select name="scope"><option value="">全部（管理员视角）</option>${scopes.map(s => `<option value="${esc(s.scope)}"${s.scope === f.scope ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}${f.scope && !scopes.some(s => s.scope === f.scope) ? `<option value="${esc(f.scope)}" selected>${esc(f.scope)}</option>` : ''}</select></label>
<label>关键词<input name="q" value="${esc(f.q)}" placeholder="关键词，空格分隔多个词（须同时出现）" maxlength="100" required></label><label>天数<input name="days" type="number" min="1" max="180" placeholder="30" value="${esc(f.days)}"></label><label>条数<input name="limit" type="number" min="1" max="20" placeholder="10" value="${esc(f.limit)}"></label><button>检索</button></form>`;
}

/** 第三级只对真实调用成立：检查器给出指向召回记录的链接（所选 scope 的 qq_search 调用）。 */
export const levelsNote = (scope: string) => {
  const p = new URLSearchParams();
  if (scope) p.set('scope', scope);
  p.set('tool', 'qq_search');
  return `<div class="levels sheet pad"><span class="lv lv-1">① 检索命中</span>数据库按关键词返回的记录（时间新到旧，无相关性分数）
<span class="lv lv-2">② 工具实际返回</span>经同一 formatter 与 QQ_CONTEXT_MAX_CHARS 字数上限裁剪后，qq_search 工具交给模型的文本
<span class="lv lv-3">③ 进入模型请求</span><span>只对某次真实调用成立，检查器里的检索不产生第三级证据。<a href="/memory/recalls?${esc(p.toString())}">在召回记录中查看该 scope 的历史调用</a></span>
<p class="hint mt">面板以管理员视角检索（全部或所选会话域），不代表某次对话的 QQ_ACCESS；这是当前数据库的对照，不证明历史上某次调用发生过，也不代表模型采用了这些内容。</p></div>`;
};

export function searchPageBody(f: SearchForm, scopes: ScopeSummary[], result?: SearchResult | { error: string }): string {
  let out = crumbs([['记忆', '/memory'], ['检索检查器']]) + searchForm(f, scopes);
  out += levelsNote(f.scope);
  if (!result) return out;
  if ('error' in result) return out + `<div class="flash err" role="alert">${esc(result.error)}</div>`;
  const terms = searchTerms(f.q), r = result;
  const label = (scope: string) => scopes.find(s => s.scope === scope)?.label ?? scopeLabel(scope);
  const hitHref = (h: Hit) => h.kind === 'summary' ? summaryHref(h.id) : memoryScopeHref(h.scope, { from: Math.max(0, h.ts - 3600_000), to: h.ts + 3600_000 }, '#messages');
  const hits = r.hits.length ? `<ol class="hits">${r.hits.map(h => `<li class="hit sheet pad"><div class="hit-head"><span class="lv lv-1">${esc(KIND[h.kind] ?? h.kind)}</span><a href="${hitHref(h)}">${esc(fmtTime(h.ts))}</a><span class="faint">${esc(label(h.scope))}</span>${h.matched_fields.map(x => `<span class="pill">${esc(x)}</span>`).join('')}<span class="mono faint">#${esc(h.id)}</span></div>
<div class="hit-text">${highlight(h.excerpt, terms)}</div></li>`).join('')}</ol>` : empty('没有命中。换个关键词或放宽天数。');
  const over = r.tool_text_chars > r.max_chars;
  const tool = `<div class="sheet pad tool-panel"><div class="gauge"><meter min="0" max="${Math.max(1, r.max_chars)}" value="${Math.min(r.tool_text_chars, Math.max(1, r.max_chars))}" aria-label="工具返回字数"></meter><span>${fmtInt(r.tool_text_chars)} / ${fmtInt(r.max_chars)} 字${over ? '（脱敏占位符使长度略超上限）' : ''}</span></div>
<p class="${r.dropped ? 's-warn' : 'muted'}">${r.dropped ? `${fmtInt(r.dropped)} 条命中但未进入工具返回（超出字数上限被裁剪）` : '全部命中都进入了工具返回'}</p>
<pre class="tool-text">${highlight(r.tool_text, terms)}</pre></div>`;
  out += `<div class="grid cols-2 search-cols"><section><h2><span class="lv lv-1">①</span> 检索命中 <small>${r.hits.length} 条</small></h2>${hits}</section>
<section><h2><span class="lv lv-2">②</span> 工具实际返回 <small>qq_search</small></h2>${tool}</section></div>`;
  return out;
}

/* ───────── /memory/archives ───────── */

const safeHref = (h: string) => /^\/agents\/(codex|pi)\/sessions\/[^/?#]+$/.test(h) ? esc(h) : '';
function archiveTable(rows: ArchiveRow[], backend: 'codex' | 'pi'): string {
  if (!rows.length) return empty('没有归档记录。重置线程后旧会话会出现在这里。');
  return `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>线程键</th><th>会话 ID</th><th class="hide-sm">创建</th><th>归档</th><th>原因</th></tr></thead><tbody>${rows.map(r => {
    const id = backend === 'codex' ? r.thread_id ?? '' : String(r.conversation ?? ''), href = safeHref(r.session_href);
    return `<tr><td>${esc(backend === 'codex' ? r.key : scopeLabel(r.key))}<br><small class="mono">${esc(r.key)}</small></td><td>${href ? `<a class="mono" href="${href}">${esc(id)}</a>` : `<span class="mono">${esc(id)}</span>`}</td><td class="hide-sm">${r.created_at === null ? '<span class="faint">—</span>' : esc(fmtTime(r.created_at))}</td><td>${r.archived_at === null ? '—' : esc(fmtTime(r.archived_at))}</td><td>${esc(r.reason)}</td></tr>`;
  }).join('')}</tbody></table></div></div>`;
}

export function archivesPageBody(a: ArchivesResult | { error: string }): string {
  let out = crumbs([['记忆', '/memory'], ['线程归档']]);
  if ('error' in a) return out + `<div class="flash err" role="alert">读取归档失败：${esc(a.error)}</div>`;
  out += `<section><h2>Codex 归档线程 <small>${a.codex.length} 条，最新在上</small></h2>${archiveTable(a.codex, 'codex')}</section>`;
  out += `<section><h2>Pi 归档会话 <small>${a.pi.length} 条</small></h2>${archiveTable(a.pi, 'pi')}<p class="hint">Pi 镜像没有创建时间时显示"—"，不用归档时间代替。</p></section>`;
  out += `<section><h2>Pi 上下文压缩 <small>${a.compactions.length} 个会话</small></h2>${a.compactions.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>会话</th><th class="num">次数</th><th>最近</th><th>原因</th></tr></thead><tbody>${a.compactions.map(c => `<tr><td><a class="mono" href="/agents/pi/sessions/${uri(String(c.conversation))}">${esc(c.conversation)}</a></td><td class="num">${fmtInt(c.attempts)}</td><td>${esc(fmtTime(c.last_at))}</td><td>${c.reasons.map(x => `<span class="pill">${esc(x)}</span>`).join(' ') || '—'}</td></tr>`).join('')}</tbody></table></div></div>
<p class="hint">次数是观测到的压缩事件条数，不等于压缩成功次数；压缩摘要正文见对应会话的回合流。</p>` : empty('没有观测到 Pi 的上下文压缩事件。')}</section>`;
  return out;
}
