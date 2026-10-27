import { z } from "zod";
import { GmailError, googleError } from "./errors.js";
import { requestJson } from "./http.js";
import { buildMime, header, messageSchema, renderMessage, singleLine, validateSendHeaders, type SendInput } from "./mime.js";
import type { GmailOAuth } from "./oauth.js";
import type { SentStore } from "./store.js";

const listSchema = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).optional() });
const sentSchema = z.object({ id: z.string().min(1), threadId: z.string().min(1) });

export class GmailClient {
  private readonly baseUrl: URL;
  constructor(private readonly oauth: GmailOAuth, private readonly store: SentStore, baseUrl = "https://gmail.googleapis.com") {
    this.baseUrl = new URL(baseUrl);
  }

  private async request<T>(path: string, schema: z.ZodType<T>, params?: URLSearchParams, body?: unknown): Promise<T> {
    const url = new URL(`/gmail/v1/users/me/${path}`, this.baseUrl);
    if (params) url.search = params.toString();
    const token = await this.oauth.accessToken();
    const response = await requestJson(url, new Set([this.baseUrl.origin]), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status < 200 || response.status >= 300) throw googleError(response.status);
    const result = schema.safeParse(response.body);
    if (!result.success) throw new GmailError("response", "Gmail 响应格式无效", response.status);
    return result.data;
  }

  private message(id: string, format: "full" | "metadata", headers: string[] = []) {
    const params = new URLSearchParams({ format });
    for (const name of headers) params.append("metadataHeaders", name);
    return this.request(`messages/${encodeURIComponent(id)}`, messageSchema, params);
  }

  async search(query: string, maxResults = 10): Promise<string> {
    const result = await this.request("messages", listSchema, new URLSearchParams({ q: query, maxResults: String(maxResults) }));
    if (!result.messages?.length) return "未找到匹配的邮件。";
    const rows = await Promise.all(result.messages.slice(0, maxResults).map(async item => {
      const message = await this.message(item.id, "metadata", ["From", "To", "Subject", "Date"]);
      const snippet = Array.from(singleLine(message.snippet ?? "")).slice(0, 200).join("");
      return [message.id, message.threadId, header(message, "Date"), header(message, "From"), header(message, "Subject")].map(singleLine).join(" | ") + "\n" + snippet;
    }));
    return rows.join("\n\n");
  }

  async read(id: string): Promise<string> { return renderMessage(await this.message(id, "full")); }

  async send(input: SendInput): Promise<string> {
    const result = await this.store.send(input.idempotency_key, async () => {
      validateSendHeaders(input);
      const original = input.reply_to_message_id ? await this.message(input.reply_to_message_id, "metadata", ["Message-ID", "Subject", "References"]) : undefined;
      const raw = buildMime(input, original ? {
        messageId: header(original, "Message-ID"), references: header(original, "References"), subject: header(original, "Subject"),
      } : undefined);
      const sent = await this.request("messages/send", sentSchema, undefined, {
        raw: Buffer.from(raw, "utf8").toString("base64url"), ...(original ? { threadId: original.threadId } : {}),
      });
      return { messageId: sent.id, threadId: sent.threadId };
    });
    return `已发送 messageId=${singleLine(result.receipt.messageId)} threadId=${singleLine(result.receipt.threadId)}${result.duplicate ? "（重复调用，未再次发送）" : ""}`;
  }
}
