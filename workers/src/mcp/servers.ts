import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ListToolsResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_CONFIG, parseMcpConfig, publicOrigin, type McpServerConfig } from "./config";
import { TokenVault } from "./crypto";
import { makeCatalog } from "./catalog";
import { serverDigest, connectionDigest, jsonBytes } from "./names";

const strict = { additionalProperties: false };
export const ServerId = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });
export const ServerSetup = Type.Object({ id: ServerId, url: Type.String({ minLength: 1, maxLength: 4096 }),
  auth: Type.Union([Type.Literal("none"), Type.Literal("token"), Type.Literal("oauth")]),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())), scope: Type.Optional(Type.String({ maxLength: 256 })) }, strict);
export type ServerSetupInput = Static<typeof ServerSetup>;
export const ServerSelection = Type.Object({ allow: Type.Array(Type.String(), { uniqueItems: true, maxItems: 1000 }),
  readOnly: Type.Optional(Type.Array(Type.String(), { uniqueItems: true, maxItems: 1000 })),
  resourceAllow: Type.Optional(Type.Array(Type.String(), { uniqueItems: true, maxItems: 100 })) }, strict);
export type ServerSelectionInput = Static<typeof ServerSelection>;
type Row = { id: string; config: string; revision: string; discovered: string | null; secret: string | null };
export class McpSetupError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict" | "probe_required" | "credentials_required") { super("mcp_setup:" + code); }
}
export function setupUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new McpSetupError("invalid"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || host === "localhost" || host.endsWith(".localhost")
    || host.endsWith(".local") || host.startsWith("[") || /^\d+(?:\.\d+)*$/.test(host)) throw new McpSetupError("invalid");
  return url.href;
}

