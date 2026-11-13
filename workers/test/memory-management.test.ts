import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { MemoryStore, memoryHash } from "../src/memory/store";
import { MemoryManager } from "../src/memory/management";
import { importMemoryHistory, parseMemoryHistory } from "../src/memory/history-import";
import { generateProfileProposal } from "../src/maintenance/profile-proposal";
import { runConsolidate } from "../src/maintenance/consolidate";
import type { MemoryRow } from "../src/memory/types";

afterEach(async () => { await reset(); });
async function use<T>(fn: (store: MemoryStore, manager: MemoryManager, state: DurableObjectState) => Promise<T>) {
  const stub = env.THREAD.getByName("owner"); await stub.stats();
  return runInDurableObject(stub, (_instance, state) => {
    const store = new MemoryStore(new DurableObjectSqliteDatabase(state.storage), "owner", () => 100);
    return fn(store, new MemoryManager(store, () => 100), state);
  });
}
const remember = (store: MemoryStore, text: string) => store.remember({ kind: "fact", text, author: "dashboard" });

describe("namespace memory administration", () => {
  it("paginates filtered lists and keeps details, relations and jobs inside the bound namespace", async () => {
    await use(async (store, manager) => {
      const one = (await remember(store, "第一条中文测试")).row;
      const two = (await remember(store, "第二条中文测试")).row;
      const three = (await remember(store, "第三条中文测试")).row;
      const otherStore = new MemoryStore(store.db, "private:10000003");
      const other = (await remember(otherStore, "别的命名空间")).row;
      await store.relate(one.id, two.id);
      await expect(store.relate(one.id, other.id)).rejects.toThrow("不存在");
      await store.db.run("INSERT INTO memory_links VALUES (?,?,'related',0)", one.id, other.id);
      const page = await manager.list({ query: "中文测试", kind: "fact", limit: 2 });
      expect(page.items.map(r => r.id)).toEqual([three.id, two.id]);
      expect(page.total).toBe(3);
      expect((await manager.list({ limit: 2, cursor: page.nextCursor! })).items.map(r => r.id)).toEqual([one.id]);
      expect((await manager.list({ limit: 2, page: 2 })).items.map(r => r.id)).toEqual([one.id]);
      expect((await manager.detail(one.id)).links).toHaveLength(1);
      await expect(manager.detail(other.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(manager.list({ page: 2, cursor: one.id })).rejects.toMatchObject({ code: "invalid" });
      await store.forget(two.id, "dashboard", "测试");
      expect((await manager.list({ status: "forgotten" })).items.map(r => r.id)).toEqual([two.id]);
      expect((await manager.list({ status: "all" })).total).toBe(3);
    });
  });

  it("restores the pre-forget status and explicit versions with revision CAS even within one second", async () => {
    await use(async (store, manager) => {
      const original = (await remember(store, "最初正文")).row;
      const initial = await manager.detail(original.id);
      await store.update(original.id, { text: "后来正文" }, "dashboard");
      await store.setStatus(original.id, "retired", "dashboard", "降级");
      await store.forget(original.id, "dashboard", "遗忘");
      const forgotten = await manager.detail(original.id);
      await expect(manager.restore(original.id, { expectedVersion: initial.revision })).rejects.toMatchObject({ code: "conflict" });
      expect(await manager.restore(original.id, { expectedVersion: forgotten.revision })).toMatchObject({ status: "retired", text: "后来正文" });
      const restored = await manager.detail(original.id);
      expect(await manager.restore(original.id, { expectedVersion: restored.revision, versionId: initial.revision })).toMatchObject({ status: "active", text: "最初正文" });
      await expect(manager.restore(original.id, { expectedVersion: restored.revision, versionId: initial.revision })).rejects.toMatchObject({ code: "conflict" });
    });
  });

  it("rolls back only untouched consolidation changes and keeps later same-second edits", async () => {
    await use(async (store, manager) => {
      const first = (await remember(store, "可以回退")).row, second = (await remember(store, "之后编辑")).row;
      await store.setStatus(first.id, "retired", "consolidate:batch", "整理");
      await store.setStatus(second.id, "retired", "consolidate:batch", "整理");
      await store.setStatus(second.id, "active", "dashboard", "手工恢复");
      await store.update(second.id, { text: "保留后来修改" }, "dashboard");
      expect(await manager.rollback("batch")).toEqual({ restored: 1, skipped: 1 });
      expect(await store.get(first.id)).toMatchObject({ status: "active" });
      expect(await store.get(second.id)).toMatchObject({ text: "保留后来修改", status: "active" });
      expect(await manager.rollback("batch")).toEqual({ restored: 0, skipped: 2 });
    });
  });

  it("generates reviewed profiles, detects stale revisions and atomically accepts or rejects", async () => {
    await use(async (store, manager) => {
      for (let i = 0; i < 31; i++) await store.remember({ kind: "preference", text: `偏好条目${i}`, author: "dashboard" });
      const generated = await generateProfileProposal(store, async () => ({ text: JSON.stringify({ profile: "合成画像" }) }), "batch");
      expect(generated.result).toBe("created");
      const proposal = (await manager.proposals())[0]!;
      expect(await generateProfileProposal(store, async () => { throw new Error("不应重复调用"); })).toMatchObject({ result: "unchanged" });
      await store.writeProfile("手工编辑", "none");
      const changed = await store.profile();
      await expect(manager.decideProposal(proposal.id, "accepted", "none")).rejects.toMatchObject({ code: "conflict" });
      await expect(manager.decideProposal(proposal.id, "accepted", changed.revision)).rejects.toMatchObject({ code: "conflict" });
      expect(await manager.decideProposal(proposal.id, "rejected", changed.revision)).toMatchObject({ status: "rejected" });
      const replacement = await manager.putProposal({ text: "新画像", based_on_revision: changed.revision, batch_id: "next", entries_hash: await store.profileFingerprint() });
      expect(await manager.decideProposal(replacement.id, "accepted", changed.revision)).toMatchObject({ status: "accepted" });
      expect((await store.profile()).text).toBe("新画像");
      expect(await manager.proposals()).toEqual([]);
      await expect(manager.decideProposal(replacement.id, "rejected", (await store.profile()).revision)).rejects.toMatchObject({ code: "conflict" });
    });
  });

  it("persists manual consolidation results and rejects concurrent jobs", async () => {
    await use(async (store, manager, state) => {
      const old = (await store.remember({ kind: "episode", text: "旧经历", author: "dashboard" })).row;
      const context = { db: store.db, store, kv: state.storage, complete: async () => ({ text: "[]" }),
        config: { rawDays: 30, rawHardMaxDays: 90, summaryDays: 365, eventsDays: 30 }, now: Date.now() };
      const report = await runConsolidate(context);
      expect(report).toMatchObject({ status: "ok", retired: 1 });
      const jobs = await manager.jobs();
      expect(jobs[0]).toMatchObject({ status: "ok", report_json: expect.any(String) });
      expect(await manager.rollback(jobs[0]!.id)).toEqual({ restored: 1, skipped: 0 });
      expect((await store.get(old.id))?.status).toBe("active");
      await store.db.run("INSERT INTO memory_jobs(id,ns,status,started_at) VALUES ('blocked','owner','running',1)");
      await expect(runConsolidate(context)).rejects.toMatchObject({ code: "conflict" });
      await manager.recoverInterruptedJobs();
      expect((await manager.jobs()).find(j => j.id === "blocked")?.status).toBe("interrupted");
    });
  });
});

describe("incremental legacy memory history", () => {
  it("imports 61 versions and four links once, remaps collisions, supports dry run and retains cloud edits and CAS", async () => {
    await use(async (store, manager) => {
      const original = (await store.remember({ kind: "fact", text: "旧正文", author: "dashboard", source_message_id: "synthetic-1" })).row;
      await store.update(original.id, { text: "云端后来编辑" }, "dashboard");
      const current = await manager.detail(original.id);
      const other = new MemoryStore(store.db, "private:10000003");
      await remember(other, "必须保留的其他命名空间");
      const memories: MemoryRow[] = Array.from({ length: 4 }, (_, i) => ({ ...original, id: i + 1, text: `旧正文${i}`,
        hash: memoryHash("owner", "fact", `旧正文${i}`), source_message_id: `synthetic-${i + 1}` }));
      memories[0] = original;
      const bundle = { format: "cs-agent-memory-history-v1", source: "legacy-test", ns: "owner", memories,
        versions: Array.from({ length: 61 }, (_, i) => {
          const row = memories[i % 4]!;
          return { id: i + 1, memory_id: row.id, at: i, by: "dashboard", before_json: null, after_json: JSON.stringify(row), reason: "remember" };
        }), links: Array.from({ length: 4 }, (_, i) => ({ from_id: i + 1, to_id: (i + 1) % 4 + 1, rel: "related", created_at: 1 })), proposals: [] };
      const preview = await importMemoryHistory(store, bundle, { dryRun: true });
      expect(preview).toMatchObject({ dryRun: true, memories: 3, versions: 61, links: 4, proposals: 0 });
      expect(await store.db.all("SELECT * FROM memory_history_receipts")).toEqual([]);
      const imported = await importMemoryHistory(store, bundle);
      expect(imported).toMatchObject({ memories: 3, versions: 61, links: 4, proposals: 0 });
      expect(imported.idMap).toEqual(preview.idMap);
      expect(imported.idMap[1]?.memoryId).not.toBe(2);
      expect(await store.get(original.id)).toMatchObject({ text: "云端后来编辑" });
      expect((await manager.detail(original.id)).revision).toBe(current.revision);
      expect(await importMemoryHistory(store, bundle)).toMatchObject({ memories: 0, versions: 0, links: 0, proposals: 0 });
      expect(await other.get(2)).toMatchObject({ text: "必须保留的其他命名空间" });
      const next = { ...bundle, versions: [...bundle.versions, { ...bundle.versions[0]!, id: 62 }] };
      expect(await importMemoryHistory(store, next)).toMatchObject({ versions: 1 });
      const invalid = structuredClone(next);
      invalid.versions[0]!.after_json = JSON.stringify({ ...original, ns: "private:10000003" });
      expect(() => parseMemoryHistory(invalid)).toThrow("snapshot");
      await expect(importMemoryHistory(store, { ...next, versions: [{ ...next.versions[0]!, reason: "改变既有版本" }] })).rejects.toThrow("receipt_conflict");
      expect((await manager.detail(original.id)).revision).toBe(current.revision);
      expect(await store.db.all("SELECT * FROM memory_imported_versions")).toHaveLength(62);
    });
  });
});
