/**
 * 票据与去重状态持久化（node:sqlite，WAL）。
 * 状态机：pending → sending → sent | uncertain；状态迁移带条件更新，跨进程也不会重复发送。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundMessage, ReplyTicketRecord, TicketStatus } from "../channel/types.js";

import { isModelOutboxRow, type OutboxInput, type OutboxRow } from "../channel/outbox.js";

const SEEN_LIMIT = 2000;
export const DB_FILE = "qq-bridge.sqlite";
const TICKET_PATTERN = /^[a-f0-9]{64}$/;

export function isTicketId(value: string): boolean {
  return typeof value === "string" && TICKET_PATTERN.test(value);
}

/** 决定性票据 ID：sha256(self_id:group:group_id:user_id:message_id | self_id:private:user_id:message_id)。 */
export function ticketIdFor(m: Pick<InboundMessage, "self_id" | "message_type" | "group_id" | "user_id" | "message_id">): string {
  const key = m.message_type === "group"
    ? [m.self_id, "group", m.group_id ?? "", m.user_id, m.message_id].join(":")
    : [m.self_id, "private", m.user_id, m.message_id].join(":");
  return createHash("sha256").update(key).digest("hex");
}

/** 去重键：self_id:message_type:group_id:user_id:message_id。 */
export function dedupeKey(m: Pick<InboundMessage, "self_id" | "message_type" | "group_id" | "user_id" | "message_id">): string {
  return [m.self_id, m.message_type, m.group_id ?? "", m.user_id, m.message_id].join(":");
}

interface TicketRow {
  ticket_id: string;
  self_id: string;
  user_id: string;
  group_id: string | null;
  group_name: string | null;
  message_type: string;
  source_message_id: string;
  source_nickname: string;
  source_text: string | null;
  source_route_text: string | null;
  source_images: string | null;
  attachments: string | null;
  source_image_error: string | null;
  created_at: string;
  seq: number;
  status: string;
  attempted_at: string | null;
  sent_at: string | null;
  reply_message_id: string | null;
}

