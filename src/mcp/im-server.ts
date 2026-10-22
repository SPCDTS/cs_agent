import { isScheduleTool, SCHEDULE_TOOLS, type ScheduleTool } from "../shared/schedule-tools.js";
import { scheduleDescriptions, scheduleParameters } from "../agent/schedule/tool-schema.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { validateSendArguments } from "../agent/send-service.js";
import { AUTH_TOOLS, type AuthTool } from "../agent/grants.js";
import { authDescriptions, authParameters, sendParameters } from "../agent/im-tools.js";
import { qqContextText } from "../context/qq-context-tool.js";
import type { CallMeta } from "../context/media-recall-server.js";
import { callMetaOf, loopbackJson, loopbackPost } from "./media-recall-client.js";

/**
 * im MCP 服务（设计 §5.3、§7）：每个会话线程一个进程，跨回合复用，所以工具清单固定为全集；
 * 每次调用连同 _meta（callId、回合元数据）交给主进程，由它按会话当前回合的身份校验 target、授权与定时权限。
 */
export interface ImHandlers {
  send(args: unknown, meta: CallMeta): Promise<unknown>;
  auth(name: AuthTool, args: unknown, meta: CallMeta): Promise<unknown>;
  schedule(name: ScheduleTool, args: unknown, meta: CallMeta): Promise<string>;
}

export function createImServer(handlers: ImHandlers): Server {
  const server = new Server({ name: "im", version: "2.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "send_message", description: "用户能看到你内容的唯一方式：立即发送消息，默认发往本会话，返回 message_id。target 须有授权。",
    inputSchema: sendParameters(true),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, ...AUTH_TOOLS.map(name => ({
    name, description: authDescriptions[name] + "（仅限 owner 回合）", inputSchema: authParameters[name],
    annotations: { readOnlyHint: name === "auth_list", destructiveHint: name === "auth_revoke", openWorldHint: false },
  })), ...SCHEDULE_TOOLS.map(name => ({
    name, description: scheduleDescriptions[name], inputSchema: scheduleParameters[name],
    annotations: { readOnlyHint: name === "schedule_list", destructiveHint: name === "schedule_delete", openWorldHint: false },
  }))] }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const meta = callMetaOf(req.params._meta);
    try {
      if (req.params.name === "send_message") {
        return qqContextText(JSON.stringify(await handlers.send(validateSendArguments(req.params.arguments), meta)));
      }
      if (AUTH_TOOLS.includes(req.params.name as AuthTool)) {
        return qqContextText(JSON.stringify(await handlers.auth(req.params.name as AuthTool, req.params.arguments ?? {}, meta)));
      }
      if (isScheduleTool(req.params.name)) {
        return qqContextText(await handlers.schedule(req.params.name, req.params.arguments ?? {}, meta));
      }
      return qqContextText("未知工具：" + req.params.name, true);
    } catch (error) { return qqContextText((error as Error).message, true); }
  });
  return server;
}

/** 经线程令牌向主进程提交 im 工具调用。 */
export async function imViaLoopback(endpoint: AuthTool | ScheduleTool | "send", args: unknown, meta: CallMeta, token: string | undefined, port = 8790): Promise<unknown> {
  return loopbackJson(await loopbackPost(endpoint, args, token, port, meta, endpoint === "send" ? 600_000 : 30_000), "IM 请求失败");
}

export async function sendViaLoopback(args: unknown, meta: CallMeta, token: string | undefined, port = 8790) {
  const body = await imViaLoopback("send", args, meta, token, port) as { message_id?: string | null; status?: string; note?: string };
  if (!body.message_id && !["sent", "sending", "uncertain", "pending"].includes(body.status ?? "")) throw new Error("发送返回格式错误");
  if (!body.message_id && !body.note) body.note = "消息状态为 " + body.status + "，但缺少 message_id 回执；不要重发。";
  return body;
}
