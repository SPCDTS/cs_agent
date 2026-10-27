import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { OAuthClientInformationSchema, type OAuthClientInformationMixed, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { registerSecrets } from "../../shared/redact.js";

export type AccountKey = { serverId: string; accountId: string; revision: string };
export type OAuthFailure = "auth_required" | "refresh_failed";
const tokenRow = z.object({ issuer: z.string(), access_token: z.string(), refresh_token: z.string().nullable(),
  token_type: z.string(), scope: z.string().nullable(), expires_at: z.number().nullable(), obtained_at: z.number(), updated_at: z.number(), version: z.number().int().nonnegative() });
const pendingRow = z.object({ state: z.string(), server_id: z.string(), account_id: z.string(), revision: z.string(),
  code_verifier: z.string(), cookie_hash: z.string(), created_at: z.number(), expires_at: z.number() });
export type OAuthPending = z.infer<typeof pendingRow>;
const statusRow = z.object({ last_error: z.enum(["auth_required", "refresh_failed"]), last_error_at: z.number() });
const keyArgs = (key: AccountKey) => [key.serverId, key.accountId, key.revision];
const WHERE_KEY = "server_id=? AND account_id=? AND revision=?";

/** 与 sqlite-migrate 一样在 IMMEDIATE 事务内幂等建表；网络操作绝不进入事务。 */
export class McpOAuthStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "mcp-oauth.sqlite"));
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          server_id TEXT NOT NULL, account_id TEXT NOT NULL, revision TEXT NOT NULL, issuer TEXT NOT NULL,
          access_token TEXT NOT NULL, refresh_token TEXT, token_type TEXT NOT NULL, scope TEXT, expires_at INTEGER,
          obtained_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(server_id, account_id, revision));
        CREATE TABLE IF NOT EXISTS oauth_clients (
          server_id TEXT NOT NULL, issuer TEXT NOT NULL, client_json TEXT NOT NULL, saved_at INTEGER NOT NULL,
          PRIMARY KEY(server_id, issuer));
        CREATE TABLE IF NOT EXISTS oauth_pending (
          state TEXT PRIMARY KEY, server_id TEXT NOT NULL, account_id TEXT NOT NULL, revision TEXT NOT NULL,
          code_verifier TEXT NOT NULL, cookie_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS oauth_status (
          server_id TEXT NOT NULL, account_id TEXT NOT NULL, revision TEXT NOT NULL, last_error TEXT, last_error_at INTEGER,
          PRIMARY KEY(server_id, account_id, revision));
      `);
      if (!this.db.prepare("PRAGMA table_info(oauth_tokens)").all().some(column => column.name === "version")) {
        this.db.exec("ALTER TABLE oauth_tokens ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      this.db.close(); throw error;
    }
  }

  token(key: AccountKey) {
    const row = this.db.prepare(`SELECT * FROM oauth_tokens WHERE ${WHERE_KEY}`).get(...keyArgs(key));
    if (!row) return;
    const value = tokenRow.parse(row);
    registerSecrets([value.access_token, value.refresh_token ?? undefined]);
    return value;
  }

  saveTokens(key: AccountKey, tokens: OAuthTokens & { issuer: string }) {
    registerSecrets([tokens.access_token, tokens.refresh_token, tokens.id_token]);
    const now = Date.now(), expires = tokens.expires_in === undefined ? null : now + tokens.expires_in * 1000;
    const saved = this.db.prepare(`INSERT INTO oauth_tokens
      (server_id,account_id,revision,issuer,access_token,refresh_token,token_type,scope,expires_at,obtained_at,updated_at,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(server_id,account_id,revision) DO UPDATE SET issuer=excluded.issuer, access_token=excluded.access_token,
      refresh_token=excluded.refresh_token, token_type=excluded.token_type, scope=excluded.scope, expires_at=excluded.expires_at,
      obtained_at=excluded.obtained_at, updated_at=excluded.updated_at, version=oauth_tokens.version+1
      RETURNING access_token,version`).get(...keyArgs(key), tokens.issuer,
      tokens.access_token, tokens.refresh_token ?? null, tokens.token_type, tokens.scope ?? null, expires, now, now);
    this.clearStatus(key);
    return tokenRow.pick({ access_token: true, version: true }).parse(saved);
  }

  deleteTokens(key: AccountKey): void { this.db.prepare(`DELETE FROM oauth_tokens WHERE ${WHERE_KEY}`).run(...keyArgs(key)); }

  client(serverId: string, issuer?: string): OAuthClientInformationMixed | undefined {
    const row = issuer ? this.db.prepare("SELECT client_json FROM oauth_clients WHERE server_id=? AND issuer=?").get(serverId, issuer)
      : this.db.prepare("SELECT client_json FROM oauth_clients WHERE server_id=? ORDER BY saved_at DESC LIMIT 1").get(serverId);
    if (!row) return;
    const raw: unknown = JSON.parse(z.object({ client_json: z.string() }).parse(row).client_json);
    const client = OAuthClientInformationSchema.passthrough().parse(raw);
    registerSecrets([client.client_secret, typeof client.registration_access_token === "string" ? client.registration_access_token : undefined]);
    return client;
  }

  saveClient(serverId: string, client: OAuthClientInformationMixed & { issuer: string }): void {
    registerSecrets([client.client_secret]);
    this.db.prepare("INSERT OR REPLACE INTO oauth_clients VALUES (?,?,?,?)").run(serverId, client.issuer, JSON.stringify(client), Date.now());
  }
  deleteClients(serverId: string): void { this.db.prepare("DELETE FROM oauth_clients WHERE server_id=?").run(serverId); }

  addPending(value: OAuthPending): void {
    registerSecrets([value.code_verifier]);
    this.db.prepare("DELETE FROM oauth_pending WHERE expires_at<=?").run(Date.now());
    this.db.prepare("INSERT INTO oauth_pending VALUES (?,?,?,?,?,?,?,?)").run(value.state, value.server_id, value.account_id,
      value.revision, value.code_verifier, value.cookie_hash, value.created_at, value.expires_at);
  }
  saveVerifier(state: string, verifier: string): void {
    registerSecrets([verifier]);
    this.db.prepare("UPDATE oauth_pending SET code_verifier=? WHERE state=?").run(verifier, state);
  }
  pending(state: string, consume = false): OAuthPending | undefined {
    const row = this.db.prepare(consume ? "DELETE FROM oauth_pending WHERE state=? RETURNING *" : "SELECT * FROM oauth_pending WHERE state=?").get(state);
    if (!row) return;
    const value = pendingRow.parse(row); registerSecrets([value.code_verifier]); return value;
  }
  deletePending(state: string): void { this.db.prepare("DELETE FROM oauth_pending WHERE state=?").run(state); }
  deleteAccountPending(key: AccountKey): void { this.db.prepare(`DELETE FROM oauth_pending WHERE ${WHERE_KEY}`).run(...keyArgs(key)); }

  status(key: AccountKey) {
    const row = this.db.prepare(`SELECT last_error,last_error_at FROM oauth_status WHERE ${WHERE_KEY}`).get(...keyArgs(key));
    return row ? statusRow.parse(row) : undefined;
  }
  setStatus(key: AccountKey, error: OAuthFailure): void {
    this.db.prepare("INSERT OR REPLACE INTO oauth_status VALUES (?,?,?,?,?)").run(...keyArgs(key), error, Date.now());
  }
  clearStatus(key: AccountKey): void { this.db.prepare(`DELETE FROM oauth_status WHERE ${WHERE_KEY}`).run(...keyArgs(key)); }
  close(): void { this.db.close(); }
}
