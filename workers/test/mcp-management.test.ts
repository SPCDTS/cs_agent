import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createRegistry, type JsonObject } from "@earendil-works/pi-durable";
import worker from "../src/index";
import { RegistryDO } from "../src/registry";
import { ThreadDO } from "../src/thread";
import { MCP_CONFIG } from "../src/mcp/config";
import { McpPolicyStore } from "../src/mcp/policy";
import { ThreadMcp } from "../src/mcp";
import { MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import { snapshotCatalogs } from "../src/mcp/access";
import { manageMcp } from "../src/mcp/manage";
import { serverDigest } from "../src/mcp/names";
import * as models from "../src/models";
import { fakeRemote, adminEnv, ACCESS, callback } from "./mcp-helpers";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const endpoint = "https://mcp.integration.test/mcp", id = "fixture-project";
const registry = () => env.REGISTRY.getByName("main");
function remoteFixture() {
  const remote = fakeRemote(endpoint);
  remote.state.tools = [{ name: "lookup", description: "查询合成项目", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
  return remote;
}
async function probeActivate() {
  let record = await registry().mcpServerGet(id);
  expect(await manageMcp(env, { action: "probe", id, expectedRevision: record.revision })).toMatchObject({ status: "ready" });
  record = await registry().mcpServerGet(id);
  return registry().mcpServerActivate(id, record.revision, { allow: ["lookup"], readOnly: ["lookup"] });
}
type Step = (revision: string) => { name: string; args: JsonObject };
function scriptedModel(steps: Step[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const offers: string[] = [], outputs: string[] = [], captured = new Set<string>();
  let revision = "absent";
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    for (const message of transcript.messages) {
      if (message.role === "system") offers.push(...(message.toolsAdded ?? []).map(tool => tool.name));
      if (message.role === "toolResult" && !captured.has(message.toolCallId)) {
        captured.add(message.toolCallId);
        const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        outputs.push(text);
        try { const value: unknown = JSON.parse(text); if (Check(Type.Object({ revision: Type.String() }), value)) revision = value.revision; } catch {}
      }
    }
    const next = steps.shift()?.(revision);
    return next ? fauxAssistantMessage(fauxToolCall(next.name, next.name === "mcp_manage" ? { request: next.args } : next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(() => { const result = createModels(); result.setProvider(faux.provider); return result; });
  return { offers, outputs };
}

describe("runtime MCP onboarding", () => {
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

  it("adds, probes, activates, calls and disables a service in one real owner conversation", async () => {
    const remote = remoteFixture();
    for (const record of await registry().mcpServersList()) await registry().mcpServerDisable(record.server.id, record.revision);
    const call = { name: "codemode", args: { code: "const tool=ALL_TOOLS.find(t=>t.name.startsWith('mcp_fixture_project_lookup_'));text(await tools[tool.name]({query:'合成查询'}));" } };
    const seen = scriptedModel([
      () => ({ name: "mcp_manage", args: { action: "put", expectedRevision: "absent", server: { id, url: endpoint, auth: "none" } } }),
      revision => ({ name: "mcp_manage", args: { action: "probe", id, expectedRevision: revision } }),
      revision => ({ name: "mcp_manage", args: { action: "activate", id, expectedRevision: revision, selection: { allow: ["lookup"], readOnly: ["lookup"] } } }),
      () => call,
      revision => ({ name: "mcp_manage", args: { action: "disable", id, expectedRevision: revision } }),
      () => call,
    ]);
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const thread = new ThreadDO(state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      const result = await thread.submit(input(1, "接入并验证合成 MCP 服务", 10000001));
      expect(result, JSON.stringify(state.storage.sql.exec("SELECT * FROM events").toArray())).toEqual({ status: "done" });
    });
    expect(seen.offers).toContain("mcp_manage");
    expect(seen.outputs[3]).toContain("service-result:");
    expect(seen.outputs[5]).toContain("denied");
    expect(remote.state.calls).toBe(1);
    expect((await registry().mcpServerGet(id)).server.enabled).toBe(false);
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
      const thread = new ThreadDO(state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      expect(await thread.submit(input(1, "接入服务", user, group, true))).toEqual({ status: "done" });
    });
    expect(seen.offers).not.toContain("mcp_manage");
    expect((await registry().mcpConfig()).servers.some(server => server.id === id)).toBe(false);
  });
});
