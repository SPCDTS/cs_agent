import { GitHubAppClient, GitHubAppError, type AuthorizedRepository } from "./app";

export type AppConnection = { installationId: number | null; repositories: AuthorizedRepository[]; generation: number; verifiedAt: number; status: "disconnected" | "active" | "revoked" };
const MAX_STATE_AGE = 10 * 60_000;
const digest = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
/** Single owner boundary. This is NOT proof of the administrator's GitHub identity. */
export class GitHubAppConnection {
  constructor(private readonly storage: DurableObjectStorage, private readonly client: GitHubAppClient, private readonly revoke: () => void) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS github_app_connection (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_app_state (hash TEXT PRIMARY KEY, binding TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
    storage.sql.exec("INSERT OR IGNORE INTO github_app_connection(id,value) VALUES(1,?)", JSON.stringify({ installationId: null, repositories: [], generation: 0, verifiedAt: 0, status: "disconnected" }));
  }
  snapshot(): AppConnection { return JSON.parse(this.storage.sql.exec<{ value: string }>("SELECT value FROM github_app_connection WHERE id=1").one().value); }
  private save(value: AppConnection) { this.storage.sql.exec("UPDATE github_app_connection SET value=? WHERE id=1", JSON.stringify(value)); }
  async start(adminBinding: string, browserVerifier: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(browserVerifier)) throw new GitHubAppError("unauthorized");
    const state = crypto.randomUUID() + crypto.randomUUID(); const hash = await digest(state), binding = await digest(adminBinding + ":" + browserVerifier);
    const url = this.client.installationUrl(state);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM github_app_state WHERE expires_at<=?", Date.now());
      if (this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM github_app_state").one().n >= 20) throw new GitHubAppError("capacity");
      this.storage.sql.exec("INSERT INTO github_app_state(hash,binding,expires_at) VALUES(?,?,?)", hash, binding, Date.now() + MAX_STATE_AGE);
    });
    return url;
  }
  async complete(state: string, installationId: number, adminBinding: string, browserVerifier: string): Promise<AppConnection> {
    if (state.length > 100 || !/^[a-f0-9]{64}$/.test(browserVerifier)) throw new GitHubAppError("unauthorized");
    const hash = await digest(state), binding = await digest(adminBinding + ":" + browserVerifier);
    // Consume before any external operation. A failed API call needs a new connect flow.
    this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{ binding: string; expires_at: number }>("SELECT binding,expires_at FROM github_app_state WHERE hash=?", hash).toArray()[0];
      if (!row || row.binding !== binding || row.expires_at <= Date.now()) throw new GitHubAppError("unauthorized");
      this.storage.sql.exec("DELETE FROM github_app_state WHERE hash=?", hash);
    });
    const generation = this.invalidate();
    const repositories = await this.client.repositories(installationId);
    return this.apply(installationId, repositories, generation);
  }
  /** Invalidating and revoking not-yet-issued execution permits must share one transaction. */
  invalidate(): number {
    return this.storage.transactionSync(() => { const current = this.snapshot();
      this.save({ ...current, repositories: [], status: "revoked", verifiedAt: 0, generation: current.generation + 1 });
      this.revoke(); return current.generation + 1;
    });
  }
  private apply(installationId: number, repositories: AuthorizedRepository[], generation: number): AppConnection {
    return this.storage.transactionSync(() => {
      const current = this.snapshot(); if (current.generation !== generation) throw new GitHubAppError("unauthorized");
      const next: AppConnection = { installationId, repositories, generation, verifiedAt: Date.now(), status: "active" }; this.save(next); return next;
    });
  }
  async sync(): Promise<AppConnection> {
    const current = this.snapshot(); if (!current.installationId) throw new GitHubAppError("unauthorized");
    const generation = this.invalidate();
    return this.apply(current.installationId, await this.client.repositories(current.installationId), generation);
  }
}
