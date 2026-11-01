import { createHash } from "node:crypto";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { McpServerConfig } from "./config";
import type { CatalogTool } from "./catalog";
export type CatalogIdentity = { serverId: string; configDigest: string; scopeDigest: string; digest: string };
export type McpToolIdentity = { serverId: string; remoteName: string; nativeName: string; catalogDigest: string };
/** 仅对经边界验证的 JSON 使用，避免对象属性顺序或目录顺序造成假版本。 */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
export const digest = (value: unknown): string => createHash("sha256").update(canonical(copyJson(value))).digest("hex");
export const serverDigest = (server: McpServerConfig): string => digest(server);
export const connectionDigest = (server: McpServerConfig): string => digest([server.id, server.transport, server.credential]);

export const slug = (value: string, length: number) => value.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, length) || "tool";

export function toolNames(revision: CatalogIdentity, tool: CatalogTool): McpToolIdentity & { extensionName: string; fullDigest: string } {
  const fullDigest = toolContract(revision, tool);
  return { serverId: revision.serverId, remoteName: tool.name, catalogDigest: revision.digest, fullDigest,
    nativeName: `mcp_${slug(revision.serverId, 16)}_${slug(tool.name, 24)}_${fullDigest.slice(0, 12)}`,
    extensionName: `cs.mcp.tool.${fullDigest}` };
}

/** 只遍历 schema 节点；同名业务字段及 const/default/enum 内的数据必须保留。 */
function contractSchema(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const maps = new Set(["properties", "patternProperties", "definitions", "$defs", "dependencies"]);
  const nodes = new Set(["additionalProperties", "propertyNames", "additionalItems", "contains", "not", "if", "then", "else"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["description", "title", "$comment", "$schema"].includes(key)).map(([key, child]) => {
    if (maps.has(key) && child !== null && typeof child === "object" && !Array.isArray(child)) {
      return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, contractSchema(schema)]))];
    }
    if (["allOf", "anyOf", "oneOf", "items"].includes(key) && Array.isArray(child)) return [key, child.map(contractSchema)];
    return [key, nodes.has(key) || key === "items" ? contractSchema(child) : child];
  }));
}

export function toolContract(revision: CatalogIdentity, tool: CatalogTool): string {
  return digest(["mcp-tool-v2", revision.serverId, revision.configDigest, revision.scopeDigest, tool.name,
    contractSchema(tool.inputSchema), tool.outputSchema ? contractSchema(tool.outputSchema) : null]);
}
