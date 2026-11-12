import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAppClient, type GitHubAppSecrets } from "../src/github/app";
const secrets: GitHubAppSecrets = { GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "events-test", GITHUB_APP_PRIVATE_KEY: "test-only-placeholder", GITHUB_APP_WEBHOOK_SECRET: "test-only",
  GITHUB_APP_CLIENT_ID: "test-client", GITHUB_APP_CLIENT_SECRET: "test-client-secret", GITHUB_APP_CALLBACK_URL: "https://agent.example.com/admin/github/oauth/callback" };
afterEach(() => vi.unstubAllGlobals());
const verifier = "v".repeat(43), challenge = "c".repeat(43);
const user = { id: 7, login: "owner", email: "private@example.test" };
const userToken = { access_token: "user-test-token", token_type: "bearer", expires_in: 28800, refresh_token: "unused-test-refresh" };
const installation = { id: 456, app_id: 123, suspended_at: null };
function mock(values: unknown[]) { const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(values.shift()))); vi.stubGlobal("fetch", fn); return fn; }
describe("GitHub App user authorization contract", () => {
  it("constructs distinct client-ID OAuth URL with S256 PKCE and fixed query-free redirect", () => {
    const url = new URL(new GitHubAppClient(secrets).authorizationUrl("opaque-state", challenge));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client"); expect(url.searchParams.get("client_id")).not.toBe(secrets.GITHUB_APP_ID);
    expect(url.searchParams.get("state")).toBe("opaque-state"); expect(url.searchParams.get("code_challenge_method")).toBe("S256"); expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("redirect_uri")).toBe(secrets.GITHUB_APP_CALLBACK_URL); expect(url.href).not.toContain("test-client-secret"); expect(url.href).not.toContain(verifier);
    expect(() => new GitHubAppClient({ ...secrets, GITHUB_APP_CALLBACK_URL: secrets.GITHUB_APP_CALLBACK_URL + "?extra=x" }).authorizationUrl("state", challenge)).toThrow("unconfigured");
    expect(() => new GitHubAppClient(secrets).authorizationUrl("state", "short")).toThrow("unauthorized");
  });
  it("exchanges with server verifier, reads user identity and user-scoped repositories, and strips tokens", async () => {
    const fetcher = mock([userToken, user, { total_count: 1, installations: [installation] }, { total_count: 1, repositories: [{ id: 42, full_name: "owner/repo", private: true }] }]);
    const result = await new GitHubAppClient(secrets).authorizeInstallation("test-code", 456, verifier);
    expect(result).toMatchObject({ user: { id: 7, login: "owner" }, repositories: [{ id: 42, name: "owner/repo" }] }); expect(result.expiresAt).toBeGreaterThan(Date.now());
    for (const secret of ["user-test-token", "unused-test-refresh", "private@example.test"]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user", "https://api.github.com/user/installations?per_page=100&page=1", "https://api.github.com/user/installations/456/repositories?per_page=100&page=1"]);
    const exchange = fetcher.mock.calls[0][1]!; expect(exchange.method).toBe("POST"); expect(exchange.redirect).toBe("error");
    const form = exchange.body as URLSearchParams; expect(form.get("code")).toBe("test-code"); expect(form.get("code_verifier")).toBe(verifier); expect(form.get("client_secret")).toBe("test-client-secret");
    expect((fetcher.mock.calls[3][1]!.headers as Record<string, string>).Authorization).toBe("Bearer user-test-token");
  });
  it.each([[], [{ ...installation, id: 999 }], [{ ...installation, app_id: 999 }], [{ ...installation, suspended_at: "2026-01-01" }]].map(installations => ({ installations })))("rejects forged/inaccessible/cross-App/suspended installation %j", async ({ installations }) => {
    const fetcher = mock([userToken, user, { total_count: installations.length, installations }]);
    await expect(new GitHubAppClient(secrets).authorizeInstallation("test-code", 456, verifier)).rejects.toThrow("unauthorized"); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("rejects code/PKCE denial without diagnostics and rejects missing verifier before network", async () => {
    const fetcher = mock([{ error: "bad_verification_code", error_description: "private-diagnostic" }]);
    await expect(new GitHubAppClient(secrets).authorizeInstallation("test-code", 456, verifier)).rejects.toThrow(/^github_app_unauthorized$/); expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(new GitHubAppClient(secrets).authorizeInstallation("test-code", 456, "")).rejects.toThrow("unauthorized"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds user installation and repository pagination independently", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ ...installation, id: i + 1 }));
    const repos = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: "owner/repo" + i }));
    const fetcher = mock([userToken, user, { total_count: 101, installations: first }, { total_count: 101, installations: [installation] },
      { total_count: 101, repositories: repos }, { total_count: 101, repositories: [{ id: 101, full_name: "owner/last" }] }]);
    expect((await new GitHubAppClient(secrets).authorizeInstallation("test-code", 456, verifier)).repositories).toHaveLength(101);
    expect(fetcher.mock.calls[3][0]).toBe("https://api.github.com/user/installations?per_page=100&page=2");
    expect(fetcher.mock.calls[5][0]).toBe("https://api.github.com/user/installations/456/repositories?per_page=100&page=2");
    mock([userToken, user, { total_count: 1001, installations: [] }]);
    await expect(new GitHubAppClient(secrets).authorizeInstallation("test-code", 456, verifier)).rejects.toThrow("capacity");
    mock([userToken, user, { total_count: 1, installations: [installation] }, { total_count: 1001, repositories: [] }]);
    await expect(new GitHubAppClient(secrets).authorizeInstallation("test-code", 456, verifier)).rejects.toThrow("capacity");
  });
  it("preserves an empty user repository scope even when the installation is accessible", async () => {
    mock([userToken, user, { total_count: 1, installations: [installation] }, { total_count: 0, repositories: [] }]);
    expect((await new GitHubAppClient(secrets).authorizeInstallation("test-code", 456, verifier)).repositories).toEqual([]);
  });
});
