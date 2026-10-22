import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessForSource, parseAccess, resolveOwner, type Access } from "../../src/context/access.js";
import { formatMessage, formatMessageFull, formatRecent, formatSearch, formatSummary, joinCapped } from "../../src/context/format.js";
import { ContextStore } from "../../src/context/store.js";
import type { InboundMessage } from "../../src/channel/types.js";
import { tmp } from "../agent/helpers.js";

const G = "200000001";
const OTHER = "39999";
const T0 = Math.floor(Date.UTC(2026, 9, 17, 12, 0, 0) / 1000); // 2026-10-17 12:00 UTC
const grp: Access = { kind: "scope", scope: `group:${G}` };
const all: Access = { kind: "all" };

let store: ContextStore | undefined;
afterEach(() => store?.close());

function open(): ContextStore {
  store = new ContextStore(tmp(), { tzOffsetSec: 0 });
  return store;
}

let seq = 1000;
function msg(text: string, o: Partial<InboundMessage> & { replyTo?: string } = {}): InboundMessage {
  const id = o.message_id ?? String(seq++);
  return {
    message_id: id, time: o.time ?? T0, message_type: o.message_type ?? "group", user_id: o.user_id ?? "20001",
    group_id: o.message_type === "private" ? null : (o.group_id ?? G), self_id: "10001", nickname: o.nickname ?? "De",
    text, route_text: text, truncated: false, mentioned_self: false,
    images: [], segments: o.replyTo ? [{ type: "reply", data: { id: o.replyTo } }, { type: "text", data: { text } }] : [{ type: "text", data: { text } }],
  };
}

describe("access", () => {
  it("parses QQ_ACCESS and derives access from an input source", () => {
    expect(parseAccess("all")).toEqual({ kind: "all" });
    expect(parseAccess(`group:${G}`)).toEqual(grp);
    expect(parseAccess("private:10000001")).toEqual({ kind: "scope", scope: "private:10000001" });
    for (const bad of [undefined, "", "group:", "group:abc", "everyone", "group:1;rm"]) expect(parseAccess(bad)).toBeUndefined();
    expect(accessForSource({ type: "group", user_id: "1", group_id: G }, "1")).toEqual(all);
    expect(accessForSource({ type: "group", user_id: "2", group_id: G }, "1")).toEqual(grp);
    expect(accessForSource({ type: "private", user_id: "10000001", group_id: null }, "10000001")).toEqual(all);
    expect(accessForSource({ type: "private", user_id: "555", group_id: null }, "10000001")).toEqual({ kind: "scope", scope: "private:555" });
    expect(resolveOwner("", ["111", "222"])).toBe("111");
    expect(resolveOwner("333", ["111"])).toBe("333");
    expect(resolveOwner("", "*")).toBeUndefined();
  });
});

