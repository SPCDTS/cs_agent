import type { TurnKind } from "../policy";
import type { Catalog } from "./catalog";
import { makeCatalog } from "./catalog";
import { MCP_CONFIG } from "./config";
import { Type } from "typebox";
import { Check } from "typebox/value";
export type McpAuthority = {
  kind: TurnKind; scope: string; actor: string; owner: boolean; generation: number; replyChannel: "web" | "qq";
  subagentId?: string;
};
export type McpCapabilitySnapshot = {
  scope: string; actor: string; generation: number; replyChannel: "web" | "qq"; catalogJson: string; tools: string[]; resourceAllow?: { server: string; prefixes: string[] }[];
};
export type McpAuthorization = TurnKind | McpAuthority | undefined;
/** 旧 owner-private 回调继续有效；群授权与审批必须由宿主传完整身份。 */
export function mcpAuthority(value: McpAuthorization): McpAuthority | undefined {
  return typeof value === "string" ? { kind: value, scope: "owner", actor: "owner", owner: true, generation: 0, replyChannel: "qq" } : value;
}
export function sameMcpOrigin(authority: McpAuthority, snapshot: McpCapabilitySnapshot): boolean {
  return authority.scope === snapshot.scope && authority.actor === snapshot.actor && authority.generation === snapshot.generation
    && authority.replyChannel === snapshot.replyChannel;
}

/** RPC 只传有界 JSON 字符串，避免递归 JsonObject 让 DO RPC 类型与快照成本膨胀。 */
export function snapshotCatalogs(snapshot: McpCapabilitySnapshot): Catalog[] {
  if (Buffer.byteLength(snapshot.catalogJson) > MCP_CONFIG.limits.catalogBytes) throw new Error("catalog_limit");
  const value: unknown = JSON.parse(snapshot.catalogJson);
  const tool = Type.Object({ name: Type.String(), description: Type.String(), inputSchema: Type.Record(Type.String(), Type.Unknown()),
    outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
  const schema = Type.Array(Type.Object({ serverId: Type.String(), configDigest: Type.String(), scopeDigest: Type.String(), digest: Type.String(), tools: Type.Array(tool) }));
  if (!Check(schema, value)) throw new Error("catalog_invalid");
  return value.map(catalog => {
    const server = MCP_CONFIG.servers.find(s => s.id === catalog.serverId);
    if (!server) throw new Error("catalog_invalid");
    const validated = makeCatalog(server, catalog.tools.map(t => ({ name: t.name, description: t.description,
      inputSchema: { ...t.inputSchema, type: "object" }, ...(t.outputSchema ? { outputSchema: { ...t.outputSchema, type: "object" } } : {}) })), MCP_CONFIG.limits).revision;
    return { ...catalog, tools: validated.tools };
  });
}
