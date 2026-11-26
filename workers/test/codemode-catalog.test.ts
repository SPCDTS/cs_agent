import { Type } from "typebox";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { describe, expect, it } from "vitest";
import { captureCodemodeCatalog, inlineCodemodeHeadings } from "../src/requests/codemode-catalog";

describe("codemode catalog capture", () => {
  const noop = async () => ({ output: [{ type: "text" as const, text: "ok" }] });

  it("extracts exact inline headings from <codemode> prompt block", () => {
    const system = [
      "<rules>\nrule\n</rules>",
      "<codemode>",
      "Tools scripts can call (`await tools.<name>(args)`):",
      "Some tools are not listed: find them with `searchTools()`.",
      "### `read`",
      "Read file.",
      "### `mcp_github_issue_get` (`mcp-github:issue.get`)",
      "Get issue.",
      "</codemode>",
    ].join("\n");
    const headings = inlineCodemodeHeadings(system);
    expect([...headings]).toEqual([
      "### `read`",
      "### `mcp_github_issue_get` (`mcp-github:issue.get`)",
    ]);
  });

  it("distinguishes inlined vs searchTools-only tools, preserves namespaces, and redacts secrets before truncation", () => {
    const readTool = defineTool({
      name: "read",
      description: "读取沙箱文件",
      parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
      structuredOutputSchema: Type.Object({ content: Type.String(), truncated: Type.Boolean() }),
      callers: ["tools"],
      execute: noop,
    }) as ToolRegistration;

    const hiddenMcpTool = defineTool({
      name: "mcp-github:issue_search",
      description: "通过关键词搜索 Issue（超预算仅 searchTools 可见）",
      parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1 })) }),
      callers: ["tools"],
      execute: noop,
    }) as ToolRegistration;

    const secretTool = defineTool({
      name: "secret_probe",
      description: "Authorization: Bearer super-secret-credential-" + "x".repeat(3000),
      parameters: Type.Object({ token: Type.String({ default: "sk-live-1234567890abcdefghijklmnop" }) }),
      callers: ["tools"],
      deferred: true,
      execute: noop,
    }) as ToolRegistration;

    const internalTool = defineTool({
      name: "__pi_codemode_classify",
      description: "internal",
      parameters: Type.Object({}),
      callers: ["tools"],
      execute: noop,
    }) as ToolRegistration;

    const extensions: Extension[] = [
      defineExtension({ name: "coding", tools: [readTool, secretTool, internalTool] }),
      defineExtension({
        name: "mcp.github",
        namespace: { name: "github", description: "GitHub MCP 服务", instructions: "Authorization: Bearer hidden-ns-token" },
        tools: [hiddenMcpTool],
      }),
    ];

    const messages = [
      {
        role: "system" as const,
        content: "<codemode>\nTools scripts can call (`await tools.<name>(args)`):\n\n### `read`\n读取沙箱文件\n</codemode>",
        toolsAdded: [{ name: CODEMODE_TOOL_NAME, description: "codemode", parameters: Type.Object({ code: Type.String() }) }],
        timestamp: 1,
      },
      { role: "user" as const, content: "hi", timestamp: 2 },
    ];

    const captured = captureCodemodeCatalog(
      { callable: [readTool, hiddenMcpTool, secretTool, internalTool], extensions },
      messages,
    );
    expect(captured).toBeDefined();
    expect(captured!.summary).toEqual({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      total: 3,
      inlined: 1,
      hidden: 2,
    });
    expect(captured!.namespaces).toEqual([
      {
        name: "github",
        description: "GitHub MCP 服务",
        instructions: "[含凭据的内容已隐藏]",
        total: 1,
        inlined: 0,
      },
    ]);

    const byName = new Map(captured!.tools.map(t => [t.name, t]));
    expect(byName.get("read")).toMatchObject({
      jsName: "read",
      inlined: true,
      outputSchema: expect.stringContaining('"content"'),
    });
    expect(byName.get("read")!.declaration).toContain("declare const tools: { read(args:");
    expect(byName.get("mcp-github:issue_search")).toMatchObject({
      jsName: "mcp_github_issue_search",
      namespace: "github",
      inlined: false,
    });
    expect(byName.get("secret_probe")).toMatchObject({
      inlined: false,
      deferred: true,
      description: "[含凭据的内容已隐藏]",
      inputSchema: "[含凭据的内容已隐藏]",
    });
    expect(JSON.stringify(captured)).not.toContain("super-secret-credential");
    expect(JSON.stringify(captured)).not.toContain("sk-live-");
    expect(JSON.stringify(captured)).not.toContain("hidden-ns-token");

    // 未向模型提供 codemode 工具时不采集脚本目录
    const withoutCodemode = captureCodemodeCatalog(
      { callable: [readTool], extensions },
      [{ role: "user", content: "hi", timestamp: 2 }],
    );
    expect(withoutCodemode).toBeUndefined();
  });
});
