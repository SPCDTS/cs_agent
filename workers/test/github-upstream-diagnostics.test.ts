import { afterEach, expect, it, vi } from "vitest";
import { GitHubAppClient, GitHubAppError, type UpstreamReason } from "../src/github/app";
import { diagnoseConnect } from "../src/github/connect-diagnostics";

const sensitive = "synthetic-private-marker";
const client = () => new GitHubAppClient({
  GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "test", GITHUB_APP_PRIVATE_KEY: sensitive,
  GITHUB_APP_WEBHOOK_SECRET: sensitive, GITHUB_APP_CLIENT_ID: sensitive, GITHUB_APP_CLIENT_SECRET: sensitive,
  GITHUB_APP_CALLBACK_URL: "https://test/admin/github/oauth/callback",
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function diagnose() {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await diagnoseConnect(crypto.randomUUID(), "complete", async mark => {
    mark("token_exchange"); return client().exchange(sensitive, "v".repeat(43));
  });
  expect(JSON.stringify([result, log.mock.calls])).not.toContain(sensitive);
  return { result, entry: log.mock.calls[0]?.[0] as Record<string, unknown> };
}
it.each([
  [503, sensitive, "http_error", 502],
  [401, sensitive, "http_error", 400],
  [429, sensitive, "http_error", 429],
  [200, "", "empty_body", 502],
  [204, null, "empty_body", 502],
  [200, sensitive, "invalid_json", 502],
  [200, new Uint8Array([0xff]), "invalid_encoding", 502],
  [200, JSON.stringify({error:"server_error", error_description:sensitive}), "server_error", 502],
  [200, JSON.stringify({error:"temporarily_unavailable", error_description:sensitive}), "temporarily_unavailable", 502],
  [200, "x".repeat(1024 * 1024 + 1), "body_too_large", 429],
] as const)("classifies upstream %s as %s without response contents", async (status, body, reason, wrapper) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {status})));
  const {result, entry} = await diagnose();
  expect(result).toMatchObject({ok:false, status:wrapper});
  expect(entry).toMatchObject({stage:"token_exchange", reason, upstreamStatus:status, status:wrapper});
  expect(Object.keys(entry).sort()).toEqual(["event","requestId","operation","stage","code","status","reason","upstreamStatus"].sort());
  expect(result).not.toHaveProperty("reason");
  expect(result).not.toHaveProperty("upstreamStatus");
});
it("separates network rejection from timeout without trusting error names or messages", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error(sensitive), {name:"TimeoutError"}); }));
  const {entry} = await diagnose();
  expect(entry.reason).toBe("network");
  expect(entry).not.toHaveProperty("upstreamStatus");
});
it.each([false,true])("reports deadline expiry (headers received: %s)", async received => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    if (!received) return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error(sensitive)));
    });
    return new Response(new ReadableStream({
      start(controller) { request.signal.addEventListener("abort", () => controller.error(new Error(sensitive))); },
    }), {status:200});
  }));
  const pending = diagnose();
  await vi.advanceTimersByTimeAsync(10_000);
  const {entry} = await pending;
  expect(entry.reason).toBe("timeout");
  if (received) expect(entry.upstreamStatus).toBe(200);
  else expect(entry).not.toHaveProperty("upstreamStatus");
});
it("retains response status when a body stream fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(sensitive)); },
  }), {status:200})));
  expect((await diagnose()).entry).toMatchObject({reason:"network", upstreamStatus:200});
});
it("keeps the form exchange contract, redirect policy and UTF-8 BOM JSON support", async () => {
  const fetcher = vi.fn(async (request: Request) => {
    expect(request.url).toBe("https://github.com/login/oauth/access_token");
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const headers = request.headers;
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(await request.formData())).toEqual({
      client_id:sensitive, client_secret:sensitive, code:sensitive, code_verifier:"v".repeat(43),
      redirect_uri:"https://test/admin/github/oauth/callback",
    });
    return new Response("\uFEFF" + JSON.stringify({access_token:sensitive, token_type:"bearer"}));
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(client().exchange(sensitive, "v".repeat(43))).resolves.toMatchObject({access:sensitive});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects unallowlisted reason and nonnumeric upstream status even on a local error", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [reason,status] of [[sensitive,200],["network",sensitive],["network",700]] as const) {
    await diagnoseConnect(crypto.randomUUID(), "complete", async () => {
      throw new GitHubAppError("unavailable", reason as UpstreamReason, status as number);
    });
  }
  expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  expect(log.mock.calls[0]?.[0]).not.toHaveProperty("reason");
  for (const [entry] of log.mock.calls) expect(entry).not.toHaveProperty("upstreamStatus");
});

it("classifies request construction failure separately without exposing exception details", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Request", class { constructor() { throw new TypeError(sensitive); } });
  const {result, entry} = await diagnose();
  expect(result).toMatchObject({ok:false, status:502, code:"github_app_unavailable"});
  expect(entry).toMatchObject({stage:"token_exchange", reason:"request_init"});
  expect(entry).not.toHaveProperty("upstreamStatus");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([302, 307])("rejects HTTP %s redirects without making a second request", async status => {
  const fetcher = vi.fn(async (request: Request) => {
    expect(request).toBeInstanceOf(Request);
    expect(request.redirect).toBe("manual");
    return new Response(null, {status, headers:{location:"https://example.invalid/private"}});
  });
  vi.stubGlobal("fetch", fetcher);
  const {result, entry} = await diagnose();
  expect(result).toMatchObject({ok:false, status:502});
  expect(entry).toMatchObject({reason:"http_error", upstreamStatus:status});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
