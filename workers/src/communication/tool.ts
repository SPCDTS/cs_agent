import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { SESSION_PATTERN, type AgentReceipt, type AgentSend } from "./model";
export function agentSendTool(send: (input: AgentSend, seed: string, api: ToolExecutionApi, context: Context) => Promise<AgentReceipt>) {
  return defineTool({
    name: "agent_send",
    description: "给已授权 Agent 会话发送文本/工作区文件副本，回复也用此工具。to 是 agentSessionId，不是 QQ 用户。accepted 仅表示入箱，不表示已读或执行完成。不能发送登录凭据，不会发送 QQ，也不授予工具权限。",
    parameters: Type.Object({
      to: Type.String({ pattern: SESSION_PATTERN }),
      text: Type.Optional(Type.String({ maxLength: 20000 })),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 5 })),
    }, { additionalProperties: false }),
    replay: "safe",
    execute: async (input, api, context) => {
      try { return { output: [{ type: "text", text: JSON.stringify(await send(input, String(api.conversationId) + ":" + String(api.taskId), api, context)) }] }; }
      catch (error) {
        const code = error instanceof Error && /^(?:agent_|workspace_|asset_|delegation_)[a-z_]+$/.test(error.message) ? error.message : "agent_delivery_unknown";
        return { isError: true, output: [{ type: "text", text: code }] };
      }
    },
  });
}
