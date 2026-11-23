import { sha256Hex } from "../shared/hash";
import type { RegistryDO } from "../registry";
import type { RuntimeSnapshot, SandboxClient } from "./client";
import type { SharedAccess, SharedChange } from "../shared/capability-files";

type Directory = Pick<
  DurableObjectStub<RegistryDO>,
  "sharedVersion" | "sharedManifest" | "sharedRead" | "sharedApply" | "sharedResolve"
>;
type Version = Awaited<ReturnType<Directory["sharedManifest"]>>;

export class SharedMount {
  private mounted?: Version;
  constructor(
    private readonly registry: () => Directory,
    private readonly workspace: string,
    private readonly runtime: (access: SharedAccess) => SandboxClient
  ) {}
  async prepare(access: SharedAccess, fresh: boolean) {
    if (!fresh && this.mounted && this.mounted.revision === (await this.registry().sharedVersion(access))) return;
    const version = await this.registry().sharedManifest(access);
    if (fresh || version.revision !== this.mounted?.revision) {
      this.mounted = undefined;
      await this.runtime(access).restore(version.snapshot, (file) => this.registry().sharedRead(access, file.path, file.sha256));
    }
    this.mounted = version;
  }
  async changes(): Promise<{ revision: string; changes: SharedChange[] } | undefined> {
    const base = this.mounted;
    if (!base) throw new Error("shared_not_mounted");
    const runtime = this.runtime("owner"),
      next = await runtime.snapshot();
    if (!next.directories.includes("skills") || !next.directories.includes("mcp")) throw new Error("path_denied");
    const changes = await diffShared(base.snapshot, next, (path) => runtime.readBlob(path));
    if (!changes.length) return;
    this.mounted = undefined;
    return { revision: base.revision, changes };
  }
  apply(epoch: number, batch: { revision: string; changes: SharedChange[] }) {
    return this.registry().sharedApply(this.workspace, epoch, batch.revision, batch.changes);
  }
  resolve(epoch: number) {
    return this.registry().sharedResolve(this.workspace, epoch);
  }
}

export async function diffShared(base: RuntimeSnapshot, next: RuntimeSnapshot, read: (path: string) => Promise<Uint8Array>) {
  const changes: SharedChange[] = [];
  const previous = new Map(base.files.map((file) => [file.path, file]));
  const remaining = new Set([...base.directories, ...previous.keys()]);
  const dirs = new Set(base.directories);
  for (const path of next.directories) {
    remaining.delete(path);
    if (!dirs.has(path)) changes.push({ path, mode: 493 });
  }
  let bytes = 0;
  for (const file of next.files) {
    remaining.delete(file.path);
    const old = previous.get(file.path);
    if (old?.sha256 === file.sha256 && old.mode === file.mode) continue;
    // 限制同一事务的 RPC 字节；单文件仍支持 /work 的 10 MiB。
    if ((bytes += file.bytes) > 16 * 1024 * 1024) throw new Error("workspace_quota");
    const content = await read(file.path);
    if (content.byteLength !== file.bytes || sha256Hex(content) !== file.sha256) throw new Error("blob_corrupt");
    changes.push({ path: file.path, mode: file.mode, bytes: content });
  }
  for (const path of remaining) {
    if (path === "skills" || path === "mcp") continue;
    changes.push({ path });
  }
  return changes;
}
