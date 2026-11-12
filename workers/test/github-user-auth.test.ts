import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAppClient, type GitHubAppSecrets } from "../src/github/app";
const secrets: GitHubAppSecrets = { GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "events-test", GITHUB_APP_PRIVATE_KEY: "test-only-placeholder", GITHUB_APP_WEBHOOK_SECRET: "test-only",
  GITHUB_APP_CLIENT_ID: "test-client", GITHUB_APP_CLIENT_SECRET: "test-client-secret", GITHUB_APP_CALLBACK_URL: "https://agent.example.com/admin/github/oauth/callback" };
afterEach(() => vi.unstubAllGlobals());
const userToken = { access_token: "user-test-token", token_type: "bearer", expires_in: 28800, refresh_token: "unused-test-refresh" };
const installation = { id: 456, app_id: 123, suspended_at: null };
function mock(values: unknown[]) { const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(values.shift()))); vi.stubGlobal("fetch", fn); return fn; }
describe("GitHub App user authorization contract", () => {
  it("constructs a separate user OAuth URL without exposing secrets", () => {
    const url = new URL(new GitHubAppClient(secrets).authorizationUrl("opaque-state"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client"); expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("redirect_uri")).toBe(secrets.GITHUB_APP_CALLBACK_URL); expect(url.href).not.toContain("test-client-secret");
    expect(() => new GitHubAppClient({ ...secrets, GITHUB_APP_CALLBACK_URL: "https://evil.test/other" }).authorizationUrl("state")).toThrow("unconfigured");
  });
  it("exchanges code only server-side and verifies the user installation before discarding tokens", async () => {
    const fetcher = mock([userToken, { total_count: 1, installations: [installation] }]);
    const result = await new GitHubAppClient(secrets).authorizeInstallation("test-code", 456); expect(result).toBeUndefined();
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user/installations?per_page=100&page=1"]);
    const exchange = fetcher.mock.calls[0][1]!; expect(exchange.method).toBe("POST"); expect(exchange.redirect).toBe("error");
    const form = exchange.body as URLSearchParams; expect(form.get("code")).toBe("test-code"); expect(form.get("client_secret")).toBe("test-client-secret");
    expect((fetcher.mock.calls[1][1]!.headers as Record<string, string>).Authorization).toBe("Bearer user-test-token");
  });
  it.each([[], [{ ...installation, id: 999 }], [{ ...installation, app_id: 999 }], [{ ...installation, suspended_at: "2026-01-01" }]].map(installations => ({ installations })))("rejects forged, inaccessible, cross-App and suspended installation %j", async ({ installations }) => {
    const fetcher = mock([userToken, { total_count: installations.length, installations }]);
    await expect(new GitHubAppClient(secrets).authorizeInstallation("test-code", 456)).rejects.toThrow("unauthorized"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects code exchange denial without leaking upstream descriptions", async () => {
    const fetcher = mock([{ error: "bad_verification_code", error_description: "private-diagnostic" }]);
    await expect(new GitHubAppClient(secrets).authorizeInstallation("test-code", 456)).rejects.toThrow(/^github_app_unauthorized$/); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("checks bounded pagination instead of trusting setup ID or Link headers", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ ...installation, id: i + 1 }));
    const fetcher = mock([userToken, { total_count: 101, installations: first }, { total_count: 101, installations: [installation] }]);
    await new GitHubAppClient(secrets).authorizeInstallation("test-code", 456);
    expect(fetcher.mock.calls[2][0]).toBe("https://api.github.com/user/installations?per_page=100&page=2");
    mock([userToken, { total_count: 1001, installations: [] }]);
    await expect(new GitHubAppClient(secrets).authorizeInstallation("test-code", 456)).rejects.toThrow("capacity");
  });
});
