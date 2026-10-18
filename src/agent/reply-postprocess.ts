import { usageFields } from "../obs/usage.js";
import { trace } from "../obs/trace.js";
/**
 * 回复后处理（设计 §4.3，两后端统一）：
 * - sanitize（代码清洗）：去 Markdown 代码围栏行、标题符号、表格竖线与分隔行、加粗/行内代码标记；
 *   `@` 换成全角 `＠`（QQ 里不会被当成 @ 提及）；压缩多余空行；孤立代理项换成 U+FFFD，
 *   UTF-16 ≤4000 截断且不拆代理对（fitText）。
 * - codex 后端额外：CODEX_REPLY_MODE=relay（默认）时先用意图模型做一次 ≤5 行提示的格式整理（20 s 超时），
 *   结果再清洗一遍；失败、超时或空结果回退到只清洗原文。direct：只清洗。
 */
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { log } from "../log.js";

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

export const RELAY_PROMPT = `把用户给你的文本整理成适合在 QQ 里直接显示的纯文本。
- 用中文，不改变含义，不增删信息。
- 去掉 Markdown：代码围栏、标题符号、表格、加粗等标记，必要时改成自然分行。
- 总长度不超过 4000 字。
- 只输出整理后的文本，不要任何解释或前后缀。`;

const RELAY_TIMEOUT_MS = 20_000;

export type ReplyMode = "relay" | "direct";

export interface PostprocessOptions {
  ticket?: string;
  mode: ReplyMode;
  models?: Models;
  model?: Model<Api>;
  timeoutMs?: number;
  /** 额外的中止信号（任务被中止 / 进程关闭） */
  signal?: AbortSignal;
}

/** 意图模型格式整理；失败抛错（调用方回退）。 */
export async function relayFormat(
  text: string,
  models: Models,
  model: Model<Api>,
  timeoutMs = RELAY_TIMEOUT_MS,
  signal?: AbortSignal,
  ticket?: string,
): Promise<string> {
  const started = Date.now();
  if (ticket) trace.event(ticket, "model_turn", { status: "started", detail: { operation: "relay", provider: model.provider, model: model.id } });
  const timeout = AbortSignal.timeout(timeoutMs);
  const msg = await models.completeSimple(
    model,
    { systemPrompt: RELAY_PROMPT, messages: [{ role: "user", content: text, timestamp: Date.now() }] },
    { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, maxTokens: 8000 },
  );
  if (ticket) trace.event(ticket, "model_turn", { status: ["error", "aborted"].includes(msg.stopReason) ? "failed" : "ok", durationMs: Date.now()-started,
    detail: { operation: "relay", provider: msg.provider, model: msg.model, ...usageFields(msg.usage), error: msg.errorMessage } });
  if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || `relay ${msg.stopReason}`);
  const out = msg.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
  if (!out) throw new Error("relay returned empty text");
  return out;
}

/**
 * 后端文本 → 最终回复正文。relay 只用于 codex 后端（调用方决定 mode）；
 * relay 失败（含超时、未配置模型）记 warn 并回退到只清洗。
 */
export async function postprocessReply(text: string, opts: PostprocessOptions): Promise<{ text: string; relayed: boolean }> {
  if (opts.mode === "relay" && opts.models && opts.model) {
    const started = Date.now();
    try {
      const formatted = await relayFormat(text, opts.models, opts.model, opts.timeoutMs, opts.signal, opts.ticket);
      log.info("reply relay done", { ms: Date.now() - started, chars: formatted.length });
      return { text: sanitizeReply(formatted), relayed: true };
    } catch (err) {
      if (opts.ticket) trace.event(opts.ticket, "fallback", { status: "failed", durationMs: Date.now()-started, detail: { operation: "relay", error: err, terminal: false } });
      log.warn("reply relay failed, sanitizing only", { ms: Date.now() - started, error: (err as Error).message });
    }
  }
  return { text: sanitizeReply(text), relayed: false };
}
