import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createRegistry, type JsonObject } from "@earendil-works/pi-durable";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import worker from "../src/index";
import { RegistryDO } from "../src/registry";
import { threadWithBindings } from "./thread-fixture";
import { MCP_CONFIG } from "../src/mcp/config";
import { McpPolicyStore } from "../src/mcp/policy";
import { ThreadMcp, type McpAuthority } from "../src/mcp";
import { MCP_CATALOG_SCHEMA, makeCatalog } from "../src/mcp/catalog";
import { snapshotCatalogs } from "../src/mcp/access";
import { manageMcp } from "../src/mcp/manage";
import { serverDigest, toolNames } from "../src/mcp/names";
import { createSubagentCapabilityHost } from "../src/mcp/delegated";
import { ENV_TOOLS } from "../src/mcp/environments";
import { createOAuthFetch } from "../src/mcp/oauth-fetch";
import { TokenVault, sha256 } from "../src/mcp/crypto";
import * as models from "../src/models";
import { ACCESS, REFRESH, TEST_STORE_KEY, issuer, callback, fakeRemote, adminEnv, adminRequest, beginLogin, login } from "./mcp-helpers";
import { adminHealth, input } from "./helpers";

describe("mcp management onboarding", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  const endpoint = "https://mcp.integration.test/mcp", id = "fixture-project";
  const registry = () => env.REGISTRY.getByName("main");
  function remoteFixture() {
    const remote = fakeRemote(endpoint);
    remote.state.tools = [{ name: "lookup", description: "查询合成项目", inputSchema: { type: "object", properties: { query: { type: "string", "x-mcp-header": "query" } }, required: ["query"] } }];
    return remote;
  }
  async function probeActivate() {
    let record = await registry().mcpServerGet(id);
    expect(await manageMcp(env, { action: "probe", id, expectedRevision: record.revision })).toMatchObject({ status: "ready" });
    record = await registry().mcpServerGet(id);
    const result = await registry().mcpServerActivate(id, record.revision, { allow: ["lookup"], readOnly: ["lookup"] });
    if ("error" in result) throw new Error(JSON.stringify(result));
    return result;
  }
  type Step = (revision: string) => { name: string; args: JsonObject };
  function scriptedModel(steps: Step[]) {
    const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const offers: string[] = [], outputs: string[] = [], errors: boolean[] = [], captured = new Set<string>();
    let revision = "absent";
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      for (const message of transcript.messages) {
        if (message.role === "system") offers.push(...(message.toolsAdded ?? []).map(tool => tool.name));
        if (message.role === "toolResult" && !captured.has(message.toolCallId)) {
          captured.add(message.toolCallId);
          const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
          outputs.push(text); errors.push(message.isError);
          try { const value: unknown = JSON.parse(text); if (Check(Type.Object({ revision: Type.String() }), value)) revision = value.revision; } catch {}
        }
      }
      const next = steps.shift()?.(revision);
      return next ? fauxAssistantMessage(fauxToolCall(next.name, next.name === "mcp_manage" ? { request: next.args } : next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation(() => { const result = createModels(); result.setProvider(faux.provider); return result; });
    return { offers, outputs, errors };
  }
  
  describe("runtime MCP onboarding", () => {
    it("原生节点列出 Space 生命周期工具时，管理台仍拒绝将其开放给会话", async () => {
      const cua = await registry().mcpServerPut({ id: "cua", transport: "reverse-websocket" }, "absent");
      const credential = await registry().mcpCredentialPut("cua", cua.revision, { Authorization: "Bearer " + "f".repeat(40) });
      const tools = ["list_spaces", "create_space", "delete_space"].map(name => ({ name, inputSchema: { type: "object" } }));
      const probed = await registry().mcpServerProbe("cua", credential.revision, { tools });
      const active = await registry().mcpServerActivate("cua", probed.revision, { allow: ["list_spaces"] });
      if ("error" in active) throw new Error("fixture_activation_failed");
      for (const name of ["create_space", "delete_space"]) {
        const response = await worker.fetch(new Request("https://test/admin/mcp/manage", { method: "POST",
          headers: { Authorization: "Bearer synthetic-admin", "Content-Type": "application/json" },
          body: JSON.stringify({ action: "activate", id: "cua", expectedRevision: active.revision,
            selection: { allow: ["list_spaces", name], readOnly: [name] } }) }), adminEnv());
        expect(response.status).toBe(400);
        expect((await registry().mcpServerGet("cua")).server.tools.allow).toEqual(["list_spaces"]);
      }
    });
  
    it("preserves seeded services, encrypts admin credentials, probes via the existing SDK and invalidates old group grants", async () => {
      const remote = remoteFixture(), initial = await registry().mcpConfig();
      expect(initial.servers).toEqual(MCP_CONFIG.servers);
      let record = await registry().mcpServerPut({ id, url: endpoint, auth: "token" }, "absent");
      expect(record.server.enabled).toBe(false);
      expect(await manageMcp(env, { action: "probe", id, expectedRevision: record.revision })).toMatchObject({ code: "credentials_required" });
      const secret = "Bearer synthetic-managed-token", path = `/admin/mcp/servers/${id}/credentials`;
      const request = (authorized: boolean) => new Request(`https://test${path}`, { method: "PUT", headers: authorized ? { Authorization: "Bearer synthetic-admin" } : {},
        body: JSON.stringify({ expectedRevision: record.revision, headers: { Authorization: secret } }) });
      expect((await worker.fetch(request(false), adminEnv())).status).toBe(401);
      const saved = await worker.fetch(request(true), adminEnv());
      expect(saved.status).toBe(200); expect(await saved.text()).not.toContain(secret);
      record = await probeActivate();
      expect(remote.requests.every(row => row.headers.get("authorization") === secret)).toBe(true);
      expect(await registry().mcpServerCurrent(id, serverDigest(record.server))).toBe(true);
      const stored = await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("SELECT * FROM mcp_servers").toArray());
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(JSON.stringify(await registry().mcpServersList())).not.toContain(secret);
      await runInDurableObject(registry(), (_instance, state) => { expect(() => new RegistryDO(state, env).mcpServerDisable(id, "outdated")).toThrow("conflict"); });
      await runInDurableObject(env.THREAD.getByName("group:200000001"), async (_instance, state) => {
        const policy = new McpPolicyStore(new DurableObjectSqliteDatabase(state.storage), await registry().mcpConfig());
        const actor = { scope: "group:200000001", actor: "10000003", owner: false, kind: "message", generation: 1, replyChannel: "web" } as const;
        await policy.setGrant(actor.scope, id, { tools: ["lookup"], resourceAllow: [], actors: [actor.actor], expiresAt: null }, "none");
        expect(await policy.allows(actor, record.server, "lookup")).toBe(true);
        const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA + "CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)");
        const runtime = new ThreadMcp(db, env, createRegistry(), async () => actor, await registry().mcpConfig(),
          { scope: actor.scope, current: (id, digest) => registry().mcpServerCurrent(id, digest) });
        await runtime.restore(); await runtime.refreshAll();
        const snapshot = await runtime.captureCapabilities(actor);
        expect(snapshotCatalogs(snapshot).map(catalog => catalog.serverId)).toEqual([id]);
        const call = { name: snapshot.tools[0]!, args: { query: "合成查询" }, operationId: "before-change", snapshot };
        expect((await runtime.invoke(call, async () => actor)).isError).not.toBe(true);
        await registry().mcpCredentialPut(id, record.revision, { Authorization: "Bearer synthetic-new-account" });
        const changed = await probeActivate(); policy.setConfig(await registry().mcpConfig());
        expect(await policy.allows(actor, changed.server, "lookup")).toBe(false);
        expect(await registry().mcpServerCurrent(id, serverDigest(record.server))).toBe(false);
        expect((await runtime.invoke({ ...call, operationId: "after-change" }, async () => actor)).isError).toBe(true);
        expect(remote.state.calls).toBe(1);
        await runtime.close();
      });
      const seeded = await registry().mcpServerGet("cs2-workshop");
      await registry().mcpServerRemove("cs2-workshop", seeded.revision);
      await runInDurableObject(registry(), async (_instance, state) => {
        const restarted = new RegistryDO(state, env);
        expect(restarted.mcpConfig().servers.some(server => server.id === "cs2-workshop")).toBe(false);
        expect(restarted.mcpServerGet(id).credentialSet).toBe(true);
      });
    });
  
    it("lets the owner agent adjust rejected tools, activate, call and disable in one conversation", async () => {
      const remote = remoteFixture();
      remote.state.tools.push({ name: "unsupported", inputSchema: { type: "object", properties: { value: { type: "string", unknownKeyword: true } } } });
      for (const record of await registry().mcpServersList()) await registry().mcpServerDisable(record.server.id, record.revision);
      const call = { name: "codemode", args: { code: "const tool=ALL_TOOLS.find(t=>t.name.startsWith('mcp_fixture_project_lookup_'));if(tool) text(await tools[tool.name]({query:'合成查询'})); else text('tool_retired');" } };
      const seen = scriptedModel([
        () => ({ name: "mcp_manage", args: { action: "put", expectedRevision: "absent", server: { id, url: endpoint, auth: "none" } } }),
        revision => ({ name: "mcp_manage", args: { action: "probe", id, expectedRevision: revision } }),
        revision => ({ name: "mcp_manage", args: { action: "activate", id, expectedRevision: revision, selection: { allow: ["lookup", "unsupported"] } } }),
        revision => ({ name: "mcp_manage", args: { action: "activate", id, expectedRevision: revision, selection: { allow: ["lookup"], readOnly: ["lookup"] } } }),
        () => call,
        revision => ({ name: "mcp_manage", args: { action: "disable", id, expectedRevision: revision } }),
        () => call,
      ]);
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        const result = await thread.submit(input(1, "接入并验证合成 MCP 服务", 10000001));
        expect(result, JSON.stringify(state.storage.sql.exec("SELECT * FROM events").toArray())).toEqual({ status: "done" });
      });
      expect(seen.offers).toContain("mcp_manage");
      expect(seen.errors[2]).toBe(true);
      expect(JSON.parse(seen.outputs[2]!)).toMatchObject({ error: "tools_rejected", rejected: 1, rejectedTools: [{ name: "unsupported", reason: "unknown_keyword" }] });
      expect(seen.outputs[4]).toContain("service-result:");
      expect(seen.outputs[6]).toContain("tool_retired");
      expect(remote.state.calls).toBe(1);
      expect((await registry().mcpServerGet(id)).server.enabled).toBe(false);
    });
  
    it("允许未配置 QQ_OWNER 的主人网页使用 Cloudflare 工具", async () => {
      const seen = scriptedModel([() => ({ name:'cloudflare_inventory', args:{ resource:'dns' } })]);
      await runInDurableObject(env.THREAD.getByName('owner'), async (host,state) => {
        const thread = threadWithBindings(host, state, { ...env, QQ_OWNER:'', MEMORY_EXTRACT_NAMESPACES:'' });
        await thread.submitWeb('owner',crypto.randomUUID(),'查看 DNS 清单');
      });
      // 未连接 Cloudflare 的实例应返回资源授权错误，说明网页主人已通过会话鉴权。
      await expect.poll(() => seen.outputs, {timeout:10000}).toContain(JSON.stringify('device_cloudflare_denied'));
      await runInDurableObject(env.THREAD.getByName('owner'), (_host,state) => {
        const event = state.storage.sql.exec<{detail:string}>("SELECT detail FROM events WHERE kind='cloudflare_management'").one();
        expect(JSON.parse(event.detail)).toEqual({tool:'cloudflare_inventory',action:'dns',result:'error'});
      });
    });
  
    it("returns tool rejection details through the admin API and preserves the active selection", async () => {
      const remote = remoteFixture();
      remote.state.tools.push({ name: "unsupported", inputSchema: { type: "object", properties: { value: { type: "string", unknownKeyword: true } } } });
      await registry().mcpServerPut({ id, url: endpoint, auth: "none" }, "absent");
      const before = await probeActivate();
      const response = await worker.fetch(new Request("https://test/admin/mcp/manage", { method: "POST",
        headers: { Authorization: "Bearer synthetic-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate", id, expectedRevision: before.revision, selection: { allow: ["lookup", "unsupported"] } }) }), adminEnv());
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "tools_rejected", rejected: 1, rejectedTools: [{ name: "unsupported", reason: "unknown_keyword" }] });
      expect(await registry().mcpServerGet(id)).toEqual(before);
      await env.THREAD.getByName("owner").syncAdminView("owner");
      expect(await env.REQUESTS.getByName("view:thread:owner").events({ kind: "mcp_management", limit: 10 })).toEqual({ events: [] });
    });
  
    it("uses the existing OAuth login and refresh flow for a newly registered service", async () => {
      const remote = remoteFixture();
      await registry().mcpServerPut({ id, url: endpoint, auth: "oauth" }, "absent");
      const link = await manageMcp(env, { action: "login", id });
      if (!("url" in link) || typeof link.url !== "string") throw new Error("missing_login_link");
      const authorization = new URL(await registry().startLogin(new URL(link.url).searchParams.get("nonce") ?? ""));
      const response = await worker.fetch(new Request(`${callback}?code=synthetic-code&state=${authorization.searchParams.get("state")}`), env);
      expect(response.status).toBe(200);
      expect(await registry().accessToken(id)).toBe(ACCESS);
      await probeActivate();
      await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_oauth_tokens SET expires_at=? WHERE server_id=?", Date.now() - 1, id); });
      expect(await registry().accessToken(id)).toBe(`${ACCESS}-refreshed`);
      expect(remote.state.refreshes).toBe(1);
    });
  
    it.each([{ scope: "group:200000001", user: 10000001, group: 200000001 }, { scope: "private:10000003", user: 10000003, group: undefined }])("does not expose onboarding to $scope", async ({ scope, user, group }) => {
      const seen = scriptedModel([() => ({ name: "mcp_manage", args: { action: "put", expectedRevision: "absent", server: { id, url: endpoint, auth: "none" } } })]);
      await runInDurableObject(env.THREAD.getByName(scope), async (_instance, state) => {
        const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        expect(await thread.submit(input(1, "接入服务", user, group, true))).toEqual({ status: "done" });
      });
      expect(seen.offers).not.toContain("mcp_manage");
      expect((await registry().mcpConfig()).servers.some(server => server.id === id)).toBe(false);
    });
  });
});

