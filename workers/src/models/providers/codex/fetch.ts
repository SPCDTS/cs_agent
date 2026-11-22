import { zstdDecompressSync } from "node:zlib";

/** Codex 的 Zstd 解码会拒绝部分长请求；统一使用端点支持的原始 JSON。 */
export function codexFetch(upstream: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get("content-encoding") !== "zstd") return upstream(request);
    // pi-ai 暂无关闭压缩的入口；在进入 ModelAlarm 前还原字节，不截断内容或重试请求。
    const body = new Uint8Array(zstdDecompressSync(new Uint8Array(await request.arrayBuffer())));
    const headers = new Headers(request.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return upstream(new Request(request, { headers, body }));
  };
}
