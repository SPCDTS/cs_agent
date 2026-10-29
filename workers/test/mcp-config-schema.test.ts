import { describe, it, expect } from "vitest";
import { MCP_CONFIG, parseMcpConfig, DEFAULT_MCP_LIMITS } from "../src/mcp/config";
import { compileMcpSchema } from "../src/mcp/schema";
import { makeCatalog } from "../src/mcp/catalog";
import { toolNames } from "../src/mcp/names";
import { convertMcpResult } from "../src/mcp/result";
import { sampleTools } from "./mcp-helpers";

describe("MCP static config and strict schema", () => {
  it("bundles the owner-only Notion CIMD config without credentials", () => {
    expect(MCP_CONFIG.servers[0].credential).toMatchObject({ kind: "oauth", registration: "cimd", clientMetadataUrl: "https://agent.spcdts.dev/oauth/client-metadata.json" });
    expect(MCP_CONFIG.servers[0].tools.allow).toHaveLength(10);
    expect(MCP_CONFIG.limits.idleMs).toBe(600_000);
  });
  it.each([
    { unexpected: true }, { servers: [...MCP_CONFIG.servers, MCP_CONFIG.servers[0]] },
    ...[{ access: { kind: "public" } }, { access: { kind: "owner-private", groups: ["123"] } }, { replay: "safe" },
      { transport: { kind: "stdio", command: "ignored" } }, { transport: { kind: "streamable-http", url: "http://localhost/mcp" } },
      { tools: { allow: ["a", "a"] } }, { credential: { ...MCP_CONFIG.servers[0].credential, registration: "dynamic" } },
      { transport: { ...MCP_CONFIG.servers[0].transport, secretHeaders: { Authorization: "KEY" } } },
      { transport: { ...MCP_CONFIG.servers[0].transport, headers: { Cookie: "synthetic" } } },
      { transport: { ...MCP_CONFIG.servers[0].transport, headers: { "Mcp-Session-Id": "synthetic" } } },
      { transport: { ...MCP_CONFIG.servers[0].transport, headers: { "invalid header": "synthetic" } } },
    ].map(patch => ({ servers: [{ ...MCP_CONFIG.servers[0], ...patch }] })),
  ])("rejects unsupported or unsafe config %#", patch => {
    expect(() => parseMcpConfig({ ...MCP_CONFIG, ...patch })).toThrow("mcp_config_invalid");
  });
  it("accepts static secret references and none credentials", () => {
    for (const credential of [{ kind: "none" }, { kind: "external-account", accountId: "test", revision: "1" }]) {
      expect(parseMcpConfig({ ...MCP_CONFIG, servers: [{ ...MCP_CONFIG.servers[0], credential,
        transport: { ...MCP_CONFIG.servers[0].transport, secretHeaders: credential.kind === "none" ? {} : { Authorization: "TEST_AUTH" } } }] }).servers).toHaveLength(1);
    }
  });
  it("checks local refs, $defs, numeric exclusive bounds and strips only schema annotations", () => {
    const result = compileMcpSchema({ type: "object", $schema: "dialect annotation", $defs: { n: { type: "number", exclusiveMinimum: 1, exclusiveMaximum: 4 } },
      properties: { count: { $ref: "#/$defs/n" }, title: { const: { $schema: "business-data" } } }, required: ["count"], additionalProperties: false }, DEFAULT_MCP_LIMITS);
    expect(result.schema).not.toHaveProperty("$schema");
    expect(result.check({ count: 2, title: { $schema: "business-data" } })).toBe(true);
    for (const value of [{ count: 1 }, { count: 4 }, { count: "2" }, { count: 2, extra: true }]) expect(result.check(value)).toBe(false);
  });
  it.each([
    { $id: "id" }, { properties: { x: { format: "unknown-format" } } }, { properties: { x: { $ref: "https://outside.test/schema" } } },
    { properties: { x: { $ref: "#" } } }, { properties: { x: { $ref: "#/$defs/missing" } } }, { properties: { x: { typo: true } } },
    { properties: { x: { $schema: "x".repeat(257) } } }, { properties: { x: { pattern: "[" } } },
  ])("rejects unsupported schema %#", patch => expect(() => compileMcpSchema({ type: "object", ...patch }, DEFAULT_MCP_LIMITS)).toThrow());
  it("filters allow lists, isolates invalid tools, and hashes tool contracts independently of descriptions", () => {
    const server = MCP_CONFIG.servers[0], first = makeCatalog(server, sampleTools, DEFAULT_MCP_LIMITS);
    expect(first.revision.tools.map(t => t.name)).toEqual(["notion-fetch", "notion-search"]);
    expect(first.rejectedTools).toEqual([{ name: "notion-create-pages", reason: "unknown_keyword" }]);
    const tool = first.revision.tools[1], name = toolNames(first.revision, tool).nativeName;
    expect(name).toMatch(/^mcp_notion_notion_search_[a-f0-9]{12}$/);
    const second = makeCatalog(server, [{ ...sampleTools[0], description: "new description", inputSchema: { ...sampleTools[0].inputSchema, title: "new title" } }], DEFAULT_MCP_LIMITS);
    expect(toolNames(second.revision, second.revision.tools[0]).nativeName).toBe(name);
    const changed = makeCatalog(server, [{ ...sampleTools[0], inputSchema: { type: "object", properties: { query: { type: "number" } } } }], DEFAULT_MCP_LIMITS);
    expect(toolNames(changed.revision, changed.revision.tools[0]).nativeName).not.toBe(name);
  });
  it("joins text, omits images, bounds 8000 characters and preserves result errors and output validation", () => {
    const result = convertMcpResult({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }, undefined, DEFAULT_MCP_LIMITS);
    expect(result.output).toEqual([{ type: "text", text: "one\ntwo\n[MCP 图片已省略：P1c 只传递文本]" }]);
    const large = convertMcpResult({ content: [{ type: "text", text: "中".repeat(9000) }], isError: true }, undefined, DEFAULT_MCP_LIMITS);
    expect(large.isError).toBe(true);
    expect(large.output?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("截断") });
    const text = large.output?.[0]; expect(text?.type === "text" && text.text.length).toBeLessThanOrEqual(8000);
    const output = compileMcpSchema({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, DEFAULT_MCP_LIMITS);
    expect(convertMcpResult({ content: [], structuredContent: { ok: true } }, output, DEFAULT_MCP_LIMITS).structuredOutput).toEqual({ ok: true });
    expect(convertMcpResult({ content: [], structuredContent: { ok: 1 } }, output, DEFAULT_MCP_LIMITS).isError).toBe(true);
  });
});
