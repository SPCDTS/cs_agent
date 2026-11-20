import { GrantInput } from "../mcp/policy";
import { Type } from "typebox";
import type { AdminContext, AdminRoute } from "./routes";
import { adminJson as json, HttpError, readAdminBody } from "./http";
import type { McpAdminRpc, McpReadRpc } from "../mcp/contracts";
function scope(ctx: AdminContext) {
 const value = ctx.url.searchParams.get("scope");
 if (value !== "owner" && !/^group:[1-9][0-9]{0,19}$/.test(value ?? "")) throw new Error("mcp_policy:invalid");
 return value!;
}
export function createMcpAdminRoutes(resolve: (ctx: AdminContext, scope: string) => McpAdminRpc, read: (ctx: AdminContext, scope: string) => McpReadRpc): AdminRoute[] {
 const guarded = (handler: AdminRoute["handle"]): AdminRoute["handle"] => async ctx => {
  try { return await handler(ctx); }
  catch (error) {
   if (error instanceof HttpError) return json({ error: "invalid" }, 400);
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
   const target = scope(ctx);
   const schema = Type.Object({ server: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }), expected: Type.String({ minLength: 1, maxLength: 64 }),
    input: GrantInput }, { additionalProperties: false });
   const value = await readAdminBody(ctx.request, schema);
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
