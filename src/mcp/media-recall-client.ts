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
