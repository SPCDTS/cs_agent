/** 定时任务页（DESIGN-scheduled-tasks 第 8 步）：纯渲染；数据与写操作由 obs/schedule-panel.ts 提供。时间一律按北京时间显示。 */
import { redactText } from '../../shared/redact.js';
import { scopeLabel } from '../../context/access.js';
import { crumbs } from './agents-pages.js';
import { csrfField, empty, esc, fmtMs, kv, stamp, uri, type Tone } from './html.js';

/* 页面只读视图：与 agent/schedule/types.ts 的 Schedule 结构一致（UI 层不依赖 agent 模块，见架构测试）。 */
export type ScheduleRule = { kind: 'rrule'; rrule: string; dtstart: number } | { kind: 'at'; at: number };
export interface ScheduleRun {
  fire_key: string; fire_at: number; status: 'queued' | 'running' | 'sent' | 'silent' | 'failed' | 'skipped';
  reason?: 'stale' | 'overlap' | 'interrupted' | 'paused' | 'revision' | 'timeout' | 'backend_failed';
  skipped_count?: number; started_at?: number; ended_at?: number; sent?: number; note?: string; ticket?: string;
}
export interface Schedule {
  id: string; revision: number; name: string; prompt: string; conversation: string; rule: ScheduleRule;
  status: 'active' | 'paused' | 'completed'; pause_reason?: string; options: { stale_after_ms: number; timeout_ms: number };
  created_by: string; created_at: number; updated_at: number; next_fire_at: number | null; failures: number; runs: ScheduleRun[];
}

const BJ_OFFSET_MS = 8 * 3600_000;
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日'];

/** 北京墙钟 ISO 片段：YYYY-MM-DDTHH:MM。 */
const bjIso = (ms: number) => new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 16);
/** 2026-10-21 14:00（北京时间）。 */
export const fmtBeijing = (ms: number) => bjIso(ms).replace('T', ' ');
/** 同年省略年份：10-21 14:00。 */
export const fmtBeijingShort = (ms: number, now = Date.now()) =>
  bjIso(ms).slice(0, 4) === bjIso(now).slice(0, 4) ? bjIso(ms).slice(5).replace('T', ' ') : fmtBeijing(ms);
const pad = (n: number) => String(n).padStart(2, '0');

/** 可用"每天 / 每周 + 时刻"表达的 RRULE；其他写法返回 null。days 为空表示每天。 */
export function simpleRule(rrule: string): { days: string[]; hour: number; minute: number } | null {
  const parts = rrule.split(';').map(p => p.split('='));
  if (parts.some(p => p.length !== 2)) return null;
  const v = Object.fromEntries(parts) as Record<string, string>;
  if (Object.keys(v).length !== parts.length) return null;
  if (Object.keys(v).some(k => !['FREQ', 'BYHOUR', 'BYMINUTE', 'BYDAY', 'INTERVAL', 'BYSECOND', 'WKST'].includes(k))) return null;
  if (v.INTERVAL !== undefined && v.INTERVAL !== '1' || v.BYSECOND !== undefined && v.BYSECOND !== '0') return null;
  if (!/^\d{1,2}$/.test(v.BYHOUR ?? '') || !/^\d{1,2}$/.test(v.BYMINUTE ?? '')) return null;
  const hour = Number(v.BYHOUR), minute = Number(v.BYMINUTE);
  if (hour > 23 || minute > 59) return null;
  const days = v.BYDAY === undefined ? [] : v.BYDAY.split(',');
  if (days.some(d => !(WEEKDAYS as readonly string[]).includes(d)) || new Set(days).size !== days.length) return null;
  if (v.FREQ === 'WEEKLY' ? !days.length : v.FREQ !== 'DAILY') return null;
  const sorted = WEEKDAYS.filter(d => days.includes(d));
  return { days: sorted.length === 7 ? [] : sorted, hour, minute };
}