function toRecord(row: TicketRow): ReplyTicketRecord {
  const record: ReplyTicketRecord = {
    ticket_id: row.ticket_id,
    self_id: row.self_id,
    user_id: row.user_id,
    group_id: row.group_id,
    ...(row.group_name ? { group_name: row.group_name } : {}),
    message_type: row.message_type === "group" ? "group" : "private",
    source_message_id: row.source_message_id,
    source_nickname: row.source_nickname,
    source_text: row.source_text ?? "",
    attachments: row.attachments ? JSON.parse(row.attachments) : [],
    source_images: row.source_images ? JSON.parse(row.source_images) : [],
    ...(row.source_image_error ? { source_image_error: row.source_image_error } : {}),
    created_at: row.created_at,
    seq: Number(row.seq),
    status: row.status as TicketStatus,
  };
  if (row.source_route_text !== null && row.source_route_text !== undefined) record.source_route_text = row.source_route_text;
  if (row.attempted_at !== null) record.attempted_at = row.attempted_at;
  if (row.sent_at !== null) record.sent_at = row.sent_at;
  if (row.reply_message_id !== null) record.reply_message_id = row.reply_message_id;
  return record;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  ticket_id TEXT PRIMARY KEY,
  self_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT,
  message_type TEXT NOT NULL CHECK (message_type IN ('private','group')),
  source_message_id TEXT NOT NULL,
  source_nickname TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  source_route_text TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','uncertain')),
  attempted_at TEXT,
  sent_at TEXT,
  reply_message_id TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  key TEXT PRIMARY KEY, ticket TEXT NOT NULL, ordinal INTEGER NOT NULL, call_id TEXT,
  message_type TEXT NOT NULL, target_id TEXT NOT NULL, mention_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','uncertain')),
  message_id TEXT, text TEXT NOT NULL, text_sha256 TEXT NOT NULL, images TEXT NOT NULL, files TEXT NOT NULL,
  created_at TEXT NOT NULL, sent_at TEXT, UNIQUE(ticket, call_id), UNIQUE(ticket, ordinal)
);
CREATE TABLE IF NOT EXISTS seen_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  seen_at TEXT NOT NULL
);
`;

export class ReplyStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, DB_FILE));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 旧库补列：source_text（崩溃对账需要原文）、source_route_text（分流文本；旧行保持 NULL）。 */
  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
    if (!columns.some(c => c.name === "group_name")) this.db.exec("ALTER TABLE tickets ADD COLUMN group_name TEXT");
    if (!columns.some(c => c.name === "attachments")) this.db.exec("ALTER TABLE tickets ADD COLUMN attachments TEXT");
    if (!columns.some(c => c.name === "source_images")) this.db.exec("ALTER TABLE tickets ADD COLUMN source_images TEXT");
    if (!columns.some(c => c.name === "source_image_error")) this.db.exec("ALTER TABLE tickets ADD COLUMN source_image_error TEXT");
    if (!columns.some(c => c.name === "source_text")) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN source_text TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some(c => c.name === "source_route_text")) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN source_route_text TEXT");
    }
  }

  getOutbox(key: string): OutboxRow | null {
    const row = this.db.prepare("SELECT * FROM outbox WHERE key = ?").get(key);
    return row ? { ...row, images: JSON.parse(String(row.images)), files: JSON.parse(String(row.files)) } as OutboxRow : null;
  }

  listOutbox(ticket: string): OutboxRow[] {
    return (this.db.prepare("SELECT key FROM outbox WHERE ticket = ? ORDER BY ordinal").all(ticket) as { key: string }[])
      .map(row => this.getOutbox(row.key)!);
  }

  reserveOutbox(input: OutboxInput): OutboxRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.listOutbox(input.ticket), modelRows = rows.filter(isModelOutboxRow);
      const existing = input.call_id ? rows.find(row => row.call_id === input.call_id)
        : input.suffix ? rows.find(row => row.key === input.ticket + "#" + input.suffix)
        : rows.find(row => row.key === input.ticket + "#" + input.sequence);
      if (existing) { this.db.exec("COMMIT"); return existing; }
      if (!input.suffix && modelRows.length >= 3) throw new Error("本回合最多发送 3 条消息");
      const ordinal = (rows.at(-1)?.ordinal ?? 0) + 1;
      const key = input.ticket + "#" + (input.suffix ?? input.sequence ?? modelRows.length + 1);
      this.db.prepare(`INSERT INTO outbox
        (key,ticket,ordinal,call_id,message_type,target_id,mention_user_id,status,text,text_sha256,images,files,created_at)
        VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?)`).run(key, input.ticket, ordinal, input.call_id,
        input.message_type, input.target_id, input.mention_user_id, input.text,
        createHash("sha256").update(input.text).digest("hex"), JSON.stringify(input.images), JSON.stringify(input.files), new Date().toISOString());
      this.db.exec("COMMIT");
      return this.getOutbox(key)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  markOutboxSending(key: string): boolean {
    return Number(this.db.prepare(`UPDATE outbox SET status='sending',
      mention_user_id=CASE WHEN EXISTS (SELECT 1 FROM outbox prior WHERE prior.ticket=outbox.ticket AND prior.status<>'pending')
        THEN NULL ELSE mention_user_id END WHERE key=? AND status='pending'`).run(key).changes) === 1;
  }
  markOutboxSent(key: string, messageId: string): void {
    this.db.prepare("UPDATE outbox SET status='sent', message_id=?, sent_at=? WHERE key=? AND status='sending'")
      .run(messageId, new Date().toISOString(), key);
  }
  markOutboxUncertain(key: string): void {
    this.db.prepare("UPDATE outbox SET status='uncertain' WHERE key=? AND status='sending'").run(key);
  }
  updateOutboxFile(key: string, index: number, status: OutboxRow["status"], fileId?: string): void {
    const row = this.getOutbox(key);
    if (!row?.files[index]) throw new Error("Outbox 附件不存在");
    const file = row.files[index]!;
    const valid = file.status === "pending" && status === "sending" ||
      file.status === "sending" && (status === "sent" || status === "uncertain");
    if (!valid) throw new Error("Outbox 附件状态已改变");
    const before = JSON.stringify(row.files);
    file.status = status;
    if (fileId) file.file_id = fileId;
    if (Number(this.db.prepare("UPDATE outbox SET files=? WHERE key=? AND files=?")
      .run(JSON.stringify(row.files), key, before).changes) !== 1) throw new Error("Outbox 附件状态已改变");
  }
  settleTicket(ticket: string): void {
    const rows = this.listOutbox(ticket);
    if (!rows.some(row => row.status !== "pending")) throw new Error("本回合尚无消息发送");
    this.db.prepare("UPDATE tickets SET status='sent', reply_message_id=?, sent_at=? WHERE ticket_id=? AND status='pending'")
      .run(rows.find(row => row.status === "sent")?.message_id ?? null, new Date().toISOString(), ticket);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /**
   * 原子地登记一条已触发消息：去重 + 建票据（已存在则保留原记录）。
   * 返回 null 表示重复消息：去重键已见过，或票据行早已存在（去重键被淘汰后再次到达），
   * 两种情况都不得再次派发。
   */
  admit(m: InboundMessage): string | null {
    const ticket = ticketIdFor(m);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seen = this.db.prepare("INSERT OR IGNORE INTO seen_messages (key, seen_at) VALUES (?, ?)").run(dedupeKey(m), now);
      if (Number(seen.changes) === 0) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare("DELETE FROM seen_messages WHERE id <= (SELECT MAX(id) FROM seen_messages) - ?").run(SEEN_LIMIT);
      const created = this.insertTicket(ticket, m, now);
      this.db.exec("COMMIT");
      return created ? ticket : null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 建票据；已存在时保留原记录。返回票据 ID。 */
  createTicket(m: InboundMessage): string {
    const ticket = ticketIdFor(m);
    this.insertTicket(ticket, m, new Date().toISOString());
    return ticket;
  }

  /** 返回 true 表示新建了票据行；false 表示已存在（保留原记录）。 */
  private insertTicket(ticket: string, m: InboundMessage, now: string): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO tickets
      (ticket_id, self_id, user_id, group_id, message_type, source_message_id, source_nickname, source_text, source_route_text, source_images, source_image_error, attachments, created_at, group_name, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(ticket, m.self_id, m.user_id, m.message_type === "group" ? m.group_id : null,
        m.message_type, m.message_id, m.nickname, m.text, m.route_text, JSON.stringify(m.images), m.image_error ?? null, JSON.stringify(m.attachments ?? []), now, m.group_name ?? null);
    return Number(result.changes) === 1;
  }

  setGroupName(ticket: string, name: string): void {
    this.db.prepare("UPDATE tickets SET group_name = ? WHERE ticket_id = ?").run(name, ticket);
  }

  finishAttachments(ticket: string, attachments: NonNullable<InboundMessage['attachments']>, error?: string): void {
    this.db.prepare('UPDATE tickets SET attachments = ?, source_images = ?, source_image_error = ? WHERE ticket_id = ?')
      .run(JSON.stringify(attachments), JSON.stringify(attachments.flatMap(a => a.path ? [a.path] : [])), error ?? null, ticket);
  }

  get(ticket: string): ReplyTicketRecord | null {
    if (!isTicketId(ticket)) return null;
    const row = this.db.prepare("SELECT rowid AS seq, * FROM tickets WHERE ticket_id = ?").get(ticket) as TicketRow | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * 仍为 pending 的票据，按 admit 顺序（seq = rowid 升序；与 created_at 在同一事务内分配）。
   * afterSeq 为游标：只返回 seq 大于它的行，用于分页直到取尽。
   */
  listPending(limit = 200, afterSeq = 0): ReplyTicketRecord[] {
    const n = Number.isInteger(limit) && limit > 0 ? limit : 200;
    const after = Number.isInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;
    const rows = this.db.prepare("SELECT rowid AS seq, * FROM tickets WHERE status = 'pending' AND rowid > ? ORDER BY rowid ASC LIMIT ?")
      .all(after, n) as unknown as TicketRow[];
    return rows.map(toRecord);
  }

  /** pending → sending；返回 false 表示状态已被改变（不可发送）。 */
  markSending(ticket: string): boolean {
    const result = this.db.prepare("UPDATE tickets SET status = 'sending', attempted_at = ? WHERE ticket_id = ? AND status = 'pending'")
      .run(new Date().toISOString(), ticket);
    return Number(result.changes) === 1;
  }

  markUncertain(ticket: string): void {
    this.db.prepare("UPDATE tickets SET status = 'uncertain' WHERE ticket_id = ? AND status = 'sending'").run(ticket);
  }

  markSent(ticket: string, replyMessageId: string): void {
    this.db.prepare("UPDATE tickets SET status = 'sent', reply_message_id = ?, sent_at = ? WHERE ticket_id = ? AND status = 'sending'")
      .run(replyMessageId, new Date().toISOString(), ticket);
  }
}
