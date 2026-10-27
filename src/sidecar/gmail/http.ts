import { GmailError } from "./errors.js";

export const RESPONSE_LIMIT = 8 * 1024 * 1024;

export async function requestJson(url: URL, allowedOrigins: ReadonlySet<string>, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  if (!allowedOrigins.has(url.origin) || url.username || url.password || url.hash) {
    throw new GmailError("config", "Gmail 请求目标不在允许范围内");
  }
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > RESPONSE_LIMIT) throw new GmailError("response", "Google 响应超过 8 MiB 限制", response.status);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch {
      if (response.ok) throw new GmailError("response", "Google 响应格式无效", response.status);
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof GmailError) throw error;
    throw new GmailError("network", "Google 请求超时或网络连接失败，请稍后检查结果");
  }
}
