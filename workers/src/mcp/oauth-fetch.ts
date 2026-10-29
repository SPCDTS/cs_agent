import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { httpsUrl } from "./config";

export class OAuthFailure extends Error {
  constructor(readonly code: "invalid_state" | "unconfigured" | "auth_required" | "oauth_metadata" | "oauth_network" | "oauth_token" | "server_unavailable") { super(code); }
}

export function createOAuthFetch(allowedOrigins: () => readonly string[]): FetchLike {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    let abort: (() => void) | undefined;
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const url = httpsUrl(String(input));
      if (!allowedOrigins().includes(url.origin)) throw new OAuthFailure("oauth_network");
      const headers = new Headers(init.headers);
      headers.delete("cookie"); headers.delete("host"); headers.delete("content-length");
      // 超时覆盖响应体读取；SDK 解析前先限流，不能只信 Content-Length。
      const work = async () => {
        // Workers 没有浏览器 cookie jar，也不支持 credentials 字段；上面显式去掉 Cookie。
        const response = await fetch(url.href, { ...init, headers, signal, redirect: "manual" });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new OAuthFailure("oauth_network"); }
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body?.getReader();
        try {
          if (reader) for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 262_144) throw new OAuthFailure("oauth_network");
            chunks.push(part.value);
          }
        } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, headers: response.headers });
      };
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        abort = () => reject(new OAuthFailure("oauth_network"));
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      })]);
    } catch { throw new OAuthFailure("oauth_network"); }
    finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); controller.abort(); }
  };
}
