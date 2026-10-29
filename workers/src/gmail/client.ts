import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { PollResult } from "../events/model";
import { GmailError, requestJson, statusError } from "./http";
import { buildMime, header, MessageSchema, renderMessage, singleLine, type GmailMessage, type MailDraft } from "./mime";
import type { GmailAuth } from "./oauth";

const HistoryId = Type.String({ pattern: "^[0-9]{1,20}$" });
const ListSchema = Type.Object({ messages: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1 }) }))) });
const SentSchema = Type.Object({ id: Type.String({ minLength: 1 }), threadId: Type.String({ minLength: 1 }) });
const ProfileSchema = Type.Object({ historyId: HistoryId });
const WatchSchema = Type.Object({ historyId: HistoryId, expiration: Type.String({ pattern: "^[0-9]{1,16}$" }) });
const HistorySchema = Type.Object({
  historyId: HistoryId, nextPageToken: Type.Optional(Type.String()),
  history: Type.Optional(Type.Array(Type.Object({
    id: HistoryId, messagesAdded: Type.Optional(Type.Array(Type.Object({ message: Type.Object({ id: Type.String({ minLength: 1 }) }) }))),
  }))),
});
export type SendRequest = MailDraft & { inReplyTo?: string; threadId?: string };

function mailEvent(message: GmailMessage) {
  const internal = message.internalDate?.trim() ? Number(message.internalDate) : Number.NaN, date = Date.parse(header(message, "Date"));
  return { source: "gmail", externalId: message.id, kind: "mail.received", ref: message.id,
    occurredAt: Number.isSafeInteger(internal) && internal >= 0 ? internal : Number.isFinite(date) ? date : Date.now(),
    title: header(message, "Subject"), summary: message.snippet ?? "", actor: header(message, "From"), labels: message.labelIds ?? [] };
}

/** 只在 EventsDO 里运行；所有出站请求都经 requestJson 的目标白名单与上限。 */
export class GmailClient {
  constructor(private readonly auth: GmailAuth) {}

  private async request<S extends TSchema>(path: string, schema: S, options: { params?: URLSearchParams; body?: unknown; signal?: AbortSignal } = {}): Promise<Static<S>> {
    const url = new URL(`/gmail/v1/users/me/${path}`, "https://gmail.googleapis.com");
    if (options.params) url.search = options.params.toString();
    const token = await this.auth.accessToken();
    const response = await requestJson(url, {
      method: options.body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }, options.signal);
    if (response.status === 401) this.auth.invalidate();
    if (response.status < 200 || response.status >= 300) throw statusError(response.status);
    if (!Check(schema, response.body)) throw new GmailError("response");
    return response.body;
  }

  private message(id: string, format: "full" | "metadata", headers: string[] = [], signal?: AbortSignal) {
    const params = new URLSearchParams({ format });
    for (const name of headers) params.append("metadataHeaders", name);
    return this.request(`messages/${encodeURIComponent(id)}`, MessageSchema, { params, signal });
  }

  async search(query: string, maxResults: number): Promise<string> {
    const list = await this.request("messages", ListSchema, { params: new URLSearchParams({ q: query, maxResults: String(maxResults) }) });
    const ids = (list.messages ?? []).slice(0, maxResults).map(item => item.id);
    if (!ids.length) return "未找到匹配的邮件。";
    const rows: string[] = [];
    for (let start = 0; start < ids.length; start += 5) {
      rows.push(...await Promise.all(ids.slice(start, start + 5).map(async id => {
        const message = await this.message(id, "metadata", ["From", "Subject", "Date"]);
        const snippet = [...singleLine(message.snippet ?? "")].slice(0, 200).join("");
        return [message.id, header(message, "Date"), header(message, "From"), header(message, "Subject")].map(singleLine).join(" | ") + "\n  " + snippet;
      })));
    }
    return rows.join("\n");
  }

  async read(id: string): Promise<string> {
    return renderMessage(await this.message(id, "full"));
  }

  async send(request: SendRequest): Promise<{ id: string; threadId: string }> {
    const original = request.inReplyTo ? await this.message(request.inReplyTo, "metadata", ["Message-ID", "Subject", "References"]) : undefined;
    const raw = buildMime(request, original ? { messageId: header(original, "Message-ID"), references: header(original, "References"), subject: header(original, "Subject") } : undefined);
    const threadId = original?.threadId ?? request.threadId;
    return this.request("messages/send", SentSchema, { body: { raw: Buffer.from(raw, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) } });
  }

  watch(topicName: string): Promise<Static<typeof WatchSchema>> {
    return this.request("watch", WatchSchema, { body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" } });
  }

  private async reset(signal: AbortSignal): Promise<PollResult> {
    const profile = await this.request("profile", ProfileSchema, { signal });
    return { cursor: profile.historyId, events: [], reset: true, more: false };
  }

  /** 游标为 historyId：首次只取当前位置不回溯；过旧（404）重置；history 记录整条消费，多出的留给下一次。 */
  async events(cursor: string | null, limit: number, signal: AbortSignal): Promise<PollResult> {
    if (!cursor) return this.reset(signal);
    const ids = new Set<string>();
    let historyId = cursor, nextPageToken: string | undefined, lastConsumed: string | undefined, more = false;
    try {
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ startHistoryId: cursor, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "100" });
        if (nextPageToken) params.set("pageToken", nextPageToken);
        const result = await this.request("history", HistorySchema, { params, signal });
        historyId = result.historyId; nextPageToken = result.nextPageToken;
        for (const record of result.history ?? []) {
          const added = new Set(record.messagesAdded?.map(item => item.message.id));
          const fresh = [...added].filter(id => !ids.has(id)).length;
          if (ids.size >= limit || (lastConsumed !== undefined && ids.size + fresh > limit)) { more = true; break; }
          for (const id of added) ids.add(id);
          lastConsumed = record.id;
        }
        if (more || !nextPageToken || ids.size >= limit) break;
      }
    } catch (error) {
      if (error instanceof GmailError && error.kind === "not_found") return this.reset(signal);
      throw error;
    }
    more ||= !!nextPageToken;
    const selected = [...ids], events: unknown[] = [];
    // 元数据并发 ≤5，按 history 首次出现顺序；只取头部与摘要，不读正文。
    for (let start = 0; start < selected.length; start += 5) {
      const batch = await Promise.all(selected.slice(start, start + 5).map(async id => {
        try { return mailEvent(await this.message(id, "metadata", ["From", "Subject", "Date"], signal)); }
        catch (error) {
          if (error instanceof GmailError && error.kind === "not_found") return undefined;
          throw error;
        }
      }));
      events.push(...batch.filter(event => event !== undefined));
    }
    return { cursor: more ? lastConsumed ?? cursor : historyId, events, reset: false, more };
  }
}
