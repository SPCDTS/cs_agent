import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { tmp } from "../agent/helpers.js";
import { readFileAttachments } from "../../src/media/attach.js";
import { resolveAttachmentDir } from "../../src/media/attach-paths.js";
import { ContextStore } from "../../src/context/store.js";
import { normalizeMessage } from "../../src/qq/policy.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const entry = fileURLToPath(new URL("../../dist/mcp/qq-context.js", import.meta.url));
const clients: Client[] = [], dirs: string[] = [], stores: ContextStore[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function setup(extra: Record<string, string> = {}) {
  const dir = tmp("cs-mcp-attach-"); dirs.push(dir);
  const data = path.join(dir, "data"), base = path.join(dir, "work");
  const work = path.join(base, "group_7"), files = path.join(data, "files", "t1"), images = path.join(data, "images", "t1");
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, "报告.txt"), "报告"); await fs.writeFile(path.join(work, "图.png"), PNG);
  const env = { ...process.env, DATA_DIR: data, WORKSPACE_DIR: base, QQ_WORKDIR: work, QQ_ATTACH_DIR: images, QQ_FILE_DIR: files, QQ_ACCESS: "group:7", ...extra } as Record<string, string>;
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" })); clients.push(client);
  return { client, dir, data, work, base, files, images };
}

it("stdio 登记图片和文件、回传文本、应用配置，拒绝额外访问参数", async () => {
  const o = await setup({ ATTACH_FILES_MAX: "1", ATTACH_FILE_MAX_MB: "1", ATTACH_FILE_DENY_EXT: ".zip" });
  expect(await o.client.callTool({ name: "qq_send_file", arguments: { path: "报告.txt", name: "../发出.txt" } })).toMatchObject({ content: [{ text: "已登记，将随回复发送（第 1/1 个，0.00 MiB）" }] });
  expect(await o.client.callTool({ name: "qq_send_image", arguments: { path: "图.png" } })).toMatchObject({ content: [{ text: "已登记，将随回复发送（第 1/4 张）" }] });
  expect((await readFileAttachments(o.files))[0]!.name).toBe("发出.txt");
  for (const args of [{ path: "图.png" }, { path: "报告.txt", name: "a.zip" }, { path: "报告.txt", access: "all" }]) {
    expect((await o.client.callTool({ name: "qq_send_file", arguments: args })).isError).toBe(true);
  }
});

it("stdio 对媒体使用 ContextStore 和 QQ_ACCESS 校验归属", async () => {
  const o = await setup(); const store = new ContextStore(o.data); stores.push(store);
  const sha = createHash("sha256").update(PNG).digest("hex"), media = path.join(o.data, "media", sha.slice(0, 2), `${sha}.png`);
  await fs.mkdir(path.dirname(media), { recursive: true }); await fs.writeFile(media, PNG);
  store.ingest(normalizeMessage({ post_type: "message", message_type: "group", group_id: 8, user_id: 123, self_id: 1, message_id: 1, time: 1800000000, message: [{ type: "image", data: { file: "x" } }] })!);
  const row = store.message({ kind: "all" }, "1")!.row;
  store.saveMedia(row, [{ scope: row.scope, message_id: row.message_id, ordinal: 0, sha256: sha, path: media, status: "ok", reason: null, created_at: 1800000000 }], `[image:${media}]`);
  for (const name of ["qq_send_image", "qq_send_file"]) expect((await o.client.callTool({ name, arguments: { path: media } })).isError).toBe(true);
  store.ingest(normalizeMessage({ post_type: "message", message_type: "group", group_id: 7, user_id: 123, self_id: 1, message_id: 2, time: 1800000000, message: [{ type: "image", data: { file: "x" } }] })!);
  const own = store.message({ kind: "scope", scope: "group:7" }, "2")!.row;
  store.saveMedia(own, [{ scope: own.scope, message_id: own.message_id, ordinal: 0, sha256: sha, path: media, status: "ok", reason: null, created_at: 1800000000 }], `[image:${media}]`);
  for (const name of ["qq_send_image", "qq_send_file"]) expect((await o.client.callTool({ name, arguments: { path: media } })).isError).not.toBe(true);
});

it.each(["QQ_ATTACH_DIR", "QQ_FILE_DIR", "QQ_WORKDIR", "QQ_ACCESS"])("缺少 %s 时附件工具拒绝", async variable => {
  const o = await setup({ [variable]: "" });
  expect((await o.client.callTool({ name: "qq_send_file", arguments: { path: "报告.txt" } })).isError).toBe(true);
});

it("目录解析拒绝相对路径、注入字符、..、根目录、深层目录和链接", async () => {
  const root = tmp("cs-attach-path-"); dirs.push(root);
  for (const dir of ["relative", root, path.join(root, "a", "b"), `${root}/a/../x`, path.join(root, 'bad"'), path.join(root, "bad name")]) {
    await expect(resolveAttachmentDir(dir, root, "QQ_FILE_DIR")).rejects.toThrow();
  }
  const valid = path.join(root, "ticket_1");
  expect(await resolveAttachmentDir(valid, root, "QQ_FILE_DIR")).toBe(await fs.realpath(valid));
  const link = path.join(root, "alias"); await fs.symlink(valid, link, "junction");
  await expect(resolveAttachmentDir(link, root, "QQ_FILE_DIR")).rejects.toThrow();
});
