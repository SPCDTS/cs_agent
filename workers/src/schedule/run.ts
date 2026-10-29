import { cleanName } from "../policy";
import { SHANGHAI_OFFSET_MS } from "./model";
import type { Schedule } from "./types";

/** 入站键直接带 fire_key：ThreadDO 回写时无需额外映射就能找回任务与计划时刻。 */
export const scheduleInputKey = (fireKey: string) => `run_${fireKey}`;
export function parseScheduleInputKey(key: string): { scheduleId: string; fireAt: number; fireKey: string } | undefined {
  const match = /^run_([0-9a-f-]{36})@(\d{1,16})$/.exec(key);
  return match ? { scheduleId: match[1]!, fireAt: Number(match[2]), fireKey: `${match[1]}@${match[2]}` } : undefined;
}

const beijing = (ms: number) => new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(5, 16).replace("T", " ");
// 外壳的方括号行只能由这里生成；正文行首的 "[" 换成 "("，提示词与运行记录不能伪造 [说明] 等段落。
const neutral = (text: string) => text.replace(/^(\s*)\[/gm, "$1(");

export function scheduledInput(schedule: Schedule, fireAt: number, ordinal: number): string {
  const recent = schedule.runs.filter(run => run.fire_at !== fireAt && run.status !== "queued" && run.status !== "running").slice(-3)
    .map(run => `${beijing(run.fire_at)} ${run.status}${run.note ? " " + run.note.replace(/\s+/g, " ").slice(0, 200) : ""}`);
  return `[定时任务] ${cleanName(schedule.name)} · 计划时间 ${beijing(fireAt)}（北京时间）· 第 ${ordinal} 次 · 创建者 ${schedule.created_by}\n` +
    `${neutral(schedule.prompt)}\n[最近运行] ${neutral(recent.join("；")) || "无"}\n` +
    "[说明] 这是定时任务，不是用户消息。需要通知就调用 send_message（发回本会话，不 @ 人），不需要就直接结束。需要停止后续触发时调用 schedule_control，说明暂停或完成的原因。";
}
