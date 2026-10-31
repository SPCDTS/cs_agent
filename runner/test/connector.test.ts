import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Connector } from "../src/connector.ts";
import { sha256, readJson } from "../src/files.ts";
import type { Config } from "../src/wsb.ts";
import type { JobInput, Descriptor } from "../src/protocol.ts";
test("真实 HTTP/WSS 重连只回传 journal，不再次执行；凭据不进入任务文件", { timeout: 20000 }, async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-connector-")); t.after(() => fs.rm(state, { recursive: true, force: true }));
  const deviceId = randomUUID(), jobId = randomUUID(), token = "a".repeat(64);
  const capabilities: Descriptor = { name: "测试", provider: "windows-wsb", os: "windows", arch: "x64", shells: ["powershell"], tools: [], taskTypes: ["shell.exec"],
    memoryMiB: 4096, maxConcurrent: 1, maxTimeoutMs: 1200000, workspaceProtocol: "r2-source-v1", cache: { npm: true, git: false } };
  const job: JobInput = { id: jobId, lease: { id: randomUUID(), deviceId, sandboxId: "remote:" + deviceId, workspace: "owner", operationId: "test", taskType: "shell.exec", requirements: {}, capabilityRevision: sha256(JSON.stringify(capabilities)), createdAt: Date.now() },
    operation: { kind: "shell.exec", command: "probe", shell: "powershell", cwd: "/work", timeoutMs: 1000 }, source: { files: [], directories: [], totalBytes: 0 }, baseRevision: "0", createdAt: Date.now(), deadline: Date.now() + 20000 };
  let runs = 0, posts = 0, latest: WebSocket | undefined, resolveDone: () => void = () => undefined;
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
        else { res.end("{}"); resolveDone(); }
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
        socket.send(JSON.stringify({ kind: "welcome", deviceId, capabilityRevision: job.lease.capabilityRevision }));
        socket.send(JSON.stringify({ kind: "execute", jobId }));
        socket.send(JSON.stringify({ kind: "execute", jobId }));
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const config: Config = { origin: "http://127.0.0.1:" + address.port, deviceId, tokenProtected: "test-only", name: "test", nodeDir: "/unused", memoryMiB: 4096, maxTimeoutMs: 1200000 };
  const connector = new Connector(state, config, "/unused", { credentials: async () => token, capabilities: async () => capabilities,
    backend: { stopOwned: async () => undefined, run: async input => {
      runs++; assert.equal(JSON.stringify(input).includes(token), false);
      return { kind: "completed", result: { stdout: "中文", stderr: "", code: 0, timedOut: false, truncated: false }, snapshot: { files: [], directories: [], totalBytes: 0 } };
    } } });
  const running = connector.run();
  try {
    await done; assert.equal(posts, 2); assert.equal(runs, 1);
    assert.equal(JSON.stringify(await readJson(path.join(state, "jobs", jobId, "input/input.json"))).includes(token), false);
  } finally {
    await connector.stop(); await running;
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
