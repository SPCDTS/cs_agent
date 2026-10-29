import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedFetch } from "../src/mcp/transport-http";

afterEach(() => vi.restoreAllMocks());
const endpoint = new URL("https://mcp.example.test/mcp");
describe("MCP HTTP boundaries", () => {
  it.each(["POST", "GET", "DELETE"])("injects fresh Bearer and retries %s 401 at most once without SDK auth", async method => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const header = new Headers(init?.headers).get("authorization");
      return header === "Bearer old-synthetic" ? new Response(null, { status: 401 }) : Response.json({ ok: true });
    });
    const rejected = vi.fn(async () => "new-synthetic"), authRequired = vi.fn(async (): Promise<never> => { throw new Error("auth_required"); });
    const send = boundedFetch(endpoint, 1000, () => {}, { accessToken: async () => "old-synthetic", rejected, authRequired });
    expect((await send(endpoint.href, { method, ...(method === "POST" ? { body: "original-body" } : {}) })).status).toBe(200);
    expect(rejected).toHaveBeenCalledTimes(1); expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map(call => call[1]?.body)).toEqual([method === "POST" ? "original-body" : undefined, method === "POST" ? "original-body" : undefined]);
    spy.mockClear(); spy.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(send(endpoint.href, { method })).rejects.toThrow("auth_required");
    expect(spy).toHaveBeenCalledTimes(2); expect(authRequired).toHaveBeenCalledTimes(1);
  });
  it("rejects cross-origin and redirected requests and strips Cookie", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 302, headers: { Location: endpoint.href } }));
    const send = boundedFetch(endpoint, 1000, () => {});
    await expect(send("https://other.example.test/mcp")).rejects.toThrow("来源变化");
    expect(spy).not.toHaveBeenCalled();
    await expect(send(endpoint.href, { headers: { Cookie: "synthetic" } })).rejects.toThrow("重定向");
    expect(new Headers(spy.mock.calls[0][1]?.headers).has("cookie")).toBe(false);
    expect(spy.mock.calls[0][1]?.redirect).toBe("manual");
  });
  it("bounds JSON bytes and individual SSE events, allowing later small events", async () => {
    const fail = vi.fn();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("x".repeat(33), { headers: { "content-type": "application/json" } }));
    const send = boundedFetch(endpoint, 32, fail);
    await expect((await send(endpoint.href)).text()).rejects.toThrow("超出限额");
    expect(fail).toHaveBeenCalledTimes(1);
    spy.mockImplementation(async () => new Response("data: 1\r\n\r\ndata: 2\n\ndata: 3\r\r", { headers: { "content-type": "text/event-stream" } }));
    expect(await (await send(endpoint.href)).text()).toContain("data: 3");
    spy.mockImplementation(async () => new Response("data: " + "x".repeat(32) + "\n\n", { headers: { "content-type": "text/event-stream" } }));
    await expect((await send(endpoint.href)).text()).rejects.toThrow("超出限额");
  });
});
