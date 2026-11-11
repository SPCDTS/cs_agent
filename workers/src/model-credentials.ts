import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { randomSecret, type TokenVault } from "./mcp/crypto";
import type { RegistryDO } from "./registry";
import { refreshFailure, type RefreshFailure } from "./codex-refresh-error";

export const MODEL_CREDENTIALS_SCHEMA = `CREATE TABLE IF NOT EXISTS model_credentials (
  provider_id TEXT PRIMARY KEY, credential_enc TEXT NOT NULL, updated_at INTEGER NOT NULL, meta_json TEXT NOT NULL)`;
/** 非密信息，面板与健康检查只读这一列，不解密凭据。 */
export type CredentialMeta = { type: Credential["type"]; email?: string; accountId?: string; flow?: string; expiresAt?: number; refreshFailure?: RefreshFailure };
export type CredentialLease = { lease: string; updatedAt: number | null; credential?: Credential };
type Row = { provider_id: string; credential_enc: string; updated_at: number; meta_json: string };
// pi-ai 的刷新有 15 秒超时；持锁的 Thread 中途被驱逐时，Registry 最迟在这之后放开锁。
const LEASE_MS = 30_000;

function metaOf(credential: Credential): CredentialMeta {
  if (credential.type === "api_key") return { type: "api_key" };
  const text = (key: string) => typeof credential[key] === "string" ? credential[key] as string : undefined;
  const email = text("email"), accountId = text("accountId");
  return { type: "oauth", ...(email ? { email } : {}), ...(accountId ? { accountId } : {}), ...(text("flow") ? { flow: text("flow") } : {}), expiresAt: credential.expires };
}

/**
 * Registry 内的凭据存储：整份 pi-ai Credential 经 TokenVault 加密，AAD 是 provider id。
 * 同一 provider 的写入按 Promise 链串行；其他 DO 通过 acquire/settle 租用同一把锁，
 * 所以并发请求只会有一个去刷新，轮换后的 refresh token 不会被另一份旧 token 的刷新冲掉。
 */
export class SqlCredentialStore implements CredentialStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly leases = new Map<string, () => void>();
  constructor(private readonly sql: SqlStorage, private readonly vault: TokenVault) {}

  private row(providerId: string): Row | undefined {
    return this.sql.exec<Row>("SELECT * FROM model_credentials WHERE provider_id = ?", providerId).toArray()[0];
  }
  private async decode(row: Row | undefined): Promise<Credential | undefined> {
    return row ? JSON.parse(await this.vault.decrypt(row.credential_enc, row.provider_id)) as Credential : undefined;
  }
  private async write(providerId: string, credential: Credential, previous: Row | undefined): Promise<void> {
    const encrypted = await this.vault.encrypt(JSON.stringify(credential), providerId);
    // updated_at 是租约的 CAS 版本号，同一毫秒内的两次写入也必须不同。
    this.sql.exec("INSERT OR REPLACE INTO model_credentials VALUES (?, ?, ?, ?)", providerId, encrypted,
      Math.max(Date.now(), (previous?.updated_at ?? 0) + 1), JSON.stringify(metaOf(credential)));
  }
  private async lock(providerId: string): Promise<() => void> {
    const previous = this.queues.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    this.queues.set(providerId, tail);
    void tail.then(() => { if (this.queues.get(providerId) === tail) this.queues.delete(providerId); });
    await previous;
    return release;
  }

  meta(providerId: string): CredentialMeta | undefined {
    const row = this.row(providerId);
    return row ? JSON.parse(row.meta_json) as CredentialMeta : undefined;
  }
  async read(providerId: string): Promise<Credential | undefined> { return this.decode(this.row(providerId)); }
  async list(): Promise<readonly CredentialInfo[]> {
    return this.sql.exec<Row>("SELECT * FROM model_credentials").toArray()
      .map(row => ({ providerId: row.provider_id, type: (JSON.parse(row.meta_json) as CredentialMeta).type }));
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const release = await this.lock(providerId);
    try {
      const row = this.row(providerId), current = await this.decode(row);
      let next: Credential | undefined;
      try { next = await fn(current); }
      catch (error) { this.recordFailure(providerId, row?.updated_at ?? null, refreshFailure(error)); throw error; }
      if (next !== undefined) await this.write(providerId, next, row);
      return next ?? current;
    } finally { release(); }
  }
  async delete(providerId: string): Promise<void> {
    const release = await this.lock(providerId);
    try { this.sql.exec("DELETE FROM model_credentials WHERE provider_id = ?", providerId); } finally { release(); }
  }

  /** 跨 DO 的 modify 前半段：拿锁并返回当前凭据，直到 settle 或租约到期才放锁。 */
  async acquire(providerId: string): Promise<CredentialLease> {
    const release = await this.lock(providerId), lease = randomSecret();
    const timer = setTimeout(() => this.end(lease), LEASE_MS);
    this.leases.set(lease, () => { clearTimeout(timer); release(); });
    try {
      const row = this.row(providerId);
      return { lease, updatedAt: row?.updated_at ?? null, credential: await this.decode(row) };
    } catch (error) { this.end(lease); throw error; }
  }
  /** 后半段：版本未变才写入，租约到期后迟到的结果不会盖掉别人刚存的凭据。 */
  async settle(providerId: string, lease: string, expectedUpdatedAt: number | null, next?: Credential, failure?: RefreshFailure): Promise<Credential | undefined> {
    try {
      const row = this.row(providerId);
      if (next === undefined && this.leases.has(lease)) this.recordFailure(providerId, expectedUpdatedAt, failure);
      if (next !== undefined && (row?.updated_at ?? null) === expectedUpdatedAt) { await this.write(providerId, next, row); return next; }
      return await this.decode(row);
    } finally { this.end(lease); }
  }
  private recordFailure(providerId: string, expectedUpdatedAt: number | null, failure?: RefreshFailure): void {
    if (!failure || failure.kind === "aborted") return;
    const row = this.row(providerId);
    if (!row || row.updated_at !== expectedUpdatedAt) return;
    const meta: CredentialMeta = JSON.parse(row.meta_json);
    this.sql.exec("UPDATE model_credentials SET meta_json = ? WHERE provider_id = ? AND updated_at = ?",
      JSON.stringify({ ...meta, refreshFailure: failure }), providerId, expectedUpdatedAt);
    console.error({ event: "model_oauth_refresh_failed", provider: providerId.startsWith("chatgpt:") ? "openai-codex" : providerId, ...failure });
  }
  private end(lease: string): void {
    const release = this.leases.get(lease);
    this.leases.delete(lease);
    release?.();
  }
}

/** Thread 一侧的 CredentialStore：读写都经 Registry RPC，modify 的回调在本地执行、锁由 Registry 持有。 */
export function remoteCredentials(registry: () => DurableObjectStub<RegistryDO>): CredentialStore {
  return {
    read: async providerId => await registry().credentialRead(providerId) as Credential | undefined,
    list: async () => await registry().credentialList(),
    delete: providerId => registry().credentialDelete(providerId),
    async modify(providerId, fn) {
      const { lease, updatedAt, credential } = await registry().credentialAcquire(providerId) as CredentialLease;
      let next: Credential | undefined;
      try { next = await fn(credential); }
      catch (error) {
        await registry().credentialSettle(providerId, lease, updatedAt, undefined, refreshFailure(error)).catch(() => {});
        throw error;
      }
      return await registry().credentialSettle(providerId, lease, updatedAt, next) as Credential | undefined;
    },
  };
}
