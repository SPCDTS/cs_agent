import { Type } from "typebox";
import { Check } from "typebox/value";
import { TokenVault } from "../mcp/crypto";
import { GmailError, requestJson, statusError } from "./http";

type GmailSecrets = { GMAIL_CLIENT_ID?: string; GMAIL_CLIENT_SECRET?: string; GMAIL_REFRESH_TOKEN?: string; OAUTH_STORE_KEY?: string };
const TokenResponse = Type.Object({ access_token: Type.String({ minLength: 1 }), expires_in: Type.Number({ exclusiveMinimum: 0 }) });
// AAD 绑定用途，表里的密文不能被挪作 MCP 或其他账号的 token。
const IDENTITY = JSON.stringify(["gmail", "owner", "access"]);

/** access token 加密缓存在 EventsDO；refresh token 只在 Worker secret，不落库。 */
export class GmailAuth {
  private readonly vault: TokenVault;
  private refreshing?: Promise<string>;
  constructor(private readonly sql: SqlStorage, private readonly secrets: GmailSecrets) {
    this.vault = new TokenVault(secrets.OAUTH_STORE_KEY);
  }
  configured(): boolean {
    return !!(this.secrets.GMAIL_CLIENT_ID && this.secrets.GMAIL_CLIENT_SECRET && this.secrets.GMAIL_REFRESH_TOKEN) && this.vault.configured;
  }
  async accessToken(): Promise<string> {
    if (!this.configured()) throw new GmailError("auth");
    const row = this.sql.exec<{ access_token_enc: string; expires_at: number }>("SELECT access_token_enc, expires_at FROM gmail_auth WHERE id = 'owner'").toArray()[0];
    if (row && row.expires_at - Date.now() >= 60_000) {
      try { return await this.vault.decrypt(row.access_token_enc, IDENTITY); } catch { this.invalidate(); }
    }
    // 并发调用共享同一次刷新，避免同时打 token 端点。
    return this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined; });
  }
  invalidate(): void {
    this.sql.exec("DELETE FROM gmail_auth WHERE id = 'owner'");
  }
  private async refresh(): Promise<string> {
    const response = await requestJson(new URL("https://oauth2.googleapis.com/token"), { method: "POST", body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: this.secrets.GMAIL_REFRESH_TOKEN ?? "",
      client_id: this.secrets.GMAIL_CLIENT_ID ?? "", client_secret: this.secrets.GMAIL_CLIENT_SECRET ?? "",
    }) });
    // 4xx（含 invalid_grant）意味着需要重新授权；5xx 不能当成授权失效。
    if (response.status >= 400 && response.status < 500) throw new GmailError("auth");
    if (response.status !== 200) throw statusError(response.status);
    if (!Check(TokenResponse, response.body)) throw new GmailError("response");
    const { access_token, expires_in } = response.body;
    this.sql.exec("INSERT OR REPLACE INTO gmail_auth (id, access_token_enc, expires_at) VALUES ('owner', ?, ?)",
      await this.vault.encrypt(access_token, IDENTITY), Date.now() + expires_in * 1000);
    return access_token;
  }
}
