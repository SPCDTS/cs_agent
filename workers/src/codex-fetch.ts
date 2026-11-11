import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

/** Codex 对较大 Zstd 窗口返回无详情的 400；限制为已实测支持的 1 MiB，保留图片原始内容。 */
export function codexFetch(upstream: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get("content-encoding") !== "zstd") return upstream(request);
    // pi-ai 暂无压缩参数入口，在进入 ModelAlarm 前规范化；不重试模型或工具调用。
    const decoded = zstdDecompressSync(new Uint8Array(await request.arrayBuffer()));
    const body = new Uint8Array(zstdCompressSync(decoded, { params: {
      [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_windowLog]: 20,
    } }));
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return upstream(new Request(request, { headers, body }));
  };
}