/** 配置和凭据共用 Registry；mcp.json 只在首次初始化时导入，之后部署不覆盖运行时修改。 */
export class McpServerStore {
  constructor(private readonly sql: SqlStorage, private readonly vault: TokenVault, private readonly origin: string) {}
  initialize() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS mcp_servers(id TEXT PRIMARY KEY,config TEXT NOT NULL,revision TEXT NOT NULL,discovered TEXT,secret TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS mcp_server_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    if (!this.sql.exec("SELECT 1 FROM mcp_server_meta WHERE key='initialized'").toArray().length) {
      for (const server of MCP_CONFIG.servers) this.sql.exec("INSERT OR IGNORE INTO mcp_servers(id,config,revision) VALUES(?,?,?)", server.id, JSON.stringify(server), crypto.randomUUID());
      this.sql.exec("INSERT INTO mcp_server_meta VALUES('initialized','1')");
    }
  }
  private row(id: string, expected?: string): Row {
    const row = this.sql.exec<Row>("SELECT * FROM mcp_servers WHERE id=?", id).toArray()[0];
    if (!row) throw new McpSetupError("not_found");
    if (expected !== undefined && row.revision !== expected) throw new McpSetupError("conflict");
    return row;
  }
  private parse(row: Pick<Row, "config">): McpServerConfig { return parseMcpConfig({ version: 1, enabled: true, servers: [JSON.parse(row.config)] }).servers[0]!; }
  config() { return { ...MCP_CONFIG, servers: this.sql.exec<Pick<Row, "config">>("SELECT config FROM mcp_servers ORDER BY rowid").toArray().map(row => this.parse(row)) }; }
  get(id: string) {
    const row = this.row(id), server = this.parse(row);
    return { server, revision: row.revision, credentialSet: !!row.secret,
      discovered: row.discovered ? ListToolsResultSchema.parse(JSON.parse(row.discovered)).tools.map(tool => ({ name: tool.name, description: tool.description ?? tool.name, readOnlyHint: tool.annotations?.readOnlyHint === true })) : null };
  }
  list() { return this.config().servers.map(server => this.get(server.id)); }
  current(id: string, digest: string) {
    const row = this.sql.exec<Pick<Row, "config">>("SELECT config FROM mcp_servers WHERE id=?", id).toArray()[0];
    if (!row || !MCP_CONFIG.enabled) return false;
    const server = this.parse(row);
    return server.enabled && serverDigest(server) === digest;
  }
  put(input: ServerSetupInput, expected: string) {
    if (!Check(ServerSetup, input)) throw new McpSetupError("invalid");
    const previous = this.sql.exec<Row>("SELECT * FROM mcp_servers WHERE id=?", input.id).toArray()[0];
    if ((previous?.revision ?? "absent") !== expected) throw new McpSetupError("conflict");
    if (!previous && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_servers").one().n >= 64) throw new McpSetupError("invalid");
    const revision = crypto.randomUUID(), url = setupUrl(input.url);
    const server = parseMcpConfig({ version: 1, enabled: true, servers: [{ id: input.id, enabled: false,
      transport: { kind: "streamable-http", url, headers: input.headers ?? {} },
      credential: input.auth === "none" ? { kind: "none" } : input.auth === "token" ? { kind: "managed", accountId: "owner-" + input.id, revision } :
        { kind: "oauth", accountId: "owner-" + input.id, revision, registration: "cimd", clientMetadataUrl: publicOrigin(this.origin) + "/oauth/client-metadata.json", ...(input.scope ? { scope: input.scope } : {}) },
      access: { kind: "owner-private", revision }, tools: { allow: [], readOnly: [], eventAllow: [] }, replay: "unsafe" }] }).servers[0]!;
    this.sql.exec("INSERT INTO mcp_servers(id,config,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,revision=excluded.revision,secret=NULL,discovered=NULL", input.id, JSON.stringify(server), revision);
    return this.get(input.id);
  }
  recordProbe(id: string, expected: string, value: unknown) {
    this.row(id, expected);
    const parsed = ListToolsResultSchema.safeParse(value);
    if (!parsed.success || parsed.data.tools.length > MCP_CONFIG.limits.maxTools || jsonBytes(parsed.data) > MCP_CONFIG.limits.catalogBytes) throw new McpSetupError("invalid");
    this.sql.exec("UPDATE mcp_servers SET discovered=?,revision=? WHERE id=?", JSON.stringify(parsed.data), crypto.randomUUID(), id);
    return this.get(id);
  }
  activate(id: string, expected: string, input: ServerSelectionInput) {
    if (!Check(ServerSelection, input)) throw new McpSetupError("invalid");
    const row = this.row(id, expected), server = this.parse(row);
    if (!row.discovered) throw new McpSetupError("probe_required");
    const tools: Tool[] = ListToolsResultSchema.parse(JSON.parse(row.discovered)).tools;
    if (input.allow.some(name => !tools.some(tool => tool.name === name)) || input.readOnly?.some(name => !input.allow.includes(name))) throw new McpSetupError("invalid");
    const next = parseMcpConfig({ version: 1, enabled: true, servers: [{ ...server, enabled: true,
      tools: { allow: input.allow, readOnly: input.readOnly ?? [], eventAllow: [] }, resourceAllow: input.resourceAllow ?? [] }] }).servers[0]!;
    const accepted = makeCatalog(next, tools, MCP_CONFIG.limits);
    if (accepted.rejected) return { error: "tools_rejected" as const, rejected: accepted.rejected, rejectedTools: accepted.rejectedTools,
      message: "部分所选工具的定义不受支持，未修改服务状态或工具选择。请根据 rejectedTools 调整选择后重试，无需重新填写凭据。" };
    this.sql.exec("UPDATE mcp_servers SET config=?,revision=? WHERE id=?", JSON.stringify(next), crypto.randomUUID(), id);
    return this.get(id);
  }
  disable(id: string, expected: string) {
    const row = this.row(id, expected);
    this.sql.exec("UPDATE mcp_servers SET config=?,revision=? WHERE id=?", JSON.stringify({ ...this.parse(row), enabled: false }), crypto.randomUUID(), id);
    return this.get(id);
  }
  remove(id: string, expected: string) { this.row(id, expected); this.sql.exec("DELETE FROM mcp_servers WHERE id=?", id); return { removed: id }; }
  async credentialPut(id: string, expected: string, headers: unknown) {
    const row = this.row(id, expected), server = this.parse(row);
    if (server.credential.kind !== "managed" || !Check(Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\\r\\n]*$" })), headers) || !Object.keys(headers).length) throw new McpSetupError("invalid");
    // 复用配置头名校验；模型与公开配置只接触引用，不接触值。
    parseMcpConfig({ version: 1, enabled: true, servers: [{ ...server, transport: { ...server.transport, secretHeaders: Object.fromEntries(Object.keys(headers).map(name => [name, "MANAGED_HEADER"])) } }] });
    const revision = crypto.randomUUID(), credential = { ...server.credential, revision };
    const secret = await this.vault.encrypt(JSON.stringify(headers), JSON.stringify([id, revision]));
    this.row(id, expected);
    this.sql.exec("UPDATE mcp_servers SET secret=?,config=?,revision=?,discovered=NULL WHERE id=?", secret, JSON.stringify({ ...server, credential, access: { ...server.access, revision }, enabled: false }), revision, id);
    return this.get(id);
  }
  async credentialHeaders(id: string, expectedDigest: string): Promise<Record<string, string>> {
    const row = this.row(id), server = this.parse(row);
    if (connectionDigest(server) !== expectedDigest) throw new McpSetupError("conflict");
    if (server.credential.kind !== "managed" || !row.secret) throw new McpSetupError("credentials_required");
    const value: unknown = JSON.parse(await this.vault.decrypt(row.secret, JSON.stringify([id, server.credential.revision])));
    if (!Check(Type.Record(Type.String(), Type.String()), value)) throw new McpSetupError("invalid");
    return value;
  }
}
