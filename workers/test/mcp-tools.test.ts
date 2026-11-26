import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type JsonObject } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { Check } from "typebox/value";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { threadWithBindings } from "./thread-fixture";
import { ThreadMcp, type McpAuthority } from "../src/mcp";
import { MCP_CATALOG_SCHEMA, makeCatalog, restoreCatalog, saveCatalog } from "../src/mcp/catalog";
import { MCP_CONFIG, parseMcpConfig } from "../src/mcp/config";
import { McpConnection } from "../src/mcp/connection";
import { toolNames } from "../src/mcp/names";
import { compileMcpSchema } from "../src/mcp/schema";
import { convertMcpResult } from "../src/mcp/result";
import { mcpCodemodeResult, mcpCodemodeSchema } from "../src/mcp/codemode-result";
import { sameMcpOrigin } from "../src/mcp/access";
import { createSubagentCapabilityHost, installDelegatedCapabilities, type SubagentCapabilityHost } from "../src/mcp/delegated";
import * as models from "../src/models";
import { fakeRemote, login, sampleTools, ACCESS } from "./mcp-helpers";
import { input } from "./helpers";

describe("mcp tools core", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  function scriptedModel(steps: { name: string; args: JsonObject; beforeResponse?: () => Promise<void> }[]) {
    const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const offers: string[] = [], sections: string[] = [], outputs: string[] = [], captured = new Set<string>();
    const respond: FauxResponseFactory = async transcript => {
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
      await next?.beforeResponse?.();
      return next ? fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation(() => {
      const models = createModels(); models.setProvider(faux.provider);
      return models;
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
        const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        expect(await thread.submit(input(1, "查询 MCP", 10000001))).toEqual({ status: "done" });
        return { catalog: state.storage.sql.exec("SELECT * FROM mcp_catalog").toArray(), events: state.storage.sql.exec("SELECT * FROM events WHERE kind LIKE 'mcp_%'").toArray() };
      });
      expect(remote.state.calls).toBe(1); expect(remote.state.pages).toBeGreaterThanOrEqual(2);
      expect(seen.offers).toContain("codemode"); expect(seen.offers.filter(n => n.startsWith("mcp_")).every(n => n === "mcp_manage")).toBe(true);
      expect(seen.sections.join("\n")).toContain("notion"); expect(seen.sections.join("\n")).toContain(name);
      expect(seen.sections.join("\n")).not.toContain("mem_remember");
      expect(seen.outputs[1]).toContain("service-result:"); expect(seen.outputs[1]).not.toContain("图片已省略");
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
        const thread = threadWithBindings(_instance, state, currentEnv);
        expect(await thread.submit(input(1, "调用两次", 10000001))).toEqual({ status: "done" });
        expect(state.storage.sql.exec<{ detail: string }>("SELECT detail FROM events WHERE kind='mcp_call'").toArray().some(e => JSON.parse(e.detail).result === "denied")).toBe(true);
      });
      expect(remote.state.calls).toBe(1); expect(seen.outputs.join("\n")).toContain("denied");
    });
    it.each([{ ns: "group:200000001", user: 10000001, group: 200000001 }, { ns: "group:200000001", user: 10000004, group: 200000001 },
      { ns: "private:10000003", user: 10000003, group: undefined }])("allows public scripts but denies MCP without a grant for $ns sender $user", async ({ ns, user, group }) => {
      const remote = fakeRemote(), seen = scriptedModel([{ name: "codemode", args: { code: "text(ALL_TOOLS); text(await tools.mcp_refresh_tools({}));" } }]);
      await runInDurableObject(env.THREAD.getByName(ns), async (_instance, state) => {
        const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        expect(await thread.submit(input(1, "test", user, group, true))).toEqual({ status: "done" });
      });
      expect(seen.outputs.join("\n")).toContain("denied");
      expect(remote.requests).toHaveLength(0);
    });
    it("does not resend an unsafe call after a transport failure", async () => {
      const remote = fakeRemote(); await login(); remote.state.failCalls = true;
      const seen = scriptedModel([refreshStep, { name: "codemode", args: { code: searchScript } }]);
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        expect(await threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" }).submit(input(1, "test", 10000001))).toEqual({ status: "done" });
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
});

describe("mcp images", () => {
  const modelRegistry = models;
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  const image = { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", mimeType: "image/png" };
  const metadata = { frameId: "synthetic-frame", width: 1024, height: 768 };
  const schema = { type: "object", $defs: { dimension: { type: "integer", minimum: 1 } }, properties: {
    frameId: { type: "string" }, width: { $ref: "#/$defs/dimension" }, height: { $ref: "#/$defs/dimension" },
  }, required: ["frameId", "width", "height"], additionalProperties: false } satisfies NonNullable<Tool["outputSchema"]>;
  const authority: McpAuthority = { kind: "message", scope: "owner", actor: "10000001", owner: true, generation: 1, replyChannel: "web" };
  const show = 'if (result.structuredContent) text(result.structuredContent); for (const block of result.content) { if (block.type === "image") image(block); else text(block.text); }';
  const screen = `const name = ALL_TOOLS.find(t => t.name.startsWith("mcp_notion_notion_fetch_")).name; const result = await tools[name]({}); ${show}`;
  
  function model(codes: string[]) {
    const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const images: typeof image[] = [], texts: string[] = [], sections: string[] = [], captured = new Set<string>();
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      for (const message of transcript.messages) {
        if (message.role === "system") sections.push(...Object.values(message.sections ?? {}).filter(value => typeof value === "string"));
        if (message.role !== "toolResult" || captured.has(message.toolCallId)) continue;
        captured.add(message.toolCallId);
        for (const block of message.content) {
          if (block.type === "image") images.push(block);
          if (block.type === "text") texts.push(block.text);
        }
      }
      const code = codes.shift();
      return code ? fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
    };
    faux.setResponses([respond]);
    const create = () => { const models = createModels(); models.setProvider(faux.provider); return models; };
    return { faux, create, images, texts, sections };
  }
  
  describe("MCP images reach the model through Code Mode", () => {
    it.each([true, false])("preserves content with outputSchema=%s through SDK, Thread and QuickJS", async declared => {
      const remote = fakeRemote(); await login();
      remote.state.tools[1] = { name: "notion-fetch", inputSchema: { type: "object", additionalProperties: false }, ...(declared ? { outputSchema: schema } : {}) };
      remote.state.toolResult = { content: [image], structuredContent: metadata };
      const seen = model(['text(await tools.mcp_refresh_tools({}));', screen]);
      vi.spyOn(modelRegistry, "openModels").mockImplementation(seen.create);
      await runInDurableObject(env.THREAD.getByName("owner"), async (instance, state) => {
        const thread = threadWithBindings(instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
        expect(await thread.submit(input(1, "检查截图", 10000001))).toEqual({ status: "done" });
      });
      expect(remote.state.calls).toBe(1);
      expect(seen.images).toEqual([image]);
      expect(seen.texts.join("\n")).toContain(JSON.stringify(metadata));
      expect(seen.texts.join("\n")).not.toContain(image.data);
      expect(seen.sections.join("\n")).toContain("image(block)");
    });
  
    it("preserves resource images without a remote outputSchema", async () => {
      const remote = fakeRemote(); await login();
      remote.state.resourceBlob = { blob: image.data, mimeType: image.mimeType };
      const seen = model(['text(await tools.mcp_refresh_tools({}));', `const result = await tools.mcp_resources_read({server:"notion",uri:"notion://docs/start"}); ${show}`]);
      vi.spyOn(modelRegistry, "openModels").mockImplementation(seen.create);
      await runInDurableObject(env.THREAD.getByName("owner"), async (instance, state) => {
        expect(await threadWithBindings(instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" }).submit(input(1, "查看资源图片", 10000001))).toEqual({ status: "done" });
      });
      expect(remote.state.resourceReads).toBe(1);
      expect(seen.images).toEqual([image]);
    });
  
    it("preserves images through parent MCP, child RPC adapter and child QuickJS", async () => {
      const endpoint = "https://desktop.example.test/mcp", id = "test-desktop";
      const remote = fakeRemote(endpoint); await env.THREAD.getByName("owner").syncAdminView("owner");
      remote.state.tools = [{ name: "desktop_capture", inputSchema: { type: "object" }, outputSchema: schema }];
      const server = { ...MCP_CONFIG.servers[0]!, id, credential: { kind: "none" as const },
        transport: { ...MCP_CONFIG.servers[0]!.transport, url: endpoint }, tools: { allow: ["desktop_capture"], eventAllow: [] } };
      const config = { ...MCP_CONFIG, servers: [server] };
      remote.state.toolResult = { content: [image], structuredContent: metadata };
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
        const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority, config); await mcp.refreshAll();
        const snapshot = await mcp.captureCapabilities(authority, [{ server: id, tools: ["desktop_capture"] }]);
        const child = { ...authority, kind: "subagent" as const, subagentId: "image-child" };
        const host = createSubagentCapabilityHost({
          validateSubagentAccess: async () => ({ authority, capabilities: { mcp: snapshot } }),
          subagentMcp: async (_id: string, call: { name: string; args: unknown; operationId: string }) => mcp.invoke({ ...call, snapshot }, async () => child),
        });
        const registry = createRegistry();
        const delegated = installDelegatedCapabilities(registry, host, "image-child", { mcp: snapshot });
        const seen = model([`const result = await tools[${JSON.stringify(snapshot.tools[0])}]({}); ${show}`]);
        const storage = await openDurableObjectSqliteStorage(state.storage, { prefix: "image_child_" });
        const harness = await Harness.open(storage, { models: seen.create(), registry }, BACKGROUND_CONTEXT);
        try {
          const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: seen.faux.provider.id, modelId: "test" } } });
          harness.resume();
          await (await root.submit({ type: "input", content: "查看截图" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
          expect(remote.state.calls).toBe(1);
          expect(seen.images).toEqual([image]);
          expect(seen.texts.join("\n")).toContain(JSON.stringify(metadata));
          expect(seen.sections.join("\n")).toContain(id);
          expect(seen.sections.join("\n")).toContain("image(block)");
        } finally { await harness.close(BACKGROUND_CONTEXT); await delegated.close(); await mcp.close(); }
      });
    });
  
    it("keeps schema references and business data distinct and rejects invalid metadata", () => {
      const source = { ...schema, properties: { ...schema.properties, business: { const: { $ref: "#business-data" } } } };
      const compiled = compileMcpSchema(source, MCP_CONFIG.limits);
      const contract = mcpCodemodeSchema(compiled.schema);
      const data = { ...metadata, business: { $ref: "#business-data" } };
      const result = mcpCodemodeResult(convertMcpResult({ content: [image], structuredContent: data }, compiled, MCP_CONFIG.limits));
      expect(Check(contract, result.structuredOutput)).toBe(true);
      expect(Check(contract, { content: [image], structuredContent: { ...data, width: "wrong" } })).toBe(false);
      expect(source.properties.width.$ref).toBe("#/$defs/dimension");
      expect(compiled.schema).toMatchObject({ properties: { width: { $ref: "#/$defs/dimension" } } });
      const rejected = mcpCodemodeResult(convertMcpResult({ content: [image], structuredContent: { ...metadata, width: "wrong" } }, compiled, MCP_CONFIG.limits));
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredOutput).toBeUndefined();
    });
  });
});

