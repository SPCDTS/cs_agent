/**
 * 入站输入与 Outbox 的持久化（node:sqlite，WAL）。
 * - inbound（Inbox，设计 §4.1）：每条触发消息 / 定时输入一行，state 只前进：queued → delivered → done；
 * - outbox（§7.4）：pending → sending → sent | uncertain，状态迁移带条件更新，跨进程也不会重复发送；
 * 库里旧版遗留的 tickets 表原样留在磁盘上，不再读写。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatType, InboundMessage, InboundRecord, InboundState, ScheduledInput } from "../channel/types.js";

import type { OutboxInput, OutboxRow } from "../channel/outbox.js";
import { isSendRuleError, type SendBreaker, type SendRuleLimits } from "../channel/send-rules.js";
import { SendRules } from "./send-rules.js";

const SEEN_LIMIT = 2000;
export const DB_FILE = "qq-bridge.sqlite";
/** 决定性入站键：sha256(self_id:group:group_id:user_id:message_id | self_id:private:user_id:message_id)。 */
export function inboundKey(m: Pick<InboundMessage, "self_id" | "message_type" | "group_id" | "user_id" | "message_id">): string {
  const key = m.message_type === "group"
    ? [m.self_id, "group", m.group_id ?? "", m.user_id, m.message_id].join(":")
    : [m.self_id, "private", m.user_id, m.message_id].join(":");
  return createHash("sha256").update(key).digest("hex");
}

/** 去重键：self_id:message_type:group_id:user_id:message_id。 */
export function dedupeKey(m: Pick<InboundMessage, "self_id" | "message_type" | "group_id" | "user_id" | "message_id">): string {
  return [m.self_id, m.message_type, m.group_id ?? "", m.user_id, m.message_id].join(":");
}

interface InboundRow {
  seq: number; key: string; kind: string; scope: string; thread_key: string; self_id: string; user_id: string;
  group_id: string | null; group_name: string | null; message_type: string; message_id: string; nickname: string;
  text: string; route_text: string; reply_to: string | null; time: number; images: string; attachments: string;
  image_error: string | null; created_at: string; state: string; turn_id: string | null;
}

function toInbound(row: InboundRow): InboundRecord {
  return {
    key: row.key, kind: row.kind === "scheduled" ? "scheduled" : "user", seq: Number(row.seq), scope: row.scope,
    thread_key: row.thread_key, self_id: row.self_id, user_id: row.user_id, group_id: row.group_id,
    ...(row.group_name ? { group_name: row.group_name } : {}),
    message_type: row.message_type === "group" ? "group" : "private", message_id: row.message_id, nickname: row.nickname,
    text: row.text, route_text: row.route_text, ...(row.reply_to ? { reply_to: row.reply_to } : {}), time: Number(row.time),
    images: JSON.parse(row.images), attachments: JSON.parse(row.attachments),
    ...(row.image_error ? { image_error: row.image_error } : {}),
    created_at: row.created_at, state: row.state as InboundState, ...(row.turn_id ? { turn_id: row.turn_id } : {}),
  };
}

const STATE_RANK: Record<InboundState, number> = { queued: 0, delivered: 1, done: 2 };

const OUTBOX_TABLE = `
CREATE TABLE IF NOT EXISTS outbox (
  key TEXT PRIMARY KEY, thread_key TEXT NOT NULL, turn_id TEXT, input_key TEXT, system INTEGER NOT NULL DEFAULT 0,
  message_type TEXT NOT NULL, target_id TEXT NOT NULL, mention_user_id TEXT, proactive INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','uncertain')),
  message_id TEXT, text TEXT NOT NULL, text_sha256 TEXT NOT NULL, images TEXT NOT NULL, files TEXT NOT NULL,
  created_at TEXT NOT NULL, sent_at TEXT, rejected TEXT
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbound (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('user','scheduled')),
  scope TEXT NOT NULL, thread_key TEXT NOT NULL, self_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL,
  group_id TEXT, group_name TEXT, message_type TEXT NOT NULL CHECK (message_type IN ('private','group')),
  message_id TEXT NOT NULL DEFAULT '', nickname TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  route_text TEXT NOT NULL DEFAULT '', reply_to TEXT, time INTEGER NOT NULL,
  images TEXT NOT NULL DEFAULT '[]', attachments TEXT NOT NULL DEFAULT '[]', image_error TEXT,
  created_at TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued','delivered','done')), turn_id TEXT
);
CREATE INDEX IF NOT EXISTS inbound_state ON inbound(state);
CREATE INDEX IF NOT EXISTS inbound_thread ON inbound(thread_key);
CREATE TABLE IF NOT EXISTS seen_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  seen_at TEXT NOT NULL
);
`;