describe("mcp approvals", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  const group = "group:200000001";
  const actor: McpAuthority = { kind: "message", scope: group, actor: "10000003", owner: false, generation: 2, replyChannel: "web" };
  const reviewer: McpAuthority = { kind: "message", scope: "owner", actor: "10000001", owner: true, generation: 1, replyChannel: "web" };
  describe("scoped MCP exact-call approval", () => {
    it("keeps groups closed by default and executes each approved write once while rejecting later requests", async () => {
      const remote = fakeRemote(); await login();
      remote.state.tools = [{ name: "notion-create-pages", description: "创建页面",
        inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } }];
      await env.THREAD.getByName(group).syncAdminView(group);
      await runInDurableObject(env.THREAD.getByName(group), async (_instance, state) => {
        const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
        const registry = createRegistry(), mcp = new ThreadMcp(db, env, registry, async () => actor, MCP_CONFIG, { scope: group });
        await mcp.restore(); await mcp.refreshAll();
        const catalog = makeCatalog(MCP_CONFIG.servers[0]!, remote.state.tools, MCP_CONFIG.limits).revision;
        const name = toolNames(catalog, catalog.tools[0]!).nativeName;
        const call = { name, args: { title: "已审阅的合成标题" }, operationId: "write-one" };
        expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
        expect(registry.snapshot().tools().some(t => t.tool.name === name)).toBe(false);
        const grant = await mcp.setAccess(group, "notion", { tools: ["notion-create-pages"], environments: ["group852"], environmentApproval: "none", resourceAllow: [], actors: [actor.actor], expiresAt: null }, "none", reviewer);
        expect(grant.tools).toEqual(["notion-create-pages"]);
        await mcp.refreshAll();
        expect(registry.snapshot().tools().some(t => t.tool.name === name)).toBe(true);
        expect(JSON.stringify((await mcp.invoke(call, async () => actor)).output)).toContain("pending");
        expect(remote.state.calls).toBe(0);
        const pending = (await mcp.policy.list(group))[0]!;
        expect(pending).toMatchObject({ actor: actor.actor, generation: 2, reply_channel: "web", status: "pending" });
        expect(JSON.parse(pending.args_json)).toEqual(call.args);
        expect(await mcp.reviewApproval(group, pending.id, "approve", reviewer, async () => actor)).toMatchObject({ status: "reviewed" });
        expect(remote.state.calls).toBe(1);
        await mcp.invoke(call, async () => actor);
        expect(remote.state.calls).toBe(1);
        const second = { ...call, operationId: "write-two", args: { title: "拒绝标题" } };
        await mcp.invoke(second, async () => actor);
        const rejected = (await mcp.policy.list(group)).find(p => p.operation_id === "write-two")!;
        expect(await mcp.reviewApproval(group, rejected.id, "reject", reviewer, async () => actor)).toEqual({ status: "rejected" });
        expect((await mcp.invoke(second, async () => actor)).isError).toBe(true);
        expect(remote.state.calls).toBe(1);
        const third = { ...call, operationId: "write-three" }; await mcp.invoke(third, async () => actor);
        const frozen = (await mcp.policy.list(group)).find(p => p.operation_id === "write-three")!;
        const changed = await mcp.reviewApproval(group, frozen.id, "approve", reviewer, async () => ({ ...actor, replyChannel: "qq" }));
        expect(changed).toMatchObject({ result: { isError: true } });
        expect(remote.state.calls).toBe(1);
        await mcp.setAccess(group, "notion", { tools: [], resourceAllow: [], actors: [actor.actor], expiresAt: null }, grant.revision, reviewer);
        expect((await mcp.invoke({ ...call, operationId: "after-revoke" }, async () => actor)).isError).toBe(true);
        await mcp.close();
      });
    });
    it("does not replay an executing write after the runtime restarts", async () => {
      await env.THREAD.getByName("owner").syncAdminView("owner");
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const db = new DurableObjectSqliteDatabase(state.storage), policy = new McpPolicyStore(db);
        const call = { authority: reviewer, server: "notion", name: "synthetic-write", contract: "contract", args: { title: "固定参数" }, operationId: "once" };
        expect(await policy.claim(call, false)).toMatchObject({ kind: "execute" });
        const restarted = new McpPolicyStore(db); await restarted.recoverInterrupted();
        const result = await restarted.claim(call, false);
        expect(result).toMatchObject({ kind: "result", result: { isError: true } });
        expect(JSON.stringify(result)).toContain("outcome_unknown");
      });
    });
  });
});