/** 人话描述：每天 08:30 / 每周一、三 09:00 / 一次 10-21 14:00 / 每 30 分钟；无法概括时返回 RRULE 原文。 */
export function describeRule(rule: ScheduleRule, now = Date.now()): string {
  if (rule.kind === 'at') return `一次 ${fmtBeijingShort(rule.at, now)}`;
  const simple = simpleRule(rule.rrule);
  if (simple) {
    const at = `${pad(simple.hour)}:${pad(simple.minute)}`, d = simple.days.join(',');
    if (!d) return `每天 ${at}`;
    if (d === 'MO,TU,WE,TH,FR') return `工作日 ${at}`;
    if (d === 'SA,SU') return `周末 ${at}`;
    return `每周${simple.days.map(x => WEEKDAY_CN[WEEKDAYS.indexOf(x as typeof WEEKDAYS[number])]).join('、')} ${at}`;
  }
  const every = /^FREQ=(MINUTELY|HOURLY)(?:;INTERVAL=([1-9]\d*))?$/.exec(rule.rrule);
  if (every) {
    const n = Number(every[2] ?? 1);
    return every[1] === 'MINUTELY' ? `每 ${n} 分钟` : n === 1 ? '每小时' : `每 ${n} 小时`;
  }
  return rule.rrule;
}

/** 表单状态：创建、编辑与校验失败回显共用；字段均为原始字符串。 */
export interface ScheduleDraft {
  name: string; prompt?: string; conversation: string;
  type: 'once' | 'repeat' | 'rrule'; date: string; time: string; days: string[]; rrule: string;
  /** 超时秒数；空表示沿用 / 默认 */
  timeout: string;
}

export function emptyDraft(now = Date.now()): ScheduleDraft {
  const next = bjIso(now + 3600_000);
  return { name: '', prompt: '', conversation: 'owner', type: 'repeat', date: next.slice(0, 10), time: '09:00', days: [], rrule: '', timeout: '' };
}

/** 把已有任务展开成表单状态，用于编辑页预填与"规则是否改动"的比较。 */
export function draftOf(s: Schedule): ScheduleDraft {
  const base = { name: s.name, prompt: s.prompt, conversation: s.conversation, timeout: String(Math.round(s.options.timeout_ms / 1000)),
    date: '', time: '', days: [] as string[], rrule: '' };
  if (s.rule.kind === 'at') { const iso = bjIso(s.rule.at); return { ...base, type: 'once', date: iso.slice(0, 10), time: iso.slice(11, 16) }; }
  const simple = simpleRule(s.rule.rrule);
  if (simple) return { ...base, type: 'repeat', time: `${pad(simple.hour)}:${pad(simple.minute)}`, days: simple.days };
  return { ...base, type: 'rrule', rrule: s.rule.rrule };
}

/** 两份表单状态是否描述同一条规则（编辑时未改规则就不提交 rule，保留原 dtstart）。 */
export function sameRule(a: ScheduleDraft, b: ScheduleDraft): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'once') return a.date === b.date && a.time === b.time;
  if (a.type === 'repeat') return a.time === b.time && a.days.join(',') === b.days.join(',');
  return a.rrule.trim() === b.rrule.trim();
}

const STATUS: Record<Schedule['status'], [string, Tone]> = { active: ['运行中', 'ok'], paused: ['已暂停', 'warn'], completed: ['已结束', 'idle'] };
const RUN_STATUS: Record<ScheduleRun['status'], [string, Tone]> = {
  queued: ['排队', 'queue'], running: ['执行中', 'run'], sent: ['已发送', 'ok'], silent: ['未发送', 'idle'], failed: ['失败', 'fail'], skipped: ['跳过', 'warn'],
};
const REASONS: Record<NonNullable<ScheduleRun['reason']>, string> = {
  stale: '迟到或停机', overlap: '上一轮未完成', interrupted: '运行中断', paused: '已暂停', revision: '任务已修改', timeout: '超时', backend_failed: '后端失败',
};
export const statusPill = (s: Pick<Schedule, 'status' | 'pause_reason'>) => {
  const [label, tone] = STATUS[s.status] ?? [s.status, 'idle' as Tone];
  return stamp(label, tone) + (s.status === 'paused' && s.pause_reason ? ` <small class="muted">${esc(s.pause_reason)}</small>` : '');
};
const runPill = (r: ScheduleRun) => { const [label, tone] = RUN_STATUS[r.status] ?? [r.status, 'idle' as Tone]; return stamp(label, tone); };
const reasonText = (r: ScheduleRun) => r.reason ? (REASONS[r.reason] ?? r.reason) + (r.skipped_count && r.skipped_count > 1 ? `（合并 ${r.skipped_count} 次）` : '') : '';

