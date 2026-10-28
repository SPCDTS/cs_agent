import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { channelDown, parseFrame, type SendReceipt } from "./onebot";

type Attachment = { id: string; active: boolean };
type Pending = { socket: WebSocket; resolve: (receipt: SendReceipt) => void; reject: (error: Error) => void };

export class BridgeDO extends DurableObject<Env> {
  // P0 等待表只在内存中：驱逐后无法关联未决响应；P1 需持久化调用意图与回执。
  private readonly pending = new Map<string, Pending>();

  private activeSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets().find(socket => {
      const attachment: Attachment | null = socket.deserializeAttachment();
      return attachment?.active === true && socket.readyState === WebSocket.OPEN;
    });
  }

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket required", { status: 426 });
    for (const socket of this.ctx.getWebSockets()) {
      this.disconnect(socket);
      socket.close(1000, "replaced");
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ id: crypto.randomUUID(), active: true } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // 已被新连接取代的 socket 可能还有排队帧，不能再投递或结算 API。
    if (socket !== this.activeSocket()) return;
    const frame = parseFrame(raw);
    if (!frame) return;
    switch (frame.kind) {
      case "meta":
        if (frame.selfId) await this.ctx.storage.put("selfId", frame.selfId);
        return;
      case "response": {
        const pending = this.pending.get(frame.echo);
        if (!pending || pending.socket !== socket) return;
        if (frame.result.ok) pending.resolve(frame.result.receipt);
        else pending.reject(new Error("onebot_failed: 发送结果不确定，请先核实，不要重试"));
        return;
      }
      case "message": {
        const owners = (this.env.QQ_OWNER ?? "").split(",").map(owner => owner.trim()).filter(Boolean);
        if (!frame.private || !owners.includes(frame.input.userId)) {
          await this.ctx.storage.transaction(async tx => {
            await tx.put("ignored", (await tx.get<number>("ignored") ?? 0) + 1);
          });
          return;
        }
        if (!frame.input.messageId || !frame.input.text.trim()) return;
        // 平台托管 RPC 的生命周期，让 WS 回调立即结束并继续处理回执。
        this.ctx.waitUntil(this.env.THREAD.getByName("owner").submit(frame.input).catch(() => {
          console.error({ event: "submit_failed", messageId: frame.input.messageId, length: frame.input.text.length });
        }));
      }
    }
  }

  async sendPrivate(userId: string, text: string): Promise<SendReceipt> {
    const socket = this.activeSocket();
    if (!socket) throw channelDown();
    const echo = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<SendReceipt>((resolve, reject) => {
        this.pending.set(echo, { socket, resolve, reject });
        timer = setTimeout(() => reject(new Error("onebot_timeout: 发送结果不确定，请先核实，不要重试")), 15_000);
        socket.send(JSON.stringify({ action: "send_private_msg", params: { user_id: userId, message: [{ type: "text", data: { text } }] }, echo }));
      });
    } finally {
      // 结算后立即撤掉计时器，空闲的 Bridge 才能休眠。
      if (timer !== undefined) clearTimeout(timer);
      this.pending.delete(echo);
    }
  }

  async status(): Promise<{ connected: boolean; selfId?: string; ignored: number }> {
    return { connected: this.activeSocket() !== undefined,
      selfId: await this.ctx.storage.get<string>("selfId"),
      ignored: await this.ctx.storage.get<number>("ignored") ?? 0 };
  }

  private disconnect(socket: WebSocket): void {
    const attachment: Attachment | null = socket.deserializeAttachment();
    if (attachment) socket.serializeAttachment({ ...attachment, active: false });
    for (const pending of this.pending.values()) {
      // 已发帧的断线属于结果不确定，不能伪装成发送前的 channel_down。
      if (pending.socket === socket) pending.reject(new Error("onebot_disconnected: 发送结果不确定，请先核实，不要重试"));
    }
  }
  override webSocketClose(socket: WebSocket, code: number): void {
    this.disconnect(socket);
    socket.close(code === 1005 || code === 1006 ? 1000 : code);
  }
  override webSocketError(socket: WebSocket): void {
    this.disconnect(socket);
    socket.close(1011, "websocket error");
  }
}
