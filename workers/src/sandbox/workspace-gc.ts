import type { WorkspaceManifest } from "./workspace";

export type GcOptions = { keepManifests?: number; retentionMs?: number; graceMs?: number; batchSize?: number; dryRun?: boolean };
type Phase = "inventory" | "manifests" | "blobs" | "results" | "cleanup";
type Policy = { keep: number; retention: number; grace: number; batch: number };
type State = {
  phase: Phase; cursor?: string; startedAt: number; policy: Policy;
  latest: { key: string; uploaded: number }[]; protected: string;
  scanned: number; candidates: number; deleted: number;
};
export type GcReport = {
  phase: Phase | "mark" | "done"; startedAt: number; dryRun: boolean;
  scanned: number; stepScanned: number; candidates: number; deleted: number;
};
type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "sql">;

/** 每次只处理一页或一个保留版本；可达性保存在 SQLite，不把整个工作区历史装入内存。 */
export class WorkspaceGc {
  constructor(private readonly deps: {
    workspace: string; storage: Storage; bucket: R2Bucket; prefix(): Promise<string>;
    parse(value: unknown): WorkspaceManifest;
  }) {}

  private tables() {
    this.deps.storage.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_gc_manifests (
      mode INTEGER NOT NULL, key TEXT NOT NULL, marked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(mode,key));
      CREATE INDEX IF NOT EXISTS workspace_gc_pending ON workspace_gc_manifests(mode,marked);
      CREATE TABLE IF NOT EXISTS workspace_gc_refs (mode INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY(mode,key));`);
  }
  private key(dryRun: boolean) { return "workspace:gc:" + (dryRun ? "dry" : "apply"); }
  private protect(mode: number, keys: string[]) {
    if (keys.length) this.deps.storage.sql.exec(
      "INSERT OR IGNORE INTO workspace_gc_manifests(mode,key) SELECT ?, value FROM json_each(?)", mode, JSON.stringify(keys));
  }
  async run(options: GcOptions = {}): Promise<GcReport> {
    const dryRun = options.dryRun ?? true;
    let state = await this.deps.storage.get<State>(this.key(dryRun));
    if (!state) {
      state = { phase: "inventory", startedAt: Date.now(), cursor: undefined, latest: [], protected: "",
        policy: { keep: Math.max(1, Math.min(100, options.keepManifests ?? 3)), retention: Math.max(3600000, options.retentionMs ?? 3600000),
          grace: Math.max(3600000, options.graceMs ?? 86400000), batch: Math.max(1, Math.min(500, options.batchSize ?? 100)) },
        scanned: 0, candidates: 0, deleted: 0 };
      await this.deps.storage.put(this.key(dryRun), state);
    }
    return this.step(state, dryRun);
  }
  async resume(): Promise<GcReport | undefined> {
    const state = await this.deps.storage.get<State>(this.key(false));
    return state ? this.step(state, false) : undefined;
  }
  private async step(state: State, dryRun: boolean): Promise<GcReport> {
    this.tables();
    const { storage, bucket } = this.deps, sql = storage.sql, mode = Number(dryRun), prefix = await this.deps.prefix();
    const before = state.scanned;
    const save = async (phase: GcReport["phase"] = state.phase): Promise<GcReport> => {
      const report = { phase, startedAt: state.startedAt, dryRun, scanned: state.scanned, stepScanned: state.scanned - before,
        candidates: state.candidates, deleted: state.deleted };
      if (phase === "done") await storage.delete(this.key(dryRun));
      else await storage.put(this.key(dryRun), state);
      await storage.put(this.key(dryRun) + ":last", report);
      return report;
    };
    if (state.phase === "cleanup") {
      sql.exec("DELETE FROM workspace_gc_refs WHERE mode=? AND key IN (SELECT key FROM workspace_gc_refs WHERE mode=? LIMIT ?)", mode, mode, state.policy.batch);
      sql.exec("DELETE FROM workspace_gc_manifests WHERE mode=? AND key IN (SELECT key FROM workspace_gc_manifests WHERE mode=? LIMIT ?)", mode, mode, state.policy.batch);
      const pending = sql.exec<{ n: number }>("SELECT EXISTS(SELECT 1 FROM workspace_gc_refs WHERE mode=?) OR EXISTS(SELECT 1 FROM workspace_gc_manifests WHERE mode=?) AS n", mode, mode).one().n;
      return save(pending ? "cleanup" : "done");
    }

    // 每批删除前重新保护 head 和有效租约。新增保护先完成标记，原有标记只增不减。
    // 因此两批之间可以正常写入、导入或申请租约，不需要重新扫描历史，也不会误删新引用。
    const head = await storage.get<string>("workspace:head") ?? "0";
    const pins = await storage.get<Record<string, number>>("workspace:pins") ?? {};
    const revisions = [...new Set([...(head === "0" ? [] : [head]), ...Object.keys(pins).filter(id => id !== "0" && pins[id] > Date.now())])].sort();
    const protectedKey = JSON.stringify(revisions);
    if (protectedKey !== state.protected) {
      this.protect(mode, revisions.map(revision => `${prefix}/manifests/${revision}`));
      state.protected = protectedKey;
    }
    const pending = sql.exec<{ key: string }>("SELECT key FROM workspace_gc_manifests WHERE mode=? AND marked=0 LIMIT 1", mode).toArray()[0];
    if (pending) {
      const stored = await bucket.get(pending.key);
      if (!stored) throw new Error("workspace_manifest_missing");
      const manifest = this.deps.parse(await stored.json());
      if (manifest.workspace !== this.deps.workspace || !pending.key.endsWith("/" + manifest.revision)) throw new Error("workspace_manifest_corrupt");
      sql.exec("INSERT OR IGNORE INTO workspace_gc_refs(mode,key) SELECT ?, value FROM json_each(?)", mode, JSON.stringify(manifest.files.map(file => file.sha256)));
      sql.exec("UPDATE workspace_gc_manifests SET marked=1 WHERE mode=? AND key=?", mode, pending.key);
      return save("mark");
    }

    const segment = state.phase === "inventory" ? "manifests" : state.phase;
    const page = await bucket.list({ prefix: `${prefix}/${segment}/`, cursor: state.cursor, limit: state.policy.batch });
    state.scanned += page.objects.length;
    state.cursor = page.truncated ? page.cursor : undefined;
    if (state.phase === "inventory") {
      state.latest = [...state.latest, ...page.objects.map(object => ({ key: object.key, uploaded: object.uploaded.getTime() }))]
        .sort((a, b) => b.uploaded - a.uploaded || a.key.localeCompare(b.key)).slice(0, state.policy.keep);
      this.protect(mode, page.objects.filter(object => object.uploaded.getTime() > state.startedAt - state.policy.retention).map(object => object.key));
      if (!page.truncated) { this.protect(mode, state.latest.map(object => object.key)); state.phase = "manifests"; }
      return save();
    }

    let candidates: string[];
    if (state.phase === "manifests") {
      const protectedKeys = new Set(sql.exec<{ key: string }>("SELECT key FROM workspace_gc_manifests WHERE mode=? AND key IN (SELECT value FROM json_each(?))", mode, JSON.stringify(page.objects.map(object => object.key))).toArray().map(row => row.key));
      candidates = page.objects.filter(object => object.uploaded.getTime() <= state.startedAt - state.policy.retention && !protectedKeys.has(object.key)).map(object => object.key);
    } else if (state.phase === "blobs") {
      const hashes = page.objects.map(object => object.key.slice(object.key.lastIndexOf("/") + 1));
      const reachable = new Set(sql.exec<{ key: string }>("SELECT key FROM workspace_gc_refs WHERE mode=? AND key IN (SELECT value FROM json_each(?))", mode, JSON.stringify(hashes)).toArray().map(row => row.key));
      candidates = page.objects.filter((object, index) => object.uploaded.getTime() <= state.startedAt - state.policy.grace && !reachable.has(hashes[index])).map(object => object.key);
    } else {
      const recent = new Set((await storage.get<string[]>("workspace:recent") ?? []).map(key => `${prefix}/results/${key.slice("workspace:op:".length)}`));
      candidates = page.objects.filter(object => object.uploaded.getTime() <= state.startedAt - Math.max(state.policy.retention, 30 * 86400000) && !recent.has(object.key)).map(object => object.key);
    }
    if (!dryRun && candidates.length) await bucket.delete(candidates);
    state.candidates += candidates.length;
    state.deleted += dryRun ? 0 : candidates.length;
    if (!page.truncated) state.phase = state.phase === "manifests" ? "blobs" : state.phase === "blobs" ? "results" : "cleanup";
    return save();
  }
}
