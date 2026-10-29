import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { randomSecret, sha256 } from "./mcp/crypto";

// 与 pi-ai 的 openai-codex OAuth 流程同一组常量（node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js）。
// pi-ai 的 login() 要在本机起 1455 端口的回调服务器，Worker 做不到，所以授权由面板发起，用户把浏览器跳到的回调地址贴回来。
export const CODEX_PROVIDER = "openai-codex";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
export const LOGIN_TTL_MS = 10 * 60_000;

const LOGIN_CODES = ["invalid_callback", "missing_code", "authorization_denied", "invalid_state", "token_exchange", "unconfigured"] as const;
export type ModelLoginCode = typeof LOGIN_CODES[number];
export class ModelLoginError extends Error {
  constructor(readonly code: ModelLoginCode) { super(code); }
}
// RPC 只保留消息文本；按白名单取分类，远端正文、code 与 token 永远不会出现在响应里。
export const modelLoginErrorCode = (error: unknown): ModelLoginCode | "invalid_request" =>
  error instanceof Error && (LOGIN_CODES as readonly string[]).includes(error.message) ? error.message as ModelLoginCode : "invalid_request";

export type CodexCredential = OAuthCredential & { accountId: string; email?: string };
export type PendingLogin = { state: string; verifier: string; url: string };

export async function startCodexLogin(): Promise<PendingLogin> {
  const state = randomSecret(), verifier = randomSecret();
  const url = new URL(AUTHORIZE_URL);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
    code_challenge: (await sha256(verifier)).toString("base64url"), code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "pi" })) url.searchParams.set(key, value);
  return { state, verifier, url: url.href };
}

/** 解析用户贴回的回调地址；浏览器地址栏复制时可能没有协议头。 */
export function parseCallback(input: string): { code: string; state: string } {
  const text = input.trim();
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`); } catch { throw new ModelLoginError("invalid_callback"); }
  if (url.searchParams.has("error")) throw new ModelLoginError("authorization_denied");
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code || code.length > 8192) throw new ModelLoginError("missing_code");
  if (!state) throw new ModelLoginError("invalid_state");
  return { code, state };
}

function jwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split(".")[1];
  if (!part) return;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(Buffer.from(part, "base64url")));
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch { return; }
}
const claim = (payload: Record<string, unknown> | undefined, path: string, field: string): string | undefined => {
  const value = (payload?.[path] as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" && value ? value : undefined;
};

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; id_token?: unknown };
async function tokenRequest(params: Record<string, string>, signal: AbortSignal): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...params, client_id: CLIENT_ID }), redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  } catch { throw new ModelLoginError("token_exchange"); }
  if (!response.ok) { await response.body?.cancel(); throw new ModelLoginError("token_exchange"); }
  const value: unknown = await response.json().catch(() => undefined);
  if (!value || typeof value !== "object") throw new ModelLoginError("token_exchange");
  return value;
}

/** 按 pi-ai 的形状组装凭据：account id 来自 access token 的 chatgpt_account_id，Codex 请求头要用它。 */
function credentialFrom(tokens: TokenResponse, previous?: CodexCredential): CodexCredential {
  if (typeof tokens.access_token !== "string" || typeof tokens.expires_in !== "number") throw new ModelLoginError("token_exchange");
  const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : previous?.refresh;
  const access = jwtPayload(tokens.access_token), id = jwtPayload(typeof tokens.id_token === "string" ? tokens.id_token : undefined);
  const accountId = claim(access, JWT_AUTH_CLAIM, "chatgpt_account_id");
  if (!refresh || !accountId) throw new ModelLoginError("token_exchange");
  const email = (typeof id?.email === "string" ? id.email : undefined) ?? claim(access, JWT_PROFILE_CLAIM, "email") ?? previous?.email;
  return { type: "oauth", access: tokens.access_token, refresh, expires: Date.now() + tokens.expires_in * 1000, accountId, ...(email ? { email } : {}) };
}

export async function exchangeCode(code: string, verifier: string): Promise<CodexCredential> {
  return credentialFrom(await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI }, AbortSignal.timeout(15_000)));
}

/**
 * 交给 pi-ai 的 OAuthAuth。pi-ai 自带的那份经 lazyOAuth 用变量路径动态 import，打包进 Worker 后加载不到，
 * 所以按同一端点自己写 refresh；Models.getAuth 在 CredentialStore.modify 里调用它，换下来的 refresh token 随之存回。
 */
export const codexOAuth: OAuthAuth = {
  name: "OpenAI (ChatGPT Plus/Pro)",
  isSubscription: true,
  login: async () => { throw new Error("ChatGPT 登录只能从管理面板发起"); },
  refresh: async (credential, signal) => credentialFrom(await tokenRequest({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal),
    credential as CodexCredential),
  toAuth: async credential => ({ apiKey: credential.access }),
};
