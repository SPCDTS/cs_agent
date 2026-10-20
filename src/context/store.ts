/**
 * 统一上下文存储（设计 §2.1–2.4）：`${DATA_DIR}/qq-messages.sqlite`，node:sqlite，WAL。
 * 唯一读写入口：入库、撤回、机器人回复行、recent / search / message、衰老（摘要 + 清理）。
 * 所有读取都带访问过滤（Access）；意图层（进程内）与 qq_context MCP（只读连接）共用本模块。
 * 时间一律为 unix 秒；"日"按进程本地时区（容器默认 UTC，可设 TZ）。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { InboundMessage } from "../channel/types.js";
import { log } from "../shared/log.js";
import { clip } from "../shared/header.js";
import { scopeOf, type Access } from "./access.js";

export { clip } from "../shared/header.js";

const CONTEXT_DB_FILE = "qq-messages.sqlite";
export const BOT_STATUS = { pending: "处理中", replied: "已回复", failed: "失败" } as const;
type BotStatus = (typeof BOT_STATUS)[keyof typeof BOT_STATUS];
export type BotAction = "generate_image" | "research+generate_image" | "ask_codex" | "fallback" | "reply";

export interface MessageRow {
  id: number;
  scope: string;
  scope_name?: string;
  message_id: string;
  time: number;
  user_id: string;
  nickname: string;
  is_self: number;
  text: string;
  reply_to_id: string | null;
  action: string | null;
  detail: string | null;
  ticket: string | null;
  status: string | null;
  image_count: number | null;
}

export interface MediaRow {
  scope: string;
  message_id: string;
  ordinal: number;
  sha256: string | null;
  path: string | null;
  status: "ok" | "skipped";
  reason: string | null;
  created_at: number;
}

export interface SummaryRow {
  id: number;
  scope: string;
  scope_name?: string;
  level: "day" | "week";
  period_start: number;
  period_end: number;
  text: string;
  msg_count: number;
  created_at: number;
}

export type ContextItem = { kind: "message"; row: MessageRow } | { kind: "summary"; row: SummaryRow };

export interface CompleteReply {
  action: BotAction;
  detail?: string;
  /** 回复正文摘要；超过 120 字截断 */
  excerpt?: string;
  image_count?: number;
  status: BotStatus;
  /** QQ 回复消息的 message_id；给出时替换占位 id，便于用户引用机器人回复时找回 */
  reply_message_id?: string;
}

export interface ContextStoreOptions {
  readOnly?: boolean;
  /** 本地时区相对 UTC 的偏移秒数（默认取进程时区）；测试可固定 */
  tzOffsetSec?: number;
}

const DAY = 86400;
export const EXCERPT_MAX = 120;
export const SUMMARY_MAX = 400;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  message_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  is_self INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  action TEXT,
  detail TEXT,
  ticket TEXT,
  status TEXT,
  image_count INTEGER,
  UNIQUE (scope, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_ticket ON messages(ticket) WHERE ticket IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_scope_time ON messages(scope, time);
CREATE INDEX IF NOT EXISTS messages_time ON messages(time);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, detail, content='messages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, detail) VALUES (new.id, new.text, new.detail);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, detail) VALUES ('delete', old.id, old.text, old.detail);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text, detail ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, detail) VALUES ('delete', old.id, old.text, old.detail);
  INSERT INTO messages_fts(rowid, text, detail) VALUES (new.id, new.text, new.detail);
END;

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('day','week')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  msg_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (scope, level, period_start)
);
CREATE INDEX IF NOT EXISTS summaries_scope_end ON summaries(scope, period_end);
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  text, content='summaries', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE OF text ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO summaries_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS message_media (
  scope TEXT NOT NULL, message_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  sha256 TEXT, path TEXT, status TEXT NOT NULL CHECK (status IN ('ok','skipped')),
  reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, message_id, ordinal)
);
CREATE INDEX IF NOT EXISTS message_media_path ON message_media(path);
CREATE TRIGGER IF NOT EXISTS messages_media_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_media WHERE scope = old.scope AND message_id = old.message_id;
END;

CREATE TABLE IF NOT EXISTS scope_names (
  scope TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** 检索词：按空白切分，去掉 LIKE 通配符，最多 5 个词。 */
function searchTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/[%_\\]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 5);
}

const nowSec = () => Math.floor(Date.now() / 1000);

export class ContextStore {
  readonly file: string;
  private readonly db: DatabaseSync;
  readonly tzOffsetSec: number;

