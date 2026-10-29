import { env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { ThreadDO } from "../src/thread";
import { memoryHash, sha256 } from "../src/memory/store";

afterEach(async () => { await reset(); });
const imported = { ns: "owner", profile: { text: "测试画像" }, memories: [
  { id: 1234, ns: "owner", kind: "fact", text: "喜欢烟雾弹", author: "dashboard", source_message_id: "90000001", source_turn_id: "synthetic-turn" },
] };
const request = (body: unknown, token: string | undefined = "test-admin-only") => new Request("https://test/admin/memory/import", {
  method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const adminEnv = () => ({ ...env, ADMIN_TOKEN: "test-admin-only" });

describe("admin memory import", () => {
  it("requires an ADMIN_TOKEN bearer and rejects absent secrets, NapCat tokens and query tokens", async () => {
    expect((await worker.fetch(request(imported), { ...env, ADMIN_TOKEN: undefined })).status).toBe(401);
    for (const token of ["", "t", "incorrect", "test-admin-onlz"]) expect((await worker.fetch(request(imported, token), adminEnv())).status).toBe(401);
    const query = new Request("https://test/admin/memory/import?access_token=test-admin-only", { method: "POST", body: JSON.stringify(imported) });
    expect((await worker.fetch(query, adminEnv())).status).toBe(401);
    expect((await worker.fetch(new Request("https://test/admin/memory/import"), adminEnv())).status).toBe(404);
    expect((await env.THREAD.getByName("owner").stats()).memory.active).toBe(0);
  });

  it("preserves IDs and sources, skips collisions, hashes profiles and exposes UTF-8 health counts", async () => {
    const response = await worker.fetch(request(imported), adminEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inserted: 1, skipped: 0 });
    expect(await (await worker.fetch(request(imported), adminEnv())).json()).toEqual({ inserted: 0, skipped: 1 });
    const data = await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) => ({
      rows: state.storage.sql.exec("SELECT id, ns, source_message_id, source_turn_id, hash FROM memories").toArray(),
      profiles: state.storage.sql.exec("SELECT text, revision FROM profile").toArray(),
      versions: state.storage.sql.exec("SELECT * FROM memory_versions").toArray(),
      fts: state.storage.sql.exec("SELECT rowid FROM memories_fts WHERE memories_fts MATCH '烟雾弹'").toArray(),
    }));
    expect(data.rows).toEqual([{ id: 1234, ns: "owner", source_message_id: "90000001", source_turn_id: "synthetic-turn", hash: memoryHash("owner", "fact", "喜欢烟雾弹") }]);
    expect(data.profiles).toEqual([{ text: "测试画像", revision: sha256("测试画像").slice(0, 16) }]);
    expect(data.versions).toHaveLength(1);
    expect(data.fts).toEqual([{ rowid: 1234 }]);
    expect(await (await SELF.fetch("https://test/healthz")).json()).toMatchObject({ thread: { memory: { active: 1, profileBytes: 12, extractQueue: 0 } } });
  });

  it("routes each namespace to its own DO and rejects malformed or cross-namespace batches atomically", async () => {
    const group = { ns: "group:200000001", memories: [{ ...imported.memories[0], ns: "group:200000001" }] };
    expect(await (await worker.fetch(request(group), adminEnv())).json()).toEqual({ inserted: 1, skipped: 0 });
    expect((await env.THREAD.getByName("owner").stats()).memory.active).toBe(0);
    expect((await env.THREAD.getByName(group.ns).stats()).memory.active).toBe(1);
    for (const bad of [{ ...imported, ns: "../../escape" }, { ...imported, memories: [...imported.memories, { ...imported.memories[0], id: 1235, ns: group.ns }] },
      { ...imported, profile: { text: "中".repeat(2000) } }, { ...imported, memories: [{ ...imported.memories[0], text: "token=synthetic-only" }] },
      { ...imported, memories: [{ ...imported.memories[0], id: -1 }] }]) {
      expect((await worker.fetch(request(bad), adminEnv())).status).toBe(400);
    }
    expect((await worker.fetch(new Request("https://test/admin/memory/import", { method: "POST", headers: { Authorization: "Bearer test-admin-only" }, body: "{" }), adminEnv())).status).toBe(400);
    expect((await env.THREAD.getByName("owner").stats()).memory.active).toBe(0);
    const error = await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      try { await new ThreadDO(state, env).importMemory(group); }
      catch (error) { return error instanceof Error ? error.message : "unknown"; }
    });
    expect(error).toContain("namespace mismatch");
  });
});
