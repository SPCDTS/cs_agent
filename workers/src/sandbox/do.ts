import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { GcReport } from "./workspace-gc";
import { MediaRepository, type AssetRef } from "../media/repository";
import { imageMime } from "../media/model";
import type { DirEntry, ExecResult, FileEdit, ReadResult } from "./client";
import { nativeSandboxClient } from "./native";
import { createOutputDirectory } from "./output-directory";
import { classifyError, logDiag } from "../shared/diagnostics";
import { WorkspaceManager, type WorkspaceManifest, type WorkspaceOperation, type WorkspaceRunResult, type WorkspaceCompareResult } from "./workspace";
export type { WorkspaceManifest, WorkspaceOperation, WorkspaceRunResult, WorkspaceCompareResult } from "./workspace";
export type SandboxStatus = "running" | "stopped" | "unavailable";
export type SandboxTelemetry = {
  bootCount: number;
  lastBootMs: number | null;
  lastBootAt: number | null;
  exitCount: number;
  lastExitAt: number | null;
  lastExitCode: string | null;
  execCount: number;
  timeoutCount: number;
};
const TELEMETRY_KEY = "sandbox:telemetry";
const EMPTY_TELEMETRY: SandboxTelemetry = { bootCount: 0, lastBootMs: null, lastBootAt: null, exitCount: 0, lastExitAt: null, lastExitCode: null, execCount: 0, timeoutCount: 0 };

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
    try { await this.collectGc(() => this.workspace.resumeGc()); }
    catch (error) {
      // 接住本轮失败再安排下一次，避免平台因未捕获异常立即退避重试。
      await this.ctx.storage.setAlarm(Date.now() + 300_000);
      logDiag(this.env, this.ctx, { event: "workspace_gc_failed", error });
    }
  }
  private async updateTelemetry(mutate: (current: SandboxTelemetry) => SandboxTelemetry): Promise<SandboxTelemetry> {
    const current = (await this.ctx.storage.get<SandboxTelemetry>(TELEMETRY_KEY)) ?? EMPTY_TELEMETRY;
    const next = mutate({ ...EMPTY_TELEMETRY, ...current });
    await this.ctx.storage.put(TELEMETRY_KEY, next);
    return next;
  }
  private async startRuntime(): Promise<Container> {
    const container = this.container();
    const booting = !container.running;
    const bootStarted = booting ? Date.now() : 0;
    if (booting) {
      this.ready = false;
      const generation = ++this.runtimeGeneration;
      container.start({ image: container.images.sandbox, enableInternet: true, instance: "lite" });
      this.ctx.waitUntil(container.monitor().catch(async error => {
        const info = classifyError(error);
        const exitCode = info.code ?? info.errorName ?? "exit";
        logDiag(this.env, this.ctx, { event: "sandbox_container_exit", code: exitCode, error });
        await this.updateTelemetry(t => ({ ...t, exitCount: t.exitCount + 1, lastExitAt: Date.now(), lastExitCode: exitCode })).catch(() => {});
        await this.env.REGISTRY.getByName("main").recordAlert({
          kind: "sandbox_error", scope: "sandbox", origin: "web", episode: `${this.ctx.id.toString()}:${generation}`,
          message: `沙箱容器异常退出（${exitCode}），后续调用将自动重建。`,
        }).catch(() => {});
      }).finally(() => { if (this.runtimeGeneration === generation) this.ready = false; }));
    }
    await container.setInactivityTimeout(SandboxDO.IDLE_MS);
    this.ready = true;
    if (booting) {
      const now = Date.now(), bootMs = Math.max(0, now - bootStarted);
      this.ctx.waitUntil(Promise.all([
        this.updateTelemetry(t => ({ ...t, bootCount: t.bootCount + 1, lastBootMs: bootMs, lastBootAt: now })),
        this.env.REGISTRY.getByName("main").resolveAlert("sandbox_error", "sandbox", "web"),
      ]).catch(() => {}));
    }
    return container;
  }
  async run(input: { operationId: string; operation: WorkspaceOperation }): Promise<WorkspaceRunResult> {
    const out = await this.workspace.run(input);
    if (input.operation.kind === "exec" && out.status === "committed" && "stdout" in out.result) {
      const timedOut = Boolean(out.result.timedOut);
      this.ctx.waitUntil(this.updateTelemetry(t => ({ ...t, execCount: t.execCount + 1, timeoutCount: t.timeoutCount + (timedOut ? 1 : 0) })).catch(() => {}));
    }
    return out;
  }
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
  async writeFile(path: string, content: string | Uint8Array, operationId?: string): Promise<{ bytes: number }> {
    const result = await this.result(typeof content === "string" ? { kind: "write", path, text: content } : { kind: "writeBytes", path, data: content }, operationId);
    if (!("bytes" in result)) throw new Error("sandbox_error");
    return result;
  }
  async createTempDir(prefix?: string): Promise<string> {
    return createOutputDirectory({ list: path => this.list(path),
      mkdir: async path => { await this.result({ kind: "mkdir", path }); },
      remove: async path => { await this.result({ kind: "remove", path }); },
    }, prefix);
  }
  async editFile(path: string, edits: FileEdit[], operationId?: string): Promise<{ replaced: number }> {
    const result = await this.result({ kind: "edit", path, edits }, operationId);
    if (!("replaced" in result)) throw new Error("sandbox_error");
    return result;
  }
  list(path: string): Promise<DirEntry[]> { return this.workspace.list(path); }
  files(revision?: string): Promise<WorkspaceManifest> { return this.workspace.files(revision); }
  readBlob(path: string, revision?: string): Promise<{ bytes: Uint8Array; mime: string; name: string }> { return this.workspace.readBlob(path, revision); }
  async exportAsset(path: string, scope: string, name?: string): Promise<AssetRef> {
    const file = await this.readBlob(path);
    return new MediaRepository({ bucket: this.env.ASSETS, scope }).put({ ...file, name: name ?? file.name, kind: imageMime(file.bytes) ? "image" : "file" });
  }
  importSnapshot(input: { manifest: WorkspaceManifest; expectedRevision: string; paths?: string[] }): Promise<WorkspaceCompareResult> { return this.workspace.importSnapshot(input); }
  /** Cloudflare 提供方负责选择快照和幂等初始化；管理服务只传来源与操作标识。 */
  async prepareResource(input: { operationId: string; sourceName?: string }): Promise<void> {
    const key = "resource-prepare:" + input.operationId;
    type Preparation = { sourceName?: string; sourceRevision?: string };
    let prepared = await this.ctx.storage.get<Preparation>(key);
    if (!prepared) {
      const candidate: Preparation = input.sourceName
        ? { sourceName: input.sourceName, sourceRevision: (await this.env.SANDBOX.getByName(input.sourceName).files()).revision } : {};
      prepared = await this.ctx.storage.transaction(async tx => {
        const prior = await tx.get<Preparation>(key); if (prior) return prior;
        await tx.put(key, candidate); return candidate;
      });
    }
    if (prepared.sourceName !== input.sourceName) throw new Error("operation_conflict");
    if (prepared.sourceName) {
      const result = await this.cloneFrom({ sourceName: prepared.sourceName, sourceRevision: prepared.sourceRevision, expectedRevision: "0", operationId: input.operationId });
      if (!result.ok) throw new Error("workspace_conflict");
    }
  }
  async cloneFrom(input: { sourceName: string; expectedRevision: string; sourceRevision?: string; operationId?: string }): Promise<WorkspaceCompareResult> {
    const manifest = await this.env.SANDBOX.getByName(input.sourceName).files(input.sourceRevision);
    return this.workspace.importSnapshot({ manifest, expectedRevision: input.expectedRevision, ...(input.operationId ? { operationId: input.operationId } : {}) });
  }
  async mergeFrom(input: { sourceName: string; expectedRevision: string; paths: string[]; sourceRevision?: string }): Promise<WorkspaceCompareResult> {
    const manifest = await this.env.SANDBOX.getByName(input.sourceName).files(input.sourceRevision);
    return this.importSnapshot({ manifest, expectedRevision: input.expectedRevision, paths: input.paths });
  }
  async status(): Promise<SandboxStatus> { const container = this.ctx.container; return !container ? "unavailable" : container.running ? "running" : "stopped"; }
  async telemetry(): Promise<{ status: SandboxStatus } & SandboxTelemetry> {
    const saved = (await this.ctx.storage.get<SandboxTelemetry>(TELEMETRY_KEY)) ?? EMPTY_TELEMETRY;
    return { status: await this.status(), ...EMPTY_TELEMETRY, ...saved };
  }
  private async destroyRuntime(): Promise<boolean> {
    const container = this.container();
    this.ready = false;
    ++this.runtimeGeneration;
    if (!container.running) return false;
    await container.destroy("restore committed workspace");
    return true;
  }
  async gc(options?: Parameters<WorkspaceManager["gc"]>[0]): ReturnType<WorkspaceManager["gc"]> {
    try { return await this.collectGc(() => this.workspace.gc(options)); }
    catch (error) {
      if (options?.dryRun === false) await this.ctx.storage.setAlarm(Date.now() + 300_000);
      throw error;
    }
  }
  private async collectGc<T extends GcReport | undefined>(work: () => Promise<T>): Promise<T> {
    const report = await work();
    if (report && !report.dryRun) {
      if (report.phase === "done") await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now() + 30_000);
      console.info({ event: "workspace_gc_progress", ...report });
    }
    return report;
  }
  resetRuntime(): Promise<{ reset: boolean }> { return this.workspace.resetRuntime(); }
}