describe("mcp resources and delegation", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  const authority: McpAuthority = { kind: "message", scope: "owner", actor: "10000001", owner: true, generation: 1, replyChannel: "web" };
  describe("MCP resources and delegated capabilities", () => {
    it("preserves structured image results across the delegated RPC boundary", async () => {
      const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
      const host = createSubagentCapabilityHost({ subagentCoding: async () => ({ output: [image], structuredOutput: { kind: "image", image }, [Symbol.dispose]() {} }) });
      expect(await host.subagentCoding("child", { kind: "read", operationId: "read-one", path: "out/image.png" })).toEqual({
        output: [image], structuredOutput: { kind: "image", image },
      });
    });
    it("runs coding-only child tools through Code Mode without an MCP catalog", async () => {
      await runInDurableObject(env.THREAD.getByName("coding-child-fixture"), async (_instance, state) => {
        const coding = vi.fn(async () => ({ output: [{ type: "text" as const, text: "child-executed" }] }));
        const host: SubagentCapabilityHost = {
          validateSubagentAccess: async () => ({ authority, capabilities: { coding: true } }),
          subagentCoding: coding,
          subagentMcp: async () => { throw new Error("unexpected_mcp"); },
          subagentSkill: async () => ({ output: [] }),
          subagentSkillList: async () => ({ output: [] }),
          subagentSkillBash: async () => ({ output: [] }),
        };
        const registry = createRegistry(), delegated = installDelegatedCapabilities(registry, host, "coding-child", { coding: true });
        const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
        faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(await tools.bash({command:"echo child"}));' }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
        const models = createModels(); models.setProvider(faux.provider);
        const storage = await openDurableObjectSqliteStorage(state.storage, { prefix: "coding_child_" });
        const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
        try {
          const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: faux.provider.id, modelId: "test" } } });
          const resolved = await root.agent(BACKGROUND_CONTEXT);
          expect(resolved.tools.map(tool => tool.name)).toContain("codemode");
          for (const name of ["bash", "read", "write", "edit"]) {
            expect(resolved.tools.map(tool => tool.name)).not.toContain(name);
            expect(resolved.callable.map(tool => tool.name)).toContain(name);
          }
          harness.resume();
          const submission = await root.submit({ type: "input", content: "执行" }, BACKGROUND_CONTEXT);
          await submission.wait(BACKGROUND_CONTEXT);
          expect(coding).toHaveBeenCalledOnce();
          expect(coding.mock.calls[0]).toEqual(["coding-child", expect.objectContaining({ kind: "exec", command: "echo child" })]);
        } finally { await harness.close(BACKGROUND_CONTEXT); await delegated.close(); }
      });
    });
    it("reads listed/template resources with configured prefixes through the shared connection", async () => {
      const remote = fakeRemote(); await login();
      await env.THREAD.getByName("owner").syncAdminView("owner");
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const db = new DurableObjectSqliteDatabase(state.storage);
        await db.exec(MCP_CATALOG_SCHEMA);
        const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority);
        const invoke = (name: string, args: unknown) => mcp.invoke({ name, args, operationId: "test" }, async () => authority);
        expect((await invoke("mcp_resources_list", { server: "notion" })).output).toEqual([{ type: "text", text: expect.stringContaining("notion://docs/start") }]);
        expect(JSON.stringify((await invoke("mcp_resources_list", { server: "notion" })).output)).not.toContain("hidden");
        expect(JSON.stringify((await invoke("mcp_resources_templates", { server: "notion" })).output)).toContain("{page}");
        expect(JSON.stringify((await invoke("mcp_resources_read", { server: "notion", uri: "notion://docs/another" })).output)).toContain("合成文档正文");
        expect((await invoke("mcp_resources_read", { server: "notion", uri: "notion://private/hidden" })).isError).toBe(true);
        expect(remote.state.resourceReads).toBe(1);
        expect(remote.requests.filter(r => r.body.includes('"method":"resources/list"'))).toHaveLength(1);
        remote.state.resourceBlob = { blob: Buffer.from("synthetic pdf bytes").toString("base64"), mimeType: "application/pdf" };
        expect(JSON.stringify((await invoke("mcp_resources_read", { server: "notion", uri: "notion://docs/file.pdf" })).output)).toContain("MCP 私有附件");
        await mcp.close();
      });
    });
    it("delegates only snapshot tools, skills and explicitly granted independent coding, preserving web origin", async () => {
      fakeRemote(); await login(); await env.THREAD.getByName("owner").syncAdminView("owner");
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
        const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority); await mcp.refreshAll();
        const snapshot = await mcp.captureCapabilities(authority);
        const host: SubagentCapabilityHost = {
          validateSubagentAccess: async () => ({ authority, capabilities: { mcp: snapshot, coding: true } }),
          subagentMcp: async () => ({ output: [{ type: "text", text: "proxy" }] }),
          subagentSkill: async () => ({ output: [{ type: "text", text: "skill" }] }),
          subagentSkillList: async () => ({ output: [] }),
          subagentSkillBash: async () => ({ output: [] }),
          subagentCoding: async () => ({ output: [{ type: "text", text: "sandbox" }] }),
        };
        const registry = createRegistry(), delegated = installDelegatedCapabilities(registry, host, "synthetic-child", { mcp: snapshot, coding: true });
        const names = registry.snapshot().tools().map(t => t.tool.name);
        expect(names).toEqual(expect.arrayContaining(["read_skill", "bash", "read", "write", "edit", "codemode", "mcp_resources_read"]));
        expect(names).not.toEqual(expect.arrayContaining(["send_message", "mem_remember", "skill_publish", "subagent"]));
        expect(sameMcpOrigin({ ...authority, subagentId: "synthetic-child" }, snapshot)).toBe(true);
        expect(sameMcpOrigin({ ...authority, replyChannel: "qq" }, snapshot)).toBe(false);
        expect((await mcp.invoke({ name: "mcp_resources_list", args: { server: "notion" }, operationId: "wrong-origin", snapshot }, async () => ({ ...authority, replyChannel: "qq" }))).isError).toBe(true);
        await delegated.close(); await mcp.close();
      });
    });
  
    it("主人派发子任务时，设备目录超时会取消在途或排队的请求并保留其他 MCP 工具", async () => {
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const db = new DurableObjectSqliteDatabase(state.storage);
        await db.exec(MCP_CATALOG_SCHEMA);
        const config = parseMcpConfig({ version: 1, enabled: true, servers: ["cua", "docs"].map(id => ({
          id, transport: { kind: "reverse-websocket", url: "https://mcp.example.test/" + id },
          credential: { kind: "managed", accountId: id, revision: "v1" }, access: { kind: "owner-private", revision: "v1" },
          tools: { allow: [id === "cua" ? "list_spaces" : "lookup"] }, replay: "unsafe",
        })) });
        for (const server of config.servers) {
          const tools = server.tools.allow.map(name => ({ name, inputSchema: { type: "object" as const } }));
          await saveCatalog(db, makeCatalog(server, tools, config.limits).revision);
        }
        const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority, config, { scope: "owner" });
        const started = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>();
        const open = vi.spyOn(McpConnection, "open").mockImplementation(async (_server, _env, _limits, signal) => {
          started.resolve(signal);
          await release.promise;
          throw new Error("fixture_offline");
        });
        try {
          await mcp.restore();
          const inFlight = mcp.captureCapabilities(authority);
          const signal = await started.promise;
          const queued = mcp.captureCapabilities(authority);
          for (const snapshot of await Promise.all([inFlight, queued])) {
            expect(snapshot.cua).toBeUndefined();
            expect(snapshot.tools).toEqual([expect.stringMatching(/^mcp_docs_lookup_/)]);
          }
          expect(signal.aborted).toBe(true);
        } finally {
          release.resolve();
          await mcp.close();
        }
        expect(open).toHaveBeenCalledOnce();
      });
    }, 8_000);
  
    it("narrows delegated tool contracts and sends trusted caller scope separately from arguments", async () => {
      const remote = fakeRemote(); await login(); await env.THREAD.getByName("owner").syncAdminView("owner");
      remote.state.tools = [
        ...remote.state.tools.slice(0, 2),
        { name: "notion-create-pages", inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false } },
      ];
      const payload = { requestId: "synthetic-request" }, image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
      remote.state.toolResult = { structuredContent: payload, content: [image] };
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
        const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority);
        await mcp.refreshAll();
        const complete = await mcp.captureCapabilities(authority);
        const snapshot = await mcp.captureCapabilities(authority, [{ server: "notion", tools: ["notion-create-pages", "not-found"] }]);
        const child = { ...authority, kind: "subagent" as const, subagentId: "child-one" };
        expect(complete.tools).toHaveLength(3);
        expect(snapshot.tools).toHaveLength(1);
        expect(snapshot.resourceAllow).toEqual([]);
        expect((await mcp.captureCapabilities(authority, [])).tools).toEqual([]);
        const tool = snapshot.tools[0]!;
        const unselected = complete.tools.find(name => name !== tool)!;
        expect((await mcp.invoke({ name: unselected, args: {}, operationId: "outside", snapshot }, async () => child)).isError).toBe(true);
        expect((await mcp.invoke({ name: "mcp_resources_list", args: { server: "notion" }, operationId: "outside", snapshot }, async () => child)).isError).toBe(true);
        expect((await mcp.captureCapabilities({ ...authority, kind: "event" }, [{ server: "notion", tools: ["notion-create-pages"] }])).tools).toEqual([]);
  
        const args = { _meta: { "joule/caller": { scope: "model-supplied" } } };
        const call = { name: tool, args, operationId: "submit" };
        const direct = await mcp.invoke(call, async () => authority);
        expect(direct).toMatchObject({ structuredOutput: payload, output: expect.arrayContaining([image]) });
        const replay = await mcp.invoke(call, async () => authority);
        expect(replay.structuredOutput).toEqual(payload);
        expect(replay.output?.map(part => part.type)).toEqual(["text", "text"]);
        await mcp.invoke({ ...call, operationId: "next-turn" }, async () => authority);
        expect(await mcp.invoke({ ...call, snapshot }, async () => child)).toMatchObject({ structuredOutput: payload });
        for (const who of [{ ...authority, generation: 2 }, { ...authority, replyChannel: "qq" as const }, { ...authority, actor: "another-owner" }]) {
          await mcp.invoke(call, async () => who);
        }
        const calls = remote.requests.flatMap(request => request.body.includes('"method":"tools/call"') ? [JSON.parse(request.body).params] : []);
        expect(calls).toHaveLength(6);
        for (const params of calls) {
          expect(params).toMatchObject({
            arguments: args,
            _meta: {
              "joule/caller": { scope: expect.stringMatching(/^[a-f0-9]{64}$/) },
              "cs-agent/caller": { scope: expect.stringMatching(/^[a-f0-9]{64}$/) },
            },
          });
          expect(params._meta["cs-agent/caller"]).toEqual(params._meta["joule/caller"]);
        }
        const scopes = calls.map(params => params._meta["joule/caller"].scope);
        expect(scopes[0]).toBe(scopes[1]);
        expect(new Set(scopes)).toHaveLength(5);
        await mcp.close();
      });
    });
  });
});
