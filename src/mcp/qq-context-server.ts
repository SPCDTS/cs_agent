/**
 * qq_context MCP 服务（设计 §2.3）：统一上下文存储的 stdio 外壳，供容器内 codex 检索 QQ 聊天记录。
 * 访问范围只来自环境变量 QQ_ACCESS（每次 codex exec 以 -c 注入），工具参数里不接受范围；
 * 缺失或非法时所有工具都返回错误文本。只读连接；输出一律经 src/context/format.ts。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CHATS_DENIED } from "../context/chats.js";
import { accessToString } from "../context/access.js";
import { callQQAttachmentTool, callQQContextTool, qqContextText as text, RECENT_MAX, SEARCH_LIMIT_MAX, SEARCH_DAYS_MAX, type QQContextToolDeps } from "../context/qq-context-tool.js";

export interface QQContextDeps extends QQContextToolDeps {
  view?: (file: string) => Promise<{ type: "image"; data: string; mimeType: string }>;
  chats?: () => Promise<string>;
  recall?: (messageId: string) => Promise<string>;
}

// 只读工具声明统一注解（与审批模式无关，供客户端按注解判断）。
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const TOOLS = [
  {
    name: "qq_chats",
    description: "只读列出群名、群号及好友备注；仅限主人私聊，用于按名称确认会话。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "qq_send_image",
    description: "登记工作区内或当前范围已召回的图片，随本次回复发送，最多 4 张。",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "qq_send_file",
    description: "登记工作区内或当前范围已召回的文件，在本次文字回复之后发送。",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 }, name: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "qq_view_image",
    description: "查看当前访问范围内已召回的图片，一次一张，不占召回次数。",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["path"], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "qq_image",
    description: "按消息 id 召回图片，只返回本地路径文本，用 qq_view_image 查看；每轮最多 5 次。",
    inputSchema: { type: "object", properties: { message_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["message_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "qq_recent",
    description:
      "读取当前 QQ 会话最近的聊天记录（旧→新，每行 `#消息id 时间 昵称: 文本`，[我] 是机器人自己）。仅当消息指代此前内容时使用。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: RECENT_MAX, description: `条数，≤${RECENT_MAX}，默认 15` },
        before_message_id: { type: "string", description: "只看这条消息之前的记录（向前翻页）" },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "qq_search",
    description: "按关键词检索当前 QQ 会话的历史（原始消息与日/周摘要混排，新→旧）。多个关键词用空格分隔，需全部命中。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词（中文可用 2 字以上子串）" },
        days: { type: "integer", minimum: 1, maximum: SEARCH_DAYS_MAX, description: `回溯天数，≤${SEARCH_DAYS_MAX}，默认 30` },
        limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT_MAX, description: `条数，≤${SEARCH_LIMIT_MAX}，默认 10` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "qq_message",
    description: "读取一条消息的完整正文及其引用链（≤3 层）。message_id 来自 qq_recent / qq_search 行首的 #id。",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
] as const;

export function createQQContextServer(deps: QQContextDeps): Server {
  const server = new Server(
    { name: "qq_context", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: deps.access
        ? `只读访问 QQ 聊天记录，范围：${accessToString(deps.access)}。`
        : "QQ_ACCESS 未配置，所有工具都会返回错误。",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    if (req.params.name === "qq_chats") {
      if (deps.access?.kind !== "all") return text(CHATS_DENIED, true);
      if (Object.keys(args).length) return text("qq_chats 不接受参数", true);
      try {
        if (!deps.chats) throw new Error("会话列表未启用");
        return text(await deps.chats());
      } catch (err) { return text((err as Error).message, true); }
    }
    if (["qq_send_image", "qq_send_file"].includes(req.params.name)) return callQQAttachmentTool(deps, req.params.name, args);
    if (req.params.name === "qq_view_image") {
      if (!deps.access) return text("qq_context 不可用：未配置有效的访问范围（QQ_ACCESS）。", true);
      if (Object.keys(args).length !== 1 || typeof args.path !== "string" || !args.path || args.path.length > 1024) return text("仅接受 path", true);
      try {
        if (!deps.view) throw new Error("图片查看未启用");
        return { content: [await deps.view(args.path)] };
      } catch (err) { return text((err as Error).message, true); }
    }
    if (req.params.name !== "qq_image") return callQQContextTool(deps, req.params.name, args);
    if (!deps.access) return text("qq_context 不可用：未配置有效的访问范围（QQ_ACCESS）。", true);
    if (Object.keys(args).length !== 1 || typeof args.message_id !== "string" || !args.message_id.trim() || args.message_id.length > 128) return text("仅接受 message_id", true);
    try {
      if (!deps.recall) throw new Error("图片召回未启用");
      return text(await deps.recall(args.message_id));
    } catch (err) { return text((err as Error).message, true); }
  });
  return server;
}
