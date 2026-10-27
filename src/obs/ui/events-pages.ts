import { csrfField, empty, esc, fmtTime, kv, stamp, uri } from "./html.js";

/** 事件页只读取视图契约，来源实现留在 agent 层。 */
export interface EventsView {
  sources: { id: string; enabled: boolean; cursor: string | null; held: unknown[]; settings: { enabled: boolean; budgetPerHour: number };
    stats: { lastPollAt: number | null; lastPollStatus: string | null; consecutivePollFailures: number; consecutiveTurnFailures: number;
      pausedReason?: string; blockedReason?: string; degraded: boolean; deliveredInHour: number } }[];
  runs: { key: string; source: string; deliveredAt: number; events: unknown[]; extraCount: number; result?: { status: string } }[];
}
export function eventsBody(view: EventsView, csrf: string): string {
  const cards = view.sources.map(source => {
    const s = source.stats, paused = !source.enabled || !source.settings.enabled || !!s.pausedReason;
    const state = paused ? stamp("暂停", "warn") : s.blockedReason ? stamp("后端阻塞", "warn") : s.degraded ? stamp("轮询降级", "fail") : stamp("启用", "ok");
    const button = (action: string, text: string) => `<form method="post" action="/events/${uri(source.id)}/${action}">${csrfField(csrf)}<button>${text}</button></form>`;
    return `<section class="sheet pad"><h2>${esc(source.id)} ${state}</h2>${kv([
      ["游标", esc(source.cursor ?? "尚未初始化")], ["上次轮询", s.lastPollAt === null ? "尚未轮询" : esc(fmtTime(s.lastPollAt)) + " · " + esc(s.lastPollStatus ?? "")],
      ["连续轮询失败 / 回合失败", `${s.consecutivePollFailures} / ${s.consecutiveTurnFailures}`],
      ["本小时预算", `${s.deliveredInHour} / ${source.settings.budgetPerHour}`], ["积压", String(source.held.length)],
      ["暂停原因", esc(s.pausedReason ?? "无")],
      ["阻塞原因", esc(s.blockedReason ?? "无")],
    ])}<div class="ops">${paused ? button("resume", "恢复") : button("pause", "暂停")}${!paused ? button("poll", "立即轮询") : ""}</div></section>`;
  }).join("");
  const rows = view.runs.map(run => `<tr><td>${esc(fmtTime(run.deliveredAt))}</td><td>${esc(run.source)}</td><td>${run.events.length + run.extraCount}</td><td>${esc(run.result?.status ?? "排队 / 处理中")}</td><td class="mono">${esc(run.key)}</td></tr>`).join("");
  return (cards || empty("未启用事件来源。配置 EVENTS_GMAIL_URL 与 owner 后重启服务。")) + `<section class="sheet pad"><h2>最近事件</h2>${rows ? `<table><thead><tr><th>时间</th><th>来源</th><th>件数</th><th>结果</th><th>入站键</th></tr></thead><tbody>${rows}</tbody></table>` : empty("尚无事件输入。")}</section>`;
}
