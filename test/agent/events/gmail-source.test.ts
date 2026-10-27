import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { GmailEventSource } from "../../../src/agent/events/sources/gmail.js";
import { mail } from "./fixture.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function rig() {
  let status = 200, body: unknown = { cursor: "20", events: [mail("a")], more: true, reset: false };
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.headers.authorization !== "Bearer test-only") { res.writeHead(401).end(); return; }
    res.writeHead(status, { "content-type": "application/json", Location: "/stolen" }).end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { source: new GmailEventSource({ baseUrl, authHeader: "Bearer test-only" }), requests,
    set(code: number, response: unknown) { status = code; body = response; } };
}

it("Bearer、游标和分页参数走真实 HTTP；reset 返回空事件", async () => {
  const r = await rig();
  expect(await r.source.poll("10", 50, new AbortController().signal)).toMatchObject({ cursor: "20", more: true, events: [mail("a")] });
  expect(r.requests).toEqual(["/events?cursor=10&limit=50"]);
  r.set(200, { cursor: "30", events: [mail("old")], more: true, reset: true });
  expect(await r.source.poll(null, 50, new AbortController().signal)).toEqual({ cursor: "30", events: [], more: false, reset: true });
});

it("鉴权失败、重定向和超限响应仅返回固定分类", async () => {
  const r = await rig(); r.set(401, "PRIVATE_REMOTE_BODY");
  await expect(r.source.poll(null, 50, new AbortController().signal)).rejects.toMatchObject({ code: "auth", message: "auth" });
  r.set(307, "redirect");
  await expect(r.source.poll(null, 50, new AbortController().signal)).rejects.toMatchObject({ code: "network" });
  expect(r.requests).toHaveLength(2);
  r.set(200, "x".repeat(1_048_577));
  await expect(r.source.poll(null, 50, new AbortController().signal)).rejects.toMatchObject({ code: "response" });
});
