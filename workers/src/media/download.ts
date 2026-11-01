import { FILE_MAX_BYTES, safeMime } from "./model";

export class MediaDownloadError extends Error {
  constructor(readonly status: number, readonly hostname: string) {
    super("media_download_failed");
    this.name = "MediaDownloadError";
  }
}

export type DownloadDeps = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  resolve?: (hostname: string) => Promise<string[]>;
};
/** 只接受公网单播地址；IPv4 映射、回环、保留网段与 IPv6 局域地址均拒绝。 */
export function publicAddress(raw: string): boolean {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (address.includes(":")) {
    if (!/^[0-9a-f:]+$/.test(address) || !/^[23][0-9a-f]{3}:/.test(address)) return false;
    return !address.startsWith("2001:db8:") && !address.startsWith("2001:0:") && !address.startsWith("2002:");
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const [a = -1, b = -1, c = -1, d = -1] = address.split(".").map(Number);
  if ([a,b,c,d].some(part => part < 0 || part > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
async function dns(hostname: string, signal: AbortSignal): Promise<string[]> {
  const responses = await Promise.all(["A", "AAAA"].map(async type => {
    // Workers 不支持 error 重定向模式；manual 的 3xx 由下方 ok 检查拒绝。
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { Accept: "application/dns-json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: "manual",
    });
    if (!response.ok) throw new Error("media_dns_failed");
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("Answer" in body) || !Array.isArray(body.Answer)) return [];
    return body.Answer.flatMap((entry: unknown) => entry && typeof entry === "object" && "type" in entry && "data" in entry &&
      (entry.type === 1 || entry.type === 28) && typeof entry.data === "string" ? [entry.data] : []);
  }));
  return responses.flat();
}
async function checkedUrl(raw: string, resolve: NonNullable<DownloadDeps["resolve"]>): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("media_url_denied"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("media_url_denied");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || !host.includes(".") && !host.includes(":") || /\.(localhost|local|internal|lan|home|test|invalid)$/.test(host)) throw new Error("media_url_denied");
  const literal = /^[\d.]+$/.test(host) || host.includes(":");
  const addresses = literal ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error("media_url_denied");
  return url;
}
/** 每一跳重做地址检查，流式计量，不信任 Content-Length，不携带宿主或管理员凭据。 */
export async function downloadMedia(raw: string, deps: DownloadDeps = {}): Promise<{ bytes: Uint8Array; mime: string; url: string }> {
  const deadline = AbortSignal.timeout(20_000);
  const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
  const request = deps.fetch ?? fetch, resolve = deps.resolve ?? ((host: string) => dns(host, signal));
  let next = raw;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const url = await checkedUrl(next, resolve);
    signal.throwIfAborted();
    const response = await request(url, { redirect: "manual", signal, headers: { Accept: "*/*" } });
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("Location");
      if (!location || redirects === 3) throw new Error("media_redirect_denied");
      next = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new MediaDownloadError(response.status, url.hostname);
    }
    const mime = safeMime(response.headers.get("Content-Type") ?? undefined);
    const length = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(length) && length > FILE_MAX_BYTES) { await response.body.cancel(); throw new Error("too_large"); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > FILE_MAX_BYTES) { await reader.cancel(); throw new Error("too_large"); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, mime, url: url.href };
  }
  throw new Error("media_redirect_denied");
}
