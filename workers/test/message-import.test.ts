import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import worker from "../src/index";
import { recall } from "../src/context";
import { input } from "./helpers";

const TOKEN = "test-admin-only";
afterEach(async () => { await reset(); });
const request = (body: unknown, token: string | null = TOKEN) => worker.fetch(new Request("https://test/admin/messages/import", {
  method: "POST", headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}), { ...env, ADMIN_TOKEN: TOKEN });
const message = (id: string, text: string, time: number, userId = "10000004") =>
  ({ message_id: id, time, user_id: userId, nickname: "成员", is_self: 0, text, reply_to_id: null, action: null, detail: null, image_count: 0 });
// 北京时间 2023-11-14 零点。
const DAY_START = 1699891200;
const summary = { kind: "day", period_start: DAY_START, period_end: DAY_START + 86400, text: "群里约了周末打训练赛", msg_count: 12, created_at: DAY_START + 90000 };
// stats() 先建表，没被导入碰过的线程也能查。
const rows = async (key: string, sql: string) => {
  await env.THREAD.getByName(key).stats();
  return runInDurableObject(env.THREAD.getByName(key), (_instance, state) => state.storage.sql.exec(sql).toArray());
};
const recallIn = (key: string, scope: string, query: string) => runInDurableObject(env.THREAD.getByName(key),
  (_instance, state) => recall(new DurableObjectSqliteDatabase(state.storage), scope, { query }));

describe("history message import", () => {
  it("requires the admin bearer and rejects malformed or oversized batches before touching a thread", async () => {
    const body = { scope: "group:200000001", messages: [message("1", "烟雾弹道具教学", 1700000001)], summaries: [] };
    expect((await request(body, null)).status).toBe(401);
    expect((await request(body, "t")).status).toBe(401);
    for (const bad of [{ ...body, scope: "owner" }, { ...body, scope: "group:../x" }, { ...body, messages: [{ ...body.messages[0], is_self: 2 }] },
      { ...body, summaries: [{ ...summary, kind: "month" }] }, { ...body, extra: 1 }, "{"]) {
      const response = await request(bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_import" });
    }
    expect((await request("x".repeat(8 * 1024 * 1024 + 1))).status).toBe(413);
    expect(await rows("group:200000001", "SELECT COUNT(*) AS n FROM messages")).toEqual([{ n: 0 }]);
  });

  it("dedupes messages against live history and summaries across runs, and makes both recallable through the trigram index", async () => {
    const group = env.THREAD.getByName("group:200000001");
    await group.ingest(input(1, "线上已有的消息", 10000004, 200000001));
    const body = { scope: "group:200000001", name: "训练群", messages: [message("1", "导入的重复消息", 1700000001), message("2", "烟雾弹道具教学", 1700000002)],
      summaries: [summary] };
    const first = await request(body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ messages: { inserted: 1, skipped: 1 }, summaries: { inserted: 1, skipped: 0 } });
    expect(await (await request(body)).json()).toEqual({ messages: { inserted: 0, skipped: 2 }, summaries: { inserted: 0, skipped: 1 } });

    expect(await rows("group:200000001", "SELECT message_id, text FROM messages ORDER BY message_id")).toEqual([
      { message_id: "1", text: "线上已有的消息" }, { message_id: "2", text: "烟雾弹道具教学" }]);
    expect(await rows("group:200000001", "SELECT scope, name FROM scope_names")).toEqual([{ scope: "group:200000001", name: "训练群" }]);
    expect(await rows("group:200000001", "SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"烟雾弹\"'")).toHaveLength(1);
    expect(await recallIn("group:200000001", "group:200000001", "烟雾弹")).toContain("成员(10000004): 烟雾弹道具教学");
    expect(await recallIn("group:200000001", "group:200000001", "训练赛")).toContain("[日摘要 11-14] 群里约了周末打训练赛");
    expect(await recallIn("group:200000001", "group:200000001", "道具")).toContain("烟雾弹道具教学");
    const events = await rows("group:200000001", "SELECT kind, detail FROM events WHERE kind = 'history_import'");
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("烟雾弹");
  });

  it("routes the owner's private history into the owner thread under its private scope and other private chats to their own threads", async () => {
    const owner = { scope: "private:10000001", messages: [message("7", "记得帮我约训练赛", 1700000007, "10000001")], summaries: [] };
    expect(await (await request(owner)).json()).toEqual({ messages: { inserted: 1, skipped: 0 }, summaries: { inserted: 0, skipped: 0 } });
    expect(await rows("owner", "SELECT scope, message_id FROM messages")).toEqual([{ scope: "private:10000001", message_id: "7" }]);
    expect(await rows("private:10000001", "SELECT COUNT(*) AS n FROM messages")).toEqual([{ n: 0 }]);
    expect(await recallIn("owner", "private:10000001", "训练赛")).toContain("记得帮我约训练赛");

    const other = { scope: "private:10000003", messages: [message("8", "别的私聊", 1700000008, "10000003")], summaries: [] };
    expect((await request(other)).status).toBe(200);
    expect(await rows("private:10000003", "SELECT scope FROM messages")).toEqual([{ scope: "private:10000003" }]);
    expect(await rows("owner", "SELECT COUNT(*) AS n FROM messages")).toEqual([{ n: 1 }]);
  });
});
