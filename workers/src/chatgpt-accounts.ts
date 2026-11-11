import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { TokenVault, randomSecret, sha256 } from "./mcp/crypto";
import { refreshNeedsReauth, type RefreshFailure } from "./codex-refresh-error";
import { CatalogFailureSchema, catalogFailure, type CatalogFailure } from "./codex-catalog-error";
import { SqlCredentialStore, type CredentialMeta, type CredentialLease } from "./model-credentials";
import { CODEX_PROVIDER, LOGIN_TTL_MS, ModelLoginError, PendingSchema, acceptTokens, callbackClient,
  codexOAuth, fetchCatalog, isChatGPTCredential, isNativeCodexCredential, revokeSession, startChatGPTLogin } from "./codex-login";

export const CHATGPT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chatgpt_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS chatgpt_accounts (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, subject TEXT NOT NULL,
    email TEXT, created_at INTEGER NOT NULL, UNIQUE(client_id, subject));
  CREATE TABLE IF NOT EXISTS chatgpt_logins (ticket_hash TEXT PRIMARY KEY, pending_enc TEXT NOT NULL, expires_at INTEGER NOT NULL);
`;
type Account = { id: string; client_id: string; subject: string; email: string | null; created_at: number };
const DraftSchema = Type.Object({ accountId: Type.Optional(Type.String()) });
type LoginStatus = "logged_out" | "ready" | "refresh_due" | "refresh_failed" | "reauth_required" | "catalog_pending";
export type ChatGPTView = {
  status: LoginStatus; loggedIn: boolean; hasCredential: boolean; needsReauth: boolean;
  activeId?: string; flow?: string; imageGeneration: boolean; email?: string; expiresAt?: number; refreshFailure?: RefreshFailure;
  catalogFailure?: CatalogFailure;
  accounts: { id: string; label: string; loggedIn: boolean; status: LoginStatus; catalogFailure?: CatalogFailure }[];
};
function loginStatus(meta?: CredentialMeta): LoginStatus {
  if (!meta) return "logged_out";
  if (meta.refreshFailure) return refreshNeedsReauth(meta.refreshFailure) ? "reauth_required" : "refresh_failed";
  return (meta.expiresAt ?? 0) <= Date.now() + 300_000 ? "refresh_due" : "ready";
}
const accountKey = (id: string) => "chatgpt:" + id;

export class ChatGPTAccounts {
  readonly store: CredentialStore = {
    read: provider => this.credentials.read(this.key(provider)),
    list: async () => (await this.credentials.list()).filter(item => !item.providerId.startsWith("chatgpt:") && item.providerId !== CODEX_PROVIDER)
      .concat(this.activeId() && this.credentials.meta(this.key(CODEX_PROVIDER)) ? [{ providerId: CODEX_PROVIDER, type: "oauth" }] : []),
    modify: (provider, fn) => this.credentials.modify(this.key(provider), fn),
    delete: provider => this.credentials.delete(this.key(provider)),
  };
  constructor(private readonly sql: SqlStorage, private readonly vault: TokenVault, private readonly credentials: SqlCredentialStore) {}
  private state(key: string): string | undefined {
    return this.sql.exec<{ value: string }>("SELECT value FROM chatgpt_state WHERE key = ?", key).toArray()[0]?.value || undefined;
  }
  private setState(key: string, value: string) { this.sql.exec("INSERT OR REPLACE INTO chatgpt_state VALUES (?, ?)", key, value); }
  private catalogFailure(id: string): CatalogFailure | undefined {
    const raw = this.state("catalog:" + id);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    return Check(CatalogFailureSchema, value) ? value : undefined;
  }
  private activeId() { return this.state("active"); }
  private key(provider: string) { return provider === CODEX_PROVIDER ? accountKey(this.activeId() ?? "unselected") : provider; }
  private account(id: string): Account {
    const account = this.sql.exec<Account>("SELECT * FROM chatgpt_accounts WHERE id = ?", id).toArray()[0];
    if (!account) throw new ModelLoginError("login_required");
    return account;
  }
  private hostId(): string {
    const saved = this.state("host");
    if (saved) return saved;
    const id = "urn:uuid:" + crypto.randomUUID();
    this.setState("host", id);
    return id;
  }
  view(): ChatGPTView {
    const activeId = this.activeId(), meta = activeId ? this.credentials.meta(accountKey(activeId)) : undefined;
    const status = !meta && this.credentials.meta(CODEX_PROVIDER) ? "reauth_required" : loginStatus(meta);
    return { status, loggedIn: status === "ready", hasCredential: !!meta, needsReauth: status === "reauth_required",
      activeId, catalogFailure: activeId ? this.catalogFailure(activeId) : undefined, flow: meta?.flow, imageGeneration: !!meta && meta.flow === "codex-native" && (!meta.refreshFailure || !refreshNeedsReauth(meta.refreshFailure)), email: meta?.email, expiresAt: meta?.expiresAt, refreshFailure: meta?.refreshFailure,
      accounts: this.sql.exec<Account>("SELECT * FROM chatgpt_accounts ORDER BY created_at, id").toArray().map(account => {
        const meta = this.credentials.meta(accountKey(account.id)), failure = this.catalogFailure(account.id);
        const status = loginStatus(meta), displayStatus = status === "ready" && account.id !== activeId && failure ? "catalog_pending" : status;
        return { id: account.id, label: (meta?.flow === "codex-native" ? "Codex · " : "旧授权 · ") + (account.email ?? "ChatGPT 账号") + " · " + account.id.slice(0, 8),
          loggedIn: displayStatus === "ready", status: displayStatus, catalogFailure: failure };
      }) };
  }
  async acquire(provider: string): Promise<CredentialLease> {
    const key = this.key(provider), result = await this.credentials.acquire(key);
    return { ...result, lease: key + "|" + result.lease };
  }
  settle(provider: string, lease: string, updatedAt: number | null, next?: Credential, failure?: RefreshFailure) {
    const separator = lease.indexOf("|"), key = lease.slice(0, separator);
    if (separator < 0 || (provider === CODEX_PROVIDER ? !key.startsWith("chatgpt:") : key !== provider))
      throw new ModelLoginError("invalid_state");
    // 租约携带当时选中的存储键，切换账号后的刷新仍写回原账号。
    return this.credentials.settle(key, lease.slice(separator + 1), updatedAt, next, failure);
  }
  async start(accountId?: string) {
    if (!this.vault.configured) throw new ModelLoginError("unconfigured");
    if (accountId) this.account(accountId);
    const ticket = randomSecret(), hash = (await sha256(ticket)).toString("hex"), expiresAt = Date.now() + LOGIN_TTL_MS;
    const encrypted = await this.vault.encrypt(JSON.stringify({ accountId }), hash);
    this.sql.exec("DELETE FROM chatgpt_logins");
    this.sql.exec("INSERT INTO chatgpt_logins VALUES (?, ?, ?)", hash, encrypted, expiresAt);
    return { ticket, expiresAt };
  }
  private async consume(ticket: string) {
    const hash = (await sha256(ticket)).toString("hex");
    const row = this.sql.exec<{ pending_enc: string; expires_at: number }>(
      "DELETE FROM chatgpt_logins WHERE ticket_hash = ? RETURNING pending_enc, expires_at", hash).toArray()[0];
    if (!row || row.expires_at <= Date.now()) throw new ModelLoginError("invalid_state");
    const value: unknown = JSON.parse(await this.vault.decrypt(row.pending_enc, hash));
    return { hash, value, expiresAt: row.expires_at };
  }
  async begin(ticket: string, port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ModelLoginError("invalid_callback");
    const { hash, value, expiresAt } = await this.consume(ticket);
    if (!Check(DraftSchema, value) || Check(PendingSchema, value)) throw new ModelLoginError("invalid_state");
    const account = value.accountId ? this.account(value.accountId) : undefined;
    const credential = account ? await this.credentials.read(accountKey(account.id)) : undefined;
    const { pending, url } = await startChatGPTLogin(this.hostId(), port, account ? {
      id: account.id, clientId: account.client_id, subject: account.subject, email: account.email ?? undefined,
      ...(isChatGPTCredential(credential) ? { idToken: credential.idToken } : {}),
      ...(isNativeCodexCredential(credential) ? { workspaceId: credential.accountId } : {}),
    } : undefined);
    const encrypted = await this.vault.encrypt(JSON.stringify(pending), hash);
    this.sql.exec("INSERT INTO chatgpt_logins VALUES (?, ?, ?)", hash, encrypted, expiresAt);
    // 只有本机助手持有的一次性票据能读到 PKCE；管理页面不会收到令牌或带 ID token 的 URL。
    return { url, verifier: pending.verifier, redirectUri: pending.redirectUri, state: pending.state, clientId: pending.clientId, expiresAt };
  }
  async complete(ticket: string, callbackUrl: string, tokens: unknown) {
    const { value } = await this.consume(ticket);
    if (!Check(PendingSchema, value)) throw new ModelLoginError("invalid_state");
    const clientId = callbackClient(callbackUrl, value);
    const credential = await acceptTokens(tokens, clientId, value);
    const existing = this.sql.exec<Account>("SELECT * FROM chatgpt_accounts WHERE client_id = ? AND subject = ?", clientId, credential.subject).toArray()[0];
    const id = value.accountId ?? existing?.id ?? crypto.randomUUID();
    // 身份验证通过即加密保存；目录请求失败不能丢弃一次性授权结果。
    await this.credentials.modify(accountKey(id), async current => ({ ...credential,
      catalog: isNativeCodexCredential(current) && isNativeCodexCredential(credential) && current.accountId === credential.accountId ? current.catalog : [] }));
    this.sql.exec("INSERT INTO chatgpt_accounts VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email",
      id, clientId, credential.subject, credential.email ?? null, Date.now());
    try { await this.refreshCatalog(id); } catch (error) {
      const diagnostic = catalogFailure(error);
      if (!diagnostic) throw error;
      return { accountId: id, email: credential.email, status: "catalog_pending" as const, diagnostic };
    }
    this.setState("active", id);
    await this.credentials.delete(CODEX_PROVIDER);
    return { accountId: id, email: credential.email, status: "ready" as const };
  }
  async select(id: string) {
    this.account(id);
    await this.refreshCatalog(id);
    this.setState("active", id);
  }
  async refreshCatalog(id = this.activeId()) {
    if (!id) throw new ModelLoginError("login_required");
    await this.credentials.modify(accountKey(id), async current => {
      if (!isChatGPTCredential(current)) throw new ModelLoginError("login_required");
      return current.expires <= Date.now() + 300_000 ? await codexOAuth.refresh(current, AbortSignal.timeout(15_000)) : undefined;
    });
    // 先保存轮换后的 refresh token，再读取目录；目录故障不能丢掉唯一有效的新令牌。
    try {
      await this.credentials.modify(accountKey(id), async current => {
        if (!isChatGPTCredential(current)) throw new ModelLoginError("login_required");
        return { ...current, catalog: await fetchCatalog(current) };
      });
      this.sql.exec("DELETE FROM chatgpt_state WHERE key = ?", "catalog:" + id);
    } catch (error) {
      const diagnostic = catalogFailure(error);
      if (diagnostic) this.setState("catalog:" + id, JSON.stringify(diagnostic));
      throw error;
    }
  }
  async logout() {
    const id = this.activeId();
    this.setState("active", "");
    this.sql.exec("DELETE FROM chatgpt_logins");
    if (!id) { await this.credentials.delete(CODEX_PROVIDER); return { revoked: true }; }
    let revoked = false;
    await this.credentials.modify(accountKey(id), async current => {
      revoked = isChatGPTCredential(current) ? await revokeSession(current) : true;
      return undefined;
    });
    await this.credentials.delete(accountKey(id));
    this.sql.exec("DELETE FROM chatgpt_state WHERE key = ?", "catalog:" + id);
    return { revoked };
  }
}
