import { createExecutionContext, createScheduledController, env, reset, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import worker from "../src/index";
import { recall } from "../src/context";
import { MAINTENANCE_CRON, type MaintenanceJob } from "../src/maintenance";
import * as models from "../src/models";
import { ThreadDO } from "../src/thread";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

const DAY = 86400;
const bj = (date: string, time = "10:00") => Date.parse(`${date}T${time}:00+08:00`);
const GROUP = "group:200000001";

/** 按提示词分辨三种调用：冲突判定按送审对数全判 a_supersedes_b，周摘要与日摘要返回固定文本。 */
function fauxModel() {
  const prompts: string[] = [];
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    const user = transcript.messages.findLast(message => message.role === "user");
    const prompt = typeof user?.content === "string" ? user.content : "";
    prompts.push(prompt);
    if (prompt.includes("<数据>")) {
      const pairs = prompt.match(/"pair":\d/g)?.length ?? 0;
      return fauxAssistantMessage(JSON.stringify(Array.from({ length: pairs }, (_, i) => ({ pair: i + 1, verdict: "a_supersedes_b" }))));
    }
    return fauxAssistantMessage(prompt.includes("一周内每天的摘要") ? "本周围绕烟雾弹训练做了安排。" : "成员讨论了烟雾弹训练。");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(() => {
    const registry = createModels(); registry.setProvider(faux.provider);
    return registry;
  });
  return prompts;
}

async function withThread<T>(name: string, vars: Record<string, string>, fn: (thread: ThreadDO, db: DurableObjectSqliteDatabase) => Promise<T>) {
  return runInDurableObject(env.THREAD.getByName(name), async (_instance, state) => {
    const thread = new ThreadDO(state, { ...env, ...vars });
    await thread.memoryView(name, "");
    return fn(thread, new DurableObjectSqliteDatabase(state.storage));
  });
}
async function chat(db: DurableObjectSqliteDatabase, date: string, count: number, scope = GROUP) {
  for (let i = 0; i < count; i++) {
    await db.run("INSERT INTO messages (scope, message_id, time, user_id, nickname, text) VALUES (?, ?, ?, '10000004', '成员', ?)",
      scope, `${date}-${i}`, bj(date) / 1000 + i * 60, `第 ${i} 条闲聊`);
  }
}
const run = (thread: ThreadDO, kind: MaintenanceJob["kind"], now: number) => thread.maintain({ kind, now });
const count = async (db: DurableObjectSqliteDatabase, sql: string, ...args: (string | number)[]) => (await db.get<{ n: number }>(sql, ...args))?.n;

describe("chat history aging", () => {
  it("summarizes days with five or more messages once, then folds a finished week and recalls summaries", async () => {
    const prompts = fauxModel();
    await withThread(GROUP, {}, async (thread, db) => {
      await chat(db, "2026-10-20", 6);
      await chat(db, "2026-10-21", 5);
      await chat(db, "2026-10-22", 3);
      const saturday = bj("2026-10-24", "03:30");
      expect(await run(thread, "aging", saturday)).toMatchObject({ status: "ok", day: 2, week: 0, failed: 0 });
      expect(await run(thread, "aging", saturday)).toEqual({ kind: "aging", status: "skipped" });
      expect(await run(thread, "aging", bj("2026-10-25", "03:30"))).toMatchObject({ status: "ok", day: 0, week: 0 });
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("日期：2026-10-20");
      expect(prompts[0]).toContain("第 5 条闲聊");

      const monday = bj("2026-10-26", "03:30");
      expect(await run(thread, "aging", monday)).toMatchObject({ day: 0, week: 1 });
      expect(prompts).toHaveLength(3);
      expect(await db.all("SELECT kind, period_start, msg_count FROM summaries")).toEqual([{ kind: "week", period_start: bj("2026-10-19", "00:00") / 1000, msg_count: 11 }]);
      expect((await thread.stats()).maintenance).toEqual({ agingLastRun: monday, consolidateLastRun: null, summaries: { day: 0, week: 1 } });

      expect(await recall(db, GROUP, { query: "烟雾弹训练" })).toBe("[周摘要 10-19~10-25] 本周围绕烟雾弹训练做了安排。");
      expect(await recall(db, GROUP, { query: "训练" })).toContain("[周摘要 10-19~10-25]");
      expect(await recall(db, "group:200000002", { query: "烟雾弹训练" })).toContain("未找到");
    });
  });

  it("purges covered raw messages after the retention days, keeps uncovered ones until the hard cap, and honors zero", async () => {
    fauxModel();
    const seed = async (db: DurableObjectSqliteDatabase) => {
      await chat(db, "2026-07-01", 3);
      await chat(db, "2026-10-20", 6);
      await chat(db, "2026-10-21", 5);
      // 周摘要覆盖整周，未摘要的少量消息只有落在没有摘要的周里才算“未覆盖”。
      await chat(db, "2026-10-28", 3);
      await db.run("INSERT INTO summaries (scope, kind, period_start, period_end, text, created_at) VALUES (?, 'week', ?, ?, '去年的周摘要', 0)",
        GROUP, bj("2025-09-01", "00:00") / 1000, bj("2025-09-08", "00:00") / 1000);
    };
    const remaining = (db: DurableObjectSqliteDatabase) => db.all<{ day: string }>(
      "SELECT DISTINCT substr(message_id, 1, 10) AS day FROM messages ORDER BY day");
    await withThread(GROUP, {}, async (thread, db) => {
      await seed(db);
      await run(thread, "aging", bj("2026-10-24", "03:30"));
      expect(await remaining(db)).toEqual([{ day: "2026-10-20" }, { day: "2026-10-21" }, { day: "2026-10-28" }]);
      expect(await run(thread, "aging", bj("2026-12-01", "03:30"))).toMatchObject({ week: 1, purgedMessages: 11 });
      expect(await remaining(db)).toEqual([{ day: "2026-10-28" }]);
      expect(await db.all("SELECT text FROM summaries")).toEqual([{ text: "本周围绕烟雾弹训练做了安排。" }]);
    });
    const registry = env.REGISTRY.getByName("main"), settings = await registry.opsSettings();
    await registry.putOpsSettings({ ...settings.value, threads: { "group:200000002": { rawDays: 0 } } }, settings.revision);
    await withThread("group:200000002", {}, async (thread, db) => {
      await seed(db);
      expect(await run(thread, "aging", bj("2026-12-01", "03:30"))).toMatchObject({ day: 2, purgedMessages: 0 });
      expect(await count(db, "SELECT COUNT(*) AS n FROM messages")).toBe(17);
    });
  });
});

describe("memory consolidation", () => {
  it("dedups, supersedes extractor-written conflicts, protects explicit writes, orphans and retires with versions and an event", async () => {
    const prompts = fauxModel();
    const owner = env.THREAD.getByName("owner");
    await owner.ingest(input(1, "还在的来源消息", 10000001));
    const now = Date.now(), sec = Math.floor(now / 1000);
    const row = (id: number, fields: object) => ({ id, kind: "fact" as const, author: "extractor", created_at: sec - 10 * DAY, updated_at: sec - 10 * DAY, ...fields });
    await owner.importMemory({ ns: "owner", memories: [
      row(1, { text: "早上喝咖啡" }), row(2, { text: "早上喝咖啡。", created_at: sec - 5 * DAY }),
      row(3, { kind: "preference", subject: "咖啡", text: "每天早上喜欢喝美式咖啡", author: "qq:10000001" }),
      row(4, { kind: "preference", subject: "咖啡", text: "每天早上喜欢喝拿铁咖啡" }),
      row(5, { kind: "rule", subject: "训练", text: "每周三晚上练习烟雾弹投掷" }),
      row(6, { kind: "rule", subject: "训练", text: "每周三晚上练习闪光弹投掷", author: "qq:10000001" }),
      row(7, { text: "来源已撤回", source_scope: "private:10000001", source_message_id: "404", created_at: sec - DAY }),
      row(8, { text: "来源还在", source_scope: "private:10000001", source_message_id: "1", created_at: sec - DAY }),
      row(9, { kind: "episode", text: "很久以前的比赛", created_at: sec - 200 * DAY }),
      row(10, { kind: "episode", text: "最近还被想起的比赛", created_at: sec - 200 * DAY, last_recalled_at: sec - 10 * DAY }),
    ] });
    await withThread("owner", {}, async (thread, db) => {
      expect(await run(thread, "consolidate", now)).toMatchObject({ status: "ok", dedup: 1, orphaned: 1, retired: 1,
        conflicts: { pairs: 2, superseded: 1, protected: 1 } });
      expect(prompts).toHaveLength(1);
      const status = Object.fromEntries((await db.all<{ id: number; status: string }>("SELECT id, status FROM memories ORDER BY id")).map(r => [r.id, r.status]));
      expect(status).toEqual({ 1: "active", 2: "superseded", 3: "active", 4: "superseded", 5: "active", 6: "active", 7: "orphaned", 8: "active", 9: "retired", 10: "active" });
      expect(await db.all("SELECT from_id, to_id FROM memory_links WHERE rel = 'supersedes' ORDER BY to_id")).toEqual([{ from_id: 1, to_id: 2 }, { from_id: 3, to_id: 4 }]);
      const versions = await db.all<{ memory_id: number; by: string; reason: string }>("SELECT memory_id, by, reason FROM memory_versions WHERE by LIKE 'consolidate:%' ORDER BY memory_id");
      expect(versions.map(v => [v.memory_id, v.reason])).toEqual([[2, "consolidate_duplicate"], [4, "consolidate_conflict"], [7, "consolidate_orphan"], [9, "consolidate_retire"]]);
      expect(new Set(versions.map(v => v.by)).size).toBe(1);

      expect(await run(thread, "consolidate", now)).toMatchObject({ dedup: 0, conflicts: { pairs: 0 } });
      expect(prompts).toHaveLength(1);
      const events = await db.all<{ detail: string }>("SELECT detail FROM events WHERE kind = 'memory_consolidate'");
      expect(events).toHaveLength(2);
      expect(JSON.parse(events[0]!.detail)).toMatchObject({ batchId: versions[0]!.by.slice(12), dedup: 1, retired: 1, tokens: expect.any(Object), ms: expect.any(Number) });
      expect(events.map(e => e.detail).join()).not.toMatch(/咖啡|比赛|撤回/);
      expect((await thread.stats()).maintenance.consolidateLastRun).toBe(now);
    });
  });

  it("skips threads without memories", async () => {
    await withThread(GROUP, {}, async thread => {
      expect(await run(thread, "consolidate", Date.now())).toEqual({ kind: "consolidate", status: "skipped" });
    });
  });
});

describe("audit retention", () => {
  it("deletes expired events, settled inbound, outbox and stale extraction queue rows", async () => {
    const now = Date.now(), old = now - 31 * DAY * 1000, recent = now - DAY * 1000;
    await withThread("owner", {}, async (thread, db) => {
      for (const at of [old, recent]) await db.run("INSERT INTO events (at, kind, detail) VALUES (?, 'memory_extract', '{}')", at);
      for (const [id, status, at] of [["a", "done", old], ["b", "failed", old], ["c", "queued", old], ["d", "done", recent]] as const) {
        await db.run("INSERT INTO inbound (message_id, user_id, text, received_at, status) VALUES (?, '10000001', '', ?, ?)", id, Math.floor(at / 1000), status);
      }
      for (const at of [old, recent]) await db.run("INSERT INTO outbox (message_id, text, sent_at) VALUES ('m', '', ?)", at);
      for (const [turn, at] of [["stale", now - 8 * DAY * 1000], ["fresh", recent]] as const) await db.run("INSERT INTO extract_queue VALUES (?, ?)", turn, at);
      expect(await run(thread, "retention", now)).toEqual({ kind: "retention", events: 1, inbound: 2, outbox: 1, extractQueue: 1, subagents: 0 });
      expect(await db.all("SELECT at FROM events")).toEqual([{ at: recent }]);
      expect(await db.all("SELECT message_id FROM inbound ORDER BY message_id")).toEqual([{ message_id: "c" }, { message_id: "d" }]);
      expect(await db.all("SELECT turn_id FROM extract_queue")).toEqual([{ turn_id: "fresh" }]);
    });
  });
});

describe("scheduled maintenance", () => {
  it("runs every registered thread serially and keeps going after one RPC throws", async () => {
    await runInDurableObject(env.BRIDGE.getByName("napcat"), (_instance, state) => {
      for (const key of [GROUP, "group:200000002"]) state.storage.sql.exec("INSERT INTO threads (key, seen_at) VALUES (?, 0)", key);
    });
    const maintain = vi.spyOn(ThreadDO.prototype, "maintain").mockImplementationOnce(async () => { throw new Error("synthetic"); });
    const now = bj("2026-10-24", "03:30"), ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: MAINTENANCE_CRON, scheduledTime: now }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(maintain.mock.calls.map(([job]) => job)).toEqual(["aging", "consolidate", "retention", "aging", "consolidate", "retention"].map(kind => ({ kind, now })));
    expect((await env.THREAD.getByName(GROUP).stats()).maintenance.agingLastRun).toBeNull();
    expect((await env.THREAD.getByName("group:200000002").stats()).maintenance.agingLastRun).toBe(now);
  });
});
