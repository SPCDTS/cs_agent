import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Execution, ExecutionStatus, WsbTarget } from "../src/domain.ts";
import { atomicJson, readJson } from "../src/files.ts";
import {
  evidence, executionFiles, GuestInput, Marker, parse, SessionIntent, sessionFiles, wsbSessionDir,
} from "../src/wsb-evidence.ts";
import { runWsbExecution, runWsbGuardian } from "../src/wsb-execution.ts";
import type { NativeWsb } from "../src/wsb-native.ts";
import { WsbBackend } from "../src/wsb.ts";

const unowned = randomUUID();
const target: WsbTarget = { kind: "wsb", id: "wsb", memoryMb: 4096, idleTimeoutMs: 60000, maxLifetimeMs: 60000 };
const task = (sessionId: string, script = "Get-Location", timeoutMs = 20000): Execution => ({
  id: randomUUID(), requestId: randomUUID(), subject: { principal: "owner", scope: "test" }, target, sessionId,
  command: { kind: "powershell", script, timeoutMs }, deadline: Date.now() + timeoutMs,
});
const defer = () => Promise.withResolvers<void>();

class Sandbox implements NativeWsb {
  readonly running = new Set<string>([unowned]);
  readonly starts: Array<{ id: string; xml: string }> = [];
  readonly stops: string[] = [];
  readonly shares = new Map<string, { id: string; host: string; writable: boolean }>();
  readonly executions: string[] = [];
  startGate?: Promise<void>;
  runGate?: Promise<void>;
  failList = false;
  failStop = false;
  mode: "normal" | "replace" | "oversize" | "wrong-id" = "normal";

  async start(id: string, xml: string) {
    this.starts.push({ id, xml });
    await this.startGate;
    this.running.add(id);
  }
  async list() {
    if (this.failList) throw new Error("list unavailable");
    return [...this.running];
  }
  async stop(id: string) {
    this.stops.push(id);
    if (this.failStop) throw new Error("stop unavailable");
    this.running.delete(id);
  }
  async share(id: string, host: string, guest: string, writable: boolean) {
    assert.ok(this.running.has(id));
    this.shares.set(guest, { id, host, writable });
  }
  async exec(id: string, input: string, output: string) {
    assert.ok(this.running.has(id));
    this.executions.push(id);
    await this.runGate;
    if (!this.running.has(id)) throw new Error("sandbox was stopped");
    const mapped = (file: string, writable: boolean) => {
      const folder = this.shares.get(path.win32.dirname(file));
      assert.ok(folder?.id === id && folder.writable === writable);
      return path.join(folder.host, path.win32.basename(file));
    };
    const job = parse(GuestInput, await readJson(mapped(input, false)));
    const result = mapped(output, true);
    if (this.mode === "replace") await fs.rename(result, result + ".preopened");
    if (this.mode === "oversize") {
      await fs.writeFile(result, "X".repeat(200000));
      return;
    }
    await fs.writeFile(result, JSON.stringify({
      id: this.mode === "wrong-id" ? randomUUID() : job.id,
      result: { exitCode: 7, stdout: job.script, stderr: "", truncated: false },
    }), "utf8");
  }
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("wsb test observation deadline");
}

