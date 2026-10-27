import { createServer, type IncomingMessage } from "node:http";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../../../src/agent/pi-mcp/config.js";

export type HttpMode = "json" | "sse" | "duplicate-name" | "duplicate-cursor" | "large-json" | "large-sse" | "sse-comment" | "redirect" | "cross-origin" | "unauthorized" | "forbidden" | "lost" | "fail" | "hang" | "late";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

/** 两类目录均分页，混入白名单外条目；资源正文只用于真实协议测试。 */
export function resourceResponse(method: string, params?: { [key: string]: unknown }) {
  const second = params?.cursor !== undefined;
  if (method === "resources/list") return { result: {
    resources: second ? [{ uri: "notion://docs/skills", name: "skills", mimeType: "text/plain" }]
      : [{ uri: "notion://docs/memory", name: "memory", title: "Memory\nTitle", mimeType: "text/markdown", description: "说明\u0000" + "长".repeat(400) },
        { uri: "ui://notion/app", name: "隐藏", mimeType: "text/html;profile=mcp-app" }],
    ...second ? {} : { nextCursor: "next" },
  } };
  if (method === "resources/templates/list") return { result: {
    resourceTemplates: second ? [{ uriTemplate: "ui://notion/{id}", name: "隐藏模板" }]
      : [{ uriTemplate: "notion://docs/{id}", name: "文档模板" }],
    ...second ? {} : { nextCursor: "next" },
  } };
  if (method === "resources/read") {
    const uri = String(params?.uri);
    if (uri.endsWith("/missing")) return { error: { code: -32002, message: "RESOURCE_ERROR_SENTINEL\n找不到资源" } };
    if (uri.endsWith("/empty")) return { result: { contents: [] } };
    if (uri.endsWith("/png")) return { result: { contents: [{ uri, mimeType: "image/png", blob: png }] } };
    if (uri.endsWith("/binary")) return { result: { contents: [{ uri, mimeType: "application/octet-stream", blob: "AAEC" }] } };
    return { result: { contents: [{ uri, mimeType: "text/markdown", text: uri.endsWith("/large") ? "中文😀".repeat(10_000) : "RESOURCE_BODY_SENTINEL：记忆资料" }] } };
  }
  throw new Error("fixture_resource_method");
}

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
      result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: "fixture", version: "1" } };
    } else if (message.method === "tools/list") {
      const second = message.params?.cursor !== undefined;
      result = {
        tools: [{ name: second && mode !== "duplicate-name" ? "second" : "first", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } }],
        ...(!second || mode === "duplicate-cursor" ? { nextCursor: "next" } : {}),
      };
    } else if (message.method.startsWith("resources/")) {
      const payload = resourceResponse(message.method, message.params);
      if (mode === "duplicate-name" && message.method === "resources/list" && "resources" in (payload.result ?? {})) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: { resources: [{ uri: "notion://docs/memory", name: "memory" }], ...message.params?.cursor ? {} : { nextCursor: "next" } } })); return;
      }
      if (mode === "duplicate-cursor" && payload.result && message.method !== "resources/read") Object.assign(payload.result, { nextCursor: "next" });
      if (mode === "sse") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/list_changed" }) + "\n\n");
        response.end("data: " + JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }) + "\n\n");
      } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
      return;
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
    credential: { kind: "none" }, resources: { allow: [] }, tools: { allow: ["first", "second"], approval: [] },
    access: { kind: "owner-private", allowScheduled: false, allowWake: false, allowSubagent: false, groups: [] }, replay: "unsafe",
  };
  return {
    config, messages, paths, headers, get calls() { return calls; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
