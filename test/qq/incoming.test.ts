import { promises as fs } from "node:fs";
import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadHooks } from '../../src/qq/incoming-http.js';
import { cleanupIncoming, downloadIncoming, INCOMING_RETENTION_MS } from "../../src/qq/incoming.js";
import { createQQBridge } from "../../src/qq/bridge.js";
import { inboundFromTicket } from "../../src/qq/ticket.js";
import type { InboundMessage, QQBridge } from "../../src/qq/types.js";
import { tmp } from "../agent/helpers.js";
import { FakeOneBot, groupEvent, privateEvent, SELF_ID, TOKEN, waitFor } from "./fake-onebot.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let cdn: Server;
let url: string;
let downloads: (string | undefined)[];
let napcat: FakeOneBot;
let bridge: QQBridge;
let dir: string;
const hooks: DownloadHooks = {
  resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  request: (target, options, cb) => request(new URL(target.pathname + target.search, url.replace('public.test', '127.0.0.1')), { ...options, lookup: undefined }, cb),
};
let received: { message: InboundMessage; ticket: string }[];
beforeEach(async () => {
  dir = tmp("incoming-"); downloads = []; received = [];
  cdn = createServer((req, res) => { downloads.push(req.headers.authorization); res.end(PNG); });
  await new Promise<void>(resolve => cdn.listen(0, "127.0.0.1", resolve));
  url = `http://public.test:${(cdn.address() as AddressInfo).port}/image`;
  napcat = new FakeOneBot(); await napcat.start();
  bridge = createQQBridge({ httpUrl: napcat.httpUrl, wsUrl: napcat.wsUrl, token: TOKEN, allowUsers: ["20001"], allowGroups: ["30001"], groupMentions: true, dataDir: dir, imageRoot: path.join(dir, "images") }, { downloadHooks: hooks });
  bridge.on("message", (message, ticket) => received.push({ message, ticket }));
  await bridge.start(); await waitFor(() => bridge.status().ws_connected);
});
afterEach(async () => {
  await bridge.stop(); await napcat.stop(); cdn.closeAllConnections();
  await new Promise<void>(resolve => cdn.close(() => resolve()));
});
const segment = (data: object) => ({ type: "image", data });

describe("触发消息参考图", () => {
  it("array 格式下载到 incoming，持久化后发事件；历史只留占位，未触发消息不下载", async () => {
    const raw: InboundMessage[] = [];
    bridge.on("raw", m => raw.push(structuredClone(m)));
    const parts = [{ type: "text", data: { text: "奶龙: 横 改成红色" } }, segment({ url })];
    napcat.push(groupEvent("30001", "29999", "", false, { message: parts }));
    const event = privateEvent("20001", "", { message: parts });
    napcat.push(event); napcat.push(event);
    await waitFor(() => received.length === 1);
    expect(downloads).toEqual([undefined]); // CDN 没有收到 NapCat token
    expect(raw[0]!.images).toEqual([]);
    expect(raw[0]!.text).toContain("[image]");
    const { message, ticket } = received[0]!;
    expect(message.images).toEqual([path.join(dir, "incoming", ticket, "1.png")]);
    expect(message.route_text).toBe("奶龙: 横 改成红色");
    expect(await fs.readFile(message.images[0]!)).toEqual(PNG);
    const saved = (await bridge.getTicket(ticket))!;
    expect(saved.source_images).toEqual(message.images);
    expect(inboundFromTicket(saved).images).toEqual(message.images);
  });
  it("图片在真实 at 前面时仍正确识别前缀文本", async () => {
    napcat.push(groupEvent("30001", "29999", "", true, { message: [
      segment({ url }), { type: "at", data: { qq: SELF_ID } },
      { type: "text", data: { text: " 奶龙: 改成红色" } },
    ] }));
    await waitFor(() => received.length === 1);
    expect(received[0]!.message.route_text.trim()).toBe("奶龙: 改成红色");
    expect(received[0]!.message.images).toHaveLength(1);
  });
  it("缺 URL 时用 get_image(file)；只接受返回的 HTTP URL", async () => {
    napcat.override = call => call.action === "get_image" ? { body: { status: "ok", retcode: 0, data: { url, file: "C:/NapCat/cache.png" } } } : undefined;
    napcat.push(privateEvent("20001", "", { message: [segment({ file: "abc.png" })] }));
    await waitFor(() => received.length === 1);
    expect(napcat.calls.find(c => c.action === "get_image")?.body).toEqual({ file: "abc.png" });
    expect(received[0]!.message.images).toHaveLength(1);
  });
  it("超过 3 张拒绝整组且持久化错误，不进行下载", async () => {
    napcat.push(privateEvent("20001", "", { message: Array.from({ length: 4 }, () => segment({ url })) }));
    await waitFor(() => received.length === 1);
    expect(downloads).toHaveLength(0);
    expect(received[0]!.message.image_error).toContain("最多 3 张");
    expect((await bridge.getTicket(received[0]!.ticket))?.source_image_error).toContain("最多 3 张");
  });
  it.each(["length", "stream", "magic", "local"])("拒绝 %s，流大小限制不能靠 Content-Length 绕过", async mode => {
    cdn.removeAllListeners('request');
    cdn.on('request', (_req, res) => {
      if (mode === 'length') { res.setHeader('content-length', 11 * 1024 * 1024); res.end(PNG); }
      else if (mode === 'stream') res.end(Buffer.alloc(10 * 1024 * 1024 + 1));
      else res.end('this is not an image');
    });
    await expect(downloadIncoming({ message: [segment({ url: mode === 'local' ? 'file:///etc/passwd' : url })] }, 'a'.repeat(64), dir, { call: async () => ({}) }, AbortSignal.timeout(1000), hooks)).rejects.toThrow(/10 MiB|魔数|HTTP URL/);
  });
  it("7 天清理只删除过期票据目录，保留新文件、非票据目录与符号链接目标", async () => {
    const root = path.join(dir, "incoming");
    const old = path.join(root, "a".repeat(64)); const fresh = path.join(root, "b".repeat(64));
    const other = path.join(root, "not-a-ticket");
    for (const p of [old, fresh, other]) { await fs.mkdir(p, { recursive: true }); await fs.writeFile(path.join(p, "1.png"), PNG); }
    const now = Date.now(); const past = new Date(now - INCOMING_RETENTION_MS - 1000);
    for (const p of [old, other]) await fs.utimes(p, past, past);
    const target = tmp("incoming-link-");
    await fs.symlink(target, path.join(root, "c".repeat(64)), process.platform === "win32" ? "junction" : "dir");
    expect(await cleanupIncoming(dir, now)).toBe(1);
    expect(await fs.readdir(root)).toEqual(expect.arrayContaining([path.basename(fresh), "not-a-ticket", "c".repeat(64)]));
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });
});
