/** 内存版 codex app-server：脚本化 stdio，供监管器与客户端测试。 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { vi } from "vitest";
import type { AppServerChild, SpawnAppServer } from "../../../src/agent/codex/app-server/supervisor.js";

export type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } };
/** 返回 undefined 表示不自动答复（由测试手动 respond）。 */
export type Handler = (message: Message, child: FakeAppServer) => { result?: unknown; error?: Message["error"] } | undefined;

export class FakeAppServer extends EventEmitter implements AppServerChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** 客户端发来的全部消息（请求、通知、对服务端请求的答复）。 */
  readonly received: Message[] = [];
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => { this.exit(null, "SIGKILL"); return true; });
  private exited = false;
  readonly stdin = new Writable({ write: (data, _encoding, done) => {
    for (const line of String(data).split("\n").filter(Boolean)) {
      const message = JSON.parse(line) as Message;
      this.received.push(message);
      queueMicrotask(() => this.dispatch(message));
    }
    done();
  } });
  private serverRequestSeq = 0;
  private readonly replies = new Map<string | number, (reply: Message) => void>();

  constructor(readonly pid: number, readonly handlers: Record<string, Handler>) { super(); }

  send(message: Message): void { this.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
  notify(method: string, params: Record<string, unknown>): void { this.send({ method, params }); }
  respond(id: string | number | undefined, reply: { result?: unknown; error?: Message["error"] }): void {
    this.send({ id: id!, ...(reply.error ? { error: reply.error } : { result: reply.result ?? {} }) });
  }
  /** 发一个服务端请求，等待客户端答复。 */
  request(method: string, params: Record<string, unknown> = {}): Promise<Message> {
    const id = `srv-${++this.serverRequestSeq}`;
    return new Promise(resolve => { this.replies.set(id, resolve); this.send({ id, method, params }); });
  }
  requests(method: string): Message[] { return this.received.filter(m => m.method === method && m.id !== undefined); }
  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.emit("exit", code, signal);
  }

  private dispatch(message: Message): void {
    if (message.method === undefined && message.id !== undefined) {
      this.replies.get(message.id)?.(message);
      this.replies.delete(message.id);
      return;
    }
    if (message.method === undefined || message.id === undefined) return;
    const handler = this.handlers[message.method];
    const reply = handler ? handler(message, this) : { result: {} };
    if (reply) this.respond(message.id, reply);
  }
}

export function defaultHandlers(extra: Record<string, Handler> = {}): Record<string, Handler> {
  let threads = 0;
  let turns = 0;
  return {
    initialize: () => ({ result: { userAgent: "fake" } }),
    "thread/start": () => ({ result: { thread: { id: `thr-${++threads}` } } }),
    "thread/resume": m => ({ result: { thread: { id: m.params!.threadId } } }),
    "turn/start": () => ({ result: { turn: { id: `turn-${++turns}`, status: "inProgress", items: [] } } }),
    "turn/steer": m => ({ result: { turnId: m.params!.expectedTurnId } }),
    "turn/interrupt": () => ({ result: {} }),
    ...extra,
  };
}

/** 每次启动生成一个新的 FakeAppServer；children 记录各代。 */
export function fakeSpawn(handlers: () => Record<string, Handler> = () => defaultHandlers()) {
  const children: FakeAppServer[] = [];
  const calls: { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnAppServer = (bin, args, opts) => {
    calls.push({ bin, args, ...opts });
    const child = new FakeAppServer(1000 + children.length, handlers());
    children.push(child);
    return child;
  };
  return { spawn, children, calls, get last() { return children.at(-1)!; } };
}

/** 让流、微任务与 setImmediate 排空。 */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
