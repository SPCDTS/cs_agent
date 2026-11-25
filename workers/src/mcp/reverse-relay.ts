// 每个凭据版本独占一个 DO；一个设备连接承载多个隔离的 SDK 会话。
const MESSAGE_BYTES = 12 * 1024 * 1024;
export const REVERSE_BYTES = MESSAGE_BYTES + 4096;
const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const messageHeader = /^\{"session":"([a-f0-9-]{36})","message":/;
type Peer = { generation: string; session: string; active: boolean };
export class ReverseRelay {
  constructor(private ctx: DurableObjectState) {}
  // 外层仅转发固定的内部地址；公开 /onebot 请求不会进入这里。
  static isInternalRequest(req: Request) { return req.url === "https://relay/register" || req.url === "https://relay/session"; }
  // 连接附件随休眠保留；不依赖唤醒时是否能从对象 ID 恢复命名。
  owns(socket: WebSocket) { return typeof (socket.deserializeAttachment() as Peer | null)?.generation === "string"; }
  private live(tag: string, generation?: string) {
    return this.ctx.getWebSockets(tag).find(s => {
      const peer = s.deserializeAttachment() as Peer;
      return s.readyState === WebSocket.OPEN && peer.active && (generation === undefined || peer.generation === generation);
    });
  }
  online() { return Boolean(this.live("device")); }
  upgrade(req: Request) {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const device = new URL(req.url).pathname === "/register";
    let generation: string;
    if (device) {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      generation = crypto.randomUUID();
      for (const previous of this.ctx.getWebSockets("device")) this.disconnect(previous);
    } else {
      const current = this.live("device");
      if (!current) return new Response("offline", { status: 503 });
      if (this.ctx.getWebSockets("sessions").length >= 16) return new Response("busy", { status: 429 });
      generation = (current.deserializeAttachment() as Peer).generation;
    }
    const pair = new WebSocketPair(), session = device ? "device" : crypto.randomUUID();
    this.ctx.acceptWebSocket(pair[1], device ? ["device"] : ["sessions", session]);
    pair[1].serializeAttachment({ session, generation, active: true } satisfies Peer);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  message(socket: WebSocket, data: string | ArrayBuffer) {
    const { session, active, generation } = socket.deserializeAttachment() as Peer;
    if (!active) return;
    try {
      if (typeof data !== "string" || Buffer.byteLength(data) > REVERSE_BYTES) throw new Error();
      if (session === "device") {
        if (data === "ping") { socket.send("pong"); return; }
        // 大截图只拆外层信封，SDK 在目标线程中校验 JSON-RPC。避免共享中继解析并重新编码整份 Base64。
        const header = messageHeader.exec(data);
        if (header && sessionId.test(header[1]!) && data[header[0].length] === "{" && data.endsWith("}}")) {
          const message = data.slice(header[0].length, -1);
          if (Buffer.byteLength(message) > MESSAGE_BYTES) throw new Error();
          this.live(header[1]!, generation)?.send(message);
          return;
        }
        // 原协议接受不固定字段顺序的小信封。
        if (Buffer.byteLength(data) > 1024 * 1024) throw new Error();
        const payload = JSON.parse(data);
        if (!payload || typeof payload.session !== "string" || !sessionId.test(payload.session)) throw new Error();
        if (payload.close === true && !("message" in payload)) {
          const peer = this.live(payload.session, generation);
          if (peer) this.disconnect(peer, false);
          return;
        }
        if (typeof payload.message !== "object" || !payload.message) throw new Error();
        this.live(payload.session, generation)?.send(JSON.stringify(payload.message));
      } else {
        const target = this.live("device", generation);
        if (!target || Buffer.byteLength(data) > MESSAGE_BYTES) throw new Error();
        // 来自 SDK 的逻辑连接仅发送小型请求；先检查结构再包装，避免向设备交付无效信封。
        const payload = JSON.parse(data);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
        target.send('{"session":"' + session + '","message":' + data + '}');
      }
    } catch { this.disconnect(socket); }
  }
  disconnect(socket: WebSocket, notifyDevice = true) {
    const peer = socket.deserializeAttachment() as Peer;
    if (!peer.active) return;
    socket.serializeAttachment({ ...peer, active: false });
    try { socket.close(1000, "closed"); } catch { /* already closed */ }
    if (peer.session === "device") {
      for (const s of this.ctx.getWebSockets("sessions")) {
        if ((s.deserializeAttachment() as Peer).generation === peer.generation) this.disconnect(s);
      }
    } else if (notifyDevice) {
      try { this.live("device", peer.generation)?.send(JSON.stringify({ session: peer.session, close: true })); } catch { /* disconnected */ }
    }
  }
}
