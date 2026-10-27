import { z } from "zod";
import { GmailError } from "./errors.js";

export const sendSchema = z.strictObject({
  to: z.string().min(1).max(1000), subject: z.string().max(500), body: z.string().max(100000),
  cc: z.string().min(1).max(1000).optional(), bcc: z.string().min(1).max(1000).optional(),
  reply_to_message_id: z.string().min(1).max(128).optional(), idempotency_key: z.string().min(8).max(128),
});
export type SendInput = z.infer<typeof sendSchema>;
export type ReplyHeaders = { messageId: string; references: string; subject: string };

function headerValue(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new GmailError("input", "邮件头部不能包含换行或控制字符");
  return value;
}

function encodedWords(value: string): string {
  headerValue(value);
  if (/^[\x20-\x7e]*$/u.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
  return words.join("\r\n ");
}

function addresses(value: string): string {
  headerValue(value);
  return value.split(",").map(item => {
    const trimmed = item.trim();
    const named = /^([^<>]+)\s*<([^<>]+)>$/u.exec(trimmed);
    const address = named ? named[2] : trimmed;
    const name = named?.[1].trim();
    // 保守接受常见邮箱；不支持 quoted local-part、注释、地址组或含逗号的显示名。
    if (address.length > 254 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(address) ||
        (name && (name.length > 200 || /["\\:;()]/u.test(name)))) {
      throw new GmailError("input", "邮件地址无效，请使用 name <local@domain> 或 local@domain，以逗号分隔");
    }
    if (!name) return address;
    const display = /^[\x20-\x7e]*$/u.test(name) ? `"${name}"` : encodedWords(name);
    return `${display} <${address}>`;
  }).join(",\r\n ");
}

export function validateSendHeaders(input: SendInput): void {
  addresses(input.to);
  if (input.cc !== undefined) addresses(input.cc);
  if (input.bcc !== undefined) addresses(input.bcc);
  headerValue(input.subject);
  if (input.reply_to_message_id !== undefined) headerValue(input.reply_to_message_id);
}

export function buildMime(input: SendInput, reply?: ReplyHeaders): string {
  validateSendHeaders(input);
  const subject = input.subject || (reply ? `Re: ${headerValue(reply.subject)}` : "");
  const headers = ["MIME-Version: 1.0", `To: ${addresses(input.to)}`];
  if (input.cc) headers.push(`Cc: ${addresses(input.cc)}`);
  if (input.bcc) headers.push(`Bcc: ${addresses(input.bcc)}`);
  headers.push(`Subject: ${encodedWords(subject)}`);
  if (reply) {
    const messageId = headerValue(reply.messageId);
    const references = headerValue(reply.references);
    if (!/^<[^<>\s]+>$/u.test(messageId) || (references && !/^(?:<[^<>\s]+>\s*)+$/u.test(references))) {
      throw new GmailError("input", "原邮件的 Message-ID 或 References 无效，无法构造回复");
    }
    headers.push(`In-Reply-To: ${messageId}`, `References: ${[references, messageId].filter(Boolean).join(" ").replace(/> +</gu, ">\r\n <")}`);
  }
  headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  const body = Buffer.from(input.body, "utf8").toString("base64").match(/.{1,76}/gu)?.join("\r\n") ?? "";
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

const headerSchema = z.object({ name: z.string(), value: z.string() });
type Part = {
  mimeType?: string; filename?: string; headers?: z.infer<typeof headerSchema>[];
  body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[];
};
const partSchema: z.ZodType<Part> = z.lazy(() => z.object({
  mimeType: z.string().optional(), filename: z.string().optional(), headers: z.array(headerSchema).optional(),
  body: z.object({ data: z.string().optional(), size: z.number().optional(), attachmentId: z.string().optional() }).optional(),
  parts: z.array(partSchema).optional(),
}));
export const messageSchema = z.object({
  id: z.string().min(1), threadId: z.string().min(1), snippet: z.string().optional(), payload: partSchema.optional(),
});
export type GmailMessage = z.infer<typeof messageSchema>;

export function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function singleLine(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " "); }

function htmlText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|h[1-6]))\s*>/giu, "\n").replace(/<[^>]*>/gu, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (whole: string, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? whole;
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    });
}

export function renderMessage(message: GmailMessage): string {
  const plain: string[] = [], html: string[] = [], attachments: string[] = [];
  function visit(part: Part): void {
    const attachment = !!part.filename || !!part.headers?.some(item => item.name.toLowerCase() === "content-disposition" && /^attachment\b/iu.test(item.value));
    if (attachment || part.body?.attachmentId) {
      attachments.push(`${singleLine(part.filename || "（无文件名）")} | ${singleLine(part.mimeType ?? "application/octet-stream")} | ${part.body?.size ?? 0} bytes`);
      return;
    }
    if (part.body?.data) {
      const text = Buffer.from(part.body.data, "base64url").toString("utf8");
      if (part.mimeType === "text/plain") plain.push(text);
      else if (part.mimeType === "text/html") html.push(htmlText(text));
    }
    for (const child of part.parts ?? []) visit(child);
  }
  if (message.payload) visit(message.payload);
  const text = (plain.length ? plain : html).join("\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
  const bytes = Buffer.from(text, "utf8"), limit = 32 * 1024;
  const body = bytes.length > limit ? `${new TextDecoder().decode(bytes.subarray(0, limit), { stream: true })}\n[正文已截断，原始 ${bytes.length} 字节]` : text;
  return [
    ...["From", "To", "Cc", "Date", "Subject", "Message-ID"].map(name => `${name}: ${singleLine(header(message, name))}`),
    "", body || "（无可读取正文）", "", "附件（不下载）：", ...attachments.length ? attachments : ["（无）"],
  ].join("\n");
}
