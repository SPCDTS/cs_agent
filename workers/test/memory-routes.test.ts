import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createMemoryAdminRoutes } from "../src/admin/memory-routes";
import type { AdminContext } from "../src/admin/routes";

const context = (path: string, params: Record<string, string> = {}): AdminContext => {
  const request = new Request("https://test" + path);
  return { env, request, url: new URL(request.url), params };
};
describe("memory admin route boundaries", () => {
  it("supports private namespaces and returns expected HTTP codes after RPC erases Error prototypes", async () => {
    for (const [code, status] of [["not_found", 404], ["conflict", 409], ["invalid", 400]] as const) {
      const routes = createMemoryAdminRoutes(() => { throw new Error(`memory_admin:${code}`); });
      const list = routes.find(r => r.path === "/admin/memory/list")!;
      const response = await list.handle(context("/admin/memory/list?ns=private:10000003"));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    }
  });
  it("rejects invalid namespaces and malformed cursor/page values before a Thread RPC", async () => {
    let called = 0;
    const routes = createMemoryAdminRoutes(() => { called++; throw new Error("should_not_call"); });
    const list = routes.find(r => r.path === "/admin/memory/list")!;
    for (const path of ["/admin/memory/list?ns=../owner", "/admin/memory/list?ns=owner&cursor=-1", "/admin/memory/list?ns=owner&limit=101", "/admin/memory/list?ns=owner&kind=invalid"]) {
      const response = await list.handle(context(path));
      expect(response.status).toBe(400);
    }
    expect(called).toBe(0);
  });
});
