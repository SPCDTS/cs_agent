import { afterEach, describe, expect, it, vi } from "vitest";
import { accessForSource, parseAccess, resolveOwner, type Access } from "../../src/context/access.js";
import { formatMessage, formatRecent, formatSearch, formatSummary, joinCapped } from "../../src/context/format.js";
import { ContextStore } from "../../src/context/store.js";
import type { InboundMessage } from "../../src/qq/types.js";
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
    segments: o.replyTo ? [{ type: "reply", data: { id: o.replyTo } }, { type: "text", data: { text } }] : [{ type: "text", data: { text } }],
  };
}

describe("access", () => {
  it("parses QQ_ACCESS and derives access from a ticket source", () => {
    expect(parseAccess("all")).toEqual({ kind: "all" });
    expect(parseAccess(`group:${G}`)).toEqual(grp);
    expect(parseAccess("private:10000001")).toEqual({ kind: "scope", scope: "private:10000001" });
    for (const bad of [undefined, "", "group:", "group:abc", "everyone", "group:1;rm"]) expect(parseAccess(bad)).toBeUndefined();
    expect(accessForSource({ type: "group", user_id: "1", group_id: G }, "1")).toEqual(grp);
    expect(accessForSource({ type: "private", user_id: "10000001", group_id: null }, "10000001")).toEqual(all);
    expect(accessForSource({ type: "private", user_id: "555", group_id: null }, "10000001")).toEqual({ kind: "scope", scope: "private:555" });
    expect(resolveOwner("", ["111", "222"])).toBe("111");
    expect(resolveOwner("333", ["111"])).toBe("333");
    expect(resolveOwner("", "*")).toBeUndefined();
  });
});

describe("ContextStore", () => {
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

  it("bot rows: pending → completed with action/detail/excerpt/images; real reply id replaces placeholder", () => {
    const s = open();
    s.ingest(msg("画一只狗", { message_id: "40", time: T0 }));
    s.recordPending(`group:${G}`, "tk1", T0, { replyTo: "40" });
    s.recordPending(`group:${G}`, "tk1", T0, { replyTo: "40" }); // 幂等
    let rows = s.recent(grp, { limit: 10 });
    expect(rows).toHaveLength(2);
    expect(formatMessage(rows[1]!, { now: T0 })).toMatch(/^\d\d:\d\d \[我\] → 处理中$/);
    s.completeReply("tk1", {
      action: "generate_image", detail: "a cute dog, photorealistic", excerpt: "图片生成好了", image_count: 1, status: "已回复",
      reply_message_id: "5001",
    });
    rows = s.recent(grp, { limit: 10 });
    expect(rows[1]).toMatchObject({ message_id: "5001", is_self: 1, status: "已回复", image_count: 1 });
    expect(formatMessage(rows[1]!, { now: T0 })).toMatch(/\[我\] → 生图 prompt="a cute dog, photorealistic" → 已发送 1 张图$/);
    // 机器人行的提示词可被检索到
    expect(s.search(grp, { query: "cute dog", days: 30, limit: 10, now: T0 })).toHaveLength(1);
    s.recordPending(`group:${G}`, "tk2", T0 + 1);
    s.completeReply("tk2", { action: "ask_codex", detail: "high", excerpt: "今晚有 ESL 决赛".repeat(20), status: "已回复" });
    const codexLine = formatMessage(s.recent(grp, { limit: 1 })[0]!, { now: T0 });
    expect(codexLine).toContain('[我] → codex(high) → "今晚有 ESL 决赛');
    expect(codexLine.length).toBeLessThanOrEqual(6 + 120);
    s.recordPending(`group:${G}`, "tk3", T0 + 2);
    s.completeReply("tk3", { action: "fallback", excerpt: "抱歉", status: "失败" });
    expect(formatMessage(s.recent(grp, { limit: 1 })[0]!, { now: T0 })).toMatch(/\[我\] → 失败$/);
  });

  it("completeReply renames self:<ticket> atomically and logs (not throws) on rename conflicts", () => {
    const s = open();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      s.recordPending(`group:${G}`, "tkA", T0);
      expect(s.completeReply("tkA", { action: "reply", excerpt: "好", status: "已回复", reply_message_id: "7001" })).toBe(true);
      // 重放同一结果：幂等，不报冲突
      expect(s.completeReply("tkA", { action: "reply", excerpt: "好", status: "已回复", reply_message_id: "7001" })).toBe(true);
      // 冲突：同 scope 已有 message_id=7002 的入站消息 → 内容照常更新，占位 id 保留，记一条 warn
      s.ingest(msg("别人的消息", { message_id: "7002" }));
      s.recordPending(`group:${G}`, "tkB", T0 + 1);
      expect(s.completeReply("tkB", { action: "reply", excerpt: "第二条", status: "已回复", reply_message_id: "7002" })).toBe(true);
      const rows = s.recent(grp, { limit: 10 });
      expect(rows.map((r) => [r.message_id, r.text])).toEqual([
        ["7001", "好"], ["7002", "别人的消息"], ["self:tkB", "第二条"],
      ]);
      const logged = err.mock.calls.map((c) => String(c[0]));
      expect(logged.filter((l) => l.includes("rename conflict"))).toHaveLength(1);
      // 找不到机器人行：返回 false 并记日志
      expect(s.completeReply("nope", { action: "reply", status: "失败", reply_message_id: "7003" })).toBe(false);
      expect(err.mock.calls.map((c) => String(c[0])).some((l) => l.includes("no bot row"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("completeReply rolls back the content update when the rename fails", () => {
    const s = open();
    s.recordPending(`group:${G}`, "tkC", T0);
    const db = (s as unknown as { db: { prepare(sql: string): unknown } }).db;
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("UPDATE messages SET message_id")) throw new Error("disk I/O error");
      return realPrepare(sql);
    });
    try {
      expect(() => s.completeReply("tkC", { action: "reply", excerpt: "不应留下", status: "已回复", reply_message_id: "7100" })).toThrow(/disk I\/O/);
    } finally {
      spy.mockRestore();
    }
    expect(s.recent(grp, { limit: 1 })[0]).toMatchObject({ message_id: "self:tkC", text: "", status: "处理中" });
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
