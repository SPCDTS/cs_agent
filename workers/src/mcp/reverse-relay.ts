// 每个凭据版本独占一个 DO；一个设备连接承载多个隔离的 SDK 会话。
export const REVERSE_BYTES = 1024 * 1024;
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
  upgrade(req: Request) {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const device = new URL(req.url).pathname === "/register";
    let generation: string;
    if (device) {
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
      const payload = JSON.parse(data);
      if (session === "device") {
        if (!payload || typeof payload.session !== "string" || !/^[a-f0-9-]{36}$/.test(payload.session) || typeof payload.message !== "object" || !payload.message) throw new Error();
        this.live(payload.session, generation)?.send(JSON.stringify(payload.message));
      } else {
        const target = this.live("device", generation);
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
      for (const s of this.ctx.getWebSockets("sessions")) {
        if ((s.deserializeAttachment() as Peer).generation === peer.generation) this.disconnect(s);
      }
    } else {
      try { this.live("device", peer.generation)?.send(JSON.stringify({ session: peer.session, close: true })); } catch { /* disconnected */ }
    }
  }
}