async function fixture(t: TestContext, { beforeExecute, dropExecution = false }: {
  beforeExecute?: Promise<void>; dropExecution?: boolean;
} = {}) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "wsb-mcp-test-"));
  const native = new Sandbox();
  const sessions = new Set<string>();
  const helpers: Promise<void>[] = [];
  const adapters: NonNullable<ConstructorParameters<typeof WsbBackend>[1]> = {
    native,
    stage: async runtime => { await fs.mkdir(runtime); },
    launch: async request => {
      if (request.role === "execute" && dropExecution) return;
      helpers.push((async () => {
        if (request.role === "guard") await runWsbGuardian(request.dir, native);
        else {
          await beforeExecute;
          await runWsbExecution(request.dir, request.id, native);
        }
      })());
    },
  };
  const create = () => new WsbBackend(state, adapters);
  const backend = create();
  const session = () => {
    const id = randomUUID();
    sessions.add(id);
    return id;
  };
  const dir = (id: string) => wsbSessionDir(state, id);
  t.after(async () => {
    for (const id of sessions) assert.equal(await backend.closeSession(id), true);
    await Promise.all(helpers);
    assert.deepEqual([...native.running], [unowned]);
    const absolute = await fs.realpath(state);
    assert.equal(absolute, path.join(await fs.realpath(os.tmpdir()), path.basename(state)));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return { backend, create, dir, native, session };
}

const succeeded = async (backend: WsbBackend, execution: Execution): Promise<ExecutionStatus> => {
  await backend.dispatch(execution);
  return until(async () => {
    const result = await backend.inspect(execution);
    return result.state === "running" ? undefined : result;
  });
};

test("同一会话复用原生 UUID，重建后读取收据，重复派发只执行一次", async t => {
  const f = await fixture(t);
  const session = f.session();
  const first = task(session, "中文 $env:HOST_SECRET");
  assert.deepEqual(await succeeded(f.backend, first), {
    state: "succeeded", result: { exitCode: 7, stdout: "中文 $env:HOST_SECRET", stderr: "", truncated: false },
  });
  const restarted = f.create();
  await restarted.dispatch(first);
  assert.equal((await restarted.inspect(first)).state, "succeeded");
  assert.equal((await succeeded(restarted, task(session))).state, "succeeded");
  assert.equal(f.native.starts.length, 1);
  assert.deepEqual(f.native.executions, [f.native.starts[0].id, f.native.starts[0].id]);
  assert.match(f.native.starts[0].xml, /<SandboxFolder>C:\\AgentRuntime<\/SandboxFolder><ReadOnly>true/);
  assert.match(f.native.starts[0].xml, /<ClipboardRedirection>Disable/);
  assert.doesNotMatch(f.native.starts[0].xml, /AgentWork|AgentCache|sandbox-data|HOST_SECRET/);
  assert.deepEqual([...f.native.shares.values()].map(row => row.writable), [false, true, false, true]);

  assert.equal(await restarted.closeSession(session), true);
  assert.equal(await restarted.closeSession(session), true);
  assert.equal((await succeeded(restarted, task(f.session()))).state, "succeeded");
  assert.notEqual(f.native.starts[1].id, f.native.starts[0].id);
  assert.ok(!f.native.stops.includes(unowned));
});

test("启动尚未返回时空 list 不确认取消，迟到实例仍会按原生 UUID 回收", async t => {
  const f = await fixture(t);
  const gate = defer();
  f.native.startGate = gate.promise;
  const execution = task(f.session());
  await f.backend.dispatch(execution);
  try {
    await until(() => f.native.starts[0]);
    const recovered = f.create();
    assert.deepEqual(await recovered.stop(execution), { state: "unknown", error: "wsb_stop_unconfirmed" });
    assert.deepEqual(f.native.stops, []);
  } finally {
    gate.resolve();
  }
  assert.deepEqual(await until(async () => {
    const status = await f.create().stop(execution);
    return status.state === "unknown" ? undefined : status;
  }), { state: "cancelled" });
  assert.deepEqual(f.native.executions, []);
  assert.deepEqual([...f.native.running], [unowned]);
});

test("启动助手拿到原生启动权前取消，迟到助手无法启动实例", async t => {
  const gate = defer();
  const f = await fixture(t, { beforeExecute: gate.promise });
  const execution = task(f.session());
  await f.backend.dispatch(execution);
  try {
    assert.deepEqual(await f.backend.stop(execution), { state: "cancelled" });
  } finally {
    gate.resolve();
  }
  await delay(50);
  assert.deepEqual(f.native.starts, []);
});

test("list 和 stop 出错时保留清理状态，确认实例停止后才能取消", async t => {
  const f = await fixture(t);
  const gate = defer();
  f.native.runGate = gate.promise;
  const execution = task(f.session());
  await f.backend.dispatch(execution);
  try {
    const owned = await until(() => f.native.executions[0]);
    f.native.failList = true;
    assert.equal((await f.backend.stop(execution)).state, "unknown");
    assert.ok(f.native.running.has(owned));
    f.native.failList = false;
    f.native.failStop = true;
    assert.equal((await f.backend.stop(execution)).state, "unknown");
    assert.ok(f.native.running.has(owned));
    f.native.failStop = false;
    assert.deepEqual(await f.backend.stop(execution), { state: "cancelled" });
    assert.ok(!f.native.running.has(owned));
  } finally {
    f.native.failList = f.native.failStop = false;
    gate.resolve();
  }
});

test("缺少独立助手心跳时恢复报告未知，重复派发不会重放", async t => {
  const f = await fixture(t, { dropExecution: true });
  const session = f.session();
  const execution = task(session);
  await f.backend.dispatch(execution);
  await atomicJson(executionFiles(f.dir(session), execution.id).request,
    { deadline: execution.deadline, preparedAt: Date.now() - 6000 });
  const recovered = f.create();
  assert.deepEqual(await recovered.inspect(execution), { state: "unknown", error: "wsb_helper_unreachable" });
  await recovered.dispatch(execution);
  assert.deepEqual(f.native.starts, []);
  assert.deepEqual(await recovered.stop(execution), { state: "cancelled" });
});

test("拒绝结果替换、超限和不匹配的执行 ID", async t => {
  const f = await fixture(t);
  for (const mode of ["replace", "oversize", "wrong-id"] satisfies Sandbox["mode"][]) {
    const session = f.session();
    f.native.mode = mode;
    const execution = task(session);
    assert.deepEqual(await succeeded(f.backend, execution), { state: "unknown", error: "wsb_execution_unconfirmed" });
    assert.equal(await f.backend.closeSession(session), true);
  }
});

test("会话硬期限由独立 guardian 执行，已完成结果仍可恢复", async t => {
  const f = await fixture(t);
  const session = f.session();
  const execution = { ...task(session), target: { ...target, maxLifetimeMs: 600 } };
  assert.equal((await succeeded(f.backend, execution)).state, "succeeded");
  const files = sessionFiles(f.dir(session));
  const intent = await evidence(files.intent, SessionIntent);
  assert.ok(intent);
  assert.ok(f.native.running.has(intent.nativeId));
  await until(() => evidence(files.closed, Marker));
  assert.ok(!f.native.running.has(intent.nativeId));
  assert.equal((await f.create().inspect(execution)).state, "succeeded");
});

test("执行助手在服务未参与时也会按任务截止时间销毁 guest", async t => {
  const f = await fixture(t);
  const gate = defer();
  f.native.runGate = gate.promise;
  const session = f.session();
  const execution = task(session, "Start-Sleep 90", 500);
  await f.backend.dispatch(execution);
  try {
    const id = await until(() => f.native.executions[0]);
    await until(() => evidence(sessionFiles(f.dir(session)).closed, Marker));
    assert.ok(!f.native.running.has(id));
    assert.deepEqual(await f.create().inspect(execution), { state: "cancelled" });
  } finally {
    gate.resolve();
  }
});
