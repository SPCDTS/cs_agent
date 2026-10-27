import { z } from "zod";

const normalized = (max: number) => z.string().transform(value => [...value
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim()].slice(0, max).join(""));
export const eventSourceIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_:-]{0,63}$/);
export const externalEventSchema = z.object({
  source: eventSourceIdSchema, externalId: z.string().min(1).max(2048),
  occurredAt: z.number().int().min(0).max(8_640_000_000_000_000),
  kind: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
  title: normalized(200), summary: normalized(500), actor: normalized(120).optional(), ref: normalized(2048).optional(),
  labels: z.array(normalized(64)).transform(labels => [...new Set(labels.filter(Boolean))].slice(0, 16)).optional(),
});
export type ExternalEvent = z.infer<typeof externalEventSchema>;
export interface EventSource {
  readonly id: string;
  poll?(cursor: string | null, limit: number, signal: AbortSignal): Promise<{
    cursor: string; events: ExternalEvent[]; reset?: boolean; more?: boolean;
  }>;
}

export const gmailFiltersSchema = z.strictObject({
  requireLabels: z.array(z.string().min(1).max(64)).max(16).default(["INBOX"]),
  excludeLabels: z.array(z.string().min(1).max(64)).max(16).default(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "SENT"]),
  excludeSenders: z.array(normalized(120).pipe(z.string().min(1))).max(50).default([]),
});
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const eventSourceSettingsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  intervalS: z.number().int().min(30).max(3600).default(120),
  mergeWindowS: z.number().int().min(0).max(600).default(60),
  budgetPerHour: z.number().int().min(1).max(100).default(10),
  filters: gmailFiltersSchema.default(() => gmailFiltersSchema.parse({})),
  quietHours: z.strictObject({ start: time, end: time }).optional(),
});
export type EventSourceSettings = z.infer<typeof eventSourceSettingsSchema>;

/** 来源错误只携带固定分类，不传播远端正文或 URL。 */
export class EventSourceError extends Error {
  constructor(readonly code: "auth" | "permission" | "quota" | "network" | "response" | "timeout" | "upstream") { super(code); }
}
export class EventManagementError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
