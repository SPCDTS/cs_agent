import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson } from "./files.ts";
import { sandboxConfiguration, WsbLaunchError, type NativeWsb } from "./wsb-native.ts";
import {
  evidence, executionFiles, GuestResult, JobRequest, Marker, MAX_WSB_RESULT_BYTES, parse, record,
  SessionIntent, sessionFiles, StartClaim, StartReceipt,
} from "./wsb-evidence.ts";

export async function closeNativeSession(dir: string, native: NativeWsb): Promise<boolean> {
  const files = sessionFiles(dir);
  await fs.mkdir(dir, { recursive: true });
  if (await evidence(files.closed, Marker)) return true;
  await record(files.closing, true);
  await record(files.startClaim, "abandoned");
  const claim = await evidence(files.startClaim, StartClaim);
  if (!claim) return false;
  const receipt = await evidence(files.startReceipt, StartReceipt);
  if (claim === "helper" && receipt !== "not-started") {
    const intent = await evidence(files.intent, SessionIntent);
    if (!intent) return false;
    if ((await native.list()).includes(intent.nativeId)) await native.stop(intent.nativeId);
    // One empty listing while the start request is still in flight proves nothing.
    if (receipt !== "started" || (await native.list()).includes(intent.nativeId)) return false;
  }
  await record(files.closed, true);
  return true;
}

export async function retireWsbScratch(dir: string): Promise<void> {
  const { runtime, executions } = sessionFiles(dir);
  const absolute = await fs.realpath(dir);
  const names = await fs.readdir(executions, { withFileTypes: true }).catch(() => []);
  const parents = await fs.realpath(executions).catch(() => "");
  if (parents !== path.join(absolute, "executions") && names.length) return;
  const targets = [runtime];
  for (const job of names) {
    if (!job.isDirectory() || job.isSymbolicLink()) continue;
    const parent = path.join(executions, job.name);
    if (await fs.realpath(parent).catch(() => "") !== path.join(parents, job.name)) continue;
    targets.push(path.join(parent, "input"), path.join(parent, "output"));
  }
  for (const target of targets) {
    const expected = path.join(absolute, path.relative(dir, target));
    if (await fs.realpath(target).catch(() => "") !== expected) continue;
    await fs.rm(expected, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runWsbGuardian(dir: string, native: NativeWsb): Promise<void> {
  const files = sessionFiles(dir);
  const intent = await evidence(files.intent, SessionIntent);
  if (!intent) throw new Error("wsb_start_intent_missing");
  await record(files.guardianReady, true);
  while (!await evidence(files.closed, Marker)) {
    if (Date.now() < intent.deadline && !await evidence(files.closing, Marker)) {
      await delay(Math.min(1000, Math.max(1, intent.deadline - Date.now())));
      continue;
    }
    if (await closeNativeSession(dir, native).catch(() => false)) break;
    await delay(2000);
  }
  await retireWsbScratch(dir);
}

async function acquire(dir: string, native: NativeWsb): Promise<string | undefined> {
  const files = sessionFiles(dir);
  const intent = await evidence(files.intent, SessionIntent);
  if (!intent) throw new Error("wsb_start_intent_missing");
  if (await evidence(files.closing, Marker)) return undefined;
  if (await record(files.startClaim, "helper")) {
    if (await evidence(files.closing, Marker) || Date.now() >= intent.deadline) {
      await record(files.startReceipt, "not-started");
      return undefined;
    }
    try {
      await native.start(intent.nativeId, sandboxConfiguration(files.runtime, intent.memoryMb));
    } catch (error) {
      if (error instanceof WsbLaunchError) await record(files.startReceipt, "not-started");
      throw error;
    }
    await record(files.startReceipt, "started");
  } else {
    if (await evidence(files.startReceipt, StartReceipt) !== "started") throw new Error("wsb_start_unconfirmed");
    if (!(await native.list()).includes(intent.nativeId)) throw new Error("wsb_session_lost");
  }
  return intent.nativeId;
}

async function readResult(handle: FileHandle, id: string) {
  const { size } = await handle.stat();
  if (size < 1 || size > MAX_WSB_RESULT_BYTES) throw new Error("invalid_wsb_result");
  const bytes = Buffer.alloc(size + 1);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  if (bytesRead !== size) throw new Error("invalid_wsb_result");
  const envelope = parse(GuestResult, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
  if (envelope.id !== id) throw new Error("invalid_wsb_result");
  return envelope.result;
}

export async function runWsbExecution(dir: string, id: string, native: NativeWsb): Promise<void> {
  const session = sessionFiles(dir), job = executionFiles(dir, id);
  const request = await evidence(job.request, JobRequest);
  if (!request || !await record(job.claim, true)) return;

  const closing = () => evidence(session.closing, Marker);
  let heartbeat = false;
  const tick = () => {
    if (heartbeat) return;
    heartbeat = true;
    void atomicJson(job.heartbeat, Date.now()).catch(() => undefined).finally(() => { heartbeat = false; });
  };
  let cleanup: Promise<boolean> | undefined;
  const close = () => {
    cleanup ??= closeNativeSession(dir, native).catch(() => false).finally(() => { cleanup = undefined; });
    return cleanup;
  };
  const timer = setInterval(() => {
    tick();
    if (Date.now() >= request.deadline) void close();
  }, 1000);
  tick();

  let handle: FileHandle | undefined;
  try {
    while (!await evidence(session.guardianReady, Marker)) {
      if (await closing() || Date.now() >= request.deadline) return;
      await delay(100);
    }
    if (await closing() || Date.now() >= request.deadline) return;
    await fs.mkdir(job.outputDir);
    handle = await fs.open(job.output, "wx+", 0o600);
    const nativeId = await acquire(dir, native);
    if (!nativeId || await closing() || Date.now() >= request.deadline) return;
    const input = "C:\\AgentInput-" + id;
    const output = "C:\\AgentOutput-" + id;
    await native.share(nativeId, job.inputDir, input, false);
    if (await closing() || Date.now() >= request.deadline) return;
    await native.share(nativeId, job.outputDir, output, true);
    if (await closing() || Date.now() >= request.deadline) return;
    await record(job.execIntent, true);
    await native.exec(nativeId, input + "\\job.json", output + "\\result.json");
    const result = await readResult(handle, id);
    await record(job.receipt, { state: "succeeded", result });
  } catch (error) {
    if (await closing()) return;
    if (error instanceof WsbLaunchError || (error instanceof Error && error.message === "wsb_session_lost")) {
      await record(job.receipt, { state: "failed", error: error.message });
    } else {
      await record(job.issue, true);
    }
    await close();
  } finally {
    clearInterval(timer);
    await handle?.close();
    await fs.unlink(job.input).catch(() => undefined);
    if (Date.now() >= request.deadline || await closing()) {
      if (await close()) await retireWsbScratch(dir);
    }
  }
}
