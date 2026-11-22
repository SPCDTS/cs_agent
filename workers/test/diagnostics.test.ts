import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { classifyError, logDiag, type DiagRecord } from "../src/shared/diagnostics";
import { safeError } from "../src/mcp/connection";
import { createSubagentCapabilityHost } from "../src/mcp/delegated";
import { modelEgressDiagnostics } from "../src/models";

const TOKEN = "test-admin-only";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe("诊断分类与环形日志缓冲", () => {
  it("提取安全错误分类并排除自由文本与潜在凭据", () => {
    const timeout = new DOMException("operation timed out", "TimeoutError");
    expect(classifyError(timeout)).toEqual({ errorName: "TimeoutError", code: "timeout" });

    const coded = Object.assign(new Error("device_cloudflare_rate_limited"), { status: 429 });
    expect(classifyError(coded)).toEqual({ errorName: "Error", code: "device_cloudflare_rate_limited", status: 429 });

    const sensitive = new Error("Bearer sk-proj-1234567890abcdefghijklmnop failed with raw payload");
    const info = classifyError(sensitive);
    expect(info).toEqual({ errorName: "Error" });
    expect(JSON.stringify(info)).not.toContain("sk-proj");
  });

  it("双写至 RequestsDO 环形表、支持按条件查询并维持 1000 条容量上限", async () => {
    const store = env.REQUESTS.getByName("main");
    for (let i = 1; i <= 1005; i++) {
      await store.recordDiag({
        at: 1000 + i,
        level: i % 2 === 0 ? "warn" : "error",
        event: i === 1005 ? "mcp_refresh_failed" : "synthetic_tick",
        thread: i === 1005 ? "owner" : "group:200000001",
        turnId: i === 1005 ? "turn:msg:1005" : undefined,
        code: i === 1005 ? "timeout" : "ok",
      });
    }
    const all = await store.queryLogs({ limit: 200 });
    expect(all.logs[0]).toMatchObject({ seq: 1005, event: "mcp_refresh_failed", thread: "owner", code: "timeout" });
    const oldest = await store.queryLogs({ before: 20, limit: 20 });
    expect(oldest.logs.every(row => (row.seq ?? 0) >= 6)).toBe(true);

    logDiag(env, undefined, {
      event: "admin_projection_failed",
      thread: "owner",
      error: new DOMException("slow", "TimeoutError"),
      detail: { secret: "Bearer sk-secret-token-value-1234567890", retries: 2 },
    });
    await expect.poll(async () => (await store.queryLogs({ event: "admin_projection_failed", limit: 5 })).logs.length).toBe(1);
    const res = await worker.fetch(new Request("https://test/admin/logs?thread=owner&level=error&limit=5", {
      headers: { Authorization: "Bearer " + TOKEN },
    }), { ...env, ADMIN_TOKEN: TOKEN });
    expect(res.status).toBe(200);
    const body = await res.json<{ logs: DiagRecord[] }>();
    expect(body.logs.map(l => l.event)).toEqual(["admin_projection_failed", "mcp_refresh_failed"]);
    expect(JSON.stringify(body)).not.toContain("sk-secret-token");
  });

  it("Worker tail 仅捕获非 ok 平台终态并写入环形日志", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    await worker.tail?.([
      { outcome: "ok", exceptions: [], logs: [], eventTimestamp: 2000, scriptName: "cs-agent", event: null } as unknown as TraceItem,
      { outcome: "exceededCpu", exceptions: [{ name: "Error", message: "sensitive", timestamp: 2001 }], logs: [], eventTimestamp: 2001, scriptName: "cs-agent", scriptVersion: { id: "v-test" }, event: null } as unknown as TraceItem,
    ], env, ctx);
    await Promise.all(pending);
    const { logs } = await env.REQUESTS.getByName("main").queryLogs({ event: "platform_invocation_failed" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ code: "exceededCpu", errorName: "Error", detail: { scriptVersion: "v-test" } });
    expect(JSON.stringify(logs[0])).not.toContain("sensitive");
  });

  it("细分 MCP 超时、委托 RPC 故障与出口探针超时，不再笼统归为协议错误或权限拒绝", async () => {
    expect(safeError(new DOMException("aborted", "TimeoutError")).code).toBe("timeout");
    expect(safeError({ code: -32001, message: "MCP request timed out" }).code).toBe("timeout");

    const delegated = createSubagentCapabilityHost({
      subagentMcp: async () => { throw new DOMException("parent slow", "TimeoutError"); },
      subagentSkill: async () => { throw new Error("denied"); },
    });
    const timedOut = await delegated.subagentMcp("sub-1", { name: "t", args: {}, operationId: "1" });
    expect(timedOut.output?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("timeout：MCP 调用未成功") });
    const denied = await delegated.subagentSkill("sub-1", { name: "s" });
    expect(denied.output?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("denied：MCP 调用未成功") });

    const egress = await modelEgressDiagnostics(async () => { throw new DOMException("probe timed out", "TimeoutError"); });
    expect(egress.probes.every(p => p.error === "timeout")).toBe(true);
  });
});
