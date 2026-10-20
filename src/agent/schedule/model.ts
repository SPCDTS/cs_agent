import rrule from "rrule";
import { runInNewContext } from "node:vm";
import { z } from "zod";
import { isScope } from "../../context/access.js";
import type { Schedule, ScheduleRule } from "./types.js";

const { RRule, rrulestr } = rrule;
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
export const DEFAULT_SCHEDULE_OPTIONS = { stale_after_ms: 10 * 60_000, timeout_ms: 300_000 };

export class ScheduleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const timestamp = z.number().int().min(0).max(Date.UTC(9998, 11, 31));
const ruleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: timestamp }).strict(),
  z.object({ kind: z.literal("rrule"), rrule: z.string().min(1).max(2000), dtstart: timestamp }).strict(),
]);
const optionsSchema = z.object({
  stale_after_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  timeout_ms: z.number().int().min(1).max(900_000).optional(),
}).strict();
const fields = {
  name: z.string().trim().min(1).max(64),
  prompt: z.string().trim().min(1).max(8000),
  conversation: z.string().refine(value => value === "owner" || isScope(value) && value === value.trim()),
  rule: ruleSchema,
  mode: z.literal("thread").optional(),
  options: optionsSchema.optional(),
};
const createSchema = z.object(fields).strict();
const updateSchema = z.object({
  name: fields.name.optional(), prompt: fields.prompt.optional(), rule: fields.rule.optional(),
  mode: fields.mode, options: fields.options,
}).strict();
export type CreateSchedule = Pick<Schedule, "name" | "prompt" | "conversation" | "rule"> & {
  mode?: "thread"; options?: Partial<Schedule["options"]>;
};
export type UpdateSchedule = Partial<Omit<CreateSchedule, "conversation">>;

export function parseCreate(input: unknown): CreateSchedule {
  const result = createSchema.safeParse(input);
  if (!result.success) throw new ScheduleError(400, "定时任务字段无效：" + result.error.issues.map(i => i.path.join(".")).join("、"));
  return result.data as CreateSchedule;
}

export function parseUpdate(input: unknown): UpdateSchedule {
  const result = updateSchema.safeParse(input);
  if (!result.success) throw new ScheduleError(400, "定时任务修改无效：" + result.error.issues.map(i => i.path.join(".")).join("、"));
  return result.data;
}

/** 固定北京墙钟轴；输出统一减 8 小时，不能再混用主机本地时区。 */
function recurrence(rule: Extract<ScheduleRule, { kind: "rrule" }>) {
  if (!/^[A-Z]+=[A-Z0-9,+-]+(?:;[A-Z]+=[A-Z0-9,+-]+)*$/.test(rule.rrule)) {
    throw new ScheduleError(400, "rrule 只接受 RRULE 正文，不含 DTSTART 或其他行");
  }
  const parts = rule.rrule.split(";").map(part => part.split("="));
  if (new Set(parts.map(([key]) => key)).size !== parts.length) throw new ScheduleError(400, "RRULE 字段不可重复");
  const ranges: Record<string, [number, number, boolean?]> = {
    INTERVAL: [1, 1_000_000], COUNT: [1, 1_000_000], BYSECOND: [0, 59], BYMINUTE: [0, 59],
    BYHOUR: [0, 23], BYMONTH: [1, 12], BYMONTHDAY: [-31, 31, true],
    BYYEARDAY: [-366, 366, true], BYWEEKNO: [-53, 53, true], BYSETPOS: [-366, 366, true],
  };
  const allowed = new Set(["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYSECOND", "BYMINUTE", "BYHOUR",
    "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST"]);
  for (const [key, value] of parts) {
    if (!allowed.has(key)) throw new ScheduleError(400, `RRULE 不支持字段 ${key}`);
    if (key === "FREQ" && !/^(YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY|SECONDLY)$/.test(value)) throw new ScheduleError(400, "RRULE FREQ 无效");
    if (key === "WKST" && !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(value)) throw new ScheduleError(400, "RRULE WKST 无效");
    const range = ranges[key];
    if (range && (["INTERVAL", "COUNT"].includes(key) && value.includes(",") ||
      value.split(",").some(v => !/^-?\d+$/.test(v) || +v < range[0] || +v > range[1] || range[2] && +v === 0))) {
      throw new ScheduleError(400, `RRULE ${key} 超出范围`);
    }
    if (key === "BYDAY" && value.split(",").some(v => !/^([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(v) ||
      Math.abs(parseInt(v) || 0) > 53)) throw new ScheduleError(400, "RRULE BYDAY 无效");
    if (key === "UNTIL") {
      if (!/^\d{8}T\d{6}Z$/.test(value)) throw new ScheduleError(400, "RRULE UNTIL 必须是 UTC 日期时间");
      const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/[-:]/g, "").replace(".000", "") !== value) {
        throw new ScheduleError(400, "RRULE UNTIL 日期无效");
      }
    }
  }
  if (!parts.some(([key]) => key === "FREQ")) throw new ScheduleError(400, "RRULE 缺少 FREQ");
  const values = Object.fromEntries(parts);
  if (values.COUNT && values.UNTIL) throw new ScheduleError(400, "RRULE COUNT 与 UNTIL 不可同时使用");
  // 秒/分钟级的密集规则必须在调用 rrule 前拒绝，避免从旧 DTSTART 扫描海量候选。
  checkFrequency(values, 5);
  try {
    const start = new Date(Math.ceil(rule.dtstart / 1000) * 1000 + SHANGHAI_OFFSET_MS).toISOString().replace(/[-:]/g, "").slice(0, 15);
    const parsed = rrulestr(`DTSTART;TZID=Asia/Shanghai:${start}\nRRULE:${rule.rrule}`);
    if (!(parsed instanceof RRule)) throw new Error("不支持规则集合");
    // rrule 的 TZID 输出受宿主时区影响。保留 TZID 解析，再在 UTC 轴计算北京墙钟，
    // 使 Windows（北京）与生产环境（UTC）都遵循同一条 -8h 规则。
    const options = { ...parsed.origOptions, tzid: "UTC" };
    if (options.until) options.until = new Date(options.until.getTime() + SHANGHAI_OFFSET_MS);
    return new RRule(options, true);
  } catch {
    throw new ScheduleError(400, "RRULE 无效");
  }
}

