import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { readResources, readResource } from "../src/sandbox/resources";
import { readCatalog, readJob, readJobInput } from "../src/remote-sandbox/wire";
import { hash } from "../src/remote-sandbox/fleet";
import { CLOUDFLARE_SANDBOX } from "../src/sandbox/registration";
import { remoteSandboxRoutes } from "../src/remote-sandbox/routes";
import { PowerShellInputSchema, PROTOCOL_VERSION, parse, JsonObjectSchema, type Descriptor } from "../../runner/src/protocol";
const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await reset(); });
const descriptor: Descriptor = { name: "测试 WSB", provider: "windows-wsb", os: "windows", arch: "x64",
  instructions: "使用 powershell，工作区在 guest 内。", persistence: "同租约保留，释放后丢弃。",
  tools: [{ name: "powershell", description: "在 guest 中运行命令", inputSchema: parse(JsonObjectSchema, JSON.parse(JSON.stringify(PowerShellInputSchema))) }],
  environment: [{ name: "node", version: "v24" }], memoryMiB: 4096, maxConcurrent: 1, maxTimeoutMs: 1200000, workspaceProtocol: "registered-tools-v2" };
const fleet = () => env.SANDBOX_FLEET.getByName("owner");
const enable = async () => fleet().putSettings({ enabled: true, expectedRevision: (await fleet().settings()).revision });
const nextFrame = (socket: WebSocket) => new Promise<MessageEvent>(resolve => socket.addEventListener("message", resolve, { once: true }));
async function register(registration: Descriptor = descriptor) {
  await enable();
  const pairing = await fleet().createPairing(), token = "a".repeat(64);
  const claim = { pairingId: pairing.pairingId, code: pairing.code, tokenHash: await hash(token), descriptor: registration };
  const device = await fleet().claim(claim);
  expect(await fleet().claim(claim)).toEqual(device);
  expect(readCatalog(await fleet().catalogJson())).toHaveLength(1);
  await expect((async () => await fleet().claim({ ...claim, tokenHash: "b".repeat(64) }))()).rejects.toThrow("pairing_denied");
  await fleet().approve(device.deviceId);
  const response = await fleet().fetch(new Request("https://test/connect?device=" + device.deviceId, { headers: { Upgrade: "websocket", Authorization: "Bearer " + token } }));
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  const welcome = nextFrame(socket);
  socket.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, descriptor: registration }));
  expect(JSON.parse((await welcome).data).kind).toBe("welcome");
  return { deviceId: device.deviceId, token, socket, revision: await hash(JSON.stringify(registration)) };
}
const request = (leaseId: string, command = "Write-Output '中文'") => ({ leaseId, tool: "powershell", arguments: { command }, timeoutMs: 1000 });
const completed = { kind: "completed", result: { stdout: "测试通过", stderr: "", code: 0, timedOut: false, truncated: false } };
it("自定义沙箱的使用说明随注册更新，目录保留提供方语义并使旧能力版本失效", async () => {
  const registration: Descriptor = { ...descriptor, name: "研究环境", provider: "custom-notebook", os: "linux", workspaceRoot: "/notebooks",
    instructions: "使用 python_cell；变量保留到 kernel 重启。", persistence: "外部卷跨租约保留。",
    tools: [{ name: "python_cell", description: "运行 Python 单元并返回 value", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } }] };
  const device = await register(registration);
  const catalog = readCatalog(await fleet().catalogJson({ tools: ["python_cell"] }));
  expect(catalog.find(row => row.id === "cloudflare")).toMatchObject({ instructions: CLOUDFLARE_SANDBOX.instructions, codeModeTools: CLOUDFLARE_SANDBOX.codeModeTools });
  expect(catalog.find(row => row.id.startsWith("remote:"))).toMatchObject({ instructions: registration.instructions, persistence: registration.persistence, mismatch: [] });
  const updated = { ...registration, instructions: "使用 python_cell；返回 value，无进程退出码。" };
  const welcome = nextFrame(device.socket);
  device.socket.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, descriptor: updated }));
  expect(JSON.parse((await welcome).data).kind).toBe("welcome");
  const current = readCatalog(await fleet().catalogJson()).find(row => row.id.startsWith("remote:"))!;
  expect(current.instructions).toBe(updated.instructions);
  expect(current.capabilityRevision).not.toBe(device.revision);
  const args = { sandboxId: current.id, workspace: "owner", operationId: "notebook-lease", requirements: {} };
  await expect((async () => await fleet().acquire({ ...args, capabilityRevision: device.revision }))()).rejects.toThrow("capability_changed");
  const lease = await fleet().acquire({ ...args, capabilityRevision: current.capabilityRevision });
  const call = await fleet().invoke("owner", "notebook-call", { leaseId: lease.id, tool: "python_cell", arguments: { code: "6 * 7" }, timeoutMs: 1000 });
  await fleet().complete(device.deviceId, call.jobId, { kind: "completed", result: { value: 42 } });
  expect(readJob(await fleet().inspectJson("owner", call.jobId)).outcome).toEqual({ kind: "completed", result: { value: 42 } });
});
async function acquire(device: Awaited<ReturnType<typeof register>>, workspace = "owner") {
  return fleet().acquire({ sandboxId: "remote:" + device.deviceId, workspace, operationId: "acquire-1", capabilityRevision: device.revision, requirements: { tools: ["powershell"] } });
}
it("配对批准后才公布工具声明；租约冻结能力版本、需求和单槽位", async () => {
  const device = await register();
  expect((readCatalog(await fleet().catalogJson({ tools: ["powershell"] }))).find(row => row.id.startsWith("remote:"))).toMatchObject({ tools: descriptor.tools, instructions: descriptor.instructions, persistence: descriptor.persistence, mismatch: [] });
  const args = { sandboxId: "remote:" + device.deviceId, workspace: "owner", operationId: "acquire-1", capabilityRevision: device.revision, requirements: {} };
  await expect((async () => await fleet().acquire({ ...args, capabilityRevision: "0".repeat(64) }))()).rejects.toThrow("capability_changed");
  await expect((async () => await fleet().acquire({ ...args, requirements: { os: "linux" } }))()).rejects.toThrow("capability_mismatch");
  await expect((async () => await fleet().acquire({ ...args, requirements: { tools: ["bash"] } }))()).rejects.toThrow("capability_mismatch");
  const lease = await fleet().acquire(args); expect(await fleet().acquire(args)).toEqual(lease);
  await expect((async () => await fleet().acquire({ ...args, operationId: "acquire-2" }))()).rejects.toThrow("busy");
  const changed = nextFrame(device.socket);
  device.socket.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, descriptor: { ...descriptor, instructions: "改变使用方式" } }));
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
it("停用时管理 API 仍需认证且可访问；旧源码上传端点不存在", async () => {
  const req = new Request("https://test/admin/sandbox-devices");
  expect((await remoteSandboxRoutes(req, env))?.status).toBe(401);
  expect((await remoteSandboxRoutes(req, { ...env, REMOTE_SANDBOX_ENABLED: "true", ADMIN_TOKEN: "admin" }))?.status).toBe(401);
  expect((await remoteSandboxRoutes(new Request(req, { headers: { Authorization: "Bearer admin" } }), { ...env, REMOTE_SANDBOX_ENABLED: "true", ADMIN_TOKEN: "admin" }))?.status).toBe(200);
  const device = await register();
  const upload = new Request(`https://test/sandbox-devices/${device.deviceId}/jobs/job/objects/${"a".repeat(64)}`, { method: "PUT", headers: { Authorization: "Bearer " + device.token }, body: "not source" });
  expect((await remoteSandboxRoutes(upload, { ...env, REMOTE_SANDBOX_ENABLED: "true" }))?.status).toBe(404);
});
it("旧协议拒绝注册；不安全工具 schema 在配对边界被拒绝", async () => {
  await enable();
  const pairing = await fleet().createPairing();
  const claim = { pairingId: pairing.pairingId, code: pairing.code, tokenHash: "a".repeat(64), descriptor };
  await expect((async () => await fleet().claim({ ...claim, descriptor: { ...descriptor, workspaceProtocol: "r2-source-v1" } }))()).rejects.toThrow("invalid_request");
  await expect((async () => await fleet().claim({ ...claim, descriptor: { ...descriptor, tools: [{ name: "powershell", description: "bad", inputSchema: { type: "object", additionalProperties: false, $ref: "https://example.com" } }] } }))()).rejects.toThrow("unsupported_tool_schema");
});

