import { createServer, type IncomingMessage } from "node:http";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../../../src/agent/pi-mcp/config.js";

export type HttpMode = "json" | "sse" | "duplicate-name" | "duplicate-cursor" | "large-json" | "large-sse" | "sse-comment" | "redirect" | "cross-origin" | "unauthorized" | "forbidden" | "lost" | "fail" | "hang" | "late";

/** 真实 HTTP 协议装置；只在本机监听，不依赖业务服务。 */
export async function httpFixture(mode: HttpMode = "json") {
  const messages: JSONRPCMessage[] = [];
  const paths: string[] = [];
  const headers: IncomingMessage["headers"][] = [];
  let calls = 0;
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "");
    headers.push(request.headers);
    request.on("error", () => {});
    response.on("error", () => {});
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { response.writeHead(202).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const message = JSONRPCMessageSchema.parse(input);
    messages.push(message);
    if (!("method" in message) || !("id" in message)) { response.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === "initialize") {
      if (mode === "redirect" || mode === "cross-origin") {
        response.writeHead(307, { Location: mode === "redirect" ? "/redirected" : "http://127.0.0.1:1/stolen" }).end(); return;
      }
      response.setHeader("mcp-session-id", "fixture-session");
      result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" } };
    } else if (message.method === "tools/list") {
      const second = message.params?.cursor !== undefined;
      result = {
        tools: [{ name: second && mode !== "duplicate-name" ? "second" : "first", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } }],
        ...(!second || mode === "duplicate-cursor" ? { nextCursor: "next" } : {}),
      };
    } else if (message.method === "tools/call") {
      calls++;
      if (mode === "unauthorized" || mode === "forbidden" || mode === "lost" || mode === "fail") {
        response.writeHead(mode === "unauthorized" ? 401 : mode === "forbidden" ? 403 : mode === "lost" ? 404 : 503,
          { "www-authenticate": "Bearer resource_metadata=\"http://127.0.0.1:1/oauth\"" }).end("SECRET_REMOTE_ERROR"); return;
      }
      if (mode === "hang") return;
      if (mode === "large-json") { response.writeHead(200, { "content-type": "application/json" }).end("{" + "x".repeat(4096)); return; }
      if (mode === "large-sse" || mode === "sse-comment") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(mode === "large-sse" ? "data: {" : ":");
        response.end("x".repeat(4096)); return;
      }
      result = { content: [{ type: "text", text: "done" }], structuredContent: { value: "deliberately-invalid-schema" } };
    } else { response.writeHead(202).end(); return; }
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    if (mode === "late" && message.method === "tools/call" && calls === 1) {
      setTimeout(() => response.writeHead(200, { "content-type": "application/json" }).end(body), 100);
      return;
    }
    if (mode === "sse" && message.method === "tools/call") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: message\r\ndata: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\r\n\r\n");
      response.write("data: " + body.slice(0, 10));
      response.end(body.slice(10) + "\r\n\r\n");
    } else response.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  const config: McpServerConfig = {
    id: "fixture", enabled: true, transport: { kind: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, headers: {}, secretHeaders: { Authorization: "FIXTURE_SECRET" }, allowLoopbackHttp: true, allowPrivateNetworkHttp: false },
    credential: { kind: "none" }, tools: { allow: ["first", "second"] },
    access: { kind: "owner-private", allowScheduled: false, allowWake: false, allowSubagent: false }, replay: "unsafe",
  };
  return {
    config, messages, paths, headers, get calls() { return calls; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
