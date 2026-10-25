import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpConnectionError } from "./transport-http.js";
import { WINDOWS_JOB_SCRIPT } from "./transport-windows-job.js";

type Options = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  messageBytes: number;
  closeMs: number;
};

/** 自有 stdio 边界，避免 SDK 默认环境合并与无界 ReadBuffer。 */
export class BoundedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private closePromise?: Promise<void>;
  private frame = Buffer.alloc(0);
  private frameBytes = 0;
  private temporary?: { directory: string; file: string };

  constructor(private readonly options: Options) {}

  async start(): Promise<void> {
    if (this.closed || this.child) throw new McpConnectionError("closed", "MCP stdio 连接无法再次启动");
    let command = this.options.command;
    let args = this.options.args;
    if (process.platform === "win32") {
      // suspended 创建目标后归入专属 Job；父进程提前退出时也清除孙进程。
      const directory = await mkdtemp(join(tmpdir(), "cs-agent-mcp-job-"));
      const file = join(directory, "job.ps1");
      this.temporary = { directory, file };
      await writeFile(file, WINDOWS_JOB_SCRIPT, { encoding: "utf8", flag: "wx" });
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      command = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const spec = Buffer.from(JSON.stringify({ command: this.options.command, args, cwd: this.options.cwd, envNames: Object.keys(this.options.env) })).toString("base64");
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, spec];
    }
    if (this.closed) { await this.cleanupTemporary(); return; }
    const child = spawn(command, args, {
      cwd: this.options.cwd, env: this.options.env, shell: false,
      detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    // stderr 只排空，不保存不可信诊断，更不会无限累积字符串。
    child.stderr.resume();
    child.stdin.on("error", () => { if (!this.closed) this.fail("transport_error", "MCP stdio 输入通道失败"); });
    child.on("exit", () => {
      if (!this.closed) this.onerror?.(new McpConnectionError("transport_error", "MCP stdio 进程已退出"));
      void this.close();
    });
    child.on("error", () => { this.fail("transport_error", "MCP stdio 进程启动失败"); });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new McpConnectionError("transport_error", "MCP stdio 进程启动失败")));
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (this.closed || !child) throw new McpConnectionError("closed", "MCP stdio 连接已关闭");
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > this.options.messageBytes) throw new McpConnectionError("message_limit", "MCP 发出消息超出限额");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(text + "\n", error => error ? reject(new McpConnectionError("transport_error", "MCP stdio 写入失败")) : resolve());
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.frame = Buffer.alloc(0);
    this.frameBytes = 0;
    this.onclose?.();
    this.closePromise = (async () => {
      const child = this.child;
      if (child) {
        child.stdout.pause();
        child.stdin.end();
        await waitExit(child, Math.min(250, this.options.closeMs / 3));
        if (process.platform === "win32") {
          // 杀死持有 Job handle 的专属 helper，内核负责整棵树的退出。
          if (child.exitCode === null && child.signalCode === null) child.kill();
        } else if (child.pid) {
          // 即使直接子进程已经退出，组内的后代仍要回收。
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) this.onerror?.(new McpConnectionError("transport_error", "MCP 进程组清理失败"));
          }
        }
        await waitExit(child, Math.max(1, this.options.closeMs * 2 / 3));
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      await this.cleanupTemporary();
    })();
    return this.closePromise;
  }

  private read(chunk: Buffer): void {
    if (this.closed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      const previousBytes = this.frameBytes;
      this.frameBytes += part.length;
      if (this.frameBytes > this.options.messageBytes) { this.fail("message_limit", "MCP 原始消息超出限额"); return; }
      if (this.frame.length < this.frameBytes) {
        const larger = Buffer.allocUnsafe(Math.min(this.options.messageBytes, Math.max(this.frameBytes, this.frame.length * 2, 1024)));
        this.frame.copy(larger, 0, 0, previousBytes);
        this.frame = larger;
      }
      part.copy(this.frame, previousBytes);
      if (newline < 0) return;
      const text = this.frame.toString("utf8", 0, this.frameBytes);
      this.frameBytes = 0;
      try {
        const value: unknown = JSON.parse(text);
        this.onmessage?.(JSONRPCMessageSchema.parse(value));
      } catch { this.fail("protocol_error", "MCP stdio 消息格式无效"); return; }
      if (this.closed) return;
      start = newline + 1;
    }
  }

  private fail(code: "message_limit" | "transport_error" | "protocol_error", message: string): void {
    this.onerror?.(new McpConnectionError(code, message));
    void this.close();
  }

  private async cleanupTemporary(): Promise<void> {
    const temporary = this.temporary;
    this.temporary = undefined;
    if (!temporary) return;
    await unlink(temporary.file).catch(() => {});
    await rmdir(temporary.directory).catch(() => {});
  }
}

async function waitExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
    const timer = setTimeout(done, ms);
    child.once("exit", done);
  });
}
