import { Type } from "typebox";
import { Check } from "typebox/value";
import type { AdminRoute } from "./routes";
import { McpManageInput, manageMcp, mcpChange, setupFailure } from "../mcp/manage";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export const MCP_SERVER_ROUTES: AdminRoute[] = [
  { method: "GET", path: "/admin/mcp/servers", handle: async ({ env }) => json({ servers: await env.REGISTRY.getByName("main").mcpServersList() }) },
  { method: "POST", path: "/admin/mcp/manage", handle: async ({ env, request }) => {
    try {
      const input: unknown = await request.json();
      if (!Check(McpManageInput, input)) return json({ error: "invalid" }, 400);
      const result = await manageMcp(env, input);
      const change = mcpChange(input);
      if (change) await env.THREAD.getByName("owner").recordMcpChange(change);
      if (input.action === "activate") await env.THREAD.getByName("owner").refreshMcp();
      return json(result);
    } catch (error) { const code = setupFailure(error); return json({ error: code }, code === "conflict" ? 409 : 400); }
  } },
  { method: "PUT", path: /^\/admin\/mcp\/servers\/(?<id>[A-Za-z][A-Za-z0-9_-]{0,63})\/credentials$/, handle: async ({ env, request, params }) => {
    try {
      const input: unknown = await request.json();
      if (!Check(Type.Object({ expectedRevision: Type.String({ minLength: 1, maxLength: 64 }), headers: Type.Record(Type.String(), Type.String()) }, { additionalProperties: false }), input)) return json({ error: "invalid" }, 400);
      const result = await env.REGISTRY.getByName("main").mcpCredentialPut(params.id!, input.expectedRevision, input.headers);
      await env.THREAD.getByName("owner").recordMcpChange({ action: "credentials", server: params.id! });
      return json(result);
    } catch (error) { const code = setupFailure(error); return json({ error: code }, code === "conflict" ? 409 : 400); }
  } },
];
