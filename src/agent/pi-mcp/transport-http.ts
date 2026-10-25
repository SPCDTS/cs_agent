import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

type FailureCode = "missing_secret" | "auth_failed" | "remote_state_lost" | "transport_error" | "protocol_error" | "catalog_limit" | "message_limit" | "timeout" | "closed";

export class McpConnectionError extends Error {
  constructor(readonly code: FailureCode, message: string) {
    super(message);
    this.name = "McpConnectionError";
  }
}

/** 在 SDK 的 JSON/SSE 解析器读取前限制实际流字节；拒绝同源重定向。 */
export function boundedFetch(endpoint: URL, messageBytes: number, fail: (error: McpConnectionError) => void): FetchLike {
  return async (url, init) => {
    if (new URL(url).origin !== endpoint.origin) throw new McpConnectionError("transport_error", "MCP HTTP 来源变化被拒绝");
    let response: Response;
    try { response = await fetch(url, { ...init, redirect: "manual", credentials: "omit" }); }
    catch { throw new McpConnectionError("transport_error", "MCP HTTP 连接失败"); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new McpConnectionError("transport_error", "MCP HTTP 重定向被拒绝");
    }
    if (!response.ok) {
      await response.body?.cancel();
      // GET 405 是 Streamable HTTP 的正常可选行为。
      if (init?.method === "GET" && response.status === 405) return response;
      if (init?.method === "DELETE" && response.status === 405) return response;
      const code = response.status === 401 || response.status === 403 ? "auth_failed" : response.status === 404 ? "remote_state_lost" : "transport_error";
      throw new McpConnectionError(code, `MCP HTTP 请求失败（${response.status}）`);
    }
    if (!response.body || response.status === 202 || init?.method === "DELETE") return response;
    const isSse = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
    let size = 0;
    let lineBytes = 0;
    let previousCr = false;
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (isSse) {
          // SSE 接受 CR、LF、CRLF；空行结束 event，行和 event 共用严格上限。
          for (const byte of chunk) {
            if (previousCr && byte === 10) { previousCr = false; continue; }
            previousCr = byte === 13;
            size++;
            if (size > messageBytes) {
              const error = new McpConnectionError("message_limit", "MCP 原始消息超出限额");
              fail(error);
              throw error;
            }
            if (byte === 10 || byte === 13) {
              if (lineBytes === 0) size = 0;
              lineBytes = 0;
            } else lineBytes++;
          }
        } else {
          size += chunk.byteLength;
          if (size > messageBytes) {
            const error = new McpConnectionError("message_limit", "MCP 原始消息超出限额");
            fail(error);
            throw error;
          }
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
