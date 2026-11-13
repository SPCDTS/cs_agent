import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { snapshot } from "../src/requests/snapshot";
import { argumentPreview, toolResultSnapshot } from "../src/requests/tool-snapshot";
import type { RequestDetail, ToolTrace } from "../src/requests/types";
import worker from "../src/index";

afterEach(() => reset());

it("历史 CodeMode 结果关联完整调用树并隔离 actor，执行正文不计入上下文", async () => {
  const store = env.REQUESTS.getByName("main"), now = Date.now(), binding = { turnId: "turn:tree", inputId: "web:test", generation: 0 };
  const source: RequestDetail = { request: { id: crypto.randomUUID(), thread: "owner", actor: "thread", purpose: "conversation", binding,
    provider: "test", model: "test", contextWindow: 1000, status: "done", startedAt: now - 100, endedAt: now - 90, durationMs: 10,
    inputTokens: 10, outputTokens: 10, cacheRead: 0, cacheWrite: null, reasoningTokens: null, toolCalls: [{ id: "same-call", name: "codemode" }] }, context: snapshot({ messages: [] }) };
  await store.record(source);
  const root: ToolTrace = { id: crypto.randomUUID(), thread: "owner", actor: "thread", binding, callId: "same-call", name: "codemode", startedAt: now - 80, endedAt: now - 20, status: "done", arguments: { text: "{}", chars: 2, truncated: false }, result: { text: "五字的输出", chars: 5, truncated: false } };
  const child: ToolTrace = { ...root, id: crypto.randomUUID(), callId: "child", parentCallId: root.callId, name: "read", result: { text: "原始长结果".repeat(100), chars: 500, truncated: false } };
  const grandchild: ToolTrace = { ...child, id: crypto.randomUUID(), callId: "grandchild", parentCallId: child.callId, name: "mcp_lookup", status: "error" };
  await store.recordTool(root); await store.recordTool(child); await store.recordTool(grandchild);
  const foreign: ToolTrace = { ...root, id: crypto.randomUUID(), actor: crypto.randomUUID(), binding: { ...binding, turnId: "turn:other-agent" }, startedAt: now - 10, name: "foreign" };
  await store.recordTool(foreign);
  const context = snapshot({ messages: [{ role: "toolResult", toolName: "codemode", toolCallId: root.callId, content: [{ type: "text", text: "五字的输出" }], isError: false, timestamp: now - 15 }] });
  const current: RequestDetail = { request: { ...source.request, id: crypto.randomUUID(), startedAt: now, endedAt: now + 10, toolCalls: [], contextMetrics: context.analysis?.metrics }, context };
  await store.record(current);
  expect((await store.detail(source.request.id))?.tools.map(tool => tool.id).sort()).toEqual([root.id, child.id, grandchild.id].sort());
  const result = await store.contextInspection(current.request.id);
  expect(result?.analysis?.metrics.chars.result).toBe(5);
  expect(result?.analysis?.items.find(item => item.category === "result")?.execution).toMatchObject({ id: root.id, calls: 2, failures: 1, label: "read · mcp_lookup" });
  expect(JSON.stringify(result)).not.toContain("原始长结果");
  const execution = await store.toolExecution(root.id);
  expect(execution?.sourceRequestId).toBe(source.request.id);
  expect(execution?.tools).toHaveLength(3);
  await runInDurableObject(store, (_instance, state) => state.storage.sql.exec("UPDATE tool_traces SET payload=NULL,bytes=0"));
  expect((await store.toolExecution(root.id))?.tools.every(tool => tool.detailAvailable === false)).toBe(true);
  expect((await store.toolDetail(root.id))?.result).toBeUndefined();
  expect((await worker.fetch(new Request("https://test/admin/tools/" + root.id + "/execution"), { ...env, ADMIN_TOKEN: "test" })).status).toBe(401);
});

it("结构化结果保留可读字段，凭据与图片正文隐藏，大小仍受原有截断限制", () => {
  const captured = toolResultSnapshot({ structuredOutput: { count: 3, image: { type: "image", data: "private-base64", mimeType: "image/png" }, value: "内容" } });
  expect(captured.structuredResult?.text).toContain('"count": 3');
  expect(captured.structuredResult?.text).not.toContain("private-base64");
  expect(toolResultSnapshot({ structuredOutput: { token: "private-token" } }).structuredResult?.text).toContain("已隐藏");
  expect(toolResultSnapshot({ structuredOutput: { content: "长".repeat(20000) } }).structuredResult?.truncated).toBe(true);
  expect(argumentPreview({ command: "curl -H 'Authorization: Bearer private-token'" })).toBe("含凭据的参数已隐藏");
});
