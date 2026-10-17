/**
 * 唯一的紧凑格式化器（设计 §2.4）：意图层与 qq_context MCP 必须都用这里的函数，
 * 保证两层看到的历史内容、裁剪规则、字数上限完全一致。
 *
 *   22:41 De: 今晚有cs比赛吗                       （普通消息，正文 ≤120 字）
 *   22:42 [我] → 生图 prompt="a cute dog" → 已发送 1 张图
 *   22:43 [我] → codex(high) → "今晚有 ESL 决赛……"
 *   22:44 [我] → 处理中
 *   [日摘要 10-15] ……                             （摘要 ≤400 字）
 *   [周摘要 10-06~10-12] ……
 * 非今天的消息在时间前加 "MM-DD "；ids=true 时行首加 "#<message_id> "（供 qq_message / before_message_id 使用）。
 */
import { BOT_STATUS, clip, EXCERPT_MAX, SUMMARY_MAX, type ContextItem, type MessageRow, type SummaryRow } from "./store.js";

export const DEFAULT_CONTEXT_MAX_CHARS = 2500;
export const MESSAGE_FULL_MAX = 1500;

export interface FormatOptions {
  /** 行首加 #message_id（机器人占位行除外） */
  ids?: boolean;
  /** 行首加会话标签（owner 跨会话查询时） */
  showScope?: boolean;
  /** 判定"今天"用的当前时间（unix 秒） */
  now?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const md = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function formatTime(ts: number, now = Math.floor(Date.now() / 1000)): string {
  const d = new Date(ts * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay(d, new Date(now * 1000)) ? hm : `${md(d)} ${hm}`;
}

export function scopeLabel(scope: string): string {
  const [kind, id] = scope.split(":");
  return kind === "group" ? `[群${id}]` : `[私聊${id}]`;
}

/** 机器人行正文（不含时间）。 */
function botBody(row: MessageRow): string {
  const failed = row.status === BOT_STATUS.failed;
  if (row.status === BOT_STATUS.pending || !row.action) return "[我] → 处理中";
  switch (row.action) {
    case "generate_image":
    case "research+generate_image": {
      const tail = failed ? "失败" : `已发送 ${row.image_count ?? 0} 张图`;
      const research = row.action === "research+generate_image" ? "查资料+" : "";
      return `[我] → ${research}生图 prompt="${clip(row.detail ?? "", 70)}" → ${tail}`;
    }
    case "ask_codex":
      return `[我] → codex(${row.detail || "default"}) → ${failed ? "失败" : `"${clip(row.text, 80)}"`}`;
    case "fallback":
      return "[我] → 失败";
    default:
      return failed ? "[我] → 失败" : `[我] → "${clip(row.text, 100)}"`;
  }
}

function prefix(row: MessageRow, o: FormatOptions): string {
  const id = o.ids && !row.message_id.startsWith("self:") ? `#${row.message_id} ` : "";
  const scope = o.showScope ? `${scopeLabel(row.scope)} ` : "";
  return `${id}${scope}${formatTime(row.time, o.now)} `;
}

/** 单条消息一行：`HH:MM 昵称: 文本`（正文部分 ≤120 字）。 */
export function formatMessage(row: MessageRow, o: FormatOptions = {}): string {
  const body = row.is_self ? botBody(row) : `${row.nickname || row.user_id}: ${row.text}`;
  return prefix(row, o) + clip(body, EXCERPT_MAX);
}

export function formatSummary(row: SummaryRow, o: Pick<FormatOptions, "showScope"> = {}): string {
  const start = new Date(row.period_start * 1000);
  const label =
    row.level === "day" ? `[日摘要 ${md(start)}]` : `[周摘要 ${md(start)}~${md(new Date((row.period_end - 86400) * 1000))}]`;
  const scope = o.showScope ? `${scopeLabel(row.scope)} ` : "";
  return `${scope}${label} ${clip(row.text, SUMMARY_MAX)}`;
}

export function formatItem(item: ContextItem, o: FormatOptions = {}): string {
  return item.kind === "message" ? formatMessage(item.row, o) : formatSummary(item.row, o);
}

/**
 * 多行拼接并施加总量上限（默认 2500 字）。keep="last"：保留末尾（recent，旧→新，丢最旧）；
 * keep="first"：保留开头（search，新→旧，丢最旧）。被丢弃时追加/前置一行说明。
 */
export function joinCapped(lines: string[], maxChars = DEFAULT_CONTEXT_MAX_CHARS, keep: "first" | "last" = "first"): string {
  const out: string[] = [];
  let used = 0;
  const ordered = keep === "last" ? [...lines].reverse() : lines;
  for (const line of ordered) {
    const cost = line.length + (out.length ? 1 : 0);
    if (used + cost > maxChars - 20) break; // 预留说明行
    out.push(line);
    used += cost;
  }
  const dropped = lines.length - out.length;
  if (keep === "last") {
    out.reverse();
    if (dropped) out.unshift(`（更早的 ${dropped} 条已省略）`);
  } else if (dropped) {
    out.push(`（另有 ${dropped} 条未显示）`);
  }
  return out.join("\n");
}

/** recent 结果（旧→新）。 */
export function formatRecent(rows: MessageRow[], maxChars = DEFAULT_CONTEXT_MAX_CHARS, o: FormatOptions = {}): string {
  return joinCapped(rows.map((r) => formatMessage(r, o)), maxChars, "last");
}

/** search 结果（新→旧，原始消息与摘要混排）。 */
export function formatSearch(items: ContextItem[], maxChars = DEFAULT_CONTEXT_MAX_CHARS, o: FormatOptions = {}): string {
  return joinCapped(items.map((i) => formatItem(i, o)), maxChars, "first");
}

/** 单条全文 + 引用链（≤1500 字）。 */
export function formatMessageFull(
  hit: { row: MessageRow; chain: MessageRow[] },
  o: FormatOptions = {},
  maxChars = MESSAGE_FULL_MAX,
): string {
  const { row } = hit;
  const head = prefix(row, o) + (row.is_self ? botBody(row) : `${row.nickname || row.user_id}: ${row.text}`);
  const detail = row.is_self && row.detail ? `\n细节: ${row.detail}` : "";
  const chain = hit.chain.map((c, i) => `${"  ".repeat(i + 1)}↳ 引用 ${formatMessage(c, o)}`);
  const text = [head + detail, ...chain].join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
