import { request } from "node:http";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { compileMcpSchema } from "../../../src/agent/pi-mcp/schema.js";
import { DEFAULT_MCP_LIMITS } from "../../../src/agent/pi-mcp/config.js";
import { GmailClient } from "../../../src/sidecar/gmail/gmail.js";
import { SentStore } from "../../../src/sidecar/gmail/store.js";
import { createGmailHttp } from "../../../src/sidecar/gmail/server.js";
import { fixture, json, textOf } from "./helpers.js";

let current: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => { await current?.cleanup(); current = undefined; });
const send = { to: "to@example.com", subject: "测试", body: "你好", idempotency_key: "idempotent-key" };

describe("Gmail MCP HTTP", () => {
  it("拒绝无/错 Bearer，未收到 body 就响应且不调用 Google", async () => {
    const f = current = await fixture();
    for (const authorization of [undefined, "Bearer incorrect"]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${f.endpoint}/mcp`, { method: "POST", headers: { "Content-Length": "500000", ...(authorization ? { Authorization: authorization } : {}) } }, res => {
          resolve(res.statusCode); res.resume(); req.destroy();
        });
        req.on("error", reject);
        req.flushHeaders();
      });
      expect(status).toBe(401);
    }
    expect(f.gmailCalls).toBe(0);
    expect(f.tokenCalls).toBe(0);
    expect(await (await fetch(`${f.endpoint}/healthz`)).json()).toEqual({ ok: true, auth: "ready", tools: 3 });
    expect((await fetch(`${f.endpoint}/mcp`)).status).toBe(405);
    expect((await fetch(`${f.endpoint}/mcp`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${f.endpoint}/other`)).status).toBe(404);
    expect(() => createGmailHttp({ token: "short", oauth: f.oauth, gmail: f.gmail })).toThrow("32");
  });

  it("initialize、tools/list、tools/call 与严格 Pi schema 校验走真实 SDK", async () => {
    const f = current = await fixture();
    const client = await f.connect();
    expect(Object.keys(client.getServerCapabilities() ?? {})).toEqual(["tools"]);
    expect(client.getServerVersion()?.name).toBe("gmail-sidecar");
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(["gmail_search", "gmail_read", "gmail_send"]);
    for (const tool of tools) {
      const compiled = compileMcpSchema(tool.inputSchema, DEFAULT_MCP_LIMITS);
      const args = tool.name === "gmail_send" ? send : tool.name === "gmail_read" ? { id: "mail-1" } : { query: "in:inbox" };
      expect(compiled.check(args)).toBe(true);
      expect(compiled.check({})).toBe(false);
      expect(tool.inputSchema).toHaveProperty("$schema");
      expect(tool.inputSchema).toHaveProperty("additionalProperties");
    }
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
    expect(tools[1].annotations?.readOnlyHint).toBe(true);
    expect(tools[2].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    const found = textOf(await client.callTool({ name: "gmail_search", arguments: { query: "in:inbox from:sender@example.com" } }));
    expect(found).toContain("mail-1 | thread-1");
    expect(found).toContain("原主题");
    expect(found.split("\n")[1]).toHaveLength(200);
    expect(found).not.toContain("\u0000");
    expect(f.urls[0].searchParams.get("maxResults")).toBe("10");
    expect(f.urls[1].searchParams.getAll("metadataHeaders")).toEqual(["From", "To", "Subject", "Date"]);
    expect(textOf(await client.callTool({ name: "gmail_read", arguments: { id: "mail-1" } }))).toContain("正文");
    expect(await client.callTool({ name: "gmail_search", arguments: { query: "" } })).toMatchObject({ isError: true });
    const audit = JSON.stringify(f.events);
    for (const privateValue of ["sender@example.com", "原主题", "正文", f.bearer, f.accessToken, f.refreshToken]) expect(audit.includes(privateValue)).toBe(false);
  });

  it("限制已鉴权请求体大小并对畸形 JSON 返回 400", async () => {
    const f = current = await fixture();
    const headers = { Authorization: `Bearer ${f.bearer}`, "Content-Type": "application/json" };
    expect((await fetch(`${f.endpoint}/mcp`, { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await fetch(`${f.endpoint}/mcp`, { method: "POST", headers, body: "{" })).status).toBe(400);
    expect(f.gmailCalls).toBe(0);
  });

  it("回复与同 key 并发只发送一次，重启存储后仍返回原回执", async () => {
    const f = current = await fixture();
    const client = await f.connect();
    const reply = { ...send, subject: "", reply_to_message_id: "mail-1" };
    const results = await Promise.all([1, 2].map(() => client.callTool({ name: "gmail_send", arguments: reply })));
    expect(f.sendCalls).toBe(1);
    expect(results.map(textOf).every(text => text.includes("messageId=sent-1"))).toBe(true);
    expect(results.map(textOf).filter(text => text.includes("重复调用，未再次发送"))).toHaveLength(1);
    const payload = z.object({ raw: z.string(), threadId: z.string() }).parse(f.sent[0]);
    expect(payload.threadId).toBe("thread-1");
    const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
    expect(mime).toContain("In-Reply-To: <original@example.com>");
    expect(mime).toContain("References: <root@example.com>\r\n <original@example.com>");
    const restarted = new GmailClient(f.oauth, await SentStore.open(f.stateDir), f.baseUrl);
    expect(await restarted.send(reply)).toContain("重复调用，未再次发送");
    expect(f.sendCalls).toBe(1);
    const stored = JSON.parse(await readFile(join(f.stateDir, "sent.json"), "utf8"));
    expect(stored[send.idempotency_key]).toMatchObject({ messageId: "sent-1", threadId: "thread-1", at: expect.any(Number) });
  });

  it("不同 key 并发不会丢失持久回执", async () => {
    const f = current = await fixture();
    await Promise.all(["send-key-one", "send-key-two"].map(idempotency_key => f.gmail.send({ ...send, idempotency_key })));
    const restarted = new GmailClient(f.oauth, await SentStore.open(f.stateDir), f.baseUrl);
    for (const idempotency_key of ["send-key-one", "send-key-two"]) expect(await restarted.send({ ...send, idempotency_key })).toContain("重复调用");
    expect(f.sendCalls).toBe(2);
  });

  it("回执首次写盘失败后，同 key 只重试写盘并返回重复成功，重启后仍可去重", async () => {
    const f = current = await fixture();
    // 用普通文件占住目录路径，在 Windows 与 Linux 都能触发真实的写入失败。
    await writeFile(f.stateDir, "阻止创建状态目录", { encoding: "utf8" });
    await expect(f.gmail.send(send)).rejects.toMatchObject({ kind: "storage" });
    expect(f.sendCalls).toBe(1);

    await unlink(f.stateDir);
    const duplicate = await f.gmail.send(send);
    expect(duplicate).toContain("messageId=sent-1");
    expect(duplicate).toContain("重复调用，未再次发送");
    expect(f.sendCalls).toBe(1);
    const stored = JSON.parse(await readFile(join(f.stateDir, "sent.json"), "utf8"));
    expect(stored[send.idempotency_key]).toMatchObject({ messageId: "sent-1", threadId: "thread-1", at: expect.any(Number) });
    const restarted = new GmailClient(f.oauth, await SentStore.open(f.stateDir), f.baseUrl);
    expect(await restarted.send(send)).toContain("重复调用，未再次发送");
    expect(f.sendCalls).toBe(1);
  });

  it("重复写盘失败持续返回存储错误，且不阻塞其他 key 的写入", async () => {
    const f = current = await fixture();
    await writeFile(f.stateDir, "阻止创建状态目录", { encoding: "utf8" });
    await expect(f.gmail.send(send)).rejects.toMatchObject({ kind: "storage" });
    await expect(f.gmail.send(send)).rejects.toMatchObject({ kind: "storage" });
    expect(f.sendCalls).toBe(1);

    await unlink(f.stateDir);
    const other = { ...send, idempotency_key: "another-send-key" };
    expect(await f.gmail.send(other)).toContain("messageId=sent-2");
    expect(await f.gmail.send(send)).toContain("重复调用，未再次发送");
    expect(f.sendCalls).toBe(2);
    const stored = JSON.parse(await readFile(join(f.stateDir, "sent.json"), "utf8"));
    expect(stored[send.idempotency_key].messageId).toBe("sent-1");
    expect(stored[other.idempotency_key].messageId).toBe("sent-2");
  });

  it("非法头部通过 isError 返回且不发送", async () => {
    const f = current = await fixture();
    const client = await f.connect();
    const result = await client.callTool({ name: "gmail_send", arguments: { ...send, subject: "bad\r\nBcc: other@example.com" } });
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain("头部");
    expect(f.gmailCalls).toBe(0);
  });

  it.each([[401, "身份验证"], [403, "权限不足"], [404, "不存在"], [429, "配额"]])("Google %s 返回分类文本而非原始 JSON", async (status, expected) => {
    const f = current = await fixture({ gmail: (_req, res) => json(res, { error: { message: "private upstream diagnostic" } }, Number(status)) });
    const client = await f.connect();
    const result = await client.callTool({ name: "gmail_read", arguments: { id: "mail-1" } });
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain(String(expected));
    expect(textOf(result)).not.toContain("private upstream");
    expect(f.events[0].google_status).toBe(Number(status));
  });

  it("无结果明确说明", async () => {
    const f = current = await fixture({ gmail: (_req, res) => json(res, {}) });
    expect(await f.gmail.search("in:inbox")).toBe("未找到匹配的邮件。");
  });
});
