import { z } from "zod";
import { EventSourceError, externalEventSchema, type EventSource } from "../types.js";

const responseSchema = z.object({
  cursor: z.string().regex(/^\d{1,20}$/), events: z.array(externalEventSchema), reset: z.boolean(), more: z.boolean(),
});
const MAX_BYTES = 1_048_576;
export class GmailEventSource implements EventSource {
  readonly id = "gmail";
  private readonly url: URL;
  constructor(private readonly options: { baseUrl: string; authHeader: string }) {
    const base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
      throw new Error("Gmail 事件来源必须是 HTTP(S) origin");
    }
    if (!/^Bearer [!-~]+$/.test(options.authHeader)) throw new Error("Gmail 事件来源缺少有效鉴权头");
    this.url = new URL("/events", base.origin);
  }
  async poll(cursor: string | null, limit: number, signal: AbortSignal) {
    const url = new URL(this.url);
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", String(Math.max(1, Math.min(50, Math.floor(limit)))));
    let response: Response;
    try { response = await fetch(url, { headers: { Authorization: this.options.authHeader }, redirect: "error", signal }); }
    catch { throw new EventSourceError(signal.aborted ? "timeout" : "network"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EventSourceError(response.status === 401 || response.status === 503 ? "auth" : response.status === 403 ? "permission" : response.status === 429 ? "quota" : "upstream");
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel(); throw new EventSourceError("response"); }
    const reader = response.body?.getReader();
    if (!reader) throw new EventSourceError("response");
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) throw new EventSourceError("response");
        chunks.push(next.value);
      }
      const result = responseSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      if (!result.success || result.data.events.some(event => event.source !== this.id)) throw new EventSourceError("response");
      return result.data.reset ? { ...result.data, events: [], more: false } : result.data;
    } catch { throw new EventSourceError(signal.aborted ? "timeout" : "response"); }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
