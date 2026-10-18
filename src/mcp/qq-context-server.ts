/**
 * qq_context MCP 服务（设计 §2.3）：统一上下文存储的 stdio 外壳，供容器内 codex 检索 QQ 聊天记录。
 * 访问范围只来自环境变量 QQ_ACCESS（每次 codex exec 以 -c 注入），工具参数里不接受范围；
 * 缺失或非法时所有工具都返回错误文本。只读连接；输出一律经 src/context/format.ts。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { accessToString, type Access } from "../context/access.js";
import { DEFAULT_CONTEXT_MAX_CHARS, formatMessageFull, formatRecent, formatSearch, type FormatOptions } from "../context/format.js";
import type { ContextStore } from "../context/store.js";

const RECENT_MAX = 30;
const SEARCH_LIMIT_MAX = 20;
const SEARCH_DAYS_MAX = 180;

export interface QQContextDeps {
  /** QQ_ACCESS 解析结果；undefined 表示缺失/非法 */
  access: Access | undefined;
  /** 惰性打开只读库（库文件可能尚未创建）；抛错时工具返回错误文本 */
  openStore: () => ContextStore;
  maxChars?: number;
}

// 三个工具都只读当前会话的上下文库：声明只读注解（与审批模式无关，供客户端按注解判断）。
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const TOOLS = [
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

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

function int(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/** 工具调用的纯函数实现（便于进程内测试）。 */
export function callQQContextTool(deps: QQContextDeps, name: string, args: Record<string, unknown>): CallToolResult {
  const { access } = deps;
  if (!access) return text("qq_context 不可用：未配置有效的访问范围（QQ_ACCESS）。", true);
  let store: ContextStore;
  try {
    store = deps.openStore();
  } catch (err) {
    return text(`qq_context 不可用：消息库无法打开（${(err as Error).message.slice(0, 120)}）。`, true);
  }
  const max = deps.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const fmt: FormatOptions = { ids: true, showScope: access.kind === "all" };
  try {
    switch (name) {
      case "qq_recent": {
        const before = typeof args.before_message_id === "string" && args.before_message_id ? args.before_message_id : undefined;
        const rows = store.recent(access, { limit: int(args.limit, 15, RECENT_MAX), ...(before ? { beforeMessageId: before } : {}) });
        return text(rows.length ? formatRecent(rows, max, fmt) : "（没有记录）");
      }
      case "qq_search": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return text("query 不能为空。", true);
        const items = store.search(access, {
          query: query.slice(0, 100),
          days: int(args.days, 30, SEARCH_DAYS_MAX),
          limit: int(args.limit, 10, SEARCH_LIMIT_MAX),
        });
        return text(items.length ? formatSearch(items, max, fmt) : "（没有匹配的记录）");
      }
      case "qq_message": {
        const id = typeof args.message_id === "string" ? args.message_id.trim() : String(args.message_id ?? "");
        if (!id) return text("message_id 不能为空。", true);
        const hit = store.message(access, id);
        return text(hit ? formatMessageFull(hit, fmt) : "（没有这条消息，或不在当前会话范围内）");
      }
      default:
        return text(`未知工具：${name}`, true);
    }
  } catch (err) {
    return text(`qq_context 查询失败：${(err as Error).message.slice(0, 160)}`, true);
  }
}

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
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callQQContextTool(deps, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  );
  return server;
}
