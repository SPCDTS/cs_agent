import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { TokenVault } from "../src/mcp/crypto";
import { MCP_CONFIG } from "../src/mcp/config";
import { sha256 } from "../src/media/model";
import { RegistryDO } from "../src/registry";
import type { SandboxClient, SkillExecResult } from "../src/sandbox/client";
import { SandboxDO } from "../src/sandbox/do";
import { scopePrefix } from "../src/media/repository";
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

const RUNNER_JSON = JSON.stringify({
  version: 1,
  authExitCode: 41,
  actions: {
    login: { command: ["python3", "scripts/login.py"], description: "主人登录", ownerOnly: true, timeoutSec: 60 },
    query: {
      command: ["python3", "scripts/query.py"],
      description: "按关键词查询",
      timeoutSec: 30,
      argsSchema: {
        type: "object",
        properties: { q: { type: "string", minLength: 1, maxLength: 100 } },
        required: ["q"],
        additionalProperties: false,
      },
    },
  },
});

async function seedShopSkill() {
  await registry().skillPut({
    name: "shop",
    description: "商城查询",
    body: "---\nname: shop\ndescription: 商城查询\n---\n使用 skill_run 调用 query。",
    files: {
      "runner.json": RUNNER_JSON,
      "scripts/login.py": "print('login')",
      "scripts/query.py": "print('query')",
    },
  });
}

