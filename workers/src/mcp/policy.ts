import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { MCP_CONFIG, type McpConfig, type McpServerConfig } from "./config";
import type { McpAuthority } from "./access";
import { digest } from "./names";
import { mcpFailure } from "./result";

export const MCP_POLICY_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_access(scope TEXT NOT NULL,server_id TEXT NOT NULL,value_json TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(scope,server_id));
CREATE TABLE IF NOT EXISTS mcp_approvals(
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,actor TEXT NOT NULL,generation INTEGER NOT NULL,reply_channel TEXT NOT NULL,
 server_id TEXT NOT NULL,tool_name TEXT NOT NULL,contract TEXT NOT NULL,args_json TEXT NOT NULL,authority_json TEXT NOT NULL,
 operation_id TEXT NOT NULL,payload_digest TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,
 created_at INTEGER NOT NULL,decided_by TEXT,decided_at INTEGER,result_json TEXT);
CREATE INDEX IF NOT EXISTS mcp_approvals_scope ON mcp_approvals(scope,created_at);
CREATE TABLE IF NOT EXISTS mcp_invocations(id TEXT PRIMARY KEY,payload_digest TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,approval_id TEXT);
`;
export type McpGrant = { scope: string; server: string; tools: string[]; resourceAllow: string[]; actors: string[]; expiresAt: number | null; revision: string };
export type McpGrantInput = Omit<McpGrant, "scope" | "server" | "revision">;
export type McpApproval = {
 id: string; scope: string; actor: string; generation: number; reply_channel: "web" | "qq"; server_id: string;
 tool_name: string; contract: string; args_json: string; authority_json: string; operation_id: string; payload_digest: string;
 expires_at: number; status: "pending" | "approved" | "executing" | "succeeded" | "rejected" | "expired" | "unknown";
 created_at: number; decided_by: string | null; decided_at: number | null; result_json: string | null;
};
export type McpCallClaim = { authority: McpAuthority; server: string; name: string; contract: string; args: unknown; operationId: string };
type Claim = { kind: "execute"; id: string } | { kind: "result"; result: ToolExecutionResult } | { kind: "pending"; approval: McpApproval };
export class McpPolicyError extends Error {
 constructor(readonly code: "invalid" | "not_found" | "conflict" | "denied") { super(`mcp_policy:${code}`); }
}
const GrantInput = Type.Object({ tools: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 200, uniqueItems: true }),
 resourceAllow: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 100, uniqueItems: true }),
 actors: Type.Array(Type.String({ pattern: "^(?:[1-9][0-9]{0,19}|admin:web|\\*)$" }), { minItems: 1, maxItems: 100, uniqueItems: true }),
 expiresAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) }, { additionalProperties: false });
const Result = Type.Object({ isError: Type.Optional(Type.Boolean()), output: Type.Optional(Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() }))) });
function parseResult(raw: string): ToolExecutionResult {
 const value: unknown = JSON.parse(raw);
 if (!Check(Result, value)) throw new McpPolicyError("invalid");
 return value;
}
const receipt = (result: ToolExecutionResult) => JSON.stringify({ ...(result.isError ? { isError: true } : {}), output: (result.output ?? []).map(content =>
 content.type === "text" ? content : { type: "text", text: "[原调用的图片保留在原结果中；回执不重复保存图片数据]" }) });

/** 三张本线程表：不增加 DO，目录缓存与 OAuth 仍沿用现有所有者。 */
export class McpPolicyStore {
 private ready?: Promise<void>;
 constructor(readonly db: SqliteDatabase, private readonly config: McpConfig = MCP_CONFIG, private readonly now = Date.now) {}
 initialize() {
  return this.ready ??= (async () => {
   await this.db.exec(MCP_POLICY_SCHEMA);
  })();
 }
 async recoverInterrupted() {
  await this.initialize();
  await this.db.run("UPDATE mcp_invocations SET status='unknown' WHERE status='executing'");
  await this.db.run("UPDATE mcp_approvals SET status='unknown' WHERE status='executing'");
 }
 async grant(scope: string, server: string): Promise<McpGrant | undefined> {
  await this.initialize();
  const row = await this.db.get<{ value_json: string }>("SELECT value_json FROM mcp_access WHERE scope=? AND server_id=?", scope, server);
  if (!row) return;
  const value: unknown = JSON.parse(row.value_json);
  const schema = Type.Object({ ...GrantInput.properties, scope: Type.Literal(scope), server: Type.Literal(server), revision: Type.String() });
  if (!Check(schema, value)) throw new McpPolicyError("invalid");
  return value;
 }
 async setGrant(scope: string, serverId: string, input: unknown, expected: string) {
  await this.initialize();
  const server = this.config.servers.find(s => s.enabled && s.id === serverId);
  if (!/^group:[1-9][0-9]{0,19}$/.test(scope) || !server || !Check(GrantInput, input)
    || input.tools.some(name => !server.tools.allow.includes(name))
    || input.resourceAllow.some(prefix => !server.resourceAllow.some(allowed => prefix.startsWith(allowed)))) throw new McpPolicyError("invalid");
  return this.db.transaction(async tx => {
   const previous = await tx.get<{ revision: string }>("SELECT revision FROM mcp_access WHERE scope=? AND server_id=?", scope, serverId);
   if ((previous?.revision ?? "none") !== expected) throw new McpPolicyError("conflict");
   const payload = { scope, server: serverId, tools: [...input.tools].sort(), resourceAllow: [...input.resourceAllow].sort(), actors: [...input.actors].sort(), expiresAt: input.expiresAt };
   const grant = { ...payload, revision: digest(payload).slice(0, 16) };
   await tx.run("UPDATE mcp_approvals SET status='rejected',decided_by='grant_changed',decided_at=? WHERE scope=? AND server_id=? AND status IN ('pending','approved')", this.now(), scope, serverId);
   await tx.run("INSERT INTO mcp_access(scope,server_id,value_json,revision) VALUES (?,?,?,?) ON CONFLICT(scope,server_id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision",
    scope, serverId, JSON.stringify(grant), grant.revision);
   return grant;
  });
 }
 async allows(authority: McpAuthority, server: McpServerConfig, tool?: string, uri?: string) {
  if (authority.scope === "owner") return authority.owner && (authority.kind !== "event" || tool !== undefined && server.tools.eventAllow.includes(tool));
  if (authority.kind === "event" || !authority.scope.startsWith("group:")) return false;
  const grant = await this.grant(authority.scope, server.id);
  return !!grant && (grant.expiresAt === null || grant.expiresAt > this.now()) && (grant.actors.includes("*") || grant.actors.includes(authority.actor))
   && (tool !== undefined ? grant.tools.includes(tool) : uri !== undefined ? grant.resourceAllow.some(prefix => uri.startsWith(prefix)) : grant.resourceAllow.length > 0);
 }
 async resourcePrefixes(authority: McpAuthority, server: McpServerConfig): Promise<string[]> {
  if (authority.scope === "owner") return authority.owner && authority.kind !== "event" ? server.resourceAllow : [];
  if (authority.kind === "event" || !authority.scope.startsWith("group:")) return [];
  const grant = await this.grant(authority.scope, server.id);
  return grant && (grant.expiresAt === null || grant.expiresAt > this.now()) && (grant.actors.includes("*") || grant.actors.includes(authority.actor))
    ? grant.resourceAllow.filter(prefix => server.resourceAllow.some(global => prefix.startsWith(global))) : [];
 }
 async list(scope: string) {
  await this.initialize();
  await this.db.run("UPDATE mcp_approvals SET status='expired' WHERE scope=? AND status IN ('pending','approved') AND expires_at<=?", scope, this.now());
  return this.db.all<McpApproval>("SELECT * FROM mcp_approvals WHERE scope=? ORDER BY created_at DESC LIMIT 100", scope);
 }
 async approval(id: string, scope: string) {
  await this.initialize();
  const row = await this.db.get<McpApproval>("SELECT * FROM mcp_approvals WHERE id=? AND scope=?", id, scope);
  if (!row) throw new McpPolicyError("not_found");
  return row;
 }
 private identity(call: McpCallClaim) {
  const a = call.authority;
  if (!call.operationId || call.operationId.length > 256) throw new McpPolicyError("invalid");
  return { id: digest(["mcp-operation", a.scope, a.actor, a.generation, a.replyChannel, a.subagentId ?? null, call.operationId]),
   payload: digest([a.scope, a.actor, a.generation, a.replyChannel, a.subagentId ?? null, call.server, call.name, call.contract, call.args]) };
 }
 async claim(call: McpCallClaim, approvalRequired: boolean): Promise<Claim> {
  await this.initialize();
  const { id, payload } = this.identity(call), now = this.now(), a = call.authority;
  return this.db.transaction(async tx => {
   const invocation = await tx.get<{ payload_digest: string; status: string; result_json: string | null }>("SELECT * FROM mcp_invocations WHERE id=?", id);
   if (invocation) {
    if (invocation.payload_digest !== payload) throw new McpPolicyError("conflict");
    return { kind: "result", result: invocation.status === "succeeded" && invocation.result_json ? parseResult(invocation.result_json) : mcpFailure("outcome_unknown") };
   }
   let approval = await tx.get<McpApproval>("SELECT * FROM mcp_approvals WHERE id=?", id);
   if (approval && approval.payload_digest !== payload) throw new McpPolicyError("conflict");
   if (approvalRequired && !approval) {
    approval = await tx.get<McpApproval>(`INSERT INTO mcp_approvals(id,scope,actor,generation,reply_channel,server_id,tool_name,contract,args_json,authority_json,
      operation_id,payload_digest,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?) RETURNING *`,
      id, a.scope, a.actor, a.generation, a.replyChannel, call.server, call.name, call.contract, JSON.stringify(call.args), JSON.stringify(a), call.operationId, payload, now + 10 * 60_000, now);
    if (!approval) throw new McpPolicyError("invalid");
   }
   if (approval) {
    if (approval.expires_at <= now && ["pending", "approved"].includes(approval.status)) {
     await tx.run("UPDATE mcp_approvals SET status='expired' WHERE id=?", id); return { kind: "result", result: mcpFailure("approval_expired") };
    }
    if (approval.status === "pending") return { kind: "pending", approval };
    if (approval.status !== "approved") return { kind: "result", result: mcpFailure(approval.status === "unknown" ? "outcome_unknown" : "approval_" + approval.status) };
    await tx.run("UPDATE mcp_approvals SET status='executing' WHERE id=?", id);
   }
   await tx.run("INSERT INTO mcp_invocations(id,payload_digest,status,approval_id) VALUES (?,?,'executing',?)", id, payload, approval?.id ?? null);
   return { kind: "execute", id };
  });
 }
 async finish(id: string, result: ToolExecutionResult, unknown = false) {
  await this.initialize();
  const state = unknown ? "unknown" : "succeeded", json = unknown ? null : receipt(result);
  await this.db.transaction(async tx => {
   await tx.run("UPDATE mcp_invocations SET status=?,result_json=? WHERE id=?", state, json, id);
   await tx.run("UPDATE mcp_approvals SET status=?,result_json=? WHERE id=?", state, json, id);
  });
 }
 async decide(scope: string, id: string, decision: "approve" | "reject", reviewer: McpAuthority) {
  if (!reviewer.owner || reviewer.kind === "event" || reviewer.kind === "subagent" || reviewer.subagentId) throw new McpPolicyError("denied");
  await this.initialize();
  return this.db.transaction(async tx => {
   const row = await tx.get<McpApproval>("SELECT * FROM mcp_approvals WHERE id=? AND scope=?", id, scope);
   if (!row) throw new McpPolicyError("not_found");
   if (row.status !== "pending" || row.expires_at <= this.now()) throw new McpPolicyError("conflict");
   await tx.run("UPDATE mcp_approvals SET status=?,decided_by=?,decided_at=? WHERE id=?", decision === "approve" ? "approved" : "rejected", reviewer.actor, this.now(), id);
   return { ...row, status: decision === "approve" ? "approved" as const : "rejected" as const };
  });
 }
}
