import { describe, expect, it } from "vitest";
import { z } from "zod";
import { digest, makeCatalog, restoreCatalog, toolContract, toolNames } from "../../src/agent/pi-mcp/catalog.js";
import { DEFAULT_MCP_LIMITS, parseMcpConfig } from "../../src/agent/pi-mcp/config.js";

const parsed = parseMcpConfig({ version: 1, enabled: true, servers: [{ id: "fixture",
  transport: { kind: "streamable-http", url: "https://example.test/mcp" }, credential: { kind: "none" },
  tools: { allow: ["lookup", "other"] }, access: { kind: "owner-private" }, replay: "unsafe" }] });
if (parsed.kind !== "enabled" || !parsed.value.servers[0]) throw new Error("fixture config");
const server = parsed.value.servers[0], limits = DEFAULT_MCP_LIMITS, scope = digest("owner");
const schema = { type: "object" as const, properties: {
  description: { type: "string", description: "说明", title: "标题" },
  value: { type: "object", const: { description: "业务数据", title: "业务标题" } },
}, required: ["description"] };
const tool = { name: "lookup", description: "工具描述", inputSchema: schema };
const catalog = (tools = [tool]) => makeCatalog(server, scope, tools, limits).revision;

describe("MCP 单工具契约身份与历史算法", () => {
  it("无关工具和所有层级展示文字变化不改变身份", () => {
    const first = catalog();
    const changed = { ...tool, description: "新描述", inputSchema: { ...schema, title: "根标题",
      properties: { ...schema.properties, description: { type: "string", description: "新说明", title: "新标题" } } } };
    const second = catalog([changed, { ...tool, name: "other" }]);
    expect(first.digest).not.toBe(second.digest);
    expect(toolNames(first, tool).nativeName).toBe(toolNames(second, changed).nativeName);
  });

  it("保留同名业务属性以及常量数据的契约含义", () => {
    const first = catalog();
    for (const inputSchema of [
      { ...schema, properties: { ...schema.properties, description: { type: "integer" } } },
      { ...schema, properties: { ...schema.properties, value: { type: "object", const: { description: "不同数据", title: "业务标题" } } } },
      { ...schema, required: ["description", "value"] },
    ]) {
      expect(toolContract(first, { ...tool, inputSchema })).not.toBe(toolContract(first, tool));
    }
    expect(toolContract({ ...first, configDigest: digest("other-account") }, tool)).not.toBe(toolContract(first, tool));
    expect(toolContract({ ...first, scopeDigest: digest("other-owner") }, tool)).not.toBe(toolContract(first, tool));
    expect(toolContract(first, { ...tool, outputSchema: { type: "object" } })).not.toBe(toolContract(first, tool));
  });

  it("只恢复 v2 目录，v1 目录被拒绝", () => {
    const current = catalog(), { digest: _ignored, ...payload } = current;
    expect(restoreCatalog(current, limits)).toEqual(current);
    const legacy = { ...payload, adapterVersion: 1 };
    expect(() => restoreCatalog({ ...legacy, digest: digest(legacy) }, limits)).toThrow();
  });

  it("嵌套组合、引用、数组和依赖中的展示注解不参与身份", () => {
    const input = { type: "object" as const, definitions: { item: { type: "string", title: "旧" } },
      properties: { items: { type: "array", items: { $ref: "#/definitions/item", description: "旧" } } },
      dependencies: { items: { properties: { description: { type: "string", title: "旧" } } } },
      allOf: [{ title: "旧", additionalProperties: { type: "string", description: "旧" } }] };
    const changed = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(input).replaceAll('"旧"', '"新"')));
    const revision = catalog();
    expect(toolContract(revision, { ...tool, inputSchema: input })).toBe(toolContract(revision, { ...tool, inputSchema: changed }));
  });
});
