import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { httpsUrl } from "./config";
import { readBoundedBytes } from "../shared/http-body";

const OAUTH_CODES = ["invalid_state", "unconfigured", "auth_required", "oauth_metadata", "oauth_network", "oauth_token", "server_unavailable"] as const;
type OAuthCode = typeof OAUTH_CODES[number];
export class OAuthFailure extends Error {
  constructor(readonly code: OAuthCode) { super(code); }
}
const isOAuthCode = (value: string): value is OAuthCode => (OAUTH_CODES as readonly string[]).includes(value);
// RPC/SDK 原始错误可能含远端正文；HTTP 响应只按消息白名单输出分类。
export const oauthErrorCode = (error: unknown): OAuthCode | "invalid_request" => error instanceof Error && isOAuthCode(error.message) ? error.message : "invalid_request";

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
        const bytes = await readBoundedBytes(response, { maxBytes: 262_144, checkContentLength: false });
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
