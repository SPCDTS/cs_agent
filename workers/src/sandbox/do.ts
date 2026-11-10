import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { MediaRepository, type AssetRef } from "../media/repository";
import { imageMime } from "../media/model";
import type { DirEntry, ExecResult, FileEdit, ReadResult } from "./client";
import { nativeSandboxClient } from "./native";
import { WorkspaceManager, type WorkspaceManifest, type WorkspaceOperation, type WorkspaceRunResult, type WorkspaceCompareResult } from "./workspace";
export type { WorkspaceManifest, WorkspaceOperation, WorkspaceRunResult, WorkspaceCompareResult } from "./workspace";
export type SandboxStatus = "running" | "stopped" | "unavailable";

/** 一个 DO 拥有一个持久工作区；容器只提供临时执行环境，空闲销毁不删除 R2 manifest。 */
export class SandboxDO extends DurableObject<Env> {
  static readonly IDLE_MS = 3 * 60 * 1000;
  private ready = false;
  private runtimeGeneration = 0;
  private readonly client = nativeSandboxClient({ container: () => this.startRuntime() });
  private readonly workspace = new WorkspaceManager({ workspace: `workspace:${this.ctx.id.toString()}`, bucket: this.env.ASSETS, storage: this.ctx.storage,
    runtime: this.client, runtimeReady: () => this.ready && Boolean(this.ctx.container?.running), resetRuntime: () => this.destroyRuntime() });
  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("sandbox_unavailable");
    return container;
  }
  override async alarm(): Promise<void> {
    // 清理旧版硬期限留下的闹钟数据，不再按累计运行时长停止容器。
    await this.ctx.storage.delete("container:deadline");
  }
  private async startRuntime(): Promise<Container> {
    const container = this.container();
    if (!container.running) {
      this.ready = false;
      const generation = ++this.runtimeGeneration;
      container.start({ image: container.images.sandbox, enableInternet: true, instance: "lite" });
      this.ctx.waitUntil(container.monitor().catch(error => {
        console.error({ event: "sandbox_container_exit", message: error instanceof Error ? error.message : String(error) });
      }).finally(() => { if (this.runtimeGeneration === generation) this.ready = false; }));
    }
    await container.setInactivityTimeout(SandboxDO.IDLE_MS);
    this.ready = true;
    return container;
  }
  run(input: { operationId: string; operation: WorkspaceOperation }): Promise<WorkspaceRunResult> { return this.workspace.run(input); }
  private async result(operation: WorkspaceOperation, operationId?: string) {
    const run = await this.run({ operationId: operationId ?? crypto.randomUUID(), operation });
    if (run.status !== "committed") throw new Error(run.status === "unknown" ? "operation_unknown" : run.error + (run.issues ? `:${JSON.stringify(run.issues)}` : ""));
    return run.result;
  }
  async exec(cmd: string, options: { cwd?: string; timeoutMs: number; operationId?: string }): Promise<ExecResult> {
    const result = await this.result({ kind: "exec", command: cmd, cwd: options.cwd, timeoutMs: options.timeoutMs }, options.operationId);
    if (!("stdout" in result)) throw new Error("sandbox_error");
    return result;
  }
  async readFile(path: string, options: { offset?: number; limit?: number } = {}): Promise<ReadResult> {
    const result = await this.result({ kind: "read", path, ...options });
    if (!("text" in result) && !("kind" in result)) throw new Error("sandbox_error");
    return result;
  }
  async writeFile(path: string, text: string, operationId?: string): Promise<{ bytes: number }> {
    const result = await this.result({ kind: "write", path, text }, operationId);
    if (!("bytes" in result)) throw new Error("sandbox_error");
    return result;
  }
  async editFile(path: string, edits: FileEdit[], operationId?: string): Promise<{ replaced: number }> {
    const result = await this.result({ kind: "edit", path, edits }, operationId);
    if (!("replaced" in result)) throw new Error("sandbox_error");
    return result;
  }
  list(path: string): Promise<DirEntry[]> { return this.workspace.list(path); }
  files(revision?: string): Promise<WorkspaceManifest> { return this.workspace.files(revision); }
  snapshot(): Promise<WorkspaceManifest> { return this.files(); }
  listAssets(revision?: string): Promise<WorkspaceManifest> { return this.files(revision); }
  readBlob(path: string, revision?: string): Promise<{ bytes: Uint8Array; mime: string; name: string }> { return this.workspace.readBlob(path, revision); }
  async exportAsset(path: string, scope: string, name?: string): Promise<AssetRef> {
    const file = await this.readBlob(path);
    return new MediaRepository({ bucket: this.env.ASSETS, scope }).put({ ...file, name: name ?? file.name, kind: imageMime(file.bytes) ? "image" : "file" });
  }
  importSnapshot(input: { manifest: WorkspaceManifest; expectedRevision: string; paths?: string[] }): Promise<WorkspaceCompareResult> { return this.workspace.importSnapshot(input); }
  async cloneFrom(input: { sourceName: string; expectedRevision: string; sourceRevision?: string; operationId?: string }): Promise<WorkspaceCompareResult> {
    const manifest = await this.env.SANDBOX.getByName(input.sourceName).files(input.sourceRevision);
    return this.workspace.importSnapshot({ manifest, expectedRevision: input.expectedRevision, ...(input.operationId ? { operationId: input.operationId } : {}) });
  }
  async mergeFrom(input: { sourceName: string; expectedRevision: string; paths: string[]; sourceRevision?: string }): Promise<WorkspaceCompareResult> {
    const manifest = await this.env.SANDBOX.getByName(input.sourceName).files(input.sourceRevision);
    return this.importSnapshot({ manifest, expectedRevision: input.expectedRevision, paths: input.paths });
  }
  async status(): Promise<SandboxStatus> { const container = this.ctx.container; return !container ? "unavailable" : container.running ? "running" : "stopped"; }
  private async destroyRuntime(): Promise<boolean> {
    const container = this.container();
    this.ready = false;
    ++this.runtimeGeneration;
    if (!container.running) return false;
    await container.destroy("restore committed workspace");
    return true;
  }
  gc(options?: Parameters<WorkspaceManager["gc"]>[0]): ReturnType<WorkspaceManager["gc"]> { return this.workspace.gc(options); }
  resetRuntime(): Promise<{ reset: boolean }> { return this.workspace.resetRuntime(); }
  reset(): Promise<{ reset: boolean }> { return this.resetRuntime(); }
}
