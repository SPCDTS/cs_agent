import { Type, type Static } from "typebox";
import { GmailError } from "./http";

const Header = Type.Object({ name: Type.String(), value: Type.String() });
const Part = Type.Cyclic({
  Part: Type.Object({
    mimeType: Type.Optional(Type.String()), filename: Type.Optional(Type.String()), headers: Type.Optional(Type.Array(Header)),
    body: Type.Optional(Type.Object({ data: Type.Optional(Type.String()), size: Type.Optional(Type.Number()), attachmentId: Type.Optional(Type.String()) })),
    parts: Type.Optional(Type.Array(Type.Ref("Part"))),
  }),
}, "Part");
export const MessageSchema = Type.Object({
  id: Type.String({ minLength: 1 }), threadId: Type.String({ minLength: 1 }), snippet: Type.Optional(Type.String()),
  internalDate: Type.Optional(Type.String()), labelIds: Type.Optional(Type.Array(Type.String())), payload: Type.Optional(Part),
});
export type GmailMessage = Static<typeof MessageSchema>;
type MessagePart = NonNullable<GmailMessage["payload"]>;

export function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
export const singleLine = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");

function headerValue(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new GmailError("input");
  return value;
}
function encodedWords(value: string): string {
  headerValue(value);
  if (/^[\x20-\x7e]*$/u.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 42) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`); chunk = ""; }
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
    const address = named?.[2] ?? trimmed;
    const name = named?.[1]?.trim();
    // 保守接受常见邮箱；不支持 quoted local-part、注释、地址组或含逗号的显示名。
    if (address.length > 254 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(address) ||
        (name && (name.length > 200 || /["\\:;()]/u.test(name)))) throw new GmailError("input");
    if (!name) return address;
    return `${/^[\x20-\x7e]*$/u.test(name) ? `"${name}"` : encodedWords(name)} <${address}>`;
  }).join(",\r\n ");
}

export type MailDraft = { to: string; subject: string; text: string };
type ReplyHeaders = { messageId: string; references: string; subject: string };
export function buildMime(draft: MailDraft, reply?: ReplyHeaders): string {
  const subject = draft.subject || (reply ? `Re: ${headerValue(reply.subject)}` : "");
  const headers = ["MIME-Version: 1.0", `To: ${addresses(draft.to)}`, `Subject: ${encodedWords(subject)}`];
  if (reply) {
    const messageId = headerValue(reply.messageId), references = headerValue(reply.references);
    if (!/^<[^<>\s]+>$/u.test(messageId) || (references && !/^(?:<[^<>\s]+>\s*)+$/u.test(references))) throw new GmailError("input");
    headers.push(`In-Reply-To: ${messageId}`, `References: ${[references, messageId].filter(Boolean).join(" ").replace(/> +</gu, ">\r\n <")}`);
  }
  headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  const body = Buffer.from(draft.text, "utf8").toString("base64").match(/.{1,76}/gu)?.join("\r\n") ?? "";
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

function htmlText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|h[1-6]))\s*>/giu, "\n").replace(/<[^>]*>/gu, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (whole: string, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? whole;
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    });
}

const BODY_CHARS = 8000;
export function renderMessage(message: GmailMessage): string {
  const plain: string[] = [], html: string[] = [], attachments: string[] = [];
  function visit(part: MessagePart): void {
    const attachment = !!part.filename || !!part.headers?.some(item => item.name.toLowerCase() === "content-disposition" && /^attachment\b/iu.test(item.value));
    if (attachment || part.body?.attachmentId) {
      attachments.push(`${singleLine(part.filename || "（无文件名）")} | ${part.body?.size ?? 0} bytes`);
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
  const chars = [...(plain.length ? plain : html).join("\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")];
  const body = chars.length > BODY_CHARS ? `${chars.slice(0, BODY_CHARS).join("")}\n[正文已截断，原文 ${chars.length} 字]` : chars.join("");
  return [
    `id: ${singleLine(message.id)}`, `threadId: ${singleLine(message.threadId)}`,
    ...["From", "To", "Cc", "Date", "Subject"].map(name => `${name}: ${singleLine(header(message, name))}`),
    "", body || "（无可读取正文）", "", "附件（不下载）：", ...attachments.length ? attachments : ["（无）"],
  ].join("\n");
}
