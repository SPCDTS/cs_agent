import { RRule, rrulestr } from "rrule";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { CreateSchedule, ScheduleConversation, ScheduleRule, UpdateSchedule } from "./types";

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
export const DEFAULT_SCHEDULE_OPTIONS = { stale_after_ms: 10 * 60_000, timeout_ms: 300_000 };
/** 只有 owner 能建任务，沿用 Docker 版 owner 的最小间隔。 */
const MIN_INTERVAL_MINUTES = 5;

const timestamp = Type.Integer({ minimum: 0, maximum: Date.UTC(9998, 11, 31) });
const RuleSchema = Type.Union([
  Type.Object({ kind: Type.Literal("at"), at: timestamp }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("rrule"), rrule: Type.String({ minLength: 1, maxLength: 2000 }), dtstart: timestamp }, { additionalProperties: false }),
]);
const fields = {
  name: Type.String({ minLength: 1, maxLength: 64 }),
  prompt: Type.String({ minLength: 1, maxLength: 8000 }),
  rule: RuleSchema,
};
export const CreateSchema = Type.Object({ ...fields, conversation: Type.String({ pattern: "^(owner|(group|private):[1-9][0-9]{0,15})$" }) }, { additionalProperties: false });
const UpdateSchema = Type.Object({ name: Type.Optional(fields.name), prompt: Type.Optional(fields.prompt), rule: Type.Optional(fields.rule) }, { additionalProperties: false });

function trimmed<T extends { name?: string; prompt?: string }>(value: T): T {
  const result = { ...value, ...(value.name === undefined ? {} : { name: value.name.trim() }), ...(value.prompt === undefined ? {} : { prompt: value.prompt.trim() }) };
  if (result.name === "" || result.prompt === "") throw new Error("定时任务名称和提示词不能为空");
  return result;
}

export function parseCreate(input: unknown): CreateSchedule {
  if (!Check(CreateSchema, input)) throw new Error("定时任务字段无效");
  const value = trimmed(input);
  return { ...value, conversation: value.conversation as ScheduleConversation };
}

export function parseUpdate(input: unknown): UpdateSchedule {
  if (!Check(UpdateSchema, input)) throw new Error("定时任务修改无效");
  return trimmed(input);
}

/** 固定北京墙钟轴：rrule.js 把北京墙钟放进 UTC 字段，输出统一减 8 小时，不受宿主时区影响。 */
function recurrence(rule: Extract<ScheduleRule, { kind: "rrule" }>): RRule {
  if (!/^[A-Z]+=[A-Z0-9,+-]+(?:;[A-Z]+=[A-Z0-9,+-]+)*$/.test(rule.rrule)) throw new Error("rrule 只接受 RRULE 正文，不含 DTSTART 或其他行");
  const parts = rule.rrule.split(";").map(part => part.split("=") as [string, string]);
  if (new Set(parts.map(([key]) => key)).size !== parts.length) throw new Error("RRULE 字段不可重复");
  const ranges: Record<string, [number, number, boolean?]> = {
    INTERVAL: [1, 1_000_000], COUNT: [1, 1_000_000], BYSECOND: [0, 59], BYMINUTE: [0, 59],
    BYHOUR: [0, 23], BYMONTH: [1, 12], BYMONTHDAY: [-31, 31, true],
    BYYEARDAY: [-366, 366, true], BYWEEKNO: [-53, 53, true], BYSETPOS: [-366, 366, true],
  };
  const allowed = new Set(["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYSECOND", "BYMINUTE", "BYHOUR",
    "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST"]);
  for (const [key, value] of parts) {
    if (!allowed.has(key)) throw new Error(`RRULE 不支持字段 ${key}`);
    if (key === "FREQ" && !/^(YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY|SECONDLY)$/.test(value)) throw new Error("RRULE FREQ 无效");
    if (key === "WKST" && !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(value)) throw new Error("RRULE WKST 无效");
    const range = ranges[key];
    if (range && ((key === "INTERVAL" || key === "COUNT") && value.includes(",") ||
      value.split(",").some(v => !/^-?\d+$/.test(v) || +v < range[0] || +v > range[1] || range[2] && +v === 0))) {
      throw new Error(`RRULE ${key} 超出范围`);
    }
    if (key === "BYDAY" && value.split(",").some(v => !/^([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(v) || Math.abs(parseInt(v) || 0) > 53)) {
      throw new Error("RRULE BYDAY 无效");
    }
    if (key === "UNTIL") {
      if (!/^\d{8}T\d{6}Z$/.test(value)) throw new Error("RRULE UNTIL 必须是 UTC 日期时间");
      const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/[-:]/g, "").replace(".000", "") !== value) throw new Error("RRULE UNTIL 日期无效");
    }
  }
  const values: Record<string, string> = Object.fromEntries(parts);
  if (!values.FREQ) throw new Error("RRULE 缺少 FREQ");
  if (values.COUNT && values.UNTIL) throw new Error("RRULE COUNT 与 UNTIL 不可同时使用");
  // 秒/分钟级的密集规则必须在调用 rrule 前拒绝，避免从旧 DTSTART 扫描海量候选。
  checkFrequency(values);
  let parsed;
  try {
    const start = new Date(Math.ceil(rule.dtstart / 1000) * 1000 + SHANGHAI_OFFSET_MS).toISOString().replace(/[-:]/g, "").slice(0, 15);
    parsed = rrulestr(`DTSTART;TZID=Asia/Shanghai:${start}\nRRULE:${rule.rrule}`);
  } catch {
    throw new Error("RRULE 无效");
  }
  if (!(parsed instanceof RRule)) throw new Error("RRULE 无效");
  const options = { ...parsed.origOptions, tzid: "UTC" };
  if (options.until) options.until = new Date(options.until.getTime() + SHANGHAI_OFFSET_MS);
  return new RRule(options, true);
}

