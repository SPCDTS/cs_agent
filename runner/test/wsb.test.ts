import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WsbBackend, type command } from "../src/wsb.ts";
import { parse, JobInputSchema, ExecResultSchema } from "../src/protocol.ts";
import { readJson, sha256 } from "../src/files.ts";
import { prepareResourceFiles } from "../src/resource-files.ts";
import { workspaceStorage } from "../src/storage.ts";
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
    const launcher = args[args.indexOf("--command") + 1];
    const preparing = launcher.endsWith(" prepare");
    assert.equal(launcher.replace(/ prepare$/, ""), '"C:\\AgentTools\\node\\node.exe" "C:\\AgentTools\\runner\\guest.mjs" "C:\\AgentInput\\input.json"');
    if (!preparing) executions++;
    const record = await readJson(path.join(state, "instance.json"));
    assert.ok(record && typeof record === "object" && "leaseId" in record && typeof record.leaseId === "string");
    const root = path.join(state, "sessions", sha256(record.leaseId)), output = path.join(root, "output/outcome.json");
    const input = parse(JobInputSchema, await readJson(path.join(root, "input/input.json")));
    assert.equal(input.tool, "powershell");
    if (mode === "hang") { await new Promise<void>(resolve => { stopped = resolve; }); throw new Error("guest_stopped"); }
    if (mode === "invalid") { await fs.writeFile(output, "invalid", "utf8"); return "{}"; }
    if (preparing) {
      const directive = input.lease.resourcePreparation; assert.ok(directive);
      const work = path.join(dataDir, "projects", sha256(input.lease.workspace));
      await prepareResourceFiles(work, directive.kind === "clone" ? path.join(dataDir, "projects", sha256(directive.sourceWorkspace)) : undefined);
    }
    if (mode === "replace") await fs.rename(output, path.join(root, "output/original.json"));
    await fs.writeFile(output, JSON.stringify({ kind: "completed", result: { stdout: "中文 " + executions, stderr: "", code: 0, timedOut: false, truncated: false } }), "utf8");
    return "{}";
  };
  const dataDir = state + "-data";
  const backend = new WsbBackend(state, { ...config(binding.deviceId), ...(persistent ? { dataDir, gitDir: path.join(state, "tools/git") } : {}) }, path.join(state, "checkout/runner/dist"), { command: host, capabilities: async () => capabilities });
  t.after(async () => { await backend.stopOwned(); await fs.rm(state, { recursive: true, force: true }); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { backend, binding, calls, live, state, dataDir, host, setMode(value: typeof mode) { mode = value; }, run(command = "probe") { return backend.run(job(binding, command), new AbortController().signal, () => undefined); } };
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

test("提供方复制文件并只读挂载来源；工作区与 npm 下载缓存独立", async t => {
  const f = await fixture(t, true);
  const parent = await workspaceStorage({ dataDir: f.dataDir, state: f.state, deviceId: f.binding.deviceId, protectedPaths: [], workspace: "parent" });
  await fs.writeFile(path.join(parent.work, "dirty.txt"), "未提交内容", "utf8");
  f.binding.workspace = "child"; f.binding.resourcePreparation = { kind: "clone", operationId: "clone-child", sourceWorkspace: "parent" };
  assert.equal((await f.run()).kind, "completed");
  const start = f.calls.find(call => call.args[0] === "start"); assert.ok(start);
  const xml = start.args[start.args.indexOf("--config") + 1];
  const source = path.join(f.dataDir, "projects", sha256("parent"));
  const work = path.join(f.dataDir, "projects", sha256("child"));
  const cache = path.join(f.dataDir, "cache", sha256("child"), "npm");
  assert.ok(xml.includes("<HostFolder>" + source + "</HostFolder><SandboxFolder>C:\\AgentSource</SandboxFolder><ReadOnly>true</ReadOnly>"));
  assert.ok(xml.includes("<HostFolder>" + work + "</HostFolder><SandboxFolder>C:\\AgentWork</SandboxFolder><ReadOnly>false</ReadOnly>"));
  assert.ok(xml.includes("<HostFolder>" + cache + "</HostFolder><SandboxFolder>C:\\AgentCache\\npm</SandboxFolder><ReadOnly>false</ReadOnly>"));
  assert.equal(await fs.readFile(path.join(work, "dirty.txt"), "utf8"), "未提交内容");
  await fs.writeFile(path.join(work, "dirty.txt"), "子任务修改", "utf8");
  await f.run();
  await f.backend.release(f.binding.id);
  // 新连接器、新租约继续使用宿主记录，不依赖 guest 文件里的完成标记。
  const resumed = new WsbBackend(f.state, { ...config(f.binding.deviceId), dataDir: f.dataDir }, path.join(f.state, "checkout/runner/dist"), { command: f.host, capabilities: async () => capabilities });
  t.after(() => resumed.stopOwned());
  await fs.rm(source, { recursive: true });
  const next = { ...f.binding, id: lease().id };
  assert.equal((await resumed.run(job(next), new AbortController().signal, () => undefined)).kind, "completed");
  assert.equal(await fs.readFile(path.join(work, "dirty.txt"), "utf8"), "子任务修改");
  assert.equal(f.calls.filter(call => call.args.some(arg => arg.endsWith(" prepare"))).length, 1);
});

test("首次准备拒绝非空目标，已有资源和旧租约不会触发新的初始化", async t => {
  const f = await fixture(t, true); await f.run(); await f.backend.release(f.binding.id);
  const work = path.join(f.dataDir, "projects", sha256(f.binding.workspace));
  await fs.writeFile(path.join(work, "keep.txt"), "保留", "utf8");
  f.binding.id = lease().id;
  f.binding.resourcePreparation = { kind: "create", operationId: "create-existing" };
  assert.equal((await f.run()).kind, "failed");
  assert.equal(await fs.readFile(path.join(work, "keep.txt"), "utf8"), "保留");
  assert.equal(f.calls.filter(call => call.args.some(arg => arg.endsWith(" prepare"))).length, 0);
  delete f.binding.resourcePreparation;
  f.binding.workspaceSource = { workspace: "legacy-parent" };
  assert.deepEqual(await f.run(), { kind: "failed", error: "legacy_preparation_requires_release", sessionLost: true });
});

test("准备失败不执行用户命令；pending 重试清理部分文件，完成记录不能换来源", async t => {
  const f = await fixture(t, true);
  const parent = await workspaceStorage({ dataDir: f.dataDir, state: f.state, deviceId: f.binding.deviceId, protectedPaths: [], workspace: "parent" });
  await fs.writeFile(path.join(parent.work, "source.txt"), "来源", "utf8");
  f.binding.resourcePreparation = { kind: "clone", operationId: "clone-once", sourceWorkspace: "parent" };
  f.setMode("invalid");
  assert.equal((await f.run()).kind, "failed");
  assert.equal(f.calls.filter(call => call.args[0] === "exec").length, 1);
  const work = path.join(f.dataDir, "projects", sha256(f.binding.workspace));
  await fs.writeFile(path.join(work, "partial.txt"), "未完成", "utf8");
  f.binding.id = lease().id; f.setMode("complete");
  assert.equal((await f.run()).kind, "completed");
  assert.deepEqual(await fs.readdir(work), ["source.txt"]);
  await f.backend.release(f.binding.id);
  f.binding.id = lease().id; f.binding.resourcePreparation.sourceWorkspace = "other";
  assert.equal((await f.run()).kind, "failed");
  assert.equal(await fs.readFile(path.join(work, "source.txt"), "utf8"), "来源");
});

test("创建空持久资源只准备一次，后续命令不清空新文件", async t => {
  const f = await fixture(t, true);
  f.binding.resourcePreparation = { kind: "create", operationId: "empty-resource" };
  assert.equal((await f.run()).kind, "completed");
  const work = path.join(f.dataDir, "projects", sha256(f.binding.workspace));
  assert.deepEqual(await fs.readdir(work), []);
  await fs.writeFile(path.join(work, "created.txt"), "用户文件", "utf8");
  assert.equal((await f.run()).kind, "completed");
  assert.equal(await fs.readFile(path.join(work, "created.txt"), "utf8"), "用户文件");
  assert.equal(f.calls.filter(call => call.args.some(arg => arg.endsWith(" prepare"))).length, 1);
});
