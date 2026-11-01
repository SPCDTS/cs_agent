import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WsbBackend, type command } from "../src/wsb.ts";
import { parse, JobInputSchema, ExecResultSchema } from "../src/protocol.ts";
import { readJson, sha256 } from "../src/files.ts";
import { capabilities, config, job, lease } from "./fixtures.ts";

async function fixture(t: TestContext, persistent = false) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-wsb-unit-")), binding = lease();
  const calls: { file: string; args: string[] }[] = [], live = new Set<string>(["unowned-instance"]);
  let mode: "complete" | "hang" | "invalid" | "replace" = "complete", executions = 0, stopped: (() => void) | undefined;
  const host: typeof command = async (file, args) => {
    calls.push({ file, args }); assert.equal(file, "wsb.exe");
    const action = args[0], id = args[args.indexOf("--id") + 1];
    if (action === "list") return JSON.stringify({ WindowsSandboxEnvironments: [...live].map(Id => ({ Id })) });
    if (action === "start") { live.add(id); return JSON.stringify({ Id: id }); }
    if (action === "stop") { live.delete(id); stopped?.(); return "{}"; }
    assert.equal(action, "exec");
    assert.equal(args[args.indexOf("--command") + 1], '"C:\\AgentTools\\node\\node.exe" "C:\\AgentTools\\runner\\guest.mjs" "C:\\AgentInput\\input.json"');
    executions++;
    const record = await readJson(path.join(state, "instance.json"));
    assert.ok(record && typeof record === "object" && "leaseId" in record && typeof record.leaseId === "string");
    const root = path.join(state, "sessions", sha256(record.leaseId)), output = path.join(root, "output/outcome.json");
    const input = parse(JobInputSchema, await readJson(path.join(root, "input/input.json")));
    assert.equal(input.tool, "powershell");
    if (mode === "hang") { await new Promise<void>(resolve => { stopped = resolve; }); throw new Error("guest_stopped"); }
    if (mode === "invalid") { await fs.writeFile(output, "invalid", "utf8"); return "{}"; }
    if (mode === "replace") await fs.rename(output, path.join(root, "output/original.json"));
    await fs.writeFile(output, JSON.stringify({ kind: "completed", result: { stdout: "中文 " + executions, stderr: "", code: 0, timedOut: false, truncated: false } }), "utf8");
    return "{}";
  };
  const dataDir = state + "-data";
  const backend = new WsbBackend(state, { ...config(binding.deviceId), ...(persistent ? { dataDir, gitDir: path.join(state, "tools/git") } : {}) }, path.join(state, "checkout/runner/dist"), { command: host, capabilities: async () => capabilities });
  t.after(async () => { await backend.stopOwned(); await fs.rm(state, { recursive: true, force: true }); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { backend, binding, calls, live, state, dataDir, setMode(value: typeof mode) { mode = value; }, run(command = "probe") { return backend.run(job(binding, command), new AbortController().signal, () => undefined); } };
}
test("同租约连续命令复用 VM；模型命令只进入 guest 输入文件", async t => {
  const f = await fixture(t), first = await f.run("New-Item .git,node_modules -ItemType Directory"), second = await f.run("Get-ChildItem");
  assert.equal(first.kind, "completed"); assert.equal(second.kind, "completed");
  if (second.kind === "completed") assert.equal(parse(ExecResultSchema, second.result).stdout, "中文 2");
  assert.equal(f.calls.filter(x => x.args[0] === "start").length, 1);
  assert.equal(f.calls.filter(x => x.args[0] === "stop").length, 0);
  const ids = f.calls.filter(x => x.args[0] === "exec").map(x => x.args[x.args.indexOf("--id") + 1]);
  assert.equal(ids[0], ids[1]);
  assert.equal(JSON.stringify(f.calls).includes("New-Item"), false);
  const start = f.calls.find(x => x.args[0] === "start"); assert.ok(start);
  const xml = start.args[start.args.indexOf("--config") + 1];
  assert.equal(xml.includes("C:\\AgentWork"), false);
  assert.equal(xml.includes("AgentNpm"), false);
  await assert.rejects(f.backend.release("another-lease"), /lease_mismatch/);
  assert.equal(f.live.size, 2);
  await f.backend.release(f.binding.id); await f.backend.release(f.binding.id);
  assert.deepEqual([...f.live], ["unowned-instance"]);
  assert.deepEqual(await f.run(), { kind: "failed", error: "session_lost", sessionLost: true });
});
test("新租约重新映射同一工作区的数据，释放不删除持久文件", async t => {
  const f = await fixture(t, true); await f.run();
  const work = path.join(f.dataDir, "projects", sha256(f.binding.workspace));
  await fs.writeFile(path.join(work, "kept.txt"), "源码与依赖", "utf8");
  await f.backend.release(f.binding.id);
  const next = { ...lease(), deviceId: f.binding.deviceId };
  assert.equal((await f.backend.run(job(next), new AbortController().signal, () => undefined)).kind, "completed");
  assert.equal(await fs.readFile(path.join(work, "kept.txt"), "utf8"), "源码与依赖");
  for (const start of f.calls.filter(call => call.args[0] === "start")) {
    const xml = start.args[start.args.indexOf("--config") + 1];
    assert.ok(xml.includes("C:\\AgentWork")); assert.ok(xml.includes("C:\\AgentCache\\npm"));
    assert.ok(xml.includes(work)); assert.equal(xml.includes("<HostFolder>" + f.state + "</HostFolder>"), false);
  }
});
test("取消销毁已记录 VM；失效租约不能重建，新的租约可以执行", async t => {
  const f = await fixture(t); await f.run(); f.setMode("hang");
  const abort = new AbortController();
  const running = f.backend.run(job(f.binding), abort.signal, text => { if (text.includes("正在执行")) setTimeout(() => abort.abort(), 10); });
  const outcome = await running;
  assert.deepEqual(outcome, { kind: "cancelled", reason: "cancelled_instance_stopped", sessionLost: true });
  assert.deepEqual([...f.live], ["unowned-instance"]);
  assert.deepEqual(await f.run(), { kind: "failed", error: "session_lost", sessionLost: true });
  f.setMode("complete");
  const next = { ...lease(), deviceId: f.binding.deviceId };
  assert.equal((await f.backend.run(job(next), new AbortController().signal, () => undefined)).kind, "completed");
  const stops = f.calls.filter(x => x.args[0] === "stop");
  assert.equal(stops.some(x => x.args.includes("unowned-instance")), false);
});
test("超时销毁 VM 并使租约失效", async t => {
  const f = await fixture(t); f.setMode("hang");
  assert.deepEqual(await f.run(), { kind: "cancelled", reason: "timeout_instance_stopped", sessionLost: true });
  assert.deepEqual(await f.run(), { kind: "failed", error: "session_lost", sessionLost: true });
});
test("外部停止 VM 后返回 session_lost，不静默重建", async t => {
  const f = await fixture(t); await f.run();
  for (const id of f.live) if (id !== "unowned-instance") f.live.delete(id);
  assert.deepEqual(await f.run(), { kind: "failed", error: "session_lost", sessionLost: true });
  assert.equal(f.calls.filter(x => x.args[0] === "start").length, 1);
});
test("结果文件被替换时持有句柄不会改读新路径；故障令会话失效", async t => {
  const f = await fixture(t); f.setMode("replace");
  assert.deepEqual(await f.run(), { kind: "unknown", reason: "sandbox_execution_unconfirmed", sessionLost: true });
  assert.deepEqual([...f.live], ["unowned-instance"]);
  assert.deepEqual(await f.run(), { kind: "failed", error: "session_lost", sessionLost: true });
});

test("子工作区仅只读挂载来源，独立可写目录复用来源的 npm 缓存", async t => {
  const f = await fixture(t, true);
  f.binding.workspace = "child"; f.binding.workspaceSource = { workspace: "parent" };
  assert.equal((await f.run()).kind, "completed");
  const start = f.calls.find(call => call.args[0] === "start"); assert.ok(start);
  const xml = start.args[start.args.indexOf("--config") + 1];
  const source = path.join(f.dataDir, "projects", sha256("parent"));
  const work = path.join(f.dataDir, "projects", sha256("child"));
  const cache = path.join(f.dataDir, "cache", sha256("parent"), "npm");
  assert.ok(xml.includes("<HostFolder>" + source + "</HostFolder><SandboxFolder>C:\\AgentSeed</SandboxFolder><ReadOnly>true</ReadOnly>"));
  assert.ok(xml.includes("<HostFolder>" + work + "</HostFolder><SandboxFolder>C:\\AgentWork</SandboxFolder><ReadOnly>false</ReadOnly>"));
  assert.ok(xml.includes("<HostFolder>" + cache + "</HostFolder><SandboxFolder>C:\\AgentCache\\npm</SandboxFolder><ReadOnly>false</ReadOnly>"));
});
