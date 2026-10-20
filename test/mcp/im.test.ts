import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RecallTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import { sendFixture } from "../agent/send-fixture.js";
import { mediaFixture } from "../context/media-fixture.js";
import { promises as fs } from "node:fs";
import { TRANSPARENT_PNG } from "../../src/media/gen/image-gen.js";
import { resolveAttachmentDir } from "../../src/media/attach-paths.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const f = sendFixture();
  const tokens = new RecallTokens({ recall: async () => ({ text: "", images: [] }) }, 5, undefined, {
    send: (b, attempt, args, signal) => f.service.send({ ...f.binding, ticket: b.ticket, source: b.source,
      access: b.access, workdir: b.workdir! }, args, { attempt }, signal),
    release: (ticket, attempt) => f.service.releaseAttempt(ticket, attempt),
  });
  const server = await startMediaRecallServer(tokens, 0); cleanup.push(() => server.close());
  const lease = tokens.issue({ ...f.binding, deadline: Date.now() + 60_000 });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/mcp/im.js", import.meta.url))],
    env: { ...process.env, IM_TOKEN: lease.token, MEDIA_RECALL_PORT: String(server.port) } as Record<string, string>, stderr: "pipe" }));
  cleanup.push(() => client.close());
  const post = (body: unknown, token = lease.token) => fetch(`http://127.0.0.1:${server.port}/send`, {
    method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(body),
  });
  return { ...f, tokens, server, lease, client, post };
}
it("独立 im stdio 工具立即发消息与附件，返回 message_id；qq_context 不再发送", async () => {
  const f = await setup();
  expect((await f.client.listTools()).tools.map(t => t.name)).toEqual(["send_message"]);
  const result = await f.client.callTool({ name: "send_message", arguments: { text: "报告", images: ["image.png"], files: [{ path: "file.txt", name: "报告.txt" }] } });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ message_id: "1" });
  expect(f.call.mock.calls.map(c => c[0])).toEqual(["get_login_info", "send_group_msg", "upload_group_file"]);
  const old = await f.client.callTool({ name: "qq_send_file", arguments: { path: "file.txt" } });
  expect(old.isError).toBe(true);
});
it("令牌必需且绑定来源；撤销、过期、无发送绑定均拒绝；参数不能改目标", async () => {
  const f = await setup();
  expect((await f.post({ text: "攻击" }, "f".repeat(64))).status).toBe(401);
  expect((await f.post({ text: "攻击", target: "group:8" })).status).toBe(400);
  expect((await f.post({ text: "攻击", ticket: "another" })).status).toBe(400);
  const readOnly = f.tokens.issue({ ticket: f.ticket, access: f.binding.access, deadline: Date.now() + 60_000 });
  expect((await f.post({ text: "攻击" }, readOnly.token)).status).toBe(400);
  const wrong = f.tokens.issue({ ...f.binding, source: { type: "group", user_id: "9", group_id: "8" }, deadline: Date.now() + 60_000 });
  expect((await f.post({ text: "攻击" }, wrong.token)).status).toBe(400);
  const expired = f.tokens.issue({ ...f.binding, deadline: Date.now() + 10 });
  await new Promise(r => setTimeout(r, 25));
  expect((await f.post({ text: "攻击" }, expired.token)).status).toBe(401);
  f.lease.revoke();
  expect((await f.post({ text: "攻击" })).status).toBe(401);
  expect(f.call).not.toHaveBeenCalled();
});
it("MCP 校验错误以文本返回；完整 4000 字中文不截断，超限不发", async () => {
  const f = await setup();
  for (const args of [{ text: "" }, { text: "字".repeat(4001) }, { text: "x", files: [{ path: "../qq-bridge.sqlite" }] }]) {
    expect((await f.client.callTool({ name: "send_message", arguments: args })).isError).toBe(true);
  }
  expect(f.service.rows(f.ticket)).toHaveLength(0);
  expect((await f.client.callTool({ name: "send_message", arguments: { text: "字".repeat(4000) } })).isError).not.toBe(true);
  expect(f.service.rows(f.ticket)[0]!.text).toHaveLength(4000);
});
it("同票据新令牌重启计数、映射第 n 条，不重复发送；跨范围媒体拒绝", async () => {
  const f = await setup();
  const media = await mediaFixture(f.history, f.dir, "group:8");
  expect((await f.post({ text: "图", images: [media] })).status).toBe(400);
  const first = await (await f.post({ text: "原文" })).json() as { message_id: string };
  f.lease.revoke();
  const next = f.tokens.issue({ ...f.binding, deadline: Date.now() + 60_000 });
  expect(await (await f.post({ text: "新措辞" }, next.token)).json()).toMatchObject({ message_id: first.message_id, already_sent: true });
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(1);
});
it("已召回同范围媒体允许；生成图片来源只允许可信绑定的当前线程根目录", async () => {
  const f = sendFixture(), own = await mediaFixture(f.history, f.dir, "group:7");
  await f.service.send(f.binding, { text: "召回图", images: [own] }, { callId: "m" });
  const generated = path.join(f.dir, "codex", "generated_images", "current");
  const other = path.join(f.dir, "codex", "generated_images", "other");
  for (const dir of [generated, other]) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, "a.png"), TRANSPARENT_PNG); }
  await f.service.send({ ...f.binding, extraRoots: [generated] }, { text: "生图", images: [path.join(generated, "a.png")] }, { callId: "g" });
  await expect(f.service.send({ ...f.binding, extraRoots: [generated] }, { text: "其他线程", images: [path.join(other, "a.png")] }, { callId: "bad" })).rejects.toThrow();
});
it("目录解析仍拒绝相对路径、注入字符、..、根目录、深层目录和链接", async () => {
  const f = sendFixture(), root = f.dir;
  for (const dir of ["relative", root, path.join(root, "a", "b"), `${root}/a/../x`, path.join(root, 'bad"'), path.join(root, "bad name")]) {
    await expect(resolveAttachmentDir(dir, root, "QQ_FILE_DIR")).rejects.toThrow();
  }
  const valid = path.join(root, "ticket_1");
  expect(await resolveAttachmentDir(valid, root, "QQ_FILE_DIR")).toBe(await fs.realpath(valid));
  const link = path.join(root, "alias"); await fs.symlink(valid, link, "junction");
  await expect(resolveAttachmentDir(link, root, "QQ_FILE_DIR")).rejects.toThrow();
});


