/**
 * codex app-server 的 JSON-RPC 2.0 stdio 连接：一行一条消息。
 * 负责请求/响应配对、通知分发、服务端请求答复（策略可注入），不关心进程生命周期（见 supervisor.ts）。
 * 日志只记方法名、id 与错误码；消息正文可能含用户内容或密钥，一律不写日志。
 */
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { log } from "../../../shared/log.js";

export type RpcId = string | number;

/** 服务端请求的答复：result 或 JSON-RPC error。 */
export type RpcReply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };
export type ServerRequestHandler = (method: string, params: unknown) => RpcReply | Promise<RpcReply>;

/** 服务端返回的 JSON-RPC 错误；message 只用于判定，不要原样写日志。 */
export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, readonly serverMessage: string, readonly data?: unknown) {
    super(`codex app-server ${method} 失败（JSON-RPC ${code}）`);
    this.name = "RpcError";
  }
}
export class RpcTimeoutError extends Error {
  constructor(readonly method: string, timeoutMs: number) {
    super(`codex app-server ${method} 超时（${timeoutMs} ms）`);
    this.name = "RpcTimeoutError";
  }
}
/** 连接已关闭（进程退出、管道错误或主动关闭）：未完成的请求一律以此失败。 */
export class RpcClosedError extends Error {
  constructor(readonly method: string, reason: string) {
    super(`codex app-server ${method} 未完成：${reason}`);
    this.name = "RpcClosedError";
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** 缺省取连接的 defaultTimeoutMs；0 表示不设时限。 */
  timeoutMs?: number;
}

export interface RpcConnectionOptions {
  /** 服务端请求（审批、用户输入等）的答复策略；缺省 declineServerRequests。 */
  onServerRequest?: ServerRequestHandler;
  defaultTimeoutMs?: number;
  /** 日志标签，例如 "gen=3"，便于区分重启前后的连接。 */
  label?: string;
}

export interface RpcConnectionEvents {
  notification: [method: string, params: unknown];
  /** 连接关闭（只触发一次）；reason 不含协议正文。 */
  close: [reason: string];
}

const JSONRPC_METHOD_NOT_FOUND = -32601;

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * 缺省策略：常驻 agent 使用 approvalPolicy=never，理论上不会收到审批；万一收到一律拒绝（不中断回合），
 * 其余未知请求答 -32601，保证服务端不会永久挂起。
 */
export const declineServerRequests: ServerRequestHandler = method => {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { result: { decision: "denied" } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline" } };
    default:
      return { error: { code: JSONRPC_METHOD_NOT_FOUND, message: "Method not supported by cs_agent client" } };
  }
};

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class RpcConnection extends EventEmitter<RpcConnectionEvents> {
  private readonly lines: Interface;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly onServerRequest: ServerRequestHandler;
  private readonly defaultTimeoutMs: number;
  private readonly label: string;
  private nextId = 0;
  private closedReason: string | undefined;

  constructor(private readonly stdin: Writable, stdout: Readable, opts: RpcConnectionOptions = {}) {
    super();
    this.onServerRequest = opts.onServerRequest ?? declineServerRequests;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.label = opts.label ?? "";
    // readline 负责跨 chunk 拼行；超长行也完整交付。
    this.lines = createInterface({ input: stdout, crlfDelay: Infinity });
    this.lines.on("line", line => this.handleLine(line));
    this.lines.once("close", () => this.close("stdout 已关闭"));
  }

  get closed(): boolean { return this.closedReason !== undefined; }

  request<T = unknown>(method: string, params?: unknown, opts: RequestOptions = {}): Promise<T> {
    if (this.closedReason !== undefined) return Promise.reject(new RpcClosedError(method, this.closedReason));
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("已取消"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        this.settle(id)?.reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("已取消"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, cleanup });
      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          log.warn("codex app-server request timed out", { conn: this.label, method, id, timeout_ms: timeoutMs });
          this.settle(id)?.reject(new RpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason !== undefined) return;
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** 关闭连接：拒绝所有未完成请求，之后的请求立即失败。不负责结束进程。 */
  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.lines.close();
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new RpcClosedError(this.pendingMethod(id), reason));
    this.emit("close", reason);
  }

  private pendingMethod(id: RpcId): string { return this.pending.get(id)?.method ?? "request"; }

  /** 取出并清理一个未完成请求；已完成（超时、取消后迟到的响应）返回 undefined。 */
  private settle(id: RpcId): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    entry.cleanup();
    return entry;
  }

  private write(message: Record<string, unknown>): void {
    if (this.closedReason !== undefined) return;
    try {
      this.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    } catch {
      this.close("stdin 写入失败");
    }
  }

  private handleLine(line: string): void {
    if (this.closedReason !== undefined || !line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = object(JSON.parse(line));
    } catch {
      // 单行损坏不拆连接；只记长度，不记内容。
      log.warn("codex app-server sent invalid JSON line", { conn: this.label, length: line.length });
      return;
    }
    const id = message.id as RpcId | undefined;
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof message.method === "string") {
      if (hasId) void this.answer(id, message.method, message.params);
      else this.emit("notification", message.method, message.params);
      return;
    }
    if (!hasId) return;
    const entry = this.settle(id);
    if (!entry) return; // 超时或已取消的迟到响应
    if (message.error !== undefined) {
      const error = object(message.error);
      const code = typeof error.code === "number" ? error.code : 0;
      log.info("codex app-server request failed", { conn: this.label, method: entry.method, id, code });
      entry.reject(new RpcError(entry.method, code, typeof error.message === "string" ? error.message : "", error.data));
    } else if (!Object.hasOwn(message, "result")) {
      entry.reject(new RpcError(entry.method, 0, "响应缺少 result"));
    } else {
      entry.resolve(message.result);
    }
  }

  /** 服务端请求必须答复，否则审批或新协议请求可能让回合永久挂起；策略抛错时答 -32603。 */
  private async answer(id: RpcId, method: string, params: unknown): Promise<void> {
    let reply: RpcReply;
    try {
      reply = await this.onServerRequest(method, params);
    } catch {
      reply = { error: { code: -32603, message: "cs_agent client failed to handle request" } };
    }
    log.info("codex app-server server request answered", {
      conn: this.label, method, id, outcome: "error" in reply ? `error ${reply.error.code}` : "result",
    });
    this.write({ id, ...reply });
  }
}