/** 会话显示：群名（已知时）+ 会话键。 */
export function conversationLabel(conversation: string, names: Record<string, string>): string {
  const name = names[conversation];
  if (conversation === 'owner') return 'owner 私聊';
  return name ? `${esc(name)} <small class="faint mono">${esc(conversation)}</small>` : esc(scopeLabel(conversation));
}
const conversationText = (conversation: string, names: Record<string, string>) =>
  conversation === 'owner' ? 'owner 私聊' : names[conversation] ? `${names[conversation]}（${conversation}）` : scopeLabel(conversation);

export interface SchedulePanelView {
  schedules: Schedule[];
  /** 会话下拉的候选（owner 与已知会话域）与群名 */
  conversations: string[]; names: Record<string, string>;
  csrf: string; now: number;
}

const back = (where: 'list' | 'detail') => `<input type="hidden" name="back" value="${where}">`;
function ops(s: Schedule, csrf: string, where: 'list' | 'detail'): string {
  const form = (action: string, label: string, cls = 'quiet') =>
    `<form method="post" action="/schedules/${uri(s.id)}/${action}">${csrfField(csrf)}${back(where)}<button class="${cls}">${label}</button></form>`;
  return `<div class="ops">${form('run', '立即运行')}${s.status === 'active' ? form('pause', '暂停') : s.status === 'paused' ? form('resume', '恢复') : ''}${
    where === 'list' ? `<a class="btn quiet" href="/schedules/${uri(s.id)}">编辑</a>` : ''}<details class="gate"><summary>删除</summary><div class="gate-pop">确认删除「${esc(s.name)}」？运行记录一并删除，不可恢复。<form method="post" action="/schedules/${uri(s.id)}/delete">${csrfField(csrf)}${back('list')}<button class="danger">确认删除</button></form></div></details></div>`;
}

const lastRun = (s: Schedule, now: number) => {
  const r = s.runs.at(-1);
  return r ? `${runPill(r)} <small class="muted" title="${esc(fmtBeijing(r.fire_at))}">${esc(fmtBeijingShort(r.fire_at, now))}</small>` : '<span class="faint">—</span>';
};
const ORDER: Record<Schedule['status'], number> = { active: 0, paused: 1, completed: 2 };
const byStatus = (a: Schedule, b: Schedule) => ORDER[a.status] - ORDER[b.status] ||
  (a.status === 'active' ? (a.next_fire_at ?? Infinity) - (b.next_fire_at ?? Infinity) : b.updated_at - a.updated_at);

