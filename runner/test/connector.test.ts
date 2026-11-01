import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Connector } from "../src/connector.ts";
import { atomicJson, readJson } from "../src/files.ts";
import { capabilities, config as makeConfig, job as makeJob, lease } from "./fixtures.ts";
for (const previouslyStarted of [false, true]) test("真实 HTTP/WS 重连不重跑，释放等待实际后端；已开始收据=" + previouslyStarted, { timeout: 20000 }, async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-connector-")); t.after(() => fs.rm(state, { recursive: true, force: true }));
  const binding = lease(), job = makeJob(binding), deviceId = binding.deviceId, jobId = job.id, token = "a".repeat(64);
  if (previouslyStarted) await atomicJson(path.join(state, "jobs", jobId, "journal.json"), { state: "started" });
  let runs = 0, posts = 0, releases = 0, stops = 0, latest: WebSocket | undefined, resolveDone: () => void = () => undefined;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    if (req.url?.endsWith("/input")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(job)); return; }
    if (req.url?.endsWith("/result")) {
      const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); assert.ok(body);
        posts++;
        if (posts === 1) { res.writeHead(503).end(); latest?.terminate(); }
        else { res.end("{}"); latest?.send(JSON.stringify({ kind: "release", leaseId: binding.id })); }
      });
      return;
    }
    res.writeHead(404).end();
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket, req) => {
    assert.equal(req.headers.authorization, "Bearer " + token); latest = socket;
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === "hello") {
        assert.equal(frame.protocolVersion, 2);
        socket.send(JSON.stringify({ kind: "welcome", deviceId, capabilityRevision: job.lease.capabilityRevision }));
        socket.send(JSON.stringify({ kind: "execute", jobId }));
        socket.send(JSON.stringify({ kind: "execute", jobId }));
      }
      if (frame.kind === "released") { assert.equal(frame.leaseId, binding.id); assert.equal(releases, 1); resolveDone(); }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const config = makeConfig(deviceId, "http://127.0.0.1:" + address.port);
  const connector = new Connector(state, config, "/unused", { credentials: async () => token, capabilities: async () => capabilities,
    backend: { stopOwned: async () => { stops++; }, release: async id => { assert.equal(id, binding.id); releases++; }, run: async input => {
      runs++; assert.equal(JSON.stringify(input).includes(token), false);
      return { kind: "completed", result: { stdout: "中文", stderr: "", code: 0, timedOut: false, truncated: false } };
    } } });
  const running = connector.run();
  try {
    await done; assert.equal(posts, 2); assert.equal(runs, previouslyStarted ? 0 : 1);
    assert.ok(stops >= 1, "空闲结果回传失败后的断线也必须终止会话");
    if (!previouslyStarted) assert.equal(JSON.stringify(await readJson(path.join(state, "jobs", jobId, "input.json"))).includes(token), false);
  } finally {
    await connector.stop(); await running;
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test("401 握手失败仍销毁本机闲置会话", { timeout: 10000 }, async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-revoked-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const server = createServer((_req, res) => res.writeHead(401).end());
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  let acknowledgeStop: () => void = () => undefined, stops = 0;
  const stopped = new Promise<void>(resolve => { acknowledgeStop = resolve; });
  const connector = new Connector(state, makeConfig(lease().deviceId, "http://127.0.0.1:" + address.port), "/unused", {
    credentials: async () => "revoked-token", capabilities: async () => capabilities,
    backend: { stopOwned: async () => { stops++; acknowledgeStop(); }, release: async () => undefined,
      run: async () => { throw new Error("unauthorized_runner_must_not_execute"); } },
  });
  const running = connector.run();
  try { await stopped; assert.ok(stops >= 1); }
  finally { await connector.stop(); await running; await new Promise<void>(resolve => server.close(() => resolve())); }
});
