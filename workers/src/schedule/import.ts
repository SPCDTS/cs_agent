import { Type } from "typebox";
import { Check } from "typebox/value";
import { CreateSchema, DEFAULT_SCHEDULE_OPTIONS, nextFireAt, parseCreate, validateRule } from "./model";
import type { Schedule } from "./types";

export const SCHEDULE_IMPORT_MAX_BYTES = 1024 * 1024;
const strict = { additionalProperties: false };
const time = Type.Integer({ minimum: 0, maximum: Date.UTC(9998, 11, 31) });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const uuid = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const run = Type.Object({
  fire_key: Type.String({ maxLength: 80 }), fire_at: time,
  status: Type.Union([Type.Literal("sent"), Type.Literal("silent"), Type.Literal("failed"), Type.Literal("skipped")]),
  reason: Type.Optional(Type.Union([Type.Literal("stale"), Type.Literal("overlap"), Type.Literal("interrupted"), Type.Literal("paused"),
    Type.Literal("revision"), Type.Literal("timeout"), Type.Literal("backend_failed")])),
  skipped_count: Type.Optional(count), started_at: Type.Optional(time), ended_at: Type.Optional(time), sent: Type.Optional(count),
  note: Type.Optional(Type.String({ maxLength: 200 })), input_key: Type.Optional(Type.String({ maxLength: 200 })),
}, strict);
const schema = Type.Object({
  dryRun: Type.Boolean(),
  schedules: Type.Array(Type.Object({
    ...CreateSchema.properties, id: uuid, revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    status: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("completed")]),
    pause_reason: Type.Optional(Type.String({ maxLength: 200 })), mode: Type.Literal("thread"),
    options: Type.Object({ stale_after_ms: Type.Literal(DEFAULT_SCHEDULE_OPTIONS.stale_after_ms), timeout_ms: Type.Literal(DEFAULT_SCHEDULE_OPTIONS.timeout_ms) }, strict),
    created_by: Type.String({ pattern: "^qq:[1-9][0-9]{0,15}$" }), created_at: time, updated_at: time,
    next_fire_at: Type.Union([time, Type.Null()]), failures: count, fire_count: count,
    runs: Type.Array(run, { maxItems: 20 }),
  }, strict), { minItems: 1, maxItems: 100 }),
}, strict);

export class ScheduleImportError extends Error {
  constructor(readonly code: "invalid_import" | "schedule_conflict") { super(code); }
}

/** 只接收已结算的旧记录；所有规则先验证，活动任务只安排未来触发。 */
export function parseScheduleImport(value: unknown, now: number) {
  if (!Check(schema, value)) throw new ScheduleImportError("invalid_import");
  const ids = new Set<string>();
  const schedules = value.schedules.map(item => {
    if (ids.has(item.id) || item.created_at > item.updated_at || item.updated_at > now ||
        item.fire_count < item.runs.filter(r => r.status !== "skipped").length) throw new ScheduleImportError("invalid_import");
    ids.add(item.id);
    const keys = new Set<string>();
    for (const run of item.runs) {
      if (run.fire_key !== item.id + "@" + run.fire_at || keys.has(run.fire_key) || run.fire_at > now ||
          run.started_at !== undefined && (run.started_at > now || run.ended_at !== undefined && run.ended_at < run.started_at) ||
          run.ended_at !== undefined && run.ended_at > now) throw new ScheduleImportError("invalid_import");
      keys.add(run.fire_key);
    }
    let fields, next;
    try {
      fields = parseCreate({ name: item.name, prompt: item.prompt, conversation: item.conversation, rule: item.rule });
      next = item.status === "active" ? validateRule(fields.rule, now) : null;
      if (item.status !== "active") nextFireAt(fields.rule, now);
    } catch { throw new ScheduleImportError("invalid_import"); }
    if (item.status === "active" && item.failures >= 3) throw new ScheduleImportError("invalid_import");
    const { fire_count: fireCount, ...source } = item;
    const schedule: Schedule = { ...source, ...fields, next_fire_at: next };
    return { schedule, fireCount, source: JSON.stringify(item) };
  });
  return { dryRun: value.dryRun, schedules };
}
