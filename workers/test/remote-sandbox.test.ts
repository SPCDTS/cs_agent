import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { hash } from "../src/remote-sandbox/fleet";
import { RemoteWorkspace } from "../src/remote-sandbox/workspace";
import { WorkspaceManager } from "../src/sandbox/workspace";
import { sandboxClient } from "../src/sandbox/client";
import { remoteSandboxRoutes } from "../src/remote-sandbox/routes";
import { scopePrefix } from "../src/media/repository";
import { type Descriptor, type JobInput } from "../../runner/src/protocol";
const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await reset(); });
const descriptor: Descriptor = { name: "测试 WSB", provider: "windows-wsb", os: "windows", arch: "x64", shells: ["powershell"], tools: [{ name: "node", version: "v24.15.0" }],
  taskTypes: ["shell.exec", "node.test"], memoryMiB: 4096, maxConcurrent: 1, maxTimeoutMs: 1200000, workspaceProtocol: "r2-source-v1", cache: { npm: true, git: false } };
const fleet = () => env.SANDBOX_FLEET.getByName("owner");
async function register() {
  const pairing = await fleet().createPairing(), token = "a".repeat(64);
  const claim = { pairingId: pairing.pairingId, code: pairing.code, tokenHash: await hash(token), descriptor };
  const device = await fleet().claim(claim);
  expect(await fleet().claim(claim)).toEqual(device);
  expect(await fleet().catalog()).toHaveLength(1);
  await expect((async () => await fleet().claim({ ...claim, tokenHash: "b".repeat(64) }))()).rejects.toThrow("pairing_denied");
  await fleet().approve(device.deviceId);
  const response = await fleet().fetch(new Request("https://test/connect?device=" + device.deviceId, { headers: { Upgrade: "websocket", Authorization: "Bearer " + token } }));
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const welcome = new Promise<MessageEvent>(resolve => socket.addEventListener("message", resolve, { once: true }));
  socket.send(JSON.stringify({ kind: "hello", protocolVersion: 1, descriptor })); await welcome;
  return { deviceId: device.deviceId, token, socket, revision: await hash(JSON.stringify(descriptor)) };
}
const withWorkspace = <T>(name: string, work: (remote: RemoteWorkspace, workspace: WorkspaceManager) => Promise<T>) =>
  runInDurableObject(env.SANDBOX.getByName(name), async (_instance, state) => {
    const workspace = new WorkspaceManager({ workspace: "workspace:" + state.id.toString(), storage: state.storage, bucket: env.ASSETS,
      runtime: sandboxClient(async () => { throw new Error("cloud_container_must_not_start"); }), runtimeReady: () => false, resetRuntime: async () => false });
    const remote = new RemoteWorkspace({ name: state.id.toString(), storage: state.storage, env, workspace });
    return work(remote, workspace);
  });
