import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { validateSendArguments } from "../agent/send-service.js";
import { qqContextText } from "../context/qq-context-tool.js";

export function createImServer(send: (args: unknown) => Promise<unknown>): Server {
  const server = new Server({ name: "im", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "send_message", description: "立即向本回合会话发送消息，返回 message_id。直接输出不会送达用户；一条消息说完就不要再发。",
    inputSchema: { type: "object", properties: {
      text: { type: "string", minLength: 1, maxLength: 4000 },
      images: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 1024 } },
      files: { type: "array", maxItems: 3, items: { type: "object", properties: {
        path: { type: "string", minLength: 1, maxLength: 1024 }, name: { type: "string", minLength: 1, maxLength: 1024 },
      }, required: ["path"], additionalProperties: false } },
    }, required: ["text"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name !== "send_message") return qqContextText("未知工具：" + req.params.name, true);
    try { return qqContextText(JSON.stringify(await send(validateSendArguments(req.params.arguments)))); }
    catch (error) { return qqContextText((error as Error).message, true); }
  });
  return server;
}

export async function sendViaLoopback(args: unknown, token: string | undefined, port = 8790) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("IM_TOKEN 未配置");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MEDIA_RECALL_PORT 无效");
  const res = await fetch(`http://127.0.0.1:${port}/send`, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(args), redirect: "error", signal: AbortSignal.timeout(600_000),
  });
  const body = await res.json() as { error?: string; message_id?: string | null; status?: string; note?: string };
  if (!res.ok) throw new Error(body.error ?? "发送失败");
  if (!body.message_id && !["sent", "sending", "uncertain", "pending"].includes(body.status ?? "")) throw new Error("发送返回格式错误");
  if (!body.message_id && !body.note) body.note = "消息状态为 " + body.status + "，但缺少 message_id 回执；不要重发。";
  return body;
}