export function schedulesListBody(v: SchedulePanelView, draft: ScheduleDraft = emptyDraft(v.now)): string {
  const count = (status: Schedule['status']) => v.schedules.filter(s => s.status === status).length;
  const fig = (label: string, n: number, tone: string) => `<div class="sheet pad"><div class="muted">${label}</div><div class="figure${n && tone ? ' ' + tone : ''}">${n}<small class="muted"> 条</small></div></div>`;
  let out = `<section><div class="grid cols-3">${fig('运行中', count('active'), 's-ok')}${fig('已暂停', count('paused'), 's-warn')}${fig('已结束', count('completed'), '')}</div></section>`;
  const rows = [...v.schedules].sort(byStatus).map(s => `<tr><td><a href="/schedules/${uri(s.id)}">${esc(s.name)}</a></td><td>${conversationLabel(s.conversation, v.names)}</td><td>${
    s.rule.kind === 'rrule' && describeRule(s.rule, v.now) === s.rule.rrule ? `<code>${esc(s.rule.rrule)}</code>` : esc(describeRule(s.rule, v.now))}</td><td>${
    s.next_fire_at === null ? '<span class="faint">—</span>' : `<span title="${esc(fmtBeijing(s.next_fire_at))}">${esc(fmtBeijingShort(s.next_fire_at, v.now))}</span>`}</td><td>${statusPill(s)}</td><td>${lastRun(s, v.now)}</td><td class="num">${
    s.failures ? `<span class="s-fail">${s.failures}</span>` : '0'}</td><td>${ops(s, v.csrf, 'list')}</td></tr>`).join('');
  out += `<section><h2>全部任务 <small>${v.schedules.length ? `${v.schedules.length} 条 · 时间均为北京时间` : ''}</small></h2>${v.schedules.length
    ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>名称</th><th>会话</th><th>规则</th><th>下次触发</th><th>状态</th><th>最近运行</th><th class="num">连续失败</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
    : empty('还没有定时任务。在下方新建一条，或在 owner 私聊里让 agent 创建。')}</section>`;
  out += `<section id="new"><h2>新建定时任务</h2>${scheduleForm({ action: '/schedules', draft, csrf: v.csrf, conversations: v.conversations, names: v.names, submit: '创建' })}</section>`;
  return out;
}

