import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILE, ReplyStore, inboundKey } from "../../src/qq/reply-store.js";
import type { InboundMessage } from "../../src/channel/types.js";

let dir: string;
let store: ReplyStore | null;

function msg(id: string, text = "hi " + id): InboundMessage {
  return {
    message_id: id, time: 1, message_type: "private", user_id: "20001", group_id: null, self_id: "10001",
    nickname: "n", text, route_text: text, truncated: false, mentioned_self: false, images: [], segments: [],
  };
}
const T = "private:20001";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reply-store-")); store = null; });
afterEach(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("ReplyStore Inbox", () => {
  it("群名与引用随输入保存，并在重新打开后恢复", () => {
    store = new ReplyStore(dir);
    const key = store.admit({ ...msg("group"), message_type: "group", group_id: "7", group_name: "家庭群",
      segments: [{ type: "reply", data: { id: "99" } }] }, "group:7")!;
    store.close(); store = new ReplyStore(dir);
    expect(store.getInbound(key)).toMatchObject({ kind: "user", scope: "group:7", thread_key: "group:7", group_name: "家庭群",
      reply_to: "99", state: "queued", message_id: "group", self_id: "10001" });
  });

  it("admit 以确定性入站键保存原文，重复消息返回 null", () => {
    store = new ReplyStore(dir);
    const key = store.admit(msg("1", "画一只猫"), T);
    expect(key).toBe(inboundKey(msg("1")));
    expect(store.getInbound(key!)).toMatchObject({ text: "画一只猫", route_text: "画一只猫", thread_key: T, scope: T });
    expect(store.admit(msg("1"), T)).toBeNull();
  });

  it("does not re-admit when the dedupe key was evicted but the input row exists (F8)", () => {
    store = new ReplyStore(dir);
    expect(store.admit(msg("7"), T)).not.toBeNull();
    // 模拟 seen_messages 淘汰
    const raw = new DatabaseSync(join(dir, DB_FILE));
    raw.exec("DELETE FROM seen_messages");
    raw.close();
    expect(store.admit(msg("7"), T)).toBeNull();
  });

  it("状态只前进：queued → delivered → done；turnId 首次写入后保留", () => {
    store = new ReplyStore(dir);
    const a = store.admit(msg("a"), T)!, b = store.admit(msg("b"), T)!;
    expect(store.listInbound("queued").map(r => r.key)).toEqual([a, b]);
    store.markInbound([a], "delivered", "turn-1");
    store.markInbound([a], "queued");
    expect(store.getInbound(a)).toMatchObject({ state: "delivered", turn_id: "turn-1" });
    store.markInbound([a, b], "done", "turn-2");
    expect(store.getInbound(a)).toMatchObject({ state: "done", turn_id: "turn-1" });
    expect(store.getInbound(b)).toMatchObject({ state: "done", turn_id: "turn-2" });
    store.markInbound([a], "delivered");
    expect(store.getInbound(a)!.state).toBe("done");
    expect(store.listInbound("queued")).toEqual([]);
    expect(store.latestInbound(T)!.key).toBe(b);
    expect(store.latestInbound("group:1")).toBeNull();
  });

  it("listInbound 按到达顺序分页", () => {
    store = new ReplyStore(dir);
    const keys = Array.from({ length: 5 }, (_, i) => store!.admit(msg(`q${i}`), T)!);
    const page1 = store.listInbound("queued", 2);
    expect(page1.map(r => r.key)).toEqual(keys.slice(0, 2));
    expect(store.listInbound("queued", 2, page1[1]!.seq).map(r => r.key)).toEqual(keys.slice(2, 4));
  });

  it("定时输入：幂等写入，重放不改变首次内容；绑定不一致或键非法即拒绝", () => {
    store = new ReplyStore(dir);
    const key = "run_" + "a".repeat(40);
    const input = { key, scope: "group:7", thread_key: "group:7", creator: "qq:9", text: "[定时任务] 第一次", time: 100 };
    const first = store.openScheduledInput(input);
    expect(first).toMatchObject({ kind: "scheduled", scope: "group:7", group_id: "7", message_type: "group", user_id: "9",
      self_id: "", message_id: "", text: "[定时任务] 第一次", state: "queued" });
    expect(store.openScheduledInput({ ...input, text: "改过的内容" })).toEqual(first);
    expect(() => store!.openScheduledInput({ ...input, creator: "qq:8" })).toThrow("绑定不一致");
    expect(() => store!.openScheduledInput({ ...input, key: "run_short" })).toThrow("定时输入无效");
    expect(() => store!.openScheduledInput({ ...input, key: "run_" + "b".repeat(40), creator: "9" })).toThrow("定时输入无效");
    store.close(); store = new ReplyStore(dir);
    expect(store.getInbound(key)).toEqual(first);
  });
});

describe("ReplyStore 旧票据（只读）", () => {
  it("旧库补列后可按票据号读取，非法票据号返回 null", () => {
    const raw = new DatabaseSync(join(dir, DB_FILE));
    raw.exec(`CREATE TABLE tickets (
      ticket_id TEXT PRIMARY KEY, self_id TEXT NOT NULL, user_id TEXT NOT NULL, group_id TEXT,
      message_type TEXT NOT NULL, source_message_id TEXT NOT NULL, source_nickname TEXT NOT NULL,
      created_at TEXT NOT NULL, status TEXT NOT NULL, attempted_at TEXT, sent_at TEXT, reply_message_id TEXT)`);
    const old = inboundKey(msg("old"));
    raw.prepare("INSERT INTO tickets (ticket_id, self_id, user_id, group_id, message_type, source_message_id, source_nickname, created_at, status, reply_message_id) VALUES (?, '10001', '20001', NULL, 'private', 'old', 'n', '2026-01-01T00:00:00.000Z', 'sent', '77')").run(old);
    raw.close();

    store = new ReplyStore(dir);
    expect(store.get(old)).toMatchObject({ ticket_id: old, status: "sent", reply_message_id: "77", source_text: "", self_id: "10001" });
    expect(store.get(old)?.source_route_text).toBeUndefined();
    expect(store.get("not-a-ticket")).toBeNull();
  });
});

describe("Outbox 迁移", () => {
  const OLD = `CREATE TABLE outbox (
    key TEXT PRIMARY KEY, ticket TEXT NOT NULL, ordinal INTEGER NOT NULL, call_id TEXT,
    message_type TEXT NOT NULL, target_id TEXT NOT NULL, mention_user_id TEXT,
    status TEXT NOT NULL, message_id TEXT, text TEXT NOT NULL, text_sha256 TEXT NOT NULL, images TEXT NOT NULL, files TEXT NOT NULL,
    created_at TEXT NOT NULL, sent_at TEXT, UNIQUE(ticket, call_id), UNIQUE(ticket, ordinal))`;
  const insert = (raw: DatabaseSync, key: string, ticketId: string, ordinal: number, proactive: number, text: string) =>
    raw.prepare(`INSERT INTO outbox (key,ticket,ordinal,call_id,message_type,target_id,mention_user_id,proactive,status,message_id,text,text_sha256,images,files,created_at,sent_at)
      VALUES (?,?,?,NULL,'group','8',NULL,?,'sent',?,?,'h','[]','[]','2026-10-20T00:00:00.000Z','2026-10-20T00:00:01.000Z')`)
      .run(key, ticketId, ordinal, proactive, `m-${ordinal}`, text);

  it("旧的按票据 Outbox 重建为按会话：行键保留、#fallback/#late 为系统行、主动标记与额度保留；重开幂等", () => {
    const raw = new DatabaseSync(join(dir, DB_FILE));
    raw.exec(OLD);
    raw.exec("ALTER TABLE outbox ADD COLUMN proactive INTEGER NOT NULL DEFAULT 0; ALTER TABLE outbox ADD COLUMN rejected TEXT");
    raw.exec("CREATE INDEX outbox_target_day ON outbox(message_type,target_id,created_at)");
    const t = "a".repeat(64);
    insert(raw, t + "#1", t, 1, 1, "模型消息");
    insert(raw, t + "#fallback", t, 2, 0, "兜底");
    insert(raw, t + "#late", t, 3, 0, "迟到图片");
    raw.close();

    store = new ReplyStore(dir);
    const model = store.getOutbox(t + "#1")!;
    expect(model).toMatchObject({ key: t + "#1", thread_key: t, turn_id: null, input_key: null, system: false, proactive: true,
      status: "sent", message_id: "m-1", text: "模型消息", target_id: "8" });
    expect(model).not.toHaveProperty("ticket");
    expect(store.getOutbox(t + "#fallback")).toMatchObject({ system: true, proactive: false, text: "兜底" });
    expect(store.getOutbox(t + "#late")).toMatchObject({ system: true });
    expect(store.countModelOutbox("group", "8", "2026-10-20", "2026-10-21")).toBe(1);
    store.close();

    store = new ReplyStore(dir);
    expect(store.getOutbox(t + "#1")).toEqual(model);
    const check = new DatabaseSync(join(dir, DB_FILE));
    try {
      expect((check.prepare("PRAGMA table_info(outbox)").all() as { name: string }[]).map(c => c.name)).toContain("thread_key");
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'outbox_v1'").get()).toBeUndefined();
      expect((check.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n).toBe(3);
    } finally { check.close(); }
    // 新键与旧行并存，同键重放取回原行。
    const fresh = store.reserveOutbox({ key: "group:8:call-1", thread_key: "group:8", turn_id: "pi:1:2", input_key: null,
      message_type: "group", target_id: "8", mention_user_id: null, text: "新消息", images: [], files: [], proactive: true });
    expect(store.reserveOutbox({ key: "group:8:call-1", thread_key: "group:8", turn_id: "other", input_key: null,
      message_type: "group", target_id: "8", mention_user_id: null, text: "另一条", images: [], files: [] })).toEqual(fresh);
    expect(store.listOutboxByTurn("pi:1:2").map(r => r.key)).toEqual(["group:8:call-1"]);
  });

  it("没有 proactive / rejected 列的更旧 Outbox 迁移为非主动", () => {
    const raw = new DatabaseSync(join(dir, DB_FILE));
    raw.exec(OLD);
    raw.prepare(`INSERT INTO outbox (key,ticket,ordinal,call_id,message_type,target_id,mention_user_id,status,message_id,text,text_sha256,images,files,created_at)
      VALUES ('old#1','old',1,NULL,'group','8',NULL,'pending',NULL,'旧消息','h','[]','[]','2026-10-20T00:00:00.000Z')`).run();
    raw.close();
    store = new ReplyStore(dir);
    expect(store.getOutbox("old#1")).toMatchObject({ thread_key: "old", proactive: false, system: false, status: "pending" });
    expect(store.countModelOutbox("group", "8", "2000", "2100")).toBe(0);
  });

  it("已发出但附件未传完的行可列出", () => {
    store = new ReplyStore(dir);
    const file = { filename: "/x/file-0", name: "a.txt", bytes: 1, sha256: "s", status: "pending" as const };
    const row = store.reserveOutbox({ key: "group:8:f", thread_key: "group:8", turn_id: null, input_key: null,
      message_type: "group", target_id: "8", mention_user_id: null, text: "带附件", images: [], files: [file] });
    expect(store.listUnfinishedOutbox()).toEqual([]);
    store.markOutboxSending(row.key); store.markOutboxSent(row.key, "9");
    expect(store.listUnfinishedOutbox().map(r => r.key)).toEqual([row.key]);
    store.updateOutboxFile(row.key, 0, "sending");
    expect(store.listUnfinishedOutbox().map(r => r.key)).toEqual([row.key]);
    store.updateOutboxFile(row.key, 0, "sent", "fid");
    expect(store.listUnfinishedOutbox()).toEqual([]);
  });
});
