import type { OAuthAuth } from "@earendil-works/pi-ai";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { randomSecret, sha256 } from "./mcp/crypto";
import { OAuthRefreshError, refreshFailure, responseDiagnostic, responseOAuthCode } from "./codex-refresh-error";

export const CODEX_PROVIDER = "openai-codex";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
const LEGACY_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
// Codex 兼容协议版本；不是本机 CLI 的安装版本。
const CODEX_VERSION = "0.162.0";
export const CODEX_MODELS_URL = CODEX_BASE_URL + "/models?client_version=" + CODEX_VERSION;
export const CODEX_HEADERS = { originator: "codex_cli_rs", version: CODEX_VERSION,
  "User-Agent": "codex_cli_rs/" + CODEX_VERSION + " (cs-agent; Cloudflare Workers)" };
export const RESOURCE = "https://api.openai.com/v1";
export const LOGIN_TTL_MS = 10 * 60_000;
const ISSUER = "https://auth.openai.com";
const SCOPE = "openid profile email offline_access";
const JWKS = createRemoteJWKSet(new URL(ISSUER + "/.well-known/jwks.json"));
const LOGIN_CODES = ["invalid_callback", "authorization_denied", "invalid_state", "token_exchange", "invalid_identity",
  "plan_permission_required", "login_required", "catalog_failed", "unconfigured"] as const;
export type ModelLoginCode = typeof LOGIN_CODES[number];
export class ModelLoginError extends Error {
  constructor(readonly code: ModelLoginCode) { super(code); }
}
export const modelLoginErrorCode = (error: unknown): ModelLoginCode | "invalid_request" =>
  refreshFailure(error) ? "token_exchange" : error instanceof Error && (LOGIN_CODES as readonly string[]).includes(error.message) ? error.message as ModelLoginCode : "invalid_request";

const Text = Type.String({ minLength: 1 });
export const TokenResponseSchema = Type.Object({
  access_token: Text, refresh_token: Text, id_token: Type.Optional(Text), token_type: Type.Literal("Bearer"),
  expires_in: Type.Number({ exclusiveMinimum: 0 }), scope: Type.Optional(Text),
});
export type TokenResponse = Static<typeof TokenResponseSchema>;
export const CatalogSchema = Type.Array(Type.Object({ slug: Text, display_name: Text, visibility: Text }));
export type ChatGPTModel = Static<typeof CatalogSchema>[number];
const CredentialFields = {
  type: Type.Literal("oauth"), access: Text, refresh: Text, expires: Type.Number(),
  clientId: Text, subject: Text, idToken: Text, scope: Text, email: Type.Optional(Text), hostId: Text, catalog: CatalogSchema,
};
const NativeCredentialSchema = Type.Object({ ...CredentialFields, flow: Type.Literal("codex-native"), accountId: Text });
const CredentialSchema = Type.Union([NativeCredentialSchema, Type.Object({ ...CredentialFields, flow: Type.Literal("chatgpt-plan") })]);
export type ChatGPTCredential = Static<typeof CredentialSchema>;
export const isChatGPTCredential = (value: unknown): value is ChatGPTCredential => Check(CredentialSchema, value);
export const isNativeCodexCredential = (value: unknown): value is Static<typeof NativeCredentialSchema> => Check(NativeCredentialSchema, value);
export const PendingSchema = Type.Object({
  flow: Type.Literal("codex-native"), workspaceId: Type.Optional(Text),
  state: Text, nonce: Text, verifier: Text, redirectUri: Text, hostId: Text,
  accountId: Type.Optional(Text), clientId: Type.Optional(Text), subject: Type.Optional(Text),
});
export type PendingLogin = Static<typeof PendingSchema>;

