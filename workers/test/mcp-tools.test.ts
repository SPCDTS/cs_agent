import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type JsonObject } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ThreadDO } from "../src/thread";
import { ThreadMcp } from "../src/mcp";
import { MCP_CATALOG_SCHEMA, makeCatalog, restoreCatalog, saveCatalog } from "../src/mcp/catalog";
import { MCP_CONFIG } from "../src/mcp/config";
import { McpConnection } from "../src/mcp/connection";
import { toolNames } from "../src/mcp/names";
import * as models from "../src/models";
import { fakeRemote, login, sampleTools, ACCESS } from "./mcp-helpers";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
function scriptedModel(steps: { name: string; args: JsonObject }[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const offers: string[] = [], sections: string[] = [], outputs: string[] = [], captured = new Set<string>();
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    for (const message of transcript.messages) {
      if (message.role === "system") {
        offers.push(...(message.toolsAdded ?? []).map(t => t.name));
        if (message.sections?.codemode) sections.push(message.sections.codemode);
      }
      if (message.role === "toolResult" && !captured.has(message.toolCallId)) {
        captured.add(message.toolCallId); outputs.push(message.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      }
    }
    const next = steps.shift();
    return next ? fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(async () => {
    const models = createModels(); models.setProvider(faux.provider);
    return { models, selection: { provider: "faux", id: "test" } };
  });
  return { offers, sections, outputs };
}
const refreshStep = { name: "codemode", args: { code: "text(await tools.mcp_refresh_tools({}));" } };
const searchScript = "const name = ALL_TOOLS.find(t => t.name.startsWith('mcp_notion_notion_search_')).name; text(await tools[name]({query:'private-query'}));";

describe("MCP in pi-durable and inline QuickJS", () => {
  it("runs codemode through the real Thread, hides MCP definitions from the model, snapshots and audits metadata", async () => {
    const remote = fakeRemote(); await login();
    const candidate = makeCatalog(MCP_CONFIG.servers[0], sampleTools, MCP_CONFIG.limits);
    const name = toolNames(candidate.revision, candidate.revision.tools[1]).nativeName;
    const seen = scriptedModel([refreshStep, { name: "codemode", args: { code: searchScript } }, { name, args: { query: "must-not-send" } }]);
    const result = await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const thread = new ThreadDO(state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      expect(await thread.submit(input(1, "查询 MCP", 10000001))).toEqual({ status: "done" });
      return { catalog: state.storage.sql.exec("SELECT * FROM mcp_catalog").toArray(), events: state.storage.sql.exec("SELECT * FROM events WHERE kind LIKE 'mcp_%'").toArray() };
    });
    expect(remote.state.calls).toBe(1); expect(remote.state.pages).toBeGreaterThanOrEqual(2);
    expect(seen.offers).toContain("codemode"); expect(seen.offers.some(n => n.startsWith("mcp_"))).toBe(false);
    expect(seen.sections.join("\n")).toContain("notion"); expect(seen.sections.join("\n")).toContain(name);
    expect(seen.sections.join("\n")).not.toContain("mem_remember");
    expect(seen.outputs[1]).toContain("service-result:"); expect(seen.outputs[1]).toContain("图片已省略");
    expect(result.catalog).toHaveLength(2);
    const calls = result.events.filter(e => e.kind === "mcp_call"); expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].detail))).toMatchObject({ server: "notion", tool: name, result: "ok", ms: expect.any(Number), inputBytes: expect.any(Number), outputBytes: expect.any(Number) });
    for (const secret of [ACCESS, "private-query", "service-result"]) expect(JSON.stringify(result.events)).not.toContain(secret);
    expect(JSON.stringify(result.events)).toContain("unknown_keyword");
  });
  it("rechecks the current sender on every nested business call after ownership changes", async () => {
    const remote = fakeRemote(); await login();
    const seen = scriptedModel([refreshStep, { name: "codemode", args: { code: searchScript + "\ntext(await tools[name]({query:'second'}));" } }]);
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const currentEnv = { ...env, QQ_OWNER: "10000001", MEMORY_EXTRACT_NAMESPACES: "" };
      remote.state.beforeCall = async () => { currentEnv.QQ_OWNER = "10000002"; };
      const thread = new ThreadDO(state, currentEnv);
      expect(await thread.submit(input(1, "调用两次", 10000001))).toEqual({ status: "done" });
      expect(state.storage.sql.exec<{ detail: string }>("SELECT detail FROM events WHERE kind='mcp_call'").toArray().some(e => JSON.parse(e.detail).result === "denied")).toBe(true);
    });
    expect(remote.state.calls).toBe(1); expect(seen.outputs.join("\n")).toContain("denied");
  });
  it.each([{ ns: "group:200000001", user: 10000001, group: 200000001 }, { ns: "group:200000001", user: 10000004, group: 200000001 },
    { ns: "private:10000003", user: 10000003, group: undefined }])("installs no MCP or codemode for $ns sender $user", async ({ ns, user, group }) => {
    const remote = fakeRemote(), seen = scriptedModel([{ name: "codemode", args: { code: "text(ALL_TOOLS)" } }]);
    await runInDurableObject(env.THREAD.getByName(ns), async (_instance, state) => {
      const thread = new ThreadDO(state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      expect(await thread.submit(input(1, "test", user, group, true))).toEqual({ status: "done" });
    });
    expect(seen.offers).not.toContain("codemode"); expect(seen.sections).toHaveLength(0); expect(remote.requests).toHaveLength(0);
  });
  it("does not resend an unsafe call after a transport failure", async () => {
    const remote = fakeRemote(); await login(); remote.state.failCalls = true;
    const seen = scriptedModel([refreshStep, { name: "codemode", args: { code: searchScript } }]);
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      expect(await new ThreadDO(state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" }).submit(input(1, "test", 10000001))).toEqual({ status: "done" });
    });
    expect(remote.state.calls).toBe(1); expect(seen.outputs.join("\n")).toContain("outcome_unknown");
    expect(seen.outputs.join("\n")).not.toContain("synthetic-network-detail");
  });
});

