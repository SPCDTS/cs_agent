/**
 * 票据与去重状态持久化（node:sqlite，WAL）。
 * 状态机：pending → sending → sent | uncertain；状态迁移带条件更新，跨进程也不会重复发送。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundMessage, ReplyTicketRecord, TicketStatus } from "./types.js";

export const SEEN_LIMIT = 2000;
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
  message_type: string;
  source_message_id: string;
  source_nickname: string;
  source_text: string | null;
  created_at: string;
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
    message_type: row.message_type === "group" ? "group" : "private",
    source_message_id: row.source_message_id,
    source_nickname: row.source_nickname,
    source_text: row.source_text ?? "",
    created_at: row.created_at,
    status: row.status as TicketStatus,
  };
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
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','uncertain')),
  attempted_at TEXT,
  sent_at TEXT,
  reply_message_id TEXT
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

  /** 旧库补列：source_text（崩溃对账需要原文）。 */
  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
    if (!columns.some(c => c.name === "source_text")) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN source_text TEXT NOT NULL DEFAULT ''");
    }
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
      (ticket_id, self_id, user_id, group_id, message_type, source_message_id, source_nickname, source_text, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(ticket, m.self_id, m.user_id, m.message_type === "group" ? m.group_id : null,
        m.message_type, m.message_id, m.nickname, m.text, now);
    return Number(result.changes) === 1;
  }

  get(ticket: string): ReplyTicketRecord | null {
    if (!isTicketId(ticket)) return null;
    const row = this.db.prepare("SELECT * FROM tickets WHERE ticket_id = ?").get(ticket) as TicketRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 仍为 pending 的票据，按 created_at 升序。 */
  listPending(limit = 200): ReplyTicketRecord[] {
    const n = Number.isInteger(limit) && limit > 0 ? limit : 200;
    const rows = this.db.prepare("SELECT * FROM tickets WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT ?")
      .all(n) as unknown as TicketRow[];
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
