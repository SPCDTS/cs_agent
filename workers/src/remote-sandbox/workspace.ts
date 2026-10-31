import type { Env } from "../env";
import type { DirEntry } from "../sandbox/client";
import type { WorkspaceManager, WorkspaceManifest, WorkspaceOperation } from "../sandbox/workspace";
import { type AcquireInput, hash } from "./fleet";
import { SourceFiles } from "./source-files";
import { OperationSchema, JobInputSchema, parse, relativePath, ephemeralPath, validateSnapshot, type Lease, type JobInput, type Operation } from "../../../runner/src/protocol";

type Intent = { jobId: string; fingerprint: string; inputKey: string };
type Commit = { state: "committed"; revision: string } | { state: "conflict"; revision: string } | { state: "cancelled" | "failed" | "unknown" };
export class RemoteWorkspace {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: { name: string; env: Env; storage: DurableObjectStorage; workspace: WorkspaceManager }) {}
  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work); this.queue = result.catch(() => undefined); return result;
  }
  private fleet() { return this.deps.env.SANDBOX_FLEET.getByName("owner"); }
  private lease() { return this.deps.storage.get<Lease>("remote:lease"); }
  private async idle() { if (await this.deps.storage.get("remote:active")) throw new Error("remote_job_running"); }
  async selection() { return { lease: await this.lease() ?? null, activeJob: await this.deps.storage.get<string>("remote:active") ?? null }; }
  acquire(input: Omit<AcquireInput, "workspace">) {
    return this.serial(async () => {
      await this.idle();
      const lease = await this.lease();
      if (lease && lease.operationId !== input.operationId) throw new Error("release_current_sandbox_first");
      const selected = await this.fleet().acquire({ ...input, workspace: this.deps.name });
      await this.deps.storage.put("remote:lease", selected); return selected;
    });
  }
  release() {
    return this.serial(async () => {
      await this.idle(); const lease = await this.lease(); if (!lease) return { selected: "cloudflare" };
      try { await this.fleet().release(lease); }
      catch (error) { if (!(error instanceof Error) || !error.message.includes("lease_expired")) throw error; }
      await this.deps.storage.delete("remote:lease"); return { selected: "cloudflare" };
    });
  }
  run(input: { operationId: string; operation: WorkspaceOperation }) {
    return this.serial(async () => {
      if (!await this.lease()) return this.deps.workspace.run(input);
      if (input.operation.kind === "exec") throw new Error("remote_async_required");
      if (input.operation.kind !== "read") await this.idle();
      return new SourceFiles({ bucket: this.deps.env.ASSETS, storage: this.deps.storage, workspace: this.deps.workspace }).run(input.operationId, input.operation);
    });
  }
  list(path: string): Promise<DirEntry[]> {
    return this.serial(async () => {
      if (!await this.lease()) return this.deps.workspace.list(path);
      const relative = relativePath(path, true), prefix = relative ? relative + "/" : "", manifest = await this.deps.workspace.files();
      if (manifest.files.some(file => file.path === relative)) throw new Error("not_a_directory");
      if (relative && !manifest.directories.includes(relative)) throw new Error("not_found");
      const entries: DirEntry[] = [];
      for (const dir of manifest.directories) if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/"))
        entries.push({ name: dir.slice(prefix.length), type: "dir", size: 0 });
      for (const file of manifest.files) if (file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes("/"))
        entries.push({ name: file.path.slice(prefix.length), type: "file", size: file.bytes });
      return entries;
    });
  }
  mutate<T>(fn: () => Promise<T>) { return this.serial(async () => { await this.idle(); return fn(); }); }
  start(operationId: string, value: Operation) {
    return this.serial(async () => {
      const operation = parse(OperationSchema, value); relativePath(operation.cwd, true);
      const fingerprint = await hash(JSON.stringify(operation)), receiptKey = "remote:start:" + await hash(operationId);
      let intent = await this.deps.storage.get<Intent>(receiptKey);
      if (intent && intent.fingerprint !== fingerprint) throw new Error("operation_conflict");
      if (!intent) {
        await this.idle();
        const lease = await this.lease(); if (!lease) throw new Error("select_remote_sandbox_first");
        const manifest = await this.deps.workspace.files();
        const files = manifest.files.filter(file => !ephemeralPath(file.path)), directories = manifest.directories.filter(path => !ephemeralPath(path));
        const source = validateSnapshot({ files, directories, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) });
        const id = crypto.randomUUID(), now = Date.now();
        const input: JobInput = { id, lease, operation, baseRevision: manifest.revision, source, createdAt: now, deadline: now + operation.timeoutMs + 360000 };
        const inputKey = "remote-intents/" + id;
        await this.deps.env.ASSETS.put(inputKey, JSON.stringify(input));
        intent = { jobId: id, fingerprint, inputKey };
        await this.deps.storage.put({ [receiptKey]: intent, ["remote:intent:" + id]: intent, "remote:active": id });
      }
      const committed = await this.deps.storage.get<Commit>("remote:commit:" + intent.jobId);
      if (committed && committed.state !== "unknown") return { jobId: intent.jobId, persistence: committed };
      try { await this.dispatch(intent); }
      catch (error) { return { jobId: intent.jobId, phase: "dispatch_pending", error: error instanceof Error ? error.message : "dispatch_unconfirmed" }; }
      return { jobId: intent.jobId, ...(await this.selection()) };
    });
  }
  private async dispatch(intent: Intent) {
    const object = await this.deps.env.ASSETS.get(intent.inputKey);
    if (!object) throw new Error("input_missing");
    await this.fleet().start(parse(JobInputSchema, await object.json()));
  }
  finish(id: string) {
    return this.serial(async () => {
      const intent = await this.deps.storage.get<Intent>("remote:intent:" + id);
      if (!intent) throw new Error("permission_denied");
      let job;
      try { job = await this.fleet().inspect(this.deps.name, id); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("job_not_found")) throw error;
        const prior = await this.deps.storage.get<Commit>("remote:commit:" + id);
        if (prior) return { jobId: id, phase: "result_expired", persistence: prior };
        await this.dispatch(intent); return { jobId: id, phase: "dispatched", persistence: "pending" };
      }
      let commit = await this.deps.storage.get<Commit>("remote:commit:" + id);
      if (job.outcome && (!commit || commit.state === "unknown")) {
        if (job.outcome.kind === "completed") {
          const source: WorkspaceManifest = { ...job.outcome.snapshot, schemaVersion: 1, workspace: "remote:" + id, revision: id, parentRevision: null };
          const result = await this.deps.workspace.importSnapshot({ manifest: source, expectedRevision: job.input.baseRevision, operationId: "remote:" + id });
          commit = result.ok ? { state: "committed", revision: result.manifest.revision } : { state: "conflict", revision: result.conflict.revision };
        } else commit = { state: job.outcome.kind };
        await this.deps.storage.put("remote:commit:" + id, commit);
      }
      if (commit) {
        if (commit.state !== "unknown" && await this.deps.storage.get("remote:active") === id) await this.deps.storage.delete("remote:active");
        await this.fleet().acknowledgeCommit(this.deps.name, id);
      }
      return { jobId: id, phase: job.phase, persistence: commit ?? "pending", result: job.outcome?.kind === "completed" ? job.outcome.result : job.outcome,
        log: job.log, recoveryWorkspace: commit?.state === "conflict" ? "remote:" + id : undefined };
    });
  }
  cancel(id: string) {
    return this.serial(async () => {
      if (!await this.deps.storage.get("remote:intent:" + id)) throw new Error("permission_denied");
      try { await this.fleet().cancel(this.deps.name, id); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("job_not_found")) throw error;
        await this.deps.storage.put("remote:commit:" + id, { state: "cancelled" } satisfies Commit);
        if (await this.deps.storage.get("remote:active") === id) await this.deps.storage.delete("remote:active");
      }
    });
  }
}
