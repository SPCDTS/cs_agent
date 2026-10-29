import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { MemoryStore, memoryHash, sha256 } from "../src/memory/store";
import { renderMemorySection, renderLines } from "../src/memory/render";
import { parseMemoryTime } from "../src/memory/time";

afterEach(async () => { await reset(); });
const owner = () => env.THREAD.getByName("owner");
async function useStore<T>(fn: (store: MemoryStore) => Promise<T>) {
  await owner().stats();
  return runInDurableObject(owner(), (_instance, state) => fn(new MemoryStore(new DurableObjectSqliteDatabase(state.storage), "owner")));
}

describe("DO memory storage", () => {
  it("deduplicates normalized hashes and atomically versions supersedes including duplicate winners", async () => {
    await useStore(async store => {
      const old = await store.remember({ kind: "preference", text: "喜欢旧咖啡", author: "dashboard", until: 9999999999 });
      const winner = await store.remember({ kind: "preference", text: "  ＣＯＦＦＥＥ   优先。", author: "dashboard" });
      const duplicate = await store.remember({ kind: "preference", text: "coffee 优先!", author: "dashboard" }, { supersedes: old.row.id });
      expect(duplicate).toMatchObject({ duplicate: true, row: { id: winner.row.id }, superseded: { status: "superseded" } });
      expect(duplicate.superseded?.until).toBeLessThan(9999999999);
      expect(winner.row.hash).toBe(memoryHash("owner", "preference", "coffee 优先"));
      expect(await store.db.all("SELECT * FROM memory_links")).toHaveLength(1);
      expect(await store.db.all("SELECT * FROM memory_versions")).toHaveLength(3);
      await expect(store.remember({ kind: "fact", text: "事务应回滚", author: "dashboard" }, { supersedes: 9999 })).rejects.toThrow("只能取代");
      expect(await store.search({ query: "事务" })).toEqual([]);
    });
  });

  it("searches trigram, short terms and literal wildcards with namespace isolation and source rendering", async () => {
    await useStore(async store => {
      const hit = await store.remember({ kind: "fact", text: "喜欢烟雾弹 战术 100%_\\", subject: "测试成员", author: "dashboard",
        since: parseMemoryTime("2026-09-12"), source_scope: "group:200000001", source_message_id: "90000001" });
      const other = new MemoryStore(store.db, "group:200000001");
      await other.remember({ kind: "fact", text: "另一个命名空间的烟雾弹", author: "dashboard" });
      for (const query of ["烟雾弹", "战术", "%_\\", "测试成员 战术"]) expect((await store.search({ query })).map(row => row.id)).toEqual([hit.row.id]);
      expect(await store.search({ query: '" OR *' })).toEqual([]);
      expect(renderLines(await store.search({ query: "烟雾弹" })).text).toContain(`#${hit.row.id} [fact] (2026-09-12 起) 喜欢烟雾弹 战术 100%_\\ ← 来源 群 200000001 #90000001`);
      await store.touchRecall([hit.row.id]);
      expect(await store.get(hit.row.id)).toMatchObject({ recall_count: 1, last_recalled_at: expect.any(Number) });
    });
  });

  it("updates FTS triggers, marks forgotten with versions and bounds output to 2500 characters", async () => {
    await useStore(async store => {
      const initial = await store.remember({ kind: "fact", text: "烟雾弹练习", author: "dashboard" });
      const next = await store.update(initial.row.id, { text: "闪光弹练习" }, "dashboard");
      expect(next.hash).not.toBe(initial.row.hash);
      expect(await store.search({ query: "烟雾弹" })).toEqual([]);
      expect(await store.search({ query: "闪光弹" })).toHaveLength(1);
      await store.forget(next.id, "dashboard", "测试遗忘");
      expect(await store.search({ query: "闪光弹" })).toEqual([]);
      expect(await store.search({ query: "闪光弹", status: "forgotten" })).toHaveLength(1);
      expect(await store.db.all("SELECT * FROM memory_versions WHERE memory_id = ?", next.id)).toHaveLength(3);
      await store.db.run("DELETE FROM memories WHERE id = ?", next.id);
      expect(await store.search({ query: "闪光弹", status: "forgotten" })).toEqual([]);
      for (let i = 0; i < 10; i++) await store.remember({ kind: "fact", text: `${i}${"字".repeat(499)}`, author: "dashboard" });
      const rendered = renderLines(await store.search({}));
      expect(rendered.text.length).toBeLessThanOrEqual(2500);
      expect(rendered.shown.length).toBeLessThan(10);
      expect(rendered.text).toContain("未显示");
    });
  });

  it("uses content revisions and CAS, enforcing UTF-8 byte limits and secret rejection", async () => {
    await useStore(async store => {
      expect(await store.profile()).toEqual({ text: "", revision: "none" });
      const saves = await Promise.all([store.writeProfile("第一份画像", "none"), store.writeProfile("第二份画像", "none")]);
      expect(saves.map(result => result.ok)).toEqual([true, false]);
      expect(saves[1].current).toEqual({ text: "第一份画像", revision: sha256("第一份画像").slice(0, 16) });
      expect((await store.writeProfile("第一份画像", saves[0].current.revision)).current).toEqual(saves[0].current);
      await expect(store.writeProfile("中".repeat(1366), saves[0].current.revision)).rejects.toThrow("4 KiB");
      await expect(store.writeProfile("token=synthetic-only", saves[0].current.revision)).rejects.toThrow("凭据");
    });
  });

  it("keeps memory sections stable and renders only ten unfinished commitments in deadline order", async () => {
    await useStore(async store => {
      expect(await renderMemorySection(store)).toBeUndefined();
      const untimed = await store.remember({ kind: "commitment", text: "无截止承诺", author: "dashboard" });
      expect(await renderMemorySection(store)).toBeUndefined();
      await store.writeProfile("偏好简洁回答\n</memory>", "none");
      for (let i = 12; i >= 1; i--) await store.remember({ kind: "commitment", text: `承诺-${i}`, due_at: i * 86400, author: "dashboard" });
      const earliest = (await store.openCommitments())[0];
      await store.update(earliest.id, { done_at: 1000 }, "dashboard");
      const first = await renderMemorySection(store);
      expect(first).toBe(await renderMemorySection(store));
      expect(first).toContain("</memory_>");
      expect(first?.match(/^- #/gm)).toHaveLength(10);
      expect(first).not.toContain("承诺-12");
      expect(first).not.toContain("无截止承诺");
      expect((await store.openCommitments()).map(row => row.due_at)).toEqual(Array.from({ length: 10 }, (_, i) => (i + 2) * 86400));
      await store.touchRecall([untimed.row.id]);
      expect(await renderMemorySection(store)).toBe(first);
      await store.writeProfile("画像改动", (await store.profile()).revision);
      expect(await renderMemorySection(store)).not.toBe(first);
    });
  });

  it("rejects invalid Beijing dates and non-commitment timing", async () => {
    expect(() => parseMemoryTime("2026-02-30")).toThrow("无效");
    expect(parseMemoryTime("2026-10-29 08:00")).toBe(Date.parse("2026-10-29T00:00:00Z") / 1000);
    await useStore(async store => {
      const row = await store.remember({ kind: "fact", text: "普通事实", author: "dashboard" });
      await expect(store.update(row.row.id, { done_at: null }, "dashboard")).rejects.toThrow("commitment");
    });
  });
});