export function scheduleDetailBody(s: Schedule, v: Omit<SchedulePanelView, 'schedules' | 'conversations'>, draft: ScheduleDraft = draftOf(s)): string {
  let out = crumbs([['定时任务', '/schedules'], [s.name]]);
  const rule = s.rule.kind === 'at' ? esc(describeRule(s.rule, v.now))
    : `${esc(describeRule(s.rule, v.now))}<br><code>${esc(s.rule.rrule)}</code> <small class="muted">起点 ${esc(fmtBeijing(s.rule.dtstart))}</small>`;
  out += `<section class="flush sheet pad">${kv([
    ['状态', statusPill(s)],
    ['会话', conversationLabel(s.conversation, v.names)],
    ['规则', rule],
    ['下次触发', s.next_fire_at === null ? '—' : esc(fmtBeijing(s.next_fire_at))],
    ['超时', esc(fmtMs(s.options.timeout_ms))],
    ['迟到跳过阈值', esc(fmtMs(s.options.stale_after_ms))],
    ['连续失败', String(s.failures)],
    ['创建者', `<span class="mono">${esc(s.created_by)}</span>`],
    ['创建 / 修改', `${esc(fmtBeijing(s.created_at))} / ${esc(fmtBeijing(s.updated_at))} <small class="muted">修订 ${s.revision}</small>`],
    ['ID', `<code>${esc(s.id)}</code>`],
  ])}<div class="mt">${ops(s, v.csrf, 'detail')}</div></section>`;
  out += `<section><h2>提示词</h2><pre class="mono wrap">${esc(s.prompt)}</pre></section>`;
  const runs = [...s.runs].reverse();
  out += `<section><h2>运行记录 <small>最近 ${runs.length} 次，新的在上</small></h2>${runs.length
    ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>触发时间</th><th>状态</th><th>原因</th><th class="num">发出条数</th><th>耗时</th><th>记录</th></tr></thead><tbody>${runs.map(r => `<tr><td title="${esc(r.fire_key)}">${esc(fmtBeijing(r.fire_at))}</td><td>${runPill(r)}</td><td>${esc(reasonText(r)) || '<span class="faint">—</span>'}</td><td class="num">${r.sent ?? '—'}</td><td>${
      r.started_at && r.ended_at ? esc(fmtMs(r.ended_at - r.started_at)) : '<span class="faint">—</span>'}</td><td>${r.note ? `<span class="excerpt">${esc(r.note)}</span>` : '<span class="faint">—</span>'}${
      r.ticket ? ` <a class="mono" href="/tickets/${uri(r.ticket)}">${esc(r.ticket.slice(0, 16))}</a>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`
    : empty('还没有运行过。')}</section>`;
  out += `<section id="edit"><h2>编辑</h2>${scheduleForm({ action: `/schedules/${uri(s.id)}/update`, draft, csrf: v.csrf, names: v.names, submit: '保存修改', fixedConversation: s.conversation })}
<p class="hint">会话创建后不可修改。修改规则会从现在起重新计算下次触发；已暂停的任务保存后仍保持暂停。</p></section>`;
  return out;
}

interface FormOptions {
  action: string; draft: ScheduleDraft; csrf: string; names: Record<string, string>; submit: string;
  conversations?: string[]; fixedConversation?: string;
}

function scheduleForm(o: FormOptions): string {
  const d = o.draft;
  const radio = (value: ScheduleDraft['type'], label: string, note: string) =>
    `<label class="choice"><input type="radio" name="type" value="${value}"${d.type === value ? ' checked' : ''}><span>${label}<small>${note}</small></span></label>`;
  const conversation = o.fixedConversation !== undefined
    ? `<label>会话<input value="${esc(conversationText(o.fixedConversation, o.names))}" disabled></label>`
    : `<label>会话<select name="conversation">${[...new Set([...(o.conversations ?? ['owner']), ...(d.conversation ? [d.conversation] : [])])].map(c =>
      `<option value="${esc(c)}"${c === d.conversation ? ' selected' : ''}>${esc(conversationText(c, o.names))}</option>`).join('')}</select></label>`;
  // 提示词含凭据样式内容时不可在面板编辑（脱敏后回填会破坏原文），保存时不提交该字段。
  const prompt = d.prompt === undefined || redactText(d.prompt, 1_000_000) !== d.prompt
    ? `<div class="flash err">提示词包含凭据样式的内容，面板不显示原文也不修改它。</div>`
    : `<label>提示词（到点时交给 agent 的任务说明）<textarea name="prompt" rows="6" maxlength="8000" required>${esc(d.prompt)}</textarea></label>`;
  return `<form method="post" action="${o.action}" class="sheet pad sch-form">${csrfField(o.csrf)}
<label>名称<input name="name" value="${esc(d.name)}" maxlength="64" required></label>
${prompt}
${conversation}
<fieldset><legend>触发方式（北京时间）</legend><div class="choices">${radio('once', '一次性', '指定日期与时刻触发一次')}${radio('repeat', '每天 / 每周', '不勾选星期即每天')}${radio('rrule', '自定义 RRULE', '高级：RRULE 正文')}</div>
<div class="sch-once"><label>日期<input type="date" name="date" value="${esc(d.date)}"></label></div>
<div class="sch-repeat"><div class="choices">${WEEKDAYS.map((day, i) => `<label class="choice"><input type="checkbox" name="days" value="${day}"${d.days.includes(day) ? ' checked' : ''}><span>周${WEEKDAY_CN[i]}</span></label>`).join('')}</div></div>
<div class="sch-time"><label>时刻<input type="time" name="time" value="${esc(d.time)}"></label></div>
<div class="sch-rrule"><label>RRULE（不含 DTSTART，例如 FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0）<input name="rrule" value="${esc(d.rrule)}" spellcheck="false" class="mono"></label></div></fieldset>
<label>超时（秒，留空为默认 300，最长 900）<input type="number" name="timeout" min="1" max="900" step="1" value="${esc(d.timeout)}"></label>
<p class="mt"><button>${esc(o.submit)}</button></p></form>`;
}

export const SCHEDULES_LEAD = '到点在对应会话线程里运行一轮 agent，回复须经 send_message 发出。连续失败 3 次自动暂停。';
export const schedulesDisabled = () => empty('定时任务管理未启用（需要配置 owner 并接入定时任务服务）。');