export async function startChatGPTLogin(hostId: string, port: number, account?: {
  id: string; clientId: string; subject: string; email?: string; idToken?: string; workspaceId?: string;
}): Promise<{ pending: PendingLogin; url: string }> {
  if (port !== 1455) throw new ModelLoginError("invalid_callback");
  // 旧 SIWC 账号不被覆盖；新授权成功前仍可继续使用或重新选回。
  const returning = account?.clientId === CODEX_CLIENT_ID ? account : undefined;
  const pending: PendingLogin = { flow: "codex-native", hostId, state: randomSecret(), nonce: randomSecret(), verifier: randomSecret(),
    redirectUri: CODEX_REDIRECT_URI, clientId: CODEX_CLIENT_ID,
    ...(returning ? { accountId: returning.id, subject: returning.subject, workspaceId: returning.workspaceId } : {}) };
  const url = new URL(ISSUER + "/oauth/authorize");
  const params = { response_type: "code", client_id: CODEX_CLIENT_ID, redirect_uri: pending.redirectUri, scope: SCOPE,
    state: pending.state, nonce: pending.nonce, code_challenge_method: "S256",
    code_challenge: (await sha256(pending.verifier)).toString("base64url"),
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs",
    ...(returning?.idToken ? { id_token_hint: returning.idToken } : {}), ...(account?.email ? { login_hint: account.email } : {}) };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { pending, url: url.href };
}

export function callbackClient(input: string, pending: PendingLogin): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new ModelLoginError("invalid_callback"); }
  if (url.origin + url.pathname !== pending.redirectUri || url.searchParams.get("state") !== pending.state)
    throw new ModelLoginError("invalid_state");
  if (url.searchParams.has("error")) throw new ModelLoginError("authorization_denied");
  const clientId = url.searchParams.get("client_id") ?? pending.clientId;
  if (!url.searchParams.get("code") || !clientId || clientId === "dynamic_agent_client" ||
    (pending.clientId && clientId !== pending.clientId)) throw new ModelLoginError("invalid_callback");
  return clientId;
}

