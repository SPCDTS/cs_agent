import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { idList } from "./policy";

export const QQ_ID = "[1-9]\\d{4,15}";

// 形状在这里校验；provider 是否注册、id 是否在目录里、是否已登录由 models.ts 的注册表在保存时判断。
export const ModelSelectionSchema = Type.Object({
  provider: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
  id: Type.String({ minLength: 1, maxLength: 100 }),
  reasoningEffort: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")])),
}, { additionalProperties: false });
export type ModelSelection = Static<typeof ModelSelectionSchema>;

export const SettingsSchema = Type.Object({
  groupTrigger: Type.Union([Type.Literal("mention_or_reply"), Type.Literal("mention_only"), Type.Literal("off")]),
  allowGroups: Type.Array(Type.String({ pattern: `^${QQ_ID}$` }), { maxItems: 500 }),
  allowUsers: Type.Array(Type.String({ pattern: `^${QQ_ID}$` }), { maxItems: 500 }),
  extractNamespaces: Type.Array(Type.String({ pattern: `^(owner|group:${QQ_ID}|private:${QQ_ID})$` }), { maxItems: 100 }),
  model: ModelSelectionSchema,
}, { additionalProperties: false });
export type Settings = Static<typeof SettingsSchema>;
export type GroupTrigger = Settings["groupTrigger"];
export type SettingsSnapshot = { value: Settings; revision: string; defaults: Settings; overrides: Settings | null; updatedAt: number | null };
export type SettingsEnv = { QQ_ALLOW_USERS?: string; QQ_ALLOW_GROUPS?: string; QQ_GROUP_MENTIONS?: string | boolean; MEMORY_EXTRACT_NAMESPACES?: string;
  MODEL_PROVIDER?: string; MODEL_ID?: string };

export function defaultSettings(env: SettingsEnv): Settings {
  return {
    groupTrigger: env.QQ_GROUP_MENTIONS === false || env.QQ_GROUP_MENTIONS === "false" ? "off" : "mention_only",
    allowGroups: idList(env.QQ_ALLOW_GROUPS), allowUsers: idList(env.QQ_ALLOW_USERS),
    extractNamespaces: (env.MEMORY_EXTRACT_NAMESPACES ?? "owner").split(",").map(ns => ns.trim()).filter(Boolean),
    model: { provider: env.MODEL_PROVIDER || "deepseek", id: env.MODEL_ID || "deepseek-flash" },
  };
}
// 每个 DO 用自己的 env 求默认值再叠加覆盖项，测试与部署都只有一条“默认被覆盖”的规则。
export const effectiveSettings = (env: SettingsEnv, overrides: Settings | null): Settings => overrides ?? defaultSettings(env);
export function settingsRevision(value: Settings): string {
  const { groupTrigger, allowGroups, allowUsers, extractNamespaces, model } = value;
  return createHash("sha256").update(JSON.stringify({ groupTrigger, allowGroups, allowUsers, extractNamespaces,
    model: { provider: model.provider, id: model.id, reasoningEffort: model.reasoningEffort ?? null } })).digest("hex").slice(0, 16);
}

// 运维参数单独做 CAS，旧设置面板保存 runtime 行不会覆盖新字段。
export const SendLimitsSchema = Type.Object({
  perChatMinute: Type.Integer({ minimum: 1, maximum: 600 }), perChatHour: Type.Integer({ minimum: 1, maximum: 36000 }),
  chatBreakerMinutes: Type.Integer({ minimum: 1, maximum: 1440 }), globalMinute: Type.Integer({ minimum: 1, maximum: 6000 }),
  globalBreakerMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
}, { additionalProperties: false });
export type SendLimits = Static<typeof SendLimitsSchema>;
export const DEFAULT_SEND_LIMITS: SendLimits = { perChatMinute: 6, perChatHour: 60, chatBreakerMinutes: 60, globalMinute: 30, globalBreakerMinutes: 10 };
const MaintenanceSettingsSchema = Type.Object({ rawDays: Type.Integer({ minimum: 0, maximum: 3650 }), rawHardMaxDays: Type.Integer({ minimum: 0, maximum: 3650 }),
  summaryDays: Type.Integer({ minimum: 0, maximum: 3650 }), eventsDays: Type.Integer({ minimum: 0, maximum: 3650 }), consolidate: Type.Boolean() }, { additionalProperties: false });
const MaintenanceOverrideSchema = Type.Partial(MaintenanceSettingsSchema);
export const OpsSettingsSchema = Type.Object({ sendLimits: SendLimitsSchema, alertOwner: Type.Boolean(),
  alertThrottleMinutes: Type.Integer({ minimum: 10, maximum: 1440 }), ownerAlertThrottleMinutes: Type.Integer({ minimum: 30, maximum: 1440 }),
  defaults: MaintenanceSettingsSchema,
  threads: Type.Record(Type.String({ pattern: `^(owner|group:${QQ_ID}|private:${QQ_ID})$` }), MaintenanceOverrideSchema, { maxProperties: 500 }),
}, { additionalProperties: false });
export type OpsSettings = Static<typeof OpsSettingsSchema>;
export type OpsSettingsSnapshot = { value: OpsSettings; revision: string; updatedAt: number | null };
export function defaultOpsSettings(env: { HISTORY_RAW_DAYS?: string; HISTORY_RAW_HARD_MAX_DAYS?: string; HISTORY_SUMMARY_DAYS?: string; EVENTS_RETENTION_DAYS?: string }): OpsSettings {
  const days = (value: string | undefined, fallback: number) => value !== undefined && /^\d+$/.test(value) && Number(value) <= 3650 ? Number(value) : fallback;
  return { sendLimits: { ...DEFAULT_SEND_LIMITS }, alertOwner: true, alertThrottleMinutes: 10, ownerAlertThrottleMinutes: 30,
    defaults: { rawDays: days(env.HISTORY_RAW_DAYS,30), rawHardMaxDays: days(env.HISTORY_RAW_HARD_MAX_DAYS,90), summaryDays: days(env.HISTORY_SUMMARY_DAYS,365), eventsDays: days(env.EVENTS_RETENTION_DAYS,30), consolidate: true }, threads: {} };
}
export function threadOpsSettings(value: OpsSettings, thread: string): OpsSettings["defaults"] { return { ...value.defaults, ...value.threads[thread] }; }
export function opsSettingsRevision(value: OpsSettings): string {
  return createHash("sha256").update(JSON.stringify({ ...value, threads: Object.fromEntries(Object.entries(value.threads).sort(([a],[b])=>a.localeCompare(b))) })).digest("hex").slice(0,16);
}
