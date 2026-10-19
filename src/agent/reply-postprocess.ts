/**
 * 回复后处理（设计 §4.3，两后端统一）：
 * - sanitize（代码清洗）：去 Markdown 代码围栏行、标题符号、表格竖线与分隔行、加粗/行内代码标记；
 *   `@` 换成全角 `＠`（QQ 里不会被当成 @ 提及）；压缩多余空行；孤立代理项换成 U+FFFD，
 *   UTF-16 ≤4000 截断且不拆代理对（fitText）。
 * 两个后端均只清洗原文，不调用模型。
 */

/** QQ 文本上限，按 UTF-16 code unit 计（与 QQBridge 的校验口径一致） */
export const QQ_TEXT_LIMIT = 4000;
const TRUNC_NOTE = "\n…（内容过长，已截断）";

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** 把孤立的代理项（非法 UTF-16）替换为 U+FFFD（Node 24 的 String.prototype.toWellFormed）。 */
function wellFormed(text: string): string {
  return (text as string & { toWellFormed(): string }).toWellFormed();
}

/** 先修正非法 UTF-16，再截断到 ≤ limit 个 UTF-16 code unit（不拆开代理对），超长时附加提示。 */
export function fitText(text: string, limit = QQ_TEXT_LIMIT): { text: string; truncated: boolean } {
  const trimmed = wellFormed(text).trim() || "（无内容）";
  if (trimmed.length <= limit) return { text: trimmed, truncated: false };
  let cut = trimmed.slice(0, Math.max(0, limit - TRUNC_NOTE.length));
  if (cut.length && isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  return { text: cut + TRUNC_NOTE, truncated: true };
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

/** 去 Markdown 标记（不调用模型）。 */
export function stripMarkdown(text: string): string {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE_RE.test(raw)) continue; // 围栏行本身删除，围栏内的内容保留
    if (TABLE_SEP_RE.test(raw)) continue;
    let line = raw.replace(HEADING_RE, "");
    if (TABLE_ROW_RE.test(line)) {
      line = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())
        .join("  ");
    }
    line = line
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1");
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** 代码清洗：去 Markdown、去 @、≤4000。 */
export function sanitizeReply(text: string, limit = QQ_TEXT_LIMIT): string {
  return fitText(stripMarkdown(text).replace(/@/g, "＠"), limit).text;
}

/** 后端文本 → 最终回复正文；仅做代码清洗。 */
export function postprocessReply(text: string): string {
  return sanitizeReply(text);
}
