/** 一次性 stdio 客户端：只恢复并压缩指定线程，不提交用户回合或记录协议正文。 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CompactChild extends Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "kill" | "unref" | "pid"> {
  once(event: "error" | "close", listener: () => void): unknown;
}

interface CompactOptions {
  /** 注入启动器，便于用内存流测试；命令、环境和配置由 runner 提供。 */
  start: () => CompactChild;
  killTree?: (pid: number | undefined) => void;
  timeoutMs?: number;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function compactAppServer(threadId: string, opts: CompactOptions): Promise<void> {
  let child: CompactChild;
  try { child = opts.start(); }
  catch { throw new Error("codex app-server 启动失败"); }
  const lines = createInterface({ input: child.stdout });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let fail: (error: Error) => void = () => undefined;
  const ioError = () => fail(new Error("codex app-server 进程或管道错误"));
  const closed = () => fail(new Error("codex app-server 在压缩完成前退出"));
  child.once("error", ioError);
  child.once("close", closed);
  child.stdin.on("error", ioError);
  child.stdout.on("error", ioError);
  child.stderr.on("error", ioError);
  // 必须排空 stderr，避免管道反压；不把内容或服务端错误正文写入日志。
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      let id = 0;
      let method = "";
      let compactRequested = false;
      let acknowledged = false;
      let completed = false;
      let turnId: string | undefined;
      fail = error => { if (!settled) { settled = true; reject(error); } };
      const finish = () => {
        if (!settled && acknowledged && completed) { settled = true; resolve(); }
      };
      const send = (message: Record<string, unknown>) => {
        if (settled) return;
        try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
        catch { ioError(); }
      };
      const request = (next: string, params: Record<string, unknown>) => {
        method = next;
        send({ id: ++id, method, params });
      };
      lines.on("line", line => {
        if (settled || !line.trim()) return;
        let message: Record<string, unknown>;
        try { message = object(JSON.parse(line)); }
        catch { fail(new Error("codex app-server 返回了无效 JSON")); return; }
        if (typeof message.method === "string") {
          // 服务端请求必须答复，否则审批或新协议请求可能永久挂起。
          if (message.id !== undefined) {
            send({ id: message.id, error: { code: -32601, message: "Method not supported by compaction client" } });
            return;
          }
          const params = object(message.params);
          if (!compactRequested || params.threadId !== threadId) return;
          const turn = object(params.turn);
          if (message.method === "turn/started" && typeof turn.id === "string") turnId = turn.id;
          const eventTurn = message.method === "turn/completed" ? turn.id : params.turnId;
          if (turnId && eventTurn !== undefined && eventTurn !== turnId) return;
          if (message.method === "error" && params.willRetry !== true) {
            fail(new Error("codex app-server 压缩失败（服务端 error 通知）"));
          } else if (message.method === "turn/completed") {
            if (turn.status !== "completed" || turn.error != null) {
              fail(new Error("codex app-server 压缩回合失败或被中断"));
              return;
            }
            completed = true;
          } else if (message.method === "thread/compacted" ||
              (message.method === "item/completed" && object(params.item).type === "contextCompaction")) {
            completed = true;
          }
          finish();
          return;
        }
        if (message.id !== id) return;
        if (message.error !== undefined) {
          const code = object(message.error).code;
          fail(new Error(`codex app-server ${method} 失败${typeof code === "number" ? `（JSON-RPC ${code}）` : ""}`));
          return;
        }
        if (!Object.hasOwn(message, "result")) {
          fail(new Error(`codex app-server ${method} 响应缺少 result`));
          return;
        }
        if (method === "initialize") {
          send({ method: "initialized" });
          request("thread/resume", { threadId });
        } else if (method === "thread/resume") {
          compactRequested = true;
          request("thread/compact/start", { threadId });
        } else if (method === "thread/compact/start") {
          acknowledged = true;
          finish();
        }
      });
      lines.once("close", closed);
      timer = setTimeout(() => fail(new Error("codex app-server 压缩超时（最长 5 分钟）")), opts.timeoutMs ?? 300_000);
      request("initialize", { clientInfo: { name: "cs_agent_compact", version: "0.1.0" } });
    });
  } finally {
    settled = true;
    clearTimeout(timer);
    lines.close();
    try { opts.killTree?.(child.pid); }
    finally {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
  }
}
