import type { SharedAccess } from "../shared/capability-files";
import type { SharedMount } from "./shared-mount";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { WorkspaceGc, type GcOptions } from "./workspace-gc";
import { FILE_MAX_BYTES, WORKSPACE_MAX_BYTES, sha256 } from "../media/model";
import { scopePrefix } from "../media/repository";
import { SandboxError, type ExecResult, type FileEdit, type ReadResult, type RuntimeSnapshot, type SandboxClient } from "./client";

const FileSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  bytes: Type.Integer({ minimum: 0, maximum: FILE_MAX_BYTES }), mime: Type.String({ maxLength: 200 }), mode: Type.Integer({ minimum: 0, maximum: 511 }) }, { additionalProperties: false });
const ManifestSchema = Type.Object({ schemaVersion: Type.Literal(1), workspace: Type.String({ minLength: 1, maxLength: 240 }),
  revision: Type.String({ pattern: "^[a-f0-9-]{1,64}$" }), parentRevision: Type.Union([Type.Null(), Type.String({ pattern: "^[a-f0-9-]{1,64}$" })]),
  files: Type.Array(FileSchema, { maxItems: 20000 }), directories: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 20000 }),
  totalBytes: Type.Integer({ minimum: 0, maximum: WORKSPACE_MAX_BYTES }) }, { additionalProperties: false });
export type WorkspaceManifest = Static<typeof ManifestSchema>;
export type WorkspaceOperation = { kind: "exec"; command: string; cwd?: string; timeoutMs?: number }
  | { kind: "read"; path: string; offset?: number; limit?: number }
  | { kind: "write"; path: string; text: string }
  | { kind: "writeBytes"; path: string; data: Uint8Array; createOnly?: boolean }
  | { kind: "mkdir" | "remove"; path: string }
  | { kind: "edit"; path: string; edits: FileEdit[] };
export type WorkspaceOperationResult = ExecResult | ReadResult | { bytes: number } | { replaced: number } | { done: true };
export type WorkspaceRunResult = { status: "committed"; persistence: "committed"; revision: string; result: WorkspaceOperationResult }
  | { status: "unknown"; persistence: "unknown"; revision: string; operationId: string }
  | { status: "failed"; persistence: "failed"; revision: string; error: string; issues?: unknown };
export type WorkspaceCompareResult = { ok: true; manifest: WorkspaceManifest } | { ok: false; conflict: WorkspaceManifest };
export type WorkspaceStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "sql" | "transaction">;
type OperationRecord = { fingerprint: string; state: "executing" | "unknown"; revision: string }
  | { fingerprint: string; state: "committed"; revision: string; result: { kind: "inline"; value: WorkspaceOperationResult } | { kind: "r2"; key: string } }
  | { fingerprint: string; state: "expired"; revision: string }
  | { fingerprint: string; state: "failed"; revision: string; error: string; issues?: unknown };
const HEAD = "workspace:head", EPOCH = "workspace:epoch";
export function relativeWorkPath(raw: string): string {
  const relative = raw.startsWith("/work/") ? raw.slice(6) : raw;
  if (!relative || relative.length > 1024 || relative.includes("\\") || relative.includes("\0") || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("path_denied");
  return relative;
}
export function parseManifest(value: unknown): WorkspaceManifest {
  if (!Check(ManifestSchema, value)) throw new Error("invalid_request");
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of value.files) {
    relativeWorkPath(file.path);
    if (paths.has(file.path)) throw new Error("invalid_request");
    paths.add(file.path); bytes += file.bytes;
  }
  for (const dir of value.directories) {
    relativeWorkPath(dir);
    if (paths.has(dir)) throw new Error("invalid_request");
    paths.add(dir);
  }
  // 一个文件不能同时是另一个条目的祖先目录。
  const filePaths = new Set(value.files.map(file => file.path));
  for (const item of paths) {
    const parts = item.split("/");
    for (let end = 1; end < parts.length; end++) if (filePaths.has(parts.slice(0, end).join("/"))) throw new Error("invalid_request");
  }
  if (bytes !== value.totalBytes) throw new Error("invalid_request");
  return value;
}

