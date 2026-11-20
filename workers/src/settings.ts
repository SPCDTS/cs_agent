import { idList } from "./policy";
import { DEFAULT_SEND_LIMITS, type OpsSettings, type Settings } from "./settings-schema";
import { sha256Hex } from "./shared/hash";

export * from "./settings-schema";
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
  return sha256Hex(JSON.stringify({ groupTrigger, allowGroups, allowUsers, extractNamespaces,
    model: { provider: model.provider, id: model.id, reasoningEffort: model.reasoningEffort ?? null } })).slice(0, 16);
}

export type OpsSettingsSnapshot = { value: OpsSettings; revision: string; updatedAt: number | null };
export function defaultOpsSettings(env: { HISTORY_RAW_DAYS?: string; HISTORY_RAW_HARD_MAX_DAYS?: string; HISTORY_SUMMARY_DAYS?: string; EVENTS_RETENTION_DAYS?: string }): OpsSettings {
  const days = (value: string | undefined, fallback: number) => value !== undefined && /^\d+$/.test(value) && Number(value) <= 3650 ? Number(value) : fallback;
  return { sendLimits: { ...DEFAULT_SEND_LIMITS }, alertOwner: true, alertThrottleMinutes: 10, ownerAlertThrottleMinutes: 30,
    defaults: { rawDays: days(env.HISTORY_RAW_DAYS,30), rawHardMaxDays: days(env.HISTORY_RAW_HARD_MAX_DAYS,90), summaryDays: days(env.HISTORY_SUMMARY_DAYS,365), eventsDays: days(env.EVENTS_RETENTION_DAYS,30), consolidate: true }, threads: {} };
}
export function threadOpsSettings(value: OpsSettings, thread: string): OpsSettings["defaults"] { return { ...value.defaults, ...value.threads[thread] }; }
export function opsSettingsRevision(value: OpsSettings): string {
  return sha256Hex(JSON.stringify({ ...value, threads: Object.fromEntries(Object.entries(value.threads).sort(([a],[b])=>a.localeCompare(b))) })).slice(0,16);
}
