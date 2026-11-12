import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAppClient } from "../src/github/app";
import { GitHubAppConnection } from "../src/github/connection";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const verifier = "a".repeat(64);
function client() {
  const api = new GitHubAppClient({});
  vi.spyOn(api, "authorizationUrl").mockImplementation((state, challenge) => "https://github.com/login/oauth/authorize?state=" + state + "&code_challenge=" + challenge + "&code_challenge_method=S256");
  vi.spyOn(api, "authorizeInstallation").mockResolvedValue({ user: { id: 7, login: "owner" }, repositories: [{ id: 42, name: "owner/repo" }], expiresAt: Date.now() + 600_000 });
  vi.spyOn(api, "repositories").mockResolvedValue([{ id: 42, name: "owner/repo" }]); return api;
}
describe("durable GitHub App state", () => {
  it("keeps fresh S256 verifiers only in server state and consumes them with the state", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), connection = new GitHubAppConnection(ctx.storage, api, () => {});
      const url = new URL(await connection.start("admin", verifier)), state = url.searchParams.get("state")!;
      const stored = ctx.storage.sql.exec<{ code_verifier: string }>("SELECT code_verifier FROM github_app_state").one().code_verifier;
      expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(url.href).not.toContain(stored);
      const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stored))).toString("base64url");
      expect(url.searchParams.get("code_challenge")).toBe(expected); expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const next = new URL(await connection.start("admin", verifier)); expect(next.searchParams.get("code_challenge")).not.toBe(expected);
      await connection.complete(state, "code", 456, "admin", verifier);
      expect(api.authorizeInstallation).toHaveBeenCalledWith("code", 456, stored);
      expect(ctx.storage.sql.exec<{ code_verifier: string }>("SELECT code_verifier FROM github_app_state").toArray().some(row => row.code_verifier === stored)).toBe(false);
      expect(JSON.stringify(connection.snapshot())).not.toContain(stored);
    });
  });
  it("exposes only the repository-ID intersection and never installation-only private repositories", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), connection = new GitHubAppConnection(ctx.storage, api, () => {});
      vi.mocked(api.repositories).mockResolvedValue([{ id: 42, name: "owner/repo" }, { id: 99, name: "org/other-private" }]);
      vi.mocked(api.authorizeInstallation).mockResolvedValue({ user: { id: 7, login: "owner" }, repositories: [{ id: 42, name: "owner/repo" }, { id: 88, name: "owner/not-installed" }], expiresAt: Date.now() + 600_000 });
      const state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      const result = await connection.complete(state, "code", 456, "admin", verifier);
      expect(result.repositories).toEqual([{ id: 42, name: "owner/repo" }]); expect(result.githubUser).toEqual({ id: 7, login: "owner" });
      expect(JSON.stringify(result)).not.toContain("other-private"); expect(connection.authorized(456, 42)).toBe(true); expect(connection.authorized(456, 99)).toBe(false); expect(connection.authorized(999, 42)).toBe(false);
      await expect(connection.sync()).rejects.toThrow("reauthorization_required"); expect(api.repositories).toHaveBeenCalledTimes(1); expect(connection.snapshot().repositories).toEqual([]);
    });
  });
  it("expires a persisted authorization lease and atomically revokes permits rather than refreshing with the App token", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), revoke = vi.fn(), connection = new GitHubAppConnection(ctx.storage, api, revoke);
      const state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      const current = await connection.complete(state, "code", 456, "admin", verifier);
      ctx.storage.sql.exec("UPDATE github_app_connection SET value=? WHERE id=1", JSON.stringify({ ...current, authorizedUntil: Date.now() - 1 }));
      const recovered = new GitHubAppConnection(ctx.storage, api, revoke);
      expect(recovered.authorized(456, 42)).toBe(false); expect(recovered.snapshot()).toMatchObject({ status: "revoked", repositories: [], userVerified: false });
      expect(revoke).toHaveBeenCalledTimes(2); expect(api.authorizeInstallation).toHaveBeenCalledTimes(1);
    });
  });
  it("revokes the matching GitHub user, invalidates pending states, and cannot recover through App-only sync", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), connection = new GitHubAppConnection(ctx.storage, api, () => {});
      const state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      await connection.complete(state, "code", 456, "admin", verifier);
      connection.revokeUserAuthorization(8); expect(connection.authorized(456, 42)).toBe(true);
      const pending = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      connection.revokeUserAuthorization(7); connection.revokeUserAuthorization(7);
      expect(connection.authorized(456, 42)).toBe(false); expect(connection.snapshot().repositories).toEqual([]);
      await expect(connection.complete(pending, "code", 456, "admin", verifier)).rejects.toThrow("unauthorized");
      await expect(connection.sync()).rejects.toThrow("reauthorization_required"); expect(api.repositories).toHaveBeenCalledTimes(1);
    });
  });
  it("requires explicit disconnect to switch the owner's GitHub identity", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), connection = new GitHubAppConnection(ctx.storage, api, () => {});
      let state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      await connection.complete(state, "code", 456, "admin", verifier);
      vi.mocked(api.authorizeInstallation).mockResolvedValue({ user: { id: 8, login: "other" }, repositories: [{ id: 42, name: "owner/repo" }], expiresAt: Date.now() + 600_000 });
      state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      await expect(connection.complete(state, "code", 456, "admin", verifier)).rejects.toThrow("identity_changed"); expect(api.repositories).toHaveBeenCalledTimes(1);
      connection.disconnect(); state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      expect((await connection.complete(state, "code", 456, "admin", verifier)).githubUser?.id).toBe(8);
    });
  });
  it("does not resurrect a first-time binding when OAuth revocation arrives while verification is pending", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), connection = new GitHubAppConnection(ctx.storage, api, () => {});
      vi.mocked(api.authorizeInstallation).mockImplementationOnce(async () => { connection.revokeUserAuthorization(7); return { user: { id: 7, login: "owner" }, repositories: [{ id: 42, name: "owner/repo" }], expiresAt: Date.now() + 600_000 }; });
      const state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      await expect(connection.complete(state, "code", 456, "admin", verifier)).rejects.toThrow("unauthorized"); expect(connection.authorized(456, 42)).toBe(false);
    });
  });
  it("requires reconnect for a legacy App-only binding instead of silently upgrading it", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), connection = new GitHubAppConnection(ctx.storage, api, () => {});
      ctx.storage.sql.exec("UPDATE github_app_connection SET value=? WHERE id=1", JSON.stringify({ installationId: 456, repositories: [], generation: 1, status: "active", verifiedAt: Date.now() }));
      await expect(connection.sync()).rejects.toThrow("reauthorization_required"); expect(api.repositories).not.toHaveBeenCalled();
    });
  });
  it("never binds an App-owned installation that the OAuth user cannot access", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), connection = new GitHubAppConnection(ctx.storage, api, () => {});
      const state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      vi.mocked(api.authorizeInstallation).mockRejectedValueOnce(new Error("github_app_unauthorized"));
      await expect(connection.complete(state, "code", 456, "admin", verifier)).rejects.toThrow("unauthorized");
      expect(api.repositories).not.toHaveBeenCalled(); expect(connection.snapshot().status).toBe("revoked");
      await expect(connection.complete(state, "code", 456, "admin", verifier)).rejects.toThrow("unauthorized");
      expect(api.authorizeInstallation).toHaveBeenCalledTimes(1);
    });
  });
  it("requires initiating admin and browser binding, consumes once, and survives reconstruction", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), revoke = vi.fn(); const connection = new GitHubAppConnection(ctx.storage, api, revoke);
      const state = new URL(await connection.start("admin-a", verifier)).searchParams.get("state")!;
      await expect(connection.complete(state + "x", "test-code", 456, "admin-a", verifier)).rejects.toThrow("unauthorized");
      await expect(connection.complete(state, "test-code", 456, "admin-b", verifier)).rejects.toThrow("unauthorized");
      await expect(connection.complete(state, "test-code", 456, "admin-a", "b".repeat(64))).rejects.toThrow("unauthorized");
      expect(api.repositories).not.toHaveBeenCalled();
      expect(await connection.complete(state, "test-code", 456, "admin-a", verifier)).toMatchObject({ installationId: 456, repositories: [{ id: 42, name: "owner/repo" }], status: "active" });
      await expect(connection.complete(state, "test-code", 456, "admin-a", verifier)).rejects.toThrow("unauthorized");
      expect(api.repositories).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledTimes(1);
      expect(new GitHubAppConnection(ctx.storage, api, revoke).snapshot().installationId).toBe(456);
      const stored = ctx.storage.sql.exec<{ hash: string; binding: string }>("SELECT hash,binding FROM github_app_state").toArray(); expect(stored).toEqual([]);
    });
  });
  it("rejects expired state and consumes state on upstream denial", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), connection = new GitHubAppConnection(ctx.storage, api, () => {});
      const state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      ctx.storage.sql.exec("UPDATE github_app_state SET expires_at=0");
      await expect(connection.complete(state, "test-code", 456, "admin", verifier)).rejects.toThrow("unauthorized"); expect(api.repositories).not.toHaveBeenCalled();
      const next = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      vi.mocked(api.repositories).mockRejectedValueOnce(new Error("denied"));
      await expect(connection.complete(next, "test-code", 456, "admin", verifier)).rejects.toThrow("denied");
      await expect(connection.complete(next, "test-code", 456, "admin", verifier)).rejects.toThrow("unauthorized"); expect(connection.snapshot().status).toBe("revoked");
    });
  });
  it("never lets an older in-flight API snapshot overwrite a revocation", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), revoke = vi.fn(), connection = new GitHubAppConnection(ctx.storage, api, revoke);
      const state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      vi.mocked(api.repositories).mockImplementationOnce(async () => { connection.invalidate(); return [{ id: 42, name: "owner/repo" }]; });
      await expect(connection.complete(state, "test-code", 456, "admin", verifier)).rejects.toThrow("unauthorized");
      expect(connection.snapshot()).toMatchObject({ status: "revoked", repositories: [], generation: 2 }); expect(revoke).toHaveBeenCalledTimes(2);
    });
  });
});