describe("mcp agent approvals", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  const group = "group:200000001";
  const actor: McpAuthority = { kind: "agent", scope: group, actor: "agent:" + group, owner: false, generation: 2, replyChannel: "qq" };
  const reviewer: McpAuthority = { kind: "message", scope: "owner", actor: "admin:web", owner: true, generation: 1, replyChannel: "web" };
  
  async function fixture(run: (mcp: ThreadMcp, db: DurableObjectSqliteDatabase, remote: ReturnType<typeof fakeRemote>, call: { name: string; args: { title: string }; operationId: string }, id: string, revoke: () => Promise<unknown>) => Promise<void>) {
    const remote = fakeRemote(); await login();
    remote.state.tools = [{ name: "notion-create-pages", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } }];
    await env.THREAD.getByName(group).syncAdminView(group);
    await runInDurableObject(env.THREAD.getByName(group), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
      const mcp = new ThreadMcp(db, env, createRegistry(), async () => actor, MCP_CONFIG, { scope: group });
      try {
        await mcp.restore();
        const catalog = makeCatalog(MCP_CONFIG.servers[0]!, remote.state.tools, MCP_CONFIG.limits).revision;
        const call = { name: toolNames(catalog, catalog.tools[0]!).nativeName, args: { title: "synthetic approved title" }, operationId: "agent-write" };
        const input = { tools: ["notion-create-pages"], resourceAllow: [], actors: [actor.actor], expiresAt: null };
        const grant = await mcp.setAccess(group, "notion", input, "none", reviewer);
        await mcp.refreshAll();
        expect(JSON.stringify(await mcp.invoke(call, async () => actor))).toContain('pending');
        const pending = (await mcp.policy.list(group))[0]!;
        expect(pending).toMatchObject({ actor: actor.actor, generation: actor.generation, reply_channel: "qq", status: "pending" });
        expect(remote.state.calls).toBe(0);
        await run(mcp, db, remote, call, pending.id, () => mcp.setAccess(group, "notion", { ...input, tools: [] }, grant.revision, reviewer));
      } finally { await mcp.close(); }
    });
  }
  
  it("executes a revalidated agent approval exactly once despite concurrent and repeated reviews", async () => {
    await fixture(async (mcp, _db, remote, call, id) => {
      const current = vi.fn(async () => actor);
      const reviews = await Promise.allSettled([1, 2].map(() => mcp.reviewApproval(group, id, "approve", reviewer, current)));
      expect(reviews.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(reviews.filter(r => r.status === "rejected")).toHaveLength(1);
      expect(reviews.find(r => r.status === "fulfilled")).toMatchObject({ value: { status: "reviewed", result: { output: expect.arrayContaining([{ type: "text", text: "service-result:" + JSON.stringify(call.args) }]) } } });
      expect(current.mock.calls.length).toBeGreaterThan(1);
      expect((await mcp.policy.approval(id, group)).status).toBe("succeeded");
      await expect(mcp.reviewApproval(group, id, "approve", reviewer, current)).rejects.toThrow("conflict");
      const receipt = await mcp.invoke(call, async () => actor);
      expect(receipt.isError).not.toBe(true);
      expect(remote.state.calls).toBe(1);
    });
  });
  
  it("rejects a revoked pending grant without executing", async () => {
    await fixture(async (mcp, _db, remote, call, id, revoke) => {
      await revoke();
      await expect(mcp.reviewApproval(group, id, "approve", reviewer, async () => actor)).rejects.toThrow("conflict");
      expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
      expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
      expect(remote.state.calls).toBe(0);
    });
  });
  
  it.each([1, 5])("rechecks generation at authorization %i and records rejection, not approval or success", async at => {
    await fixture(async (mcp, _db, remote, call, id) => {
      let checks = 0;
      const reviewed = await mcp.reviewApproval(group, id, "approve", reviewer, async () => ++checks >= at ? { ...actor, generation: actor.generation + 1 } : actor);
      expect(reviewed).toMatchObject({ result: { isError: true } });
      expect(checks).toBe(at);
      expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
      expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
      expect(remote.state.calls).toBe(0);
    });
  });
  
  it.each([1, 5])("rechecks grant at authorization %i including after the execution claim", async at => {
    await fixture(async (mcp, _db, remote, call, id, revoke) => {
      let checks = 0;
      const reviewed = await mcp.reviewApproval(group, id, "approve", reviewer, async () => { if (++checks === at) await revoke(); return actor; });
      expect(reviewed).toMatchObject({ result: { isError: true } });
      expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
      expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
      expect(remote.state.calls).toBe(0);
    });
  });
  
  it.each(["invalid-kind", "malformed-json", "kind-changed", "owner-changed"])("fails closed for %s without leaving an executable approval", async mode => {
    await fixture(async (mcp, db, remote, call, id) => {
      if (mode === "invalid-kind" || mode === "malformed-json") await db.run("UPDATE mcp_approvals SET authority_json=? WHERE id=?", mode === "malformed-json" ? "{" : JSON.stringify({ ...actor, kind: "untrusted" }), id);
      const current = vi.fn(async () => mode === "kind-changed" ? { ...actor, kind: "message" as const } : mode === "owner-changed" ? { ...actor, owner: true } : actor);
      await mcp.reviewApproval(group, id, "approve", reviewer, current);
      if (mode === "invalid-kind" || mode === "malformed-json") expect(current).not.toHaveBeenCalled();
      expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
      expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
      expect(remote.state.calls).toBe(0);
    });
  });
  
  it("preserves unknown execution outcome and never retries a dispatched write", async () => {
    await fixture(async (mcp, _db, remote, call, id) => {
      remote.state.failCalls = true;
      const result = await mcp.reviewApproval(group, id, "approve", reviewer, async () => actor);
      expect(JSON.stringify(result)).toContain("outcome_unknown");
      expect((await mcp.policy.approval(id, group)).status).toBe("unknown");
      await expect(mcp.reviewApproval(group, id, "approve", reviewer, async () => actor)).rejects.toThrow("conflict");
      expect(JSON.stringify(await mcp.invoke(call, async () => actor))).toContain("outcome_unknown");
      expect(remote.state.calls).toBe(1);
    });
  });
  
  it("rejects an unclaimed approval if current-authority lookup throws", async () => {
    await fixture(async (mcp, _db, remote, _call, id) => {
      await expect(mcp.reviewApproval(group, id, "approve", reviewer, async () => { throw new Error("synthetic-lookup-failure"); })).rejects.toThrow("synthetic-lookup-failure");
      expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
      expect(remote.state.calls).toBe(0);
    });
  });
  
  it("uses the same agent authority schema for delegated capability responses", async () => {
    const host = createSubagentCapabilityHost({ validateSubagentAccess: async () => ({ authority: actor, capabilities: {} }) });
    expect(await host.validateSubagentAccess("child")).toMatchObject({ authority: actor });
    const invalid = createSubagentCapabilityHost({ validateSubagentAccess: async () => ({ authority: { ...actor, kind: "untrusted" }, capabilities: {} }) });
    await expect(invalid.validateSubagentAccess("child")).rejects.toThrow("delegation_denied");
  });
});

