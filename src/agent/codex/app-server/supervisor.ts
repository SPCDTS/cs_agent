/**
 * 常驻 `codex app-server` 子进程的监管器（设计稿 §5.1、§5.4）。
 * 一个进程承载所有线程；每次（重新）启动称为一代（generation），完成 initialize 握手后才算就绪。
 * 进程退出、管道错误或握手失败都视为"掉线"：拒绝该代所有未完成请求、清理进程树，按 1s→2s→…→60s 退避重启；
 * 稳定运行超过 stableMs 后退避归零。重启就绪后发出 "restarted"，由调用方对已知线程 thread/resume。
 * 不写 stderr 内容与协议正文到日志（可能含用户内容或密钥）。
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { log } from "../../../shared/log.js";
import { killTree as defaultKillTree } from "../runner.js";
import { RpcConnection, type RequestOptions, type ServerRequestHandler } from "./rpc.js";

/** 监管器需要的子进程最小接口；测试注入内存实现。 */
export interface AppServerChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnAppServer = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => AppServerChild;

export interface AppServerSupervisorOptions {
  /** 可执行文件及前置参数，例如 ["codex"]；实际参数为 [...prefix, "app-server", ...args]。 */
  command: string[];
  /** app-server 之后的参数，例如 ["-c", "features.multi_agent=true"]。 */
  args?: string[];
  cwd: string;
  /** 完整子进程环境（含 CODEX_HOME），由调用方用 buildCodexEnv 等构造；监管器不做增删。 */
  env: NodeJS.ProcessEnv;
  spawn?: SpawnAppServer;
  killTree?: (pid: number | undefined) => void;
  onServerRequest?: ServerRequestHandler;
  clientInfo?: { name: string; version: string };
  /** initialize 的 capabilities，例如 { experimentalApi: true }。 */
  capabilities?: Record<string, unknown>;
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** 等待进程就绪的缺省上限（设计稿 §8.1："后端不可用超过 2 分钟"）。 */
  readyTimeoutMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** 一代运行超过该时长后再掉线，退避从头开始。 */
  stableMs?: number;
}

export type SupervisorState = "idle" | "starting" | "ready" | "backoff" | "stopped";

export interface DownEvent {
  generation: number;
  /** 不含协议正文的简短原因，例如"进程退出（code 1）"。 */
  reason: string;
  /** 掉线前是否已完成握手；为 false 表示启动/握手阶段就失败了。 */
  wasReady: boolean;
}

export interface SupervisorEvents {
  ready: [generation: number];
  /** 掉线后重新就绪；调用方应对需要的线程重新 thread/resume。 */
  restarted: [generation: number];
  down: [event: DownEvent];
  notification: [method: string, params: unknown, generation: number];
}

export class AppServerUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "AppServerUnavailableError"; }
}

export interface SupervisedRequestOptions extends RequestOptions {
  /** 等待进程就绪的上限；缺省取 readyTimeoutMs。 */
  readyTimeoutMs?: number;
}

const defaultSpawn: SpawnAppServer = (bin, args, opts) => spawn(bin, args, {
  cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"],
  detached: process.platform !== "win32", windowsHide: true,
});

interface Generation {
  id: number;
  child?: AppServerChild;
  conn?: RpcConnection;
  ready: boolean;
  down: boolean;
  readyAt?: number;
  exited: Promise<void>;
}

interface Waiter { resolve: () => void; reject: (error: Error) => void }

export class AppServerSupervisor extends EventEmitter<SupervisorEvents> {
  private current: Generation | undefined;
  private generationSeq = 0;
  private attempts = 0;
  private hadDown = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private waiters = new Set<Waiter>();
  private stateValue: SupervisorState = "idle";

  constructor(private readonly opts: AppServerSupervisorOptions) { super(); }

  get state(): SupervisorState { return this.stateValue; }
  /** 当前代号；从 1 开始，每次启动尝试加一。 */
  get generation(): number { return this.generationSeq; }
  get pid(): number | undefined { return this.current?.child?.pid; }

  /** 启动（幂等）；失败时自动退避重试，不抛错。用 ready() 等待就绪。 */
  start(): void {
    if (this.stateValue !== "idle") return;
    this.launch();
  }

