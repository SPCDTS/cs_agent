import { DEFAULT_GITHUB, parseGitHubConfig, type GitHubDelivery, type GitHubConfig } from "./model";
import { suppressed } from "../events/model";

export const RECEIPT_LIMIT = 5000, PENDING_LIMIT = 200, RETENTION_MS = 30 * 86400_000;
type Receipt = {
  installation_id: number; delivery_id: string; body_hash: string; repository: string; repository_id: number; event: string; action: string;
  received_at: number; updated_at: number; state: string; reason: string | null; event_key: string; input_key: string | null; outcome: string | null;
};
export class GitHubInbox {
  constructor(private readonly storage: DurableObjectStorage, private readonly app: {
    authorized: (installationId:number,repositoryId:number)=>boolean; lifecycle:(delivery:GitHubDelivery)=>void;
  }) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS github_config (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, revision INTEGER NOT NULL);
      DROP TABLE IF EXISTS github_repo_pin;
      CREATE TABLE IF NOT EXISTS github_receipt (
        delivery_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, repository_id INTEGER NOT NULL,
        event TEXT NOT NULL, action TEXT NOT NULL, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        state TEXT NOT NULL, reason TEXT, event_key TEXT NOT NULL UNIQUE, input_key TEXT, outcome TEXT);
      CREATE INDEX IF NOT EXISTS github_receipt_input ON github_receipt(input_key);
    `);
    if (!this.sql.exec<{name:string}>("PRAGMA table_info(github_receipt)").toArray().some(c=>c.name==="installation_id"))
      this.sql.exec("ALTER TABLE github_receipt ADD COLUMN installation_id INTEGER NOT NULL DEFAULT 0");
    // INSERT OR IGNORE is atomic; an explicit [] is data, never treated as missing.
    this.sql.exec("INSERT OR IGNORE INTO github_config(id,value,revision) VALUES(1,?,1)", JSON.stringify(DEFAULT_GITHUB));
    // Old name-based or mixed configs never become ID permissions. Preserve the ledger, not old authority.
    this.storage.transactionSync(() => {
      const raw = this.sql.exec<{value:string}>("SELECT value FROM github_config WHERE id=1").one().value;
      let current: unknown; try { current=JSON.parse(raw); } catch { current=null; }
      if (!parseGitHubConfig(current)) {
        const old=current && typeof current==="object" ? current as Record<string,unknown> : {};
        const migrated=parseGitHubConfig({repositoryIds:[],selections:old.selections,paused:old.paused,settings:old.settings}) ?? DEFAULT_GITHUB;
        this.sql.exec("UPDATE github_config SET value=?,revision=revision+1 WHERE id=1",JSON.stringify(migrated));
      }
      this.reauthorize();
    });

  }
  private get sql() { return this.storage.sql; }
  snapshot(): { value: GitHubConfig; revision: string } {
    const row = this.sql.exec<{ value: string; revision: number }>("SELECT value,revision FROM github_config WHERE id=1").one();
    return { value: JSON.parse(row.value), revision: String(row.revision) };
  }
  put(value: unknown, expectedRevision: string) {
    const parsed = parseGitHubConfig(value);
    if (!parsed || parsed.repositoryIds.some(r=>!this.app.authorized(r.installationId,r.repositoryId))) return { ok: false as const, error: "invalid" as const };
    return this.storage.transactionSync(() => {
      const current = this.snapshot();
      if (current.revision !== expectedRevision) return { ok: false as const, error: "conflict" as const, current };
      this.sql.exec("UPDATE github_config SET value=?,revision=revision+1 WHERE id=1", JSON.stringify(parsed));
      this.sql.exec("UPDATE event_source SET settings_json=?,paused=?,pause_reason=? WHERE id='github'",
        JSON.stringify(parsed.settings), parsed.paused ? 1 : 0, parsed.paused ? "manual" : null);
      this.reauthorize();
      return { ok: true as const, current: this.snapshot() };
    });
  }
  private reason(row: Pick<Receipt, "installation_id" | "repository_id" | "event" | "action">): string | null {
    const config = this.snapshot().value;
    if (!this.app.authorized(row.installation_id,row.repository_id)) return "installation_not_authorized";
    if (!config.repositoryIds.some(r=>r.installationId===row.installation_id && r.repositoryId===row.repository_id)) return "repository_not_allowed";
    return config.selections.includes(row.event + (row.action ? "." + row.action : "")) ? null : "event_action_not_allowed";
  }

  private suppress(key: string, reason: string) {
    this.sql.exec("UPDATE github_receipt SET state='suppressed',reason=?,updated_at=? WHERE event_key=? AND state IN ('held','enqueued')", reason, Date.now(), key);
    this.sql.exec("DELETE FROM event_held WHERE key=?", key);
  }
  reauthorize() {
    for (const row of this.sql.exec<Receipt>("SELECT * FROM github_receipt WHERE state IN ('held','enqueued')").toArray()) {
      const reason = this.reason(row);
      if (reason) this.suppress(row.event_key, reason);
    }
  }
  receive(delivery: GitHubDelivery): { status: number; code: string } {
    return this.storage.transactionSync(() => {
      const existing = this.sql.exec<Receipt>("SELECT * FROM github_receipt WHERE delivery_id=?", delivery.deliveryId).toArray()[0];
      if (existing) return { status: existing.body_hash === delivery.bodyHash ? 200 : 409, code: existing.body_hash === delivery.bodyHash ? "duplicate" : "delivery_conflict" };
      // One global hash domain: neither event nor delivery headers are covered by GitHub's HMAC.
      if (this.sql.exec("SELECT 1 FROM github_receipt WHERE body_hash=?", delivery.bodyHash).toArray().length) return { status: 200, code: "body_duplicate" };
      this.prune();
      if (this.count() >= RECEIPT_LIMIT) return { status: 503, code: "receipt_capacity" };
      const row = { installation_id:delivery.installationId ?? 0, repository_id: delivery.repositoryId, event: delivery.event, action: delivery.action };
      let reason = delivery.lifecycle ? "lifecycle" : delivery.normalized ? this.reason(row) : "ping";
      if (!reason && delivery.normalized && suppressed(this.snapshot().value.settings, delivery.normalized)) reason = "source_filter";
      if (!reason && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM github_receipt WHERE state IN ('held','enqueued','started')").one().n >= PENDING_LIMIT)
        return { status: 503, code: "pending_capacity" };
      const key = "evt_github_" + delivery.bodyHash;
      this.sql.exec(`INSERT INTO github_receipt(delivery_id,body_hash,repository,repository_id,event,action,received_at,updated_at,state,reason,event_key,installation_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, delivery.deliveryId, delivery.bodyHash, delivery.repository, delivery.repositoryId, delivery.event, delivery.action,
        delivery.receivedAt, delivery.receivedAt, reason ? "suppressed" : "held", reason, key, delivery.installationId ?? 0);
      if (delivery.lifecycle) this.app.lifecycle(delivery);
      if (!reason) this.sql.exec("INSERT INTO event_held(key,source,event_json,received_at,reason) VALUES(?,'github',?,?,'merge')",
        key, JSON.stringify(delivery.normalized), delivery.receivedAt);
      return { status: 202, code: reason ? "suppressed" : "received" };
    });
  }
  enqueued(keys: string[], inputKey: string) {
    for (const key of keys) this.sql.exec("UPDATE github_receipt SET state='enqueued',input_key=?,updated_at=? WHERE event_key=? AND state='held'", inputKey, Date.now(), key);
  }
  /** New claims (including recovery) require App authority; already-running operations cannot be undone. */
  claim(inputKey: string): "start" | "wait" | "suppressed" {
    return this.storage.transactionSync(() => {
      const rows = this.sql.exec<Receipt>("SELECT * FROM github_receipt WHERE input_key=?", inputKey).toArray();
      // Historical permits cannot create new execution without current installation authority.
      // An operation already running cannot be undone, but a legacy/revoked row cannot resume a new turn.
      if (rows.some(row=>!this.app.authorized(row.installation_id,row.repository_id))) {
        for (const row of rows) this.suppress(row.event_key,"installation_not_authorized");
        return "suppressed";
      }
      if (rows.some(row => row.state === "started" || row.state === "finished")) return "start";
      this.reauthorize();
      if (!rows.length || rows.some(row => row.state === "suppressed" || this.reason(row))) {
        for (const row of rows) this.suppress(row.event_key, "batch_revoked");
        return "suppressed";
      }
      const source = this.sql.exec<{ paused: number }>("SELECT paused FROM event_source WHERE id='github'").one();
      if (source.paused) return "wait";
      this.sql.exec("UPDATE github_receipt SET state='started',updated_at=? WHERE input_key=? AND state='enqueued'", Date.now(), inputKey);
      return "start";
    });
  }
  finish(inputKey: string, outcome: string) {
    this.sql.exec("UPDATE github_receipt SET state='finished',outcome=?,updated_at=? WHERE input_key=? AND state IN ('enqueued','started')", outcome, Date.now(), inputKey);
  }
  prune() {
    this.sql.exec("DELETE FROM github_receipt WHERE state IN ('suppressed','finished') AND updated_at < ?", Date.now() - RETENTION_MS);
  }
  private count(): number { return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM github_receipt").one().n; }
  receipt(id: string) {
    return this.sql.exec<Receipt>("SELECT * FROM github_receipt WHERE delivery_id=?", id).toArray()[0] ?? null;
  }
  status() {
    return { ...this.snapshot(), count: this.count(), capacity: RECEIPT_LIMIT, pendingCapacity: PENDING_LIMIT,
      counts: this.sql.exec<{ state: string; count: number }>("SELECT state,COUNT(*) AS count FROM github_receipt GROUP BY state").toArray(),
      receipts: this.sql.exec<Receipt>("SELECT * FROM github_receipt ORDER BY received_at DESC,rowid DESC LIMIT 50").toArray() };
  }
}
