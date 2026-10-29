import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { idList } from "./policy";

export const QQ_ID = "[1-9]\\d{4,15}";

export const SettingsSchema = Type.Object({
  groupTrigger: Type.Union([Type.Literal("mention_or_reply"), Type.Literal("mention_only"), Type.Literal("off")]),
  allowGroups: Type.Array(Type.String({ pattern: `^${QQ_ID}$` }), { maxItems: 500 }),
  allowUsers: Type.Array(Type.String({ pattern: `^${QQ_ID}$` }), { maxItems: 500 }),
  extractNamespaces: Type.Array(Type.String({ pattern: `^(owner|group:${QQ_ID}|private:${QQ_ID})$` }), { maxItems: 100 }),
}, { additionalProperties: false });
export type Settings = Static<typeof SettingsSchema>;
export type GroupTrigger = Settings["groupTrigger"];
export type SettingsSnapshot = { value: Settings; revision: string; defaults: Settings; overrides: Settings | null; updatedAt: number | null };
export type SettingsEnv = { QQ_ALLOW_USERS?: string; QQ_ALLOW_GROUPS?: string; QQ_GROUP_MENTIONS?: string | boolean; MEMORY_EXTRACT_NAMESPACES?: string };

export function defaultSettings(env: SettingsEnv): Settings {
  return {
    groupTrigger: env.QQ_GROUP_MENTIONS === false || env.QQ_GROUP_MENTIONS === "false" ? "off" : "mention_only",
    allowGroups: idList(env.QQ_ALLOW_GROUPS), allowUsers: idList(env.QQ_ALLOW_USERS),
    extractNamespaces: (env.MEMORY_EXTRACT_NAMESPACES ?? "owner").split(",").map(ns => ns.trim()).filter(Boolean),
  };
}
// 每个 DO 用自己的 env 求默认值再叠加覆盖项，测试与部署都只有一条“默认被覆盖”的规则。
export const effectiveSettings = (env: SettingsEnv, overrides: Settings | null): Settings => overrides ?? defaultSettings(env);
export function settingsRevision(value: Settings): string {
  const { groupTrigger, allowGroups, allowUsers, extractNamespaces } = value;
  return createHash("sha256").update(JSON.stringify({ groupTrigger, allowGroups, allowUsers, extractNamespaces })).digest("hex").slice(0, 16);
}
