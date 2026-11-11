import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { responseFields } from "./codex-refresh-error";

export const CatalogFailureSchema = Type.Union([
  Type.Object({ at: Type.Number(), kind: Type.Union([Type.Literal("network"), Type.Literal("timeout"), Type.Literal("aborted")]) }, { additionalProperties: false }),
  Type.Object({ at: Type.Number(), kind: Type.Union([Type.Literal("http"), Type.Literal("invalid_json"), Type.Literal("invalid_catalog")]), ...responseFields }, { additionalProperties: false }),
]);
export type CatalogFailure = Static<typeof CatalogFailureSchema>;
export class CatalogError extends Error {
  constructor(readonly diagnostic: CatalogFailure) { super("catalog_failed: " + JSON.stringify(diagnostic)); }
}
// 跨 DO 只传递白名单诊断字段，不传递上游正文或令牌。
export function catalogFailure(error: unknown): CatalogFailure | undefined {
  if (error instanceof CatalogError) return error.diagnostic;
  if (error instanceof Error && error.message.startsWith("catalog_failed: ")) {
    try { const value: unknown = JSON.parse(error.message.slice("catalog_failed: ".length)); if (Check(CatalogFailureSchema, value)) return value; } catch {}
  }
  return undefined;
}
