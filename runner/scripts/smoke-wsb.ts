import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Execution, ExecutionStatus, WsbTarget } from "../src/domain.ts";
import { evidence, executionFiles, Marker, SessionIntent, sessionFiles, wsbSessionDir } from "../src/wsb-evidence.ts";
import { nativeWsb } from "../src/wsb-native.ts";
import { createWsbBackend } from "../src/wsb.ts";

if (process.platform !== "win32") throw new Error("Windows required");
const before = await nativeWsb.list();
const state = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-wsb-mcp-smoke-"));
const sessions = [randomUUID(), randomUUID(), randomUUID()];
const target: WsbTarget = { kind: "wsb", id: "wsb", memoryMb: 4096, idleTimeoutMs: 60000, maxLifetimeMs: 480000 };
let backend = createWsbBackend(state);
console.log(JSON.stringify({ state }));

function job(sessionId: string, script: string): Execution {
  return {
    id: randomUUID(), requestId: randomUUID(), subject: { principal: "smoke", scope: "smoke" }, target, sessionId,
    command: { kind: "powershell", script, timeoutMs: 90000 }, deadline: Date.now() + 90000,
  };
}
async function wait<T>(probe: () => Promise<T | undefined>, timeoutMs = 90000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(250);
  }
  throw new Error("wsb_smoke_deadline");
}
async function succeeded(execution: Execution, exitCode = 0) {
  await backend.dispatch(execution);
  const result = await wait<ExecutionStatus>(async () => {
    const status = await backend.inspect(execution);
    return status.state === "running" ? undefined : status;
  });
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.equal(result.result.exitCode, exitCode, JSON.stringify(result));
  return result.result;
}
async function close(session: string) {
  await wait(async () => await backend.closeSession(session) ? true : undefined, 350000);
}
const nativeId = async (sessionId: string) =>
  (await evidence(sessionFiles(wsbSessionDir(state, sessionId)).intent, SessionIntent))?.nativeId;

try {
  const first = await succeeded(job(sessions[0],
    "[IO.File]::WriteAllText('C:\\AgentWork\\中文.txt','你好'); New-Item node_modules,.git -ItemType Directory | Out-Null; Write-Output '中文 stdout'; [Console]::Error.WriteLine('中文 stderr')"));
  assert.match(first.stdout, /中文 stdout/);
  assert.match(first.stderr, /中文 stderr/);
  const original = await nativeId(sessions[0]);
  assert.ok(original && (await nativeWsb.list()).includes(original));

  // A new service object can inspect durable receipts and use the same guest.
  backend = createWsbBackend(state);
  const next = await succeeded(job(sessions[0],
    "[IO.File]::ReadAllText('C:\\AgentWork\\中文.txt'); Test-Path node_modules; Test-Path .git; exit 7"), 7);
  assert.match(next.stdout, /你好\r?\nTrue\r?\nTrue/);
  assert.equal(await nativeId(sessions[0]), original);
  await close(sessions[0]);
  assert.ok(!(await nativeWsb.list()).includes(original));

  const fresh = await succeeded(job(sessions[1], "Test-Path '中文.txt'; Test-Path node_modules; Test-Path .git"));
  assert.match(fresh.stdout, /False\r?\nFalse\r?\nFalse/);
  const replacement = await nativeId(sessions[1]);
  assert.ok(replacement && replacement !== original);

  const sleeping = job(sessions[1], "Start-Sleep -Seconds 90");
  await backend.dispatch(sleeping);
  const sleepEvidence = executionFiles(wsbSessionDir(state, sessions[1]), sleeping.id);
  await wait(() => evidence(sleepEvidence.execIntent, Marker));
  await delay(1000);
  assert.equal(await backend.inspect(sleeping).then(status => status.state), "running");
  await wait(async () => (await backend.stop(sleeping)).state === "cancelled" ? true : undefined, 60000);
  assert.ok(!(await nativeWsb.list()).includes(replacement));
  const expiring = { ...job(sessions[2], "Write-Output deadline"), target: { ...target, maxLifetimeMs: 12000 } };
  await succeeded(expiring);
  const expiringFiles = sessionFiles(wsbSessionDir(state, sessions[2]));
  const expiringId = await nativeId(sessions[2]);
  assert.ok(expiringId && (await nativeWsb.list()).includes(expiringId));
  await wait(() => evidence(expiringFiles.closed, Marker), 20000);
  assert.ok(!(await nativeWsb.list()).includes(expiringId));
  console.log("WSB smoke passed: same guest across commands and backend recreation; fresh guest filesystem; confirmed stop; independent hard deadline.");
} finally {
  for (const session of sessions) {
    await close(session);
    const id = await nativeId(session);
    if (id) {
      assert.ok(!before.includes(id));
      assert.ok(!(await nativeWsb.list()).includes(id));
    }
  }
}
