import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { TokenVault } from "../src/mcp/crypto";
import { MCP_CONFIG } from "../src/mcp/config";
import { sha256 } from "../src/media/model";
import { RegistryDO } from "../src/registry";
import type { SandboxClient, SkillExecResult } from "../src/sandbox/client";
import { SandboxDO } from "../src/sandbox/do";
import { legacyScopePrefix, scopePrefix } from "../src/media/repository";
import { SkillStateManager } from "../src/skill-runtime/state";
import { scriptedModel } from "./events-helpers";
import { input } from "./helpers";
import { gate, onlySubagent, reports, twoModels } from "./subagent-fixture";

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

const group = "group:200000001";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const registry = () => env.REGISTRY.getByName("main");

async function seedShopSkill() {
  await registry().skillPut({
    name: "shop",
    description: "商城查询",
    body: "---\nname: shop\ndescription: 商城查询\n---\n按说明调用 scripts/query.py 查询商品。",
    files: {
      "scripts/query.py": "print('query')",
    },
  });
}

function skillSandboxFixture(onExec: (ctx: {
  stateFiles: Map<string, Uint8Array>;
  outFiles: Map<string, Uint8Array>;
  command: string;
}) => Promise<SkillExecResult>) {
  let ready = false;
  let stateFiles = new Map<string, Uint8Array>();
  let outFiles = new Map<string, Uint8Array>();
  const client: SandboxClient = {
    async snapshot() { return { files: [], directories: [], totalBytes: 0 }; },
    async readBlob(path) {
      const rel = path.replace(/^\/work\/state\//, "");
      const value = stateFiles.get(rel);
      if (!value) throw new Error("not_found");
      return value;
    },
    async restore() { ready = true; },
    async exec() { return { stdout: "", stderr: "", code: 0, timedOut: false, truncated: false }; },
    async readFile() { return { text: "", startLine: 1, endLine: 1, totalLines: 1 }; },
    async writeFile() { return { bytes: 0 }; },
    async mkdir() {},
    async remove() {},
    async editFile() { return { replaced: 0 }; },
    async list() { return []; },
    async materializeSkill() {},
    async execSkillBash(call) {
      outFiles = new Map();
      return onExec({ stateFiles, outFiles, command: call.command });
    },
    async skillStateSnapshot() {
      const entries = await Promise.all([...stateFiles.entries()].map(async ([path, bytes]) => ({
        path,
        bytes: bytes.byteLength,
        sha256: await sha256(bytes),
        mime: "application/octet-stream",
        mode: 0o600,
      })));
      return { files: entries, directories: [], totalBytes: entries.reduce((sum, item) => sum + item.bytes, 0) };
    },
    async skillStateRestore(snapshot, readBlob) {
      ready = true;
      stateFiles = new Map(await Promise.all(snapshot.files.map(async file => [file.path, await readBlob(file)] as [string, Uint8Array])));
    },
    async readSkillOutBlob(path) {
      const value = outFiles.get(path);
      if (!value) throw new Error("not_found");
      return value;
    },
    async clearSkillOut() { outFiles.clear(); },
  };
  return { client, ready: () => ready, reset: async () => { ready = false; stateFiles = new Map(); outFiles = new Map(); return true; } };
}

describe("skill state sandbox & trusted group sharing", () => {
  it("SkillStateManager 加密写回 R2、冷启解密恢复、超时回滚、限制并发且垃圾回收孤儿 blob", async () => {
    const secretToken = "super-secret-oauth-refresh-token-12345";
    await runInDurableObject(env.SANDBOX.getByName("skill-state:shop"), async (_instance, state) => {
      const hold = gate();
      let step = 0;
      const fx = skillSandboxFixture(async ({ stateFiles, outFiles }) => {
        step++;
        if (step === 1) {
          stateFiles.set("session.json", encoder.encode(JSON.stringify({ token: secretToken, n: 1 })));
          const outBytes = encoder.encode('{"ok":true}');
          outFiles.set("out.json", outBytes);
          return { stdout: "step1", stderr: "", code: 0, timedOut: false, truncated: false, outputs: [{ path: "out.json", bytes: outBytes.byteLength, sha256: await sha256(outBytes) }] };
        }
        if (step === 2) {
          stateFiles.set("dirty.txt", encoder.encode("corrupt"));
          return { stdout: "", stderr: "timeout", code: null, timedOut: true, truncated: false, outputs: [] };
        }
        if (step === 3) {
          await hold.promise;
        }
        const restored = decoder.decode(stateFiles.get("session.json") ?? new Uint8Array());
        expect(restored).toContain(secretToken);
        expect(stateFiles.has("dirty.txt")).toBe(false);
        return { stdout: "restored", stderr: "", code: 0, timedOut: false, truncated: false, outputs: [] };
      });

      const manager = new SkillStateManager({
        workspaceId: state.id.toString(),
        bucket: env.ASSETS,
        storage: state.storage,
        vault: new TokenVault("01".repeat(32)),
        runtime: fx.client,
        runtimeReady: fx.ready,
        resetRuntime: fx.reset,
      });

      const run1 = await manager.runBash({
        skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "",
        command: "node login.js", timeoutMs: 5000,
      });
      expect(run1.code).toBe(0);
      expect(run1.outputs).toHaveLength(1);
      expect(decoder.decode(run1.outputs[0]!.data)).toBe('{"ok":true}');

      const prefix = `${await scopePrefix("skill-state:" + state.id.toString())}/skill-state/`;
      const listed = await env.ASSETS.list({ prefix });
      expect(listed.objects.length).toBeGreaterThanOrEqual(2);
      for (const obj of listed.objects) {
        const raw = new Uint8Array(await (await env.ASSETS.get(obj.key))!.arrayBuffer());
        expect(decoder.decode(raw)).not.toContain(secretToken);
        if (obj.key.includes("/blobs/")) {
          expect(decoder.decode(raw.subarray(0, 6))).toBe("CSENC1");
        } else {
          expect(decoder.decode(raw)).toMatch(/^v1\./);
        }
      }

      const run2 = await manager.runBash({
        skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "",
        command: "sleep 10", timeoutMs: 5000,
      });
      expect(run2.timedOut).toBe(true);
      expect(run2.stateRevision).toBe(run1.stateRevision);
      expect(fx.ready()).toBe(false);

      const p1 = manager.runBash({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", command: "ok", timeoutMs: 5000 });
      const p2 = manager.runBash({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", command: "ok", timeoutMs: 5000 });
      const p3 = manager.runBash({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", command: "ok", timeoutMs: 5000 });
      const p4 = manager.runBash({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", command: "ok", timeoutMs: 5000 });
      await expect(manager.runBash({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", command: "ok", timeoutMs: 5000 })).rejects.toThrow("skill_busy");
      hold.open();
      const results = await Promise.all([p1, p2, p3, p4]);
      expect(results.every(r => r.stdout === "restored")).toBe(true);

      // 5 次滚动写入后只保留最近 3 份 manifest，淘汰版本的孤儿 blob 被清理（session.json 仍被引用保留）
      for (let i = 1; i <= 5; i++) {
        await manager.importFiles({
          skill: "shop",
          files: [{ path: "rolling.txt", bytes: encoder.encode("rolling-secret-version-" + i) }],
        });
      }
      const afterRolling = await env.ASSETS.list({ prefix });
      const manifestObjs = afterRolling.objects.filter(obj => obj.key.includes("/manifests/"));
      const blobKeys = new Set(afterRolling.objects.filter(obj => obj.key.includes("/blobs/")).map(obj => obj.key));
      expect(manifestObjs).toHaveLength(3);
      expect(blobKeys.size).toBe(4);
      for (const evictedIdx of [1, 2]) {
        const evictedHash = await sha256(encoder.encode("rolling-secret-version-" + evictedIdx));
        expect(blobKeys.has(`${prefix}blobs/${evictedHash}`)).toBe(false);
      }
      for (const liveIdx of [3, 4, 5]) {
        const liveHash = await sha256(encoder.encode("rolling-secret-version-" + liveIdx));
        expect(blobKeys.has(`${prefix}blobs/${liveHash}`)).toBe(true);
      }

      // 路径冲突在写 R2 前拒绝，不留下孤儿 blob
      await manager.importFiles({ skill: "shop", files: [{ path: "dir/file.txt", bytes: encoder.encode("ok") }] });
      const beforeConflictCount = (await env.ASSETS.list({ prefix: `${prefix}blobs/` })).objects.length;
      await expect(manager.importFiles({ skill: "shop", files: [{ path: "dir", bytes: encoder.encode("conflict-blob") }] }))
        .rejects.toThrow("workspace_conflict");
      expect((await env.ASSETS.list({ prefix: `${prefix}blobs/` })).objects.length).toBe(beforeConflictCount);

      await manager.clear("shop");
      expect((await manager.list("shop")).fileCount).toBe(0);
    });
  });

  it("零配置普通 Skill：主人导入/登录并授权群后，群可用 skill_bash 复用状态与输出，未授权与管理越权被拦截", async () => {
    await seedShopSkill();
    const secret = "owner-cookie-secret-xyz";
    const ownerSandbox = env.SANDBOX.getByName("owner");
    await ownerSandbox.writeFile("/work/login/cookie.txt", encoder.encode("sid=" + secret), undefined, true);
    await ownerSandbox.writeObject("r2://login/extra.json", JSON.stringify({ token: secret }));

    const bashMock = vi.spyOn(SandboxDO.prototype, "skillBash");
    const code = (src: string): Parameters<typeof scriptedModel>[0] => [{ name: "codemode", args: { code: src } }, { name: "", args: {} }];
    const seen = scriptedModel([
      ...code(`
        text(await tools.skill_list({}));
        try { await tools.skill_bash({ skill: 'shop', command: 'echo denied' }); } catch (e) { text(String(e)); }
      `),
      ...code(`
        text(await tools.skill_state_import({ skill: 'shop', fromPath: '/work/login/cookie.txt', toPath: 'cookie.txt' }));
        text(await tools.skill_state_import({ skill: 'shop', fromPath: 'r2://login/extra.json', toPath: 'extra.json' }));
        text(await tools.skill_state_list({ skill: 'shop' }));
        text(await tools.skill_grant({ skill: 'shop', group: '${group}', enabled: true }));
      `),
      ...code(`
        text(await describeNamespace('skills'));
        text(await tools.skill_list({}));
        const res = await tools.skill_bash({ skill: 'shop', command: 'python3 /opt/skill/scripts/query.py keyboard' });
        text(res);
        text(await tools.r2_read({ key: res.outputs[0].path }));
      `),
      ...code(`
        try { await tools.skill_state_list({ skill: 'shop' }); } catch (e) { text(String(e)); }
        try { await tools.skill_grant({ skill: 'shop', group: '${group}', enabled: false }); } catch (e) { text(String(e)); }
      `),
    ]);

    // 未授权时群列表为空，且调用 skill_bash 返回 skill_denied
    await env.THREAD.getByName(group).submit(input(1, "未授权先试", 10000004, 200000001, true));
    expect(seen.outputs[0]).toContain('"skills":[]');
    expect(seen.outputs[0]).toContain("skill_denied");

    // 主人导入登录态并授权给群
    await env.THREAD.getByName("owner").submit(input(2, "导入并授权", 10000001));
    expect(seen.outputs[1]).toContain('"fileCount":2');
    expect(seen.outputs[1]).toContain('"enabled":true');
    expect(seen.outputs[1]).not.toContain(secret);

    // 群执行 skill_bash，验证挂载文件包含 SKILL.md 与附件，输出写入群 R2 临时区
    bashMock.mockResolvedValueOnce({
      stdout: '{"items":["hhkb"]}',
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      stateRevision: "rev-2",
      outputs: [{ path: "items.json", bytes: 16, data: encoder.encode('{"items":["hhkb"]}') }],
    });
    await env.THREAD.getByName(group).submit(input(3, "查商品", 10000004, 200000001, true));
    expect(seen.outputs[2]).toContain("hhkb");
    expect(seen.outputs[2]).toContain("r2://.tmp/");
    expect(bashMock).toHaveBeenCalledWith(expect.objectContaining({
      skill: "shop",
      command: "python3 /opt/skill/scripts/query.py keyboard",
      files: expect.objectContaining({ "SKILL.md": expect.stringContaining("商城查询"), "scripts/query.py": "print('query')" }),
    }));

    // 群无法调用主人管理类工具
    await env.THREAD.getByName(group).submit(input(4, "管理越权测试", 10000004, 200000001, true));
    expect(seen.outputs[3]).toContain("does not exist");
  });

  it("群执行中途撤权丢弃输出", async () => {
    await seedShopSkill();
    await registry().skillRuntimeGrant("shop", group, true);
    const bashMock = vi.spyOn(SandboxDO.prototype, "skillBash");
    const code = (src: string): Parameters<typeof scriptedModel>[0] => [{ name: "codemode", args: { code: src } }, { name: "", args: {} }];
    const seen = scriptedModel([
      ...code(`text(await tools.skill_bash({ skill: 'shop', command: 'echo midflight' }));`),
    ]);

    bashMock.mockImplementationOnce(async () => {
      await registry().skillRuntimeGrant("shop", group, false);
      return { stdout: "should-not-leak", stderr: "", code: 0, timedOut: false, truncated: false, stateRevision: "rev-3", outputs: [] };
    });
    await env.THREAD.getByName(group).submit(input(4, "中途撤权", 10000004, 200000001, true));
    expect(seen.outputs[0]).toContain("skill_denied");
    expect(seen.outputs[0]).not.toContain("should-not-leak");
  });

  it("群子任务继承 skill_bash 授权，按快照 revision 与实时授权交集校验，撤权后重授不复活", async () => {
    await seedShopSkill();
    await registry().skillRuntimeGrant("shop", group, true);
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    const bashMock = vi.spyOn(SandboxDO.prototype, "skillBash").mockResolvedValue({
      stdout: "subagent-ok", stderr: "", code: 0, timedOut: false, truncated: false, stateRevision: "rev-sub", outputs: [],
    });

    const childDone = gate();
    const { outputs } = twoModels(
      [
        {
          tool: "subagent",
          args: { action: "spawn", summary: "查询商品", task: "调用 skills.skill_bash 查询鼠标" },
        },
        { text: "已派出子任务" },
        { text: "子任务已完成" },
      ],
      [
        {
          tool: "codemode",
          args: { code: "text(await tools.skill_list({})); text(await tools.skill_bash({ skill: 'shop', command: 'echo mouse' }));" },
        },
        { text: "完成", after: childDone.promise },
      ],
    );

    await env.THREAD.getByName(group).submit(input(1, "派子任务查商城", 10000004, 200000001, true));
    const sub = await onlySubagent(group);
    await vi.waitFor(() => expect(bashMock).toHaveBeenCalledTimes(1));

    // 子任务仍在运行时撤权并重新授权（生成新 revision）：旧子任务不得借新授权复活
    await registry().skillRuntimeGrant("shop", group, false);
    await registry().skillRuntimeGrant("shop", group, true);
    const listAfterRegrant = await runInDurableObject(env.THREAD.getByName(group), instance => instance.subagentSkillList(sub.id));
    expect(JSON.parse(listAfterRegrant.output?.[0]?.type === "text" ? listAfterRegrant.output[0].text : "{}")).toEqual({ skills: [] });
    const denied = await runInDurableObject(env.THREAD.getByName(group), instance => instance.subagentSkillBash(sub.id, {
      skill: "shop", command: "echo mouse", operationId: "after-revoke",
    }));
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("skill_denied");
    expect(bashMock).toHaveBeenCalledTimes(1);

    childDone.open();
    await reports(group, 1);
    expect(outputs.child[0]).toContain("subagent-ok");
  });

  it("管理台 /admin/skill-runtime 列出普通 Skill 并支持授权、撤销、删除同步清理与删后清态", async () => {
    await seedShopSkill();
    await env.SANDBOX.getByName("skill-state:shop").skillStateImport({
      skill: "shop",
      files: [{ path: "cookie.txt", bytes: encoder.encode("sid=abc") }],
    });

    const call = (method: string, path: string, body?: unknown) => worker.fetch(
      new Request(`https://test${path}`, {
        method,
        headers: { Authorization: "Bearer test-admin-token", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      { ...env, ADMIN_TOKEN: "test-admin-token" },
    );

    const listRes = await call("GET", "/admin/skill-runtime");
    expect(listRes.status).toBe(200);
    const overview = await listRes.json() as { skills: Array<{ skill: string; state: { fileCount: number } }> };
    expect(overview.skills[0]).toMatchObject({ skill: "shop", state: { fileCount: 1 } });

    const badGrant = await call("PUT", "/admin/skill-runtime/shop/grants", { group: "owner", enabled: true });
    expect(badGrant.status).toBe(400);

    const okGrant = await call("PUT", "/admin/skill-runtime/shop/grants", { group, enabled: true });
    expect(okGrant.status).toBe(200);
    expect(await okGrant.json()).toMatchObject({ skill: "shop", group, enabled: true });

    const revokeGrant = await call("PUT", "/admin/skill-runtime/shop/grants", { group, enabled: false });
    expect(revokeGrant.status).toBe(200);
    expect(await revokeGrant.json()).toEqual({ skill: "shop", group, enabled: false, revision: "" });

    // 删除技能自动清理加密登录态，之后新建同名技能不会静默继承旧登录态
    expect(await registry().skillDelete("shop")).toBe(true);
    expect((await env.SANDBOX.getByName("skill-state:shop").skillStateList("shop")).fileCount).toBe(0);

    // 对已删除技能的残留状态直接调用清理接口仍允许成功
    await env.SANDBOX.getByName("skill-state:shop").skillStateImport({
      skill: "shop",
      files: [{ path: "orphan.txt", bytes: encoder.encode("stale") }],
    });
    const clearRes = await call("POST", "/admin/skill-runtime/shop/state/clear");
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toEqual({ skill: "shop", cleared: true });
    expect((await env.SANDBOX.getByName("skill-state:shop").skillStateList("shop")).fileCount).toBe(0);
  });

  it("SkillStateManager 可无缝读取并清理 legacy cs-agent/v1 前缀下的加密状态", async () => {
    const key = "01".repeat(32);
    const vault = new TokenVault(key);
    await runInDurableObject(env.SANDBOX.getByName("skill-state:legacy-shop"), async (_instance, state) => {
      const fx = skillSandboxFixture(async ({ stateFiles }) => {
        expect(decoder.decode(stateFiles.get("cookie.txt") ?? new Uint8Array())).toBe("legacy-sid");
        return { stdout: "legacy-ok", stderr: "", code: 0, timedOut: false, truncated: false, outputs: [] };
      });
      const manager = new SkillStateManager({
        workspaceId: state.id.toString(),
        bucket: env.ASSETS,
        storage: state.storage,
        vault,
        runtime: fx.client,
        runtimeReady: fx.ready,
        resetRuntime: fx.reset,
      });
      const legacyRoot = `${await legacyScopePrefix("skill-state:" + state.id.toString())}/skill-state`;
      const plain = encoder.encode("legacy-sid");
      const hash = await sha256(plain);
      const revision = "00000000-0000-4000-8000-000000000001";
      const manifest = {
        schemaVersion: 1,
        skill: "legacy-shop",
        revision,
        updatedAt: Date.now(),
        files: [{ path: "cookie.txt", sha256: hash, bytes: plain.byteLength, mime: "application/octet-stream", mode: 0o600 }],
        directories: [],
        totalBytes: plain.byteLength,
      };
      await env.ASSETS.put(
        `${legacyRoot}/blobs/${hash}`,
        await vault.encryptBytes(plain, JSON.stringify(["skill-state-blob", "legacy-shop", hash])),
      );
      await env.ASSETS.put(
        `${legacyRoot}/manifests/${revision}`,
        await vault.encrypt(JSON.stringify(manifest), JSON.stringify(["skill-state-manifest", "legacy-shop", revision])),
      );
      await state.storage.put("skill-state:head", revision);

      expect((await manager.list("legacy-shop")).fileCount).toBe(1);
      const outcome = await manager.runBash({
        skill: "legacy-shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "",
        command: "cat cookie.txt", timeoutMs: 5000,
      });
      expect(outcome.stdout).toBe("legacy-ok");

      await manager.clear("legacy-shop");
      expect(await env.ASSETS.get(`${legacyRoot}/blobs/${hash}`)).toBeNull();
      expect(await env.ASSETS.get(`${legacyRoot}/manifests/${revision}`)).toBeNull();
    });
  });
});
