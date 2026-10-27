import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type RequestOptions } from "node:http";
import { BlockList, isIP, type TcpNetConnectOpts } from "node:net";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const privateAddresses = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]] satisfies [string, number][]) {
  privateAddresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] satisfies [string, number][]) {
  privateAddresses.addSubnet(address, prefix, "ipv6");
}
const loopback = (host: string) => host === "::1" || /^127\./u.test(host);
const refused = () => new Error("OAuth 网络请求被拒绝");
type Resolve = (host: string) => Promise<LookupAddress[]>;
const resolveHost: Resolve = host => lookup(host, { all: true });

/** 解析结果直接绑定到 socket lookup，避免校验 DNS 后由 fetch 再解析造成重绑定。 */
async function destination(url: URL, allowLoopbackHttp: boolean, resolve: Resolve = resolveHost) {
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol)) throw refused();
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some(({ address, family }) => {
    const testLoopback = allowLoopbackHttp && loopback(address) && (loopback(host) || host === "localhost");
    return !testLoopback && (url.protocol !== "https:" || privateAddresses.check(address, family === 6 ? "ipv6" : "ipv4"));
  })) throw refused();
  return addresses;
}

export async function validateOAuthRedirect(url: URL, issuer: string, allowLoopbackHttp: boolean): Promise<void> {
  if (url.origin !== new URL(issuer).origin) throw refused();
  await destination(url, allowLoopbackHttp);
}

/** SDK 仅发送字符串或 URLSearchParams；无 cookie、手动重定向、完整响应限额及总超时。 */
export function createOAuthFetch({ allowedOrigins, allowLoopbackHttp = false, resolve = resolveHost }: {
  allowedOrigins: () => readonly string[]; allowLoopbackHttp?: boolean; resolve?: Resolve;
}): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(input), controller = new AbortController();
    if (!allowedOrigins().includes(url.origin)) throw refused();
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const addresses = await Promise.race([destination(url, allowLoopbackHttp, resolve), new Promise<never>((_, reject) => {
        if (signal.aborted) reject(refused());
        else signal.addEventListener("abort", () => reject(refused()), { once: true });
      })]);
      signal.throwIfAborted();
      const headers = new Headers(init.headers);
      headers.delete("cookie"); headers.delete("host"); headers.delete("content-length");
      headers.set("accept-encoding", "identity");
      if (init.body != null && typeof init.body !== "string" && !(init.body instanceof URLSearchParams)) throw refused();
      // 原生 request 不跟随重定向、不使用 cookie jar，等价于 redirect:manual、credentials:omit。
      return await new Promise<Response>((resolve, reject) => {
        const options: RequestOptions & Pick<TcpNetConnectOpts, "autoSelectFamily"> = {
          method: init.method ?? "GET", headers: Object.fromEntries(headers), signal, agent: false, autoSelectFamily: true,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
          },
        };
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, response => {
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) { response.destroy(); reject(refused()); return; }
          const chunks: Buffer[] = []; let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 262_144) { response.destroy(); reject(refused()); } else chunks.push(chunk);
          });
          response.on("error", () => reject(refused()));
          response.on("end", () => {
            const resultHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) {
              for (const part of Array.isArray(value) ? value : [value]) resultHeaders.append(name, part);
            }
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: resultHeaders }));
          });
        });
        request.on("error", () => reject(refused()));
        request.end(init.body?.toString());
      });
    } catch { throw refused(); }
    finally { clearTimeout(timer); }
  };
}
