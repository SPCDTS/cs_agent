// 独立节点示例：只提供返回固定文本的 hello，不开放 shell、文件或桌面。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, JSONRPCMessageSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const url = process.env.REVERSE_MCP_URL ?? "";
const endpoint = new URL(URL.canParse(url) ? url : "about:blank");
const token = process.env.REVERSE_MCP_TOKEN ?? "";
if (endpoint.protocol !== "wss:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !/^\/mcp\/reverse\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(endpoint.pathname) || !/^[A-Za-z0-9._~-]{32,256}$/.test(token)) {
  throw new Error("请设置 REVERSE_MCP_URL（wss 注册地址）与 REVERSE_MCP_TOKEN（实例专用凭据）。");
}
// Node 的内置 WebSocket 支持 Undici 握手选项，浏览器 DOM 重载不包含 headers。
const NodeSocket = WebSocket as typeof import("undici-types").WebSocket;
const socket = new NodeSocket(endpoint, { headers: { Authorization: "Bearer " + token } });
const sessions = new Map<string, Transport>();
const maxBytes = 1024 * 1024;
socket.addEventListener("open", () => console.log("反向 MCP 已注册，可在管理页检测并启用 hello。"));
socket.addEventListener("error", () => { console.error("注册连接失败，请核对地址、网络及实例凭据。"); process.exitCode = 1; });
socket.addEventListener("close", () => {
  for (const session of sessions.values()) void session.close();
  sessions.clear();
});

async function receive(data: unknown) {
  if (typeof data !== "string" || Buffer.byteLength(data) > maxBytes) throw new Error();
  const frame = JSON.parse(data);
  if (typeof frame?.session !== "string" || !/^[a-f0-9-]{36}$/.test(frame.session)) throw new Error();
  const id: string = frame.session;
  let transport = sessions.get(id);
  if (frame.close === true) { await transport?.close(); sessions.delete(id); return; }
  const message = JSONRPCMessageSchema.parse(frame.message);
  if (!transport) {
    if (!("method" in message) || message.method !== "initialize" || sessions.size >= 16) throw new Error();
    const server = new Server({ name: "reverse-example", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "hello", description: "返回固定问候", inputSchema: { type: "object" } }] }));
    server.setRequestHandler(CallToolRequestSchema, req => {
      if (req.params.name !== "hello") throw new Error("unknown tool");
      return { content: [{ type: "text", text: "Hello from the reverse MCP node!" }] };
    });
    transport = { async start() {}, async close() { this.onclose?.(); },
      async send(reply) { socket.send(JSON.stringify({ session: id, message: reply })); } };
    sessions.set(id, transport);
    await server.connect(transport);
  }
  transport.onmessage?.(message);
}
socket.addEventListener("message", e => { void receive(e.data).catch(() => socket.close(4002, "invalid frame")); });
