import path from "node:path";
import { expect, it } from "vitest";
import { sendFixture } from "../agent/send-fixture.js";
import { mediaFixture } from "../context/media-fixture.js";
import { promises as fs } from "node:fs";
import { TRANSPARENT_PNG } from "../agent/helpers.js";
import type { CallBinding } from "../../src/context/media-recall-server.js";
import { imSendRig as setup } from "./im-fixture.js";

it("令牌必需且绑定会话；撤销、缺少调用 id、网关拒绝均拒绝；参数不能改目标", async () => {
  const f = await setup();
  expect((await f.post("send", { text: "攻击" }, { callId: "exec-x" }, "f".repeat(64))).status).toBe(401);
  expect((await f.post("send", { text: "攻击", target: "group:8" })).status).toBe(400);
  expect((await f.post("send", { text: "攻击", ticket: "another" })).status).toBe(400);
  expect((await f.post("send", { text: "攻击" }, {})).status).toBe(400);
  const resolve = f.current.binding;
  f.current.binding = undefined as unknown as CallBinding;
  expect((await f.post("send", { text: "攻击" })).status).toBe(400);
  f.current.binding = resolve;
  f.tokens.revoke(f.threadKey);
  expect((await f.post("send", { text: "攻击" })).status).toBe(401);
  expect(f.call).not.toHaveBeenCalled();
});
it("MCP 校验错误以文本返回；完整 4000 字中文不截断，超限不发", async () => {
  const f = await setup();
  for (const args of [{ text: "" }, { text: "字".repeat(4001) }, { text: "x", files: [{ path: "../qq-bridge.sqlite" }] }]) {
    expect((await f.tool("send_message", args)).isError).toBe(true);
  }
  expect(f.store.listOutboxByTurn("t1")).toHaveLength(0);
  expect((await f.tool("send_message", { text: "字".repeat(4000) })).isError).not.toBe(true);
  expect(f.store.listOutboxByTurn("t1")[0]!.text).toHaveLength(4000);
});
it("同一 callId 重放（含令牌重新签发后）映射到已发消息，不重复发送；跨范围媒体拒绝", async () => {
  const f = await setup();
  const media = await mediaFixture(f.history, f.dir, "group:8");
  expect((await f.post("send", { text: "图", images: [media] })).status).toBe(400);
  const first = await (await f.post("send", { text: "原文" }, { callId: "exec-same" })).json() as { message_id: string };
  const next = f.tokens.issue(f.threadKey);
  expect(await (await f.post("send", { text: "原文" }, { callId: "exec-same" }, next)).json()).toMatchObject({ message_id: first.message_id, already_sent: true });
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(1);
});
it("已召回同范围媒体允许；生成图片来源只允许可信绑定的当前线程根目录", async () => {
  const f = sendFixture(), own = await mediaFixture(f.history, f.dir, "group:7");
  await f.service.send(f.binding, { text: "召回图", images: [own] }, "m");
  const generated = path.join(f.dir, "codex", "generated_images", "current");
  const other = path.join(f.dir, "codex", "generated_images", "other");
  for (const dir of [generated, other]) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, "a.png"), TRANSPARENT_PNG); }
  await f.service.send({ ...f.binding, extraRoots: [generated] }, { text: "生图", images: [path.join(generated, "a.png")] }, "g");
  await expect(f.service.send({ ...f.binding, extraRoots: [generated] }, { text: "其他线程", images: [path.join(other, "a.png")] }, "bad")).rejects.toThrow();
});
it.each(["sent", "sending", "uncertain"] as const)("im 返回 %s 无 message_id 的明确非错误结果，不诱导再次发送", async status => {
  const f = await setup();
  // 调用键为 MCP 的 _meta.callId：<会话>:<callId>。
  const row = f.store.reserveOutbox({ key: `${f.threadKey}:exec-1`, thread_key: f.threadKey, turn_id: "t1", input_key: f.key,
    text: "原内容", images: [], files: [], message_type: "group", target_id: "7", mention_user_id: "1" });
  f.store.markOutboxSending(row.key);
  if (status === "sent") f.store.markOutboxSent(row.key, "");
  if (status === "uncertain") f.store.markOutboxUncertain(row.key);
  const result = await f.tool("send_message", { text: "原内容" }, "exec-1");
  expect(result.isError).not.toBe(true);
  expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
    status, already_sent: true, message_id: null, note: expect.stringContaining("不要重发"),
  });
  expect(f.call).not.toHaveBeenCalled();
});

it("im 首次发送响应丢失返回明确非错误结果；同一调用再次提交不新建消息", async () => {
  const f = await setup();
  f.call.mockImplementationOnce(async () => ({ user_id: 2 })).mockRejectedValueOnce(new Error("连接断开"));
  for (const n of [1, 2]) {
    const result = await f.tool("send_message", { text: "可能送达" }, "exec-lost");
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
      status: "uncertain", already_sent: n === 2, note: expect.stringContaining("不要重发"),
    });
  }
  expect(f.store.listOutboxByTurn("t1")).toHaveLength(1);
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(1);
});
