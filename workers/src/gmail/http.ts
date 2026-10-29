export type GmailErrorKind = "auth" | "permission" | "quota" | "network" | "response" | "timeout" | "upstream" | "not_found" | "input";

/** 只携带固定分类；远端正文、URL 与凭据都不穿过这个边界。 */
export class GmailError extends Error {
  constructor(readonly kind: GmailErrorKind) { super(kind); }
}
export const errorKind = (error: unknown): GmailErrorKind => error instanceof GmailError ? error.kind : "upstream";

export function statusError(status: number): GmailError {
  switch (status) {
    case 400: return new GmailError("input");
    case 401: return new GmailError("auth");
    case 403: return new GmailError("permission");
    case 404: return new GmailError("not_found");
    case 429: return new GmailError("quota");
    default: return new GmailError("upstream");
  }
}

const ORIGINS = new Set(["https://gmail.googleapis.com", "https://oauth2.googleapis.com"]);
const LIMIT = 8 * 1024 * 1024;

export async function requestJson(url: URL, init: RequestInit = {}, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  if (!ORIGINS.has(url.origin) || url.username || url.password || url.hash) throw new GmailError("upstream");
  const timeout = AbortSignal.timeout(30_000), budget = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: budget });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new GmailError("upstream"); }
    if (Number(response.headers.get("content-length")) > LIMIT) { await response.body?.cancel(); throw new GmailError("response"); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > LIMIT) throw new GmailError("response");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks))); }
    catch { if (response.ok) throw new GmailError("response"); }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof GmailError) throw error;
    throw new GmailError(timeout.aborted || signal?.aborted ? "timeout" : "network");
  }
}