/** 固定代码调用受信任的 rrule；VM 超时中断无解过滤器等同步长循环。 */
function evaluate<T>(operation: () => T): T {
  try { return runInNewContext("operation()", { operation }, { timeout: 250 }) as T; }
  catch (error) {
    if ((error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new ScheduleError(400, "RRULE 计算超过 250ms，请简化规则或缩短 DTSTART 范围");
    }
    throw error;
  }
}

/** 严格晚于 afterMs；一次性及 COUNT / UNTIL 到期返回 null。 */
export function nextFireAt(rule: ScheduleRule, afterMs: number): number | null {
  if (rule.kind === "at") return rule.at > afterMs ? rule.at : null;
  const next = evaluate(() => recurrence(rule).after(new Date(afterMs + SHANGHAI_OFFSET_MS), false));
  return next ? next.getTime() - SHANGHAI_OFFSET_MS : null;
}

function checkFrequency(values: Record<string, string>, minutes: number): void {
  const unit = values.FREQ === "SECONDLY" ? 1000 : values.FREQ === "MINUTELY" ? 60_000 : undefined;
  if (unit && Number(values.INTERVAL ?? 1) * unit < minutes * 60_000) {
    throw new ScheduleError(400, `触发间隔不得少于 ${minutes} 分钟`);
  }
}

export function validateRule(rule: ScheduleRule, now: number, owner: boolean): number {
  if (rule.kind === "rrule") {
    const minutes = owner ? 5 : 30;
    checkFrequency(Object.fromEntries(rule.rrule.split(";").map(part => part.split("="))), minutes);
    let previous: number | undefined;
    evaluate(() => recurrence(rule).all((date, index) => {
      const at = date.getTime() - SHANGHAI_OFFSET_MS;
      if (previous !== undefined && at - previous < minutes * 60_000) {
        throw new ScheduleError(400, `触发间隔不得少于 ${minutes} 分钟`);
      }
      previous = at;
      return index < 49;
    }));
  }
  const next = nextFireAt(rule, now);
  if (next === null) throw new ScheduleError(400, "规则必须包含未来的触发时刻");
  return next;
}

/** 包含两端；只向运行记录保存合并次数，不保存逐次跳过条目。 */
export function missedFires(rule: ScheduleRule, from: number, now: number): number {
  if (rule.kind === "at") return 1;
  let count = 0;
  evaluate(() => recurrence(rule).between(new Date(from + SHANGHAI_OFFSET_MS), new Date(now + SHANGHAI_OFFSET_MS), true,
    () => { count++; return true; }));
  return Math.max(1, count);
}
