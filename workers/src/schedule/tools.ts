import type { Context } from "@earendil-works/chord/context";
import { Type, type Static } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Env } from "../env";
import { formatBeijingTime } from "../memory/time";
import { parseBeijingTime } from "./model";
import type { Schedule, ScheduleConversation, ScheduleRule } from "./types";

/** 本回合对定时工具的权限，由 ThreadDO 按当前输入求出；工具每次执行都重新求，不信任可见性。 */
export type ScheduleAccess =
  | { kind: "manage"; actor: string }
  | { kind: "control"; scheduleId: string; fireKey: string }
  | { kind: "none" };

type Action = "create" | "list" | "update" | "pause" | "resume" | "delete" | "run_now";
type Field = "id" | "name" | "prompt" | "rule";
/** 每个 action 的必填与可选字段；其余字段一律拒绝，避免模型以为改了实际没改。 */
const ACTION_FIELDS: Record<Action, { required: Field[]; optional: Field[] }> = {
  create: { required: ["name", "prompt", "rule"], optional: [] },
  list: { required: [], optional: [] },
  update: { required: ["id"], optional: ["name", "prompt", "rule"] },
  pause: { required: ["id"], optional: [] },
  resume: { required: ["id"], optional: [] },
  delete: { required: ["id"], optional: [] },
  run_now: { required: ["id"], optional: [] },
};

const time = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$", description: "Beijing time, strictly in YYYY-MM-DD HH:mm format" });
const ruleInput = Type.Union([
  Type.Object({ rrule: Type.String({ minLength: 1, maxLength: 2000 }), start: Type.Optional(time) }, { additionalProperties: false }),
  Type.Object({ at: time }, { additionalProperties: false }),
]);
const scheduleParameters = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("update"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("delete"), Type.Literal("run_now")]),
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })), rule: Type.Optional(ruleInput),
}, { additionalProperties: false });
const controlParameters = Type.Object({
  action: Type.Union([Type.Literal("pause"), Type.Literal("complete")]),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });

const DESCRIPTIONS = {
  schedule: "Manage scheduled tasks of the current chat; the owner or a user with an active schedule grant may use it. Granted users can manage only tasks they created in this chat. create requires name, prompt, rule; list takes no other fields; update requires id plus optional name, prompt, rule; pause/resume/delete/run_now require id. rule: Beijing time YYYY-MM-DD HH:mm; rrule (RRULE body without DTSTART) with optional start (default now), or a future at. At each trigger the prompt runs as a turn in this chat and send_message there replies to this chat, so write in the prompt what to do and what to send; specify 'silent if nothing new' when requested. resume skips missed triggers; run_now preserves the next trigger; pause leaves running turns intact.",
  schedule_control: "Available only during scheduled runs: pause or complete the task for this run and provide a reason. Completion stops future triggers without interrupting the current turn. Other tasks cannot be targeted.",
};
const STATUS_TEXT = { active: "启用", paused: "暂停", completed: "已完成" } as const;
const summary = (schedule: Schedule) =>
  `${schedule.id} · ${schedule.name} · 状态：${STATUS_TEXT[schedule.status]}（${schedule.status}）· 下次：${schedule.next_fire_at === null ? "无" : formatBeijingTime(schedule.next_fire_at) + "（北京时间）"}`;

function toolRule(input: Static<typeof ruleInput>, now: number): ScheduleRule {
  return "at" in input ? { kind: "at", at: parseBeijingTime(input.at) }
    : { kind: "rrule", rrule: input.rrule, dtstart: input.start === undefined ? now : parseBeijingTime(input.start) };
}

function checkFields(args: Static<typeof scheduleParameters>): void {
  const { required, optional } = ACTION_FIELDS[args.action];
  const missing = required.filter(field => args[field] === undefined);
  if (missing.length) throw new Error(`${args.action} 需要字段：${missing.join("、")}`);
  const extra = (["id", "name", "prompt", "rule"] as const).filter(field => args[field] !== undefined && !required.includes(field) && !optional.includes(field));
  if (extra.length) throw new Error(`${args.action} 不接受字段：${extra.join("、")}`);
}

