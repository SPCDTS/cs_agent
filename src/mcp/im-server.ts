import type { MemoryOperation } from "../shared/memory-tools.js";
import { isScheduleTool, SCHEDULE_TOOLS, type ScheduleOperation } from "../shared/schedule-tools.js";
import { parseScheduleCall, scheduleDescriptions, scheduleParameters } from "../agent/schedule/tool-schema.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { validateSendArguments } from "../agent/send-service.js";
import { AUTH_TOOLS, type AuthOperation } from "../shared/auth-tools.js";
import { authDescriptions, authParameters, parseAuthCall, sendParameters, SKILL_PUBLISH_DESCRIPTION, skillPublishParameters } from "../agent/im-tools.js";
import { qqContextText } from "../context/qq-context-tool.js";
import { MEMORY_RULE, MEMORY_TOOLS, isMemoryTool, memoryDescriptions, memoryParameters, parseMemoryCall } from "../agent/memory/tools.js";
import type { CallMeta } from "../context/media-recall-server.js";
import { callMetaOf, loopbackJson, loopbackPost } from "./media-recall-client.js";

/**
 * im MCP 服务（docs/ARCHITECTURE.md §4.1、§3.1）：每个会话线程一个进程，跨回合复用，所以工具清单固定为全集；
 * 每次调用连同 _meta（callId、回合元数据）交给主进程，由它按会话当前回合的身份校验 target、授权与定时权限。
 */
export interface ImHandlers {
  send(args: unknown, meta: CallMeta): Promise<unknown>;
  auth(name: AuthOperation, args: unknown, meta: CallMeta): Promise<unknown>;
  schedule(name: ScheduleOperation, args: unknown, meta: CallMeta): Promise<string>;
  skillPublish(args: unknown, meta: CallMeta): Promise<unknown>;
  memory(name: MemoryOperation, args: unknown, meta: CallMeta): Promise<string>;
}

export function createImServer(handlers: ImHandlers): Server {
  const server = new Server({ name: "im", version: "2.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "send_message", description: "The only way users can see your content: immediately send a message, to this chat by default, and return message_id. target requires authorization.",
    inputSchema: sendParameters(true),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, ...AUTH_TOOLS.map(name => ({
    name, description: authDescriptions[name] + " (owner turns only)", inputSchema: authParameters[name],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  })), {
    name: "skill_publish", description: SKILL_PUBLISH_DESCRIPTION, inputSchema: skillPublishParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ...MEMORY_TOOLS.map(name => ({
    // 使用规则只在 MEMORY_RULE 定义一次，挂在 mem_remember 的说明里；可见性固定为全集，主进程每次调用按本轮权限复核。
    name, description: memoryDescriptions[name] + (name === "mem_remember" ? " " + MEMORY_RULE : ""), inputSchema: memoryParameters[name],
    annotations: { readOnlyHint: name === "mem_search", destructiveHint: false, idempotentHint: name !== "mem_update", openWorldHint: false },
  })), ...SCHEDULE_TOOLS.map(name => ({
    name, description: scheduleDescriptions[name], inputSchema: scheduleParameters[name],
    annotations: { readOnlyHint: false, destructiveHint: name === "schedule", openWorldHint: false },
  }))] }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const meta = callMetaOf(req.params._meta);
    try {
      if (req.params.name === "send_message") {
        return qqContextText(JSON.stringify(await handlers.send(validateSendArguments(req.params.arguments), meta)));
      }
      if (req.params.name === "auth") {
        const call = parseAuthCall(req.params.arguments ?? {});
        return qqContextText(JSON.stringify(await handlers.auth(call.name, call.args, meta)));
      }
      if (req.params.name === "skill_publish") {
        return qqContextText(JSON.stringify(await handlers.skillPublish(req.params.arguments ?? {}, meta)));
      }
      if (isMemoryTool(req.params.name)) {
        const call = parseMemoryCall(req.params.name, req.params.arguments ?? {});
        return qqContextText(await handlers.memory(call.name, call.args, meta));
      }
      if (isScheduleTool(req.params.name)) {
        const call = parseScheduleCall(req.params.name, req.params.arguments ?? {});
        return qqContextText(await handlers.schedule(call.name, call.args, meta));
      }
      return qqContextText("未知工具：" + req.params.name, true);
    } catch (error) { return qqContextText((error as Error).message, true); }
  });
  return server;
}

/** 经线程令牌向主进程提交 im 工具调用。 */
export async function imViaLoopback(endpoint: AuthOperation | ScheduleOperation | MemoryOperation | "send" | "skill_publish", args: unknown, meta: CallMeta, token: string | undefined, port = 8790): Promise<unknown> {
  return loopbackJson(await loopbackPost(endpoint, args, token, port, meta, endpoint === "send" ? 600_000 : 30_000), "IM 请求失败");
}

export async function sendViaLoopback(args: unknown, meta: CallMeta, token: string | undefined, port = 8790) {
  const body = await imViaLoopback("send", args, meta, token, port) as { message_id?: string | null; status?: string; note?: string };
  if (!body.message_id && !["sent", "sending", "uncertain", "pending"].includes(body.status ?? "")) throw new Error("发送返回格式错误");
  if (!body.message_id && !body.note) body.note = "消息状态为 " + body.status + "，但缺少 message_id 回执；不要重发。";
  return body;
}
