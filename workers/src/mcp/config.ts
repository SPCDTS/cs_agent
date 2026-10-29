import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import config from "../../mcp.json";

const strict = { additionalProperties: false };
const clean = (maxLength: number, minLength = 0) => Type.String({ minLength, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]*$" });
const limit = (maximum: number) => Type.Optional(Type.Integer({ minimum: 1, maximum }));
const Limits = Type.Object({
  connectMs: limit(60_000), callMs: limit(300_000), connections: limit(64), queuedPerConnection: limit(64),
  idleMs: limit(3_600_000), catalogTtlMs: limit(3_600_000), maxPages: limit(100), maxTools: limit(1000),
  catalogBytes: limit(8_388_608), schemaBytes: limit(262_144), schemaDepth: limit(64),
  visibleTools: limit(128), visibleSchemaBytes: limit(2_097_152), argumentBytes: limit(1_048_576),
  messageBytes: limit(25_165_824), structuredBytes: limit(1_048_576), closePerConnectionMs: limit(10_000),
}, strict);
export const DEFAULT_MCP_LIMITS = Object.freeze({
  connectMs: 10_000, callMs: 60_000, connections: 16, queuedPerConnection: 16, idleMs: 600_000,
  catalogTtlMs: 300_000, maxPages: 20, maxTools: 200, catalogBytes: 2_097_152, schemaBytes: 65_536,
  schemaDepth: 64, visibleTools: 64, visibleSchemaBytes: 524_288, argumentBytes: 262_144,
  messageBytes: 12_582_912, structuredBytes: 262_144, closePerConnectionMs: 3000,
});
export type McpLimits = { [K in keyof typeof DEFAULT_MCP_LIMITS]: number };
const Header = Type.String({ maxLength: 128, pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" });
const Variable = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" });
const Credential = Type.Union([
  Type.Object({ kind: Type.Literal("none") }, strict),
  Type.Object({ kind: Type.Literal("external-account"), accountId: clean(128, 1), revision: clean(128, 1) }, strict),
  Type.Object({ kind: Type.Literal("oauth"), accountId: clean(128, 1), revision: clean(128, 1),
    registration: Type.Optional(Type.Literal("cimd")), clientMetadataUrl: clean(4096, 1), scope: Type.Optional(clean(256)) }, strict),
]);
const Server = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }), enabled: Type.Optional(Type.Boolean()),
  transport: Type.Object({ kind: Type.Literal("streamable-http"), url: clean(4096, 1),
    headers: Type.Optional(Type.Record(Header, clean(8192), strict)), secretHeaders: Type.Optional(Type.Record(Header, Variable, strict)) }, strict),
  credential: Credential, access: Type.Object({ kind: Type.Literal("owner-private") }, strict),
  tools: Type.Object({ allow: Type.Array(clean(256, 1), { maxItems: 1000, uniqueItems: true }) }, strict), replay: Type.Literal("unsafe"),
}, strict);
const Config = Type.Object({ version: Type.Literal(1), enabled: Type.Boolean(), servers: Type.Array(Server, { maxItems: 64 }), limits: Type.Optional(Limits) }, strict);
type ServerInput = Static<typeof Server>;
export type McpServerConfig = ServerInput & { enabled: boolean; transport: ServerInput["transport"] & { headers: Record<string, string>; secretHeaders: Record<string, string> } };
export type OAuthServer = McpServerConfig & { credential: Extract<ServerInput["credential"], { kind: "oauth" }> };
export type McpConfig = { version: 1; enabled: boolean; servers: McpServerConfig[]; limits: McpLimits };

export function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid_url");
  return url;
}
export function publicOrigin(value: string): string {
  const url = httpsUrl(value);
  if (url.pathname !== "/" || url.search) throw new Error("unconfigured");
  return url.origin;
}
export function parseMcpConfig(value: unknown): McpConfig {
  // 配置错误只给固定分类，避免原始校验错误把误填的凭据带进日志。
  try {
    if (!Check(Config, value) || new Set(value.servers.map(s => s.id)).size !== value.servers.length) throw new Error();
    const servers = value.servers.map(server => {
      httpsUrl(server.transport.url);
      const headers = server.transport.headers ?? {}, secretHeaders = server.transport.secretHeaders ?? {};
      const names = [...Object.keys(headers), ...Object.keys(secretHeaders)].map(n => n.toLowerCase());
      if (new Set(names).size !== names.length || names.some(n => /^(accept|content-type|host|content-length|connection|transfer-encoding|upgrade|te|trailer|keep-alive|mcp-.*|last-event-id|proxy-.*|sec-.*|cookie|set-cookie)$/i.test(n))
        || Object.keys(headers).some(n => /(?:^|[-_])(?:auth|authorization|cookie|token|key|secret)(?:$|[-_])/i.test(n))) throw new Error();
      if (server.credential.kind === "none" && Object.keys(secretHeaders).length) throw new Error();
      if (server.credential.kind === "oauth") {
        if (httpsUrl(server.credential.clientMetadataUrl).pathname === "/" || names.includes("authorization")) throw new Error();
      }
      return { ...server, enabled: server.enabled ?? true, transport: { ...server.transport, headers, secretHeaders } };
    });
    return { ...value, servers, limits: { ...DEFAULT_MCP_LIMITS, ...value.limits } };
  } catch { throw new Error("mcp_config_invalid"); }
}
// 构建时打包；聊天、模型参数和工作目录均不能改变服务或凭据引用。
export const MCP_CONFIG = parseMcpConfig(config);
export const isOAuthServer = (server: McpServerConfig): server is OAuthServer => server.credential.kind === "oauth";
export function referencedSecret(env: object, name: string): string | undefined {
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" && value.length ? value : undefined;
}
