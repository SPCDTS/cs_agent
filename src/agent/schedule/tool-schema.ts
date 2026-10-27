import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { SHANGHAI_OFFSET_MS } from "./model.js";
import type { ScheduleRule } from "./types.js";

const TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$";
const time = Type.String({ pattern: TIME_PATTERN, description: "Beijing time, strictly in YYYY-MM-DD HH:mm format" });
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
const promptInstruction = "prompt must specify what to do on each run, whom to notify, and how. Resolve destinations such as '家庭群' with qq_chats first, then include the exact ref in prompt, e.g. '发到 qq:group:123（家庭群）'. For monitoring tasks where the user requests no notification without updates, explicitly write '无新内容则静默（silent if nothing new）'.";
export const scheduleDescriptions = {
  schedule_create: "Create a scheduled task in the current source chat, with this turn's speaker as its creator. rule uses Beijing time; rrule is the RRULE body, start defaults to now if omitted, and at is a one-time future instant. " + promptInstruction,
  schedule_list: "List visible scheduled tasks with id, status, and next run time in Beijing time. The owner sees all tasks; others see only tasks they created.",
  schedule_update: "Update the name, prompt, or entire rule by id. The source chat and creator cannot be changed. Manage only tasks you are authorized to operate on. " + promptInstruction,
  schedule_pause: "Pause a scheduled task by id without interrupting a running turn.",
  schedule_resume: "Resume a scheduled task by id, recalculating the next run in Beijing time from now without replaying missed triggers.",
  schedule_delete: "Delete a scheduled task by id.",
  schedule_run_now: "Trigger one run immediately by id without changing the next scheduled time; return the status of this run.",
  schedule_control: "Available only during scheduled runs: pause or complete the task for this run and provide a reason. Completion stops future triggers without interrupting the current turn. Other tasks cannot be targeted.",
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
