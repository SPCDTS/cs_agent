import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_PAGE_HTML } from "../src/admin/app.generated.ts";
import { bundleModule, mountDom } from "./browser-harness.mjs";

test("请求详情页展示未内联的 searchTools 脚本工具定义，支持筛选、搜索与展开 Schema", async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: "synthetic-admin" });
  const requestUi = await bundleModule("browser/request-detail.ts");
  const reqId = "11111111-2222-3333-4444-555555555555";
  const summary = { digest: "a".repeat(64), total: 3, inlined: 1, hidden: 2 };

  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url === `/admin/requests/${reqId}?summary=1` && method === "GET") {
      return Response.json({
        detailAvailable: true,
        bodyDeferred: true,
        responseAvailable: false,
        request: {
          id: reqId,
          thread: "owner",
          actor: "thread",
          purpose: "conversation",
          startedAt: 1790000000000,
          endedAt: 1790000001000,
          provider: "faux",
          model: "test-model",
          status: "done",
          inputTokens: 1200,
          outputTokens: 80,
          cacheRead: 600,
          cacheWrite: 0,
          durationMs: 1000,
          contextWindow: 128000,
          contextMetrics: {
            version: 1,
            chars: { system: 4000, tools: 800, summary: 0, user: 20, assistant: 0, result: 0 },
            messageCount: 1,
            toolCount: 2,
            imageCount: 0,
            codemode: summary,
          },
        },
        context: {
          system: { text: "", chars: 4000, truncated: false },
          messages: [],
          tools: [],
          messageCount: 1,
          toolCount: 2,
          omittedMessages: 0,
          truncated: false,
          chars: { system: 4000, messages: 20, tools: 800 },
        },
      });
    }
    if (url === `/admin/requests/${reqId}/context` && method === "GET") {
      return Response.json({
        current: {
          id: reqId,
          startedAt: 1790000000000,
          provider: "faux",
          model: "test-model",
          inputTokens: 1200,
          cacheRead: 600,
          contextWindow: 128000,
          status: "done",
          metrics: {
            version: 1,
            chars: { system: 4000, tools: 800, summary: 0, user: 20, assistant: 0, result: 0 },
            messageCount: 1,
            toolCount: 2,
            imageCount: 0,
            codemode: summary,
          },
        },
        previous: null,
        analysis: {
          metrics: {
            version: 1,
            chars: { system: 4000, tools: 800, summary: 0, user: 20, assistant: 0, result: 0 },
            messageCount: 1,
            toolCount: 2,
            imageCount: 0,
            codemode: summary,
          },
          items: [
            { id: "system", key: "system:1", category: "system", chars: 4000, label: "系统提示", images: 0, bodyAvailable: true, truncated: false },
            { id: "tool:0", key: "tool:0", category: "tools", chars: 800, label: "codemode", images: 0, bodyAvailable: true, truncated: false },
          ],
        },
        comparison: null,
      });
    }
    if (url === `/admin/requests/${reqId}/codemode` && method === "GET") {
      return Response.json({
        summary,
        catalogAvailable: true,
        truncated: false,
        namespaces: [{ name: "github", description: "GitHub MCP", total: 2, inlined: 0 }],
        tools: [
          {
            name: "read",
            jsName: "read",
            inlined: true,
            chars: 120,
            truncated: false,
            description: "读取沙箱文件",
            declaration: "declare const tools: { read(args: { path: string; }): Promise<{ content: string; }>; };",
            inputSchema: JSON.stringify({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }, null, 2),
          },
          {
            name: "mcp_github_search_issues",
            jsName: "mcp_github_search_issues",
            namespace: "github",
            inlined: false,
            chars: 480,
            truncated: false,
            description: "搜索 GitHub 仓库 Issue",
            declaration: "declare const tools: { mcp_github_search_issues(args: { q: string; }): Promise<unknown>; };",
            inputSchema: JSON.stringify({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }, null, 2),
          },
          {
            name: "mcp_github_create_pr",
            jsName: "mcp_github_create_pr",
            namespace: "github",
            inlined: false,
            chars: 520,
            truncated: false,
            description: "创建 Pull Request",
            declaration: "declare const tools: { mcp_github_create_pr(args: { title: string; }): Promise<{ number: number; }>; };",
            inputSchema: JSON.stringify({ type: "object", properties: { title: { type: "string" } }, required: ["title"] }, null, 2),
            outputSchema: JSON.stringify({ type: "object", properties: { number: { type: "number" } } }, null, 2),
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  await requestUi.openRequest(reqId);
  await page.settle();

  const body = page.document.getElementById("detail-body");
  assert.match(body.textContent, /另有 2 个脚本工具因超出 <codemode> 内联预算未进入上下文/);
  const tabBtn = [...body.querySelectorAll(".context-tab")].find(b => b.textContent.includes("脚本工具 (2 未内联)"));
  assert.ok(tabBtn);

  const jumpBtn = [...body.querySelectorAll(".codemode-callout button")].find(b => b.textContent === "查看脚本工具定义");
  assert.ok(jumpBtn);
  await page.click(jumpBtn);

  // 默认自动筛选「仅 searchTools」工具，直接呈现未进上下文的 2 个工具
  const rows = () => [...body.querySelectorAll("details.codemode-tool")];
  assert.equal(rows().length, 2);
  assert.deepEqual(rows().map(r => r.getAttribute("data-codemode-tool")), [
    "mcp_github_search_issues",
    "mcp_github_create_pr",
  ]);

  // 展开查看 TypeScript 声明与 JSON Schema
  rows()[1].open = true;
  rows()[1].dispatchEvent(new page.window.Event("toggle"));
  assert.match(rows()[1].textContent, /declare const tools: \{ mcp_github_create_pr/);
  assert.match(rows()[1].textContent, /参数 JSON Schema/);
  assert.match(rows()[1].textContent, /返回结构 JSON Schema/);

  // 切换到「全部」后共展示 3 个工具
  const allBtn = [...body.querySelectorAll(".codemode-filter-btn")].find(b => b.textContent.startsWith("全部"));
  await page.click(allBtn);
  assert.equal(rows().length, 3);

  // 搜索框过滤
  const search = body.querySelector("input.codemode-search");
  search.value = "issue";
  search.dispatchEvent(new page.window.Event("input"));
  assert.deepEqual(rows().map(r => r.getAttribute("data-codemode-tool")), ["mcp_github_search_issues"]);
});

test("MCP 服务管理面板支持展开已探测工具的签名与参数 Schema，不影响工具勾选激活", async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: "synthetic-admin" });
  const mcpUi = await bundleModule("browser/mcp-servers.ts");

  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url === "/admin/mcp/servers" && method === "GET") {
      return Response.json({
        servers: [
          {
            server: {
              id: "github",
              enabled: true,
              transport: { kind: "streamable-http", url: "https://mcp.example.com/github", headers: {} },
              credential: { kind: "none" },
              resourceAllow: [],
              access: { revision: "rev-a" },
              tools: { allow: ["issue_get"], readOnly: ["issue_get"] },
            },
            revision: "rev-1",
            credentialSet: false,
            discovered: [
              {
                name: "issue_get",
                description: "读取单条 Issue",
                declaration: "declare const tools: { issue_get(args: { number: number; }): Promise<unknown>; };",
                inputSchema: JSON.stringify({ type: "object", properties: { number: { type: "integer" } }, required: ["number"] }, null, 2),
              },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  await mcpUi.loadMcpServers("github");
  const toolsList = page.document.getElementById("mcp-server-tools");
  assert.match(toolsList.textContent, /issue_get/);
  const details = toolsList.querySelector("details.message-block");
  assert.ok(details);
  details.open = true;
  details.dispatchEvent(new page.window.Event("toggle"));
  assert.match(details.textContent, /declare const tools: \{ issue_get/);
  assert.match(details.textContent, /number/);
  const toolCheck = toolsList.querySelector('input[data-tool="issue_get"]');
  assert.equal(toolCheck.checked, true);
});
