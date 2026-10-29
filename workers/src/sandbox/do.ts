import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { sandboxClient, type DirEntry, type ExecResult, type FileEdit, type ReadResult } from "./client";

export type SandboxStatus = "running" | "stopped" | "unavailable";

/**
 * 每个会话一个沙箱容器（docs/WORKERS-DESIGN.md §3.5），名字是线程键。本账户只允许 durable_object 调度策略，
 * 所以和当年的 magpie 一样由普通 DO 用 ctx.container.start() 按需拉起，镜像是 wrangler.jsonc 的 images.sandbox。
 * 测试配置没有 containers，ctx.container 为 undefined，所有调用抛 sandbox_unavailable。
 */
export class SandboxDO extends DurableObject<Env> {
  static readonly PORT = 3000;
  static readonly IDLE_MS = 10 * 60 * 1000;
  /** 冷启动等待：容器起来加 node 启动，一般几秒，上限 30 秒 */
  static readonly START_ATTEMPTS = 60;
  static readonly START_INTERVAL_MS = 500;

  // 只在确认控制服务就绪之前重试；就绪后的请求只发一次，exec 被重放会把命令跑两遍。
  private ready = false;
  private readonly client = sandboxClient((path, init) => this.send(path, init));

  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("sandbox_unavailable");
    return container;
  }

  private async send(path: string, init?: RequestInit): Promise<Response> {
    const container = this.container();
    if (!container.running) {
      this.ready = false;
      container.start({ image: container.images.sandbox, enableInternet: true, instance: "lite" });
      this.ctx.waitUntil(container.monitor().catch(error => {
        console.error({ event: "sandbox_container_exit", message: error instanceof Error ? error.message : String(error) });
      }).finally(() => { this.ready = false; }));
    }
    await container.setInactivityTimeout(SandboxDO.IDLE_MS);
    const port = container.getTcpPort(SandboxDO.PORT);
    for (let attempt = 0; !this.ready; attempt++) {
      if (attempt >= SandboxDO.START_ATTEMPTS) throw new Error("sandbox_unavailable");
      try { this.ready = (await port.fetch("http://sandbox/health")).ok; } catch { /* 端口还没监听 */ }
      if (!this.ready) await scheduler.wait(SandboxDO.START_INTERVAL_MS);
    }
    try { return await port.fetch(`http://sandbox${path}`, init); }
    catch {
      this.ready = false;
      throw new Error("sandbox_unavailable");
    }
  }

  exec(cmd: string, options: { cwd?: string; timeoutMs: number }): Promise<ExecResult> { return this.client.exec(cmd, options); }
  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<ReadResult> { return this.client.readFile(path, options); }
  writeFile(path: string, text: string): Promise<{ bytes: number }> { return this.client.writeFile(path, text); }
  editFile(path: string, edits: FileEdit[]): Promise<{ replaced: number }> { return this.client.editFile(path, edits); }
  list(path: string): Promise<DirEntry[]> { return this.client.list(path); }

  async status(): Promise<SandboxStatus> {
    const container = this.ctx.container;
    return !container ? "unavailable" : container.running ? "running" : "stopped";
  }

  /** 销毁容器，/work 随之清空；下一次调用重新拉起。 */
  async reset(): Promise<{ reset: boolean }> {
    const container = this.container();
    this.ready = false;
    if (!container.running) return { reset: false };
    await container.destroy("reset requested");
    return { reset: true };
  }
}
