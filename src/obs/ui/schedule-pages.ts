/** 定时任务页（docs/ARCHITECTURE.md §6）：纯渲染；数据与写操作由 obs/schedule-panel.ts 提供。时间一律按北京时间显示。 */
import { scopeLabel } from '../../context/access.js';
import { crumbs } from './agents-pages.js';
import { csrfField, empty, esc, fmtMs, kv, stamp, uri, type Tone } from './html.js';

/* 页面只读视图：与 agent/schedule/types.ts 的 Schedule 结构一致（UI 层不依赖 agent 模块，见架构测试）。 */
export type ScheduleRule = { kind: 'rrule'; rrule: string; dtstart: number } | { kind: 'at'; at: number };
export interface ScheduleRun {
  fire_key: string; fire_at: number; status: 'queued' | 'running' | 'sent' | 'silent' | 'failed' | 'skipped';
  reason?: 'stale' | 'overlap' | 'interrupted' | 'paused' | 'revision' | 'timeout' | 'backend_failed';
  skipped_count?: number; started_at?: number; ended_at?: number; sent?: number; note?: string; input_key?: string;
}
export interface Schedule {
  id: string; revision: number; name: string; prompt: string; conversation: string; rule: ScheduleRule;
  status: 'active' | 'paused' | 'completed'; pause_reason?: string; options: { stale_after_ms: number; timeout_ms: number };
  created_by: string; created_at: number; updated_at: number; next_fire_at: number | null; failures: number; runs: ScheduleRun[];
}

const BJ_OFFSET_MS = 8 * 3600_000;
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
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
export interface SchedulePanelView {
  schedules: Schedule[];
  names: Record<string, string>;
  csrf: string; now: number;
}

const back = (where: 'list' | 'detail') => `<input type="hidden" name="back" value="${where}">`;
function ops(s: Schedule, csrf: string, where: 'list' | 'detail'): string {
  const form = (action: string, label: string, cls = 'quiet') =>
    `<form method="post" action="/schedules/${uri(s.id)}/${action}">${csrfField(csrf)}${back(where)}<button class="${cls}">${label}</button></form>`;
  return `<div class="ops">${form('run', '立即运行')}${s.status === 'active' ? form('pause', '暂停') : s.status === 'paused' ? form('resume', '恢复') : ''}<details class="gate"><summary>删除</summary><div class="gate-pop">确认删除「${esc(s.name)}」？运行记录一并删除，不可恢复。<form method="post" action="/schedules/${uri(s.id)}/delete">${csrfField(csrf)}${back('list')}<button class="danger">确认删除</button></form></div></details></div>`;
}

const lastRun = (s: Schedule, now: number) => {
  const r = s.runs.at(-1);
  return r ? `${runPill(r)} <small class="muted" title="${esc(fmtBeijing(r.fire_at))}">${esc(fmtBeijingShort(r.fire_at, now))}</small>` : '<span class="faint">—</span>';
};
const ORDER: Record<Schedule['status'], number> = { active: 0, paused: 1, completed: 2 };
const byStatus = (a: Schedule, b: Schedule) => ORDER[a.status] - ORDER[b.status] ||
  (a.status === 'active' ? (a.next_fire_at ?? Infinity) - (b.next_fire_at ?? Infinity) : b.updated_at - a.updated_at);

export function schedulesListBody(v: SchedulePanelView): string {
  const count = (status: Schedule['status']) => v.schedules.filter(s => s.status === status).length;
  const fig = (label: string, n: number, tone: string) => `<div class="sheet pad"><div class="muted">${label}</div><div class="figure${n && tone ? ' ' + tone : ''}">${n}<small class="muted"> 条</small></div></div>`;
  let out = `<section><div class="grid cols-3">${fig('运行中', count('active'), 's-ok')}${fig('已暂停', count('paused'), 's-warn')}${fig('已结束', count('completed'), '')}</div></section>`;
  const rows = [...v.schedules].sort(byStatus).map(s => `<tr><td><a href="/schedules/${uri(s.id)}">${esc(s.name)}</a></td><td>${conversationLabel(s.conversation, v.names)}</td><td>${
    s.rule.kind === 'rrule' && describeRule(s.rule, v.now) === s.rule.rrule ? `<code>${esc(s.rule.rrule)}</code>` : esc(describeRule(s.rule, v.now))}</td><td>${
    s.next_fire_at === null ? '<span class="faint">—</span>' : `<span title="${esc(fmtBeijing(s.next_fire_at))}">${esc(fmtBeijingShort(s.next_fire_at, v.now))}</span>`}</td><td>${statusPill(s)}</td><td>${lastRun(s, v.now)}</td><td class="num">${
    s.failures ? `<span class="s-fail">${s.failures}</span>` : '0'}</td><td>${ops(s, v.csrf, 'list')}</td></tr>`).join('');
  out += `<section><h2>全部任务 <small>${v.schedules.length ? `${v.schedules.length} 条 · 时间均为北京时间` : ''}</small></h2>${v.schedules.length
    ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>名称</th><th>会话</th><th>规则</th><th>下次触发</th><th>状态</th><th>最近运行</th><th class="num">连续失败</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
    : empty('还没有定时任务。在聊天里让 agent 创建。')}</section>`;
  return out;
}

export function scheduleDetailBody(s: Schedule, v: Omit<SchedulePanelView, 'schedules'>): string {
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
      r.input_key ? ` <a class="mono" href="/inputs/${uri(r.input_key)}">${esc(r.input_key.slice(0, 16))}</a>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`
    : empty('还没有运行过。')}</section>`;
  return out;
}

export const SCHEDULES_LEAD = '到点在对应会话线程里运行一轮 agent，回复须经 send_message 发出。连续失败 3 次自动暂停。';
export const schedulesDisabled = () => empty('定时任务管理未启用（需要配置 owner 并接入定时任务服务）。');
