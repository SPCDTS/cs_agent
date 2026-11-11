import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

// 只记录协议错误码和请求标识；错误描述、响应正文、Cookie、令牌不进入日志或 RPC。
const OAuthCode = Type.Union([
  Type.Literal("invalid_grant"), Type.Literal("invalid_client"), Type.Literal("invalid_request"), Type.Literal("unauthorized_client"), Type.Literal("unsupported_grant_type"), Type.Literal("invalid_scope"),
  Type.Literal("invalid_resource"), Type.Literal("access_denied"), Type.Literal("server_error"), Type.Literal("temporarily_unavailable"), Type.Literal("rate_limit_exceeded"),
  Type.Literal("refresh_token_reused"), Type.Literal("refresh_token_expired"), Type.Literal("refresh_token_invalidated"), Type.Literal("invalid_token"),
  Type.Literal("unsupported_country_region_territory"), Type.Literal("unrecognized"),
]);
const identifier = Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" });
export const responseFields = {
  status: Type.Integer({ minimum: 100, maximum: 599 }),
  format: Type.Union([Type.Literal("json"), Type.Literal("html"), Type.Literal("other")]),
  oauthCode: Type.Optional(OAuthCode), requestId: Type.Optional(identifier), cfRay: Type.Optional(identifier),
  challenge: Type.Boolean(),
};
export const RefreshFailureSchema = Type.Union([
  Type.Object({ at: Type.Number(), kind: Type.Union([Type.Literal("network"), Type.Literal("timeout"), Type.Literal("aborted")]) }, { additionalProperties: false }),
  Type.Object({ at: Type.Number(), kind: Type.Union([Type.Literal("http"), Type.Literal("invalid_json"), Type.Literal("invalid_token_response"),
    Type.Literal("invalid_identity"), Type.Literal("plan_permission_required")]), ...responseFields }, { additionalProperties: false }),
]);
export type RefreshFailure = Static<typeof RefreshFailureSchema>;
export class OAuthRefreshError extends Error {
  constructor(readonly diagnostic: RefreshFailure) { super("token_exchange: " + JSON.stringify(diagnostic)); }
}
/** pi-ai 包装 cause；跨 DO 的 Error 只保证 message，因此同时支持经过 schema 校验的序列化诊断。 */
export function refreshFailure(error: unknown): RefreshFailure | undefined {
  for (let depth = 0; depth < 6 && error instanceof Error; depth++, error = error.cause) {
    if (error instanceof OAuthRefreshError) return error.diagnostic;
    if (error.message.startsWith("token_exchange: ")) {
      try { const value: unknown = JSON.parse(error.message.slice("token_exchange: ".length)); if (Check(RefreshFailureSchema, value)) return value; } catch { /* 非诊断错误 */ }
    }
  }
  return undefined;
}
export function refreshNeedsReauth(failure: RefreshFailure): boolean {
  return failure.kind === "plan_permission_required" || "oauthCode" in failure &&
    ["invalid_grant", "invalid_client", "unauthorized_client", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"].includes(failure.oauthCode ?? "");
}
export function responseDiagnostic(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const id = (name: string) => { const value = response.headers.get(name); return Check(identifier, value) ? value : undefined; };
  return { status: response.status, format: contentType.includes("json") ? "json" as const : contentType.includes("html") ? "html" as const : "other" as const,
    requestId: id("x-request-id"), cfRay: id("cf-ray"), challenge: response.headers.get("cf-mitigated") === "challenge" };
}
const ErrorBody = Type.Object({ error: Type.Union([Type.String(), Type.Object({ code: Type.Optional(Type.String()), type: Type.Optional(Type.String()) })]) });
export async function responseOAuthCode(response: Response): Promise<Static<typeof OAuthCode> | undefined> {
  if (!response.headers.get("content-type")?.includes("json")) { await response.body?.cancel(); return undefined; }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    let body = "", size = 0;
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 16_384) return undefined;
      body += decoder.decode(part.value, { stream: true });
    }
    const value: unknown = JSON.parse(body + decoder.decode());
    if (!Check(ErrorBody, value)) return undefined;
    const code = typeof value.error === "string" ? value.error : value.error.code ?? value.error.type;
    return code === undefined ? undefined : Check(OAuthCode, code) ? code : "unrecognized";
  } catch { return undefined; } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
