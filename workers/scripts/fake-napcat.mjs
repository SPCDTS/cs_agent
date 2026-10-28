import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";

const token = process.env.NAPCAT_TOKEN;
const owner = process.env.QQ_OWNER?.split(",")[0]?.trim();
if (!token || !owner) throw new Error("请通过环境变量提供 NAPCAT_TOKEN 和 QQ_OWNER");
const base = process.env.SMOKE_URL ?? "http://127.0.0.1:8789";
const wsUrl = new URL("/onebot", base);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
// Node 24 的内置 WebSocket 支持 WebSocketInit.headers，无需安装 ws。
const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
const deadline = setTimeout(() => { console.error("冒烟超时"); process.exit(1); }, 20_000);
const frames = [];
socket.addEventListener("message", event => { frames.push(JSON.parse(String(event.data))); });
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket 握手失败，请检查本地端口和 token")), { once: true });
  });
  const lifecycle = { post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect", self_id: 42 };
  const input = { post_type: "message", message_type: "private", self_id: 42, user_id: owner,
    message_id: Date.now(), time: Math.floor(Date.now() / 1000), message: [{ type: "text", data: { text: "P0 smoke" } }] };
  // 只打印本脚本构造的合成测试帧；生产 Worker 不记录消息正文。
  for (const frame of [lifecycle, input]) {
    console.log("SEND", JSON.stringify(frame));
    socket.send(JSON.stringify(frame));
  }
  while (frames.length === 0) await pause(25);
  const frame = frames[0];
  console.log("RECV", JSON.stringify(frame));
  assert.equal(frame.action, "send_private_msg");
  assert.equal(frame.params.user_id, owner);
  assert.equal(frame.params.message[0].data.text, "echo: P0 smoke");
  const response = { status: "ok", retcode: 0, data: { message_id: 99 }, echo: frame.echo };
  console.log("SEND", JSON.stringify(response));
  socket.send(JSON.stringify(response));
  await pause(300);
  socket.send(JSON.stringify(input));
  await pause(1000);
  assert.equal(frames.length, 1, "重复入站不能产生第二条回复");
  const healthResponse = await fetch(new URL("/healthz", base));
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.bridge.connected, true);
  assert.deepEqual(health.model, { provider: "faux", id: "test" });
  console.log("HEALTH", JSON.stringify(health));
  console.log("PASS: owner round trip and duplicate suppression");
} finally {
  clearTimeout(deadline);
  socket.close();
}
