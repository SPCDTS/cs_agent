import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { forbiddenAddress } from "../../media/download.js";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

export interface WebOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  backoffMs?: number;
}

/** 复用入站下载 IP 策略；请求由 DeepSeek 服务端抓取，不在本机访问目标页面。 */
export async function publicPageUrl(raw: string, resolve: NonNullable<WebOptions["resolve"]> = h => lookup(h, { all: true })): Promise<string> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || (!isIP(host) && !host.includes("."))) {
    throw new Error("fetch_page 只允许公开 HTTP(S) 地址");
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some(a => forbiddenAddress(a.address))) throw new Error("fetch_page 禁止访问内部网络");
  return url.href;
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === "string" ? v : "";
const cap = (s: string, n: number) => s.length <= n ? s : s.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";

export class DeepSeekWeb {
  constructor(private readonly opts: WebOptions = {}) {}

  private async post(tool: string, body: object, signal?: AbortSignal): Promise<unknown> {
    const key = this.opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_APIKEY;
    if (!key) throw new Error("联网检索不可用：未配置 DeepSeek API key");
    const sig = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    for (let attempt = 0; ; attempt++) {
      const res = await (this.opts.fetch ?? fetch)(`https://api.deepseek.com/v1/tools/${tool}`, {
        method: "POST", redirect: "error", signal: sig,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.status === 429 && attempt === 0) {
        await res.body?.cancel();
        await delay(this.opts.backoffMs ?? 1000, undefined, { signal: sig });
        continue;
      }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`DeepSeek ${tool} HTTP ${res.status}`); }
      // 不把服务端错误正文带回模型或日志（可能含请求凭据）。限制响应体内存。
      const reader = res.body?.getReader();
      if (!reader) throw new Error("DeepSeek 返回空响应");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > 2 * 1024 * 1024) throw new Error("DeepSeek 响应过大");
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new Error("DeepSeek 返回无效 JSON"); }
    }
  }

  async search(query: string, count = 8, signal?: AbortSignal): Promise<string> {
    if (!query.trim() || query.length > 128) throw new Error("query 必须为 1–128 字");
    const raw = await this.post("search", { query, count: Math.max(1, Math.min(8, Math.floor(count))), need_content: false }, signal);
    const root = record(raw); const data = record(root.data);
    const rows = [root.results, data.results, root.data, raw].find(Array.isArray);
    if (!rows) throw new Error("DeepSeek search 响应缺少 results");
    const text = rows.map(record).sort((a, b) => (Number(b.rerank_score) || 0) - (Number(a.rerank_score) || 0))
      .slice(0, count).map(r => [str(r.title), str(r.date ?? r.published_date), str(r.summary), str(r.url)].join(" / ")).join("\n");
    return cap(text || "（没有搜索结果）", 2500);
  }

  async page(url: string, signal?: AbortSignal): Promise<string> {
    const sig = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    const target = await awaitWithContext(publicPageUrl(url, this.opts.resolve), withAbortSignal(sig, BACKGROUND_CONTEXT));
    signal?.throwIfAborted();
    const root = record(await this.post("fetch", { url: target }, sig));
    const content = root.content ?? record(root.data).content;
    if (typeof content !== "string") throw new Error("DeepSeek fetch 响应缺少 content");
    return cap(content || "（页面正文为空）", 4000);
  }
}
