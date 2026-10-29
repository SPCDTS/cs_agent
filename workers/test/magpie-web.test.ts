import { env, SELF, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";

afterEach(async () => { await reset(); });

// 测试配置没有 containers，MagpieContainer 拿不到 ctx.container，代表“容器起不来”。
describe("magpie Web UI host", () => {
  it("hands every path on MAGPIE_WEB_HOST to the container and hides its failure", async () => {
    for (const path of ["/", "/api/providers?x=1", "/healthz"]) {
      const response = await SELF.fetch(`https://${env.MAGPIE_WEB_HOST}${path}`, { method: path === "/" ? "GET" : "POST", body: path === "/" ? undefined : "{}" });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("magpie unavailable");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  it("leaves the agent host untouched", async () => {
    const health = await SELF.fetch("https://agent.spcdts.dev/healthz");
    expect(await health.json()).toMatchObject({ model: { provider: "faux", id: "test" } });
    expect(health.headers.get("X-Robots-Tag")).toBeNull();
    expect((await SELF.fetch("https://agent.spcdts.dev/")).status).toBe(404);
  });

  it("intercepts nothing when MAGPIE_WEB_HOST is empty", async () => {
    const off = { ...env, MAGPIE_WEB_HOST: "" };
    const missing = await worker.fetch(new Request("https://magpie.spcdts.dev/"), off);
    expect([missing.status, await missing.text()]).toEqual([404, "not found"]);
    const health = await worker.fetch(new Request("https://magpie.spcdts.dev/healthz"), off);
    expect(await health.json()).toMatchObject({ model: { provider: "faux" } });
  });
});
