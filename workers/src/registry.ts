import { DurableObject } from "cloudflare:workers";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { Credential } from "@earendil-works/pi-ai";
import type { Env } from "./env";
import { MCP_CONFIG, isOAuthServer, publicOrigin, referencedSecret, type OAuthServer } from "./mcp/config";
import { TokenVault, randomSecret, sha256 } from "./mcp/crypto";
import { DiscoverySchema, discover, exchange, TokenRejected, type OAuthTokens } from "./mcp/oauth";
import { OAuthFailure } from "./mcp/oauth-fetch";
import { defaultSettings, effectiveSettings, settingsRevision, type ModelSelection, type Settings, type SettingsSnapshot } from "./settings";
import { MODEL_CREDENTIALS_SCHEMA, SqlCredentialStore, type CredentialLease } from "./model-credentials";
import { openModels, providerStatuses, selectionProblem, type ProviderStatus } from "./models";
import { CODEX_PROVIDER, LOGIN_TTL_MS, ModelLoginError, exchangeCode, parseCallback, startCodexLogin } from "./codex-login";
import type { ImageAvailability } from "./tools/generate-image";
import { SKILLS_SCHEMA, type Skill, type SkillInput, type SkillSummary } from "./skills";

type TokenRow = { server_id: string; account_id: string; revision: string; issuer: string; access_token: string; refresh_token: string | null; scope: string | null; expires_at: number | null; updated_at: number };
type LoginRow = { state: string; server_id: string; verifier: string; nonce_hash: string; created_at: number; expires_at: number };
export type McpStatus = { server: string; enabled: boolean; credential: "none" | "static" | "oauth"; login: "ok" | "needed" | "error" | "unconfigured" };
const Pending = Type.Object({ verifier: Type.String(), config: Type.String(), discovery: DiscoverySchema }, { additionalProperties: false });
const identity = (server: OAuthServer, field: string) => JSON.stringify([server.id, server.credential.accountId, server.credential.revision, field]);
type ModelLoginRow = { state: string; provider_id: string; verifier_enc: string; created_at: number; expires_at: number };
export type ModelView = { current: ModelSelection; revision: string; providers: ProviderStatus[]; codex: { loggedIn: boolean; email?: string; expiresAt?: number };
  imageGeneration: ImageAvailability };
export type ModelStatus = (ModelSelection & { codexLoggedIn: boolean }) | { unavailable: string };
export type PutSettingsResult = { ok: true; current: SettingsSnapshot } | { ok: false; error: "conflict"; current: SettingsSnapshot } | { ok: false; error: "invalid_model"; reason: string };

