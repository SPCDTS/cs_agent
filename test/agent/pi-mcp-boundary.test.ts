import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MCP_LIMITS, loadMcpConfig, parseMcpConfig } from "../../src/agent/pi-mcp/config.js";
import { compileMcpSchema } from "../../src/agent/pi-mcp/schema.js";
import { convertMcpResult } from "../../src/agent/pi-mcp/result.js";

const limits = { ...DEFAULT_MCP_LIMITS };
function stdio() {
  return {
    id: "files", transport: { kind: "stdio", command: "D:/tools/server.exe", cwd: "${sessionWorkspace}", args: ["--root", "${sessionWorkspace}"], execution: "trusted-host" },
    credential: { kind: "none" }, tools: { allow: ["read"] }, access: { kind: "owner-private" }, replay: "unsafe",
  };
}
function http() {
  return { ...stdio(), transport: { kind: "streamable-http", url: "https://example.test/mcp", secretHeaders: { Authorization: "MCP_TOKEN" } } };
}
function config(server: unknown = stdio()) { return { version: 1, enabled: true, servers: [server] }; }
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("Pi MCP 配置边界", () => {
  it("严格解析双传输并补齐默认值，不读取环境秘密", async () => {
    const example = JSON.parse(await readFile("docs/design/pi-mcp/config.example.json", "utf8"));
    expect(parseMcpConfig(example).kind).toBe("enabled");
    const parsed = parseMcpConfig(config(http()));
    expect(parsed.kind).toBe("enabled");
    if (parsed.kind !== "enabled") throw new Error("fixture");
    expect(parsed.value.limits).toEqual(limits);
    expect(parsed.value.servers[0].access).toEqual({ kind: "owner-private", allowScheduled: false, allowWake: false });
    expect(JSON.stringify(parsed)).toContain("MCP_TOKEN");
    expect(JSON.stringify(parsed)).not.toContain("Bearer ");
  });

  it.each([
    { ...config(), oauth: { token: "SECRET_SENTINEL" } },
    config({ ...stdio(), replay: "safe" }),
    config({ ...stdio(), access: { kind: "public" } }),
    config({ ...stdio(), credential: { kind: "oauth" } }),
    { ...config(), servers: [stdio(), stdio()] },
    { ...config(), limits: { callMs: 300_001 } },
    { ...config(), limits: { schemaDepth: 0 } },
    { ...config(), limits: { unknown: 1 } },
    config({ ...stdio(), tools: { allow: ["read", "read"] } }),
    config({ ...stdio(), transport: { ...stdio().transport, command: "npx" } }),
    config({ ...stdio(), transport: { ...stdio().transport, command: "C:server.exe" } }),
    config({ ...stdio(), transport: { ...stdio().transport, command: "\\tools\\server.exe" } }),
    config({ ...stdio(), transport: { ...stdio().transport, cwd: "relative" } }),
    config({ ...stdio(), transport: { ...stdio().transport, args: ["--root=${sessionWorkspace}"] } }),
    config({ ...stdio(), transport: { ...stdio().transport, inheritEnv: ["PATH"], env: { Path: "override" } } }),
    config({ ...stdio(), transport: { ...stdio().transport, secretEnv: { TOKEN: "Bearer SECRET_SENTINEL" } } }),
  ])("拒绝非法配置且错误不包含秘密值 %#", input => {
    const result = parseMcpConfig(input);
    expect(result.kind).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
  });

  it.each([
    { url: "http://example.test/mcp", allowLoopbackHttp: true },
    { url: "http://127.0.0.1/mcp" },
    { url: "https://owner:SECRET_SENTINEL@example.test/mcp" },
    { url: "https://example.test/mcp#fragment" },
    { headers: { Authorization: "Bearer SECRET_SENTINEL" } },
    { headers: { "X-Api-Key": "SECRET_SENTINEL" } },
    { headers: { "X-Goog-Api-Key": "SECRET_SENTINEL" } },
    { headers: { Host: "example.test" } },
    { secretHeaders: { "Mcp-Session-Id": "TOKEN" } },
    { headers: { "X-Value": "one\r\ntwo" } },
    { headers: { "X-Value": "one" }, secretHeaders: { "x-value": "TOKEN" } },
  ])("拒绝不安全 HTTP 配置 %#", transport => {
    const result = parseMcpConfig(config({ ...http(), transport: { ...http().transport, ...transport } }));
    expect(result.kind).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
  });

  it.each(["http://127.0.0.1:4567/mcp", "http://localhost/mcp", "http://[::1]/mcp"])("显式允许 loopback HTTP %s", url => {
    expect(parseMcpConfig(config({ ...http(), transport: { ...http().transport, url, allowLoopbackHttp: true } })).kind).toBe("enabled");
  });

  it.each(["192.168.3.13", "10.0.0.1", "172.16.0.1", "172.31.255.254"])("私网 IPv4 HTTP 必须显式允许：%s", host => {
    const transport = { ...http().transport, url: `http://${host}:3721/mcp` };
    expect(parseMcpConfig(config({ ...http(), transport })).kind).toBe("invalid");
    expect(parseMcpConfig(config({ ...http(), transport: { ...transport, allowPrivateNetworkHttp: true } })).kind).toBe("enabled");
  });

  it.each(["example.test", "8.8.8.8", "169.254.169.254", "172.15.255.255", "172.32.0.1", "192.169.0.1", "127.0.0.1"])("私网 HTTP 开关不放开其他地址：%s", host => {
    expect(parseMcpConfig(config({ ...http(), transport: { ...http().transport,
      url: `http://${host}/mcp`, allowPrivateNetworkHttp: true } })).kind).toBe("invalid");
  });

  it("空白名单保持无工具，未设置与禁用不启动 MCP", async () => {
    expect(parseMcpConfig(config({ ...stdio(), tools: { allow: [] } })).kind).toBe("enabled");
    expect(parseMcpConfig({ ...config(), enabled: false }).kind).toBe("disabled");
    expect((await loadMcpConfig()).kind).toBe("disabled");
  });

  it("读取 UTF-8/BOM JSON；损坏、无效编码、超限与缺失文件安全降级", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-boundary-")); directories.push(dir);
    const file = join(dir, "配置.json");
    await writeFile(file, "\ufeff" + JSON.stringify(config()), "utf8");
    expect((await loadMcpConfig(file)).kind).toBe("enabled");
    for (const bytes of [Buffer.from("SECRET_SENTINEL"), Buffer.from([0xff]), Buffer.alloc(1_048_577, 32)]) {
      await writeFile(file, bytes);
      const result = await loadMcpConfig(file);
      expect(result.kind).toBe("invalid");
      expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    }
    expect((await loadMcpConfig(join(dir, "missing"))).kind).toBe("invalid");
  });
});

