import { GitHubAppClient, GitHubAppError, type AuthorizedRepository, type GitHubUser } from "./app";

export type AppConnection = { authorizationVersion: 2; githubUser: GitHubUser | null; authorizedUntil: number; userVerified: boolean;
  installationId: number | null; repositories: AuthorizedRepository[]; generation: number; verifiedAt: number; status: "disconnected" | "active" | "revoked" };
const MAX_STATE_AGE = 10 * 60_000;
// No retained user token: renewal requires a fresh user OAuth flow, never an installation-token-only refresh.
export const AUTHORIZATION_LEASE_MS = 10 * 60_000;
const digest = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
/** Owner admin + browser state AND the OAuth user's repository intersection are all required. */
export class GitHubAppConnection {
  constructor(private readonly storage: DurableObjectStorage, private readonly client: GitHubAppClient, private readonly revoke: () => void) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS github_app_connection (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_app_state (hash TEXT PRIMARY KEY, binding TEXT NOT NULL, expires_at INTEGER NOT NULL, code_verifier TEXT);`);
    if (!storage.sql.exec<{ name: string }>("PRAGMA table_info(github_app_state)").toArray().some(column => column.name === "code_verifier"))
      storage.sql.exec("ALTER TABLE github_app_state ADD COLUMN code_verifier TEXT");
    storage.sql.exec("INSERT OR IGNORE INTO github_app_connection(id,value) VALUES(1,?)", JSON.stringify({ authorizationVersion: 2, githubUser: null, authorizedUntil: 0,
      userVerified: false, installationId: null, repositories: [], generation: 0, verifiedAt: 0, status: "disconnected" }));
  }
  private current(): AppConnection { return JSON.parse(this.storage.sql.exec<{ value: string }>("SELECT value FROM github_app_connection WHERE id=1").one().value); }
  snapshot(): AppConnection {
    const current = this.current();
    if (current.status === "active" && (current.authorizationVersion !== 2 || !current.userVerified || !current.githubUser || !(current.authorizedUntil > Date.now()))) this.invalidate();
    return this.current();
  }
  private save(value: AppConnection) { this.storage.sql.exec("UPDATE github_app_connection SET value=? WHERE id=1", JSON.stringify(value)); }
  async start(adminBinding: string, browserVerifier: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(browserVerifier)) throw new GitHubAppError("unauthorized");
    const state = crypto.randomUUID() + crypto.randomUUID(); const hash = await digest(state), binding = await digest(adminBinding + ":" + browserVerifier);
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const url = this.client.authorizationUrl(state, challenge);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM github_app_state WHERE expires_at<=?", Date.now());
      if (this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM github_app_state").one().n >= 20) throw new GitHubAppError("capacity");
      this.storage.sql.exec("INSERT INTO github_app_state(hash,binding,expires_at,code_verifier) VALUES(?,?,?,?)", hash, binding, Date.now() + MAX_STATE_AGE, verifier);
    });
    return url;
  }
  async complete(state: string, code: string, installationId: number, adminBinding: string, browserVerifier: string): Promise<AppConnection> {
    if (state.length > 100 || !/^[a-f0-9]{64}$/.test(browserVerifier)) throw new GitHubAppError("unauthorized");
    const hash = await digest(state), binding = await digest(adminBinding + ":" + browserVerifier);
    // Atomically consume state AND server-side PKCE verifier before any external operation.
    const verifier = this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ binding: string; expires_at: number; code_verifier: string | null }>("SELECT binding,expires_at,code_verifier FROM github_app_state WHERE hash=?", hash).toArray()[0];
      if (!row || row.binding !== binding || row.expires_at <= Date.now()) throw new GitHubAppError("unauthorized");
      this.storage.sql.exec("DELETE FROM github_app_state WHERE hash=?", hash); return row.code_verifier;
    });
    if (!verifier) throw new GitHubAppError("unauthorized");
    const previousUser = this.snapshot().githubUser, generation = this.invalidate();
    const authorization = await this.client.authorizeInstallation(code, installationId, verifier);
    // Switching GitHub identity requires an explicit authenticated disconnect first.
    if (previousUser && previousUser.id !== authorization.user.id) throw new GitHubAppError("identity_changed");
    const installationRepositories = await this.client.repositories(installationId);
    const allowed = new Set(authorization.repositories.map(repo => repo.id));
    const repositories = installationRepositories.filter(repo => allowed.has(repo.id));
    return this.storage.transactionSync(() => {
      if (this.current().generation !== generation || authorization.expiresAt <= Date.now() + 30_000) throw new GitHubAppError("unauthorized");
      const next: AppConnection = { authorizationVersion: 2, githubUser: authorization.user, userVerified: true, authorizedUntil: Math.min(authorization.expiresAt, Date.now() + AUTHORIZATION_LEASE_MS),
        installationId, repositories, generation, verifiedAt: Date.now(), status: "active" }; this.save(next); return next;
    });
  }
  /** Revocation and not-yet-issued execution permits must share this transaction. */
  invalidate(): number {
    return this.storage.transactionSync(() => { const current = this.current();
      this.save({ ...current, repositories: [], status: "revoked", userVerified: false, authorizedUntil: 0, verifiedAt: 0, generation: current.generation + 1 });
      this.revoke(); return current.generation + 1;
    });
  }
  authorized(installationId: number, repositoryId: number): boolean {
    const current = this.snapshot(); return current.status === "active" && current.installationId === installationId && current.repositories.some(repo => repo.id === repositoryId);
  }
  /** Caller MUST first verify App-origin raw HMAC and globally deduplicate github_app_authorization. */
  revokeUserAuthorization(userId: number): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new GitHubAppError("unauthorized");
    this.storage.transactionSync(() => {
      const current = this.current(); this.storage.sql.exec("DELETE FROM github_app_state");
      if (current.githubUser?.id === userId) this.invalidate();
      else this.save({ ...current, generation: current.generation + 1 }); // Also prevents pending first-time/replacement OAuth from resurrecting a revoked grant.
    });
  }
  disconnect(): void {
    this.storage.transactionSync(() => { this.invalidate(); this.storage.sql.exec("DELETE FROM github_app_state");
      this.save({ ...this.current(), authorizationVersion: 2, githubUser: null, installationId: null, status: "disconnected" }); });
  }
  async sync(): Promise<AppConnection> {
    this.invalidate(); throw new GitHubAppError("reauthorization_required"); // Explicitly require fresh OAuth; App scope cannot substitute for user scope.
  }
}
