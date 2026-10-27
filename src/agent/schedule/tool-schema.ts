import { SCHEDULE_ACTIONS, type ScheduleTool } from "../../shared/schedule-tools.js";
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
export const scheduleParameters = {
  schedule: Type.Object({
    action: Type.String({ enum: [...SCHEDULE_ACTIONS] }),
    id: Type.Optional(id), name: Type.Optional(name), prompt: Type.Optional(prompt), rule: Type.Optional(rule),
  }, { additionalProperties: false }),
  schedule_control: Type.Object({
    action: Type.Union([Type.Literal("pause"), Type.Literal("complete")]),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
};
export const scheduleDescriptions = {
  schedule: "Manage tasks in the current source chat as this turn's speaker. create requires name, prompt, rule; list takes no other fields; update requires id plus optional name, prompt, rule; pause/resume/delete/run_now require id. Owners manage all tasks; others only their own. rule: Beijing time YYYY-MM-DD HH:mm; rrule with optional start (default now), or a future at. Resolve destinations with qq_chats and put exact refs (e.g. qq:group:123) in prompt with what to do and whom/how to notify; specify 'silent if nothing new' when requested. resume skips missed triggers; run_now preserves the next trigger; pause leaves running turns intact.",
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

const scheduleAction = z.object({ action: z.enum(SCHEDULE_ACTIONS, {
  error: "schedule action is required and must be one of: create, list, update, pause, resume, delete, run_now",
}) }).loose();
export function parseScheduleCall(tool: ScheduleTool, input: unknown) {
  if (tool === "schedule_control") return { name: tool, args: scheduleInputs.control.parse(input) };
  const { action, ...args } = scheduleAction.parse(input);
  const name = `schedule_${action}` as const;
  const schema = action === "create" || action === "update" || action === "list" ? scheduleInputs[action] : scheduleInputs.id;
  return { name, args: schema.parse(args) };
}

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
