import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { MAX_IMAGE_BYTES, MIN_IMAGE_BYTES } from './limits.js';
import { validateImageHeader } from './header.js';

export interface DownloadHooks {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** 仅供本地假服务器测试；生产不注入此传输钩子。 */
  request?: (url: URL, options: RequestOptions, cb: (res: IncomingMessage) => void) => ReturnType<typeof httpRequest>;
}

export function forbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a,b] = address.split('.').map(Number) as [number,number];
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
  }
  if (family !== 6) return true;
  // URL 规范化把 IPv4 映射后缀转为十六进制，再展开 IPv6。
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1,-1);
  const [left, right] = normalized.split('::');
  const l = left ? left.split(':') : [], r = right ? right.split(':') : [];
  const words = (right !== undefined ? [...l, ...Array(8-l.length-r.length).fill('0'), ...r] : l).map(x => parseInt(x,16));
  if (words.slice(0,5).every(x => x === 0) && words[5] === 65535) {
    return forbiddenAddress(`${words[6]! >>> 8}.${words[6]! & 255}.${words[7]! >>> 8}.${words[7]! & 255}`);
  }
  return words.every(x => x === 0) || (words.slice(0,7).every(x => x === 0) && words[7] === 1) ||
    (words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80 || (words[0]! & 0xff00) === 0xff00;
}

async function response(url: URL, signal: AbortSignal, hooks: DownloadHooks): Promise<IncomingMessage> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('参考图只接受无凭据的 HTTP URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'host.docker.internal' || host.endsWith('.internal')) throw new Error('参考图地址禁止访问内部网络');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await (hooks.resolve ?? (h => lookup(h, { all: true })))(host);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => forbiddenAddress(a.address))) throw new Error('参考图地址禁止访问内部网络');
  const pinned = addresses[0]!;
  const connectionUrl = new URL(url);
  connectionUrl.hostname = pinned.family === 6 ? '[' + pinned.address + ']' : pinned.address;
  // URL 直接使用已校验的 IP；Host、TLS SNI/证书校验保留原主机名，lookup 同样固定。
  return new Promise((resolve, reject) => {
    const request = hooks.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
    const req = request(connectionUrl, { signal, agent: false, headers: { Host: url.host },
      ...(url.protocol === 'https:' ? { servername: host } : {}), lookup: (_hostname, options, cb) => {
      if (options.all) cb(null, [pinned]); else cb(null, pinned.address, pinned.family);
    } }, resolve);
    req.on('error', () => reject(signal.aborted ? signal.reason : new Error('参考图下载连接失败')));
    req.end();
  });
}

export async function downloadImage(url: string, signal: AbortSignal, hooks: DownloadHooks = {}): Promise<Buffer> {
  let target: URL;
  try { target = new URL(url); } catch { throw new Error('参考图没有可下载的 HTTP URL'); }
  for (let hop = 0; ; hop++) {
    const res = await response(target, signal, hooks);
    if ([301,302,303,307,308].includes(res.statusCode ?? 0)) {
      res.destroy();
      if (hop >= 3) throw new Error('参考图重定向超过 3 次');
      if (!res.headers.location) throw new Error('参考图重定向缺少地址');
      target = new URL(res.headers.location, target); continue;
    }
    try {
      if (res.statusCode !== 200) throw new Error('参考图下载失败');
      if (Number(res.headers['content-length']) > MAX_IMAGE_BYTES) throw new Error('参考图超过 10 MiB');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of res) {
        size += chunk.length; if (size > MAX_IMAGE_BYTES) throw new Error('参考图超过 10 MiB');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length < MIN_IMAGE_BYTES) throw new Error('参考图魔数无效');
      validateImageHeader(bytes); return bytes;
    } finally { res.destroy(); }
  }
}
