import { Type, type Static } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Env } from "../env";
import { MCP_CONFIG, isOAuthServer } from "./config";
import { ServerId, ServerSetup, ServerSelection, McpSetupError } from "./servers";
import { McpConnection, safeError } from "./connection";
import { discover } from "./oauth";
import { oauthErrorCode } from "./oauth-fetch";

const strict = { additionalProperties: false }, id = { id: ServerId }, expected = { ...id, expectedRevision: Type.String({ minLength: 1, maxLength: 64 }) };
export const McpManageInput = Type.Union([
  Type.Object({ action: Type.Literal("list") }, strict),
  Type.Object({ action: Type.Literal("get"), ...id }, strict),
  Type.Object({ action: Type.Literal("put"), expectedRevision: expected.expectedRevision, server: ServerSetup }, strict),
  Type.Object({ action: Type.Literal("probe"), ...expected }, strict),
  Type.Object({ action: Type.Literal("activate"), ...expected, selection: ServerSelection }, strict),
  Type.Object({ action: Type.Literal("disable"), ...expected }, strict),
  Type.Object({ action: Type.Literal("remove"), ...expected }, strict),
  Type.Object({ action: Type.Literal("login"), ...id }, strict),
]);
export type McpManageRequest = Static<typeof McpManageInput>;
export type McpChange = { action: "put" | "activate" | "disable" | "remove" | "credentials"; server: string };
export function mcpChange(input: McpManageRequest): McpChange | undefined {
  if (input.action === "put") return { action: input.action, server: input.server.id };
  if (input.action === "activate" || input.action === "disable" || input.action === "remove") return { action: input.action, server: input.id };
}
export const setupFailure = (error: unknown) => error instanceof McpSetupError ? error.code :
  error instanceof Error && /^mcp_setup:(invalid|not_found|conflict|probe_required|credentials_required)$/.test(error.message) ? error.message.slice(10) : "connection_failed";

export async function manageMcp(env: Env, input: McpManageRequest) {
  const registry = env.REGISTRY.getByName("main");
  switch (input.action) {
    case "list": return { servers: await registry.mcpServersList() };
    case "get": return registry.mcpServerGet(input.id);
    case "put": return registry.mcpServerPut(input.server, input.expectedRevision);
    case "activate": return registry.mcpServerActivate(input.id, input.expectedRevision, input.selection);
    case "disable": return registry.mcpServerDisable(input.id, input.expectedRevision);
    case "remove": return registry.mcpServerRemove(input.id, input.expectedRevision);
    case "login": {
      const { server } = await registry.mcpServerGet(input.id);
      if (!isOAuthServer(server)) return { status: "credentials_required", url: env.PUBLIC_ORIGIN + "/admin/#mcp-server=" + encodeURIComponent(input.id) };
      // 先验证现有客户端支持的授权机制；专用应用注册由服务提供方和用户完成。
      try { await discover(server); }
      catch (error) { return oauthErrorCode(error) === "oauth_network"
        ? { status: "unavailable", message: "暂时无法读取 OAuth 元数据，请检查服务连接后重试。" }
        : { status: "oauth_not_supported", message: "未发现当前客户端支持的 OAuth 元数据。请核对服务地址；需要额外客户端注册的服务可改用 Token。" }; }
      return { status: "login_required", ...await registry.loginLink(input.id) };
    }
    case "probe": {
      const record = await registry.mcpServerGet(input.id);
      if (record.revision !== input.expectedRevision) throw new McpSetupError("conflict");
      let connection: McpConnection | undefined;
      try {
        connection = await McpConnection.open(record.server, env, MCP_CONFIG.limits, AbortSignal.timeout(MCP_CONFIG.limits.connectMs), () => {});
        const tools = await connection.listTools(AbortSignal.timeout(MCP_CONFIG.limits.connectMs));
        return { status: "ready", ...await registry.mcpServerProbe(input.id, input.expectedRevision, { tools }) };
      } catch (error) {
        const setup = setupFailure(error);
        if (setup === "conflict") throw new McpSetupError("conflict");
        const code = setup === "credentials_required" ? setup : safeError(error).code;
        return { status: "unavailable", code, next: record.server.credential.kind === "oauth" ? "login" : "credentials",
          credentialsUrl: env.PUBLIC_ORIGIN + "/admin/#mcp-server=" + encodeURIComponent(input.id),
          message: "连接未完成。检查服务地址与认证方式；Token 在管理页填写，OAuth 使用 login。登录或保存凭据后重新 get、probe、activate。" };
      } finally { await connection?.close(); }
    }
  }
}

export function createMcpManagementExtension(env: Env, allowed: (api: ToolExecutionApi, context: Context) => Promise<boolean>,
  changed: (refresh: boolean) => Promise<void>, record: (change: McpChange) => Promise<unknown>) {
  return defineExtension({ name: "cs.mcp.management", tools: [defineTool({ name: "mcp_manage", replay: "unsafe", callers: ["model"], parameters: Type.Object({ request: McpManageInput }, strict),
    description: "管理运行时 HTTP MCP 服务（仅限主人本人回合）。流程：list/get 取最新 revision -> put 登记地址与认证方式（新服务 expectedRevision=absent；修改已有服务会清空旧凭据与工具选择）-> Token 由主人在管理页填写（勿在聊天索要），OAuth 用 login 取链接 -> probe 拉取目录 -> activate 选择工具（遇 tools_rejected 按 rejectedTools 调整重试）。每次变更后换用返回的新 revision；远端描述与 readOnlyHint 不可信，不确定时 readOnly 留空；新服务不自动对群或事件开放。",
    execute: async ({ request: input }, api, context) => {
      if (!await allowed(api, context)) return { isError: true, output: [{ type: "text", text: "只有主人本人私聊或经过验证的网页回合可以管理 MCP 服务。" }] };
      try {
        const result = await manageMcp(env, input);
        if ("error" in result) return { isError: true, output: [{ type: "text", text: JSON.stringify(result) }] };
        const change = mcpChange(input);
        if (change) { await record(change); await changed(input.action === "activate"); }
        return { output: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) { return { isError: true, output: [{ type: "text", text: setupFailure(error) }] }; }
    } })] });
}
