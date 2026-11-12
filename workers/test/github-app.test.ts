import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { GitHubAppClient, type GitHubAppSecrets } from "../src/github/app";
let secrets: GitHubAppSecrets; let publicKey: CryptoKey;
beforeAll(async () => { const pair = await generateKeyPair("RS256", { extractable: true }); publicKey = pair.publicKey; secrets = {
  GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "test-events", GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey), GITHUB_APP_WEBHOOK_SECRET: "test-only",
}; });
afterEach(() => vi.unstubAllGlobals());
function mock(responses: unknown[]) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
const token = () => ({ token: "installation-test-token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
describe("operator GitHub App API boundary", () => {
  it("signs a short RS256 JWT and returns only actual authorized IDs and names", async () => {
    const fetcher = mock([{ id: 456, app_id: 123, suspended_at: null }, token(), { total_count: 1, repositories: [{ id: 7, full_name: "owner/repo", private: true }] }]);
    expect(await new GitHubAppClient(secrets).repositories(456)).toEqual([{ id: 7, name: "owner/repo" }]);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(c => c[0])).toEqual(["https://api.github.com/app/installations/456", "https://api.github.com/app/installations/456/access_tokens", "https://api.github.com/installation/repositories?per_page=100&page=1"]);
    expect(calls[1][1].method).toBe("POST"); expect(calls.every(c => c[1].redirect === "error")).toBe(true);
    const authorization = (calls[0][1].headers as Record<string, string>).Authorization;
    const verified = await jwtVerify(authorization.slice(7), publicKey);
    expect(verified.payload.iss).toBe("123"); expect(verified.payload.exp! - verified.payload.iat!).toBe(600);
    expect((calls[2][1].headers as Record<string, string>).Authorization).toBe("Bearer installation-test-token");
  });
  it.each([{ id: 999, app_id: 123, suspended_at: null }, { id: 456, app_id: 999, suspended_at: null }, { id: 456, app_id: 123, suspended_at: "2026-01-01" }])("rejects forged/cross-App/suspended installation %j", async installation => {
    const fetcher = mock([installation]); await expect(new GitHubAppClient(secrets).repositories(456)).rejects.toThrow("github_app_unauthorized"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("accepts an empty authorization list without restoring defaults", async () => {
    mock([{ id: 456, app_id: 123, suspended_at: null }, token(), { total_count: 0, repositories: [] }]);
    expect(await new GitHubAppClient(secrets).repositories(456)).toEqual([]);
  });
  it("rejects expired token before repository lookup", async () => {
    const fetcher = mock([{ id: 456, app_id: 123, suspended_at: null }, { token: "expired", expires_at: "2000-01-01" }]);
    await expect(new GitHubAppClient(secrets).repositories(456)).rejects.toThrow("github_app_unavailable"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds authorized repository enumeration", async () => {
    mock([{ id: 456, app_id: 123, suspended_at: null }, token(), { total_count: 1001, repositories: [] }]);
    await expect(new GitHubAppClient(secrets).repositories(456)).rejects.toThrow("github_app_capacity");
  });
  it("does not leak upstream errors or cache authorization across failures", async () => {
    const fetcher = vi.fn(async () => new Response("private upstream diagnostic", { status: 403 })); vi.stubGlobal("fetch", fetcher);
    const client = new GitHubAppClient(secrets); await expect(client.repositories(456)).rejects.toThrow(/^github_app_unauthorized$/); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("paginates only fixed API paths, rejects an inconsistent snapshot, and revalidates installation authority before using a short-lived cached token", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: "owner/repo" + i }));
    const fetcher = mock([{ id: 456, app_id: 123, suspended_at: null }, token(), { total_count: 101, repositories: first }, { total_count: 101, repositories: [{ id: 101, full_name: "owner/last" }] }]);
    const api = new GitHubAppClient(secrets); expect(await api.repositories(456)).toHaveLength(101);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][]; expect(calls[3][0]).toBe("https://api.github.com/installation/repositories?per_page=100&page=2");
    const next = mock([{ id: 456, app_id: 123, suspended_at: null }, { total_count: 101, repositories: first }, { total_count: 102, repositories: [{ id: 101, full_name: "owner/last" }] }]);
    await expect(api.repositories(456)).rejects.toThrow("github_app_unavailable"); expect(next).toHaveBeenCalledTimes(3);
  });
  it("bounds response bytes and does not expose response contents", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sensitive".repeat(150_000))));
    await expect(new GitHubAppClient(secrets).repositories(456)).rejects.toThrow(/^github_app_capacity$/);
  });
  it("uses only fixed GitHub installation URL and fails closed without configuration", () => {
    const url = new URL(new GitHubAppClient(secrets).installationUrl("opaque-state")); expect(url.origin).toBe("https://github.com"); expect(url.pathname).toBe("/apps/test-events/installations/new"); expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(() => new GitHubAppClient({}).installationUrl("state")).toThrow("github_app_unconfigured");
  });
});