describe("ContextStore", () => {
  it("scope_names 幂等迁移、入站 upsert，跨域消息、引用与摘要标签附上清洗后的群名", () => {
    const dir = tmp();
    store = new ContextStore(dir); const file = store.file; store.close();
    const old = new DatabaseSync(file); old.exec("DROP TABLE scope_names"); old.close();
    store = new ContextStore(dir); store.close(); store = new ContextStore(dir);
    const s = store, scope = "group:" + G;
    s.ingest({ ...msg("群名测试", { message_id: "named", time: T0 }), group_name: "旧名" });
    s.ingest({ ...msg("引用测试", { replyTo: "named", message_id: "quote", time: T0 + 1 }), group_name: "家庭群\n[来源]" });
    s.ingest(msg("无名不会覆盖", { time: T0 + 2 }));
    s.ingest({ ...msg("私聊不写群名", { message_type: "private" }), group_name: "伪造" });
    s.writeSummary({ scope, level: "day", period_start: T0, period_end: T0 + 86400, text: "摘要测试", msg_count: 2 });
    const db = new DatabaseSync(file, { readOnly: true });
    try { expect(db.prepare("SELECT * FROM scope_names").all()).toEqual([{ scope, name: "家庭群\n[来源]", updated_at: expect.any(Number) }]); }
    finally { db.close(); }
    const label = "[群" + G + "(家庭群 (来源))]";
    expect(formatRecent(s.recent(all, { limit: 10 }), 2500, { showScope: true })).toContain(label);
    expect(formatSearch(s.search(all, { query: "测试", days: 1, limit: 10, now: T0 + 60 }), 2500, { showScope: true })).toContain(label + " [日摘要");
    const full = formatMessageFull(s.message(all, "quote")!, { showScope: true });
    expect(full.split(label)).toHaveLength(3); expect(full).not.toContain("[来源]");
    expect(formatMessage(s.message(all, "named")!.row)).not.toContain(label);
    expect(s.recent({ kind: "scope", scope: "group:999" }, { limit: 10 })).toEqual([]);
    s.close(); store = new ContextStore(dir, { readOnly: true });
    expect(formatMessage(store.message(all, "named")!.row, { showScope: true })).toContain(label);
  });
  it("ingests idempotently, recalls, and returns recent rows old→new within the window", () => {
    const s = open();
    s.ingest(msg("第一条", { message_id: "1", time: T0 - 3 * 3600 }));
    s.ingest(msg("第二条", { message_id: "2", time: T0 - 60 }));
    s.ingest(msg("第二条重复投递", { message_id: "2", time: T0 - 60 }));
    s.ingest(msg("第三条", { message_id: "3", time: T0 }));
    expect(s.recent(grp, { limit: 10 }).map((r) => r.text)).toEqual(["第一条", "第二条", "第三条"]);
    expect(s.recent(grp, { limit: 10, windowMin: 120, now: T0 }).map((r) => r.message_id)).toEqual(["2", "3"]);
    expect(s.recent(grp, { limit: 1 }).map((r) => r.message_id)).toEqual(["3"]);
    expect(s.recent(grp, { limit: 10, beforeMessageId: "3" }).map((r) => r.message_id)).toEqual(["1", "2"]);
    expect(s.recall(`group:${G}`, "2")).toBe(true);
    expect(s.recent(grp, { limit: 10 }).map((r) => r.message_id)).toEqual(["1", "3"]);
    expect(s.search(grp, { query: "第二条", days: 30, limit: 10, now: T0 })).toEqual([]);
  });

  it("Chinese trigram search: 2-char and 3+-char substrings, multi-term AND, newest first", () => {
    const s = open();
    s.ingest(msg("今晚有cs比赛吗", { message_id: "10", time: T0 - 100 }));
    s.ingest(msg("比赛几点开始", { message_id: "11", time: T0 - 50 }));
    s.ingest(msg("吃饭了没", { message_id: "12", time: T0 }));
    expect(s.search(grp, { query: "比赛", days: 30, limit: 10, now: T0 }).map((i) => i.kind === "message" && i.row.message_id)).toEqual(["11", "10"]);
    expect(s.search(grp, { query: "cs比赛", days: 30, limit: 10, now: T0 })).toHaveLength(1);
    expect(s.search(grp, { query: "CS 今晚", days: 30, limit: 10, now: T0 })).toHaveLength(1);
    expect(s.search(grp, { query: "%", days: 30, limit: 10, now: T0 })).toEqual([]);
    expect(s.search(grp, { query: "比赛", days: 30, limit: 1, now: T0 })).toHaveLength(1);
  });

  it("access filter: group sees only its own scope; cross-scope requests are rejected; all sees everything", () => {
    const s = open();
    s.ingest(msg("本群的比赛", { message_id: "20" }));
    s.ingest(msg("别的群的比赛", { message_id: "21", group_id: OTHER }));
    s.ingest(msg("私聊的比赛", { message_id: "22", message_type: "private", user_id: "10000001" }));
    expect(s.recent(grp, { limit: 10 }).map((r) => r.message_id)).toEqual(["20"]);
    expect(s.recent(grp, { limit: 10, scope: `group:${OTHER}` })).toEqual([]);
    expect(s.search(grp, { query: "比赛", days: 30, limit: 10, now: T0 })).toHaveLength(1);
    expect(s.search(grp, { query: "比赛", days: 30, limit: 10, now: T0, scope: `group:${OTHER}` })).toEqual([]);
    expect(s.message(grp, "21")).toBeNull();
    expect(s.message(grp, "22")).toBeNull();
    expect(s.recent(grp, { limit: 10, beforeMessageId: "21" })).toEqual([]);
    expect(s.recent(all, { limit: 10 })).toHaveLength(3);
    expect(s.search(all, { query: "比赛", days: 30, limit: 10, now: T0 })).toHaveLength(3);
    expect(s.message(all, "21")?.row.text).toBe("别的群的比赛");
  });

  it("message(): full text plus quote chain up to 3 levels", () => {
    const s = open();
    s.ingest(msg("a", { message_id: "30", time: T0 - 4 }));
    s.ingest(msg("b", { message_id: "31", time: T0 - 3, replyTo: "30" }));
    s.ingest(msg("c", { message_id: "32", time: T0 - 2, replyTo: "31" }));
    s.ingest(msg("d", { message_id: "33", time: T0 - 1, replyTo: "32" }));
    s.ingest(msg("e", { message_id: "34", time: T0, replyTo: "33" }));
    const hit = s.message(grp, "34")!;
    expect(hit.row.reply_to_id).toBe("33");
    expect(hit.chain.map((r) => r.text)).toEqual(["d", "c", "b"]);
  });

  it("bot rows: recordSent writes one row per Outbox key; legacy rows from the old reply path still format", () => {
    const s = open();
    s.ingest(msg("画一只狗", { message_id: "40", time: T0 }));
    const row = { key: "group:1:call-1", thread_key: `group:${G}`, turn_id: "pi:1:2", input_key: null, system: false, message_type: "group" as const,
      target_id: G, mention_user_id: null, proactive: false, status: "sent" as const, message_id: "5001", text: "图片生成好了",
      text_sha256: "", images: ["/a.png"], files: [], created_at: new Date(T0 * 1000).toISOString(), sent_at: new Date(T0 * 1000).toISOString() };
    s.recordSent(row, { selfId: "10001", replyTo: "40" });
    s.recordSent(row, { selfId: "10001", replyTo: "40" }); // 幂等
    const rows = s.recent(grp, { limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ message_id: "5001", is_self: 1, status: "已回复", image_count: 1, outbox_key: "group:1:call-1", reply_to_id: "40" });
    expect(formatMessage(rows[1]!, { now: T0 })).toMatch(/\[我\] → "图片生成好了"$/);
    // 旧版回复路径留下的行（处理中占位、生图、codex、失败）只读保留，照常格式化
    const db = new DatabaseSync(s.file);
    const legacy = db.prepare(`INSERT INTO messages (scope,message_id,time,user_id,nickname,is_self,text,outbox_key,status,action,detail,image_count)
      VALUES (?,?,?,'10001','我',1,?,?,?,?,?,?)`);
    legacy.run(`group:${G}`, "self:tk0", T0 + 1, "", "tk0", "处理中", null, null, null);
    legacy.run(`group:${G}`, "5002", T0 + 2, "图片好了", "tk1", "已回复", "generate_image", "a cute dog", 1);
    legacy.run(`group:${G}`, "5003", T0 + 3, "今晚有 ESL 决赛".repeat(20), "tk2", "已回复", "ask_codex", "high", 0);
    legacy.run(`group:${G}`, "5004", T0 + 4, "抱歉", "tk3", "失败", "fallback", null, 0);
    db.close();
    const lines = s.recent(grp, { limit: 4 }).map(r => formatMessage(r, { now: T0 }));
    expect(lines[0]).toMatch(/\[我\] → 处理中$/);
    expect(lines[1]).toMatch(/\[我\] → 生图 prompt="a cute dog" → 已发送 1 张图$/);
    expect(lines[2]).toContain('[我] → codex(high) → "今晚有 ESL 决赛');
    expect(lines[2]!.length).toBeLessThanOrEqual(6 + 120);
    expect(lines[3]).toMatch(/\[我\] → 失败$/);
    expect(s.search(grp, { query: "cute dog", days: 30, limit: 10, now: T0 })).toHaveLength(1);
  });

  it("old schema: messages.ticket is renamed to outbox_key once (index rebuilt, rows kept), reopening is a no-op", () => {
    const dir = tmp();
    const old = new DatabaseSync(`${dir}/qq-messages.sqlite`);
    old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, message_id TEXT NOT NULL, time INTEGER NOT NULL,
      user_id TEXT NOT NULL, nickname TEXT NOT NULL DEFAULT '', is_self INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', reply_to_id TEXT,
      action TEXT, detail TEXT, ticket TEXT, status TEXT, image_count INTEGER, UNIQUE (scope, message_id));
      CREATE UNIQUE INDEX messages_ticket ON messages(ticket) WHERE ticket IS NOT NULL;
      INSERT INTO messages (scope,message_id,time,user_id,is_self,text,ticket,status,action) VALUES ('group:${G}','9001',${T0},'10001',1,'旧回复','private:1:call-9','已回复','reply');`);
    old.close();
    const columns = (db: DatabaseSync) => (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map(c => c.name);
    const indexes = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'").all() as { name: string }[]).map(i => i.name);
    for (let i = 0; i < 2; i++) {
      const s = new ContextStore(dir, { tzOffsetSec: 0 });
      expect(s.message(grp, "9001")!.row).toMatchObject({ outbox_key: "private:1:call-9", text: "旧回复" });
      s.close();
      const check = new DatabaseSync(`${dir}/qq-messages.sqlite`, { readOnly: true });
      expect(columns(check)).toContain("outbox_key");
      expect(columns(check)).not.toContain("ticket");
      expect(indexes(check)).toContain("messages_outbox_key");
      expect(indexes(check)).not.toContain("messages_ticket");
      check.close();
    }
    // 只读连接（qq_context MCP）不迁移，读到的是主进程迁移后的库
    const ro = new ContextStore(dir, { readOnly: true });
    expect(ro.message(grp, "9001")!.row.outbox_key).toBe("private:1:call-9");
    ro.close();
    // 唯一索引仍按行键生效
    const s = new ContextStore(dir, { tzOffsetSec: 0 });
    const db = new DatabaseSync(`${dir}/qq-messages.sqlite`);
    expect(() => db.prepare("INSERT INTO messages (scope,message_id,time,user_id,outbox_key) VALUES ('group:1','x',1,'1','private:1:call-9')").run()).toThrow(/UNIQUE/);
    db.close(); s.close();
  });

  it("purge drops covered raw rows older than rawDays and summaries older than summaryDays", () => {
    const s = open();
    s.ingest(msg("old", { message_id: "50", time: T0 - 31 * 86400 }));
    s.ingest(msg("new", { message_id: "51", time: T0 - 29 * 86400 }));
    s.ingest(msg("uncovered", { message_id: "52", time: T0 - 35 * 86400 }));
    s.ingest(msg("other scope", { message_id: "53", time: T0 - 31 * 86400, group_id: OTHER }));
    s.writeSummary({ scope: `group:${G}`, level: "day", period_start: T0 - 32 * 86400, period_end: T0 - 30 * 86400, text: "覆盖", msg_count: 5 });
    s.writeSummary({ scope: `group:${G}`, level: "week", period_start: T0 - 200 * 86400, period_end: T0 - 193 * 86400, text: "古老", msg_count: 9 });
    s.writeSummary({ scope: `group:${G}`, level: "week", period_start: T0 - 20 * 86400, period_end: T0 - 13 * 86400, text: "较新", msg_count: 9 });
    expect(s.purge(T0, 30, 180)).toEqual({ messages: 1, summaries: 1 });
    expect(s.recent(grp, { limit: 10 }).map((r) => r.text)).toEqual(["uncovered", "new"]);
    expect(s.recent(all, { scope: `group:${OTHER}`, limit: 10 }).map((r) => r.text)).toEqual(["other scope"]);
    // 兜底上限：未覆盖的原始消息超过 hardMaxDays 也删除
    expect(s.purge(T0, 30, 180, 34)).toEqual({ messages: 1, summaries: 0 });
    expect(s.recent(all, { limit: 10 }).map((r) => r.text)).toEqual(["other scope", "new"]);
    expect(s.search(grp, { query: "古老", days: 365, limit: 10, now: T0 })).toEqual([]);
  });

  it("search merges summaries with raw messages, newest first, with summary labels", () => {
    const s = open();
    const day = Math.floor(Date.UTC(2026, 9, 15) / 1000);
    s.writeSummary({ scope: `group:${G}`, level: "day", period_start: day, period_end: day + 86400, text: "讨论了比赛安排", msg_count: 8 });
    const wk = Math.floor(Date.UTC(2026, 9, 6) / 1000);
    s.writeSummary({ scope: `group:${G}`, level: "week", period_start: wk, period_end: wk + 7 * 86400, text: "本周比赛总结", msg_count: 40 });
    s.writeSummary({ scope: `group:${OTHER}`, level: "day", period_start: day, period_end: day + 86400, text: "别群比赛", msg_count: 8 });
    s.ingest(msg("今晚有cs比赛吗", { message_id: "60", time: T0 }));
    const items = s.search(grp, { query: "比赛", days: 30, limit: 10, now: T0 });
    expect(items.map((i) => i.kind)).toEqual(["message", "summary", "summary"]);
    const text = formatSearch(items, 2500, { now: T0 });
    expect(text.split("\n")[1]).toBe("[日摘要 10-15] 讨论了比赛安排");
    expect(text.split("\n")[2]).toBe("[周摘要 10-06~10-12] 本周比赛总结");
  });
});

describe("format", () => {
  it("caps each message at 120 chars and the total at maxChars, keeping the newest lines for recent", () => {
    const s = open();
    for (let i = 0; i < 40; i++) s.ingest(msg(`第${i}条 ` + "长".repeat(300), { message_id: String(100 + i), time: T0 - 40 + i }));
    const rows = s.recent(grp, { limit: 40 });
    for (const r of rows) expect(formatMessage(r, { now: T0 }).length).toBeLessThanOrEqual(6 + 120);
    const text = formatRecent(rows, 2500, { now: T0 });
    expect(text.length).toBeLessThanOrEqual(2500);
    expect(text.split("\n")[0]).toMatch(/^（更早的 \d+ 条已省略）$/);
    expect(text).toContain("第39条");
    expect(text).not.toContain("第0条");
  });

  it("ids/showScope prefixes and non-today date prefix", () => {
    const s = open();
    s.ingest(msg("hi", { message_id: "77", time: T0 - 2 * 86400 }));
    const line = formatMessage(s.recent(all, { limit: 1 })[0]!, { ids: true, showScope: true, now: T0 });
    expect(line).toMatch(new RegExp(`^#77 \\[群${G}\\] 10-15 \\d\\d:\\d\\d De: hi$`));
  });

  it("joinCapped keeps the first lines for search order and notes the rest", () => {
    const out = joinCapped(["a".repeat(50), "b".repeat(50), "c".repeat(50)], 100, "first");
    expect(out.split("\n")).toEqual(["a".repeat(50), "（另有 2 条未显示）"]);
  });

  it("summary lines are capped at 400 chars", () => {
    const line = formatSummary({ id: 1, scope: `group:${G}`, level: "day", period_start: T0, period_end: T0 + 86400, text: "长".repeat(900), msg_count: 5, created_at: T0 });
    expect(line.length).toBeLessThanOrEqual(12 + 400);
  });
});
