import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { SHANGHAI_OFFSET_MS } from "./model.js";
import type { ScheduleRule } from "./types.js";

const TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$";
const time = Type.String({ pattern: TIME_PATTERN, description: "北京时间，严格使用 YYYY-MM-DD HH:mm" });
const name = Type.String({ minLength: 1, maxLength: 64 });
const prompt = Type.String({ minLength: 1, maxLength: 8000 });
const id = Type.String({ minLength: 1, maxLength: 128 });
const rule = Type.Union([
  Type.Object({ rrule: Type.String({ minLength: 1, maxLength: 2000 }), start: Type.Optional(time) }, { additionalProperties: false }),
  Type.Object({ at: time }, { additionalProperties: false }),
]);
const byId = Type.Object({ id }, { additionalProperties: false });
export const scheduleParameters = {
  schedule_create: Type.Object({ name, prompt, rule }, { additionalProperties: false }),
  schedule_list: Type.Object({}, { additionalProperties: false }),
  schedule_update: Type.Object({ id, name: Type.Optional(name), prompt: Type.Optional(prompt), rule: Type.Optional(rule) }, { additionalProperties: false }),
  schedule_pause: byId, schedule_resume: byId, schedule_delete: byId, schedule_run_now: byId,
  schedule_control: Type.Object({
    action: Type.Union([Type.Literal("pause"), Type.Literal("complete")]),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
};
const promptInstruction = "prompt 必须明确每次执行什么、通知谁以及如何通知。目的地如“家庭群”须先用 qq_chats 解析，将具体 ref 写入 prompt，例如“发到 qq:group:123（家庭群）”。监控任务若用户要求无更新不通知，写明“无新内容则静默（silent if nothing new）”。";
export const scheduleDescriptions = {
  schedule_create: "在当前来源会话创建定时任务，创建者为本回合发言人。rule 使用北京时间；rrule 是 RRULE 正文，start 省略为现在；at 为未来的一次性时刻。" + promptInstruction,
  schedule_list: "列出可见定时任务的 id、状态与下次北京时间；owner 看全部，其他人只看自己创建的任务。",
  schedule_update: "按 id 修改名称、prompt 或整个 rule；来源会话与创建者不可修改。只能管理有权操作的任务。" + promptInstruction,
  schedule_pause: "按 id 暂停定时任务，不中断正在执行的回合。",
  schedule_resume: "按 id 恢复定时任务，从现在重新计算下次北京时间，不补跑错过的触发。",
  schedule_delete: "按 id 删除定时任务。",
  schedule_run_now: "按 id 立即触发一次，不改变下次计划时间；返回本次运行状态。",
  schedule_control: "仅定时运行可用：暂停（pause）或完成（complete）本次运行所属的任务，并说明 reason。完成后停止后续触发，不中断当前回合；不能指定其他任务。",
};

const timeInput = z.string().regex(new RegExp(TIME_PATTERN));
const ruleInput = z.union([
  z.object({ rrule: z.string().min(1).max(2000), start: timeInput.optional() }).strict(),
  z.object({ at: timeInput }).strict(),
]);
const fields = { name: z.string().trim().min(1).max(64), prompt: z.string().trim().min(1).max(8000), rule: ruleInput };
const idInput = z.string().min(1).max(128);
export const scheduleInputs = {
  create: z.object(fields).strict(),
  update: z.object({ id: idInput, name: fields.name.optional(), prompt: fields.prompt.optional(), rule: ruleInput.optional() }).strict(),
  id: z.object({ id: idInput }).strict(),
  list: z.object({}).strict(),
  control: z.object({ action: z.enum(["pause", "complete"]), reason: z.string().trim().min(1).max(500) }).strict(),
};

/** 用 UTC 字段校验墙钟日期再减八小时；拒绝 Date 自动归一化的 2 月 30 日等输入。 */
export function parseBeijingTime(value: string): number {
  if (!new RegExp(TIME_PATTERN).test(value)) throw new Error("时间必须是北京时间 YYYY-MM-DD HH:mm");
  const wall = Date.parse(value.replace(" ", "T") + ":00.000Z");
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16).replace("T", " ") !== value ||
      Number(value.slice(0, 4)) < 1970 || Number(value.slice(0, 4)) > 9998) throw new Error("北京时间日期或时分无效");
  return wall - SHANGHAI_OFFSET_MS;
}

export function parseToolRule(input: z.infer<typeof ruleInput>, now: number): ScheduleRule {
  return "at" in input ? { kind: "at", at: parseBeijingTime(input.at) }
    : { kind: "rrule", rrule: input.rrule, dtstart: input.start === undefined ? now : parseBeijingTime(input.start) };
}

export function formatBeijingTime(ms: number): string {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}
