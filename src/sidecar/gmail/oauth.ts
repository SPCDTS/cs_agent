import { z } from "zod";
import { GmailError, googleError, REAUTHORIZE } from "./errors.js";
import { atomicJson, isMissing, readJson } from "./files.js";
import { requestJson } from "./http.js";

export const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"].join(" ");
const desktopSchema = z.object({ installed: z.object({
  client_id: z.string().min(1), client_secret: z.string().min(1), auth_uri: z.string().min(1), token_uri: z.string().min(1),
}) });
export type DesktopClient = z.infer<typeof desktopSchema>["installed"];
const tokenSchema = z.object({
  refresh_token: z.string().min(1), access_token: z.string().min(1), expires_at: z.number().finite(),
  scope: z.string(), obtained_at: z.number().finite(),
});
type SavedToken = z.infer<typeof tokenSchema>;
const responseSchema = z.object({
  access_token: z.string().min(1), expires_in: z.number().positive(), refresh_token: z.string().min(1).optional(), scope: z.string().optional(),
});
type AuthState = { kind: "ready"; token: SavedToken } | { kind: "missing" } | { kind: "invalid" };

export async function readDesktopClient(file: string): Promise<DesktopClient> {
  try {
    const client = desktopSchema.parse(await readJson(file)).installed;
    for (const value of [client.auth_uri, client.token_uri]) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error();
    }
    return client;
  } catch { throw new GmailError("config", "Gmail 桌面客户端配置缺失或无效"); }
}

async function tokenRequest(client: DesktopClient, fields: Record<string, string>) {
  const url = new URL(client.token_uri);
  const response = await requestJson(url, new Set([url.origin]), {
    method: "POST", body: new URLSearchParams({ ...fields, client_id: client.client_id, client_secret: client.client_secret }),
  });
  // 5xx 即使携带 OAuth 错误字段，也不能销毁仍可能有效的授权。
  if (response.status >= 400 && response.status < 500 &&
      z.object({ error: z.literal("invalid_grant") }).safeParse(response.body).success) {
    throw new GmailError("auth_invalid", REAUTHORIZE, response.status);
  }
  if (response.status < 200 || response.status >= 300) throw googleError(response.status);
  const parsed = responseSchema.safeParse(response.body);
  if (!parsed.success) throw new GmailError("response", "Google token 响应格式无效", response.status);
  return parsed.data;
}

export async function exchangeCode(options: { client: DesktopClient; code: string; verifier: string; redirectUri: string; tokenFile: string }): Promise<void> {
  const result = await tokenRequest(options.client, {
    grant_type: "authorization_code", code: options.code, code_verifier: options.verifier, redirect_uri: options.redirectUri,
  });
  if (!result.refresh_token) throw new GmailError("auth_missing", "Google 未返回 refresh_token，请带 prompt=consent 重新运行 npm run gmail:login");
  const now = Date.now();
  await atomicJson(options.tokenFile, {
    refresh_token: result.refresh_token, access_token: result.access_token, expires_at: now + result.expires_in * 1000,
    scope: result.scope ?? SCOPES, obtained_at: now,
  } satisfies SavedToken);
}

export class GmailOAuth {
  private state: AuthState = { kind: "missing" };
  private refreshing: Promise<string> | undefined;
  private constructor(private readonly client: DesktopClient, private readonly tokenFile: string) {}

  static async open(client: DesktopClient, tokenFile: string): Promise<GmailOAuth> {
    const oauth = new GmailOAuth(client, tokenFile);
    try {
      const result = tokenSchema.safeParse(await readJson(tokenFile));
      oauth.state = result.success ? { kind: "ready", token: result.data } : { kind: "invalid" };
    } catch (error) { oauth.state = { kind: isMissing(error) ? "missing" : "invalid" }; }
    return oauth;
  }

  get auth(): AuthState["kind"] { return this.state.kind; }

  async accessToken(): Promise<string> {
    if (this.state.kind === "invalid") throw new GmailError("auth_invalid", REAUTHORIZE);
    if (this.state.kind === "missing") throw new GmailError("auth_missing", "Gmail 尚未授权，请在宿主机运行 npm run gmail:login 后重启 sidecar");
    if (this.refreshing) return this.refreshing;
    if (this.state.token.expires_at - Date.now() >= 60_000) return this.state.token.access_token;
    this.refreshing = this.refresh(this.state.token);
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }

  private async refresh(previous: SavedToken): Promise<string> {
    try {
      const result = await tokenRequest(this.client, { grant_type: "refresh_token", refresh_token: previous.refresh_token });
      const token: SavedToken = {
        ...previous, access_token: result.access_token, refresh_token: result.refresh_token ?? previous.refresh_token,
        expires_at: Date.now() + result.expires_in * 1000, scope: result.scope ?? previous.scope,
      };
      await atomicJson(this.tokenFile, token);
      this.state = { kind: "ready", token };
      return token.access_token;
    } catch (error) {
      if (error instanceof GmailError && error.kind === "auth_invalid") this.state = { kind: "invalid" };
      throw error;
    }
  }
}