  constructor(dataDir: string, opts: ContextStoreOptions = {}) {
    this.file = path.join(dataDir, CONTEXT_DB_FILE);
    this.tzOffsetSec = opts.tzOffsetSec ?? -new Date().getTimezoneOffset() * 60;
    if (opts.readOnly) {
      this.db = new DatabaseSync(this.file, { readOnly: true });
      this.db.exec("PRAGMA busy_timeout = 5000;");
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(this.file);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
      this.db.exec(SCHEMA);
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  // ------------------------------------------------------------------ 写入

  /** 入站 QQ 消息入库（幂等：同 scope+message_id 只保留第一条）。 */
  ingest(m: InboundMessage): void {
    if (m.message_type === "group" && m.group_name) {
      this.db.prepare("INSERT INTO scope_names (scope, name, updated_at) VALUES (?, ?, ?) ON CONFLICT (scope) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at")
        .run(scopeOf(m), m.group_name, nowSec());
    }
    const reply = m.segments.find((s) => s.type === "reply") as { data: { id?: string } } | undefined;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (scope, message_id, time, user_id, nickname, is_self, text, reply_to_id)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(scopeOf(m), m.message_id, m.time > 0 ? Math.floor(m.time) : nowSec(), m.user_id, m.nickname, m.text,
        reply?.data.id || null);
  }

  /** 撤回：删除原始行（摘要不回溯修改）。 */
  recall(scope: string, messageId: string): boolean {
    const r = this.db.prepare("DELETE FROM messages WHERE scope = ? AND message_id = ?").run(scope, messageId);
    return Number(r.changes) > 0;
  }

  /** 每条 Outbox 消息一行；真实 id 与完整正文可立即用于引用查找。 */
  recordSent(row: import("../channel/outbox.js").OutboxRow, source: import("../channel/types.js").ReplyTicketRecord): void {
    if (row.status !== "sent" || !row.message_id) throw new Error("上下文仅接受已发送消息");
    const scope = row.message_type + ":" + row.target_id;
    this.db.prepare("DELETE FROM messages WHERE ticket=? AND message_id=?").run(row.ticket, "self:" + row.ticket);
    this.db.prepare(`INSERT OR IGNORE INTO messages
      (scope,message_id,time,user_id,nickname,is_self,text,reply_to_id,ticket,status,action,image_count)
      VALUES (?,?,?,?,'我',1,?,?,?,'已回复',?,?)`).run(scope, row.message_id, Math.floor(Date.parse(row.sent_at ?? row.created_at) / 1000),
      source.self_id, row.text, scope === scopeOf(source) ? source.source_message_id : null, row.key, row.key.endsWith("#fallback") ? "fallback" : "reply", row.images.length);
  }

  /** 收到消息即写入机器人"处理中"行（幂等：每个票据一行）。 */
  recordPending(scope: string, ticket: string, time: number, opts: { replyTo?: string; selfId?: string } = {}): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (scope, message_id, time, user_id, nickname, is_self, text, reply_to_id, ticket, status)
         VALUES (?, ?, ?, ?, '我', 1, '', ?, ?, ?)`,
      )
      .run(scope, `self:${ticket}`, time > 0 ? Math.floor(time) : nowSec(), opts.selfId ?? "", opts.replyTo ?? null, ticket,
        BOT_STATUS.pending);
  }

  /** 回复后更新机器人行：动作、细节（生图提示词 / codex 强度）、正文摘要、图片数、状态。 */
  /**
   * 占位 id `self:<ticket>` 换成真实 message_id 与内容更新在同一事务内完成；改名冲突（同 scope 已有该
   * message_id）或找不到行时记日志并保留占位 id，内容更新照常提交。
   */
  completeReply(ticket: string, r: CompleteReply): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const res = this.db
        .prepare("UPDATE messages SET action = ?, detail = ?, text = ?, image_count = ?, status = ? WHERE ticket = ?")
        .run(r.action, r.detail ?? null, clip(r.excerpt ?? "", EXCERPT_MAX), r.image_count ?? 0, r.status, ticket);
      if (r.reply_message_id) this.renameSelfRow(ticket, r.reply_message_id);
      this.db.exec("COMMIT");
      return Number(res.changes) > 0;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 事务内调用：把机器人行的占位 id 换成真实 message_id，结果写日志。 */
  private renameSelfRow(ticket: string, messageId: string): void {
    const row = this.db.prepare("SELECT scope, message_id FROM messages WHERE ticket = ?").get(ticket) as
      | { scope: string; message_id: string }
      | undefined;
    if (!row) {
      log.warn("context reply rename: no bot row for ticket", { ticket, message_id: messageId });
      return;
    }
    if (row.message_id === messageId) return; // 重放：已改名
    const taken = this.db
      .prepare("SELECT ticket FROM messages WHERE scope = ? AND message_id = ?")
      .get(row.scope, messageId) as { ticket: string | null } | undefined;
    if (taken) {
      log.warn("context reply rename conflict: message_id already stored", { ticket, scope: row.scope, message_id: messageId, owner_ticket: taken.ticket });
      return;
    }
    const res = this.db.prepare("UPDATE messages SET message_id = ? WHERE ticket = ?").run(messageId, ticket);
    if (Number(res.changes) !== 1) log.warn("context reply rename updated no row", { ticket, message_id: messageId });
  }

  // ------------------------------------------------------------------ 读取（带访问过滤）

  private withScopeName<T extends { scope: string }>(row: T): T & { scope_name?: string } {
    const name = this.db.prepare("SELECT name FROM scope_names WHERE scope = ?").get(row.scope) as { name: string } | undefined;
    return name ? { ...row, scope_name: name.name } : row;
  }

  private accessClause(access: Access, scope: string | undefined, column = "scope"): { sql: string; args: SQLInputValue[] } | null {
    if (access.kind === "scope") {
      if (scope !== undefined && scope !== access.scope) return null; // 跨域请求一律拒绝
      return { sql: ` AND ${column} = ?`, args: [access.scope] };
    }
    return scope !== undefined ? { sql: ` AND ${column} = ?`, args: [scope] } : { sql: "", args: [] };
  }

  /** 最近消息，按时间旧→新。windowMin 限定时间窗口；beforeMessageId 向前翻页。 */
  recent(
    access: Access,
    opts: { scope?: string; windowMin?: number; limit: number; beforeMessageId?: string; now?: number },
  ): MessageRow[] {
    const acc = this.accessClause(access, opts.scope);
    if (!acc) return [];
    let sql = `SELECT * FROM messages WHERE 1 = 1${acc.sql}`;
    const args: SQLInputValue[] = [...acc.args];
    if (opts.windowMin !== undefined) {
      sql += " AND time >= ?";
      args.push((opts.now ?? nowSec()) - Math.floor(opts.windowMin * 60));
    }
    if (opts.beforeMessageId !== undefined) {
      const anchor = this.findMessage(access, opts.beforeMessageId, opts.scope);
      if (!anchor) return [];
      sql += " AND scope = ? AND (time < ? OR (time = ? AND id < ?))";
      args.push(anchor.scope, anchor.time, anchor.time, anchor.id);
    }
    sql += " ORDER BY time DESC, id DESC LIMIT ?";
    args.push(Math.max(0, Math.floor(opts.limit)));
    return (this.db.prepare(sql).all(...args) as unknown as MessageRow[]).reverse().map(row => this.withScopeName(row));
  }

  /** 关键词检索：原始消息与摘要混排，按时间新→旧。 */
  search(access: Access, opts: { query: string; days: number; limit: number; scope?: string; now?: number }): ContextItem[] {
    const acc = this.accessClause(access, opts.scope, "m.scope");
    const terms = searchTerms(opts.query);
    if (!acc || !terms.length) return [];
    const since = (opts.now ?? nowSec()) - Math.floor(opts.days * DAY);
    const limit = Math.max(0, Math.floor(opts.limit));

    const likeArgs = (n: number) => terms.flatMap((t) => Array<string>(n).fill(`%${t}%`));
    const msgWhere = terms.map(() => "(f.text LIKE ? OR f.detail LIKE ?)").join(" AND ");
    const msgs = this.db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE ${msgWhere} AND m.time >= ?${acc.sql} ORDER BY m.time DESC, m.id DESC LIMIT ?`,
      )
      .all(...likeArgs(2), since, ...acc.args, limit) as unknown as MessageRow[];

    const sAcc = this.accessClause(access, opts.scope, "s.scope")!;
    const sumWhere = terms.map(() => "f.text LIKE ?").join(" AND ");
    const sums = this.db
      .prepare(
        `SELECT s.* FROM summaries_fts f JOIN summaries s ON s.id = f.rowid
         WHERE ${sumWhere} AND s.period_end >= ?${sAcc.sql} ORDER BY s.period_end DESC LIMIT ?`,
      )
      .all(...likeArgs(1), since, ...sAcc.args, limit) as unknown as SummaryRow[];

    const items: ContextItem[] = [
      ...msgs.map((row) => ({ kind: "message" as const, row: this.withScopeName(row) })),
      ...sums.map((row) => ({ kind: "summary" as const, row: this.withScopeName(row) })),
    ];
    const t = (i: ContextItem) => (i.kind === "message" ? i.row.time : i.row.period_end);
    return items.sort((a, b) => t(b) - t(a)).slice(0, limit);
  }