export class RegistryDO extends DurableObject<Env> {
  private readonly vault = new TokenVault(this.env.OAUTH_STORE_KEY);
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly access = new Map<string, Promise<string | undefined>>();
  private readonly credentials = new SqlCredentialStore(this.ctx.storage.sql, this.vault);
  private readonly models = openModels(this.env, this.credentials);

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
      ${MODEL_CREDENTIALS_SCHEMA};
      CREATE TABLE IF NOT EXISTS model_logins (state TEXT PRIMARY KEY, provider_id TEXT NOT NULL, verifier_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      ${SKILLS_SCHEMA};
    `);
  }

  // 技能目录只经面板写入；Thread 读目录与正文。
  skillsList(): SkillSummary[] {
    return this.ctx.storage.sql.exec<{ name: string; description: string; files_json: string; enabled: number; updated_at: number }>(
      "SELECT name, description, files_json, enabled, updated_at FROM skills ORDER BY name").toArray()
      .map(row => ({ name: row.name, description: row.description, enabled: row.enabled === 1, updatedAt: row.updated_at, files: Object.keys(JSON.parse(row.files_json)) }));
  }

  skillGet(name: string): Skill | undefined {
    const row = this.ctx.storage.sql.exec<{ name: string; description: string; body: string; files_json: string; enabled: number; updated_at: number }>(
      "SELECT * FROM skills WHERE name = ?", name).toArray()[0];
    return row && { name: row.name, description: row.description, body: row.body, files: JSON.parse(row.files_json), enabled: row.enabled === 1, updatedAt: row.updated_at };
  }

  /** 覆盖写入保留启用状态；files 省略时保留已有附件。 */
  skillPut(skill: SkillInput): SkillSummary {
    const files = skill.files === undefined ? null : JSON.stringify(skill.files), now = Date.now();
    this.ctx.storage.sql.exec(`INSERT INTO skills (name, description, body, files_json, updated_at) VALUES (?, ?, ?, COALESCE(?, '{}'), ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, body = excluded.body, files_json = COALESCE(?, files_json), updated_at = excluded.updated_at`,
    skill.name, skill.description, skill.body, files, now, files);
    return this.skillsList().find(summary => summary.name === skill.name)!;
  }

  skillDelete(name: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM skills WHERE name = ? RETURNING name", name).toArray().length > 0;
  }

  skillSetEnabled(name: string, enabled: boolean): boolean {
    return this.ctx.storage.sql.exec("UPDATE skills SET enabled = ?, updated_at = ? WHERE name = ? RETURNING name", enabled ? 1 : 0, Date.now(), name).toArray().length > 0;
  }

  /** 只由启用技能的名称与描述决定，Thread 据此判断目录是否需要重新渲染。 */
  async skillsDigest(): Promise<string> {
    const rows = this.ctx.storage.sql.exec<{ name: string; description: string }>("SELECT name, description FROM skills WHERE enabled = 1 ORDER BY name").toArray();
    return (await sha256(JSON.stringify(rows.map(row => [row.name, row.description])))).toString("hex").slice(0, 16);
  }

  // 一行保存整份覆盖值；revision 按有效内容计算，未覆盖时也能对默认值做 CAS。
  settings(): SettingsSnapshot {
    const row = this.ctx.storage.sql.exec<{ value: string; updated_at: number }>("SELECT value, updated_at FROM settings WHERE key = 'runtime'").toArray()[0];
    const defaults = defaultSettings(this.env);
    // 加入 model 之前保存的行没有这一项，沿用 vars 的默认模型。
    const overrides: Settings | null = row ? { model: defaults.model, ...JSON.parse(row.value) } : null, value = effectiveSettings(this.env, overrides);
    return { value, revision: settingsRevision(value), defaults, overrides, updatedAt: row?.updated_at ?? null };
  }

  /** 模型变了才校验可用性：已选的模型登出后，仍要能保存群与白名单等其他设置。 */
  async putSettings(value: Settings, expectedRevision: string): Promise<PutSettingsResult> {
    const before = this.settings().value.model;
    if (value.model.provider !== before.provider || value.model.id !== before.id) {
      const reason = selectionProblem(await this.providers(), value.model);
      if (reason) return { ok: false, error: "invalid_model", reason };
    }
    // 校验期间可能有别的保存插进来，CAS 放在 await 之后同步完成。
    const current = this.settings();
    if (current.revision !== expectedRevision) return { ok: false, error: "conflict", current };
    this.ctx.storage.sql.exec(`INSERT INTO settings (key, value, revision, updated_at) VALUES ('runtime', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=excluded.revision, updated_at=excluded.updated_at`,
    JSON.stringify(value), settingsRevision(value), Date.now());
    return { ok: true, current: this.settings() };
  }

  private async providers(): Promise<ProviderStatus[]> {
    const statuses = await providerStatuses(this.models);
    return statuses.map(status => status.id === CODEX_PROVIDER && !this.vault.configured ? { ...status, reason: "unconfigured" } : status);
  }

  async modelView(): Promise<ModelView> {
    const settings = this.settings(), meta = this.credentials.meta(CODEX_PROVIDER);
    return { current: settings.value.model, revision: settings.revision, providers: await this.providers(),
      codex: { loggedIn: meta !== undefined, ...(meta?.email ? { email: meta.email } : {}), ...(meta?.expiresAt ? { expiresAt: meta.expiresAt } : {}) },
      imageGeneration: await this.ctx.storage.get<ImageAvailability>("image_generation") ?? "unknown" };
  }

  /** 订阅能不能生成图片只有真实调用才知道；Thread 每次成功或被后端拒绝后回写。 */
  async recordImageGeneration(state: Exclude<ImageAvailability, "unknown">): Promise<void> {
    await this.ctx.storage.put("image_generation", state);
  }

  async modelStatus(): Promise<ModelStatus> {
    const view = await this.modelView(), problem = selectionProblem(view.providers, view.current);
    return problem ? { unavailable: `${view.current.provider}/${view.current.id}: ${problem}` } : { ...view.current, codexLoggedIn: view.codex.loggedIn };
  }

  // Thread 侧 CredentialStore 的 RPC；凭据只在 Worker 内部的 DO 之间传递，不经任何 HTTP 响应。
  credentialRead(providerId: string) { return this.credentials.read(providerId); }
  credentialList() { return this.credentials.list(); }
  credentialDelete(providerId: string) { return this.credentials.delete(providerId); }
  credentialAcquire(providerId: string): Promise<CredentialLease> { return this.credentials.acquire(providerId); }
  credentialSettle(providerId: string, lease: string, expectedUpdatedAt: number | null, next?: Credential) {
    return this.credentials.settle(providerId, lease, expectedUpdatedAt, next);
  }

  /** 每个 provider 只留一条待完成登录；verifier 加密保存，AAD 绑定 state。 */
  async codexLoginStart(): Promise<{ url: string }> {
    if (!this.vault.configured) throw new ModelLoginError("unconfigured");
    const pending = await startCodexLogin(), now = Date.now();
    const verifier = await this.vault.encrypt(pending.verifier, `model-login:${pending.state}`);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM model_logins WHERE expires_at <= ? OR provider_id = ?", now, CODEX_PROVIDER);
      this.ctx.storage.sql.exec("INSERT INTO model_logins VALUES (?, ?, ?, ?, ?)", pending.state, CODEX_PROVIDER, verifier, now, now + LOGIN_TTL_MS);
    });
    return { url: pending.url };
  }

  /** state 在换 token 之前就消费掉，失败也不能用同一个回调地址重试。 */
  async codexLoginComplete(callbackUrl: string): Promise<{ email?: string }> {
    const { code, state } = parseCallback(callbackUrl);
    const row = this.ctx.storage.sql.exec<ModelLoginRow>("DELETE FROM model_logins WHERE state = ? RETURNING *", state).toArray()[0];
    if (!row || row.expires_at <= Date.now()) throw new ModelLoginError("invalid_state");
    let verifier: string;
    try { verifier = await this.vault.decrypt(row.verifier_enc, `model-login:${state}`); } catch { throw new ModelLoginError("invalid_state"); }
    const credential = await exchangeCode(code, verifier);
    await this.credentials.modify(row.provider_id, async () => credential);
    return credential.email ? { email: credential.email } : {};
  }

  async codexLogout(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM model_logins WHERE provider_id = ?", CODEX_PROVIDER);
    await this.credentials.delete(CODEX_PROVIDER);
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
