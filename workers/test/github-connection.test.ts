import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAppClient } from "../src/github/app";
import { GitHubAppConnection } from "../src/github/connection";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const verifier = "a".repeat(64);
function client() {
  const api = new GitHubAppClient({});
  vi.spyOn(api, "installationUrl").mockImplementation(state => "https://github.com/apps/test/installations/new?state=" + state);
  vi.spyOn(api, "repositories").mockResolvedValue([{ id: 42, name: "owner/repo" }]); return api;
}
describe("durable GitHub App state", () => {
  it("requires initiating admin and browser binding, consumes once, and survives reconstruction", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), revoke = vi.fn(); const connection = new GitHubAppConnection(ctx.storage, api, revoke);
      const state = new URL(await connection.start("admin-a", verifier)).searchParams.get("state")!;
      await expect(connection.complete(state + "x", 456, "admin-a", verifier)).rejects.toThrow("unauthorized");
      await expect(connection.complete(state, 456, "admin-b", verifier)).rejects.toThrow("unauthorized");
      await expect(connection.complete(state, 456, "admin-a", "b".repeat(64))).rejects.toThrow("unauthorized");
      expect(api.repositories).not.toHaveBeenCalled();
      expect(await connection.complete(state, 456, "admin-a", verifier)).toMatchObject({ installationId: 456, repositories: [{ id: 42, name: "owner/repo" }], status: "active" });
      await expect(connection.complete(state, 456, "admin-a", verifier)).rejects.toThrow("unauthorized");
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
      await expect(connection.complete(state, 456, "admin", verifier)).rejects.toThrow("unauthorized"); expect(api.repositories).not.toHaveBeenCalled();
      const next = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      vi.mocked(api.repositories).mockRejectedValueOnce(new Error("denied"));
      await expect(connection.complete(next, 456, "admin", verifier)).rejects.toThrow("denied");
      await expect(connection.complete(next, 456, "admin", verifier)).rejects.toThrow("unauthorized"); expect(connection.snapshot().status).toBe("revoked");
    });
  });
  it("never lets an older in-flight API snapshot overwrite a revocation", async () => {
    await runInDurableObject(env.EVENTS.getByName("main"), async (_instance, ctx) => {
      const api = client(), revoke = vi.fn(), connection = new GitHubAppConnection(ctx.storage, api, revoke);
      const state = new URL(await connection.start("admin", verifier)).searchParams.get("state")!;
      vi.mocked(api.repositories).mockImplementationOnce(async () => { connection.invalidate(); return [{ id: 42, name: "owner/repo" }]; });
      await expect(connection.complete(state, 456, "admin", verifier)).rejects.toThrow("unauthorized");
      expect(connection.snapshot()).toMatchObject({ status: "revoked", repositories: [], generation: 2 }); expect(revoke).toHaveBeenCalledTimes(2);
    });
  });
});
