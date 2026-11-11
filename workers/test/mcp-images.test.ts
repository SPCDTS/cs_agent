import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { Check } from "typebox/value";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ThreadMcp, type McpAuthority } from "../src/mcp";
import { MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import { MCP_CONFIG } from "../src/mcp/config";
import { compileMcpSchema } from "../src/mcp/schema";
import { convertMcpResult } from "../src/mcp/result";
import { mcpCodemodeResult, mcpCodemodeSchema } from "../src/mcp/codemode-result";
import { createSubagentCapabilityHost, installDelegatedCapabilities } from "../src/mcp/delegated";
import { threadWithBindings } from "./thread-fixture";
import { fakeRemote, login } from "./mcp-helpers";
import { input } from "./helpers";
import * as modelRegistry from "../src/models";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
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
    const remote = fakeRemote(); await login(); await env.THREAD.getByName("owner").stats();
    remote.state.tools[1] = { name: "notion-fetch", inputSchema: { type: "object" }, outputSchema: schema };
    remote.state.toolResult = { content: [image], structuredContent: metadata };
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
      const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority); await mcp.refreshAll();
      const snapshot = await mcp.captureCapabilities(authority, [{ server: "notion", tools: ["notion-fetch"] }]);
      const child = { ...authority, kind: "subagent" as const, subagentId: "image-child" };
      const host = createSubagentCapabilityHost({
        validateSubagentAccess: async () => ({ authority, capabilities: { mcp: snapshot } }),
        subagentMcp: async (_id: string, call: { name: string; args: unknown; operationId: string }) => mcp.invoke({ ...call, snapshot }, async () => child),
      });
      const registry = createRegistry();
      const delegated = installDelegatedCapabilities(registry, host, "image-child", { mcp: snapshot });
      const seen = model([screen]);
      const storage = await openDurableObjectSqliteStorage(state.storage, { prefix: "image_child_" });
      const harness = await Harness.open(storage, { models: seen.create(), registry }, BACKGROUND_CONTEXT);
      try {
        const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: seen.faux.provider.id, modelId: "test" } } });
        harness.resume();
        await (await root.submit({ type: "input", content: "查看截图" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
        expect(remote.state.calls).toBe(1);
        expect(seen.images).toEqual([image]);
        expect(seen.texts.join("\n")).toContain(JSON.stringify(metadata));
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
