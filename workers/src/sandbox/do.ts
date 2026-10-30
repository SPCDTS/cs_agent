import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { MediaRepository, type AssetRef } from "../media/repository";
import { imageMime } from "../media/model";
import { sandboxClient, type DirEntry, type ExecResult, type FileEdit, type ReadResult } from "./client";
import { WorkspaceManager, type WorkspaceManifest, type WorkspaceOperation, type WorkspaceRunResult, type WorkspaceCompareResult } from "./workspace";
export type { WorkspaceManifest, WorkspaceOperation, WorkspaceRunResult, WorkspaceCompareResult } from "./workspace";
export type SandboxStatus = "running" | "stopped" | "unavailable";

/** 一个 DO 拥有一个持久工作区；容器只提供临时执行环境，空闲销毁不删除 R2 manifest。 */
export class SandboxDO extends DurableObject<Env> {
  static readonly PORT = 3000;
  static readonly MAX_LIFETIME_MS = 5 * 60 * 1000;
  static readonly IDLE_MS = 3 * 60 * 1000;
  static readonly START_ATTEMPTS = 60;
  static readonly START_INTERVAL_MS = 500;
  private ready = false;
  private hardDeadline = 0;
  private runtimeGeneration = 0;
  private readonly client = sandboxClient((path, init) => this.send(path, init));
  private readonly workspace = new WorkspaceManager({ workspace: `workspace:${this.ctx.id.toString()}`, bucket: this.env.ASSETS, storage: this.ctx.storage,
    runtime: this.client, runtimeReady: () => this.ready && Boolean(this.ctx.container?.running), resetRuntime: () => this.destroyRuntime() });
  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("sandbox_unavailable");
    return container;
  }
  private async reserveBudget(): Promise<number> {
    // 结构边界使本slice可独立编译；Registry是预算事实源，不允许缺方法时降级为无限制启动。
    const registry = this.env.REGISTRY.getByName("main"), reserve: unknown = Reflect.get(registry, "reserveContainerBudget");
    if (typeof reserve !== "function") throw new Error("container_budget_unavailable");
    const result: unknown = await reserve.call(registry, `workspace:${this.ctx.id.toString()}`);
    if (!result || typeof result !== "object" || !("expiresAt" in result) || typeof result.expiresAt !== "number" || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error("container_budget_unavailable");
    return Math.min(result.expiresAt, Date.now() + SandboxDO.MAX_LIFETIME_MS);
  }
  override async alarm(): Promise<void> {
    const expires = await this.ctx.storage.get<number>("container:deadline");
    if (expires === undefined) return;
    if (Date.now() < expires) { await this.ctx.storage.setAlarm(expires); return; }
    if (this.ctx.container?.running) await this.destroyRuntime();
    this.ready = false;
    this.hardDeadline = 0;
    await this.ctx.storage.delete("container:deadline");
  }
  private async send(path: string, init?: RequestInit): Promise<Response> {
    const container = this.container();
    if (!container.running) {
      this.ready = false;
      const expires = await this.reserveBudget();
      this.hardDeadline = expires;
      await this.ctx.storage.put("container:deadline", expires);
      await this.ctx.storage.setAlarm(expires);
      const generation = ++this.runtimeGeneration;
      container.start({ image: container.images.sandbox, enableInternet: true, instance: "lite", env: { SANDBOX_DEADLINE_MS: String(expires) } });
      this.ctx.waitUntil(container.monitor().catch(error => {
        console.error({ event: "sandbox_container_exit", message: error instanceof Error ? error.message : String(error) });
      }).finally(() => { if (this.runtimeGeneration === generation) this.ready = false; }));
    }
    const deadline = this.hardDeadline || await this.ctx.storage.get<number>("container:deadline") || 0;
    if (Date.now() >= deadline) { await this.destroyRuntime(); throw new Error("container_budget_expired"); }
    await container.setInactivityTimeout(Math.min(SandboxDO.IDLE_MS, deadline - Date.now()));
    const port = container.getTcpPort(SandboxDO.PORT);
    for (let attempt = 0; !this.ready; attempt++) {
      if (Date.now() >= deadline) { await this.destroyRuntime(); throw new Error("container_budget_expired"); }
      if (attempt >= SandboxDO.START_ATTEMPTS) throw new Error("sandbox_unavailable");
      try { this.ready = (await port.fetch("http://sandbox/health")).ok; } catch { /* 端口还未监听 */ }
      if (!this.ready) await scheduler.wait(SandboxDO.START_INTERVAL_MS);
    }
    try { return await port.fetch(`http://sandbox${path}`, init); }
    catch { this.ready = false; throw new Error("sandbox_unavailable"); }
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
  async cloneFrom(input: { sourceName: string; expectedRevision: string; sourceRevision?: string }): Promise<WorkspaceCompareResult> {
    const manifest = await this.env.SANDBOX.getByName(input.sourceName).files(input.sourceRevision);
    return this.importSnapshot({ manifest, expectedRevision: input.expectedRevision });
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
