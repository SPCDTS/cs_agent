import { isScheduleTool, SCHEDULE_MANAGEMENT_TOOLS, type ScheduleTool, type ScheduleToolPermissions } from "../shared/schedule-tools.js";
import { scheduleDescriptions, scheduleParameters } from "../agent/schedule/tool-schema.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { validateSendArguments } from "../agent/send-service.js";
import { AUTH_TOOLS, type AuthTool, type ImPermissions } from "../agent/grants.js";
import { authDescriptions, authParameters, sendParameters } from "../agent/im-tools.js";
import { qqContextText } from "../context/qq-context-tool.js";

export function createImServer(send: (args: unknown) => Promise<unknown>, opts: {
  permissions?: ImPermissions & Partial<ScheduleToolPermissions>;
  schedule?: (name: ScheduleTool, args: unknown) => Promise<string>;
  auth?: (name: AuthTool, args: unknown) => Promise<unknown>;
} = {}): Server {
  const permissions = opts.permissions ?? { actorIsOwner: false, target: false, auth: false };
  const scheduleTools: readonly ScheduleTool[] = permissions.scheduleControl ? ["schedule_control"]
    : permissions.schedule ? SCHEDULE_MANAGEMENT_TOOLS : [];
  const server = new Server({ name: "im", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "send_message", description: "用户能看到你内容的唯一方式。立即发送消息，默认回复本回合会话，返回 message_id。回合结束前必须至少调用一次把答复发出；直接输出不会送达用户；一条消息说完就不要再发。",
    inputSchema: sendParameters(permissions.target),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, ...(permissions.auth ? AUTH_TOOLS.map(name => ({
    name, description: authDescriptions[name], inputSchema: authParameters[name],
    annotations: { readOnlyHint: name === "auth_list", destructiveHint: name === "auth_revoke", openWorldHint: false },
  })) : []), ...scheduleTools.map(name => ({
    name, description: scheduleDescriptions[name], inputSchema: scheduleParameters[name],
    annotations: { readOnlyHint: name === "schedule_list", destructiveHint: name === "schedule_delete", openWorldHint: false },
  }))] }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    try {
      if (req.params.name === "send_message") {
        const args = validateSendArguments(req.params.arguments);
        if (args.target !== undefined && !permissions.target) throw new Error("本回合未开放 target 参数");
        return qqContextText(JSON.stringify(await send(args)));
      }
      if (AUTH_TOOLS.includes(req.params.name as AuthTool)) {
        if (!permissions.auth || !opts.auth) throw new Error("授权工具仅限 owner 回合");
        return qqContextText(JSON.stringify(await opts.auth(req.params.name as AuthTool, req.params.arguments ?? {})));
      }
      if (isScheduleTool(req.params.name)) {
        if (!scheduleTools.includes(req.params.name) || !opts.schedule) throw new Error("本回合无权使用此定时工具");
        return qqContextText(await opts.schedule(req.params.name, req.params.arguments ?? {}));
      }
      return qqContextText("未知工具：" + req.params.name, true);
    } catch (error) { return qqContextText((error as Error).message, true); }
  });
  return server;
}

/** schema 声明经真实令牌向主进程查询；环境里不接受可伪造的 owner 开关。 */
export async function imViaLoopback(endpoint: "im-info" | AuthTool | ScheduleTool | "send", args: unknown, token: string | undefined, port = 8790): Promise<unknown> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("IM_TOKEN 未配置");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MEDIA_RECALL_PORT 无效");
  const res = await fetch(`http://127.0.0.1:${port}/${endpoint}`, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(args), redirect: "error", signal: AbortSignal.timeout(endpoint === "send" ? 600_000 : 30_000),
  });
  const body = await res.json() as { error?: string };
  if (!res.ok) throw new Error(body?.error ?? "IM 请求失败");
  return body;
}

export async function imPermissions(token: string | undefined, port = 8790): Promise<ImPermissions & Partial<ScheduleToolPermissions>> {
  const result = await imViaLoopback("im-info", {}, token, port) as ImPermissions & Partial<ScheduleToolPermissions>;
  if (!result || typeof result.actorIsOwner !== "boolean" || typeof result.target !== "boolean" || typeof result.auth !== "boolean") throw new Error("IM 权限返回格式错误");
  if (["schedule", "scheduleControl"].some(key => {
    const value = result[key as keyof ScheduleToolPermissions];
    return value !== undefined && typeof value !== "boolean";
  })) throw new Error("IM 定时权限返回格式错误");
  return result;
}

export async function sendViaLoopback(args: unknown, token: string | undefined, port = 8790) {
  const body = await imViaLoopback("send", args, token, port) as { message_id?: string | null; status?: string; note?: string };
  if (!body.message_id && !["sent", "sending", "uncertain", "pending"].includes(body.status ?? "")) throw new Error("发送返回格式错误");
  if (!body.message_id && !body.note) body.note = "消息状态为 " + body.status + "，但缺少 message_id 回执；不要重发。";
  return body;
}