/** manifest 是事实源；容器仅是可丢弃的物化视图。所有公开操作经同一队列，副作用命令从不自动重放。 */
type SharedIntent = {
  epoch: number;
  key: string;
  previous: string;
  record: Extract<OperationRecord, { state: "committed" }>;
  recent: string[];
};
const SHARED_INTENT = "workspace:shared-intent";

export class WorkspaceManager {
  private access?: SharedAccess;
  private queue: Promise<unknown> = Promise.resolve();
  private hydrated = false;
  private readonly collector: WorkspaceGc;
  constructor(private readonly deps: { workspace: string; bucket: R2Bucket; storage: WorkspaceStorage; runtime: SandboxClient; shared?: SharedMount; resetRuntime(): Promise<unknown>; runtimeReady(): boolean }) {
    this.collector = new WorkspaceGc({ ...deps, prefix: () => this.prefix(), parse: parseManifest });
  }
  serial<T>(work: () => Promise<T>): Promise<T> {
    const start = async () => {
      if (this.deps.shared) {
        const pending = await this.deps.storage.get<SharedIntent>(SHARED_INTENT);
        if (pending) await this.finishShared(pending,await this.deps.shared.resolve(pending.epoch));
      }
      return work();
    };
    const pending = this.queue.then(start, start);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private async finishShared(intent: SharedIntent, applied: boolean) {
    await this.deps.storage.transaction(async (tx) => {
      if (applied) await tx.put({ [HEAD]: intent.record.revision, [intent.key]: intent.record, "workspace:recent": intent.recent });
      else
        await tx.put(intent.key, {
          fingerprint: intent.record.fingerprint,
          state: "failed",
          revision: intent.previous,
          error: "persistence_failed"
        } satisfies OperationRecord);
      await tx.delete(SHARED_INTENT);
    });
  }

  private async prefix(): Promise<string> { return `${await scopePrefix(this.deps.workspace)}/workspace`; }
  private empty(): WorkspaceManifest { return { schemaVersion: 1, workspace: this.deps.workspace, revision: "0", parentRevision: null, files: [], directories: [], totalBytes: 0 }; }
  private async manifest(revision?: string): Promise<WorkspaceManifest> {
    const requested = revision ?? await this.deps.storage.get<string>(HEAD) ?? "0";
    if (requested === "0") return this.empty();
    if (!/^[a-f0-9-]{1,64}$/.test(requested)) throw new Error("invalid_request");
    const object = await this.deps.bucket.get(`${await this.prefix()}/manifests/${requested}`);
    if (!object) throw new Error("workspace_manifest_missing");
    const manifest = parseManifest(await object.json());
    if (manifest.workspace !== this.deps.workspace || manifest.revision !== requested) throw new Error("workspace_manifest_corrupt");
    return manifest;
  }
  files(revision?: string): Promise<WorkspaceManifest> {
    return this.serial(async () => {
      const manifest = await this.manifest(revision), now = Date.now();
      const pins = await this.deps.storage.get<Record<string, number>>("workspace:pins") ?? {};
      for (const [id, expires] of Object.entries(pins)) if (expires < now) delete pins[id];
      if (Object.keys(pins).length >= 512 && !pins[manifest.revision]) throw new Error("workspace_lease_limit");
      pins[manifest.revision] = now + 3600000;
      await this.deps.storage.put("workspace:pins", pins);
      return manifest;
    });
  }
  private async blob(file: WorkspaceManifest["files"][number], workspace = this.deps.workspace): Promise<Uint8Array> {
    const object = await this.deps.bucket.get(`${await scopePrefix(workspace)}/workspace/blobs/${file.sha256}`);
    if (!object || object.size !== file.bytes || object.size > FILE_MAX_BYTES) throw new Error("blob_corrupt");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await sha256(bytes) !== file.sha256) throw new Error("blob_corrupt");
    return bytes;
  }
  readBlob(path: string, revision?: string): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
    return this.serial(async () => {
      const manifest = await this.manifest(revision), relative = relativeWorkPath(path), file = manifest.files.find(file => file.path === relative);
      if (!file) throw new Error("not_found");
      return { bytes: await this.blob(file), mime: file.mime, name: file.path.split("/").at(-1) ?? "file" };
    });
  }
  /** 附件不是容器命令：只提交已校验字节、manifest 与成功回执，失败不留下不可重试的命令状态。 */
  saveAttachment(path: string, bytes: Uint8Array, operationId: string): Promise<void> {
    return this.serial(async () => {
      const relative = relativeWorkPath(path);
      if (!operationId || operationId.length > 240) throw new Error("invalid_request");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > FILE_MAX_BYTES) throw new Error("too_large");
      if (relative.split("/").some(part => [".git", ".wrangler", "node_modules"].includes(part))) throw new Error("path_denied");
      const hash = await sha256(bytes), fingerprint = await sha256(JSON.stringify([relative, hash]));
      const receiptKey = "workspace:attachment:" + await sha256(operationId);
      const receipt = await this.deps.storage.get<{ fingerprint: string }>(receiptKey);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error("operation_conflict");
        return; // 曾经提交成功；即使现在副本已被编辑或删除，也不触碰它。
      }
      const current = await this.manifest(), existing = current.files.find(file => file.path === relative);
      if (existing && existing.sha256 !== hash || current.directories.includes(relative)
        || current.files.some(file => relative.startsWith(file.path + "/"))) throw new Error("workspace_conflict");
      const parts = relative.split("/"), directories = [...new Set([...current.directories,
        ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))])];
      const file = { path: relative, sha256: hash, bytes: bytes.byteLength, mime: "application/octet-stream", mode: 420 };
      const manifest = existing ? current : parseManifest({ ...current, revision: crypto.randomUUID(), parentRevision: current.revision,
        files: [...current.files, file], directories, totalBytes: current.totalBytes + bytes.byteLength });
      if (!existing) {
        await this.deps.bucket.put(`${await this.prefix()}/blobs/${hash}`, bytes);
        await this.deps.bucket.put(`${await this.prefix()}/manifests/${manifest.revision}`, JSON.stringify(manifest));
      }
      // 先使运行时失效：即使事务已提交但调用方丢失响应，后续操作也必须从 head 恢复。
      this.hydrated = false;
      await this.deps.storage.transaction(async tx => {
        if ((await tx.get<string>(HEAD) ?? "0") !== current.revision) throw new Error("workspace_conflict");
        await tx.put({ [HEAD]: manifest.revision, [EPOCH]: (await tx.get<number>(EPOCH) ?? 0) + 1, [receiptKey]: { fingerprint } });
      });
    });
  }

  /** 仅在接收方已持久入箱后调用；部分导入或 unknown 不得释放附件证明。 */
  retireAttachments(operationIds: string[]): Promise<void> {
    return this.serial(async () => {
      const keys = await Promise.all(operationIds.map(async id => "workspace:attachment:" + await sha256(id)));
      if (keys.length) await this.deps.storage.delete(keys);
    });
  }

  private async ensureRuntime(manifest: WorkspaceManifest, access?: SharedAccess, refreshShared = true): Promise<void> {
    const fresh = !this.hydrated || this.access !== access || !this.deps.runtimeReady();
    this.hydrated = false;
    if (fresh) {
      await this.deps.resetRuntime();
      await this.deps.runtime.restore(manifest, (file) => this.blob(file));
    }
    if (access && (fresh || refreshShared)) await this.deps.shared?.prepare(access, fresh);
    this.access = access;
    this.hydrated = true;
  }

  private async commit(snapshot: RuntimeSnapshot, previous: WorkspaceManifest, epoch: number): Promise<WorkspaceManifest> {
    const manifest = parseManifest({ ...snapshot, schemaVersion: 1, workspace: this.deps.workspace, revision: crypto.randomUUID(), parentRevision: previous.revision });
    if (JSON.stringify(snapshot.files) === JSON.stringify(previous.files) && JSON.stringify(snapshot.directories) === JSON.stringify(previous.directories)) return previous;
    const previousHashes = new Set(previous.files.map(file => file.sha256));
    for (const file of manifest.files) {
      if (previousHashes.has(file.sha256)) continue;
      const bytes = await this.deps.runtime.readBlob(file.path);
      if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error("blob_corrupt");
      await this.deps.bucket.put(`${await this.prefix()}/blobs/${file.sha256}`, bytes);
      previousHashes.add(file.sha256);
    }
    if (await this.deps.storage.get<number>(EPOCH) !== epoch) throw new Error("workspace_conflict");
    await this.deps.bucket.put(`${await this.prefix()}/manifests/${manifest.revision}`, JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
    if (await this.deps.storage.get<number>(EPOCH) !== epoch) throw new Error("workspace_conflict");
    return manifest;
  }
  private async execute(operation: WorkspaceOperation): Promise<WorkspaceOperationResult> {
    switch (operation.kind) {
      case "exec": return this.deps.runtime.exec(operation.command, { cwd: operation.cwd, timeoutMs: operation.timeoutMs ?? 60000 });
      case "read": return this.deps.runtime.readFile(operation.path, { offset: operation.offset, limit: operation.limit });
      case "write": return this.deps.runtime.writeFile(operation.path, operation.text);
      case "writeBytes": return this.deps.runtime.writeFile(operation.path, operation.data);
      case "mkdir": await this.deps.runtime.mkdir(operation.path); return { done: true };
      case "remove": await this.deps.runtime.remove(operation.path); return { done: true };
      case "edit": return this.deps.runtime.editFile(operation.path, operation.edits);
      default: { const exhaustive: never = operation; throw new Error(`invalid_operation:${exhaustive}`); }
    }
  }
  run(input: { operationId: string; operation: WorkspaceOperation; sharedAccess?: SharedAccess }): Promise<WorkspaceRunResult> {
    return this.serial(async () => {
      if (!input.operationId || input.operationId.length > 240) throw new Error("invalid_request");
      if ("path" in input.operation && (input.operation.path==="/shared" || input.operation.path.startsWith("/shared/"))
        && (!input.sharedAccess || input.operation.kind!=="read" && input.sharedAccess!=="owner")) throw new Error("permission_denied");
      const usesShared = input.operation.kind==="exec" || input.operation.path==="/shared" || input.operation.path.startsWith("/shared/");
      const runtimeAccess = usesShared ? input.sharedAccess : this.access;
      if (input.operation.kind === "read") {
        const manifest = await this.manifest();
        await this.ensureRuntime(manifest,runtimeAccess,usesShared);
        return { status: "committed", persistence: "committed", revision: manifest.revision, result: await this.execute(input.operation) };
      }
      if (input.operation.kind === "writeBytes" && (!(input.operation.data instanceof Uint8Array) || input.operation.data.byteLength > FILE_MAX_BYTES)) throw new Error("too_large");
      const digest = input.operation.kind === "writeBytes" ? await sha256(input.operation.data) : undefined;
      const encoded = JSON.stringify(input.operation.kind === "writeBytes" ? { ...input.operation, data:digest } : input.operation);
      const legacyFingerprint = await sha256(encoded);
      const fingerprint = input.sharedAccess ? await sha256(input.sharedAccess+"|"+encoded) : legacyFingerprint, key = `workspace:op:${await sha256(input.operationId)}`;
      const previous = await this.deps.storage.get<OperationRecord>(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint && previous.fingerprint !== legacyFingerprint) throw new Error("operation_conflict");
        switch (previous.state) {
          case "executing": case "unknown":
            this.hydrated = false;
            await this.deps.storage.put({ [key]: { ...previous, state: "unknown" }, [EPOCH]: (await this.deps.storage.get<number>(EPOCH) ?? 0) + 1 });
            await this.deps.resetRuntime();
            return { status: "unknown", persistence: "unknown", revision: previous.revision, operationId: input.operationId };
          case "expired": return { status: "failed", persistence: "failed", revision: previous.revision, error: "operation_expired" };
          case "failed": return { status: "failed", persistence: "failed", revision: previous.revision, error: previous.error, issues: previous.issues };
          case "committed": {
            if (previous.result.kind === "inline") return { status: "committed", persistence: "committed", revision: previous.revision, result: previous.result.value };
            const object = await this.deps.bucket.get(previous.result.key);
            if (!object) throw new Error("workspace_result_missing");
            // 该对象只由 execute 的已验证控制服务响应写入，不接受外部导入覆盖。
            const result = await object.json<WorkspaceOperationResult>();
            return { status: "committed", persistence: "committed", revision: previous.revision, result };
          }
        }
      }
      const manifest = await this.manifest();
      const destination = input.operation.kind === "writeBytes" && input.operation.createOnly ? relativeWorkPath(input.operation.path) : undefined;
      if (destination) {
        const existing = manifest.files.find(file => file.path === destination);
        if (existing && existing.sha256 === digest) {
          return { status: "committed", persistence: "committed", revision: manifest.revision, result: { bytes: existing.bytes } };
        }
        if (existing || manifest.directories.includes(destination) || manifest.files.some(file => destination.startsWith(file.path + "/"))) {
          throw new Error("workspace_conflict");
        }
        if (destination.split("/").some(part => [".git", ".wrangler", "node_modules"].includes(part))) throw new Error("path_denied");
      }
      await this.ensureRuntime(manifest,runtimeAccess,usesShared);
      const epoch = (await this.deps.storage.get<number>(EPOCH) ?? 0) + 1;
      await this.deps.storage.put(EPOCH, epoch);
      await this.deps.storage.put(key, { fingerprint, state: "executing", revision: manifest.revision } satisfies OperationRecord);
      let executed = false;
      try {
        const result = await this.execute(input.operation);
        executed = true;
        const retainedPaths = [...manifest.files.map(file => file.path), ...manifest.directories];
        const snapshot = await this.deps.runtime.snapshot(retainedPaths);
        if (destination && !snapshot.files.some(file => file.path === destination && file.sha256 === digest)) throw new Error("persistence_failed");
        const committed = await this.commit(snapshot, manifest, epoch);
        const resultKey = `${await this.prefix()}/results/${await sha256(input.operationId)}`;
        const encodedResult = JSON.stringify(result);
        const storedResult: Extract<OperationRecord, { state: "committed" }>["result"] = new TextEncoder().encode(encodedResult).length <= 32768 ? { kind: "inline", value: result } : { kind: "r2", key: resultKey };
        if (storedResult.kind === "r2") await this.deps.bucket.put(resultKey, encodedResult, { httpMetadata: { contentType: "application/json" } });
        const recent = await this.deps.storage.get<string[]>("workspace:recent") ?? [];
        recent.push(key);
        const expiredKey = recent.length > 32 ? recent.shift() : undefined;
        const record={fingerprint,state:"committed",revision:committed.revision,result:storedResult} as const;
        const shared=usesShared && input.sharedAccess==="owner" ? this.deps.shared : undefined;
        const batch=await shared?.changes();
        if (shared && batch) {
          const intent:SharedIntent={epoch,key,previous:manifest.revision,record,recent};
          await this.deps.storage.put(SHARED_INTENT,intent);
          try { await shared.apply(epoch,batch); }
          catch (error) {
            const applied=await shared.resolve(epoch);
            if (!applied) { await this.finishShared(intent,false); throw error; }
          }
          await this.finishShared(intent,true);
        } else {
          await this.deps.storage.transaction(async tx=>{
            if (await tx.get<number>(EPOCH)!==epoch) throw new Error("workspace_conflict");
            await tx.put({[HEAD]:committed.revision,[key]:record,"workspace:recent":recent});
          });
        }
        if (expiredKey) {
          try {
            const expired = await this.deps.storage.get<OperationRecord>(expiredKey);
            if (expired?.state === "committed") {
              await this.deps.storage.put(expiredKey, { fingerprint: expired.fingerprint, state: "expired", revision: expired.revision } satisfies OperationRecord);
              if (expired.result.kind === "r2") await this.deps.bucket.delete(expired.result.key);
            }
          } catch { console.error({ event: "workspace_result_cleanup_failed" }); }
        }
        return { status: "committed", persistence: "committed", revision: committed.revision, result };
      } catch (error) {
        this.hydrated = false;
        if (this.deps.shared && await this.deps.storage.get(SHARED_INTENT)) return {status:"unknown",persistence:"unknown",revision:manifest.revision,operationId:input.operationId};
        const code = error instanceof Error ? error.message : "sandbox_error";
        if (!executed && code === "sandbox_unavailable" && input.operation.kind === "exec") {
          await this.deps.storage.put(key, { fingerprint, state: "unknown", revision: manifest.revision } satisfies OperationRecord);
          // 原生执行中断时助手可能还未收尾；先销毁容器，不能让后台写入进入后续快照。
          await this.deps.resetRuntime();
          return { status: "unknown", persistence: "unknown", revision: manifest.revision, operationId: input.operationId };
        }
        const failure = { fingerprint, state: "failed", revision: manifest.revision, error: executed && !["workspace_quota", "blob_corrupt", "workspace_conflict", "invalid_request", "path_denied"].includes(code) ? "persistence_failed" : code,
          ...(error instanceof SandboxError && error.issues !== undefined ? { issues: error.issues } : {}) } satisfies OperationRecord;
        await this.deps.storage.put(key, failure);
        // 容器里未提交的文件不可冒充成功，也不能留给下一条命令继续使用。
        await this.deps.resetRuntime();
        return { status: "failed", persistence: "failed", revision: manifest.revision, error: failure.error, ...("issues" in failure ? { issues: failure.issues } : {}) };
      }
    });
  }
  list(path: string): ReturnType<SandboxClient["list"]> {
    return this.serial(async () => {
      if (path==="/shared" || path.startsWith("/shared/")) throw new Error("permission_denied");
      await this.ensureRuntime(await this.manifest(),this.access,false);
      return this.deps.runtime.list(path);
    });
  }
  resetRuntime(): Promise<{ reset: boolean }> {
    return this.serial(async () => { this.hydrated = false; await this.deps.storage.put(EPOCH, (await this.deps.storage.get<number>(EPOCH) ?? 0) + 1); return { reset: Boolean(await this.deps.resetRuntime()) }; });
  }
  gc(options: GcOptions = {}) { return this.serial(() => this.collector.run(options)); }
  resumeGc() { return this.serial(() => this.collector.resume()); }
  importSnapshot(input: { manifest: WorkspaceManifest; expectedRevision: string; paths?: string[]; operationId?: string }): Promise<WorkspaceCompareResult> {
    return this.serial(async () => {
      const source = parseManifest(input.manifest), current = await this.manifest();
      const receiptKey = input.operationId ? "workspace:import:" + await sha256(new TextEncoder().encode(input.operationId)) : undefined;
      const fingerprint = await sha256(new TextEncoder().encode(JSON.stringify(input)));
      const receipt = receiptKey ? await this.deps.storage.get<{ fingerprint: string; revision: string }>(receiptKey) : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error("operation_conflict");
        return { ok: true, manifest: await this.manifest(receipt.revision) };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, conflict: current };
      const selected = input.paths ? new Set(input.paths.map(relativeWorkPath)) : undefined;
      const changed = source.files.filter(file => !selected || selected.has(file.path));
      const files = selected ? [...current.files.filter(file => !selected.has(file.path)), ...changed] : changed;
      const directories = [...new Set([...(selected ? current.directories : []), ...source.directories])].filter(dir => !files.some(file => file.path === dir));
      const manifest = parseManifest({ schemaVersion: 1, workspace: this.deps.workspace, revision: crypto.randomUUID(), parentRevision: current.revision,
        files, directories, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) });
      // 在提交 head 前验证并复制每个被引用的源 blob；父子 scope 永不通过模型路径共享。
      for (const file of changed) await this.deps.bucket.put(`${await this.prefix()}/blobs/${file.sha256}`, await this.blob(file, source.workspace));
      await this.deps.bucket.put(`${await this.prefix()}/manifests/${manifest.revision}`, JSON.stringify(manifest));
      await this.deps.storage.transaction(async tx => {
        if ((await tx.get<string>(HEAD) ?? "0") !== current.revision) throw new Error("workspace_conflict");
        await tx.put({ [HEAD]: manifest.revision, [EPOCH]: (await tx.get<number>(EPOCH) ?? 0) + 1,
          ...(receiptKey ? { [receiptKey]: { fingerprint, revision: manifest.revision } } : {}) });
      });
      this.hydrated = false;
      if (this.deps.runtimeReady()) await this.deps.resetRuntime();
      return { ok: true, manifest };
    });
  }
}
