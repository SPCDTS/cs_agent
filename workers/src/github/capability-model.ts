import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
export const CapabilityDataSchema = Type.Object({
  events: Type.Array(Type.String({pattern:"^[a-z_]{1,40}$"}), {maxItems:256,uniqueItems:true}),
  permissions: Type.Record(Type.String({pattern:"^[a-z_]{1,64}$"}), Type.Union([Type.Literal("read"),Type.Literal("write"),Type.Literal("admin")]), {additionalProperties:false}),
  repositorySelection: Type.Optional(Type.Union([Type.Literal("all"),Type.Literal("selected")])),
  suspendedAt: Type.Optional(Type.Union([Type.String({maxLength:40}),Type.Null()])),
}, {additionalProperties:false});
export type CapabilityData = Static<typeof CapabilityDataSchema>;
export function capabilityData(value: unknown): CapabilityData {
  if (!Check(CapabilityDataSchema,value) || Object.keys(value.permissions).length > 128
    || typeof value.suspendedAt === "string" && !Number.isFinite(Date.parse(value.suspendedAt))) throw new Error("invalid_capabilities");
  return value;
}
export const CapabilityReadSchema = Type.Object({
  status: Type.Union([Type.Literal("fresh"),Type.Literal("stale"),Type.Literal("error"),Type.Literal("never")]),
  fetchedAt: Type.Number(), lastAttemptAt: Type.Number(), expiresAt: Type.Number(), retryAt: Type.Number(),
  error: Type.Union([Type.String(),Type.Null()]), data: Type.Union([CapabilityDataSchema,Type.Null()]),
});
export const CapabilitiesSchema = Type.Object({
  app: CapabilityReadSchema,
  installations: Type.Array(Type.Object({installationId:Type.Number(),read:CapabilityReadSchema})),
});
