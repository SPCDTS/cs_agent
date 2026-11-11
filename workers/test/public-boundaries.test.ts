import { env, reset } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { RegistryDO } from "../src/registry";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const adminEnv = { ...env, ADMIN_TOKEN: "test-admin" };

it("公开存活探针不读取绑定，详情需要管理员认证并分别报告各组件", async () => {
  const noBindings = new Proxy(env, { get() { throw new Error("公开探针不应读取绑定"); } });
  const probe = await worker.fetch(new Request("https://test/healthz"), noBindings);
  expect(probe.status).toBe(200);
  expect(await probe.json()).toEqual({ ok: true });
  expect(probe.headers.get("cache-control")).toBe("no-store");

  expect((await worker.fetch(new Request("https://test/admin/health"), adminEnv)).status).toBe(401);
  vi.spyOn(RegistryDO.prototype, "modelStatus").mockResolvedValue({ unavailable: "model_unavailable" });
  const detail = await worker.fetch(new Request("https://test/admin/health", { headers: { Authorization: "Bearer test-admin" } }), adminEnv);
  expect(detail.status).toBe(200);
  expect(detail.headers.get("cache-control")).toBe("no-store");
  expect(await detail.json()).toMatchObject({ overall: "degraded", components: { worker: "ready", bridge: "degraded", model: "unavailable" } });
});

it("没有配对票据时先拒绝请求，不解析 OAuth 正文", async () => {
  for (const action of ["begin", "complete"]) {
    const request = new Request("https://test/admin/model/oauth/codex/bridge/" + action, { method: "POST", body: "{" });
    const response = await worker.fetch(request, adminEnv);
    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
  }
});

it("按实际流字节拒绝超大配对正文，且不消费可用票据", async () => {
  const start = await worker.fetch(new Request("https://test/admin/model/oauth/codex/start", {
    method: "POST", headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" }, body: "{}",
  }), adminEnv);
  const { ticket } = await start.json<{ ticket: string }>();
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64_000)); controller.enqueue(new Uint8Array(2000)); },
    cancel: cancelled,
  });
  const headers = { Authorization: "Bearer " + ticket, "Content-Type": "application/json" };
  const rejected = await worker.fetch(new Request("https://test/admin/model/oauth/codex/bridge/begin", {
    method: "POST", headers: { ...headers, "Content-Length": "1" }, body: stream,
  }), adminEnv);
  expect(rejected.status).toBe(413);
  expect(await rejected.json()).toEqual({ error: "request_too_large" });
  expect(cancelled).toHaveBeenCalled();

  const accepted = await worker.fetch(new Request("https://test/admin/model/oauth/codex/bridge/begin", {
    method: "POST", headers, body: JSON.stringify({ port: 1455 }),
  }), adminEnv);
  expect(accepted.status).toBe(200);
});

it("正文未超限时仍拒绝过长 token 字段", async () => {
  const response = await worker.fetch(new Request("https://test/admin/model/oauth/codex/bridge/complete", {
    method: "POST", headers: { Authorization: "Bearer " + "a".repeat(43), "Content-Type": "application/json" },
    body: JSON.stringify({ callbackUrl: "http://localhost:1455/auth/callback", tokens: {
      access_token: "a".repeat(16385), refresh_token: "refresh", token_type: "Bearer", expires_in: 3600,
    } }),
  }), adminEnv);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});
