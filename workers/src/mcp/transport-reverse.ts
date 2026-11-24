import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Env } from "../env";
import { McpConnectionError } from "./transport-http";

export class ReverseTransport implements Transport {
  private socket?: WebSocket;
  private closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  constructor(private env: Env, private digest: string, private bytes: number, private connectSignal: AbortSignal) {}
  async start() {
    const response = await this.env.BRIDGE.getByName("mcp-reverse:" + this.digest).fetch("https://relay/session", { headers: { Upgrade: "websocket" }, signal: this.connectSignal });
    const socket = response.webSocket;
    if (!socket) throw new McpConnectionError(response.status === 429 ? "rate_limited" : "reverse_offline", "reverse_unavailable");
    this.socket = socket;
    socket.addEventListener("message", event => {
      try {
        if (typeof event.data !== "string") throw new Error();
        if (Buffer.byteLength(event.data) > this.bytes) throw new McpConnectionError("message_limit", "message_limit");
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(event.data)));
      } catch (error) { this.onerror?.(error instanceof McpConnectionError ? error : new McpConnectionError("protocol_error", "protocol_error")); void this.close(); }
    });
    const lost = () => {
      if (!this.closed) { this.onerror?.(new McpConnectionError("reverse_offline", "reverse_offline")); void this.close(); }
    };
    socket.addEventListener("close", lost);
    socket.addEventListener("error", lost);
    socket.accept();
  }
  async send(message: JSONRPCMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN || this.closed) throw new McpConnectionError("reverse_offline", "reverse_offline");
    const data = JSON.stringify(message);
    if (Buffer.byteLength(data) > this.bytes) throw new McpConnectionError("message_limit", "message_limit");
    this.socket.send(data);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.close(1000); } finally { this.onclose?.(); }
  }
}