const adminRequest = (method: string, suffix: string, value?: unknown, token = "admin") => remoteSandboxRoutes(new Request("https://test/admin/sandbox-devices" + suffix, {
  method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: value === undefined ? undefined : JSON.stringify(value),
}), { ...env, ADMIN_TOKEN: "admin" });
it("管理页开关无需部署，配置持久化并防止旧页面覆盖；配对码不进入设备列表", async () => {
  expect((await adminRequest("GET", "/overview", undefined, "wrong"))?.status).toBe(401);
  expect(await (await adminRequest("GET", "/settings"))!.json()).toMatchObject({ enabled: false, revision: 0 });
  expect((await adminRequest("POST", "/pairings"))?.status).toBe(403);
  expect((await adminRequest("PUT", "/settings", { enabled: "true", expectedRevision: 0 }))?.status).toBe(400);
  expect(await (await adminRequest("PUT", "/settings", { enabled: true, expectedRevision: 0 }))!.json()).toMatchObject({ enabled: true, revision: 1 });
  expect((await adminRequest("PUT", "/settings", { enabled: false, expectedRevision: 0 }))?.status).toBe(409);
  const pairing = await (await adminRequest("POST", "/pairings"))!.json<{ pairingId: string; code: string }>();
  const token = "d".repeat(64), device = await fleet().claim({ pairingId: pairing.pairingId, code: pairing.code, tokenHash: await hash(token), descriptor });
  const response = (await adminRequest("GET", "/overview"))!;
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(text).toContain("pending");expect(text).toContain(descriptor.instructions);
  expect(text).not.toContain(pairing.code);expect(text).not.toContain(await hash(token));expect(text).not.toContain("tokenHash");
  expect((await adminRequest("POST", "/" + device.deviceId + "/approve"))?.status).toBe(200);
  expect((await adminRequest("DELETE", "/" + device.deviceId))?.status).toBe(200);
  await runInDurableObject(fleet(), async (_instance, state) => {
    const { SandboxFleetDO } = await import("../src/remote-sandbox/fleet");
    expect(await new SandboxFleetDO(state, { ...env, REMOTE_SANDBOX_ENABLED: "false" }).enabled()).toBe(true);
  });
});
it("停用拒绝新租约与任务，但保留回传、取消和释放；过期操作不能作用到新租约", async () => {
  const device = await register(), lease = await acquire(device), call = await fleet().invoke("owner", "running", request(lease.id));
  const settings = await fleet().settings();
  expect((await adminRequest("PUT", "/settings", { enabled: false, expectedRevision: settings.revision }))?.status).toBe(200);
  await expect((async () => await fleet().invoke("owner", "new-call", request(lease.id)))()).rejects.toThrow("disabled");
  await expect((async () => await acquire(device, "other"))()).rejects.toThrow("disabled");
  expect((await adminRequest("POST", "/" + device.deviceId + "/release", { leaseId: "stale" }))?.status).toBe(400);
  expect((await adminRequest("POST", "/" + device.deviceId + "/release", { leaseId: lease.id }))?.status).toBe(409);
  expect((await adminRequest("POST", "/" + device.deviceId + "/cancel", { jobId: call.jobId }))?.status).toBe(200);
  const result = await remoteSandboxRoutes(new Request(`https://test/sandbox-devices/${device.deviceId}/jobs/${call.jobId}/result`, {
    method: "POST", headers: { Authorization: "Bearer " + device.token }, body: JSON.stringify({ kind: "cancelled", reason: "stopped", sessionLost: true }),
  }), env);
  expect(result?.status).toBe(200);
  expect((await adminRequest("POST", "/" + device.deviceId + "/release", { leaseId: lease.id }))?.status).toBe(200);
  await runInDurableObject(fleet(), async (instance, state) => { await instance.webSocketMessage(state.getWebSockets(device.deviceId)[0]!, JSON.stringify({ kind: "released", leaseId: lease.id })); });
  expect(await fleet().sessions("owner")).toEqual([]);
});

