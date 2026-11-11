import { Type } from "typebox";
import { Check } from "typebox/value";
import type { AdminContext, AdminRoute } from "./routes";
import type { McpGrant, McpGrantInput, McpApproval } from "../mcp/policy";
export type McpReviewResult = {status:string;result?:{isError?:boolean;output:({type:"text";text:string}|{type:"image";data:string;mimeType:string})[]}};
export interface McpAdminRpc {
 mcpAccess(scope: string, server: string): Promise<McpGrant | null>;
 mcpSetAccess(scope: string, server: string, input: McpGrantInput, expected: string): Promise<McpGrant>;
 mcpApprovals(scope: string): Promise<McpApproval[]>;
 mcpReviewApproval(scope: string, id: string, decision: "approve" | "reject"): Promise<McpReviewResult>;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
function scope(ctx: AdminContext) {
 const value = ctx.url.searchParams.get("scope");
 if (value !== "owner" && !/^group:[1-9][0-9]{0,19}$/.test(value ?? "")) throw new Error("mcp_policy:invalid");
 return value!;
}
export function createMcpAdminRoutes(resolve: (ctx: AdminContext, scope: string) => McpAdminRpc, read: (ctx: AdminContext, scope: string) => Pick<McpAdminRpc, "mcpAccess" | "mcpApprovals"> = resolve): AdminRoute[] {
 const guarded = (handler: AdminRoute["handle"]): AdminRoute["handle"] => async ctx => {
  try { return await handler(ctx); }
  catch (error) {
   const code = error instanceof Error ? /^mcp_policy:(invalid|not_found|conflict|denied)$/.exec(error.message)?.[1] : undefined;
   if (code) return json({ error: code }, code === "conflict" ? 409 : code === "not_found" ? 404 : code === "denied" ? 403 : 400);
   throw error;
  }
 };
 return [
  { method: "GET", path: "/admin/mcp/access", handle: guarded(async ctx => {
   const target = scope(ctx), server = ctx.url.searchParams.get("server") ?? "";
   if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(server)) throw new Error("mcp_policy:invalid");
   return json({ grant: await read(ctx, target).mcpAccess(target, server) });
  }) },
  { method: "PUT", path: "/admin/mcp/access", handle: guarded(async ctx => {
   const target = scope(ctx); let value: unknown;
   try { value = await ctx.request.json(); } catch { throw new Error("mcp_policy:invalid"); }
   const schema = Type.Object({ server: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }), expected: Type.String({ minLength: 1, maxLength: 64 }),
    input: Type.Object({ tools: Type.Array(Type.String()), resourceAllow: Type.Array(Type.String()), actors: Type.Array(Type.String()), expiresAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]) }, { additionalProperties: false }) }, { additionalProperties: false });
   if (!Check(schema, value)) throw new Error("mcp_policy:invalid");
   return json(await resolve(ctx, target).mcpSetAccess(target, value.server, value.input, value.expected));
  }) },
  { method: "GET", path: "/admin/mcp/approvals", handle: guarded(async ctx => {
   const target = scope(ctx); return json({ approvals: await read(ctx, target).mcpApprovals(target) });
  }) },
  { method: "POST", path: /^\/admin\/mcp\/approvals\/(?<id>[a-f0-9]{64})\/(?<decision>approve|reject)$/, handle: guarded(async ctx => {
   const target = scope(ctx); return json(await resolve(ctx, target).mcpReviewApproval(target, ctx.params.id!, ctx.params.decision === "approve" ? "approve" : "reject"));
  }) },
 ];
}