export class ReplyStore {
  private readonly db: DatabaseSync;
  private readonly rules: SendRules;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, DB_FILE));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.rules = new SendRules(this.db);
  }

  private columns(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
  }

  /**
   * 幂等迁移：
   * - 旧 outbox（按票据：ticket/ordinal/call_id，UNIQUE(ticket, ordinal)）整表重建为按会话的新表：
   *   thread_key 保留原入站键、#late/#fallback 行标为系统消息，主动额度所需的 proactive/created_at 原样保留。
   */
  private migrate(): void {
    const outbox = this.columns("outbox");
    if (outbox.includes("ticket")) {
      if (!outbox.includes("proactive")) this.db.exec("ALTER TABLE outbox ADD COLUMN proactive INTEGER NOT NULL DEFAULT 0");
      if (!outbox.includes("rejected")) this.db.exec("ALTER TABLE outbox ADD COLUMN rejected TEXT");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("DROP INDEX IF EXISTS outbox_target_day; ALTER TABLE outbox RENAME TO outbox_v1;");
        this.db.exec(OUTBOX_TABLE);
        this.db.exec(`INSERT INTO outbox (key,thread_key,turn_id,input_key,system,message_type,target_id,mention_user_id,proactive,
          status,message_id,text,text_sha256,images,files,created_at,sent_at,rejected)
          SELECT key,ticket,NULL,NULL,CASE WHEN key = ticket || '#late' OR key = ticket || '#fallback' THEN 1 ELSE 0 END,
          message_type,target_id,mention_user_id,proactive,status,message_id,text,text_sha256,images,files,created_at,sent_at,rejected
          FROM outbox_v1 ORDER BY rowid; DROP TABLE outbox_v1;`);
        this.db.exec("COMMIT");
      } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    } else this.db.exec(OUTBOX_TABLE);
    this.db.exec(`CREATE INDEX IF NOT EXISTS outbox_target_day ON outbox(message_type,target_id,created_at);
      CREATE INDEX IF NOT EXISTS outbox_turn ON outbox(turn_id);`);
  }

  // ---------- Outbox ----------

  getOutbox(key: string): OutboxRow | null {
    const row = this.db.prepare("SELECT * FROM outbox WHERE key = ?").get(key);
    if (!row) return null;
    const { rejected: _rejected, ...rest } = row;
    return { ...rest, proactive: row.proactive === 1, system: row.system === 1,
      images: JSON.parse(String(row.images)), files: JSON.parse(String(row.files)) } as OutboxRow;
  }

  private rows(sql: string, ...args: (string | number)[]): OutboxRow[] {
    return (this.db.prepare(sql).all(...args) as { key: string }[]).map(row => this.getOutbox(row.key)!);
  }

  listOutboxByTurn(turnId: string): OutboxRow[] {
    return this.rows("SELECT key FROM outbox WHERE turn_id = ? ORDER BY rowid", turnId);
  }

  listUnfinishedOutbox(): OutboxRow[] {
    return this.rows(`SELECT key FROM outbox WHERE status = 'sent'
      AND (files LIKE '%"status":"pending"%' OR files LIKE '%"status":"sending"%') ORDER BY rowid`);
  }

  countModelOutbox(type: ChatType, targetId: string, start: string, end: string): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM outbox WHERE message_type=? AND target_id=?
      AND proactive=1 AND system=0 AND rejected IS NULL AND created_at>=? AND created_at<?`)
      .get(type, targetId, start, end) as { n: number };
    return row.n;
  }

  reserveOutbox(input: OutboxInput): OutboxRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getOutbox(input.key);
      if (existing) { this.db.exec("COMMIT"); return existing; }
      if (input.proactive && input.dailyLimit && this.countModelOutbox(input.message_type, input.target_id, input.dailyLimit.start, input.dailyLimit.end) >= input.dailyLimit.limit) {
        throw new Error("该 target 当天最多主动发送 100 条消息（Asia/Shanghai）");
      }
      this.db.prepare(`INSERT INTO outbox
        (key,thread_key,turn_id,input_key,system,message_type,target_id,mention_user_id,proactive,status,text,text_sha256,images,files,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`).run(input.key, input.thread_key, input.turn_id, input.input_key,
        input.system ? 1 : 0, input.message_type, input.target_id, input.mention_user_id, input.proactive ? 1 : 0, input.text,
        createHash("sha256").update(input.text).digest("hex"), JSON.stringify(input.images), JSON.stringify(input.files), new Date().toISOString());
      this.db.exec("COMMIT");
      return this.getOutbox(input.key)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  markOutboxSending(key: string): boolean {
    return Number(this.db.prepare("UPDATE outbox SET status='sending', rejected=NULL WHERE key=? AND status='pending'").run(key).changes) === 1;
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
  /**
   * 发送规则检查 + pending → sending + 记数，同一写事务内完成。被规则拒绝时行保持 pending 并记下原因，
   * 抛 SendRuleError；返回 false 表示状态已被改变（不可发送，也不记数）。
   */
  beginOutboxSend(key: string, limits: SendRuleLimits, now: number): boolean {
    const row = this.getOutbox(key);
    if (!row) return false;
    return this.admitSend(`${row.message_type}:${row.target_id}`, limits, now, () => this.markOutboxSending(key),
      reason => { this.db.prepare("UPDATE outbox SET rejected=? WHERE key=? AND status='pending'").run(reason, key); });
  }

  private admitSend(scope: string, limits: SendRuleLimits, now: number, mark: () => boolean, reject: (reason: string) => void): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let rejected: unknown;
      try { this.rules.check(scope, limits, now); }
      catch (error) {
        if (!isSendRuleError(error)) throw error;
        reject(error.message); rejected = error;
      }
      // 熔断行与拒绝原因须提交；只有接纳且状态迁移成功的发送才记数。
      const accepted = !rejected && mark();
      if (accepted) this.rules.record(scope, now);
      this.db.exec("COMMIT");
      if (rejected) throw rejected;
      return accepted;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  sendBreakers(now: number): SendBreaker[] { return this.rules.breakers(now); }
  resetSendBreaker(scope: string, now: number): boolean { return this.rules.reset(scope, now); }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  // ---------- Inbox ----------

  /**
   * 原子地登记一条已触发消息：去重 + 写入 inbound（queued）。
   * 返回 null 表示重复消息：去重键已见过，或输入行早已存在（去重键被淘汰后再次到达），两种情况都不得再次投递。
   */
  admit(m: InboundMessage, threadKey: string): string | null {
    const key = inboundKey(m);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seen = this.db.prepare("INSERT OR IGNORE INTO seen_messages (key, seen_at) VALUES (?, ?)").run(dedupeKey(m), now);
      if (Number(seen.changes) === 0) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare("DELETE FROM seen_messages WHERE id <= (SELECT MAX(id) FROM seen_messages) - ?").run(SEEN_LIMIT);
      const reply = m.segments.find(s => s.type === "reply") as { data: { id?: string } } | undefined;
      const created = this.db.prepare(`INSERT OR IGNORE INTO inbound
        (key,kind,scope,thread_key,self_id,user_id,group_id,group_name,message_type,message_id,nickname,text,route_text,reply_to,time,
         images,attachments,image_error,created_at,state)
        VALUES (?,'user',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued')`).run(key,
        m.message_type === "group" ? `group:${m.group_id}` : `private:${m.user_id}`, threadKey, m.self_id, m.user_id,
        m.message_type === "group" ? m.group_id : null, m.group_name ?? null, m.message_type, m.message_id, m.nickname, m.text,
        m.route_text, reply?.data.id || null, m.time > 0 ? Math.floor(m.time) : Math.floor(Date.now() / 1000),
        JSON.stringify(m.images), JSON.stringify(m.attachments ?? []), m.image_error ?? null, now);
      this.db.exec("COMMIT");
      return Number(created.changes) === 1 ? key : null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 定时输入（§10）：重放不改变首次写入的内容。 */
  openScheduledInput(input: ScheduledInput): InboundRecord {
    const match = /^(group|private):([1-9][0-9]{0,19})$/.exec(input.scope);
    const creator = /^qq:([1-9][0-9]{0,19})$/.exec(input.creator)?.[1];
    if (!/^run_[a-f0-9]{40}$/.test(input.key) || !match || !creator) throw new Error("定时输入无效");
    this.db.prepare(`INSERT OR IGNORE INTO inbound
      (key,kind,scope,thread_key,user_id,group_id,message_type,nickname,text,route_text,time,created_at,state)
      VALUES (?,'scheduled',?,?,?,?,?,?,?,?,?,?,'queued')`).run(input.key, input.scope, input.thread_key, creator,
      match[1] === "group" ? match[2]! : null, match[1]!, creator, input.text, input.text, input.time, new Date().toISOString());
    const rec = this.getInbound(input.key)!;
    if (rec.kind !== "scheduled" || rec.scope !== input.scope || rec.user_id !== creator) throw new Error("定时输入绑定不一致");
    return rec;
  }

  getInbound(key: string): InboundRecord | null {
    const row = this.db.prepare("SELECT rowid AS seq, * FROM inbound WHERE key = ?").get(key) as InboundRow | undefined;
    return row ? toInbound(row) : null;
  }

  listInbound(state: InboundState, limit = 200, afterSeq = 0): InboundRecord[] {
    const n = Number.isInteger(limit) && limit > 0 ? limit : 200;
    return (this.db.prepare("SELECT rowid AS seq, * FROM inbound WHERE state = ? AND rowid > ? ORDER BY rowid LIMIT ?")
      .all(state, Math.max(0, afterSeq), n) as unknown as InboundRow[]).map(toInbound);
  }

  latestInbound(threadKey: string): InboundRecord | null {
    const row = this.db.prepare("SELECT rowid AS seq, * FROM inbound WHERE thread_key = ? ORDER BY rowid DESC LIMIT 1")
      .get(threadKey) as InboundRow | undefined;
    return row ? toInbound(row) : null;
  }

  /** 状态只前进；turnId 首次写入后保留。 */
  markInbound(keys: readonly string[], state: InboundState, turnId?: string): void {
    const update = this.db.prepare(`UPDATE inbound SET state = ?, turn_id = COALESCE(turn_id, ?) WHERE key = ? AND
      CASE state WHEN 'queued' THEN 0 WHEN 'delivered' THEN 1 ELSE 2 END < ?`);
    for (const key of keys) update.run(state, turnId ?? null, key, STATE_RANK[state]);
  }

  setGroupName(key: string, name: string): void {
    this.db.prepare("UPDATE inbound SET group_name = ? WHERE key = ?").run(name, key);
  }

  finishAttachments(key: string, attachments: NonNullable<InboundMessage['attachments']>, error?: string): void {
    this.db.prepare('UPDATE inbound SET attachments = ?, images = ?, image_error = ? WHERE key = ?')
      .run(JSON.stringify(attachments), JSON.stringify(attachments.flatMap(a => a.path ? [a.path] : [])), error ?? null, key);
  }
}
