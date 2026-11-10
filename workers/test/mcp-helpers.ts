import { env } from "cloudflare:test";
import { vi } from "vitest";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import worker from "../src/index";

// 全部为合成测试值，不读取开发机或线上凭据。
export const TEST_STORE_KEY = "01".repeat(32);
export const ACCESS = "synthetic-access-token", REFRESH = "synthetic-refresh-token";
export const issuer = "https://auth.example.test";
export const callback = `${env.PUBLIC_ORIGIN}/mcp/oauth/callback`;
export const sampleTools: Tool[] = [
  { name: "notion-search", description: "搜索资料", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "notion-fetch", inputSchema: { type: "object", properties: {} } },
  { name: "notion-create-pages", inputSchema: { type: "object", properties: { bad: { type: "string", secretKeyword: true } } } },
  { name: "not-allowed", inputSchema: { type: "object" } },
];
const Rpc = Type.Object({ id: Type.Optional(Type.Union([Type.Number(), Type.String()])), method: Type.String(), params: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
export function fakeRemote(endpoint = "https://mcp.notion.com/mcp") {
  const requests: { url: string; method: string; body: string; headers: Headers; redirect: string }[] = [];
  const state = {
    resources: [{ uri: "notion://docs/start", name: "起步资料" }, { uri: "notion://private/hidden", name: "未授权" }],
    resourceBlob: undefined as { blob: string; mimeType: string } | undefined,
    templates: [{ uriTemplate: "notion://docs/{page}", name: "文档" }], resourceReads: 0,
    tools: structuredClone(sampleTools), refreshes: 0, calls: 0, initializations: 0, pages: 0,
    tokenStatus: 200, tokenError: "invalid_grant", expires: 3600, cimd: true,
    tokenEndpoint: `${issuer}/token`, resourceIssuer: issuer, failCalls: false, failPage: false,
    toolResult: undefined as CallToolResult | undefined,
    beforeCall: undefined as (() => Promise<void>) | undefined,
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url), body = new TextDecoder().decode(await request.arrayBuffer());
    requests.push({ url: request.url, method: request.method, body, headers: request.headers, redirect: request.redirect });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [state.resourceIssuer] });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return Response.json({ issuer: state.resourceIssuer,
      authorization_endpoint: `${state.resourceIssuer}/authorize`, token_endpoint: state.tokenEndpoint,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: state.cimd, token_endpoint_auth_methods_supported: ["none"] });
    if (url.href === `${issuer}/token`) {
      const form = new URLSearchParams(body);
      const refreshing = form.get("grant_type") === "refresh_token";
      if (refreshing) state.refreshes++;
      if (state.tokenStatus !== 200) return Response.json({ error: state.tokenError, error_description: "untrusted-token-response" }, { status: state.tokenStatus });
      return Response.json({ token_type: "Bearer", access_token: refreshing ? `${ACCESS}-refreshed` : ACCESS,
        ...(refreshing ? {} : { refresh_token: REFRESH }), scope: "default", expires_in: state.expires });
    }
    if (url.href === endpoint) {
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") return new Response(null, { status: 202 });
      const rpc: unknown = JSON.parse(body);
      if (!Check(Rpc, rpc)) throw new Error("bad_test_rpc");
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === "initialize") { state.initializations++; result = { protocolVersion: rpc.params?.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: "fixture", version: "1" } }; }
      else if (rpc.method === "tools/list") {
        state.pages++;
        if (state.failPage && rpc.params?.cursor) return new Response("synthetic-private-body", { status: 500 });
        result = rpc.params?.cursor ? { tools: state.tools.slice(2) } : { tools: state.tools.slice(0, 2), nextCursor: "page2" };
      } else if (rpc.method === "resources/list") result = { resources: state.resources };
      else if (rpc.method === "resources/templates/list") result = { resourceTemplates: state.templates };
      else if (rpc.method === "resources/read") { state.resourceReads++; result = { contents: [{ uri: rpc.params?.uri, ...(state.resourceBlob ?? { mimeType: "text/plain", text: "合成文档正文" }) }] }; }
      else if (rpc.method === "tools/call") {
        state.calls++;
        await state.beforeCall?.();
        if (state.failCalls) throw new Error("synthetic-network-detail");
        result = state.toolResult ?? { content: [{ type: "text", text: "service-result:" + JSON.stringify(rpc.params?.arguments) }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] };
      } else throw new Error("unexpected_test_method");
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers: { "Mcp-Session-Id": "fixture-session" } });
    }
    throw new Error("unexpected_test_destination");
  });
  return { state, requests, spy };
}
export const adminEnv = () => ({ ...env, ADMIN_TOKEN: "synthetic-admin" });
export function adminRequest(token = "synthetic-admin", body: unknown = { server: "notion" }) {
  return new Request(`${env.PUBLIC_ORIGIN}/admin/mcp/oauth/login-link`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
export async function beginLogin() {
  const response = await worker.fetch(adminRequest(), adminEnv());
  const link: unknown = await response.json();
  if (!Check(Type.Object({ url: Type.String() }), link)) throw new Error("missing_test_link");
  const start = await worker.fetch(new Request(link.url), env);
  const location = start.headers.get("location");
  if (!location) throw new Error(`missing_test_redirect:${await start.text()}`);
  return { link: link.url, authorization: new URL(location) };
}
export async function login() {
  const started = await beginLogin();
  const response = await worker.fetch(new Request(`${callback}?code=synthetic-code&state=${started.authorization.searchParams.get("state")}`), env);
  if (response.status !== 200) throw new Error(`test_login_failed:${await response.text()}`);
  return started;
}
