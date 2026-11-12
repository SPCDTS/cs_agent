import type { GitHubDelivery } from "./model";
import { GitHubAppClient, GitHubAppError, type GitHubAppSecrets, type GitHubUser, type UserTokens, type AuthorizedRepository } from "./app";
import { githubAppConfigured } from "./configuration";
import { TokenVault, randomSecret, sha256 } from "../mcp/crypto";

type Identity = { id: number; login: string; generation: number; cipher: string };
export type InstallationView = { installationId: number; user: GitHubUser; repositories: AuthorizedRepository[]; status: "active" | "revoked"; until: number };
type Binding = InstallationView & { generation: number; retryAt?: number; failures?: number };
const digest = async (s: string) => (await sha256(s)).toString("hex");
const aad = (id: number, generation: number) => JSON.stringify(["github-app-owner", id, generation]);
/** Owner identities and installations are independently authorized; old snapshots confer no authority. */
export class GitHubConnections {
  private readonly vault: TokenVault;
  private readonly client: GitHubAppClient;
  private readonly connecting = new Set<{userId:number;installations:number[];revoked:boolean;revokedUsers:Set<number>}>();
  private readonly syncing = new Map<number, Promise<void>>();
  constructor(private readonly storage: DurableObjectStorage, private readonly secrets: GitHubAppSecrets & { GITHUB_APP_STORE_KEY?: string },
    private readonly revoke: (installationId: number) => void) {
    this.vault = new TokenVault(secrets.GITHUB_APP_STORE_KEY);
    this.client = new GitHubAppClient(secrets);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS github_identities (id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_installations (id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_connect_state (hash TEXT PRIMARY KEY,binding TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL,epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS github_connect_epoch (id INTEGER PRIMARY KEY,epoch INTEGER NOT NULL);
      INSERT OR IGNORE INTO github_connect_epoch VALUES(1,0);`);
  }
  configured() { return githubAppConfigured(this.secrets); }
  private epoch() { return this.storage.sql.exec<{epoch: number}>("SELECT epoch FROM github_connect_epoch WHERE id=1").one().epoch; }
  private identities(): Identity[] { return this.storage.sql.exec<{value:string}>("SELECT value FROM github_identities").toArray().map(r => JSON.parse(r.value) as Identity); }
  private bindings(): Binding[] { return this.storage.sql.exec<{value:string}>("SELECT value FROM github_installations").toArray().map(r => JSON.parse(r.value) as Binding); }
  private save(b: Binding) { this.storage.sql.exec("INSERT OR REPLACE INTO github_installations VALUES(?,?)", b.installationId, JSON.stringify(b)); }
  private defer(b: Binding) {
    const failures = Math.min((b.failures ?? 0) + 1, 6);
    this.save({...b,until:0,failures,retryAt:Date.now()+Math.min(60_000 * 2 ** (failures-1),900_000)});
  }
  snapshot() {
    return { configured: this.configured(), slug: this.secrets.GITHUB_APP_SLUG ?? "",
      identities: this.identities().map(({id,login}) => ({id,login})),
      installations: this.bindings().map(({generation: _, ...b}) => ({...b, repositories: b.until > Date.now() && b.status === "active" ? b.repositories : []})) };
  }
  authorization(installationId: number, repositoryId: number): "allow" | "wait" | "deny" {
    if (!this.configured()) return "deny";
    const b = this.bindings().find(b => b.installationId === installationId);
    if (!b || b.status !== "active" || !b.repositories.some(r => r.id === repositoryId)) return "deny";
    return b.until > Date.now() ? "allow" : "wait";
  }
  authorized(installationId: number, repositoryId: number) { return this.authorization(installationId,repositoryId) === "allow"; }
  async start(admin: string, browser: string) {
    if (!this.configured()) throw new GitHubAppError("unconfigured");
    if (!/^[a-f0-9]{64}$/.test(browser)) throw new GitHubAppError("unauthorized");
    const state = randomSecret(), verifier = randomSecret(), binding = await digest(admin + ":" + browser);
    const url = this.client.authorizationUrl(state, (await sha256(verifier)).toString("base64url"));
    const hash = await digest(state);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM github_connect_state WHERE expires<=?", Date.now());
      if (this.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM github_connect_state").one().n >= 20) throw new GitHubAppError("capacity");
      this.storage.sql.exec("INSERT INTO github_connect_state VALUES(?,?,?,?,?)",hash,binding,verifier,Date.now()+600_000,this.epoch());
    });
    return { url, installationUrl: this.client.installationUrl(state) };
  }
  async complete(state: string, code: string, admin: string, browser: string) {
    if (state.length > 100 || !/^[a-f0-9]{64}$/.test(browser)) throw new GitHubAppError("unauthorized");
    const hash = await digest(state), binding = await digest(admin + ":" + browser);
    const row = this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<{binding:string;verifier:string;expires:number;epoch:number}>("SELECT * FROM github_connect_state WHERE hash=?",hash).toArray()[0];
      if (!row || row.binding !== binding || row.expires <= Date.now() || row.epoch !== this.epoch()) throw new GitHubAppError("unauthorized");
      if(this.connecting.size>=20) throw new GitHubAppError("capacity");
      this.storage.sql.exec("DELETE FROM github_connect_state WHERE hash=?", hash); return row;
    });
    const pending={userId:0,installations:[] as number[],revoked:false,revokedUsers:new Set<number>()};
    this.connecting.add(pending);
    try {
      const tokens = await this.client.exchange(code,row.verifier);
      const discovered = await this.client.discover(tokens);
      pending.userId=discovered.user.id;pending.installations=discovered.installations;
      if(pending.revokedUsers.has(discovered.user.id)) pending.revoked=true;
      pending.revokedUsers.clear();
      if(pending.revoked) throw new GitHubAppError("unauthorized");
      if (this.identities().length >= 20 && !this.identities().some(u => u.id === discovered.user.id)) throw new GitHubAppError("capacity");
      const generation = this.epoch() + 1; // Monotonic across disconnect/reconnect: no identity-generation ABA.
      const cipher = await this.vault.encrypt(JSON.stringify(tokens),aad(discovered.user.id,generation));
      const prepared: Binding[] = [];
      for (const installationId of discovered.installations) {
        const existing = this.bindings().find(b => b.installationId === installationId);
        // One installation has an explicit identity owner. Another login cannot silently take it over.
        if (existing && existing.user.id !== discovered.user.id) continue;
        const auth = await this.client.inspect(tokens,installationId);
        if (auth.user.id !== discovered.user.id) throw new GitHubAppError("unauthorized");
        const allowed = new Set(auth.repositories.map(r => r.id));
        const repositories = (await this.client.repositories(installationId)).filter(r => allowed.has(r.id));
        prepared.push({installationId,user:auth.user,repositories,status:"active",until:auth.expiresAt,generation});
      }
      this.storage.transactionSync(() => {
        if (pending.revoked || row.epoch !== this.epoch()) throw new GitHubAppError("unauthorized");
        for (const b of this.bindings().filter(b => b.user.id === discovered.user.id)) {
          if (!prepared.some(next => next.installationId === b.installationId)) this.invalidate(b.installationId);
          else if (b.status !== "active") this.revoke(b.installationId);
        }
        this.storage.sql.exec("INSERT OR REPLACE INTO github_identities VALUES(?,?)",discovered.user.id,JSON.stringify({...discovered.user,generation,cipher}));
        for (const b of prepared) this.save(b);
        // Reconnect retains still-authorized work, but removes receipts outside the new intersection.
        for (const b of prepared) this.revoke(b.installationId);
        this.storage.sql.exec("UPDATE github_connect_epoch SET epoch=epoch+1 WHERE id=1");
      });
      return this.snapshot();
    } finally { this.connecting.delete(pending); }
  }
  invalidate(id: number) {
    this.storage.transactionSync(() => {
      const b = this.bindings().find(b => b.installationId === id);
      for(const pending of this.connecting) if(pending.installations.includes(id)) pending.revoked=true;
      if (!b) return; // Unknown external installations must not reset unrelated owner OAuth.
      this.save({...b,status:"revoked",repositories:[],until:0,generation:b.generation+1}); this.revoke(id);
      this.storage.sql.exec("UPDATE github_connect_epoch SET epoch=epoch+1 WHERE id=1");
      this.storage.sql.exec("DELETE FROM github_connect_state");
    });
  }
  disconnectUser(id: number) {
    this.storage.transactionSync(() => {
      for(const pending of this.connecting) if(pending.userId===id) pending.revoked=true;
      for (const b of this.bindings().filter(b => b.user.id === id)) this.invalidate(b.installationId);
      this.storage.sql.exec("DELETE FROM github_identities WHERE id=?",id);
      this.storage.sql.exec("UPDATE github_connect_epoch SET epoch=epoch+1 WHERE id=1");
      this.storage.sql.exec("DELETE FROM github_connect_state");
    });
  }
  private knownUser(id:number) { return this.identities().some(u=>u.id===id)||this.bindings().some(b=>b.user.id===id); }
  related(d:GitHubDelivery) {
    return !!(d.installationId && (this.bindings().some(b=>b.installationId===d.installationId)
      ||[...this.connecting].some(p=>p.installations.includes(d.installationId!))))
      ||!!(d.lifecycleUserId && (this.knownUser(d.lifecycleUserId)||[...this.connecting].some(p=>p.userId===d.lifecycleUserId)));
  }
  lifecycle(d:GitHubDelivery) {
    if(d.event==="github_app_authorization" && d.lifecycleUserId) {
      const id=d.lifecycleUserId;
      if(this.knownUser(id)) this.disconnectUser(id);
      else for(const pending of this.connecting) {
        if(pending.userId===id) pending.revoked=true;
        else if(pending.userId===0 && !pending.revoked) {
          // Until /user returns, remember exact revoked users without globally invalidating other states.
          // Bound per-flow memory; overflow rejects this unresolved flow, never grants through lost evidence.
          if(!pending.revokedUsers.has(id) && pending.revokedUsers.size>=256) pending.revoked=true;
          else pending.revokedUsers.add(id);
        }
      }
    } else if(d.installationId) this.invalidate(d.installationId);
  }
  disconnectInstallation(id: number) {
    this.storage.transactionSync(() => { this.invalidate(id); this.storage.sql.exec("DELETE FROM github_installations WHERE id=?",id); });
  }
  needsSync() { return this.configured() && this.bindings().some(b => b.status === "active" && b.until <= Date.now() && (b.retryAt ?? 0) <= Date.now()); }
  async sync(userId?: number, restore = false) {
    // Pause all identities before the first network yield; Gmail flushes must not
    // enqueue a later identity while this synchronization is still in flight.
    for (const b of this.bindings()) if ((userId === undefined || b.user.id === userId) && b.status === "active" && !this.syncing.has(b.user.id)) this.save({...b,until:0});
    for (const u of this.identities().filter(u => userId === undefined || u.id === userId)) {
      let task = this.syncing.get(u.id);
      if (!task) { task = this.syncIdentity(u,restore).finally(() => this.syncing.delete(u.id)); this.syncing.set(u.id,task); }
      await task;
    }
  }
  private async syncIdentity(u: Identity, restore: boolean) {
    const identityCurrent = () => this.identities().some(current => current.id === u.id && current.generation === u.generation);
    const bindingCurrent = (b: Binding) => identityCurrent() && this.bindings().some(current =>
      current.installationId === b.installationId && current.user.id === u.id && current.generation === b.generation);
    if (!identityCurrent()) return;
    const targets = this.bindings().filter(b => b.user.id === u.id && (restore || b.status === "active") && (restore || (b.retryAt ?? 0) <= Date.now()));
    if (!targets.length) return;
    // Suspend permits during verification without discarding the last intersection.
    for (const b of targets) this.save({...b,until:0});
    try {
      let tokens: UserTokens;
      try { tokens = JSON.parse(await this.vault.decrypt(u.cipher,aad(u.id,u.generation))) as UserTokens; }
      catch { throw new GitHubAppError("unauthorized"); }
      if (tokens.expiresAt <= Date.now()+120_000) {
        tokens = await this.client.refresh(tokens);
        const cipher = await this.vault.encrypt(JSON.stringify(tokens),aad(u.id,u.generation));
        if (!identityCurrent()) return;
        this.storage.sql.exec("UPDATE github_identities SET value=? WHERE id=?",JSON.stringify({...u,cipher}),u.id);
      }
      // A user-level authorization failure must stop every binding for that identity.
      const identity = await this.client.discover(tokens);
      if (identity.user.id !== u.id) throw new GitHubAppError("unauthorized");
      for (const b of targets) {
        if (!bindingCurrent(b)) continue;
        try {
          const auth = await this.client.inspect(tokens,b.installationId);
          if (auth.user.id !== u.id) throw new GitHubAppError("unauthorized");
          const allowed = new Set(auth.repositories.map(r => r.id));
          const repositories = (await this.client.repositories(b.installationId)).filter(r => allowed.has(r.id));
          if (!bindingCurrent(b)) continue;
          this.storage.transactionSync(() => {
            // Revoke pending receipts removed from the authoritative intersection before publishing it.
            this.save({...b,repositories,status:"active",until:auth.expiresAt,retryAt:0,failures:0});
            this.revoke(b.installationId);
          });
        } catch (error) { if (bindingCurrent(b)) {
          if (error instanceof GitHubAppError && ["unauthorized","reauthorization_required"].includes(error.code)) this.invalidate(b.installationId);
          else this.defer(b);
        } }
      }
    } catch (error) { if (identityCurrent()) {
      if (error instanceof GitHubAppError && ["unauthorized","reauthorization_required"].includes(error.code)) this.disconnectUser(u.id);
      else for (const b of targets) if (bindingCurrent(b)) this.defer(b);
    } }
  }
}