describe("Pi MCP schema 边界", () => {
  it("普通 draft-07 schema 在真实 Pi 校验路径工作，并复核修复后的参数", () => {
    const compiled = compileMcpSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 4 } }, required: ["count"], additionalProperties: false }, limits);
    expect(compiled.check({ count: "2" })).toBe(false);
    const args = validateToolArguments({ name: "test", description: "边界测试", parameters: compiled.schema }, { type: "toolCall", id: "call-1", name: "test", arguments: { count: "2" } });
    expect(args).toEqual({ count: 2 });
    expect(compiled.check(args)).toBe(true);
    expect(compiled.check({ count: 0 })).toBe(false);
    expect(compiled.check({ count: 2, extra: 1 })).toBe(false);
  });

  it("支持局部引用、JSON Pointer 转义与并列复用", () => {
    const compiled = compileMcpSchema({ type: "object", definitions: { "a/b~c": { type: "string", pattern: "^ok$" } }, properties: { a: { $ref: "#/definitions/a~1b~0c" }, b: { $ref: "#/definitions/a~1b~0c" } }, required: ["a", "b"] }, limits);
    expect(compiled.check({ a: "ok", b: "ok" })).toBe(true);
    expect(compiled.check({ a: "ok", b: "bad" })).toBe(false);
    const pointers = compileMcpSchema({ type: "object", definitions: { "中文 name": { allOf: [{ type: "integer", minimum: 2 }] } }, properties: { n: { $ref: "#/definitions/%E4%B8%AD%E6%96%87%20name/allOf/0" } } }, limits);
    expect(pointers.check({ n: 2 })).toBe(true);
    expect(pointers.check({ n: 1 })).toBe(false);
  });

  it("保留组合、tuple、条件、依赖、唯一值、格式及 Unicode 长度约束", () => {
    const compiled = compileMcpSchema({ type: "object", properties: {
      choice: { oneOf: [{ const: 1 }, { type: "string", minLength: 2, format: "email" }] },
      tuple: { type: "array", items: [{ type: "integer" }, { type: "boolean" }], additionalItems: false, minItems: 2 },
      values: { type: "array", items: { type: "integer" }, uniqueItems: true, contains: { const: 2 } },
      unicode: { type: "string", minLength: 2 },
    }, dependencies: { choice: ["tuple"] }, if: { required: ["values"] }, then: { required: ["unicode"] } }, limits);
    const valid = { choice: 1, tuple: [2, true], values: [2, 3], unicode: "中文" };
    expect(compiled.check(valid)).toBe(true);
    for (const invalid of [{ choice: 1 }, { ...valid, choice: "invalid" }, { ...valid, tuple: [2, true, 3] }, { ...valid, values: [2, 2] }, { ...valid, unicode: "😀" }]) expect(compiled.check(invalid)).toBe(false);
  });

  it.each([
    true, { type: "array" },
    { type: "object", properties: { x: { $ref: "https://SECRET_SENTINEL/schema" } } },
    { type: "object", properties: { x: { $ref: "#/missing" } } },
    { type: "object", properties: { x: { $ref: "#" } } },
    { type: "object", definitions: { A: { $ref: "#/definitions/B" }, B: { $ref: "#/definitions/A" } } },
    { type: "object", $schema: "https://json-schema.org/draft/2020-12/schema" },
    { type: "object", unevaluatedProperties: false },
    { type: "object", properties: { x: { type: "string", format: "SECRET_SENTINEL" } } },
    { type: "object", properties: { x: { type: "string", pattern: "[" } } },
    { type: "object", definitions: { A: { type: "integer" } }, properties: { x: { $ref: "#/definitions/A", minimum: 2 } } },
    { type: "object", properties: { x: { minLength: -1 } } },
  ])("拒绝不支持或无效 schema，错误不回显原始数据 %#", schema => {
    expect(() => compileMcpSchema(schema, limits)).toThrow(/^MCP schema/u);
    try { compileMcpSchema(schema, limits); } catch (error) { expect(String(error)).not.toContain("SECRET_SENTINEL"); }
  });

  it("限制原始大小、语义深度和 JSON 特性，不执行访问器", () => {
    expect(() => compileMcpSchema({ type: "object", description: "文".repeat(limits.schemaBytes) }, limits)).toThrow();
    expect(() => compileMcpSchema({ type: "object", properties: { x: { type: "string" } } }, { ...limits, schemaDepth: 1 })).toThrow();
    let reads = 0;
    expect(() => compileMcpSchema({ type: "object", get description() { reads++; return "SECRET_SENTINEL"; } }, limits)).toThrow();
    expect(reads).toBe(0);
    expect(parseMcpConfig({ get version() { throw new Error("SECRET_SENTINEL"); } }).kind).toBe("invalid");
    const schema: { type: string; properties?: unknown } = { type: "object" }; schema.properties = { x: schema };
    expect(() => compileMcpSchema(schema, limits)).toThrow();
    const compiled = compileMcpSchema({ type: "object" }, limits);
    expect(compiled.check({ x: Infinity })).toBe(false);
    expect(compiled.check({ x: undefined })).toBe(false);
  });
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
function image(data = png, mimeType = "image/png") { return { type: "image", data, mimeType }; }
function textOf(result: ReturnType<typeof convertMcpResult>) { return result.output?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? ""; }

