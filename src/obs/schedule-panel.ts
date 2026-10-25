/** 定时任务页的路由：GET 渲染、表单 POST 调用 ScheduleService。 */
import type { ServerResponse } from 'node:http';
import { ScheduleError } from '../agent/schedule/model.js';
import type { ScheduleManagement } from './schedules.js';
import { HttpError } from './dashboard-io.js';
import { page, type Flash } from './ui/html.js';
import { log } from '../shared/log.js';
import { scheduleDetailBody, schedulesDisabled, schedulesListBody, SCHEDULES_LEAD } from './ui/schedule-pages.js';

export interface SchedulePanelDeps {
  service?: ScheduleManagement;
  /** 面板 owner 的 QQ 号；面板身份即 owner。 */
  owner?: string;
  csrf: string;
  scopeNames?: () => Record<string, string>;
  now?: () => number;
}

export const isSchedulePath = (pathname: string) => pathname === '/schedules' || pathname.startsWith('/schedules/');

const FLASH: Record<string, string> = {
  paused: '定时任务已暂停。', resumed: '定时任务已恢复，从现在起计算下次触发。',
  run: '已触发一次运行，结果稍后出现在运行记录中。', deleted: '定时任务已删除。',
};

export function createSchedulePanel(deps: SchedulePanelDeps) {
  const now = deps.now ?? Date.now;
  const actor = deps.owner ? `qq:${deps.owner}` : '';
  const enabled = !!deps.service && !!deps.owner;

  function names(): Record<string, string> {
    try { return deps.scopeNames?.() ?? {}; } catch { return {}; }
  }

  /** GET /schedules、/schedules/:id；未知 id 返回 null（404）。 */
  async function render(url: URL, nonce: string, flash?: Flash): Promise<string | null> {
    const p = url.pathname;
    const code = url.searchParams.get('ok');
    flash ??= code && Object.hasOwn(FLASH, code) ? { text: FLASH[code]! } : undefined;
    const shell = (title: string, body: string) => page({ title, path: p, nonce, body, flash, lead: SCHEDULES_LEAD });
    if (!enabled) return p === '/schedules' ? shell('定时任务', schedulesDisabled()) : null;
    const schedules = await deps.service!.list(actor);
    const view = { schedules, names: names(), csrf: deps.csrf, now: now() };
    if (p === '/schedules') return shell('定时任务', schedulesListBody(view));
    const match = /^\/schedules\/([a-zA-Z0-9_-]+)$/.exec(p);
    const schedule = match && schedules.find(s => s.id === match[1]);
    if (!schedule) return null;
    return shell(schedule.name, scheduleDetailBody(schedule, view));
  }

  /** 已通过同源与 CSRF 校验的表单 POST；成功 303 回列表或详情，失败显示服务给出的原因。 */
  async function post(form: URLSearchParams, url: URL, res: ServerResponse, nonce: string): Promise<void> {
    const p = url.pathname;
    const match = /^\/schedules\/([a-zA-Z0-9_-]+)\/(pause|resume|run|delete)$/.exec(p);
    const id = match?.[1], action = match?.[2];
    const back = (code: string) => {
      const target = action === 'delete' || form.get('back') !== 'detail' ? '/schedules' : `/schedules/${id}`;
      res.writeHead(303, { Location: `${target}?ok=${code}` }).end();
    };
    try {
      if (!enabled) throw new HttpError(404, '定时任务管理未启用');
      if (!action) throw new HttpError(404, '没有这个操作');
      const service = deps.service!;
      if (action === 'pause') { await service.pause(actor, id!); back('paused'); return; }
      if (action === 'resume') { await service.resume(actor, id!); back('resumed'); return; }
      if (action === 'run') { await service.runNow(actor, id!); back('run'); return; }
      await service.remove(actor, id!); back('deleted');
    } catch (error) {
      const expected = error instanceof ScheduleError || error instanceof HttpError;
      if (!expected) log.error('schedule panel action failed', { action, error });
      const message = expected ? error.message : '操作失败，详见日志';
      const status = expected ? error.status : 500;
      // 失败时回到操作所在的页面；任务已不存在时回到列表。
      const where = form.get('back') !== 'detail' || status === 404 ? '/schedules' : `/schedules/${id}`;
      const html = enabled ? await render(new URL(where, 'http://localhost'), nonce, { text: message, error: true }).catch(() => null) : null;
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(html ?? page({ title: '操作未完成', path: p, nonce, flash: { text: message, error: true }, body: '<p><a href="/schedules">返回定时任务</a></p>' }));
    }
  }

  return { render, post };
}
