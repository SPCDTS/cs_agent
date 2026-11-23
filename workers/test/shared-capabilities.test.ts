import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceManager } from "../src/sandbox/workspace";
import { SharedMount } from "../src/sandbox/shared-mount";
import { connectionDigest } from "../src/mcp/names";
import { RegistryDO } from "../src/registry";
import { TokenVault } from "../src/mcp/crypto";
import { runtime } from "./sandbox-runtime-fixture";
import { TEST_STORE_KEY } from "./mcp-helpers";

const registry = () => env.REGISTRY.getByName("main");
const markdown = "---\nname: query\ndescription: 查询\n---\n运行 query.py";
const bytes = (text: string) => new TextEncoder().encode(text);
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("已安装脚本和普通 Cookie 跨工作区可读，群工作区独立，提交响应丢失后不重跑命令", async () => {
  await registry().skillPut({ name: "query", description: "查询", body: markdown, files: { "query.py": "print(42)" } });
  await runInDurableObject(env.SANDBOX.getByName("owner"), async (_instance, state) => {
    const local = runtime(),
      shared = runtime(),
      mount = new SharedMount(registry, "owner-test", () => shared.client);
    const deps = {
      workspace: "owner-test",
      storage: state.storage,
      bucket: env.ASSETS,
      runtime: local.client,
      shared: mount,
      runtimeReady: local.ready,
      resetRuntime: local.reset
    };
    const manager = new WorkspaceManager(deps);
    const exec = vi.spyOn(local.client, "exec").mockImplementation(async () => {
      await shared.client.writeFile("skills/query/cookies.txt", "登录态");
      await local.client.writeFile("out/private.txt", "私有结果");
      return { stdout: "ok", stderr: "", code: 0, timedOut: false, truncated: false };
    });
    const apply = mount.apply.bind(mount);
    vi.spyOn(mount, "apply").mockImplementationOnce(async (epoch, batch) => {
      await apply(epoch, batch);
      throw new Error("response_lost");
    });
    vi.spyOn(mount, "resolve").mockRejectedValueOnce(new Error("registry_temporarily_offline"));
    const operation = { operationId: "login", operation: { kind: "exec" as const, command: "login" }, sharedAccess: "owner" as const };
    expect((await manager.run(operation)).status).toBe("unknown");
    const rebuilt = new WorkspaceManager(deps);
    expect((await rebuilt.run(operation)).status).toBe("committed");
    expect(exec).toHaveBeenCalledTimes(1);
    expect((await manager.files()).files.map((file) => file.path)).toEqual(["out/private.txt"]);
  });
  await runInDurableObject(env.SANDBOX.getByName("group:test"), async (_instance, state) => {
    const local = runtime(),
      shared = runtime(),
      mount = new SharedMount(registry, "group-test", () => shared.client);
    const manager = new WorkspaceManager({
      workspace: "group-test",
      storage: state.storage,
      bucket: env.ASSETS,
      runtime: local.client,
      shared: mount,
      runtimeReady: local.ready,
      resetRuntime: local.reset
    });
    vi.spyOn(local.client, "exec").mockImplementation(async () => ({
      stdout: new TextDecoder().decode(await shared.client.readBlob("skills/query/cookies.txt")),
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false
    }));
    expect(
      await manager.run({ operationId: "query", sharedAccess: "reader", operation: { kind: "exec", command: "query" } })
    ).toMatchObject({ result: { stdout: "登录态" } });
    expect(await shared.client.readBlob("skills/query/query.py")).toEqual(bytes("print(42)"));
    await expect(
      manager.run({
        operationId: "write",
        sharedAccess: "reader",
        operation: { kind: "write", path: "/shared/skills/query/cookies.txt", text: "group" }
      })
    ).rejects.toThrow("permission_denied");
    expect((await manager.files()).files).toEqual([]);
  });
});

it("直接安装的技能进入目录，停用和删除立即反映到群投影", async () => {
  const r = registry();
  await r.sharedApply("terminal", 1, (await r.sharedManifest("owner")).revision, [
    { path: "skills/query/SKILL.md", bytes: bytes(markdown), mode: 420 },
    { path: "skills/query/payload.bin", bytes: new Uint8Array([255, 0, 7]), mode: 384 }
  ]);
  expect(await r.skillGet("query")).toMatchObject({ enabled: true, body: markdown });
  expect(await r.sharedRead("reader", "skills/query/payload.bin")).toEqual(new Uint8Array([255, 0, 7]));
  const visible = await r.sharedVersion("reader");
  await r.skillSetEnabled("query", false);
  expect(await r.sharedVersion("reader")).not.toBe(visible);
  expect((await r.sharedManifest("reader")).snapshot.files.some((file) => file.path.startsWith("skills/query/"))).toBe(false);
  await expect(async () => await r.sharedRead("reader", "skills/query/payload.bin")).rejects.toThrow("permission_denied");
  await r.skillDelete("query");
  expect((await r.sharedManifest("owner")).snapshot.files.some((file) => file.path.startsWith("skills/query/"))).toBe(false);
});

