/** 定时任务页的路由：GET 渲染、表单 POST 调用 ScheduleService（校验全部由服务完成，这里只把表单换成服务的输入）。 */
import type { ServerResponse } from 'node:http';
import type { ScheduleRule } from '../agent/schedule/types.js';
import { ScheduleError } from '../agent/schedule/model.js';
import type { ScheduleManagement } from './schedules.js';
import { HttpError } from './dashboard-io.js';
import { page, type Flash } from './ui/html.js';
import { log } from '../shared/log.js';
import {
  draftOf, emptyDraft, sameRule, scheduleDetailBody, schedulesDisabled, schedulesListBody, SCHEDULES_LEAD, WEEKDAYS, type ScheduleDraft,
} from './ui/schedule-pages.js';

const BJ_OFFSET_MS = 8 * 3600_000;

export interface SchedulePanelDeps {
  service?: ScheduleManagement;
  /** 面板 owner 的 QQ 号；面板身份即 owner。 */
  owner?: string;
  csrf: string;
  context: { scopes(): string[]; scopeNames?(): Record<string, string> };
  now?: () => number;
}

export const isSchedulePath = (pathname: string) => pathname === '/schedules' || pathname.startsWith('/schedules/');

export function draftFromForm(form: URLSearchParams): ScheduleDraft {
  const type = form.get('type');
  return {
    name: form.get('name') ?? '', ...(form.has('prompt') ? { prompt: form.get('prompt')! } : {}), conversation: form.get('conversation') ?? 'owner',
    type: type === 'once' || type === 'rrule' ? type : 'repeat',
    date: form.get('date') ?? '', time: form.get('time') ?? '', rrule: form.get('rrule') ?? '', timeout: (form.get('timeout') ?? '').trim(),
    days: WEEKDAYS.filter(d => form.getAll('days').includes(d)),
  };
}

/** 表单 → ScheduleRule。只做表单格式解析；规则是否有效、是否在未来由 ScheduleService 判定。 */
export function ruleFromDraft(d: ScheduleDraft, now: number): ScheduleRule {
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(d.time.trim());
  // 每天 / 每周与自定义规则的起点取当前分钟整点，避免触发时刻带上创建时的秒数。
  const dtstart = Math.floor(now / 60_000) * 60_000;
  if (d.type === 'rrule') return { kind: 'rrule', rrule: d.rrule.trim().replace(/^RRULE:/i, ''), dtstart };
  if (!time) throw new ScheduleError(400, '请填写时刻（HH:MM）');
  const [hour, minute] = [Number(time[1]), Number(time[2])];
  if (d.type === 'once') {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.date.trim());
    const at = date ? Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), hour, minute) - BJ_OFFSET_MS : NaN;
    if (!date || !Number.isFinite(at) || new Date(at + BJ_OFFSET_MS).toISOString().slice(0, 10) !== d.date.trim()) throw new ScheduleError(400, '请填写有效日期（YYYY-MM-DD）');
    return { kind: 'at', at };
  }
  const rrule = d.days.length && d.days.length < 7
    ? `FREQ=WEEKLY;BYDAY=${d.days.join(',')};BYHOUR=${hour};BYMINUTE=${minute}` : `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`;
  return { kind: 'rrule', rrule, dtstart };
}

/** 超时秒数 → options；留空不提交。非数字原样交给服务校验并报错。 */
const optionsOf = (d: ScheduleDraft) => d.timeout ? { options: { timeout_ms: Math.round(Number(d.timeout) * 1000) } } : {};

const FLASH: Record<string, string> = {
  created: '定时任务已创建。', saved: '定时任务已保存。', paused: '定时任务已暂停。', resumed: '定时任务已恢复，从现在起计算下次触发。',
  run: '已触发一次运行，结果稍后出现在运行记录中。', deleted: '定时任务已删除。',
};

