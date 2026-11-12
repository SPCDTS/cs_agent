import { env, reset } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { Errors } from "typebox/value";
import worker from "../src/index";
import { ADMIN_BROWSER_CONTRACTS as C } from "../src/admin/app.generated";
import { snapshot } from "../src/requests/snapshot";
import type { RequestDetail } from "../src/requests/types";

afterEach(() => reset());
const admin = (path: string, method = "GET", body?: unknown) => worker.fetch(new Request("https://test" + path, {
  method, headers: { Authorization: "Bearer browser-test", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}), { ...env, ADMIN_TOKEN: "browser-test" });

it("浏览器 schema 接受真实管理路由响应，包括空列表和已保存内容", async () => {
  const owner = env.THREAD.getByName("owner"), requests = env.REQUESTS.getByName("main"), now = Date.now();
  await owner.importMemory({ ns: "owner", memories: [{ id: 1, kind: "fact", text: "浏览器契约检查", author: "test" }] });
  await owner.syncAdminView("owner");
  await env.SCHEDULE.getByName("main").create({ name: "契约检查", prompt: "检查", conversation: "owner", rule: { kind: "at", at: now + 3600_000 } }, "qq:10000001");
  expect((await admin("/admin/skills/browser-check", "PUT", { markdown: "---\nname: browser-check\ndescription: 浏览器契约检查\n---\n检查正文" })).status).toBe(200);
  const id = crypto.randomUUID(), toolId = crypto.randomUUID(), binding = { turnId: "turn:browser-check", inputId: "web:browser-check", generation: 0 };
  const detail: RequestDetail = { request: { id, startedAt: now, endedAt: now + 10, thread: "owner", actor: "thread", purpose: "conversation", provider: "faux", model: "test",
    status: "done", inputTokens: 14, outputTokens: 3, cacheRead: 5, cacheWrite: 2, reasoningTokens: 2, durationMs: 10, contextWindow: 1000, binding, toolCalls: [{ id: "call", name: "read" }] },
    context: snapshot({ messages: [{ role: "user", content: "读取文件", timestamp: now }] }) };
  await requests.record(detail);
  await requests.recordTool({ id: toolId, thread: "owner", binding, callId: "call", name: "read", startedAt: now, endedAt: now + 2, status: "done",
    arguments: { text: "{}", chars: 2, truncated: false }, result: { text: "完成", chars: 2, truncated: false } });
  const checks = {
    "/admin/overview": C.Overview, "/admin/settings": C.Settings, "/admin/model": C.ModelView,
    "/admin/schedules": C.Schedules, "/admin/event-sources": C.Sources,
    "/admin/memory?ns=owner": C.MemoryView, "/admin/memory/list?ns=owner": C.MemoryList,
    "/admin/memory/1?ns=owner": C.MemoryDetailSchema, "/admin/memory/jobs?ns=owner": C.MemoryJobsSchema,
    "/admin/memory/proposals?ns=owner": C.MemoryProposalsSchema,
    "/admin/skills": C.Skills, "/admin/skills/browser-check": C.Skill,
    "/admin/persona": C.PersonaSchema, "/admin/grants": C.GrantsSchema, "/admin/ops-settings": C.OpsSchema,
    "/admin/alerts": C.AlertsSchema, "/admin/deliveries": C.DeliveriesSchema, "/admin/mcp/servers": C.McpServersSchema,
    "/admin/threads/owner/chat": C.ChatView, "/admin/threads/owner/history": C.SessionHistorySchema,
    "/admin/threads/owner/subagents": C.Subagents, "/admin/threads/owner/workspace": C.ManifestSchema,
    "/admin/threads/owner/trace?turn=turn:browser-check": C.Trace,
    "/admin/requests": C.RequestPage, "/admin/usage": C.Usage, "/admin/agent-topology": C.AgentTopologySchema,
    ["/admin/requests/" + id + "?summary=1"]: C.RequestDetail,
    ["/admin/requests/" + id + "/context"]: C.ContextInspection,
    ["/admin/requests/" + id + "/context/message:0"]: C.ContextBody,
    "/admin/context-timeline?thread=owner": C.ContextTimeline,
    ["/admin/requests/" + id]: C.RequestDetail, ["/admin/tools/" + toolId]: C.ToolDetail,
  };
  for (const [path, schema] of Object.entries(checks)) {
    const response = await admin(path);
    expect(response.status, path).toBe(200);
    expect([...Errors(schema, await response.json())], path).toEqual([]);
  }
});