const text = (value: string, isError = false) => ({ ...(isError ? { isError } : {}), output: [{ type: "text" as const, text: value }] });

export function createScheduleExtension(env: Env, conversation: ScheduleConversation, access: (api: ToolExecutionApi, context: Context) => Promise<ScheduleAccess>) {
  const directory = () => env.SCHEDULE.getByName("main");
  /** 只能操作本线程的任务；conversation 创建后不可改，所以先查后改没有竞态。 */
  async function owned(id: string,actor:string): Promise<Schedule> {
    const found = (await directory().listFor(conversation,actor)).find(schedule => schedule.id === id);
    if (!found) throw new Error("本会话没有这个定时任务");
    return found;
  }
  async function manage(args: Static<typeof scheduleParameters>, actor: string): Promise<string> {
    checkFields(args);
    const schedules = directory();
    switch (args.action) {
      case "create":
        return summary(await schedules.create({ name: args.name, prompt: args.prompt, rule: toolRule(args.rule!, Date.now()), conversation }, actor));
      case "list":
        return (await schedules.listFor(conversation,actor)).map(summary).join("\n") || "没有可见的定时任务。";
      case "update": {
        const id = (await owned(args.id!,actor)).id;
        return summary(await schedules.update(id, { name: args.name, prompt: args.prompt, ...(args.rule ? { rule: toolRule(args.rule, Date.now()) } : {}) }, actor));
      }
      case "pause": case "resume":
        return summary(await schedules.setStatus((await owned(args.id!,actor)).id, args.action === "pause" ? "paused" : "active", undefined, actor));
      case "delete": {
        const id = (await owned(args.id!,actor)).id;
        await schedules.remove(id, actor);
        return `${id} · 状态：已删除 · 下次：无`;
      }
      case "run_now": {
        const id = (await owned(args.id!,actor)).id, run = await schedules.runNow(id, actor);
        const after = (await schedules.listFor(conversation,actor)).find(schedule => schedule.id === id);
        return `${after ? summary(after) : `${id} · 状态：已删除 · 下次：无`}；本次运行：${run.status}`;
      }
    }
  }
  return defineExtension({
    name: "cs.schedule",
    sections: conversation==="owner"?[section("schedule", async () => {
      const active = (await directory().list(conversation)).filter(schedule => schedule.status === "active" && schedule.next_fire_at !== null);
      if (!active.length) return undefined;
      return "本会话的定时任务（用 schedule 工具管理）：\n" + active.map(schedule => `- ${schedule.name}：下次 ${formatBeijingTime(schedule.next_fire_at!)}（北京时间）`).join("\n");
    })]:[],
    tools: [defineTool({
      name: "schedule", description: DESCRIPTIONS.schedule, parameters: scheduleParameters, replay: "unsafe",
      execute: async (args, api, context) => {
        try {
          const turn = await access(api, context);
          if (turn.kind !== "manage") throw new Error("本轮没有有效的定时管理授权；本轮请勿重试。");
          return text(await manage(args, turn.actor));
        } catch (error) { return text(error instanceof Error ? error.message : "定时任务操作失败", true); }
      },
    }), defineTool({
      name: "schedule_control", description: DESCRIPTIONS.schedule_control, parameters: controlParameters, replay: "unsafe",
      execute: async (args, api, context) => {
        try {
          const turn = await access(api, context);
          if (turn.kind !== "control") throw new Error("schedule_control 仅限定时运行控制自己的任务；本轮请勿重试。");
          const schedule = await directory().setStatus(turn.scheduleId, args.action === "pause" ? "paused" : "completed", args.reason, `run:${turn.fireKey}`);
          return text(summary(schedule));
        } catch (error) { return text(error instanceof Error ? error.message : "定时任务操作失败", true); }
      },
    })].map(tool => ({ ...tool, callers: ["model"] as const })),
  });
}