function checkFrequency(values: Record<string, string>): void {
  const unit = values.FREQ === "SECONDLY" ? 1000 : values.FREQ === "MINUTELY" ? 60_000 : undefined;
  if (unit && Number(values.INTERVAL ?? 1) * unit < MIN_INTERVAL_MINUTES * 60_000) throw new Error(`触发间隔不得少于 ${MIN_INTERVAL_MINUTES} 分钟`);
}

/** 严格晚于 afterMs；一次性及 COUNT / UNTIL 到期返回 null。 */
export function nextFireAt(rule: ScheduleRule, afterMs: number): number | null {
  if (rule.kind === "at") return rule.at > afterMs ? rule.at : null;
  const next = recurrence(rule).after(new Date(afterMs + SHANGHAI_OFFSET_MS), false);
  return next ? next.getTime() - SHANGHAI_OFFSET_MS : null;
}

/** 新建、改规则与恢复时调用：必须有未来触发，且前 50 次相邻间隔不少于最小间隔。返回下一次触发。 */
export function validateRule(rule: ScheduleRule, now: number): number {
  // 先求下一次：无解规则只扫描一遍就被拒绝，不再进入间隔检查。
  const next = nextFireAt(rule, now);
  if (next === null) throw new Error("规则必须包含未来的触发时刻");
  if (rule.kind === "rrule") {
    let previous: number | undefined;
    recurrence(rule).all((date, index) => {
      const at = date.getTime() - SHANGHAI_OFFSET_MS;
      if (previous !== undefined && at - previous < MIN_INTERVAL_MINUTES * 60_000) throw new Error(`触发间隔不得少于 ${MIN_INTERVAL_MINUTES} 分钟`);
      previous = at;
      return index < 49;
    });
  }
  return next;
}

/** 包含两端；只向运行记录保存合并次数，不保存逐次跳过条目。 */
export function missedFires(rule: ScheduleRule, from: number, now: number): number {
  if (rule.kind === "at") return 1;
  let count = 0;
  recurrence(rule).between(new Date(from + SHANGHAI_OFFSET_MS), new Date(now + SHANGHAI_OFFSET_MS), true, () => { count++; return true; });
  return Math.max(1, count);
}

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/** 用 UTC 字段校验墙钟日期再减八小时；拒绝 Date 自动归一化的 2 月 30 日等输入。 */
export function parseBeijingTime(value: string): number {
  if (!TIME_PATTERN.test(value)) throw new Error("时间必须是北京时间 YYYY-MM-DD HH:mm");
  const wall = Date.parse(value.replace(" ", "T") + ":00.000Z");
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16).replace("T", " ") !== value ||
      Number(value.slice(0, 4)) < 1970 || Number(value.slice(0, 4)) > 9998) throw new Error("北京时间日期或时分无效");
  return wall - SHANGHAI_OFFSET_MS;
}
