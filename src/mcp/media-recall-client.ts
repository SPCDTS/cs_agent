/** MCP 不接触 NapCat 或写连接，只向固定 loopback 地址提交本轮令牌。 */
export async function recallViaLoopback(messageId: string, token: string | undefined, port = 8790): Promise<string> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("QQ_RECALL_TOKEN 未配置");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MEDIA_RECALL_PORT 无效");
  const response = await fetch("http://127.0.0.1:" + port + "/recall", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ message_id: messageId }), redirect: "error", signal: AbortSignal.timeout(65_000),
  });
  const body = await response.json() as { text?: unknown; error?: unknown };
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "图片召回失败");
  if (typeof body.text !== "string") throw new Error("图片召回返回格式错误");
  return body.text;
}

/** 图片字节只来自主进程；限制读取量，避免无界缓冲 loopback 响应。 */
export async function viewViaLoopback(file: string, token: string | undefined, port = 8790): Promise<{ type: "image"; data: string; mimeType: string }> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("QQ_RECALL_TOKEN 未配置");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MEDIA_RECALL_PORT 无效");
  const response = await fetch("http://127.0.0.1:" + port + "/view", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ path: file }), redirect: "error", signal: AbortSignal.timeout(65_000),
  });
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

export async function chatsViaLoopback(token: string | undefined, port = 8790): Promise<string> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("QQ_RECALL_TOKEN 未配置");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MEDIA_RECALL_PORT 无效");
  const response = await fetch("http://127.0.0.1:" + port + "/chats", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: "{}", redirect: "error", signal: AbortSignal.timeout(65_000),
  });
  const body = await response.json() as { text?: unknown; error?: unknown };
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "会话列表查询失败");
  if (typeof body.text !== "string") throw new Error("会话列表返回格式错误");
  return body.text;
}
