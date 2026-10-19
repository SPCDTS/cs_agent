/** 进程内共用的 QQ 召回工具：访问校验、查询、格式化与召回观察回调。 */
import { registerFileAttachment, registerImageAttachment, type AttachmentLimits } from "../media/attach.js";
import { readMediaFile } from "./media.js";
import { log } from '../shared/log.js';
import type { RecallObservation, RecallHit } from './observer.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { returnedLines, returnedMessage } from './recall-results.js';
import { accessToString, type Access } from './access.js';
import { DEFAULT_CONTEXT_MAX_CHARS, formatMessageFull, formatRecent, formatSearch, type FormatOptions } from './format.js';
import type { ContextStore } from './store.js';

export const RECENT_MAX = 30;
export const SEARCH_LIMIT_MAX = 20;
export const SEARCH_DAYS_MAX = 180;

export interface QQContextToolDeps {
  /** QQ_ACCESS 解析结果；undefined 表示缺失/非法 */
  access: Access | undefined;
  /** 惰性打开只读库（库文件可能尚未创建）；抛错时工具返回错误文本 */
  openStore: () => ContextStore;
  maxChars?: number;
  attachments?: () => Promise<{ dataDir: string; workdir: string; extraRoots?: string[]; attachDir: string; fileDir: string; limits: AttachmentLimits }>;
  onRecall?: (event: RecallObservation) => void;
}

export const qqContextText = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

function int(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/** 附件不产生召回证据；仅对媒体路径打开库并校验当前访问范围。 */
export async function callQQAttachmentTool(deps: QQContextToolDeps, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!deps.access) return qqContextText("qq_context 不可用：未配置有效的访问范围（QQ_ACCESS）。", true);
  if (typeof args.path !== "string" || !args.path || args.path.length > 1024 ||
      Object.keys(args).some(key => key !== "path" && !(name === "qq_send_file" && key === "name")) ||
      (args.name !== undefined && (typeof args.name !== "string" || !args.name || args.name.length > 1024))) return qqContextText("仅接受 path 和文件的可选 name", true);
  try {
    if (!deps.attachments) throw new Error("附件发送未启用");
    const dirs = await deps.attachments();
    const mediaCheck = async (canonical: string) => {
      if (!deps.openStore().mediaPathAllowed(deps.access!, canonical)) return false;
      await readMediaFile(dirs.dataDir, canonical);
      return true;
    };
    const options = { ...dirs, path: args.path, mediaCheck };
    return qqContextText(name === "qq_send_image" ? await registerImageAttachment(options)
      : await registerFileAttachment({ ...options, name: args.name as string | undefined }));
  } catch (err) { return qqContextText((err as Error).message, true); }
}

/** 工具调用的纯函数实现（便于进程内测试）。 */
export function callQQContextTool(deps: QQContextToolDeps, name: string, args: Record<string, unknown>): CallToolResult {
  const ts = Date.now();
  let returned: RecallHit[] = [], count = 0;
  const result = queryQQContextTool(deps, name, args, (hits, total) => { returned = hits; count = total; });
  if (deps.onRecall && ["qq_recent", "qq_search", "qq_message"].includes(name)) {
    try {
      deps.onRecall({ ts, tool: name, args, access: deps.access ? accessToString(deps.access) : '',
        scope_hint: deps.access?.kind === 'scope' ? deps.access.scope : null,
        returned, returned_count: returned.length, dropped_count: count - returned.length,
        chars: result.content.filter(c => c.type === 'text').map(c => c.text).join('\n').length,
        max_chars: name === 'qq_message' ? 1500 : deps.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS,
        duration_ms: Math.max(0, Date.now() - ts), is_error: result.isError === true });
    } catch (error) { log.warn('memory recall callback failed', { error }); }
  }
  return result;
}

function queryQQContextTool(deps: QQContextToolDeps, name: string, args: Record<string, unknown>,
  observe: (hits: RecallHit[], count: number) => void): CallToolResult {
  const { access } = deps;
  if (!access) return qqContextText("qq_context 不可用：未配置有效的访问范围（QQ_ACCESS）。", true);
  let store: ContextStore;
  try {
    store = deps.openStore();
  } catch (err) {
    return qqContextText(`qq_context 不可用：消息库无法打开（${(err as Error).message.slice(0, 120)}）。`, true);
  }
  const max = deps.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const fmt: FormatOptions = { ids: true, showScope: access.kind === "all" };
  try {
    switch (name) {
      case "qq_recent": {
        const before = typeof args.before_message_id === "string" && args.before_message_id ? args.before_message_id : undefined;
        const rows = store.recent(access, { limit: int(args.limit, 15, RECENT_MAX), ...(before ? { beforeMessageId: before } : {}) });
        const output = rows.length ? formatRecent(rows, max, fmt) : "（没有记录）";
        observe(returnedLines(rows.map(row => ({ kind: 'message', row })), output, fmt, 'last'), rows.length);
        return qqContextText(output);
      }
      case "qq_search": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return qqContextText("query 不能为空。", true);
        const items = store.search(access, {
          query: query.slice(0, 100),
          days: int(args.days, 30, SEARCH_DAYS_MAX),
          limit: int(args.limit, 10, SEARCH_LIMIT_MAX),
        });
        const output = items.length ? formatSearch(items, max, fmt) : "（没有匹配的记录）";
        observe(returnedLines(items, output, fmt, 'first'), items.length);
        return qqContextText(output);
      }
      case "qq_message": {
        const id = typeof args.message_id === "string" ? args.message_id.trim() : String(args.message_id ?? "");
        if (!id) return qqContextText("message_id 不能为空。", true);
        const hit = store.message(access, id);
        const output = hit ? formatMessageFull(hit, fmt) : "（没有这条消息，或不在当前会话范围内）";
        observe(hit ? returnedMessage(hit, output, fmt) : [], hit ? 1 + hit.chain.length : 0);
        return qqContextText(output);
      }
      default:
        return qqContextText(`未知工具：${name}`, true);
    }
  } catch (err) {
    return qqContextText(`qq_context 查询失败：${(err as Error).message.slice(0, 160)}`, true);
  }
}
