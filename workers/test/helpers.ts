import worker from "../src/index";
import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { event, input } from "./fixtures/qq";
import { threadView } from "../src/admin/read-views";

export { event, input };

const Action = Type.Object({ action: Type.String(), echo: Type.String(), params: Type.Object({
  user_id: Type.Optional(Type.String()), group_id: Type.Optional(Type.String()),
  message: Type.Optional(Type.Array(Type.Object({ type: Type.String(), data: Type.Object({ text: Type.Optional(Type.String()), qq: Type.Optional(Type.String()) }) }))),
}) });

export function reply(socket: WebSocket, echo: string, messageId = 90000001) {
  socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: messageId }, echo }));
}
export async function connect(sockets: WebSocket[], groupNames = true) {
  const response = await SELF.fetch("https://test/onebot", { headers: { Upgrade: "websocket", Authorization: "Bearer t" } });
  if (!response.webSocket) throw new Error("missing websocket");
  const socket = response.webSocket;
  socket.accept();
  sockets.push(socket);
  const frames: unknown[] = [];
  socket.addEventListener("message", event => {
    const frame: unknown = JSON.parse(String(event.data));
    frames.push(frame);
    if (groupNames && Check(Action, frame) && frame.action === "get_group_info") {
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { group_name: "测试群" }, echo: frame.echo }));
    }
  });
  return { socket, frames };
}
export async function action(frames: unknown[], index = 0, name = "send_group_msg") {
  const matching = () => frames.filter(frame => Check(Action, frame) && frame.action === name);
  await expect.poll(() => matching().length, { timeout: 5000 }).toBeGreaterThan(index);
  const frame = matching()[index];
  if (!Check(Action, frame)) throw new Error("invalid action");
  return frame;
}
export async function sendPrivate(text: string, userId = "10000003") {
  return await env.BRIDGE.getByName("napcat").send({ kind: "private", userId }, text);
}

export function adminHealth() {
  return worker.fetch(new Request("https://test/admin/health", { headers: { Authorization: "Bearer test-health" } }), { ...env, ADMIN_TOKEN: "test-health" });
}
export async function syncedView(thread: string) {
  await env.THREAD.getByName(thread).syncAdminView(thread);
  return threadView(env, thread);
}