describe("MCP transport, snapshots and connection lifetime", () => {
  it("uses SDK Streamable HTTP pagination with static secrets, accepts optional GET 405, and closes sessions", async () => {
    const remote = fakeRemote();
    await runInDurableObject(env.THREAD.getByName("owner"), async () => {
      const server = { ...MCP_CONFIG.servers[0], credential: { kind: "external-account", accountId: "fixture", revision: "1" } as const,
        transport: { ...MCP_CONFIG.servers[0].transport, secretHeaders: { Authorization: "STATIC_HEADER" } } };
      const staticEnv = { ...env, STATIC_HEADER: "Bearer synthetic-static" };
      const connection = await McpConnection.open(server, staticEnv, MCP_CONFIG.limits, new AbortController().signal, () => {});
      expect(await connection.listTools(new AbortController().signal)).toHaveLength(4);
      await connection.close();
    });
    expect(remote.state.initializations).toBe(1); expect(remote.state.pages).toBe(2);
    expect(remote.requests.some(r => r.method === "DELETE")).toBe(true);
    expect(remote.requests.every(r => r.headers.get("authorization") === "Bearer synthetic-static")).toBe(true);
  });
  it("restores snapshots before network refresh, preserves them on partial failure and expires idle connections", async () => {
    const remote = fakeRemote(); await login();
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA + "CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)");
      const revision = makeCatalog(MCP_CONFIG.servers[0], sampleTools, MCP_CONFIG.limits).revision;
      await saveCatalog(db, revision);
      const registry = createRegistry(), mcp = new ThreadMcp(db, env, registry, async () => "message" as const, { ...MCP_CONFIG, limits: { ...MCP_CONFIG.limits, idleMs: 1 } });
      await mcp.restore();
      expect(registry.snapshot().tools().filter(t => t.tool.name.startsWith("mcp_notion_"))).toHaveLength(2);
      expect(remote.state.initializations).toBe(0);
      await mcp.refreshAll();
      await new Promise(resolve => setTimeout(resolve, 5));
      remote.state.failPage = true;
      expect((await mcp.refreshAll())[0].status).toBe("unavailable");
      expect(remote.state.initializations).toBe(2);
      expect((await restoreCatalog(db, MCP_CONFIG.servers[0], MCP_CONFIG.limits))?.digest).toBe(revision.digest);
      await db.run("UPDATE mcp_catalog SET tool_name='tampered' WHERE remote_name='notion-search'");
      await expect(restoreCatalog(db, MCP_CONFIG.servers[0], MCP_CONFIG.limits)).rejects.toThrow("catalog_invalid");
      await mcp.close();
    });
  });
});