const operation = { kind: "shell.exec", command: "Write-Output '中文'", shell: "powershell", cwd: "/work", timeoutMs: 1000 } as const;
it("配对、鉴权、能力版本和单槽位必须同时满足；撤销后不能连接", async () => {
  const device = await register();
  const args = { sandboxId: "remote:" + device.deviceId, workspace: env.SANDBOX.idFromName("owner").toString(), operationId: "acquire-1", capabilityRevision: device.revision, taskType: "shell.exec", requirements: {} };
  await expect((async () => await fleet().acquire({ ...args, capabilityRevision: "0".repeat(64) }))()).rejects.toThrow("capability_changed");
  await expect((async () => await fleet().acquire({ ...args, requirements: { os: "linux" } }))()).rejects.toThrow("capability_mismatch");
  const lease = await fleet().acquire(args); expect(await fleet().acquire(args)).toEqual(lease);
  await expect((async () => await fleet().acquire({ ...args, operationId: "acquire-2" }))()).rejects.toThrow("busy");
  expect(await fleet().authorize(device.deviceId, "Bearer " + "b".repeat(64))).toBe(false);
  await fleet().revoke(device.deviceId);
  expect(await fleet().authorize(device.deviceId, "Bearer " + device.token)).toBe(false);
});
it("异步执行锁定写入、重复派发不重复执行、结果提交幂等且未知结果保留槽位", async () => {
  const device = await register(), name = "remote-owner";
  await withWorkspace(name, async (remote) => {
    await remote.acquire({ sandboxId: "remote:" + device.deviceId, capabilityRevision: device.revision, operationId: "lease", taskType: "shell.exec", requirements: {} });
    await remote.run({ operationId: "write", operation: { kind: "write", path: "a.txt", text: "原文" } });
    await remote.run({ operationId: "bom-write", operation: { kind: "write", path: "bom.txt", text: "\uFEFF中文\r\n原文" } });
    await remote.run({ operationId: "bom-edit", operation: { kind: "edit", path: "bom.txt", edits: [{ oldText: "原文", newText: "修改" }] } });
    const bom = await env.SANDBOX.getByName(name).readBlob("bom.txt");
    expect([...bom.bytes.slice(0, 3)]).toEqual([239, 187, 191]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(bom.bytes)).toBe("\uFEFF中文\r\n修改");
    const edit = { operationId: "edit", operation: { kind: "edit", path: "a.txt", edits: [{ oldText: "原文", newText: "修改" }] } } as const;
    const edited = await remote.run({ ...edit, operation: { ...edit.operation, edits: [...edit.operation.edits] } });
    expect(await remote.run({ ...edit, operation: { ...edit.operation, edits: [...edit.operation.edits] } })).toEqual(edited);
  });
  const started = await withWorkspace(name, remote => remote.start("exec", operation)), id = started.jobId;
  expect((await withWorkspace(name, remote => remote.start("exec", operation))).jobId).toBe(id);
  await withWorkspace(name, async remote => {
    await expect(remote.run({ operationId: "blocked", operation: { kind: "write", path: "b.txt", text: "blocked" } })).rejects.toThrow("remote_job_running");
    await expect(remote.release()).rejects.toThrow("remote_job_running");
    expect(await remote.run({ operationId: "read", operation: { kind: "read", path: "a.txt" } })).toMatchObject({ result: { text: "修改" } });
  });
  const input = await fleet().input(device.deviceId, id), bytes = new TextEncoder().encode("完成"), sha = await hash(bytes);
  await expect((async () => await fleet().upload(device.deviceId, id, sha, new Uint8Array([1])))()).rejects.toThrow("blob_corrupt");
  const uploaded = await remoteSandboxRoutes(new Request("https://test/sandbox-devices/" + device.deviceId + "/jobs/" + id + "/objects/" + sha, {
    method: "PUT", headers: { Authorization: "Bearer " + device.token }, body: bytes,
  }), { ...env, REMOTE_SANDBOX_ENABLED: "true" });
  expect(uploaded?.status).toBe(200);
  const snapshot = { files: [{ path: "a.txt", sha256: sha, bytes: bytes.length, mime: "text/plain", mode: 420 }], directories: [], totalBytes: bytes.length };
  const outcome = { kind: "completed", snapshot, result: { stdout: "测试通过", stderr: "", code: 0, timedOut: false, truncated: false } };
  await fleet().complete(device.deviceId, id, outcome);
  await fleet().complete(device.deviceId, id, outcome);
  const status = await withWorkspace(name, remote => remote.finish(id));
  expect(status).toMatchObject({ phase: "completed", persistence: { state: "committed" }, result: { stdout: "测试通过" } });
  expect(await withWorkspace(name, remote => remote.finish(id))).toEqual(status);
  expect((await env.SANDBOX.getByName(name).files()).revision).not.toBe(input.baseRevision);
  expect(new TextDecoder().decode((await env.SANDBOX.getByName(name).readBlob("a.txt")).bytes)).toBe("完成");
  const next = await withWorkspace(name, remote => remote.start("exec-unknown", operation));
  await fleet().complete(device.deviceId, next.jobId, { kind: "unknown", reason: "lost" });
  expect(await withWorkspace(name, remote => remote.finish(next.jobId))).toMatchObject({ persistence: { state: "unknown" } });
  await expect(withWorkspace(name, remote => remote.release())).rejects.toThrow("remote_job_running");
  await fleet().complete(device.deviceId, next.jobId, { kind: "cancelled", reason: "stopped" });
  await withWorkspace(name, remote => remote.finish(next.jobId));
  await withWorkspace(name, remote => remote.release());
});
it("重复任务拒绝不同参数，跨设备/工作区不可读取任务", async () => {
  const device = await register(), workspace = env.SANDBOX.idFromName("conflict").toString();
  const lease = await fleet().acquire({ sandboxId: "remote:" + device.deviceId, workspace, operationId: "lease", capabilityRevision: device.revision, taskType: "shell.exec", requirements: {} });
  const input: JobInput = { id: crypto.randomUUID(), lease, operation, source: { files: [], directories: [], totalBytes: 0 }, baseRevision: "0", createdAt: Date.now(), deadline: Date.now() + 10000 };
  await fleet().start(input);
  await expect((async () => await fleet().start({ ...input, operation: { ...operation, command: "different" } }))()).rejects.toThrow("operation_conflict");
  await expect((async () => await fleet().input("another-device", input.id))()).rejects.toThrow("permission_denied");
  await expect((async () => await fleet().inspect("another-workspace", input.id))()).rejects.toThrow("permission_denied");
});
it("回传版本冲突不覆盖新修订；管理员封存未知任务后拒绝晚到结果", async () => {
  const device = await register(), name = "remote-conflict";
  await withWorkspace(name, remote => remote.acquire({ sandboxId: "remote:" + device.deviceId, capabilityRevision: device.revision, operationId: "lease", taskType: "shell.exec", requirements: {} }));
  const started = await withWorkspace(name, remote => remote.start("conflict-exec", operation));
  const bytes = new TextEncoder().encode("较新的修订"), sha = await hash(bytes);
  await env.ASSETS.put(await scopePrefix("fixture") + "/workspace/blobs/" + sha, bytes);
  const head = await withWorkspace(name, async (_remote, workspace) => {
    const current = await workspace.files();
    return workspace.importSnapshot({ manifest: { schemaVersion: 1, workspace: "fixture", revision: crypto.randomUUID(), parentRevision: null,
      files: [{ path: "new.txt", sha256: sha, bytes: bytes.length, mime: "text/plain", mode: 420 }], directories: [], totalBytes: bytes.length }, expectedRevision: current.revision });
  });
  expect(head.ok).toBe(true);
  await fleet().complete(device.deviceId, started.jobId, { kind: "completed", snapshot: { files: [], directories: [], totalBytes: 0 }, result: { stdout: "", stderr: "", code: 0, timedOut: false, truncated: false } });
  expect(await withWorkspace(name, remote => remote.finish(started.jobId))).toMatchObject({ persistence: { state: "conflict" } });
  expect(new TextDecoder().decode((await env.SANDBOX.getByName(name).readBlob("new.txt")).bytes)).toBe("较新的修订");
  const next = await withWorkspace(name, remote => remote.start("abandon-exec", operation));
  await fleet().complete(device.deviceId, next.jobId, { kind: "unknown", reason: "device_lost" });
  await fleet().abandon(next.jobId);
  expect(await withWorkspace(name, remote => remote.finish(next.jobId))).toMatchObject({ persistence: { state: "failed" }, result: { error: "admin_abandoned_execution_unknown" } });
  await expect((async () => await fleet().complete(device.deviceId, next.jobId, { kind: "cancelled", reason: "late" }))()).rejects.toThrow("operation_conflict");
  await withWorkspace(name, remote => remote.release());
});
it("管理 API 默认关闭，批准接口必须管理员认证", async () => {
  const req = new Request("https://test/admin/sandbox-devices");
  expect((await remoteSandboxRoutes(req, env))?.status).toBe(404);
  expect((await remoteSandboxRoutes(req, { ...env, REMOTE_SANDBOX_ENABLED: "true", ADMIN_TOKEN: "admin" }))?.status).toBe(401);
  expect((await remoteSandboxRoutes(new Request(req, { headers: { Authorization: "Bearer admin" } }), { ...env, REMOTE_SANDBOX_ENABLED: "true", ADMIN_TOKEN: "admin" }))?.status).toBe(200);
});
