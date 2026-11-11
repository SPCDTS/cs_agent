import { env, reset } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { modelEgressDiagnostics } from "../src/model-egress";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it("requires admin authentication and probes fixed public targets from the owner DO without credentials", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers);
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual");
    expect(headers.has("Authorization")).toBe(false); expect(headers.has("Cookie")).toBe(false);
    if (url.includes("ipify")) return Response.json({ ip: "192.0.2.8", secret: "must-not-return" });
    if (url.includes("auth.openai")) return new Response("sensitive upstream error", { status: 403 });
    return new Response("ip=2a06:98c0:3600::103\nloc=GB\ncolo=LHR\nsecret=must-not-return\n", { headers: { "cf-ray": "example-LHR" } });
  });
  const call = (token: string) => worker.fetch(new Request("https://test/admin/diagnostics/model-egress", {
    method: "POST", headers: { Authorization: "Bearer " + token },
  }), { ...env, ADMIN_TOKEN: "synthetic-admin" });
  expect((await call("wrong")).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  const response = await call("synthetic-admin"), result = await response.json<Awaited<ReturnType<typeof modelEgressDiagnostics>>>();
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(result.executionContext).toBe("ThreadDO/owner"); expect(result.authenticatedOpenAIRequest).toBe(false);
  expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
    "https://api.openai.com/cdn-cgi/trace", "https://auth.openai.com/cdn-cgi/trace",
    "https://www.cloudflare.com/cdn-cgi/trace", "https://api.ipify.org?format=json",
  ].sort());
  expect(result.probes).toEqual(expect.arrayContaining([
    expect.objectContaining({ target: "openai-api", sharedWorkerAddress: true, country: "GB", colo: "LHR" }),
    expect.objectContaining({ target: "openai-auth", status: 403 }),
    expect.objectContaining({ target: "ipify", ip: "192.0.2.8" }),
  ]));
  expect(JSON.stringify(result)).not.toMatch(/must-not-return|sensitive upstream error/);
});

it("bounds diagnostic response bodies", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("x".repeat(9000)));
  const result = await modelEgressDiagnostics();
  expect(result.probes).toHaveLength(4);
  expect(result.probes.every(probe => "error" in probe && probe.error === "body_limit")).toBe(true);
});
