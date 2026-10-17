import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILE, ReplyStore, ticketIdFor } from "../../src/qq/reply-store.js";
import type { InboundMessage } from "../../src/qq/types.js";

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
    expect(store.get(old)?.source_route_text).toBeUndefined();
    const t = store.admit(msg("new", "新消息"))!;
    expect(store.get(t)?.source_text).toBe("新消息");
    expect(store.listPending().map(r => r.ticket_id)).toEqual([old, t]);
  });
});
