import { DurableObject } from "cloudflare:workers";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { Env } from "./env";
import { MCP_CONFIG, isOAuthServer, publicOrigin, referencedSecret, type OAuthServer } from "./mcp/config";
import { TokenVault, randomSecret, sha256 } from "./mcp/crypto";
import { DiscoverySchema, discover, exchange, TokenRejected, type OAuthTokens } from "./mcp/oauth";
import { OAuthFailure } from "./mcp/oauth-fetch";
import { defaultSettings, effectiveSettings, settingsRevision, type Settings, type SettingsSnapshot } from "./settings";

type TokenRow = { server_id: string; account_id: string; revision: string; issuer: string; access_token: string; refresh_token: string | null; scope: string | null; expires_at: number | null; updated_at: number };
type LoginRow = { state: string; server_id: string; verifier: string; nonce_hash: string; created_at: number; expires_at: number };
export type McpStatus = { server: string; enabled: boolean; credential: "none" | "static" | "oauth"; login: "ok" | "needed" | "error" | "unconfigured" };
const Pending = Type.Object({ verifier: Type.String(), config: Type.String(), discovery: DiscoverySchema }, { additionalProperties: false });
const identity = (server: OAuthServer, field: string) => JSON.stringify([server.id, server.credential.accountId, server.credential.revision, field]);

