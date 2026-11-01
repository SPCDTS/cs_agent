import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { readCatalog, readJob, readJobInput } from "../src/remote-sandbox/wire";
import { hash } from "../src/remote-sandbox/fleet";
import { remoteSandboxRoutes } from "../src/remote-sandbox/routes";
import { PowerShellInputSchema, PROTOCOL_VERSION, parse, JsonObjectSchema, type Descriptor } from "../../runner/src/protocol";
const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await reset(); });
const descriptor: Descriptor = { name: "测试 WSB", provider: "windows-wsb", os: "windows", arch: "x64",
  tools: [{ name: "powershell", description: "在 guest 中运行命令", inputSchema: parse(JsonObjectSchema, JSON.parse(JSON.stringify(PowerShellInputSchema))) }],
  environment: [{ name: "node", version: "v24" }], memoryMiB: 4096, maxConcurrent: 1, maxTimeoutMs: 1200000, workspaceProtocol: "registered-tools-v2" };
const fleet = () => env.SANDBOX_FLEET.getByName("owner");
const nextFrame = (socket: WebSocket) => new Promise<MessageEvent>(resolve => socket.addEventListener("message", resolve, { once: true }));
async function register() {
  const pairing = await fleet().createPairing(), token = "a".repeat(64);
  const claim = { pairingId: pairing.pairingId, code: pairing.code, tokenHash: await hash(token), descriptor };
  const device = await fleet().claim(claim);
  expect(await fleet().claim(claim)).toEqual(device);
  expect(readCatalog(await fleet().catalogJson())).toHaveLength(1);
  await expect((async () => await fleet().claim({ ...claim, tokenHash: "b".repeat(64) }))()).rejects.toThrow("pairing_denied");
  await fleet().approve(device.deviceId);
  const response = await fleet().fetch(new Request("https://test/connect?device=" + device.deviceId, { headers: { Upgrade: "websocket", Authorization: "Bearer " + token } }));
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const welcome = nextFrame(socket);
  socket.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, descriptor }));
  expect(JSON.parse((await welcome).data).kind).toBe("welcome");
  return { deviceId: device.deviceId, token, socket, revision: await hash(JSON.stringify(descriptor)) };
}
const request = (leaseId: string, command = "Write-Output '中文'") => ({ leaseId, tool: "powershell", arguments: { command }, timeoutMs: 1000 });
const completed = { kind: "completed", result: { stdout: "测试通过", stderr: "", code: 0, timedOut: false, truncated: false } };
async function acquire(device: Awaited<ReturnType<typeof register>>, workspace = "owner") {
  return fleet().acquire({ sandboxId: "remote:" + device.deviceId, workspace, operationId: "acquire-1", capabilityRevision: device.revision, requirements: { tools: ["powershell"] } });
}
it("配对批准后才公布工具声明；租约冻结能力版本、需求和单槽位", async () => {
  const device = await register();
  expect((readCatalog(await fleet().catalogJson({ tools: ["powershell"] }))).find(row => row.id.startsWith("remote:"))).toMatchObject({ tools: descriptor.tools, mismatch: [] });
  const args = { sandboxId: "remote:" + device.deviceId, workspace: "owner", operationId: "acquire-1", capabilityRevision: device.revision, requirements: {} };
  await expect((async () => await fleet().acquire({ ...args, capabilityRevision: "0".repeat(64) }))()).rejects.toThrow("capability_changed");
  await expect((async () => await fleet().acquire({ ...args, requirements: { os: "linux" } }))()).rejects.toThrow("capability_mismatch");
  await expect((async () => await fleet().acquire({ ...args, requirements: { tools: ["bash"] } }))()).rejects.toThrow("capability_mismatch");
  const lease = await fleet().acquire(args); expect(await fleet().acquire(args)).toEqual(lease);
  await expect((async () => await fleet().acquire({ ...args, operationId: "acquire-2" }))()).rejects.toThrow("busy");
  const changed = nextFrame(device.socket);
  device.socket.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, descriptor: { ...descriptor, name: "改变配置" } }));
  expect(JSON.parse((await changed).data)).toMatchObject({ kind: "error", error: "capability_changed_while_leased" });
  expect(await fleet().authorize(device.deviceId, "Bearer " + "b".repeat(64))).toBe(false);
  await fleet().revoke(device.deviceId);
  expect(await fleet().authorize(device.deviceId, "Bearer " + device.token)).toBe(false);
});
it("只分派注册工具并验证 schema；幂等调用不产生新任务，结果无源码同步", async () => {
  const device = await register(), lease = await acquire(device);
  await expect((async () => await fleet().invoke("owner", "bad-tool", { ...request(lease.id), tool: "node_test" }))()).rejects.toThrow("tool_not_registered");
  await expect((async () => await fleet().invoke("owner", "bad-input", { ...request(lease.id), arguments: { command: 1 } }))()).rejects.toThrow("invalid_tool_arguments");
  await expect((async () => await fleet().invoke("owner", "extra-input", { ...request(lease.id), arguments: { command: "ok", host: true } }))()).rejects.toThrow("invalid_tool_arguments");
  const call = await fleet().invoke("owner", "call-1", request(lease.id));
  expect(await fleet().invoke("owner", "call-1", request(lease.id))).toEqual(call);
  await expect((async () => await fleet().invoke("owner", "call-1", request(lease.id, "different")))()).rejects.toThrow("operation_conflict");
  await expect((async () => await fleet().invoke("owner", "call-2", request(lease.id)))()).rejects.toThrow("job_running");
  expect((await env.ASSETS.list()).objects).toEqual([]);
  await runInDurableObject(fleet(), async (_instance, state) => {
    expect((await state.storage.list({ prefix: "input:" })).size).toBe(1);
    expect((await state.storage.list({ prefix: "job:" })).size).toBe(1);
  });
  const input = readJobInput(await fleet().inputJson(device.deviceId, call.jobId));
  expect(input).toMatchObject({ tool: "powershell", arguments: request(lease.id).arguments, lease });
  expect(input).not.toHaveProperty("source"); expect(input).not.toHaveProperty("baseRevision");
  await fleet().complete(device.deviceId, call.jobId, completed);
  await fleet().complete(device.deviceId, call.jobId, completed);
  expect(readJob(await fleet().inspectJson("owner", call.jobId))).toMatchObject({ phase: "completed", outcome: completed });
  expect((await fleet().invoke("owner", "call-1", request(lease.id))).jobId).toBe(call.jobId);
  const next = await fleet().invoke("owner", "call-2", request(lease.id)); expect(next.jobId).not.toBe(call.jobId);
  const keys = (await env.ASSETS.list()).objects.map(object => object.key);
  expect(keys.every(key => key.startsWith("remote-jobs/") && !key.includes("/objects/") && !key.includes("/blobs/"))).toBe(true);
});
it("工作区和设备边界校验；旧 lease 不会改道到新租约", async () => {
  const device = await register(), lease = await acquire(device);
  await expect((async () => await fleet().invoke("other", "call", request(lease.id)))()).rejects.toThrow("lease_expired");
  const call = await fleet().invoke("owner", "call", request(lease.id));
  await expect((async () => await fleet().inputJson("other-device", call.jobId))()).rejects.toThrow("permission_denied");
  await expect((async () => await fleet().inspectJson("other", call.jobId))()).rejects.toThrow("permission_denied");
  await expect((async () => await fleet().cancel("other", call.jobId))()).rejects.toThrow("permission_denied");
  await expect((async () => await fleet().release("owner", lease.id))()).rejects.toThrow("job_running");
  await fleet().complete(device.deviceId, call.jobId, completed);
  await fleet().release("owner", lease.id);
  expect((await fleet().sessions("owner"))[0]?.state).toBe("releasing");
  await runInDurableObject(fleet(), async (instance, state) => { await instance.webSocketMessage(state.getWebSockets(device.deviceId)[0]!, JSON.stringify({ kind: "released", leaseId: lease.id })); });
  expect(await fleet().sessions("owner")).toEqual([]);
  const newer = await fleet().acquire({ sandboxId: lease.sandboxId, workspace: "owner", operationId: "new-lease", capabilityRevision: device.revision, requirements: {} });
  expect(newer.id).not.toBe(lease.id);
  await expect((async () => await fleet().invoke("owner", "old-lease-call", request(lease.id)))()).rejects.toThrow("lease_expired");
});
it("unknown 保留槽位，确认停止后失效租约；管理员封存不声称远端已停止", async () => {
  const device = await register(), lease = await acquire(device);
  const call = await fleet().invoke("owner", "call", request(lease.id));
  await fleet().complete(device.deviceId, call.jobId, { kind: "unknown", reason: "lost", sessionLost: true });
  await expect((async () => await fleet().release("owner", lease.id))()).rejects.toThrow("job_running");
  await expect((async () => await fleet().invoke("owner", "new", request(lease.id)))()).rejects.toThrow("session_lost");
  await fleet().cancel("owner", call.jobId);
  await fleet().complete(device.deviceId, call.jobId, { kind: "cancelled", reason: "stopped", sessionLost: true });
  expect((await fleet().sessions("owner"))[0]).toMatchObject({ state: "lost", jobId: null });
  await fleet().release("owner", lease.id);
  await expect((async () => await fleet().complete(device.deviceId, call.jobId, completed))()).rejects.toThrow("operation_conflict");
});
it("管理 API 默认关闭且需要认证；旧源码上传端点不存在", async () => {
  const req = new Request("https://test/admin/sandbox-devices");
  expect((await remoteSandboxRoutes(req, env))?.status).toBe(404);
  expect((await remoteSandboxRoutes(req, { ...env, REMOTE_SANDBOX_ENABLED: "true", ADMIN_TOKEN: "admin" }))?.status).toBe(401);
  expect((await remoteSandboxRoutes(new Request(req, { headers: { Authorization: "Bearer admin" } }), { ...env, REMOTE_SANDBOX_ENABLED: "true", ADMIN_TOKEN: "admin" }))?.status).toBe(200);
  const device = await register();
  const upload = new Request(`https://test/sandbox-devices/${device.deviceId}/jobs/job/objects/${"a".repeat(64)}`, { method: "PUT", headers: { Authorization: "Bearer " + device.token }, body: "not source" });
  expect((await remoteSandboxRoutes(upload, { ...env, REMOTE_SANDBOX_ENABLED: "true" }))?.status).toBe(404);
});
it("旧协议拒绝注册；不安全工具 schema 在配对边界被拒绝", async () => {
  const pairing = await fleet().createPairing();
  const claim = { pairingId: pairing.pairingId, code: pairing.code, tokenHash: "a".repeat(64), descriptor };
  await expect((async () => await fleet().claim({ ...claim, descriptor: { ...descriptor, workspaceProtocol: "r2-source-v1" } }))()).rejects.toThrow("invalid_request");
  await expect((async () => await fleet().claim({ ...claim, descriptor: { ...descriptor, tools: [{ name: "powershell", description: "bad", inputSchema: { type: "object", additionalProperties: false, $ref: "https://example.com" } }] } }))()).rejects.toThrow("unsupported_tool_schema");
});
