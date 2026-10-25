import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpLimits, McpServerConfig } from "./config.js";
import { compileMcpSchema } from "./schema.js";
import type { McpToolIdentity } from "./names.js";

const schemaJson = z.record(z.string(), z.json());
const storedTool = z.strictObject({
  name: z.string().min(1).max(256), description: z.string(),
  inputSchema: schemaJson, outputSchema: schemaJson.optional(),
});
const revisionPayload = z.strictObject({
  adapterVersion: z.union([z.literal(1), z.literal(2)]), serverId: z.string(), configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/), tools: z.array(storedTool),
});
const revisionSchema = revisionPayload.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) });
export type CatalogRevision = z.infer<typeof revisionSchema>;
type StoredTool = z.infer<typeof storedTool>;

export const McpCatalogsDoc = defineDoc<{ revisions: Record<string, CatalogRevision> }>({
  kind: "cs.pi.mcp.catalogs", version: 1, scope: "session", initial: () => ({ revisions: {} }),
});

/** 仅对经边界验证的 JSON 使用，避免对象属性顺序或目录顺序造成假版本。 */
function canonical(value: z.infer<ReturnType<typeof z.json>>): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
export const digest = (value: unknown): string => createHash("sha256").update(canonical(z.json().parse(value))).digest("hex");
export const serverDigest = (server: McpServerConfig): string => digest(server);

export function makeCatalog(server: McpServerConfig, scopeDigest: string, tools: readonly Tool[], limits: McpLimits): {
  revision: CatalogRevision; rejected: number;
} {
  const accepted: StoredTool[] = [];
  let rejected = 0;
  for (const tool of tools) {
    if (!server.tools.allow.includes(tool.name)) continue;
    try {
      const candidate = storedTool.parse({ name: tool.name, description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) });
      compileStoredTool(candidate, limits);
      accepted.push(candidate);
    } catch { rejected++; }
  }
  accepted.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const payload = { adapterVersion: 2 as const, serverId: server.id, configDigest: serverDigest(server), scopeDigest, tools: accepted };
  const revision = { ...payload, digest: digest(payload) };
  if (jsonBytes(revision) > limits.catalogBytes) throw new Error("catalog_too_large");
  return { revision, rejected };
}

export function restoreCatalog(input: unknown, limits: McpLimits): CatalogRevision {
  if (jsonBytes(input) > limits.catalogBytes) throw new Error("catalog_too_large");
  const revision = revisionSchema.parse(input);
  const { digest: expected, ...payload } = revision;
  if (digest(payload) !== expected || revision.tools.length > limits.maxTools ||
    new Set(revision.tools.map(t => t.name)).size !== revision.tools.length) throw new Error("catalog_invalid");
  for (const tool of revision.tools) compileStoredTool(tool, limits);
  return revision;
}

export function compileStoredTool(tool: StoredTool, limits: McpLimits) {
  if (jsonBytes([tool.inputSchema, tool.outputSchema ?? null]) > limits.schemaBytes) throw new Error("schema_too_large");
  return { input: compileMcpSchema(tool.inputSchema, limits),
    output: tool.outputSchema ? compileMcpSchema(tool.outputSchema, limits) : undefined };
}

export function toolNames(revision: CatalogRevision, tool: StoredTool): McpToolIdentity & { extensionName: string; fullDigest: string } {
  const slug = (value: string, length: number) => value.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, length) || "tool";
  const fullDigest = revision.adapterVersion === 1 ? digest([revision.digest, tool]) : toolContract(revision, tool);
  return { serverId: revision.serverId, remoteName: tool.name, catalogDigest: revision.digest, fullDigest,
    nativeName: `mcp_${slug(revision.serverId, 16)}_${slug(tool.name, 24)}_${fullDigest.slice(0, 12)}`,
    extensionName: `cs.mcp.tool.${fullDigest}` };
}

/** 只遍历 schema 节点；同名业务字段及 const/default/enum 内的数据必须保留。 */
function contractSchema(value: z.infer<ReturnType<typeof z.json>>): z.infer<ReturnType<typeof z.json>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const maps = new Set(["properties", "patternProperties", "definitions", "dependencies"]);
  const nodes = new Set(["additionalProperties", "propertyNames", "additionalItems", "contains", "not", "if", "then", "else"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["description", "title", "$comment"].includes(key)).map(([key, child]) => {
    if (maps.has(key) && child !== null && typeof child === "object" && !Array.isArray(child)) {
      return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, contractSchema(schema)]))];
    }
    if (["allOf", "anyOf", "oneOf", "items"].includes(key) && Array.isArray(child)) return [key, child.map(contractSchema)];
    return [key, nodes.has(key) || key === "items" ? contractSchema(child) : child];
  }));
}

export function toolContract(revision: CatalogRevision, tool: StoredTool): string {
  return digest(["mcp-tool-v2", revision.serverId, revision.configDigest, revision.scopeDigest, tool.name,
    contractSchema(tool.inputSchema), tool.outputSchema ? contractSchema(tool.outputSchema) : null]);
}