it("目录编辑与管理台、连接器使用同一份配置；轮换、冲突、群投影和断线围栏", async () => {
  const r = registry(),
    saved = await r.mcpServerPut({ id: "query", url: "https://example.test/mcp", auth: "token" }, "absent");
  await r.mcpCredentialPut("query", saved.revision, { Authorization: "Bearer first" });
  const owner = await r.sharedManifest("owner"),
    reader = await r.sharedManifest("reader");
  expect(reader.snapshot.files.some((file) => file.path.startsWith("mcp/"))).toBe(false);
  await expect(async () => await r.sharedRead("reader", "mcp/query/headers.json")).rejects.toThrow("permission_denied");
  const config = owner.snapshot.files.find((file) => file.path === "mcp/query/server.json")!;
  const server = JSON.parse(new TextDecoder().decode(await r.sharedRead("owner", config.path, config.sha256)));
  expect(server.id).toBe("query");
  const changes = [{ path: "mcp/query/headers.json", bytes: bytes('{"Authorization":"Bearer second"}'), mode: 384 }];
  await r.sharedApply("writer", 1, owner.revision, changes);
  const fresh = (await r.mcpServerGet("query")).server;
  expect(await r.mcpCredentialHeaders("query", connectionDigest(fresh))).toEqual({ Authorization: "Bearer second" });
  await expect(async () => await r.mcpCredentialHeaders("query", connectionDigest(server))).rejects.toThrow("conflict");
  await expect(async () => await r.sharedApply("other", 1, owner.revision, changes)).rejects.toThrow("workspace_conflict");
  expect(await r.sharedResolve("late", 1)).toBe(false);
  await expect(async () => await r.sharedApply("late", 1, (await r.sharedManifest("owner")).revision, changes)).rejects.toThrow(
    "workspace_conflict"
  );
  await r.sharedApply("writer", 2, (await r.sharedManifest("owner")).revision, [
    {
      path: config.path,
      mode: 420,
      bytes: bytes(JSON.stringify({ ...fresh, transport: { ...fresh.transport, url: "https://another.example.test/mcp" } }))
    }
  ]);
  expect((await r.mcpServerGet("query")).credentialSet).toBe(false);
});

it("旧技能、加密 OAuth 和旧部署认证头升级后只用目录，重建时保留登录", async () => {
  await runInDurableObject(registry(), async (_instance, state) => {
    const sql = state.storage.sql,
      vault = new TokenVault(TEST_STORE_KEY);
    sql.exec("INSERT INTO skills VALUES(?,?,?,?,?,?)", "query", "查询", markdown, JSON.stringify({ "query.py": "print(1)" }), 123, 1);
    const aad = (field: string) => JSON.stringify(["notion", "owner-notion", "1", field]);
    sql.exec(
      "INSERT INTO mcp_oauth_tokens VALUES(?,?,?,?,?,?,?,?,?)",
      "notion",
      "owner-notion",
      "1",
      "https://auth.example.test",
      await vault.encrypt("old-access", aad("access")),
      await vault.encrypt("old-refresh", aad("refresh")),
      null,
      null,
      123
    );
    let upgraded = new RegistryDO(state, { ...env, CS2_WORKSHOP_AUTHORIZATION: "Bearer legacy" });
    expect(await upgraded.accessToken("notion")).toBe("old-access");
    expect(upgraded.skillGet("query")).toMatchObject({ files: { "query.py": "print(1)" }, updatedAt: 123 });
    const workshop = upgraded.mcpServerGet("cs2-workshop").server;
    expect(workshop.credential.kind).toBe("managed");
    upgraded = new RegistryDO(state, { ...env, CS2_WORKSHOP_AUTHORIZATION: undefined });
    expect(await upgraded.mcpCredentialHeaders(workshop.id, connectionDigest(workshop))).toEqual({ Authorization: "Bearer legacy" });
    expect(upgraded.sharedRead("reader", "skills/query/query.py")).toEqual(bytes("print(1)"));
    expect(sql.exec("SELECT 1 FROM mcp_oauth_tokens").toArray()).toEqual([]);
  });
});
