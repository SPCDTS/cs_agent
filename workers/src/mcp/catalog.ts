import { copyJson } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpLimits, McpServerConfig } from "./config";
import { compileMcpSchema, McpSchemaError } from "./schema";
import { digest, jsonBytes, serverDigest, toolNames, type CatalogIdentity } from "./names";

export const MCP_CATALOG_SCHEMA = `CREATE TABLE IF NOT EXISTS mcp_catalog (
  server_id TEXT NOT NULL, tool_name TEXT NOT NULL, remote_name TEXT NOT NULL,
  schema_json TEXT NOT NULL, digest TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(server_id, tool_name));`;
export type CatalogTool = { name: string; description: string; inputSchema: JsonObject; outputSchema?: JsonObject };
export type Catalog = CatalogIdentity & { tools: CatalogTool[] };
const Stored = Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }), description: Type.String(),
  inputSchema: Type.Record(Type.String(), Type.Unknown()), outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false });
const ownerScope = digest(["owner-private", "owner"]);
function ownedSchema(value: unknown, limits: McpLimits): JsonObject {
  const schema = copyJson(compileMcpSchema(value, limits).schema);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new McpSchemaError("schema_invalid");
  return schema;
}
export function validateTool(value: unknown, limits: McpLimits): CatalogTool {
  if (!Check(Stored, value)) throw new McpSchemaError("schema_invalid");
  if (jsonBytes([value.inputSchema, value.outputSchema ?? null]) > limits.schemaBytes) throw new McpSchemaError("schema_limit");
  return { name: value.name, description: value.description, inputSchema: ownedSchema(value.inputSchema, limits),
    ...(value.outputSchema ? { outputSchema: ownedSchema(value.outputSchema, limits) } : {}) };
}
function catalog(server: McpServerConfig, tools: CatalogTool[]): Catalog {
  const payload = { serverId: server.id, configDigest: serverDigest(server), scopeDigest: ownerScope, tools };
  return { ...payload, digest: digest(payload) };
}
export function makeCatalog(server: McpServerConfig, tools: readonly Tool[], limits: McpLimits) {
  const accepted: CatalogTool[] = [], rejectedTools: { name: string; reason: McpSchemaError["reason"] }[] = [];
  let rejected = 0;
  for (const tool of tools) {
    if (!server.tools.allow.includes(tool.name)) continue;
    try { accepted.push(validateTool({ name: tool.name, description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }, limits)); }
    catch (error) {
      rejected++;
      if (rejectedTools.length < 20) rejectedTools.push({ name: tool.name.slice(0, 128), reason: error instanceof McpSchemaError ? error.reason : "schema_invalid" });
    }
  }
  accepted.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const revision = catalog(server, accepted);
  if (jsonBytes(revision) > limits.catalogBytes || accepted.length > limits.visibleTools || jsonBytes(accepted.map(t => [t.inputSchema, t.outputSchema ?? null])) > limits.visibleSchemaBytes) throw new Error("catalog_limit");
  const names = accepted.map(tool => toolNames(revision, tool).nativeName);
  if (new Set(names).size !== names.length) throw new Error("catalog_collision");
  return { revision, rejected, rejectedTools };
}

export async function saveCatalog(db: SqliteDatabase, revision: Catalog): Promise<void> {
  // 整个分页目录在一个事务替换；离线或半截响应不会覆盖最后一份可恢复快照。
  await db.transaction(async tx => {
    await tx.run("DELETE FROM mcp_catalog WHERE server_id=?", revision.serverId);
    for (const tool of revision.tools) await tx.run("INSERT INTO mcp_catalog VALUES (?,?,?,?,?,?)", revision.serverId,
      toolNames(revision, tool).nativeName, tool.name, JSON.stringify({ tool, configDigest: revision.configDigest }), revision.digest, Date.now());
  });
}
export async function restoreCatalog(db: SqliteDatabase, server: McpServerConfig, limits: McpLimits): Promise<Catalog | undefined> {
  const rows = await db.all<{ tool_name: string; remote_name: string; schema_json: string; digest: string }>("SELECT * FROM mcp_catalog WHERE server_id=? ORDER BY remote_name", server.id);
  if (!rows.length) return;
  if (rows.length > limits.visibleTools || jsonBytes(rows) > limits.catalogBytes) throw new Error("catalog_limit");
  const tools: CatalogTool[] = [];
  for (const row of rows) {
    const stored: unknown = JSON.parse(row.schema_json);
    if (!Check(Type.Object({ tool: Type.Unknown(), configDigest: Type.Literal(serverDigest(server)) }, { additionalProperties: false }), stored)) throw new Error("catalog_invalid");
    const tool = validateTool(stored.tool, limits);
    if (tool.name !== row.remote_name || !server.tools.allow.includes(tool.name)) throw new Error("catalog_invalid");
    tools.push(tool);
  }
  const revision = catalog(server, tools);
  if (rows.some((row, i) => row.digest !== revision.digest || row.tool_name !== toolNames(revision, tools[i]).nativeName)) throw new Error("catalog_invalid");
  return revision;
}