describe("Pi MCP 结果边界", () => {
  it("保留远端错误，成功结构化结果同时提供模型文本", () => {
    const schema = compileMcpSchema({ type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false }, limits);
    const success = convertMcpResult({ content: [{ type: "text", text: "完成" }], structuredContent: { count: 2 } }, schema, limits);
    expect(success.isError).not.toBe(true);
    expect(success.structuredOutput).toEqual({ count: 2 });
    expect(textOf(success)).toContain('"count":2');
    const error = convertMcpResult({ content: [{ type: "text", text: "失败" }], isError: true }, schema, limits);
    expect(error.isError).toBe(true);
    expect(textOf(error)).toBe("失败");
    expect(error.diagnostics?.some(item => item.code === "remote_error")).toBe(true);
  });

  it("无 outputSchema 时结构化内容只成为文本，超限 JSON 整体拒绝", () => {
    const result = convertMcpResult({ structuredContent: { value: "中文" } }, undefined, limits);
    expect(result.structuredOutput).toBeUndefined();
    expect(textOf(result)).toContain("中文");
    expect(convertMcpResult({ structuredContent: { value: "文".repeat(100) } }, undefined, { ...limits, structuredBytes: 100 }).isError).toBe(true);
  });

  it("schema 不符或缺失时拒绝响应并提示可能已经执行", () => {
    const schema = compileMcpSchema({ type: "object", properties: { count: { type: "integer" } }, required: ["count"] }, limits);
    for (const raw of [{ content: [] }, { structuredContent: { count: "2" } }]) {
      const result = convertMcpResult(raw, schema, limits);
      expect(result.isError).toBe(true);
      expect(result.structuredOutput).toBeUndefined();
      expect(textOf(result)).toContain("可能已完成");
    }
  });

  it("文本以 UTF-8 总预算截断且明确保留原始字节数", () => {
    const result = convertMcpResult({ content: [{ type: "text", text: "中文😀".repeat(100) }, { type: "text", text: "尾部" }] }, undefined, { ...limits, textBytes: 100 });
    const text = textOf(result);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(100);
    expect(text).not.toContain("�");
    expect(text).toContain("已截断");
    expect(result.diagnostics?.some(item => item.code === "text_truncated")).toBe(true);
  });

  it("合法 PNG 映射图片；超张数、单张和总解码预算明确省略", () => {
    const result = convertMcpResult({ content: [image(), image(), image()] }, undefined, limits);
    expect(result.output?.filter(item => item.type === "image")).toHaveLength(2);
    expect(textOf(result)).toContain("图片张数");
    for (const options of [{ ...limits, imageBytes: 1 }, { ...limits, contentBytes: 1 }, { ...limits, images: 0 }]) {
      const omitted = convertMcpResult({ content: [image()] }, undefined, options);
      expect(omitted.output?.some(item => item.type === "image")).toBe(false);
      expect(textOf(omitted)).toContain("省略");
    }
  });

  it("拒绝伪装 MIME、非规范 base64 和异常尺寸图片", () => {
    const huge = Buffer.from(png, "base64"); huge.writeUInt32BE(100_000, 16);
    for (const content of [image(png, "image/jpeg"), image(png, "image/svg+xml"), image(huge.toString("base64")), image(Buffer.from("not an image").toString("base64"))]) {
      const result = convertMcpResult({ content: [content] }, undefined, limits);
      expect(result.output?.some(item => item.type === "image")).toBe(false);
      expect(textOf(result)).toContain("省略");
    }
    const whitespace = convertMcpResult({ content: [image(png + "\n")] }, undefined, limits);
    expect(whitespace.output?.some(item => item.type === "image")).toBe(false);
    expect(textOf(whitespace)).toContain("省略");
    expect(convertMcpResult({ content: [image("====")] }, undefined, limits).isError).toBe(true);
  });

  it("资源文本注明来源，链接只展示元信息，音频与二进制明确降级", () => {
    const result = convertMcpResult({ content: [
      { type: "resource", resource: { uri: "file:///source", text: "资料" } },
      { type: "resource_link", uri: "https://example.test/data", name: "说明", mimeType: "text/plain" },
      { type: "audio", data: Buffer.from("SECRET_SENTINEL").toString("base64"), mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///blob", blob: Buffer.from("SECRET_SENTINEL").toString("base64") } },
    ] }, undefined, limits);
    expect(textOf(result)).toContain("file:///source");
    expect(textOf(result)).toContain("未访问");
    expect(textOf(result)).toContain("未转写");
    expect(textOf(result)).not.toContain("SECRET_SENTINEL");
    expect(textOf(result)).not.toContain(Buffer.from("SECRET_SENTINEL").toString("base64"));
  });

  it("原始响应超限、非 JSON 与非法内容只返回有界错误", () => {
    let reads = 0;
    const cyclic: { x?: unknown } = {}; cyclic.x = cyclic;
    for (const raw of [cyclic, { content: [{ type: "unknown", text: "SECRET_SENTINEL" }] }, { get content() { reads++; throw new Error("SECRET_SENTINEL"); } }, { content: [{ type: "text", text: "SECRET_SENTINEL".repeat(100) }] }]) {
      const result = convertMcpResult(raw, undefined, { ...limits, messageBytes: 100 });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    }
    expect(reads).toBe(0);
    expect(Buffer.byteLength(textOf(convertMcpResult({ bad: true }, undefined, { ...limits, textBytes: 7 })), "utf8")).toBeLessThanOrEqual(7);
  });
});
