/**
 * qq_context MCP 服务（docs/ARCHITECTURE.md §9）：统一上下文存储的 stdio 外壳，供容器内 codex 检索 QQ 聊天记录。
 * 每个会话线程一个进程、跨回合复用：读取范围不在环境里，每次调用按 _meta 向主进程求本次调用的上下文
 * （会话当前回合的发送者决定：owner 为 all，其余为本会话），调用不属于当前回合时主进程拒绝。
 * 工具参数里不接受范围。只读连接；输出一律经 src/context/format.ts。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Access } from "../context/access.js";
import type { CallMeta } from "../context/media-recall-server.js";
import type { RecallObservation } from "../context/observer.js";
import { callQQContextTool, qqContextText as text, RECENT_MAX, SEARCH_LIMIT_MAX, SEARCH_DAYS_MAX, type QQContextToolDeps } from "../context/qq-context-tool.js";
import { callMetaOf } from "./media-recall-client.js";

/** 主进程求出的本次调用上下文 */
export interface QQCallContext { access: Access; turnId?: string; session?: string }

export interface QQContextDeps extends Omit<QQContextToolDeps, "access" | "onRecall"> {
  /** 本次调用的读取范围（抛错时工具返回错误文本） */
  context(meta: CallMeta): Promise<QQCallContext>;
  onRecall?: (event: RecallObservation, context: QQCallContext) => void;
  view?: (file: string, meta: CallMeta) => Promise<{ type: "image"; data: string; mimeType: string }>;
  chats?: (meta: CallMeta) => Promise<string>;
  recall?: (messageId: string, meta: CallMeta) => Promise<string>;
}

// 只读工具声明统一注解（与审批模式无关，供客户端按注解判断）。
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const TOOLS = [
  {
    name: "qq_chats",
    description: "只读列出群名、群号及好友备注；仅限主人回合，用于按名称确认会话。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
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
    { name: "qq_context", version: "2.0.0" },
    { capabilities: { tools: {} }, instructions: "只读访问 QQ 聊天记录；范围随本轮发送者：owner 为全部会话，其他人为本会话。" },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    const meta = callMetaOf(req.params._meta);
    try {
      if (req.params.name === "qq_chats") {
        if (Object.keys(args).length) return text("qq_chats 不接受参数", true);
        if (!deps.chats) throw new Error("会话列表未启用");
        return text(await deps.chats(meta));
      }
      if (req.params.name === "qq_view_image") {
        if (Object.keys(args).length !== 1 || typeof args.path !== "string" || !args.path || args.path.length > 1024) return text("仅接受 path", true);
        if (!deps.view) throw new Error("图片查看未启用");
        return { content: [await deps.view(args.path, meta)] };
      }
      if (req.params.name === "qq_image") {
        if (Object.keys(args).length !== 1 || typeof args.message_id !== "string" || !args.message_id.trim() || args.message_id.length > 128) return text("仅接受 message_id", true);
        if (!deps.recall) throw new Error("图片召回未启用");
        return text(await deps.recall(args.message_id, meta));
      }
      const context = await deps.context(meta);
      const onRecall = deps.onRecall;
      return callQQContextTool({ openStore: deps.openStore, access: context.access, ...(deps.maxChars !== undefined ? { maxChars: deps.maxChars } : {}),
        ...(onRecall ? { onRecall: (event: RecallObservation) => onRecall(event, context) } : {}) }, req.params.name, args);
    } catch (err) { return text((err as Error).message, true); }
  });
  return server;
}
