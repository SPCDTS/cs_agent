/**
 * MCP 不接触 NapCat 或写连接，只向固定 loopback 地址提交线程令牌与本次调用的归属（tools/call 的 _meta），
 * 由主进程按会话当前回合求出身份与范围（docs/ARCHITECTURE.md §9）。
 */
import type { CallContext, CallMeta } from "../context/media-recall-server.js";

const META_HEADER = "x-cs-call-meta";
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const field = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined;

/**
 * 从 MCP tools/call 的 _meta 取调用归属：callId（与 mcpToolCall 条目 id 相同）与 x-codex-turn-metadata 的 thread_id / turn_id。
 * 元数据可能是对象或 JSON 字符串；非法字段忽略（主进程据缺失拒绝需要它的调用）。
 */
export function callMetaOf(meta: unknown): CallMeta {
  const m = object(meta);
  let turn = m["x-codex-turn-metadata"];
  if (typeof turn === "string") {
    try { turn = JSON.parse(turn); } catch { turn = undefined; }
  }
  const t = object(turn);
  const callId = field(m.callId), threadId = field(t.thread_id), turnId = field(t.turn_id);
  return { ...(callId ? { callId } : {}), ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };
}

/** 向主进程 loopback 端点提交一次调用。 */
export async function loopbackPost(endpoint: string, body: unknown, token: string | undefined, port: number, meta: CallMeta,
  timeoutMs = 65_000): Promise<Response> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("线程令牌未配置");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MEDIA_RECALL_PORT 无效");
  return fetch(`http://127.0.0.1:${port}/${endpoint}`, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", [META_HEADER]: JSON.stringify(meta) },
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 解析 JSON 响应；非 2xx 抛出主进程给出的错误文本。 */
export async function loopbackJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json() as T & { error?: unknown };
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : fallback);
  return body;
}

export async function recallViaLoopback(messageId: string, token: string | undefined, port = 8790, meta: CallMeta = {}): Promise<string> {
  const body = await loopbackJson<{ text?: unknown }>(await loopbackPost("recall", { message_id: messageId }, token, port, meta), "图片召回失败");
  if (typeof body.text !== "string") throw new Error("图片召回返回格式错误");
  return body.text;
}

/** 图片字节只来自主进程；限制读取量，避免无界缓冲 loopback 响应。 */
export async function viewViaLoopback(file: string, token: string | undefined, port = 8790, meta: CallMeta = {}): Promise<{ type: "image"; data: string; mimeType: string }> {
  const response = await loopbackPost("view", { path: file }, token, port, meta);
  const maxBase64 = 4 * Math.ceil(10 * 1024 * 1024 / 3);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片查看返回为空");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBase64 + 1024) throw new Error("图片查看响应过大");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { type?: unknown; data?: unknown; mimeType?: unknown; error?: unknown };
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "图片查看失败");
  if (body.type !== "image" || typeof body.data !== "string" || body.data.length > maxBase64 ||
      Buffer.byteLength(body.data, "base64") > 10 * 1024 * 1024 ||
      typeof body.mimeType !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(body.mimeType)) throw new Error("图片查看返回格式错误");
  return { type: "image", data: body.data, mimeType: body.mimeType };
}

export async function chatsViaLoopback(token: string | undefined, port = 8790, meta: CallMeta = {}): Promise<string> {
  const body = await loopbackJson<{ text?: unknown }>(await loopbackPost("chats", {}, token, port, meta), "会话列表查询失败");
  if (typeof body.text !== "string") throw new Error("会话列表返回格式错误");
  return body.text;
}

/** 本次调用的上下文：读取范围、回合与线程。调用不属于会话当前回合时主进程拒绝。 */
export async function contextViaLoopback(token: string | undefined, port = 8790, meta: CallMeta = {}): Promise<CallContext> {
  const body = await loopbackJson<Partial<CallContext>>(await loopbackPost("context", {}, token, port, meta, 30_000), "调用上下文查询失败");
  if (typeof body.access !== "string" || typeof body.turn_id !== "string" || typeof body.session !== "string") {
    throw new Error("调用上下文返回格式错误");
  }
  return { access: body.access, turn_id: body.turn_id, session: body.session };
}
