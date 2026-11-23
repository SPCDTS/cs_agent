// 每个凭据版本独占一个 DO；一个设备连接承载多个隔离的 SDK 会话。
export const REVERSE_BYTES = 1024 * 1024;
type Peer = { session: string; active: boolean };
export class ReverseRelay {
  constructor(private ctx: DurableObjectState) {}
  // 外层仅转发固定的内部地址；公开 /onebot 请求不会进入这里。
  static isInternalRequest(req: Request) { return req.url === "https://relay/register" || req.url === "https://relay/session"; }
  // WS tag 随休眠保留；不依赖唤醒时是否能从对象 ID 恢复命名。
  owns(socket: WebSocket) { return this.ctx.getTags(socket).includes("reverse"); }
  private live(tag: string) {
    return this.ctx.getWebSockets(tag).find(s => s.readyState === WebSocket.OPEN && (s.deserializeAttachment() as Peer).active);
  }
  upgrade(req: Request) {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const device = new URL(req.url).pathname === "/register";
    if (device) {
      for (const previous of this.ctx.getWebSockets("device")) this.disconnect(previous);
    } else if (!this.live("device")) return new Response("offline", { status: 503 });
    else if (this.ctx.getWebSockets("sessions").length >= 16) return new Response("busy", { status: 429 });
    const pair = new WebSocketPair(), session = device ? "device" : crypto.randomUUID();
    this.ctx.acceptWebSocket(pair[1], device ? ["reverse", "device"] : ["reverse", "sessions", session]);
    pair[1].serializeAttachment({ session, active: true } satisfies Peer);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  message(socket: WebSocket, data: string | ArrayBuffer) {
    const { session, active } = socket.deserializeAttachment() as Peer;
    if (!active) return;
    try {
      if (typeof data !== "string" || Buffer.byteLength(data) > REVERSE_BYTES) throw new Error();
      const payload = JSON.parse(data);
      if (session === "device") {
        if (!payload || typeof payload.session !== "string" || !/^[a-f0-9-]{36}$/.test(payload.session) || typeof payload.message !== "object" || !payload.message) throw new Error();
        this.live(payload.session)?.send(JSON.stringify(payload.message));
      } else {
        const target = this.live("device");
        if (!target) throw new Error();
        const frame = JSON.stringify({ session, message: payload });
        if (Buffer.byteLength(frame) > REVERSE_BYTES) throw new Error();
        target.send(frame);
      }
    } catch { this.disconnect(socket); }
  }
  disconnect(socket: WebSocket) {
    const peer = socket.deserializeAttachment() as Peer;
    if (!peer.active) return;
    socket.serializeAttachment({ ...peer, active: false });
    try { socket.close(1000, "closed"); } catch { /* already closed */ }
    if (peer.session === "device") {
      for (const s of this.ctx.getWebSockets("sessions")) this.disconnect(s);
    } else {
      try { this.live("device")?.send(JSON.stringify({ session: peer.session, close: true })); } catch { /* disconnected */ }
    }
  }
}