  /** 单条消息全文 + 引用链（同 scope，最多 3 层，近→远）。 */
  message(access: Access, messageId: string, opts: { scope?: string } = {}): { row: MessageRow; chain: MessageRow[] } | null {
    const row = this.findMessage(access, messageId, opts.scope);
    if (!row) return null;
    const chain: MessageRow[] = [];
    let cur = row;
    const seen = new Set<number>([row.id]);
    while (cur.reply_to_id && chain.length < 3) {
      const next = this.db.prepare("SELECT * FROM messages WHERE scope = ? AND message_id = ?").get(cur.scope, cur.reply_to_id) as
        | MessageRow
        | undefined;
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      chain.push(next);
      cur = next;
    }
    return { row: this.withScopeName(row), chain: chain.map(r => this.withScopeName(r)) };
  }

  private findMessage(access: Access, messageId: string, scope?: string): MessageRow | undefined {
    const acc = this.accessClause(access, scope);
    if (!acc) return undefined;
    return this.db
      .prepare(`SELECT * FROM messages WHERE message_id = ?${acc.sql} ORDER BY time DESC, id DESC LIMIT 1`)
      .get(messageId, ...acc.args) as MessageRow | undefined;
  }

  /** 媒体与正文替换同事务；撤回后的旧任务不能重新建行。 */
  saveMedia(row: MessageRow, media: MediaRow[], text: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db.prepare("UPDATE messages SET text = ? WHERE id = ? AND scope = ? AND message_id = ? AND text = ?")
        .run(text, row.id, row.scope, row.message_id, row.text);
      if (!updated.changes) throw new Error("消息已撤回或变更");
      const insert = this.db.prepare("INSERT OR REPLACE INTO message_media VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const m of media) insert.run(row.scope, row.message_id, m.ordinal, m.sha256, m.path, m.status, m.reason, m.created_at);
      this.db.exec("COMMIT");
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  media(scope: string, messageId: string): MediaRow[] {
    return this.db.prepare("SELECT * FROM message_media WHERE scope = ? AND message_id = ? ORDER BY ordinal")
      .all(scope, messageId) as unknown as MediaRow[];
  }

  mediaPathAllowed(access: Access, file: string): boolean {
    const acc = this.accessClause(access, undefined)!;
    return !!this.db.prepare("SELECT 1 FROM message_media WHERE path = ? AND status = 'ok'" + acc.sql + " LIMIT 1").get(file, ...acc.args);
  }

  mediaPathReferenced(file: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM message_media WHERE path = ? LIMIT 1").get(file);
  }

  // ------------------------------------------------------------------ 衰老

  /** 本地日序号（自 1970-01-01 本地日起）。 */
  dayIndex(ts: number): number {
    return Math.floor((ts + this.tzOffsetSec) / DAY);
  }

  dayStart(day: number): number {
    return day * DAY - this.tzOffsetSec;
  }

  /** 需要生成日摘要的 (scope, 日)：今天之前、≥minMessages 条、尚未被日/周摘要覆盖。 */
  pendingDaySummaries(now: number, minMessages = 5): { scope: string; period_start: number; period_end: number; count: number }[] {
    const today = this.dayIndex(now);
    const rows = this.db
      .prepare(
        `SELECT scope, CAST((time + ?) / ${DAY} AS INTEGER) AS day, COUNT(*) AS n FROM messages
         WHERE time < ? GROUP BY scope, day HAVING n >= ? ORDER BY day, scope`,
      )
      .all(this.tzOffsetSec, this.dayStart(today), minMessages) as { scope: string; day: number; n: number }[];
    const covered = this.db.prepare(
      "SELECT 1 FROM summaries WHERE scope = ? AND period_start <= ? AND period_end > ? LIMIT 1",
    );
    return rows
      .map((r) => ({ scope: r.scope, period_start: this.dayStart(r.day), period_end: this.dayStart(r.day + 1), count: r.n }))
      .filter((p) => !covered.get(p.scope, p.period_start, p.period_start));
  }

  /** 某 scope 一段时间内的全部消息，旧→新（衰老任务用，不经访问过滤，仅进程内调用）。 */
  messagesBetween(scope: string, start: number, end: number): MessageRow[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE scope = ? AND time >= ? AND time < ? ORDER BY time, id")
      .all(scope, start, end) as unknown as MessageRow[];
  }

  writeSummary(s: Omit<SummaryRow, "id" | "created_at"> & { created_at?: number }): SummaryRow {
    return this.db
      .prepare(
        `INSERT INTO summaries (scope, level, period_start, period_end, text, msg_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, level, period_start) DO UPDATE SET period_end = excluded.period_end, text = excluded.text,
           msg_count = excluded.msg_count, created_at = excluded.created_at RETURNING *`,
      )
      .get(s.scope, s.level, s.period_start, s.period_end, clip(s.text, SUMMARY_MAX), s.msg_count, s.created_at ?? nowSec()) as unknown as SummaryRow;
  }

  /** 已结束的自然周（周一起）内的日摘要，按 scope+周 分组；用于折叠为周摘要。 */
  foldableWeeks(now: number): { scope: string; period_start: number; period_end: number; days: SummaryRow[] }[] {
    const today = this.dayIndex(now);
    const weekOf = (day: number) => day - ((day + 3) % 7); // 1970-01-01 为周四 → 周一起
    const thisWeek = weekOf(today);
    const days = this.db
      .prepare("SELECT * FROM summaries WHERE level = 'day' AND period_start < ? ORDER BY scope, period_start")
      .all(this.dayStart(thisWeek)) as unknown as SummaryRow[];
    const groups = new Map<string, { scope: string; period_start: number; period_end: number; days: SummaryRow[] }>();
    for (const d of days) {
      const w = weekOf(this.dayIndex(d.period_start));
      const key = `${d.scope}|${w}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { scope: d.scope, period_start: this.dayStart(w), period_end: this.dayStart(w + 7), days: [] }));
      g.days.push(d);
    }
    return [...groups.values()];
  }

  /** 写入周摘要并删除对应日摘要（同一事务）。 */
  replaceWithWeek(week: { scope: string; period_start: number; period_end: number; days: SummaryRow[] }, text: string): SummaryRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const written = this.writeSummary({
        scope: week.scope, level: "week", period_start: week.period_start, period_end: week.period_end, text,
        msg_count: week.days.reduce((n, d) => n + d.msg_count, 0),
      });
      const del = this.db.prepare("DELETE FROM summaries WHERE id = ? AND level = 'day'");
      for (const d of week.days) del.run(d.id);
      this.db.exec("COMMIT");
      return written;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 清理：原始消息超过 rawDays 且其时间已被同 scope 的日/周摘要覆盖时删除；未被覆盖（摘要失败、
   * 条数不足未做摘要）的原始消息保留到 hardMaxDays 为止（兜底上限，默认 90）。摘要超过 summaryDays 删除。
   */
  purge(now: number, rawDays: number, summaryDays: number, hardMaxDays = 90): { messages: number; summaries: number } {
    const m = this.db
      .prepare(
        `DELETE FROM messages WHERE time < ? AND (time < ? OR EXISTS (
           SELECT 1 FROM summaries s WHERE s.scope = messages.scope AND s.period_start <= messages.time AND s.period_end > messages.time))`,
      )
      .run(now - rawDays * DAY, now - Math.max(hardMaxDays, rawDays) * DAY);
    const s = this.db.prepare("DELETE FROM summaries WHERE period_end < ?").run(now - summaryDays * DAY);
    return { messages: Number(m.changes), summaries: Number(s.changes) };
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** 面板 scope 选择器：包括只有摘要、已无原文的域。 */
  scopes(): string[] {
    return (this.db.prepare("SELECT scope FROM messages UNION SELECT scope FROM summaries ORDER BY scope").all() as {scope:string}[]).map(r=>r.scope);
  }

  /** 面板显示用：会话域 → 最近一次入站消息携带的群名。 */
  scopeNames(): Record<string, string> {
    const rows = this.db.prepare("SELECT scope, name FROM scope_names").all() as { scope: string; name: string }[];
    return Object.fromEntries(rows.map(r => [r.scope, r.name]));
  }

  /** 运维统计（DEPLOY 文档 / 日志用）。 */
  stats(): { messages: number; summaries: number } {
    const m = this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    const s = this.db.prepare("SELECT COUNT(*) AS n FROM summaries").get() as { n: number };
    return { messages: Number(m.n), summaries: Number(s.n) };
  }
}