function skillSandboxFixture(onExec: (ctx: {
  stateFiles: Map<string, Uint8Array>;
  outFiles: Map<string, Uint8Array>;
  stdin: string;
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
    async execSkill(call) {
      outFiles = new Map();
      return onExec({ stateFiles, outFiles, stdin: call.stdin });
    },
    async execSkillBash() {
      outFiles = new Map();
      return onExec({ stateFiles, outFiles, stdin: "" });
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

describe("skill runtime & encrypted shared state", () => {
  it("SkillStateManager 加密写回 R2、冷启解密恢复、超时回滚且限制并发排队", async () => {
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
          // 模拟超时前写入了脏数据，超时后应回滚不提交
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

      const run1 = await manager.runAction({
        skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "",
        argv: ["node"], stdin: "{}", timeoutMs: 5000,
      });
      expect(run1.code).toBe(0);
      expect(run1.outputs).toHaveLength(1);
      expect(decoder.decode(run1.outputs[0]!.data)).toBe('{"ok":true}');

      // 验证 R2 上全部对象均为密文，不包含明文密钥
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

      // 超时不写回脏文件，且重置容器
      const run2 = await manager.runAction({
        skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "",
        argv: ["node"], stdin: "{}", timeoutMs: 5000,
      });
      expect(run2.timedOut).toBe(true);
      expect(run2.stateRevision).toBe(run1.stateRevision);
      expect(fx.ready()).toBe(false);

      // 并发排队限制（最多 4 个）
      const p1 = manager.runAction({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", argv: ["node"], stdin: "{}", timeoutMs: 5000 });
      const p2 = manager.runAction({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", argv: ["node"], stdin: "{}", timeoutMs: 5000 });
      const p3 = manager.runAction({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", argv: ["node"], stdin: "{}", timeoutMs: 5000 });
      const p4 = manager.runAction({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", argv: ["node"], stdin: "{}", timeoutMs: 5000 });
      await expect(manager.runAction({ skill: "shop", revision: "r1", files: {}, installNpmDeps: false, depsHash: "", argv: ["node"], stdin: "{}", timeoutMs: 5000 })).rejects.toThrow("skill_busy");
      hold.open();
      const results = await Promise.all([p1, p2, p3, p4]);
      expect(results.every(r => r.stdout === "restored")).toBe(true);

      await manager.clear("shop");
      expect((await manager.list("shop")).fileCount).toBe(0);
    });
  });

  it("主人导入/清空加密态与授权群，群在受控沙箱复用状态并支持中途撤权与 41 告警闭环", async () => {
    await seedShopSkill();
    const secret = "owner-cookie-secret-xyz";
    const ownerSandbox = env.SANDBOX.getByName("owner");
    await ownerSandbox.writeFile("/work/login/cookie.txt", encoder.encode("sid=" + secret), undefined, true);
    await ownerSandbox.writeObject("r2://login/extra.json", JSON.stringify({ token: secret }));

    const runMock = vi.spyOn(SandboxDO.prototype, "skillRun");
    const bashMock = vi.spyOn(SandboxDO.prototype, "skillOwnerBash");

    // 1. owner 导入状态、尝试授权 ownerOnly 被拒、授权 query 给群
    const code = (src: string): Parameters<typeof scriptedModel>[0] => [{ name: "codemode", args: { code: src } }, { name: "", args: {} }];
    const seen = scriptedModel([
      ...code(`
        text(await tools.skill_state_import({ skill: 'shop', fromPath: '/work/login/cookie.txt', toPath: 'cookie.txt' }));
        text(await tools.skill_state_import({ skill: 'shop', fromPath: 'r2://login/extra.json', toPath: 'extra.json' }));
        text(await tools.skill_state_list({ skill: 'shop' }));
        try { await tools.skill_grant({ skill: 'shop', group: '${group}', actions: ['login'] }); } catch (e) { text(String(e)); }
        text(await tools.skill_grant({ skill: 'shop', group: '${group}', actions: ['query'] }));
      `),
      // 2. 群会话查看可用动作并执行 query
      ...code(`
        text(await describeNamespace('skills'));
        text(await tools.skill_actions({}));
        const res = await tools.skill_run({ skill: 'shop', action: 'query', args: { q: 'keyboard' } });
        text(res);
        text(await tools.r2_read({ key: res.outputs[0].path }));
      `),
      // 3. 群尝试调用 ownerOnly / 管理工具被拒
      ...code(`
        try { await tools.skill_run({ skill: 'shop', action: 'login' }); } catch (e) { text(String(e)); }
        try { await tools.skill_owner_bash({ skill: 'shop', command: 'cat /work/state/cookie.txt' }); } catch (e) { text(String(e)); }
      `),
      // 4. 群执行中途被撤权 -> 结果被丢弃
      ...code(`text(await tools.skill_run({ skill: 'shop', action: 'query', args: { q: 'midflight' } }));`),
      // 5. 群执行返回 41 -> 触发告警
      ...code(`text(await tools.skill_run({ skill: 'shop', action: 'query', args: { q: 'expired' } }));`),
      // 6. owner 跑 skill_owner_bash 登录成功 -> 关闭告警
      ...code(`text(await tools.skill_owner_bash({ skill: 'shop', command: 'echo ok' }));`),
    ]);

    await env.THREAD.getByName("owner").submit(input(1, "导入并授权", 10000001));
    expect(seen.outputs[0]).toContain("skill_action_owner_only");
    expect(seen.outputs[0]).toContain('"fileCount":2');
    expect(seen.outputs[0]).not.toContain(secret);

    runMock.mockResolvedValueOnce({
      stdout: '{"items":["hhkb"]}',
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      stateRevision: "rev-2",
      outputs: [{ path: "items.json", bytes: 16, data: encoder.encode('{"items":["hhkb"]}') }],
    });
    await env.THREAD.getByName(group).submit(input(2, "查商品", 10000004, 200000001, true));
    expect(seen.outputs[1]).toContain("hhkb");
    expect(seen.outputs[1]).toContain("r2://.tmp/");
    expect(seen.outputs[1]).not.toContain('"name":"login"');

    await env.THREAD.getByName(group).submit(input(3, "越权测试", 10000004, 200000001, true));
    expect(seen.outputs[2]).toContain("skill_denied");
    expect(seen.outputs[2]).toContain("does not exist");

    // 4. 执行中途撤权
    runMock.mockImplementationOnce(async () => {
      await registry().skillRuntimeGrant("shop", group, []);
      return { stdout: "should-not-leak", stderr: "", code: 0, timedOut: false, truncated: false, stateRevision: "rev-3", outputs: [] };
    });
    await env.THREAD.getByName(group).submit(input(4, "中途撤权", 10000004, 200000001, true));
    expect(seen.outputs[3]).toContain("skill_denied");
    expect(seen.outputs[3]).not.toContain("should-not-leak");

    // 5. 重新授权后返回 41 触发告警
    await registry().skillRuntimeGrant("shop", group, ["query"]);
    runMock.mockResolvedValueOnce({
      stdout: "", stderr: "login expired", code: 41, timedOut: false, truncated: false, stateRevision: "rev-4", outputs: [],
    });
    await env.THREAD.getByName(group).submit(input(5, "失效测试", 10000004, 200000001, true));
    expect(seen.outputs[4]).toContain('"authRequired":true');
    expect(await registry().alerts()).toMatchObject([{ kind: "credential_login", scope: "skill:shop", closedAt: null }]);

    // 6. owner 重新登录后关闭告警
    bashMock.mockResolvedValueOnce({
      stdout: "logged in", stderr: "", code: 0, timedOut: false, truncated: false, stateRevision: "rev-5", outputs: [],
    });
    await env.THREAD.getByName("owner").submit(input(6, "重新登录", 10000001));
    expect((await registry().alerts())[0]?.closedAt).toEqual(expect.any(Number));
  });

  it("群子任务继承 skill_run 授权，取快照与实时授权交集，撤权立即生效", async () => {
    await seedShopSkill();
    await registry().skillRuntimeGrant("shop", group, ["query"]);
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    const runMock = vi.spyOn(SandboxDO.prototype, "skillRun").mockResolvedValue({
      stdout: "subagent-ok", stderr: "", code: 0, timedOut: false, truncated: false, stateRevision: "rev-sub", outputs: [],
    });

    const childDone = gate();
    const { outputs } = twoModels(
      [
        {
          tool: "subagent",
          args: { action: "spawn", summary: "查询商品", task: "调用 shop.query 查询鼠标" },
        },
        { text: "已派出子任务" },
        { text: "子任务已完成" },
      ],
      [
        {
          tool: "codemode",
          args: { code: "text(await tools.skill_actions({})); text(await tools.skill_run({ skill: 'shop', action: 'query', args: { q: 'mouse' } }));" },
        },
        {
          tool: "codemode",
          args: {
            code: "text(await tools.skill_run({ skill: 'shop', action: 'login' }));",
          },
        },
        { text: "完成", after: childDone.promise },
      ],
    );

    await env.THREAD.getByName(group).submit(input(1, "派子任务查商城", 10000004, 200000001, true));
    const sub = await onlySubagent(group);
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));

    // 子任务仍在运行时撤权，实时授权校验应立即拒绝
    await registry().skillRuntimeGrant("shop", group, []);
    const denied = await runInDurableObject(env.THREAD.getByName(group), instance => instance.subagentSkillRun(sub.id, {
      skill: "shop", action: "query", args: { q: "mouse" }, operationId: "after-revoke",
    }));
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("skill_denied");
    expect(runMock).toHaveBeenCalledTimes(1);

    childDone.open();
    await reports(group, 1);

    expect(outputs.child[0]).toContain("subagent-ok");
    expect(outputs.child[1]).toContain("denied");
  });

  it("管理台 /admin/skill-runtime 接口支持列表、保存/拒绝授权与清空加密登录态", async () => {
    await seedShopSkill();
    await env.SANDBOX.getByName("skill-state:shop").skillStateImport({
      skill: "shop",
      files: [{ path: "cookie.txt", bytes: encoder.encode("sid=abc") }],
    });
    await registry().skillRuntimeAuthAlert("shop", "web", "ep-1");

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

    const badGrant = await call("PUT", "/admin/skill-runtime/shop/grants", { group, actions: ["login"] });
    expect(badGrant.status).toBe(400);

    const okGrant = await call("PUT", "/admin/skill-runtime/shop/grants", { group, actions: ["query"] });
    expect(okGrant.status).toBe(200);
    expect(await okGrant.json()).toMatchObject({ skill: "shop", group, actions: ["query"] });

    const clearRes = await call("POST", "/admin/skill-runtime/shop/state/clear");
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toEqual({ skill: "shop", cleared: true });
    expect((await env.SANDBOX.getByName("skill-state:shop").skillStateList("shop")).fileCount).toBe(0);
    expect((await registry().alerts())[0]?.closedAt).toEqual(expect.any(Number));
  });
});