it("共享资源复用租约但保留任务归属；退出一方不停止另一方，重建仍绑定原持久目录", async () => {
  const device = await register({ ...descriptor, workspacePreparation: "git-clone-v1" });
  const resources = readResources(await fleet().resourcesJson("owner")), remote = resources.find(row => row.kind === "remote")!;
  const args = { sandboxId: remote.id, capabilityRevision: device.revision, requirements: {} };
  const parent = await fleet().acquireResource("owner", "parent", "parent-acquire", args);
  const child = await fleet().acquireResource("owner", "child", "child-acquire", args);
  expect(child.id).toBe(parent.id);
  expect(child.workspace).toBe(env.SANDBOX.idFromName("owner").toString());
  const running = await fleet().invoke("parent", "p", request(parent.id));
  expect((await fleet().sessions("child"))[0]?.jobId).toBeNull();
  await expect((async () => await fleet().cancel("child", running.jobId))()).rejects.toThrow("permission_denied");
  await expect((async () => await fleet().invoke("child", "c", request(child.id)))()).rejects.toThrow("job_running");
  await fleet().release("child", child.id);
  await fleet().release("child", child.id);
  expect(await fleet().sessions("child")).toEqual([]);
  expect((await fleet().sessions("parent"))[0]).toMatchObject({ state: "active", jobId: running.jobId });
  await expect((async () => await fleet().invoke("child", "late", request(child.id)))()).rejects.toThrow("lease_expired");
  const rejoined = await fleet().acquireResource("owner", "child", "child-rejoin", args);
  expect(rejoined.id).toBe(parent.id);
  await fleet().release("child", rejoined.id);
  expect(await fleet().sessions("child")).toEqual([]);
  await fleet().complete(device.deviceId, running.jobId, completed);
  const independent = readResource(await fleet().createResourceJson("owner", "new-resource", { providerId: remote.providerId, sourceId: remote.id }));
  await expect((async () => await fleet().acquireResource("owner", "child", "different", { ...args, sandboxId: independent.id }))()).rejects.toThrow("busy");
  await fleet().release("parent", parent.id);
  await runInDurableObject(fleet(), async (instance, state) => { await instance.webSocketMessage(state.getWebSockets(device.deviceId)[0]!, JSON.stringify({ kind: "released", leaseId: parent.id })); });
  const recreated = await fleet().acquireResource("owner", "parent", "new-lease", args);
  expect(recreated.id).not.toBe(parent.id); expect(recreated.workspace).toBe(parent.workspace);
  await fleet().release("parent", recreated.id);
  await runInDurableObject(fleet(), async (instance, state) => { await instance.webSocketMessage(state.getWebSockets(device.deviceId)[0]!, JSON.stringify({ kind: "released", leaseId: recreated.id })); });
  const cloned = await fleet().acquireResource("owner", "child", "clone-lease", { ...args, sandboxId: independent.id });
  expect(cloned.workspace).toBe(independent.id);
  expect(cloned.workspaceSource?.workspace).toBe(parent.workspace);
});

