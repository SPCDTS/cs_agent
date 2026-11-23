import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ListToolsResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_CONFIG, parseMcpConfig, publicOrigin, type McpServerConfig } from "./config";
import { CapabilityFiles } from "../shared/capability-files";
import { referencedSecret } from "./config";
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
function validateHeaders(server: McpServerConfig, headers: unknown): asserts headers is Record<string, string> {
  if (
    server.credential.kind !== "managed" ||
    !Check(Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\\r\\n]*$" })), headers) ||
    !Object.keys(headers).length
  )
    throw new McpSetupError("invalid");
  parseMcpConfig({
    version: 1,
    enabled: true,
    servers: [
      {
        ...server,
        transport: {
          ...server.transport,
          secretHeaders: Object.fromEntries(Object.keys(headers).map((name) => [name, "MANAGED_HEADER"]))
        }
      }
    ]
  });
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
  private readonly sql: SqlStorage;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly vault: TokenVault,
    private readonly origin: string,
    private readonly files: CapabilityFiles
  ) {
    this.sql = storage.sql;
  }
  initialize(env: object = {}) {
    this.files.initialize();
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS mcp_servers(id TEXT PRIMARY KEY,config TEXT NOT NULL,revision TEXT NOT NULL,discovered TEXT,secret TEXT)"
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS mcp_server_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    if (!this.sql.exec("SELECT 1 FROM mcp_server_meta WHERE key='initialized'").toArray().length) {
      for (const server of MCP_CONFIG.servers)
        this.sql.exec(
          "INSERT OR IGNORE INTO mcp_servers(id,config,revision) VALUES(?,?,?)",
          server.id,
          JSON.stringify(server),
          crypto.randomUUID()
        );
      this.sql.exec("INSERT INTO mcp_server_meta VALUES('initialized','1')");
    }
    // 旧表只留 CAS 修订与探测结果。成功迁移后清空旧值；缺失或损坏的旧密钥不会阻塞其他能力。
    for (const row of this.sql.exec<Row>("SELECT * FROM mcp_servers WHERE config<>'' OR secret IS NOT NULL")) {
      const server = this.parse(row.config ? row : { config: this.files.text(this.path(row.id)) });
      let headers: string | undefined;
      if (row.secret && server.credential.kind === "managed" && this.vault.configured) {
        try {
          headers = this.vault.legacyValue(row.secret, JSON.stringify([row.id, server.credential.revision]));
        } catch {
          /* 更正主密钥后下次启动再迁移。 */
        }
      }
      if (headers) this.files.put(this.path(row.id, "headers.json"), headers);
      this.files.put(this.path(row.id), JSON.stringify(server));
      this.sql.exec("UPDATE mcp_servers SET config='',secret=? WHERE id=?", headers ? null : row.secret, row.id);
    }
    if (!this.vault.configured) return;
    for (const server of this.config().servers) {
      if (server.credential.kind !== "external-account") continue;
      const entries = Object.entries(server.transport.secretHeaders).map(([name, ref]) => [name, referencedSecret(env, ref)] as const);
      if (!entries.length || entries.some(([, value]) => !value)) continue;
      this.files.put(this.path(server.id, "headers.json"), JSON.stringify(Object.fromEntries(entries)));
      this.files.put(
        this.path(server.id),
        JSON.stringify({
          ...server,
          transport: { ...server.transport, secretHeaders: {} },
          credential: { ...server.credential, kind: "managed" }
        })
      );
    }
  }
  private path(id: string, file = "server.json") {
    return "mcp/" + id + "/" + file;
  }

  private row(id: string, expected?: string): Row {
    const row = this.sql.exec<Row>("SELECT * FROM mcp_servers WHERE id=?", id).toArray()[0];
    if (!row) throw new McpSetupError("not_found");
    if (expected !== undefined && row.revision !== expected) throw new McpSetupError("conflict");
    return { ...row, config: this.files.text(this.path(id)) };
  }
  private parse(row: Pick<Row, "config">): McpServerConfig {
    try { return parseMcpConfig({version:1,enabled:true,servers:[JSON.parse(row.config)]}).servers[0]!; }
    catch { throw new McpSetupError("invalid"); }
  }
  config() { return { ...MCP_CONFIG, servers: this.sql.exec<{id:string}>("SELECT id FROM mcp_servers ORDER BY rowid").toArray().map(({id}) => this.parse({config:this.files.text(this.path(id))})) }; }
  get(id: string) {
    const row = this.row(id), server = this.parse(row);
    return { server, revision: row.revision, credentialSet: !!this.files.stat(this.path(id,"headers.json")) || !!row.secret,
      discovered: row.discovered ? ListToolsResultSchema.parse(JSON.parse(row.discovered)).tools.map(tool => ({ name: tool.name, description: tool.description ?? tool.name, readOnlyHint: tool.annotations?.readOnlyHint === true })) : null };
  }
  list() { return this.config().servers.map(server => this.get(server.id)); }
  current(id: string, digest: string) {
    const row = this.sql.exec("SELECT 1 FROM mcp_servers WHERE id=?",id).toArray()[0];
    if (!row || !MCP_CONFIG.enabled) return false;
    const server = this.parse({config:this.files.text(this.path(id))});
    return server.enabled && serverDigest(server) === digest;
  }
  put(input: ServerSetupInput, expected: string) {
    return this.storage.transactionSync(() => {
      if (!Check(ServerSetup, input)) throw new McpSetupError("invalid");
      const previous = this.sql.exec<Row>("SELECT * FROM mcp_servers WHERE id=?", input.id).toArray()[0];
      if ((previous?.revision ?? "absent") !== expected) throw new McpSetupError("conflict");
      if (!previous && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_servers").one().n >= 64)
        throw new McpSetupError("invalid");
      const revision = crypto.randomUUID(),
        url = setupUrl(input.url);
      const server = parseMcpConfig({
        version: 1,
        enabled: true,
        servers: [
          {
            id: input.id,
            enabled: false,
            transport: { kind: "streamable-http", url, headers: input.headers ?? {} },
            credential:
              input.auth === "none"
                ? { kind: "none" }
                : input.auth === "token"
                  ? { kind: "managed", accountId: "owner-" + input.id, revision }
                  : {
                      kind: "oauth",
                      accountId: "owner-" + input.id,
                      revision,
                      registration: "cimd",
                      clientMetadataUrl: publicOrigin(this.origin) + "/oauth/client-metadata.json",
                      ...(input.scope ? { scope: input.scope } : {})
                    },
            access: { kind: "owner-private", revision },
            tools: { allow: [], readOnly: [], eventAllow: [] },
            replay: "unsafe"
          }
        ]
      }).servers[0]!;
      this.files.remove(this.path(input.id, "headers.json"));
      this.files.remove(this.path(input.id, "oauth.json"));
      this.files.put(this.path(input.id), JSON.stringify(server));
      this.sql.exec(
        "INSERT INTO mcp_servers(id,config,revision) VALUES(?,'',?) ON CONFLICT(id) DO UPDATE SET config='',revision=excluded.revision,secret=NULL,discovered=NULL",
        input.id,
        revision
      );
      this.files.checkQuota();
      return this.get(input.id);
    });
  }

  recordProbe(id: string, expected: string, value: unknown) {
    this.row(id, expected);
    const parsed = ListToolsResultSchema.safeParse(value);
    if (!parsed.success || parsed.data.tools.length > MCP_CONFIG.limits.maxTools || jsonBytes(parsed.data) > MCP_CONFIG.limits.catalogBytes) throw new McpSetupError("invalid");
    this.sql.exec("UPDATE mcp_servers SET discovered=?,revision=? WHERE id=?", JSON.stringify(parsed.data), crypto.randomUUID(), id);
    return this.get(id);
  }
  activate(id: string, expected: string, input: ServerSelectionInput) {
    return this.storage.transactionSync(() => {
      if (!Check(ServerSelection, input)) throw new McpSetupError("invalid");
      const row = this.row(id, expected),
        server = this.parse(row);
      if (!row.discovered) throw new McpSetupError("probe_required");
      const tools: Tool[] = ListToolsResultSchema.parse(JSON.parse(row.discovered)).tools;
      if (
        input.allow.some((name) => !tools.some((tool) => tool.name === name)) ||
        input.readOnly?.some((name) => !input.allow.includes(name))
      )
        throw new McpSetupError("invalid");
      const next = parseMcpConfig({
        version: 1,
        enabled: true,
        servers: [
          {
            ...server,
            enabled: true,
            tools: { allow: input.allow, readOnly: input.readOnly ?? [], eventAllow: [] },
            resourceAllow: input.resourceAllow ?? []
          }
        ]
      }).servers[0]!;
      const accepted = makeCatalog(next, tools, MCP_CONFIG.limits);
      if (accepted.rejected)
        return {
          error: "tools_rejected" as const,
          rejected: accepted.rejected,
          rejectedTools: accepted.rejectedTools,
          message: "部分所选工具的定义不受支持，未修改服务状态或工具选择。请根据 rejectedTools 调整选择后重试，无需重新填写凭据。"
        };
      this.files.put(this.path(id), JSON.stringify(next));
      this.sql.exec("UPDATE mcp_servers SET revision=? WHERE id=?", crypto.randomUUID(), id);
      this.files.checkQuota();
      return this.get(id);
    });
  }
  disable(id: string, expected: string) {
    return this.storage.transactionSync(() => {
      const row = this.row(id, expected);
      this.files.put(this.path(id), JSON.stringify({ ...this.parse(row), enabled: false }));
      this.sql.exec("UPDATE mcp_servers SET revision=? WHERE id=?", crypto.randomUUID(), id);
      this.files.checkQuota();
      return this.get(id);
    });
  }
  remove(id: string, expected: string) {
    return this.storage.transactionSync(() => {
      this.row(id, expected);
      this.files.removeTree("mcp/" + id);
      this.sql.exec("DELETE FROM mcp_servers WHERE id=?", id);
      return { removed: id };
    });
  }
  // 主人从文件系统修改连接时重签授权代次；旧账号的登录态不能随 URL 改写而转移。
  applyDirectory(id: string, previous: McpServerConfig | undefined, changed: Set<string>) {
    const path = this.path(id),
      revision = crypto.randomUUID();
    if (!this.files.stat(path)) {
      if (previous) {
        this.files.remove(this.path(id, "headers.json"));
        this.files.remove(this.path(id, "oauth.json"));
      }
      this.sql.exec("DELETE FROM mcp_servers WHERE id=?", id);
      return;
    }
    const server = this.parse({ config: this.files.text(path) });
    if (server.id !== id || Object.keys(server.transport.secretHeaders).length || server.credential.kind === "external-account")
      throw new McpSetupError("invalid");
    setupUrl(server.transport.url);
    const connectionChanged =
      previous &&
      (previous.transport.url !== server.transport.url || JSON.stringify(previous.credential) !== JSON.stringify(server.credential));
    if (connectionChanged)
      for (const file of ["headers.json", "oauth.json"]) if (!changed.has(file)) this.files.remove(this.path(id, file));
    if ((!previous || changed.has("headers.json")) && this.files.stat(this.path(id, "headers.json"))) {
      const headers: unknown = this.files.json(this.path(id, "headers.json"));
      validateHeaders(server, headers);
    }
    if (!changed.has("server.json") && !changed.has("headers.json") && !changed.has("oauth.json")) return server;
    server.access = { ...server.access, revision };
    if (server.credential.kind !== "none") server.credential = { ...server.credential, revision };
    this.files.put(path, JSON.stringify(server));
    this.sql.exec(
      "INSERT INTO mcp_servers(id,config,revision) VALUES(?,'',?) ON CONFLICT(id) DO UPDATE SET config='',revision=excluded.revision,discovered=NULL,secret=NULL",
      id,
      revision
    );
    return server;
  }
  async credentialPut(id: string, expected: string, headers: unknown) {
    return this.storage.transactionSync(() => {
      const row = this.row(id, expected),
        server = this.parse(row);
      validateHeaders(server, headers);
      const revision = crypto.randomUUID(),
        credential = { ...server.credential, revision };
      this.files.put(this.path(id, "headers.json"), JSON.stringify(headers));
      this.files.put(this.path(id), JSON.stringify({ ...server, credential, access: { ...server.access, revision }, enabled: false }));
      this.sql.exec("UPDATE mcp_servers SET secret=NULL,config='',revision=?,discovered=NULL WHERE id=?", revision, id);
      this.files.checkQuota();
      return this.get(id);
    });
  }

  async credentialHeaders(id: string, expectedDigest: string): Promise<Record<string, string>> {
    const row = this.row(id), server = this.parse(row);
    if (connectionDigest(server) !== expectedDigest) throw new McpSetupError("conflict");
    if (server.credential.kind !== "managed" || !this.files.stat(this.path(id,"headers.json"))) throw new McpSetupError("credentials_required");
    const value: unknown = this.files.json(this.path(id,"headers.json"));
    if (!Check(Type.Record(Type.String(), Type.String()), value)) throw new McpSetupError("invalid");
    return value;
  }
}
