import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { RegistryDO } from "../src/registry";
import { createOAuthFetch } from "../src/mcp/oauth-fetch";
import { TokenVault, sha256 } from "../src/mcp/crypto";
import { ACCESS, REFRESH, TEST_STORE_KEY, issuer, callback, fakeRemote, adminEnv, adminRequest, beginLogin, login } from "./mcp-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const registry = () => env.REGISTRY.getByName("main");
async function expire() {
  await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_oauth_tokens SET expires_at=?", Date.now() - 1); });
}

describe("Registry OAuth CIMD", () => {
  it("serves its own client metadata with the PUBLIC_ORIGIN callback and public cache", async () => {
    const origin = "https://alternate.example.test";
    const response = await worker.fetch(new Request(`${origin}/oauth/client-metadata.json`), { ...env, PUBLIC_ORIGIN: origin });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({ client_id: `${origin}/oauth/client-metadata.json`, client_name: "cs-agent", client_uri: origin,
      redirect_uris: [`${origin}/mcp/oauth/callback`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    expect((await worker.fetch(new Request(`${origin}/mcp/oauth/callback`), env)).status).toBe(400);
  });
  it("requires an admin Bearer, rejects query/NapCat auth and reports unconfigured without a key", async () => {
    for (const token of ["", "t", "wrong"]) expect((await worker.fetch(adminRequest(token), adminEnv())).status).toBe(401);
    expect((await worker.fetch(adminRequest(), { ...env, ADMIN_TOKEN: undefined })).status).toBe(401);
    expect((await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}/admin/mcp/oauth/login-link?access_token=synthetic-admin`, { method: "POST" }), adminEnv())).status).toBe(401);
    expect((await worker.fetch(adminRequest("synthetic-admin", { server: "notion", extra: true }), adminEnv())).status).toBe(400);
    const status = await runInDurableObject(registry(), async (_instance, state) => {
      const instance = new RegistryDO(state, { ...env, OAUTH_STORE_KEY: undefined });
      expect(await instance.accessToken("notion")).toBeUndefined();
      await expect(instance.loginLink("notion")).rejects.toThrow("unconfigured");
      return instance.status();
    });
    expect(status[0].login).toBe("unconfigured");
  });
  it("runs login-link → one-time start → PKCE callback → accessToken and stores only ciphertext", async () => {
    const remote = fakeRemote(), started = await beginLogin(), auth = started.authorization;
    expect(auth.origin).toBe(issuer);
    expect(auth.searchParams.get("client_id")).toBe(`${env.PUBLIC_ORIGIN}/oauth/client-metadata.json`);
    expect(auth.searchParams.get("redirect_uri")).toBe(callback);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await worker.fetch(new Request(started.link), env)).status).toBe(400);
    const request = new Request(`${callback}?state=${auth.searchParams.get("state")}&code=synthetic-code`);
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200); expect(await response.text()).toBe("已登录 notion");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await worker.fetch(request, env)).status).toBe(400);
    expect(await registry().accessToken("notion")).toBe(ACCESS);
    expect((await registry().status())[0]).toMatchObject({ server: "notion", credential: "oauth", login: "ok" });
    const tokenRequest = remote.requests.find(r => r.url.endsWith("/token"));
    const verifier = new URLSearchParams(tokenRequest?.body).get("code_verifier");
    expect(verifier).toHaveLength(43);
    expect((await sha256(verifier ?? "")).toString("base64url")).toBe(auth.searchParams.get("code_challenge"));
    const stored = await runInDurableObject(registry(), (_instance, state) => ({ tokens: state.storage.sql.exec("SELECT * FROM mcp_oauth_tokens").toArray(),
      logins: state.storage.sql.exec("SELECT * FROM mcp_oauth_logins").toArray(), clients: state.storage.sql.exec("SELECT * FROM mcp_oauth_client").toArray() }));
    expect(stored.tokens[0]).toMatchObject({ access_token: expect.stringMatching(/^v1\./), refresh_token: expect.stringMatching(/^v1\./) });
    for (const secret of [ACCESS, REFRESH, "synthetic-code", verifier ?? "unreachable"]) expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.logins).toHaveLength(0);
    expect(remote.requests.every(r => r.redirect === "manual" && !r.headers.has("cookie"))).toBe(true);
    const healthy = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}/healthz`), env);
    expect(await healthy.json()).toMatchObject({ mcp: expect.arrayContaining([expect.objectContaining({ server: "notion", enabled: true, credential: "oauth", login: "ok", tools: expect.any(Number) })]) });
  });
  it("expires links and states after ten minutes and consumes failed callbacks without exposing code", async () => {
    fakeRemote(); const link = await registry().loginLink("notion");
    await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_oauth_logins SET expires_at=0"); });
    expect((await worker.fetch(new Request(link.url), env)).status).toBe(400);
    const started = await beginLogin();
    const denied = await worker.fetch(new Request(`${callback}?state=${started.authorization.searchParams.get("state")}&error=private-error&code=private-code`), env);
    expect(await denied.text()).toBe("invalid_state");
    expect((await worker.fetch(new Request(`${callback}?state=${started.authorization.searchParams.get("state")}&code=private-code`), env)).status).toBe(400);
    const late = await beginLogin();
    await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE mcp_oauth_logins SET expires_at=0"); });
    expect((await worker.fetch(new Request(`${callback}?state=${late.authorization.searchParams.get("state")}&code=private-code`), env)).status).toBe(400);
  });
  it("single-flights refresh, retains rotated refresh when omitted, and deletes invalid_grant tokens", async () => {
    const remote = fakeRemote(); await login(); await expire();
    expect(await Promise.all(Array.from({ length: 6 }, () => registry().accessToken("notion")))).toEqual(Array(6).fill(`${ACCESS}-refreshed`));
    expect(remote.state.refreshes).toBe(1);
    await expire(); remote.state.tokenStatus = 400;
    await expect((async () => await registry().accessToken("notion"))()).rejects.toThrow("auth_required");
    expect(remote.requests.filter(r => r.url.endsWith("/token")).at(-1)?.body).toContain(`refresh_token=${REFRESH}`);
    const rows = await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("SELECT * FROM mcp_oauth_tokens").toArray());
    expect(rows).toHaveLength(0); expect((await registry().status())[0].login).toBe("error");
  });
  it("keeps tokens on temporary refresh failures, survives reconstruction and logs out locally", async () => {
    const remote = fakeRemote(); await login(); await expire(); remote.state.tokenStatus = 503;
    await expect((async () => await registry().accessToken("notion"))()).rejects.toThrow("oauth_network");
    expect((await registry().status())[0].login).toBe("ok");
    remote.state.tokenStatus = 200;
    const token = await runInDurableObject(registry(), async (_instance, state) => new RegistryDO(state, { ...env, OAUTH_STORE_KEY: TEST_STORE_KEY }).accessToken("notion"));
    expect(token).toBe(`${ACCESS}-refreshed`);
    await registry().logout("notion");
    expect((await registry().status())[0].login).toBe("needed");
    await expect((async () => await registry().accessToken("notion"))()).rejects.toThrow("auth_required");
  });
  it("refuses absent CIMD support and third-party token endpoints before sending credentials", async () => {
    const remote = fakeRemote(); remote.state.cimd = false;
    const first = await registry().loginLink("notion");
    expect((await worker.fetch(new Request(first.url), env)).status).toBe(400);
    remote.state.cimd = true; remote.state.tokenEndpoint = "https://third-party.example.test/token";
    const second = await registry().loginLink("notion");
    expect((await worker.fetch(new Request(second.url), env)).status).toBe(400);
    expect(remote.requests.some(r => r.url.includes("third-party") || r.url.endsWith("/register"))).toBe(false);
  });
  it("uses randomized AES-GCM with authenticated identity and rejects tampered ciphertext", async () => {
    const vault = new TokenVault(TEST_STORE_KEY);
    const [one, two] = await Promise.all([vault.encrypt("synthetic", "account1"), vault.encrypt("synthetic", "account1")]);
    expect(one).not.toBe(two); expect(await vault.decrypt(one, "account1")).toBe("synthetic");
    await expect(vault.decrypt(one, "account2")).rejects.toThrow("oauth_token");
    await expect(vault.decrypt(one.slice(0, -4) + "AAAA", "account1")).rejects.toThrow("oauth_token");
  });
});

describe("bounded OAuth fetch", () => {
  it("enforces HTTPS, allowed origins, manual redirects, no cookies and the streamed 256 KiB limit", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const bounded = createOAuthFetch(() => [issuer]);
    await expect(bounded("http://auth.example.test/token")).rejects.toThrow("oauth_network");
    await expect(bounded("https://elsewhere.example.test/token")).rejects.toThrow("oauth_network");
    expect(spy).not.toHaveBeenCalled();
    await bounded(`${issuer}/token`, { headers: { Cookie: "synthetic-cookie" } });
    expect(new Headers(spy.mock.calls[0][1]?.headers).has("cookie")).toBe(false);
    spy.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: `${issuer}/other` } }));
    await expect(bounded(`${issuer}/token`)).rejects.toThrow("oauth_network");
    spy.mockResolvedValueOnce(new Response("x".repeat(262145)));
    await expect(bounded(`${issuer}/token`)).rejects.toThrow("oauth_network");
  });
  it("times out even when a fetch implementation ignores AbortSignal", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const result = expect(createOAuthFetch(() => [issuer])(`${issuer}/token`)).rejects.toThrow("oauth_network");
      await vi.advanceTimersByTimeAsync(5001); await result;
    } finally { vi.useRealTimers(); }
  });
});
