import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { auth, discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, discoverOAuthServerInfo, refreshAuthorization, selectClientAuthMethod,
  type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { registerSecrets } from "../../shared/redact.js";
import type { McpServerConfig } from "./config.js";
import { McpConnectionError } from "./transport-http.js";
import { createOAuthFetch, validateOAuthRedirect } from "./oauth-fetch.js";
import { McpOAuthStore, type AccountKey, type OAuthFailure, type OAuthPending } from "./oauth-store.js";

type OAuthServer = McpServerConfig & { credential: Extract<McpServerConfig["credential"], { kind: "oauth" }> };
type Flow = { state: string; authorizationUrl?: string; consumed?: OAuthPending };
type EventKind = "oauth_login" | "oauth_logout" | "oauth_refreshed" | "oauth_refresh_failed" | "oauth_required";
type Options = { dataDir: string; redirectUrl: string; servers: readonly McpServerConfig[]; allowLoopbackHttp?: boolean;
  resolve?: Parameters<typeof createOAuthFetch>[0]["resolve"];
  onEvent?: (kind: EventKind, detail: AccountKey & { code?: OAuthFailure }) => void };
type TokenRow = NonNullable<ReturnType<McpOAuthStore["token"]>>;
export type McpAccessToken = Pick<TokenRow, "access_token" | "version">;
export class McpOAuthError extends Error {
  constructor(readonly code: "invalid_state" | "server_unavailable" | "auth_required") { super(code); }
}
const accountKey = (server: OAuthServer): AccountKey => ({ serverId: server.id, accountId: server.credential.accountId, revision: server.credential.revision });
const hashCookie = (nonce: string) => createHash("sha256").update(nonce).digest("hex");
const sameIssuer = (a: string, b: string) => new URL(a).href.replace(/\/$/u, "") === new URL(b).href.replace(/\/$/u, "");
function oauthServer(server: McpServerConfig): server is OAuthServer { return server.credential.kind === "oauth"; }

/** 一个进程共享凭据与账号锁；每个 MCP 会话仍有自己的 SDK transport。 */
export class McpOAuth {
  readonly redirectUrl: string;
  private readonly store: McpOAuthStore;
  private readonly servers: Map<string, OAuthServer>;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly discovery = new Map<string, OAuthDiscoveryState>();
  private closing?: Promise<void>;

  constructor(private readonly options: Options) {
    this.redirectUrl = options.redirectUrl;
    this.servers = new Map(options.servers.filter(oauthServer).map(server => [server.id, server]));
    this.store = new McpOAuthStore(options.dataDir);
  }

  private server(id: string): OAuthServer {
    const server = this.servers.get(id);
    if (!server?.enabled || this.closing) throw new McpOAuthError("server_unavailable");
    return server;
  }
  private lock<T>(key: AccountKey, work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new McpOAuthError("server_unavailable"));
    const id = JSON.stringify(key), previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    this.locks.set(id, run);
    const release = () => { if (this.locks.get(id) === run) this.locks.delete(id); };
    void run.then(release, release);
    return run;
  }
  private event(server: OAuthServer, kind: EventKind, code?: OAuthFailure): void {
    this.options.onEvent?.(kind, { ...accountKey(server), ...(code ? { code } : {}) });
  }
  private failed(server: OAuthServer): void {
    this.store.deleteTokens(accountKey(server));
    this.store.setStatus(accountKey(server), "refresh_failed");
    this.event(server, "oauth_refresh_failed", "refresh_failed");
  }
  private required(server: OAuthServer): McpConnectionError {
    const key = accountKey(server);
    // 保留刷新失败的原因，避免被随后“需登录”的拒绝覆盖。
    if (this.store.status(key)?.last_error !== "refresh_failed") this.store.setStatus(key, "auth_required");
    this.event(server, "oauth_required", "auth_required");
    return new McpConnectionError("auth_required", "MCP 服务需要在面板登录外部账号");
  }
  private readTokens(key: AccountKey): OAuthTokens | undefined {
    const row = this.store.token(key);
    return row ? { access_token: row.access_token, refresh_token: row.refresh_token ?? undefined,
      issuer: row.issuer, token_type: row.token_type, scope: row.scope ?? undefined,
      expires_in: row.expires_at === null ? undefined : Math.max(0, (row.expires_at - Date.now()) / 1000) } : undefined;
  }

  private loginProvider(server: OAuthServer, flow: Flow): OAuthClientProvider {
    const key = accountKey(server), cacheKey = JSON.stringify(key), { credential } = server;
    const provider: OAuthClientProvider = {
      redirectUrl: this.redirectUrl,
      clientMetadataUrl: credential.registration === "cimd" ? credential.clientMetadataUrl : undefined,
      clientMetadata: { client_name: "cs-agent", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "none", ...(credential.scope ? { scope: credential.scope } : {}) },
      state: () => flow.state,
      clientInformation: () => {
        const issuer = this.discovery.get(cacheKey)?.authorizationServerUrl ?? this.store.token(key)?.issuer;
        const client = this.store.client(server.id, issuer);
        if (credential.registration === "cimd" ? client?.client_id !== credential.clientMetadataUrl : client?.client_id === credential.clientMetadataUrl) return undefined;
        return client;
      },
      saveClientInformation: client => {
        registerSecrets([client.client_secret]);
        if (!client.issuer) throw this.required(server);
        this.store.saveClient(server.id, { ...client, issuer: client.issuer });
      },
      tokens: () => this.readTokens(key),
      saveTokens: tokens => {
        registerSecrets([tokens.access_token, tokens.refresh_token, tokens.id_token]);
        if (!tokens.issuer) throw this.required(server);
        this.store.saveTokens(key, { ...tokens, issuer: tokens.issuer });
      },
      redirectToAuthorization: async url => {
        const issuer = this.discovery.get(cacheKey)?.authorizationServerUrl;
        if (!issuer) throw this.required(server);
        await validateOAuthRedirect(url, issuer, this.options.allowLoopbackHttp ?? false);
        flow.authorizationUrl = url.href;
      },
      saveCodeVerifier: verifier => {
        registerSecrets([verifier]);
        this.store.saveVerifier(flow.state, verifier);
      },
      codeVerifier: () => {
        const pending = flow.consumed ?? this.store.pending(flow.state);
        if (!pending?.code_verifier || pending.expires_at <= Date.now()) throw new McpOAuthError("invalid_state");
        return pending.code_verifier;
      },
      invalidateCredentials: scope => {
        if (scope === "tokens" || scope === "all") {
          this.store.deleteTokens(key);
        }
        if (scope === "client" || scope === "all") this.store.deleteClients(server.id);
        if (scope === "discovery" || scope === "all") this.discovery.delete(cacheKey);
        if (scope === "verifier" || scope === "all") this.store.saveVerifier(flow.state, "");
      },
      discoveryState: () => this.discovery.get(cacheKey),
      saveDiscoveryState: state => {
        // CIMD 模式不能悄悄触发 SDK 的 DCR 回退；管理员须显式切换 registration。
        if (credential.registration === "cimd" && state.authorizationServerMetadata?.client_id_metadata_document_supported !== true) throw this.required(server);
        this.validateEndpoints(server, state);
        this.discovery.set(cacheKey, state);
      },
    };
    return provider;
  }

  async accessToken(config: McpServerConfig): Promise<McpAccessToken> {
    const server = this.server(config.id);
    if (!oauthServer(config) || JSON.stringify(accountKey(server)) !== JSON.stringify(accountKey(config))) throw new McpOAuthError("server_unavailable");
    const key = accountKey(server);
    return this.lock(key, async () => {
      const row = this.store.token(key);
      if (!row || this.store.status(key)?.last_error === "refresh_failed") throw this.required(server);
      if (row.expires_at !== null && row.expires_at <= Date.now() + 60_000 && row.refresh_token) {
        return this.refresh(server, row);
      }
      if (row.expires_at !== null && row.expires_at <= Date.now()) throw this.required(server);
      return { access_token: row.access_token, version: row.version };
    });
  }

  async rejected(config: McpServerConfig, used: McpAccessToken): Promise<McpAccessToken> {
    const server = this.server(config.id), key = accountKey(server);
    return this.lock(key, async () => {
      const row = this.store.token(key);
      if (!row || this.store.status(key)?.last_error === "refresh_failed") throw this.required(server);
      // 其他连接已经轮换时复用新凭据，绝不能再用被拒绝请求对应的 refresh token。
      if (row.access_token !== used.access_token || row.version !== used.version) return { access_token: row.access_token, version: row.version };
      return this.refresh(server, row);
    });
  }

  authRequired(config: McpServerConfig, used: McpAccessToken): Promise<never> {
    const server = this.server(config.id), key = accountKey(server);
    return this.lock(key, async () => {
      const row = this.store.token(key);
      if (row?.access_token === used.access_token && row.version === used.version) throw this.required(server);
      // 迟到的拒绝只结束本次请求，不能污染其他连接刷新或重新登录后的账号状态。
      throw new McpConnectionError("auth_required", "MCP 服务需要在面板登录外部账号");
    });
  }

  private async refresh(server: OAuthServer, row: TokenRow): Promise<McpAccessToken> {
    if (!row.refresh_token) throw this.required(server);
    const key = accountKey(server), cacheKey = JSON.stringify(key);
    const oauthFetch = this.fetch(() => this.allowedOrigins(server));
    // SDK 会把非 OAuth 错误正文也包装为 ServerError；5xx 在解析前统一作为暂态错误。
    const fetchFn: FetchLike = async (url, init) => {
      const response = await oauthFetch(url, init);
      if (response.status >= 500) { await response.body?.cancel(); throw new McpConnectionError("transport_error", "OAuth 刷新暂时不可用"); }
      return response;
    };
    try {
      let info = this.discovery.get(cacheKey);
      if (!info) {
        // 不用 SDK 会吞掉 PRM 网络异常的组合发现；暂态错误必须原样进入本次失败分支。
        const resourceMetadata = await this.resourceMetadata(server, fetchFn);
        const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? new URL("/", server.transport.url).href;
        if (!sameIssuer(row.issuer, authorizationServerUrl)) throw this.required(server);
        const authorizationServerMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, { fetchFn });
        info = { resourceMetadata, authorizationServerUrl, authorizationServerMetadata };
      }
      if (!sameIssuer(row.issuer, info.authorizationServerUrl)) throw this.required(server);
      this.validateEndpoints(server, info);
      const client = this.store.client(server.id, row.issuer);
      if (!client?.issuer || !sameIssuer(client.issuer, row.issuer)) throw this.required(server);
      const resource = info.resourceMetadata?.resource;
      if (resource && !checkResourceAllowed({ requestedResource: server.transport.url, configuredResource: resource })) throw this.required(server);
      const tokens = await refreshAuthorization(info.authorizationServerUrl, { metadata: info.authorizationServerMetadata,
        clientInformation: client, refreshToken: row.refresh_token, resource, fetchFn });
      const saved = this.store.saveTokens(key, { ...tokens, issuer: row.issuer });
      this.discovery.set(cacheKey, info);
      this.event(server, "oauth_refreshed");
      return saved;
    } catch (error) {
      if (error instanceof OAuthError && !["server_error", "temporarily_unavailable"].includes(error.errorCode)) {
        this.failed(server); throw this.required(server);
      }
      if (error instanceof McpConnectionError) throw error;
      throw new McpConnectionError("transport_error", "OAuth 刷新暂时不可用");
    }
  }

  private fetch(allowedOrigins: () => readonly string[]): FetchLike {
    return createOAuthFetch({ allowedOrigins, allowLoopbackHttp: this.options.allowLoopbackHttp, resolve: this.options.resolve });
  }

  private async resourceMetadata(server: OAuthServer, fetchFn: FetchLike) {
    let missing = false;
    try {
      return await discoverOAuthProtectedResourceMetadata(server.transport.url, undefined, async (url, init) => {
        missing = false;
        const response = await fetchFn(url, init);
        missing = response.status === 404;
        return response;
      });
    } catch (error) {
      // 保留未实现 PRM 的服务回退到资源 origin；网络故障不能伪装成“不支持”。
      if (!missing) throw error;
      return undefined;
    }
  }

  private validateEndpoints(server: OAuthServer, info: OAuthDiscoveryState): void {
    const origins = [new URL(server.transport.url).origin, new URL(info.authorizationServerUrl).origin];
    const metadata = info.authorizationServerMetadata;
    if (!metadata) return;
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint,
      "revocation_endpoint" in metadata ? metadata.revocation_endpoint : undefined]) {
      if (typeof endpoint === "string" && !origins.includes(new URL(endpoint).origin)) throw this.required(server);
    }
    if (new URL(metadata.authorization_endpoint).origin !== origins[1]) throw this.required(server);
  }

  private async loginFetch(server: OAuthServer): Promise<FetchLike> {
    const cacheKey = JSON.stringify(accountKey(server)), origins = [new URL(server.transport.url).origin];
    const fetchFn = this.fetch(() => origins);
    let info = this.discovery.get(cacheKey);
    if (!info) {
      // PRM 只能从资源来源读取；解析出 issuer 之后才允许访问授权服务器。
      const resourceMetadata = await this.resourceMetadata(server, fetchFn);
      const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? new URL("/", server.transport.url).href;
      origins.push(new URL(authorizationServerUrl).origin);
      const authorizationServerMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, { fetchFn });
      info = { resourceMetadata, authorizationServerUrl, authorizationServerMetadata };
      if (server.credential.registration === "cimd" && authorizationServerMetadata?.client_id_metadata_document_supported !== true) throw this.required(server);
      this.validateEndpoints(server, info);
      this.discovery.set(cacheKey, info);
    } else origins.push(new URL(info.authorizationServerUrl).origin);
    return fetchFn;
  }

  allowedOrigins(server: McpServerConfig): readonly string[] {
    const origins = [new URL(server.transport.url).origin];
    if (oauthServer(server)) {
      const issuer = this.store.token(accountKey(server))?.issuer;
      if (issuer) origins.push(new URL(issuer).origin);
    }
    return [...new Set(origins)];
  }

  status() {
    return [...this.servers.values()].map(server => {
      const key = accountKey(server), row = this.store.token(key), status = this.store.status(key);
      return { ...key, issuer: row?.issuer, loggedIn: !!row && !status && (row.expires_at === null || row.expires_at > Date.now() || !!row.refresh_token),
        expiresAt: row?.expires_at ?? undefined, scope: row?.scope ?? undefined, hasRefresh: !!row?.refresh_token,
        lastError: status?.last_error ?? (!row || (row.expires_at !== null && row.expires_at <= Date.now() && !row.refresh_token) ? "auth_required" : undefined),
        lastErrorAt: status?.last_error_at };
    });
  }

  async start(serverId: string, cookieNonce: string): Promise<{ authorizationUrl: string } | { alreadyAuthorized: true }> {
    const server = this.server(serverId), key = accountKey(server);
    if (!cookieNonce) throw new McpOAuthError("invalid_state");
    return this.lock(key, async () => {
      const flow: Flow = { state: randomBytes(32).toString("base64url") }, now = Date.now();
      this.store.addPending({ state: flow.state, server_id: server.id, account_id: key.accountId, revision: key.revision,
        cookie_hash: hashCookie(cookieNonce), code_verifier: "", created_at: now, expires_at: now + 600_000 });
      try {
        const result = await auth(this.loginProvider(server, flow), { serverUrl: server.transport.url,
          scope: server.credential.scope, fetchFn: await this.loginFetch(server) });
        if (result === "AUTHORIZED") { this.store.deletePending(flow.state); return { alreadyAuthorized: true }; }
        if (!flow.authorizationUrl) throw this.required(server);
        return { authorizationUrl: flow.authorizationUrl };
      } catch {
        this.store.deletePending(flow.state); this.required(server); throw new McpOAuthError("auth_required");
      }
    });
  }

  async callback(input: { state: string; code?: string; error?: string; cookieNonce: string }): Promise<{ serverId: string }> {
    registerSecrets([input.code]);
    const pending = this.store.pending(input.state);
    if (!pending) throw new McpOAuthError("invalid_state");
    const key = { serverId: pending.server_id, accountId: pending.account_id, revision: pending.revision };
    return this.lock(key, async () => {
      // 在换码前原子消费；并发回调和刷新页面都不能重复使用同一个 code/verifier。
      const consumed = this.store.pending(input.state, true);
      if (!consumed || consumed.expires_at <= Date.now() || !input.cookieNonce ||
        !timingSafeEqual(Buffer.from(consumed.cookie_hash), Buffer.from(hashCookie(input.cookieNonce)))) throw new McpOAuthError("invalid_state");
      const server = this.server(consumed.server_id);
      if (server.credential.accountId !== consumed.account_id || server.credential.revision !== consumed.revision) throw new McpOAuthError("invalid_state");
      try {
        if (input.error || !input.code) throw this.required(server);
        const result = await auth(this.loginProvider(server, { state: consumed.state, consumed }), { serverUrl: server.transport.url,
          authorizationCode: input.code, scope: server.credential.scope, fetchFn: await this.loginFetch(server) });
        if (result !== "AUTHORIZED") throw this.required(server);
        this.store.clearStatus(key); this.event(server, "oauth_login");
        return { serverId: server.id };
      } catch { this.required(server); throw new McpOAuthError("auth_required"); }
    });
  }

  async logout(serverId: string): Promise<void> {
    const server = this.server(serverId), key = accountKey(server);
    await this.lock(key, async () => {
      const tokens = this.store.token(key);
      try {
        if (tokens?.refresh_token) {
          const signal = AbortSignal.timeout(3_000), oauthFetch = this.fetch(() => this.allowedOrigins(server));
          const fetchFn: FetchLike = (url, init) => oauthFetch(url, { ...init, signal });
          const info = this.discovery.get(JSON.stringify(key)) ?? await discoverOAuthServerInfo(server.transport.url, { fetchFn });
          const metadata = info.authorizationServerMetadata;
          const endpoint = metadata && "revocation_endpoint" in metadata ? metadata.revocation_endpoint : undefined;
          const client = this.store.client(server.id, tokens.issuer);
          if (endpoint && client?.issuer && sameIssuer(tokens.issuer, info.authorizationServerUrl) && sameIssuer(client.issuer, tokens.issuer)) {
            const body = new URLSearchParams({ token: tokens.refresh_token, token_type_hint: "refresh_token", client_id: client.client_id });
            const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
            const method = selectClientAuthMethod(client, metadata && "revocation_endpoint_auth_methods_supported" in metadata ? metadata.revocation_endpoint_auth_methods_supported ?? [] : []);
            if (method === "client_secret_basic" && client.client_secret) headers.set("authorization", `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`);
            else if (method === "client_secret_post" && client.client_secret) body.set("client_secret", client.client_secret);
            await fetchFn(endpoint, { method: "POST", headers, body });
          }
        }
      } catch { /* 撤销失败不妨碍本地退出；不回显服务端错误。 */ }
      finally {
        this.store.deleteTokens(key); this.store.clearStatus(key); this.store.deleteAccountPending(key);
        this.discovery.delete(JSON.stringify(key)); this.event(server, "oauth_logout");
      }
    });
  }

  close(): Promise<void> {
    return this.closing ??= Promise.allSettled([...this.locks.values()]).then(() => { this.store.close(); });
  }
}