const AccountClaim = Type.Object({ "https://api.openai.com/auth": Type.Object({ chatgpt_account_id: Text }) });
function tokenAccountId(access: string): string {
  try { const payload = decodeJwt(access); if (Check(AccountClaim, payload)) return payload["https://api.openai.com/auth"].chatgpt_account_id; } catch {}
  throw new ModelLoginError("invalid_identity");
}
async function verifyIdentity(idToken: string, clientId: string, expected: { nonce?: string; subject?: string }) {
  try {
    const { payload } = await jwtVerify(idToken, JWKS, { issuer: ISSUER, audience: clientId, algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"] });
    if (!payload.sub || (expected.nonce && payload.nonce !== expected.nonce) ||
      (expected.subject && payload.sub !== expected.subject)) throw new Error();
    return { subject: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
  } catch { throw new ModelLoginError("invalid_identity"); }
}
function checkScope(scope: string | undefined): string {
  if (!scope?.split(" ").includes("chatgpt.tokens.use.direct") || !scope.split(" ").includes("resource.invoke"))
    throw new ModelLoginError("plan_permission_required");
  return scope;
}
export async function acceptTokens(raw: unknown, clientId: string, pending: PendingLogin): Promise<ChatGPTCredential> {
  if (!Check(TokenResponseSchema, raw) || !raw.id_token) throw new ModelLoginError("token_exchange");
  if (clientId !== CODEX_CLIENT_ID) throw new ModelLoginError("invalid_identity");
  const scope = raw.scope ?? SCOPE, identity = await verifyIdentity(raw.id_token, clientId, pending);
  const accountId = tokenAccountId(raw.access_token);
  if (pending.workspaceId && pending.workspaceId !== accountId) throw new ModelLoginError("invalid_identity");
  return { type: "oauth", flow: "codex-native", accountId, access: raw.access_token, refresh: raw.refresh_token,
    expires: Date.now() + raw.expires_in * 1000, idToken: raw.id_token, scope, clientId,
    hostId: pending.hostId, ...identity, catalog: [] };
}
export async function fetchCatalog(credential: ChatGPTCredential): Promise<ChatGPTModel[]> {
  try {
    const response = await fetch(credential.flow === "codex-native" ? CODEX_MODELS_URL : RESOURCE + "/models", {
      headers: { Authorization: "Bearer " + credential.access, ...(credential.flow === "codex-native" ? { ...CODEX_HEADERS, "chatgpt-account-id": credential.accountId } : {}) },
      redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const value: unknown = await response.json();
    if (!Check(Type.Object({ models: CatalogSchema }), value)) throw new Error();
    return value.models.filter(model => model.visibility === "list");
  } catch { throw new ModelLoginError("catalog_failed"); }
}
export const codexOAuth: OAuthAuth = {
  name: "ChatGPT 订阅", isSubscription: true,
  login: async () => { throw new ModelLoginError("login_required"); },
  refresh: async (credential, signal) => {
    if (!isChatGPTCredential(credential)) throw new ModelLoginError("login_required");
    let response: Response;
    try {
      response = await fetch(credential.flow === "codex-native" ? TOKEN_URL : LEGACY_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: credential.clientId, refresh_token: credential.refresh, ...(credential.flow === "chatgpt-plan" ? { resource: RESOURCE } : {}) }),
        redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    } catch (error) {
      throw new OAuthRefreshError({ at: Date.now(), kind: error instanceof Error && error.name === "TimeoutError" ? "timeout"
        : error instanceof Error && error.name === "AbortError" ? "aborted" : "network" });
    }
    const diagnostic = responseDiagnostic(response);
    if (!response.ok) throw new OAuthRefreshError({ at: Date.now(), kind: "http", ...diagnostic, oauthCode: await responseOAuthCode(response) });
    let tokens: unknown;
    try { tokens = await response.json(); } catch { throw new OAuthRefreshError({ at: Date.now(), kind: "invalid_json", ...diagnostic }); }
    if (!Check(TokenResponseSchema, tokens)) throw new OAuthRefreshError({ at: Date.now(), kind: "invalid_token_response", ...diagnostic });
    let scope: string, identity: Awaited<ReturnType<typeof verifyIdentity>> | {};
    try {
      scope = credential.flow === "chatgpt-plan" ? checkScope(tokens.scope ?? credential.scope) : tokens.scope ?? credential.scope;
      if (credential.flow === "codex-native" && tokenAccountId(tokens.access_token) !== credential.accountId) throw new ModelLoginError("invalid_identity");
      identity = tokens.id_token ? await verifyIdentity(tokens.id_token, credential.clientId, { subject: credential.subject }) : {};
    } catch (error) {
      throw new OAuthRefreshError({ at: Date.now(), kind: error instanceof ModelLoginError && error.code === "plan_permission_required"
        ? "plan_permission_required" : "invalid_identity", ...diagnostic });
    }
    return { ...credential, ...identity, access: tokens.access_token, refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000, idToken: tokens.id_token ?? credential.idToken, scope };
  },
  toAuth: async credential => {
    if (!isChatGPTCredential(credential)) throw new ModelLoginError("login_required");
    if (credential.flow === "chatgpt-plan") { checkScope(credential.scope); return { apiKey: credential.access, baseUrl: RESOURCE }; }
    return { apiKey: credential.access, baseUrl: CODEX_BASE_URL, headers: { ...CODEX_HEADERS, "chatgpt-account-id": credential.accountId } };
  },
};
export async function revokeSession(credential: ChatGPTCredential): Promise<boolean> {
  try {
    const discovery = await fetch(ISSUER + "/.well-known/openid-configuration", { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (!discovery.ok) { await discovery.body?.cancel(); return false; }
    const value: unknown = await discovery.json();
    if (!Check(Type.Object({ revocation_endpoint: Text }), value)) return false;
    const endpoint = new URL(value.revocation_endpoint);
    if (endpoint.origin !== ISSUER) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: credential.refresh, token_type_hint: "refresh_token", client_id: credential.clientId }),
        redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      await response?.body?.cancel();
      if (response?.status === 200) return true;
      if (response && response.status < 500) return false;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
    }
    return false;
  } catch { return false; }
}