it("资源创建幂等、跨会话不可见、显式克隆检验提供方能力", async () => {
  const device = await register(), providerId = "remote:" + device.deviceId;
  const defaults = readResources(await fleet().resourcesJson("owner")), remote = defaults.find(row => row.kind === "remote")!;
  const empty = readResource(await fleet().createResourceJson("owner", "new", { providerId }));
  expect(readResource(await fleet().createResourceJson("owner", "new", { providerId }))).toEqual(empty);
  await expect((async () => await fleet().createResourceJson("owner", "new", { providerId: "cloudflare" }))()).rejects.toThrow("operation_conflict");
  await expect((async () => await fleet().resourceJson("group:123", empty.id))()).rejects.toThrow("sandbox_not_found");
  await expect((async () => await fleet().acquireResource("group:123", "attacker", "op", { sandboxId: empty.id, capabilityRevision: device.revision, requirements: {} }))()).rejects.toThrow("sandbox_not_found");
  await expect((async () => await fleet().createResourceJson("owner", "clone", { providerId, sourceId: remote.id }))()).rejects.toThrow("clone_not_supported");
  await expect((async () => await fleet().createResourceJson("owner", "cross-provider", { providerId: "cloudflare", sourceId: remote.id }))()).rejects.toThrow("clone_provider_mismatch");
  expect(await fleet().sessions("owner")).toEqual([]);
});
