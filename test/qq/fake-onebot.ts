/** 进程内假 OneBot v11 服务器：node:http（API）+ ws（事件）。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export const TOKEN = "test-token";
export const SELF_ID = "10001";

/** 监听 127.0.0.1 的随机端口（fetch 禁用端口由 test/setup-fetchable-ports.ts 统一跳过）。 */
async function listenLocal(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}

export interface ApiCall {
  action: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

/** 返回 undefined 表示走默认处理；否则自定义响应。 */
export type ApiOverride = (call: ApiCall) =>
  | { http?: number; body?: unknown; delayMs?: number }
  | undefined;

export class FakeOneBot {
  readonly calls: ApiCall[] = [];
  readonly sockets = new Set<WebSocket>();
  wsAuthFailures = 0;
  connections = 0;
  loginUserId = SELF_ID;
  override: ApiOverride | null = null;
  private nextMessageId = 5000;
  private http!: Server;
  private wss!: WebSocketServer;
  httpUrl = "";
  wsUrl = "";

  async start(): Promise<void> {
    this.http = await listenLocal((req, res) => void this.handleHttp(req, res));
    this.httpUrl = "http://127.0.0.1:" + (this.http.address() as AddressInfo).port;

    this.wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (info: { req: IncomingMessage }) => {
        const ok = info.req.headers.authorization === "Bearer " + TOKEN;
        if (!ok) this.wsAuthFailures++;
        return ok;
      },
    });
    await new Promise<void>(resolve => this.wss.once("listening", () => resolve()));
    this.wsUrl = "ws://127.0.0.1:" + (this.wss.address() as AddressInfo).port;
    this.wss.on("connection", socket => {
      this.connections++;
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
    this.http.closeAllConnections();
    await new Promise<void>(resolve => this.http.close(() => resolve()));
  }

  /** 向所有已连接客户端推送一个事件（对象或原始字符串）。 */
  push(event: unknown): void {
    const frame = typeof event === "string" ? event : JSON.stringify(event);
    for (const s of this.sockets) s.send(frame);
  }

  /** 服务端主动断开所有连接。 */
  dropAll(): void {
    for (const s of this.sockets) s.close(1001, "server going away");
  }

  sendCalls(): ApiCall[] {
    return this.calls.filter(c => c.action.startsWith("send_"));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const action = (req.url ?? "/").slice(1);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; } catch { /* ignore */ }
    const call: ApiCall = { action, body, authorization: req.headers.authorization };
    this.calls.push(call);

    if (call.authorization !== "Bearer " + TOKEN) return this.respond(res, 401, { status: "failed", retcode: 1403 });
    const custom = this.override?.(call);
    if (custom) {
      if (custom.delayMs) await new Promise(r => setTimeout(r, custom.delayMs));
      return this.respond(res, custom.http ?? 200, custom.body ?? { status: "ok", retcode: 0, data: null });
    }
    if (action === "get_login_info") {
      return this.respond(res, 200, { status: "ok", retcode: 0, data: { user_id: Number(this.loginUserId), nickname: "bot" } });
    }
    if (action === "send_group_msg" || action === "send_private_msg") {
      return this.respond(res, 200, { status: "ok", retcode: 0, data: { message_id: this.nextMessageId++ } });
    }
    return this.respond(res, 200, { status: "failed", retcode: 1404, data: null });
  }

  private respond(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for " + label);
    await new Promise(r => setTimeout(r, 10));
  }
}

let nextId = 1;

/** 构造 OneBot 私聊消息事件。 */
export function privateEvent(userId: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: "message", message_type: "private", sub_type: "friend", time: 1700000000,
    self_id: Number(SELF_ID), user_id: Number(userId), message_id: nextId++,
    message: [{ type: "text", data: { text } }], raw_message: text,
    sender: { user_id: Number(userId), nickname: "nick-" + userId }, ...extra,
  };
}

/** 构造群消息事件；mention=true 时带真实 at 段。 */
export function groupEvent(groupId: string, userId: string, text: string, mention: boolean,
  extra: Record<string, unknown> = {}): Record<string, unknown> {
  const message: unknown[] = mention ? [{ type: "at", data: { qq: SELF_ID } }, { type: "text", data: { text: " " + text } }]
    : [{ type: "text", data: { text } }];
  return {
    post_type: "message", message_type: "group", sub_type: "normal", time: 1700000000,
    self_id: Number(SELF_ID), user_id: Number(userId), group_id: Number(groupId), message_id: nextId++,
    message, raw_message: text,
    sender: { user_id: Number(userId), nickname: "nick-" + userId, card: "card-" + userId }, ...extra,
  };
}