it.each(["sent", "sending", "uncertain"] as const)("im 返回 %s 无 message_id 的明确非错误结果，不诱导再次发送", async status => {
  const f = await setup();
  const row = f.store.reserveOutbox({ ticket: f.ticket, text: "原内容", images: [], files: [], call_id: null,
    message_type: "group", target_id: "7", mention_user_id: "1" });
  f.store.markOutboxSending(row.key);
  if (status === "sent") f.store.markOutboxSent(row.key, "");
  if (status === "uncertain") f.store.markOutboxUncertain(row.key);
  const result = await f.client.callTool({ name: "send_message", arguments: { text: "原内容" } });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
    status, already_sent: true, message_id: null, note: expect.stringContaining("不要重发"),
  });
  expect(f.call).not.toHaveBeenCalled();
});

it("im 首次发送响应丢失返回明确非错误结果；同文再次调用不新建消息", async () => {
  const f = await setup();
  f.call.mockImplementationOnce(async () => ({ user_id: 2 })).mockRejectedValueOnce(new Error("连接断开"));
  for (const n of [1, 2]) {
    const result = await f.client.callTool({ name: "send_message", arguments: { text: "可能送达" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
      status: "uncertain", already_sent: n === 2, note: expect.stringContaining("不要重发"),
    });
  }
  expect(f.service.rows(f.ticket)).toHaveLength(1);
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(1);
});
