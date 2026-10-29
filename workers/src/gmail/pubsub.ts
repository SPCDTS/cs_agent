import { Type } from "typebox";
import { Check } from "typebox/value";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const Jwk = Type.Object({ kid: Type.String(), kty: Type.Literal("RSA"), n: Type.String({ minLength: 1 }), e: Type.String({ minLength: 1 }) });
const Jwks = Type.Object({ keys: Type.Array(Type.Unknown(), { maxItems: 32 }) });
const Header = Type.Object({ alg: Type.Literal("RS256"), kid: Type.String({ minLength: 1, maxLength: 128 }) });
const Claims = Type.Object({ iss: Type.String(), aud: Type.String(), email: Type.String(), email_verified: Type.Boolean(), exp: Type.Number() });
const Push = Type.Object({ message: Type.Object({ data: Type.String({ minLength: 1 }), messageId: Type.String({ minLength: 1, maxLength: 256 }) }), subscription: Type.String({ maxLength: 512 }) });
const Notification = Type.Object({ emailAddress: Type.String({ minLength: 3, maxLength: 320 }),
  historyId: Type.Union([Type.String({ pattern: "^[0-9]{1,20}$" }), Type.Integer({ minimum: 0 })]) });
const BODY_LIMIT = 64 * 1024;
// 未知 kid 触发的重新拉取受限流，伪造请求不能把 Worker 变成打 Google 的放大器。
let lastRefresh = 0;

async function keys(refresh: boolean): Promise<unknown[]> {
  const cache = caches.default, cacheKey = new Request(JWKS_URL);
  if (!refresh) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body: unknown = await hit.json();
      if (Check(Jwks, body)) return body.keys;
    }
  } else if (Date.now() - lastRefresh < 60_000) return [];
  lastRefresh = Date.now();
  // Workers 不支持 redirect: "error"；manual 下 3xx 不是 ok，按失败处理。
  const response = await fetch(JWKS_URL, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const body: unknown = response.ok ? await response.json() : undefined;
  if (!Check(Jwks, body)) return [];
  await cache.put(cacheKey, Response.json(body, { headers: { "Cache-Control": "public, max-age=3600" } }));
  return body.keys;
}
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** Pub/Sub push 的 OIDC JWT：RS256 验签、签发者、受众、服务账号邮箱与过期时间全部核对。 */
export async function verifyPushToken(authorization: string | null, audience: string, serviceAccount: string): Promise<boolean> {
  const parts = authorization?.startsWith("Bearer ") ? authorization.slice(7).split(".") : [];
  const [head, payload, signature] = parts;
  if (parts.length !== 3 || !head || !payload || !signature) return false;
  let header: unknown, claims: unknown;
  try { header = decode(head); claims = decode(payload); } catch { return false; }
  if (!Check(Header, header) || !Check(Claims, claims)) return false;
  if (!ISSUERS.has(claims.iss) || claims.aud !== audience || claims.email !== serviceAccount || !claims.email_verified || claims.exp * 1000 <= Date.now()) return false;
  try {
    const find = (list: unknown[]) => list.find(key => Check(Jwk, key) && key.kid === header.kid);
    const jwk = find(await keys(false)) ?? find(await keys(true));
    if (!Check(Jwk, jwk)) return false;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${head}.${payload}`));
  } catch { return false; }
}

/** 请求体只是"有新邮件"的信号；形状不对或超过 64 KiB 返回 undefined。 */
export async function readPush(request: Request): Promise<{ historyId: string } | undefined> {
  if (Number(request.headers.get("content-length")) > BODY_LIMIT) return;
  const reader = request.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) return;
      chunks.push(value);
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks)));
    if (!Check(Push, body)) return;
    const data: unknown = JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8"));
    return Check(Notification, data) ? { historyId: String(data.historyId) } : undefined;
  } catch { return; }
  finally { await reader.cancel().catch(() => {}); }
}
