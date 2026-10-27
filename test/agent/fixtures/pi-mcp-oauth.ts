import { createHash, randomBytes } from "node:crypto";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { parseMcpConfig } from "../../../src/agent/pi-mcp/config.js";

export const CLIENT_METADATA_URL = "https://jule-agent.vercel.app/oauth/client-metadata.json";
export const REDIRECT_URL = "http://127.0.0.1:8787/mcp/oauth/callback";

/** 独立资源、issuer 与第三方回环服务，真实检查 PKCE、来源边界及 refresh token 轮换。 */
export async function oauthFixture({ dualStack = false } = {}) {
  let origin = "", issuer = "", serial = 0, token: OAuthTokens | undefined;
  const codes = new Map<string, URLSearchParams>();
  const paths: string[] = [], grants: string[] = [], authorizations: URLSearchParams[] = [];
  const endpoints: Partial<Record<"authorization_endpoint" | "token_endpoint" | "registration_endpoint" | "revocation_endpoint", string>> = {};
  const behavior = { rejectNext: false, rejectAlways: false, rejectGetAlways: false, rejectConcurrent: false,
    invalidGrant: false, refresh503Once: false, holdNextPost: false, endpoints };
  const concurrent: ServerResponse[] = [], rejectedTokens: (string | undefined)[] = [], resourceMethods: string[] = [];
  let delayed401: ServerResponse | undefined;
  let refreshes = 0, revocations = 0, registrations = 0, resourceRequests = 0;
  const handler: RequestListener = async (req, res) => {
    req.on("error", () => {}); res.on("error", () => {});
    const url = new URL(req.url ?? "/", origin); paths.push(url.pathname);
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(200, { resource: `${origin}/mcp`, authorization_servers: [issuer], scopes_supported: ["default"] }); return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`, response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: true, ...behavior.endpoints }); return;
    }
    if (url.pathname === "/authorize") {
      authorizations.push(url.searchParams);
      const code = randomBytes(24).toString("base64url"); codes.set(code, url.searchParams);
      json(200, { code }); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8"), params = new URLSearchParams(body);
    if (url.pathname === "/register") {
      registrations++;
      json(201, { ...JSON.parse(body), client_id: "dynamic-fixture", client_secret: "fixture-dynamic-secret", token_endpoint_auth_method: "none" }); return;
    }
    if (url.pathname === "/revoke") { revocations++; json(200, {}); return; }
    if (url.pathname === "/token") {
      const grant = params.get("grant_type") ?? ""; grants.push(grant);
      if (grant === "refresh_token") {
        refreshes++;
        if (behavior.refresh503Once) { behavior.refresh503Once = false; json(503, { error: "temporarily_unavailable" }); return; }
        if (behavior.invalidGrant || params.get("refresh_token") !== token?.refresh_token) { json(400, { error: "invalid_grant" }); return; }
      } else {
        const code = params.get("code") ?? "", authorization = codes.get(code); codes.delete(code);
        const challenge = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
        if (!authorization || authorization.get("code_challenge") !== challenge || params.get("redirect_uri") !== REDIRECT_URL ||
          params.get("client_id") !== authorization.get("client_id")) { json(400, { error: "invalid_grant" }); return; }
      }
      serial++;
      token = { access_token: `access-${serial}-${randomBytes(18).toString("hex")}`, refresh_token: `refresh-${serial}-${randomBytes(18).toString("hex")}`,
        token_type: "Bearer", scope: "default", expires_in: 3600 };
      json(200, token); return;
    }
    if (url.pathname !== "/mcp") { json(404, {}); return; }
    resourceRequests++;
    resourceMethods.push(req.method ?? "GET");
    const unauthorized = (response: ServerResponse) => response.writeHead(401, {
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="default"`,
    }).end();
    if (behavior.rejectConcurrent && req.method === "POST") {
      concurrent.push(res); rejectedTokens.push(req.headers.authorization);
      if (concurrent.length === 2) { behavior.rejectConcurrent = false; concurrent.splice(0).forEach(unauthorized); }
      return;
    }
    if ((behavior.rejectNext && req.method === "POST") || (behavior.rejectGetAlways && req.method === "GET") || behavior.rejectAlways || !token || req.headers.authorization !== `Bearer ${token.access_token}`) {
      behavior.rejectNext = false;
      unauthorized(res); return;
    }
    if (behavior.holdNextPost && req.method === "POST") {
      behavior.holdNextPost = false; delayed401 = res; return;
    }
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    if (req.method === "DELETE") { res.writeHead(202).end(); return; }
    const message = JSONRPCMessageSchema.parse(JSON.parse(body));
    if (!("method" in message) || !("id" in message)) { res.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "read", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "done" }] };
    json(200, { jsonrpc: "2.0", id: message.id, result });
  };
  let thirdPartyRequests = 0;
  const server = createServer(handler), authorizationServer = createServer(handler);
  const thirdParty = createServer((_req, res) => { thirdPartyRequests++; res.writeHead(500).end(); });
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_address");
    return `http://127.0.0.1:${address.port}`;
  };
  origin = await listen(server);
  issuer = (await listen(authorizationServer)).replace("127.0.0.1", dualStack ? "localhost" : "127.0.0.1");
  const thirdPartyOrigin = await listen(thirdParty);
  const parsed = parseMcpConfig({ version: 1, enabled: true, servers: [{ id: "notion", transport: {
    kind: "streamable-http", url: `${origin}/mcp`, allowLoopbackHttp: true }, credential: {
    kind: "oauth", accountId: "owner-notion", revision: "1", clientMetadataUrl: CLIENT_METADATA_URL, scope: "default" },
    tools: { allow: ["read"] }, access: { kind: "owner-private" }, replay: "unsafe" }] });
  if (parsed.kind !== "enabled") throw new Error("fixture_config");
  return { origin, issuer, thirdPartyOrigin, config: parsed.value.servers[0], paths, grants, authorizations, behavior, resourceMethods, rejectedTokens,
    get token() { if (!token) throw new Error("fixture_not_logged_in"); return { ...token, issuer }; },
    get thirdPartyRequests() { return thirdPartyRequests; },
    get refreshes() { return refreshes; }, get revocations() { return revocations; }, get registrations() { return registrations; },
    get resourceRequests() { return resourceRequests; },
    get hasDelayed401() { return !!delayed401; },
    releaseDelayed401: () => {
      if (!delayed401) throw new Error("fixture_no_delayed_response");
      delayed401.writeHead(401).end(); delayed401 = undefined;
    },
    authorize: async (url: string): Promise<string> => {
      const response = await fetch(url), body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("code" in body) || typeof body.code !== "string") throw new Error("fixture_code");
      return body.code;
    },
    close: () => Promise.all([server, authorizationServer, thirdParty].map(server => new Promise<void>((resolve, reject) => {
      server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
    }))),
  };
}
