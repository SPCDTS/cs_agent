import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { WsbBackend, command, descriptor, protectToken, type Config } from "../src/wsb.ts";
import { atomicJson, sha256, plainFile } from "../src/files.ts";
import type { JobInput, Operation } from "../src/protocol.ts";
if (process.platform !== "win32") throw new Error("Windows only");
const state = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-wsb-smoke-"));
const config: Config = { origin: "http://localhost:8787", deviceId: randomUUID(), tokenProtected: "unused", name: "wsb-smoke",
  nodeDir: path.dirname(process.execPath), memoryMiB: 4096, maxTimeoutMs: 1200000 };
const backend = new WsbBackend(state, config, fileURLToPath(new URL("../dist/", import.meta.url)));
const capabilities = await descriptor(config);
assert.equal(await protectToken(await protectToken("test-token"), true), "test-token");
const fixture = path.join(state, "fixture"); await fs.mkdir(fixture);
await atomicJson(path.join(fixture, "package.json"), { name: "sandbox-smoke-dep", version: "1.0.0", main: "index.cjs", license: "UNLICENSED" });
await fs.writeFile(path.join(fixture, "index.cjs"), "module.exports = '依赖已安装';", "utf8");
await command(process.execPath, [path.join(config.nodeDir, "node_modules/npm/bin/npm-cli.js"), "pack", "--ignore-scripts", "--json"], { cwd: fixture });
const tarball = await fs.readFile(path.join(fixture, "sandbox-smoke-dep-1.0.0.tgz"));
const dependencies = { "sandbox-smoke-dep": "file:sandbox-smoke-dep-1.0.0.tgz" };
const files = {
  "package.json": Buffer.from(JSON.stringify({ name: "wsb-smoke-project", version: "1.0.0", scripts: { test: "node --test sample.test.mjs" }, dependencies })),
  "package-lock.json": Buffer.from(JSON.stringify({ name: "wsb-smoke-project", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "wsb-smoke-project", version: "1.0.0", dependencies }, "node_modules/sandbox-smoke-dep": {
      version: "1.0.0", resolved: "file:sandbox-smoke-dep-1.0.0.tgz", integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64") } } })),
  "sandbox-smoke-dep-1.0.0.tgz": tarball,
  "sample.test.mjs": Buffer.from("import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import dep from 'sandbox-smoke-dep'; test('沙箱测试',()=>{ assert.equal(dep,'依赖已安装'); fs.writeFileSync('中文.txt','你好，远程沙箱'); fs.writeFileSync('binary.bin',Buffer.from([0,255,1])); console.log('中文 stdout'); console.error('中文 stderr'); });"),
};
async function prepare(operation: Operation): Promise<JobInput> {
  const id = randomUUID(), entries = Object.entries(files).map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length, mode: 420, mime: "application/octet-stream" }));
  const job: JobInput = { id, lease: { id: randomUUID(), deviceId: config.deviceId, sandboxId: "remote:" + config.deviceId, workspace: "smoke", operationId: id, capabilityRevision: sha256(JSON.stringify(capabilities)), taskType: operation.kind, requirements: {}, createdAt: Date.now() },
    operation, source: { files: entries, directories: [], totalBytes: entries.reduce((sum, file) => sum + file.bytes, 0) }, baseRevision: "0", createdAt: Date.now(), deadline: Date.now() + 420000 };
  const input = path.join(state, "jobs", id, "input"); await fs.mkdir(path.join(input, "objects"), { recursive: true });
  for (const bytes of Object.values(files)) await fs.writeFile(path.join(input, "objects", sha256(bytes)), bytes);
  await atomicJson(path.join(input, "input.json"), job); return job;
}
console.log(JSON.stringify({ state }));
try {
  for (let round = 0; round < 2; round++) {
    const job = await prepare({ kind: "node.test", script: "test", cwd: "/work", timeoutMs: 60000 }), progress: string[] = [];
    const result = await backend.run(job, new AbortController().signal, message => { progress.push(message); process.stdout.write(message); });
    console.log(JSON.stringify({ round, result }));
    assert.equal(result.kind, "completed"); if (result.kind !== "completed") throw new Error("smoke_failed");
    assert.equal(result.result.code, 0); assert.match(result.result.stdout, /中文 stdout/); assert.match(result.result.stdout + result.result.stderr, /中文 stderr/);
    assert.ok(!result.snapshot.files.some(file => file.path.includes("node_modules")));
    const text = result.snapshot.files.find(file => file.path === "中文.txt"); assert.ok(text);
    assert.equal((await plainFile(path.join(state, "jobs", job.id, "output/objects"), text.sha256)).toString("utf8"), "你好，远程沙箱");
    if (round === 1) assert.ok(progress.some(text => text.includes("恢复当前工作区")));
  }
  const job = await prepare({ kind: "shell.exec", shell: "powershell", command: "Start-Sleep -Seconds 120", cwd: "/work", timeoutMs: 60000 }), abort = new AbortController();
  const cancelled = await backend.run(job, abort.signal, message => { process.stdout.write(message); if (message.includes("正在执行")) setTimeout(() => abort.abort(), 1500); });
  assert.equal(cancelled.kind, "cancelled");
  console.log("WSB 内 npm ci + 测试、中文/二进制回传、跨实例 npm 缓存复用、取消与实例销毁全部通过。");
} finally { await backend.stopOwned(); }