  /** 等待当前代就绪。stop 后、超时或 signal 取消时拒绝。 */
  ready(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    if (this.stateValue === "ready") return Promise.resolve();
    if (this.stateValue === "stopped") return Promise.reject(new AppServerUnavailableError("codex app-server 已停止"));
    if (this.stateValue === "idle") this.start();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); this.waiters.delete(waiter); };
      const waiter: Waiter = {
        resolve: () => { done(); resolve(); },
        reject: error => { done(); reject(error); },
      };
      const onAbort = () => waiter.reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("已取消"));
      if (opts.signal?.aborted) { onAbort(); return; }
      this.waiters.add(waiter);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = opts.timeoutMs ?? this.opts.readyTimeoutMs ?? 120_000;
      if (timeoutMs > 0) {
        timer = setTimeout(() => waiter.reject(new AppServerUnavailableError(`codex app-server ${timeoutMs} ms 内未就绪`)), timeoutMs);
      }
    });
  }

  /** 等待就绪后发请求；返回结果与处理该请求的代号（调用方据此判断线程是否属于当前进程）。 */
  async call<T = unknown>(method: string, params: unknown, opts: SupervisedRequestOptions = {}): Promise<{ result: T; generation: number }> {
    await this.ready({ ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.readyTimeoutMs !== undefined ? { timeoutMs: opts.readyTimeoutMs } : {}) });
    const gen = this.current;
    if (!gen?.conn || !gen.ready) throw new AppServerUnavailableError("codex app-server 未就绪");
    const result = await gen.conn.request<T>(method, params, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      timeoutMs: opts.timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000,
    });
    return { result, generation: gen.id };
  }

  async request<T = unknown>(method: string, params: unknown, opts: SupervisedRequestOptions = {}): Promise<T> {
    return (await this.call<T>(method, params, opts)).result;
  }

  /** 停止监管并结束进程树；等待进程退出最多 waitMs。 */
  async stop(waitMs = 5_000): Promise<void> {
    if (this.stateValue === "stopped") return;
    this.stateValue = "stopped";
    clearTimeout(this.restartTimer);
    for (const waiter of [...this.waiters]) waiter.reject(new AppServerUnavailableError("codex app-server 已停止"));
    const gen = this.current;
    if (!gen) return;
    this.markDown(gen, "已停止");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([gen.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
  }

  private launch(): void {
    const id = ++this.generationSeq;
    let resolveExit!: () => void;
    const gen: Generation = { id, ready: false, down: false, exited: new Promise<void>(resolve => { resolveExit = resolve; }) };
    this.current = gen;
    this.stateValue = "starting";
    const [bin, ...prefix] = this.opts.command;
    if (!bin) { this.markDown(gen, "CODEX_BIN 未配置"); resolveExit(); return; }
    const spawnChild = this.opts.spawn ?? defaultSpawn;
    let child: AppServerChild;
    try {
      child = spawnChild(bin, [...prefix, "app-server", ...(this.opts.args ?? [])], { cwd: this.opts.cwd, env: this.opts.env });
    } catch {
      resolveExit();
      this.markDown(gen, "启动失败");
      return;
    }
    gen.child = child;
    log.info("codex app-server spawned", { generation: id, pid: child.pid ?? null });
    child.once("exit", (code, signal) => {
      resolveExit();
      this.markDown(gen, `进程退出（${code === null ? `signal ${signal ?? "?"}` : `code ${code}`}）`);
    });
    child.once("error", () => { this.markDown(gen, "进程错误"); });
    const pipeError = () => this.markDown(gen, "管道错误");
    child.stdin.on("error", pipeError);
    child.stdout.on("error", pipeError);
    child.stderr.on("error", pipeError);
    // 必须排空 stderr，避免管道反压；内容不进日志。
    child.stderr.resume();
    const conn = new RpcConnection(child.stdin, child.stdout, {
      ...(this.opts.onServerRequest ? { onServerRequest: this.opts.onServerRequest } : {}),
      defaultTimeoutMs: this.opts.requestTimeoutMs ?? 60_000,
      label: `gen=${id}`,
    });
    gen.conn = conn;
    conn.on("notification", (method, params) => { if (!gen.down) this.emit("notification", method, params, id); });
    conn.once("close", reason => this.markDown(gen, reason));
    void this.handshake(gen, conn);
  }

  private async handshake(gen: Generation, conn: RpcConnection): Promise<void> {
    try {
      await conn.request("initialize", {
        clientInfo: this.opts.clientInfo ?? { name: "cs_agent", version: "0.1.0" },
        ...(this.opts.capabilities ? { capabilities: this.opts.capabilities } : {}),
      }, { timeoutMs: this.opts.initTimeoutMs ?? 30_000 });
    } catch {
      this.markDown(gen, "initialize 失败");
      return;
    }
    if (gen.down || this.current !== gen) return;
    conn.notify("initialized");
    gen.ready = true;
    gen.readyAt = Date.now();
    this.stateValue = "ready";
    log.info("codex app-server ready", { generation: gen.id, restarted: this.hadDown });
    for (const waiter of [...this.waiters]) waiter.resolve();
    this.emit("ready", gen.id);
    if (this.hadDown) this.emit("restarted", gen.id);
  }

  /** 某一代掉线：只处理一次；清理进程树并安排重启（stop 后不再重启）。 */
  private markDown(gen: Generation, reason: string): void {
    if (gen.down) return;
    gen.down = true;
    const wasReady = gen.ready;
    gen.ready = false;
    gen.conn?.close(reason);
    const child = gen.child;
    if (child) {
      try { (this.opts.killTree ?? defaultKillTree)(child.pid); } catch { /* 已退出 */ }
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    if (this.current !== gen) return;
    this.hadDown = true;
    const stopping = this.stateValue === "stopped";
    log.warn("codex app-server down", { generation: gen.id, reason, was_ready: wasReady, stopping });
    this.emit("down", { generation: gen.id, reason, wasReady });
    if (stopping) return;
    // 稳定运行足够久后掉线，退避从头开始；握手前就失败的连续计数。
    if (gen.readyAt !== undefined && Date.now() - gen.readyAt >= (this.opts.stableMs ?? 60_000)) this.attempts = 0;
    const initial = this.opts.backoffInitialMs ?? 1_000;
    const max = this.opts.backoffMaxMs ?? 60_000;
    const delay = Math.min(initial * 2 ** this.attempts, max);
    this.attempts++;
    this.stateValue = "backoff";
    log.info("codex app-server restart scheduled", { generation: gen.id, delay_ms: delay });
    this.restartTimer = setTimeout(() => { if (this.stateValue === "backoff") this.launch(); }, delay);
  }
}
