import type { Channel } from '../channel/types.js';
import type { Trace } from '../shared/trace.js';
import { log } from '../shared/log.js';
/**
 * 静态开关关闭时不订阅、不发送；函数开关（运行时设置）每次发送前现读，关闭期间不发送也不计入限频。
 * 所有告警共用 30 分钟限频，内容不含原文或服务端错误。
 * 发送熔断通知（send_breaker）是发送规则的一部分：每次熔断恰好发一条，不受运行时开关与限频约束。
 */
export function startAlerts(opts: { enabled: boolean | (() => boolean); owner?: string; bridge: Pick<Channel, 'status' | 'sendOps'>; trace: Trace; now?: () => number }) {
  if (opts.enabled === false || !opts.owner) return { stop() {} };
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
  const now = opts.now ?? Date.now;
  let downAt: number | undefined;
  let last = -Infinity;
  let failed = 0;
  const terminal = new Map<string, number>();
  const send = (reason: string) => {
    if (!enabled() || now() - last < 30 * 60_000) return;
    last = now();
    void opts.bridge.sendOps('private', opts.owner!, 'cs-agent 告警：' + reason).catch(() => log.warn('owner alert delivery failed'));
  };
  const off = opts.trace.subscribe(e => {
    const d = JSON.parse(e.detail_json);
    if (e.stage === 'send_breaker') {
      const minutes = Math.round((Number(d.until) - Number(d.tripped_at)) / 60_000);
      const who = d.scope === 'global' ? '全部会话' : `会话 ${d.scope}`;
      void opts.bridge.sendOps('private', opts.owner!, `cs-agent 告警：${who}发送熔断（${d.reason}），暂停 ${minutes} 分钟；可在面板设置页解除。`)
        .catch(() => log.warn('owner breaker alert delivery failed'));
    }
    if (e.stage === 'schedule_paused') send('定时任务连续三次失败，已自动暂停，请打开观测面板排查。');
    if (e.status === 'failed' && /codex|pi|model_turn|model_error|tool:/.test(e.stage) && d.failure?.kind === 'auth')
      send('模型鉴权失败，请检查凭据。');
    if (d.terminal === true) {
      for (const [ticket, ts] of terminal) if (now() - ts > 86400_000) terminal.delete(ticket);
      if (terminal.has(e.ticket)) return;
      terminal.set(e.ticket, now());
      if (terminal.size > 10000) terminal.delete(terminal.keys().next().value!);
      failed = e.stage === 'failed' || e.stage === 'fallback' ? failed + 1 : 0;
      if (failed >= 3) send('连续三条票据失败，请打开观测面板排查。');
    }
  });
  const check = () => {
    if (opts.bridge.status().ws_connected) downAt = undefined;
    else { downAt ??= now(); if (now() - downAt > 5 * 60_000) send('QQ WebSocket 已离线超过五分钟。'); }
  };
  check();
  const timer = setInterval(check, 10_000); timer.unref();
  return { stop() { clearInterval(timer); off(); } };
}
