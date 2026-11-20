import { Type, type Static } from "typebox";

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

// 运维参数单独做 CAS，旧设置面板保存 runtime 行不会覆盖新字段。
export const SendLimitsSchema = Type.Object({
  perChatMinute: Type.Integer({ minimum: 1, maximum: 600 }), perChatHour: Type.Integer({ minimum: 1, maximum: 36000 }),
  chatBreakerMinutes: Type.Integer({ minimum: 1, maximum: 1440 }), globalMinute: Type.Integer({ minimum: 1, maximum: 6000 }),
  globalBreakerMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
}, { additionalProperties: false });
export type SendLimits = Static<typeof SendLimitsSchema>;
export const DEFAULT_SEND_LIMITS: SendLimits = { perChatMinute: 6, perChatHour: 60, chatBreakerMinutes: 60, globalMinute: 30, globalBreakerMinutes: 10 };
export const MaintenanceSettingsSchema = Type.Object({ rawDays: Type.Integer({ minimum: 0, maximum: 3650 }), rawHardMaxDays: Type.Integer({ minimum: 0, maximum: 3650 }),
  summaryDays: Type.Integer({ minimum: 0, maximum: 3650 }), eventsDays: Type.Integer({ minimum: 0, maximum: 3650 }), consolidate: Type.Boolean() }, { additionalProperties: false });
export const MaintenanceOverrideSchema = Type.Partial(MaintenanceSettingsSchema);
export type MaintenanceOverride = Static<typeof MaintenanceOverrideSchema>;
export const OpsSettingsSchema = Type.Object({ sendLimits: SendLimitsSchema, alertOwner: Type.Boolean(),
  alertThrottleMinutes: Type.Integer({ minimum: 10, maximum: 1440 }), ownerAlertThrottleMinutes: Type.Integer({ minimum: 30, maximum: 1440 }),
  defaults: MaintenanceSettingsSchema,
  threads: Type.Record(Type.String({ pattern: `^(owner|group:${QQ_ID}|private:${QQ_ID})$` }), MaintenanceOverrideSchema, { maxProperties: 500 }),
}, { additionalProperties: false });
export type OpsSettings = Static<typeof OpsSettingsSchema>;