describe("mcp environments", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  const group = 'group:200000001';
  const actor: McpAuthority = { kind: 'message', scope: group, actor: '10000003', owner: false, generation: 1, replyChannel: 'web' };
  const owner: McpAuthority = { ...actor, scope: 'owner', actor: '10000001', owner: true };
  
  it('管理 API 保存环境范围与独立审批设置，读投影返回同一授权', async () => {
    fakeRemote(); await login();
    const path = '/admin/mcp/access?scope=' + encodeURIComponent(group) + '&server=notion';
    const request = (method: string, body?: object) => worker.fetch(new Request('https://test' + path, {
      method, headers: { Authorization: 'Bearer environment-test', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }), { ...env, ADMIN_TOKEN: 'environment-test' });
    const input = { tools: ['notion-search'], resourceAllow: [], actors: [actor.actor], expiresAt: null, environments: ['group852'], environmentApproval: 'none' };
    const saved = await request('PUT', { server: 'notion', expected: 'none', input });
    expect(saved.status).toBe(200);
    const grant = await saved.json();
    expect(grant).toMatchObject(input);
    const fetched = await request('GET');
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ grant });
  });
  
  it('环境授权在审批前校验；查询、写操作和子 agent 都不能越过环境范围', async () => {
    const remote = fakeRemote(); await login();
    remote.state.tools = ENV_TOOLS.map((name): Tool => ({ name, inputSchema: name === 'env_list' ? { type: 'object', properties: {}, additionalProperties: false }
      : { type: 'object', properties: { envId: { type: 'string' } }, required: ['envId'], additionalProperties: false } }));
    remote.state.toolResult = { content: [{ type: 'text', text: 'checked' }] };
    const config = { ...MCP_CONFIG, servers: [{ ...MCP_CONFIG.servers[0]!, tools: { allow: [...ENV_TOOLS], eventAllow: [], readOnly: ['env_list', 'env_status', 'env_job_get'] } }] };
    const server = config.servers[0]!;
    const catalog = makeCatalog(server, remote.state.tools, config.limits).revision;
    const name = (raw: string) => {
      const tool = catalog.tools.find(t => t.name === raw); if (!tool) throw new Error('missing_tool');
      return toolNames(catalog, tool).nativeName;
    };
    await env.THREAD.getByName(group).syncAdminView(group);
    await runInDurableObject(env.THREAD.getByName(group), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
      const mcp = new ThreadMcp(db, env, createRegistry(), async () => actor, config, { scope: group });
      const settings = { tools: [...ENV_TOOLS], actors: [actor.actor], resourceAllow: [], expiresAt: null, environments: ['group852'] };
      let op = 0;
      const call = (raw: string, args: object, who = actor) => mcp.invoke({ name: name(raw), args, operationId: String(++op) }, async () => who);
      try {
        let grant = await mcp.setAccess(group, server.id, { tools: [...ENV_TOOLS], actors: [actor.actor], resourceAllow: [], expiresAt: null }, 'none', owner);
        await mcp.refreshAll();
        expect((await call('env_list', {})).isError).toBe(true); // 旧群授权没有环境范围，不自动扩大。
        grant = await mcp.setAccess(group, server.id, { ...settings, environments: ['group852'] }, grant.revision, owner);
        for (const tool of ENV_TOOLS.filter(tool => tool !== 'env_list')) expect((await call(tool, { envId: 'dev' })).isError).toBe(true);
        expect((await call('env_status', { envId: 'group852' }, { ...actor, actor: '10000004' })).isError).toBe(true);
        expect(remote.state.calls).toBe(0);
        expect(await mcp.policy.list(group)).toEqual([]);
        expect((await call('env_list', {})).isError).not.toBe(true);
        expect((await call('env_status', { envId: 'group852' })).isError).not.toBe(true);
        const requests = remote.requests.filter(row => row.body.includes('"tools/call"')).map(row => JSON.parse(row.body));
        expect(requests.at(-1).params._meta['cs-agent/caller']).toMatchObject({ environments: { kind: 'selected', envIds: ['group852'] } });
        expect(requests.at(-1).params.arguments).toEqual({ envId: 'group852' });
        const prior = remote.state.calls;
        expect(JSON.stringify(await call('env_submit', { envId: 'group852' }))).toContain('pending');
        expect(remote.state.calls).toBe(prior);
        const pending = (await mcp.policy.list(group))[0]!;
        await mcp.reviewApproval(group, pending.id, 'approve', owner, async () => actor);
        expect(remote.state.calls).toBe(prior + 1);
        grant = await mcp.setAccess(group, server.id, { ...settings, environmentApproval: 'none' }, grant.revision, owner);
        expect((await call('env_submit', { envId: 'group852' })).isError).not.toBe(true);
        expect(remote.state.calls).toBe(prior + 2);
  
        const snapshot = await mcp.captureCapabilities(actor);
        const child: McpAuthority = { ...actor, kind: 'subagent', subagentId: 'child' };
        const host = createSubagentCapabilityHost({ validateSubagentAccess: async () => ({ authority: child, capabilities: { mcp: snapshot } }) });
        expect((await host.validateSubagentAccess('child'))?.capabilities.mcp?.environments).toEqual(snapshot.environments);
        grant = await mcp.setAccess(group, server.id, { ...settings, environments: ['group852', 'second'] }, grant.revision, owner);
        const childCall = (envId: string) => mcp.invoke({ name: name('env_status'), args: { envId }, operationId: String(++op), snapshot }, async () => child);
        expect((await childCall('second')).isError).toBe(true);
        expect((await childCall('group852')).isError).not.toBe(true);
        await mcp.setAccess(group, server.id, { ...settings, environments: [] }, grant.revision, owner);
        expect((await childCall('group852')).isError).toBe(true);
        expect((await call('env_status', { envId: 'dev' }, owner)).isError).not.toBe(true);
      } finally { await mcp.close(); }
    });
  });
});