export function createSchedulePanel(deps: SchedulePanelDeps) {
  const now = deps.now ?? Date.now;
  const actor = deps.owner ? `qq:${deps.owner}` : '';
  const enabled = !!deps.service && !!deps.owner;

  function names(): Record<string, string> {
    try { return deps.context.scopeNames?.() ?? {}; } catch { return {}; }
  }
  function conversations(): string[] {
    let scopes: string[] = [];
    try { scopes = deps.context.scopes(); } catch { /* 消息库不可用时只提供 owner 私聊 */ }
    // owner 私聊用专用会话 "owner"，不重复列出 private:<owner>。
    return ['owner', ...scopes.filter(s => /^(group|private):[1-9]\d*$/.test(s) && s !== `private:${deps.owner}`)];
  }

  /** GET /schedules、/schedules/new、/schedules/:id；未知 id 返回 null（404）。 */
  async function render(url: URL, nonce: string, flash?: Flash, draft?: ScheduleDraft): Promise<string | null> {
    const p = url.pathname;
    const code = url.searchParams.get('ok');
    flash ??= code && Object.hasOwn(FLASH, code) ? { text: FLASH[code]! } : undefined;
    const shell = (title: string, body: string) => page({ title, path: p, nonce, body, flash, lead: SCHEDULES_LEAD });
    if (!enabled) return p === '/schedules' || p === '/schedules/new' ? shell('定时任务', schedulesDisabled()) : null;
    const schedules = await deps.service!.list(actor);
    const view = { schedules, conversations: conversations(), names: names(), csrf: deps.csrf, now: now() };
    if (p === '/schedules' || p === '/schedules/new') return shell('定时任务', schedulesListBody(view, draft ?? emptyDraft(view.now)));
    const match = /^\/schedules\/([a-zA-Z0-9_-]+)$/.exec(p);
    const schedule = match && schedules.find(s => s.id === match[1]);
    if (!schedule) return null;
    return shell(schedule.name, scheduleDetailBody(schedule, view, draft));
  }

  /** 已通过同源与 CSRF 校验的表单 POST；成功 303 回列表或详情，失败带原输入重绘并显示服务给出的原因。 */
  async function post(form: URLSearchParams, url: URL, res: ServerResponse, nonce: string): Promise<void> {
    const p = url.pathname;
    const match = /^\/schedules\/([a-zA-Z0-9_-]+)\/(update|pause|resume|run|delete)$/.exec(p);
    const id = match?.[1], action = match?.[2] ?? (p === '/schedules' ? 'create' : '');
    const detail = id ? `/schedules/${id}` : '/schedules';
    const back = (code: string) => {
      const target = action === 'delete' || form.get('back') !== 'detail' && action !== 'update' ? '/schedules' : detail;
      res.writeHead(303, { Location: `${target}?ok=${code}` }).end();
    };
    let draft: ScheduleDraft | undefined;
    try {
      if (!enabled) throw new HttpError(404, '定时任务管理未启用');
      if (!action) throw new HttpError(404, '没有这个操作');
      const service = deps.service!;
      if (action === 'create') {
        draft = draftFromForm(form);
        await service.create(actor, { name: draft.name, prompt: draft.prompt ?? '', conversation: draft.conversation, rule: ruleFromDraft(draft, now()), ...optionsOf(draft) });
        back('created'); return;
      }
      if (action === 'update') {
        draft = draftFromForm(form);
        const current = (await service.list(actor)).find(s => s.id === id);
        if (!current) throw new ScheduleError(404, '定时任务不存在');
        draft.conversation = current.conversation;
        const patch = { name: draft.name, ...(draft.prompt !== undefined ? { prompt: draft.prompt } : {}), ...optionsOf(draft),
          ...(sameRule(draft, draftOf(current)) ? {} : { rule: ruleFromDraft(draft, now()) }) };
        await service.update(actor, id!, patch);
        back('saved'); return;
      }
      if (action === 'pause') { await service.pause(actor, id!); back('paused'); return; }
      if (action === 'resume') { await service.resume(actor, id!); back('resumed'); return; }
      if (action === 'run') { await service.runNow(actor, id!); back('run'); return; }
      await service.remove(actor, id!); back('deleted');
    } catch (error) {
      const expected = error instanceof ScheduleError || error instanceof HttpError;
      if (!expected) log.error('schedule panel action failed', { action, error });
      const message = expected ? error.message : '操作失败，详见日志';
      const status = expected ? error.status : 500;
      // 失败时留在提交所在的页面并保留输入；任务已不存在时回到列表。
      const where = action === 'create' || form.get('back') !== 'detail' && action !== 'update' || status === 404 ? '/schedules' : detail;
      const html = enabled ? await render(new URL(where, 'http://localhost'), nonce, { text: message, error: true }, where === detail || action === 'create' ? draft : undefined).catch(() => null) : null;
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html ?? page({ title: '操作未完成', path: p, nonce, flash: { text: message, error: true }, body: '<p><a href="/schedules">返回定时任务</a></p>' }));
    }
  }

  return { render, post };
}