export class RegistryDO extends DurableObject<Env> {
  private readonly vault = new TokenVault(this.env.OAUTH_STORE_KEY);
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly access = new Map<string, Promise<string | undefined>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
        server_id TEXT NOT NULL, account_id TEXT NOT NULL, revision TEXT NOT NULL, issuer TEXT NOT NULL,
        access_token TEXT NOT NULL, refresh_token TEXT, scope TEXT, expires_at INTEGER, updated_at INTEGER NOT NULL,
        PRIMARY KEY(server_id, account_id, revision));
      CREATE TABLE IF NOT EXISTS mcp_oauth_logins (
        state TEXT PRIMARY KEY, server_id TEXT NOT NULL, verifier TEXT NOT NULL, nonce_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_oauth_nonce ON mcp_oauth_logins(nonce_hash);
      CREATE TABLE IF NOT EXISTS mcp_oauth_client (server_id TEXT PRIMARY KEY, registration_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
  }

  // 一行保存整份覆盖值；revision 按有效内容计算，未覆盖时也能对默认值做 CAS。
  settings(): SettingsSnapshot {
    const row = this.ctx.storage.sql.exec<{ value: string; updated_at: number }>("SELECT value, updated_at FROM settings WHERE key = 'runtime'").toArray()[0];
    const overrides: Settings | null = row ? JSON.parse(row.value) : null, value = effectiveSettings(this.env, overrides);
    return { value, revision: settingsRevision(value), defaults: defaultSettings(this.env), overrides, updatedAt: row?.updated_at ?? null };
  }

  putSettings(value: Settings, expectedRevision: string): { ok: boolean; current: SettingsSnapshot } {
    const current = this.settings();
    if (current.revision !== expectedRevision) return { ok: false, current };
    this.ctx.storage.sql.exec(`INSERT INTO settings (key, value, revision, updated_at) VALUES ('runtime', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=excluded.revision, updated_at=excluded.updated_at`,
    JSON.stringify(value), settingsRevision(value), Date.now());
    return { ok: true, current: this.settings() };
  }

  private server(id: string): OAuthServer {
    const server = MCP_CONFIG.servers.find(server => server.id === id);
    if (!MCP_CONFIG.enabled || !server?.enabled || !isOAuthServer(server)) throw new OAuthFailure("server_unavailable");
    return server;
  }
  private lock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(id, run);
    const release = () => { if (this.locks.get(id) === run) this.locks.delete(id); };
    void run.then(release, release);
    return run;
  }
  private row(server: OAuthServer): TokenRow | undefined {
    return this.ctx.storage.sql.exec<TokenRow>("SELECT * FROM mcp_oauth_tokens WHERE server_id=? AND account_id=? AND revision=?",
      server.id, server.credential.accountId, server.credential.revision).toArray()[0];
  }
  private deleteToken(server: OAuthServer): void {
    this.ctx.storage.sql.exec("DELETE FROM mcp_oauth_tokens WHERE server_id=? AND account_id=? AND revision=?", server.id, server.credential.accountId, server.credential.revision);
  }
  private async save(server: OAuthServer, issuer: string, tokens: OAuthTokens, previous?: { refresh?: string; scope: string | null }): Promise<string> {
    const refresh = tokens.refresh_token ?? previous?.refresh;
    const access = await this.vault.encrypt(tokens.access_token, identity(server, "access"));
    const encryptedRefresh = refresh ? await this.vault.encrypt(refresh, identity(server, "refresh")) : null;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO mcp_oauth_tokens VALUES (?,?,?,?,?,?,?,?,?)", server.id, server.credential.accountId,
      server.credential.revision, issuer, access, encryptedRefresh, tokens.scope ?? previous?.scope ?? null,
      tokens.expires_in === undefined ? null : Date.now() + tokens.expires_in * 1000, Date.now());
    await this.ctx.storage.delete(`oauth_error:${server.id}`);
    return tokens.access_token;
  }

  async accessToken(serverId: string, rejectedToken?: string): Promise<string | undefined> {
    const server = this.server(serverId);
    if (!this.vault.configured) return undefined;
    // RPC 可在网络等待时交错；同一凭据的并发刷新共享结果，包括失败，避免耗尽旋转式 refresh token。
    const key = JSON.stringify([serverId, rejectedToken ?? null]);
    const existing = this.access.get(key);
    if (existing) return existing;
    const run = this.lock(serverId, async () => {
      const row = this.row(server);
      if (!row) throw new OAuthFailure("auth_required");
      const token = await this.vault.decrypt(row.access_token, identity(server, "access"));
      if (rejectedToken !== undefined && token !== rejectedToken) return token;
      if (rejectedToken === undefined && (row.expires_at === null || row.expires_at > Date.now() + 60_000)) return token;
      if (!row.refresh_token) {
        if (rejectedToken === undefined && row.expires_at !== null && row.expires_at > Date.now()) return token;
        throw new OAuthFailure("auth_required");
      }
      try {
        const refresh = await this.vault.decrypt(row.refresh_token, identity(server, "refresh"));
        const discovery = await discover(server, row.issuer);
        const tokens = await exchange(server, discovery, { grant_type: "refresh_token", refresh_token: refresh });
        return await this.save(server, row.issuer, tokens, { refresh, scope: row.scope });
      } catch (error) {
        if (error instanceof TokenRejected) {
          this.deleteToken(server); await this.ctx.storage.put(`oauth_error:${serverId}`, "refresh_failed");
          throw new OAuthFailure("auth_required");
        }
        throw error instanceof OAuthFailure ? error : new OAuthFailure("oauth_token");
      }
    });
    this.access.set(key, run);
    try { return await run; } finally { if (this.access.get(key) === run) this.access.delete(key); }
  }

  async loginLink(serverId: string): Promise<{ url: string }> {
    const server = this.server(serverId);
    if (!this.vault.configured) throw new OAuthFailure("unconfigured");
    const origin = publicOrigin(this.env.PUBLIC_ORIGIN);
    return this.lock(server.id, async () => {
      const nonce = randomSecret(), state = randomSecret(), now = Date.now();
      const hash = (await sha256(nonce)).toString("hex");
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM mcp_oauth_logins WHERE expires_at<=? OR server_id=?", now, server.id);
        this.ctx.storage.sql.exec("INSERT INTO mcp_oauth_logins VALUES (?,?,?,?,?,?)", state, server.id, "", hash, now, now + 600_000);
      });
      return { url: `${origin}/mcp/oauth/start?nonce=${encodeURIComponent(nonce)}` };
    });
  }

  async startLogin(nonce: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new OAuthFailure("invalid_state");
    const hash = (await sha256(nonce)).toString("hex");
    // 先消费 nonce 再联网，授权失败也不能重复使用同一管理链接。
    const row = this.ctx.storage.sql.exec<LoginRow>("UPDATE mcp_oauth_logins SET nonce_hash='' WHERE nonce_hash=? AND expires_at>? RETURNING *", hash, Date.now()).toArray()[0];
    if (!row) throw new OAuthFailure("invalid_state");
    return this.lock(row.server_id, async () => {
      try {
        const server = this.server(row.server_id), discovery = await discover(server), verifier = randomSecret();
        const saved = await this.vault.encrypt(JSON.stringify({ verifier, config: JSON.stringify(server), discovery }), `login:${row.state}`);
        const updated = this.ctx.storage.sql.exec("UPDATE mcp_oauth_logins SET verifier=? WHERE state=? AND expires_at>? RETURNING state", saved, row.state, Date.now()).toArray();
        if (!updated.length) throw new OAuthFailure("invalid_state");
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO mcp_oauth_client VALUES (?,?)", server.id,
          JSON.stringify({ client_id: server.credential.clientMetadataUrl, issuer: discovery.issuer, token_endpoint_auth_method: "none" }));
        const url = new URL(discovery.authorization);
        for (const [key, value] of Object.entries({ response_type: "code", client_id: server.credential.clientMetadataUrl,
          redirect_uri: `${publicOrigin(this.env.PUBLIC_ORIGIN)}/mcp/oauth/callback`, state: row.state,
          code_challenge: (await sha256(verifier)).toString("base64url"), code_challenge_method: "S256", resource: discovery.resource,
          ...(server.credential.scope ? { scope: server.credential.scope } : {}) })) url.searchParams.set(key, value);
        return url.href;
      } catch (error) {
        this.ctx.storage.sql.exec("DELETE FROM mcp_oauth_logins WHERE state=?", row.state);
        throw error instanceof OAuthFailure ? error : new OAuthFailure("oauth_metadata");
      }
    });
  }

  async completeLogin(state: string, code: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new OAuthFailure("invalid_state");
    const pending = this.ctx.storage.sql.exec<LoginRow>("SELECT * FROM mcp_oauth_logins WHERE state=?", state).toArray()[0];
    if (!pending) throw new OAuthFailure("invalid_state");
    return this.lock(pending.server_id, async () => {
      const row = this.ctx.storage.sql.exec<LoginRow>("DELETE FROM mcp_oauth_logins WHERE state=? RETURNING *", state).toArray()[0];
      if (!row || row.expires_at <= Date.now() || !row.verifier || row.nonce_hash || !code || code.length > 8192) throw new OAuthFailure("invalid_state");
      try {
        const server = this.server(row.server_id);
        const saved: unknown = JSON.parse(await this.vault.decrypt(row.verifier, `login:${state}`));
        if (!Check(Pending, saved) || saved.config !== JSON.stringify(server)) throw new OAuthFailure("invalid_state");
        const tokens = await exchange(server, saved.discovery, { grant_type: "authorization_code", code,
          code_verifier: saved.verifier, redirect_uri: `${publicOrigin(this.env.PUBLIC_ORIGIN)}/mcp/oauth/callback` });
        await this.save(server, saved.discovery.issuer, tokens);
        return server.id;
      } catch (error) { throw error instanceof OAuthFailure ? error : new OAuthFailure("oauth_token"); }
    });
  }

  async logout(serverId: string): Promise<void> {
    const server = this.server(serverId);
    await this.lock(server.id, async () => {
      this.deleteToken(server);
      this.ctx.storage.sql.exec("DELETE FROM mcp_oauth_logins WHERE server_id=?", server.id);
      await this.ctx.storage.delete(`oauth_error:${serverId}`);
    });
  }

  async status(): Promise<McpStatus[]> {
    return Promise.all(MCP_CONFIG.servers.map(async server => {
      let login: McpStatus["login"] = "ok";
      if (isOAuthServer(server)) {
        if (!this.vault.configured) login = "unconfigured";
        else {
          const row = this.row(server);
          login = await this.ctx.storage.get(`oauth_error:${server.id}`) ? "error" : !row || (row.expires_at !== null && row.expires_at <= Date.now() && !row.refresh_token) ? "needed" : "ok";
          if (row) try { await this.vault.decrypt(row.access_token, identity(server, "access")); } catch { login = "error"; }
        }
      } else if (server.credential.kind === "external-account" && Object.values(server.transport.secretHeaders).some(ref => !referencedSecret(this.env, ref))) login = "unconfigured";
      return { server: server.id, enabled: MCP_CONFIG.enabled && server.enabled,
        credential: server.credential.kind === "external-account" ? "static" : server.credential.kind, login };
    }));
  }
}