describe("mcp oauth", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  const registry = () => env.REGISTRY.getByName("main");
  async function expire() {
    await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_oauth_tokens SET expires_at=?", Date.now() - 1); });
  }
  
  describe("Registry OAuth CIMD", () => {
    it("serves its own client metadata with the PUBLIC_ORIGIN callback and public cache", async () => {
      const origin = "https://alternate.example.test";
      const response = await worker.fetch(new Request(`${origin}/oauth/client-metadata.json`), { ...env, PUBLIC_ORIGIN: origin });
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await response.json()).toEqual({ client_id: `${origin}/oauth/client-metadata.json`, client_name: "cs-agent", client_uri: origin,
        redirect_uris: [`${origin}/mcp/oauth/callback`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
      expect((await worker.fetch(new Request(`${origin}/mcp/oauth/callback`), env)).status).toBe(400);
    });
    it("requires an admin Bearer, rejects query/NapCat auth and reports unconfigured without a key", async () => {
      for (const token of ["", "t", "wrong"]) expect((await worker.fetch(adminRequest(token), adminEnv())).status).toBe(401);
      expect((await worker.fetch(adminRequest(), { ...env, ADMIN_TOKEN: undefined })).status).toBe(401);
      expect((await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}/admin/mcp/notion/login-link?access_token=synthetic-admin`, { method: "POST" }), adminEnv())).status).toBe(401);
      const badServer = await worker.fetch(adminRequest("synthetic-admin", "unknown"), adminEnv());
      expect(badServer.status).toBe(400);
      expect(await badServer.json()).toEqual({ error: "server_unavailable" });
      const status = await runInDurableObject(registry(), async (_instance, state) => {
        const instance = new RegistryDO(state, { ...env, OAUTH_STORE_KEY: undefined });
        expect(await instance.accessToken("notion")).toBeUndefined();
        await expect(instance.loginLink("notion")).rejects.toThrow("unconfigured");
        return instance.status();
      });
      expect(status[0].login).toBe("unconfigured");
    });
    it("runs login-link → one-time start → PKCE callback → accessToken and stores only ciphertext", async () => {
      const remote = fakeRemote(), started = await beginLogin(), auth = started.authorization;
      expect(auth.origin).toBe(issuer);
      expect(auth.searchParams.get("client_id")).toBe(`${env.PUBLIC_ORIGIN}/oauth/client-metadata.json`);
      expect(auth.searchParams.get("redirect_uri")).toBe(callback);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect((await worker.fetch(new Request(started.link), env)).status).toBe(400);
      const request = new Request(`${callback}?state=${auth.searchParams.get("state")}&code=synthetic-code`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200); expect(await response.text()).toBe("已登录 notion");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect((await worker.fetch(request, env)).status).toBe(400);
      expect(await registry().accessToken("notion")).toBe(ACCESS);
      expect((await registry().status())[0]).toMatchObject({ server: "notion", credential: "oauth", login: "ok" });
      const tokenRequest = remote.requests.find(r => r.url.endsWith("/token"));
      const verifier = new URLSearchParams(tokenRequest?.body).get("code_verifier");
      expect(verifier).toHaveLength(43);
      expect((await sha256(verifier ?? "")).toString("base64url")).toBe(auth.searchParams.get("code_challenge"));
      const stored = await runInDurableObject(registry(), (_instance, state) => ({ tokens: state.storage.sql.exec("SELECT * FROM mcp_oauth_tokens").toArray(),
        logins: state.storage.sql.exec("SELECT * FROM mcp_oauth_logins").toArray(), clients: state.storage.sql.exec("SELECT * FROM mcp_oauth_client").toArray() }));
      expect(stored.tokens[0]).toMatchObject({ access_token: expect.stringMatching(/^v1\./), refresh_token: expect.stringMatching(/^v1\./) });
      for (const secret of [ACCESS, REFRESH, "synthetic-code", verifier ?? "unreachable"]) expect(JSON.stringify(stored)).not.toContain(secret);
      expect(stored.logins).toHaveLength(0);
      expect(remote.requests.every(r => r.redirect === "manual" && !r.headers.has("cookie"))).toBe(true);
      const healthy = await adminHealth();
      expect(await healthy.json()).toMatchObject({ mcp: expect.arrayContaining([expect.objectContaining({ server: "notion", enabled: true, credential: "oauth", login: "ok", tools: null })]) });
    });
    it("expires links and states after ten minutes and consumes failed callbacks without exposing code", async () => {
      fakeRemote(); const link = await registry().loginLink("notion");
      await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_oauth_logins SET expires_at=0"); });
      expect((await worker.fetch(new Request(link.url), env)).status).toBe(400);
      const started = await beginLogin();
      const denied = await worker.fetch(new Request(`${callback}?state=${started.authorization.searchParams.get("state")}&error=private-error&code=private-code`), env);
      expect(await denied.text()).toBe("invalid_state");
      expect((await worker.fetch(new Request(`${callback}?state=${started.authorization.searchParams.get("state")}&code=private-code`), env)).status).toBe(400);
      const late = await beginLogin();
      await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_oauth_logins SET expires_at=0"); });
      expect((await worker.fetch(new Request(`${callback}?state=${late.authorization.searchParams.get("state")}&code=private-code`), env)).status).toBe(400);
    });
    it("single-flights refresh, retains rotated refresh when omitted, and deletes invalid_grant tokens", async () => {
      const remote = fakeRemote(); await login(); await expire();
      expect(await Promise.all(Array.from({ length: 6 }, () => registry().accessToken("notion")))).toEqual(Array(6).fill(`${ACCESS}-refreshed`));
      expect(remote.state.refreshes).toBe(1);
      await expire(); remote.state.tokenStatus = 400;
      await expect((async () => await registry().accessToken("notion"))()).rejects.toThrow("auth_required");
      expect(remote.requests.filter(r => r.url.endsWith("/token")).at(-1)?.body).toContain(`refresh_token=${REFRESH}`);
      const rows = await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("SELECT * FROM mcp_oauth_tokens").toArray());
      expect(rows).toHaveLength(0); expect((await registry().status())[0].login).toBe("error");
    });
    it("keeps tokens on temporary refresh failures, survives reconstruction and logs out locally", async () => {
      const remote = fakeRemote(); await login(); await expire(); remote.state.tokenStatus = 503;
      await expect((async () => await registry().accessToken("notion"))()).rejects.toThrow("oauth_network");
      expect((await registry().status())[0].login).toBe("ok");
      remote.state.tokenStatus = 200;
      const token = await runInDurableObject(registry(), async (_instance, state) => new RegistryDO(state, { ...env, OAUTH_STORE_KEY: TEST_STORE_KEY }).accessToken("notion"));
      expect(token).toBe(`${ACCESS}-refreshed`);
      await registry().logout("notion");
      expect((await registry().status())[0].login).toBe("needed");
      await expect((async () => await registry().accessToken("notion"))()).rejects.toThrow("auth_required");
    });
    it("refuses absent CIMD support and third-party token endpoints before sending credentials", async () => {
      const remote = fakeRemote(); remote.state.cimd = false;
      const first = await registry().loginLink("notion");
      expect((await worker.fetch(new Request(first.url), env)).status).toBe(400);
      remote.state.cimd = true; remote.state.tokenEndpoint = "https://third-party.example.test/token";
      const second = await registry().loginLink("notion");
      expect((await worker.fetch(new Request(second.url), env)).status).toBe(400);
      expect(remote.requests.some(r => r.url.includes("third-party") || r.url.endsWith("/register"))).toBe(false);
    });
    it("uses randomized AES-GCM with authenticated identity and rejects tampered ciphertext", async () => {
      const vault = new TokenVault(TEST_STORE_KEY);
      const [one, two] = await Promise.all([vault.encrypt("synthetic", "account1"), vault.encrypt("synthetic", "account1")]);
      expect(one).not.toBe(two); expect(await vault.decrypt(one, "account1")).toBe("synthetic");
      await expect(vault.decrypt(one, "account2")).rejects.toThrow("oauth_token");
      await expect(vault.decrypt(one.slice(0, -4) + "AAAA", "account1")).rejects.toThrow("oauth_token");
    });
  });
  
  describe("bounded OAuth fetch", () => {
    it("enforces HTTPS, allowed origins, manual redirects, no cookies and the streamed 256 KiB limit", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      const bounded = createOAuthFetch(() => [issuer]);
      await expect(bounded("http://auth.example.test/token")).rejects.toThrow("oauth_network");
      await expect(bounded("https://elsewhere.example.test/token")).rejects.toThrow("oauth_network");
      expect(spy).not.toHaveBeenCalled();
      await bounded(`${issuer}/token`, { headers: { Cookie: "synthetic-cookie" } });
      expect(new Headers(spy.mock.calls[0][1]?.headers).has("cookie")).toBe(false);
      spy.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: `${issuer}/other` } }));
      await expect(bounded(`${issuer}/token`)).rejects.toThrow("oauth_network");
      spy.mockResolvedValueOnce(new Response("x".repeat(262145)));
      await expect(bounded(`${issuer}/token`)).rejects.toThrow("oauth_network");
    });
    it("times out even when a fetch implementation ignores AbortSignal", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
      try {
        const result = expect(createOAuthFetch(() => [issuer])(`${issuer}/token`)).rejects.toThrow("oauth_network");
        await vi.advanceTimersByTimeAsync(5001); await result;
      } finally { vi.useRealTimers(); }
    });
  });
});
