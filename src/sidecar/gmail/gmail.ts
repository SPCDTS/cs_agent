import { z } from "zod";
import { GmailError, googleError } from "./errors.js";
import { requestJson } from "./http.js";
import { buildMime, header, messageSchema, renderMessage, singleLine, validateSendHeaders, type SendInput } from "./mime.js";
import type { GmailOAuth } from "./oauth.js";
import type { SentStore } from "./store.js";

const listSchema = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).optional() });
const sentSchema = z.object({ id: z.string().min(1), threadId: z.string().min(1) });
const profileSchema = z.object({ historyId: z.string().regex(/^[0-9]{1,20}$/u) });
const historySchema = profileSchema.extend({
  nextPageToken: z.string().optional(),
  history: z.array(z.object({
    id: z.string().regex(/^[0-9]{1,20}$/u),
    messagesAdded: z.array(z.object({ message: z.object({ id: z.string().min(1) }) })).optional(),
  })).optional(),
});
const eventMessageSchema = messageSchema.extend({ internalDate: z.string().optional(), labelIds: z.array(z.string()).optional() });
type GmailEvent = {
  source: "gmail"; externalId: string; occurredAt: number; kind: "mail.received";
  title: string; summary: string; actor: string; ref: string; labels: string[];
};
type GmailEvents = { cursor: string; events: GmailEvent[]; reset: boolean; more: boolean };

function eventText(value: string, limit: number): string {
  return Array.from(singleLine(value)).slice(0, limit).join("");
}

function mailEvent(message: z.infer<typeof eventMessageSchema>): GmailEvent {
  const internalDate = message.internalDate?.trim() ? Number(message.internalDate) : Number.NaN;
  const date = Date.parse(header(message, "Date"));
  return {
    source: "gmail", externalId: message.id, kind: "mail.received", ref: message.id,
    occurredAt: Number.isSafeInteger(internalDate) && internalDate >= 0 ? internalDate : Number.isFinite(date) ? date : Date.now(),
    title: eventText(header(message, "Subject"), 200), summary: eventText(message.snippet ?? "", 500),
    actor: eventText(header(message, "From"), 120), labels: (message.labelIds ?? []).slice(0, 16).map(label => eventText(label, 64)),
  };
}

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

  private async resetEvents(): Promise<GmailEvents> {
    const profile = await this.request("profile", profileSchema);
    return { cursor: profile.historyId, events: [], reset: true, more: false };
  }

  async events(cursor: string | null = null, limit = 20): Promise<GmailEvents> {
    if (!cursor) return this.resetEvents();
    const ids = new Set<string>();
    let historyId = cursor, nextPageToken: string | undefined;
    let lastConsumedId: string | undefined;
    let more = false;
    try {
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ startHistoryId: cursor, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "100" });
        if (nextPageToken) params.set("pageToken", nextPageToken);
        const result = await this.request("history", historySchema, params);
        historyId = result.historyId;
        nextPageToken = result.nextPageToken;
        for (const history of result.history ?? []) {
          const recordIds = new Set(history.messagesAdded?.map(added => added.message.id));
          const newCount = Array.from(recordIds).filter(id => !ids.has(id)).length;
          if (ids.size >= limit || (lastConsumedId !== undefined && ids.size + newCount > limit)) {
            more = true;
            break;
          }
          // 整条消费，首条即使超限也不拆开，确保下一次轮询能够继续。
          for (const id of recordIds) ids.add(id);
          lastConsumedId = history.id;
        }
        if (more || !nextPageToken || ids.size >= limit) break;
      }
    } catch (error) {
      if (error instanceof GmailError && error.kind === "not_found") return this.resetEvents();
      throw error;
    }
    more ||= !!nextPageToken;
    const selected = Array.from(ids);
    const events: GmailEvent[] = [];
    // 分批限制元数据请求的并发，Promise.all 保持 history 中的首次出现顺序。
    for (let start = 0; start < selected.length; start += 5) {
      const batch = await Promise.all(selected.slice(start, start + 5).map(async id => {
        try {
          const params = new URLSearchParams({ format: "metadata" });
          for (const name of ["From", "Subject", "Date"]) params.append("metadataHeaders", name);
          return mailEvent(await this.request(`messages/${encodeURIComponent(id)}`, eventMessageSchema, params));
        } catch (error) {
          if (error instanceof GmailError && error.kind === "not_found") return undefined;
          throw error;
        }
      }));
      events.push(...batch.filter(event => event !== undefined));
    }
    return { cursor: more ? lastConsumedId ?? cursor : historyId, events, reset: false, more };
  }

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
