/**
 * 回复后处理（设计 §4.3，两后端统一）：模型原文照发，不改格式、不调用模型。
 * 只保留发送保护：孤立代理项换成 U+FFFD、去首尾空白、空文本给占位，
 * UTF-16 ≤4000 截断且不拆代理对（与 QQBridge 的校验口径一致）。
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

/** 发送保护：只保证 QQBridge 能接受，不改动内容格式。 */
export function fitReply(text: string, limit = QQ_TEXT_LIMIT): string {
  return fitText(text, limit).text;
}

/** 后端文本 → 最终回复正文；原文照发，仅做发送保护。 */
export function postprocessReply(text: string): string {
  return fitReply(text);
}
