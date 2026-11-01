import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ThreadMcp, type McpAuthority } from "../src/mcp";
import { MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import { sameMcpOrigin } from "../src/mcp/access";
import { createSubagentCapabilityHost, installDelegatedCapabilities, type SubagentCapabilityHost } from "../src/mcp/delegated";
import { fakeRemote, login } from "./mcp-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
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
    await env.THREAD.getByName("owner").stats();
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
    fakeRemote(); await login(); await env.THREAD.getByName("owner").stats();
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
      const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority); await mcp.refreshAll();
      const snapshot = await mcp.captureCapabilities(authority);
      const host: SubagentCapabilityHost = {
        validateSubagentAccess: async () => ({ authority, capabilities: { mcp: snapshot, coding: true } }),
        subagentMcp: async () => ({ output: [{ type: "text", text: "proxy" }] }),
        subagentSkill: async () => ({ output: [{ type: "text", text: "skill" }] }),
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
});
