import { inboundFromTicket } from "../../src/channel/ticket.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILE, ReplyStore, ticketIdFor } from "../../src/qq/reply-store.js";
import type { InboundMessage } from "../../src/channel/types.js";

let dir: string;
let store: ReplyStore | null;

function msg(id: string, text = "hi " + id): InboundMessage {
  return {
    message_id: id, time: 1, message_type: "private", user_id: "20001", group_id: null, self_id: "10001",
    nickname: "n", text, route_text: text, truncated: false, mentioned_self: false, images: [], segments: [],
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reply-store-")); store = null; });
afterEach(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("ReplyStore", () => {
  it("群名随票据保存并在重新打开后恢复", () => {
    store = new ReplyStore(dir);
    const ticket = store.admit({ ...msg("group"), message_type: "group", group_id: "7", group_name: "家庭群" })!;
    store.close(); store = new ReplyStore(dir);
    expect(inboundFromTicket(store.get(ticket)!).group_name).toBe("家庭群");
  });
  it("admit stores source_text and returns null for a repeat", () => {
    store = new ReplyStore(dir);
    const t = store.admit(msg("1", "画一只猫"));
    expect(t).toBe(ticketIdFor(msg("1")));
    expect(store.get(t!)?.source_text).toBe("画一只猫");
    expect(store.get(t!)?.source_route_text).toBe("画一只猫");
    expect(store.admit(msg("1"))).toBeNull();
  });

  it("does not re-admit when the dedupe key was evicted but the ticket row exists (F8)", () => {
    store = new ReplyStore(dir);
    expect(store.admit(msg("7"))).not.toBeNull();
    // 模拟 seen_messages 淘汰
    const raw = new DatabaseSync(join(dir, DB_FILE));
    raw.exec("DELETE FROM seen_messages");
    raw.close();
    expect(store.admit(msg("7"))).toBeNull();
  });

  it("listPending returns pending only, oldest first, honouring limit", () => {
    store = new ReplyStore(dir);
    const a = store.admit(msg("a"))!;
    const b = store.admit(msg("b"))!;
    const c = store.admit(msg("c"))!;
    expect(store.markSending(b)).toBe(true);
    store.markSent(b, "99");
    expect(store.listPending().map(r => r.ticket_id)).toEqual([a, c]);
    expect(store.listPending(1).map(r => r.ticket_id)).toEqual([a]);
  });

  it("exposes seq (admit order) and pages listPending with an afterSeq cursor (R6/R7)", () => {
    store = new ReplyStore(dir);
    const ids = Array.from({ length: 5 }, (_, i) => store!.admit(msg(`p${i}`))!);
    const seqs = ids.map(t => store!.get(t)!.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(5);
    store.markSending(ids[1]!);
    const page1 = store.listPending(2);
    expect(page1.map(r => r.ticket_id)).toEqual([ids[0], ids[2]]);
    const page2 = store.listPending(2, page1[1]!.seq);
    expect(page2.map(r => r.ticket_id)).toEqual([ids[3], ids[4]]);
    expect(store.listPending(2, page2[1]!.seq)).toEqual([]);
  });

  it("migrates an old database without source_text", () => {
    const raw = new DatabaseSync(join(dir, DB_FILE));
    raw.exec(`CREATE TABLE tickets (
      ticket_id TEXT PRIMARY KEY, self_id TEXT NOT NULL, user_id TEXT NOT NULL, group_id TEXT,
      message_type TEXT NOT NULL, source_message_id TEXT NOT NULL, source_nickname TEXT NOT NULL,
      created_at TEXT NOT NULL, status TEXT NOT NULL, attempted_at TEXT, sent_at TEXT, reply_message_id TEXT)`);
    const old = ticketIdFor(msg("old"));
    raw.prepare("INSERT INTO tickets (ticket_id, self_id, user_id, group_id, message_type, source_message_id, source_nickname, created_at, status) VALUES (?, '10001', '20001', NULL, 'private', 'old', 'n', '2026-01-01T00:00:00.000Z', 'pending')").run(old);
    raw.close();

    store = new ReplyStore(dir);
    expect(store.get(old)?.source_text).toBe("");
    expect(inboundFromTicket(store.get(old)!).group_name).toBeUndefined();
    expect(store.get(old)?.source_route_text).toBeUndefined();
    const t = store.admit(msg("new", "新消息"))!;
    expect(store.get(t)?.source_text).toBe("新消息");
    expect(store.listPending().map(r => r.ticket_id)).toEqual([old, t]);
    expect(store.get(old)?.origin).toBe("message");
    expect(store.get(old)?.target_id).toBeUndefined();
    const ticket = "run_" + "d".repeat(40);
    store.openOutbound(ticket, { origin: "scheduled", message_type: "private", target_id: "20001", user_id: "9", self_id: "10001" });
    const row = store.reserveOutbox({ ticket, call_id: "target", message_type: "group", target_id: "8",
      proactive: true, mention_user_id: null, text: "迁移后主动发送", images: [], files: [],
      dailyLimit: { start: "2000-01-01T00:00:00.000Z", end: "2100-01-01T00:00:00.000Z", limit: 100 } });
    store.close(); store = new ReplyStore(dir);
    expect(store.get(ticket)).toMatchObject({ origin: "scheduled", target_id: "20001", user_id: "9" });
    expect(store.getOutbox(row.key)).toEqual(row);
    expect(store.countModelOutbox("group", "8", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")).toBe(1);
  });
});


it("旧 Outbox 行迁移为非主动，重开后保留显式主动标记", () => {
  store = new ReplyStore(dir);
  const old = store.reserveOutbox({ ticket: "old", call_id: null, message_type: "group", target_id: "8",
    mention_user_id: null, text: "旧消息", images: [], files: [], proactive: true });
  store.close();
  const raw = new DatabaseSync(join(dir, DB_FILE));
  raw.exec("ALTER TABLE outbox DROP COLUMN proactive");
  raw.close();
  store = new ReplyStore(dir);
  expect(store.getOutbox(old.key)?.proactive).toBe(false);
  expect(store.countModelOutbox("group", "8", "2000", "2100")).toBe(0);
  const current = store.reserveOutbox({ ticket: "new", call_id: null, message_type: "group", target_id: "8",
    mention_user_id: null, text: "新主动消息", images: [], files: [], proactive: true });
  store.close(); store = new ReplyStore(dir);
  expect(store.getOutbox(current.key)?.proactive).toBe(true);
  expect(store.countModelOutbox("group", "8", "2000", "2100")).toBe(1);
});
