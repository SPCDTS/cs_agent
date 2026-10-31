import { Type } from "@earendil-works/pi-ai";
import type { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { cleanName, scopeOf, parseInboundMedia, type InboundInput, type InboundMedia } from "./policy";

export const MESSAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, message_id TEXT NOT NULL,
  time INTEGER NOT NULL, user_id TEXT NOT NULL, nickname TEXT NOT NULL DEFAULT '',
  is_self INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', reply_to_id TEXT,
  action TEXT, detail TEXT, image_count INTEGER, UNIQUE (scope, message_id)
);
CREATE TABLE IF NOT EXISTS message_media (
  scope TEXT NOT NULL, message_id TEXT NOT NULL, media_json TEXT NOT NULL DEFAULT '[]', recalled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, message_id)
);
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
CREATE TABLE IF NOT EXISTS scope_names (scope TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('day','week')),
  period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, text TEXT NOT NULL, msg_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, UNIQUE (scope, kind, period_start)
);
CREATE INDEX IF NOT EXISTS summaries_scope_end ON summaries(scope, period_end);
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(text, content='summaries', content_rowid='id', tokenize='trigram');
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
`;

export async function recordMessage(database: Pick<DurableObjectSqliteDatabase, "run">, input: InboundInput, isSelf = false): Promise<void> {
  const scope = scopeOf(input.target);
  await database.run(`INSERT OR IGNORE INTO messages
    (scope, message_id, time, user_id, nickname, is_self, text, reply_to_id, action, image_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, scope, input.messageId, input.time, input.userId, input.nickname,
    isSelf || input.userId === input.selfId ? 1 : 0, input.text, input.replyToId, isSelf ? "send_message" : null, input.imageCount);
  if (input.media?.length) await database.run(`INSERT INTO message_media (scope, message_id, media_json) VALUES (?, ?, ?)
    ON CONFLICT(scope, message_id) DO UPDATE SET media_json=excluded.media_json`, scope, input.messageId, JSON.stringify(parseInboundMedia(input.media)));
  if (input.scopeName) await database.run(`INSERT INTO scope_names (scope, name, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`, scope, cleanName(input.scopeName), Math.floor(Date.now() / 1000));
}

export async function recallMedia(database: Pick<DurableObjectSqliteDatabase, "get">, scope: string, messageId: string): Promise<InboundMedia[]> {
  const row = await database.get<{ media_json: string; recalled: number }>("SELECT media_json, recalled FROM message_media WHERE scope=? AND message_id=?", scope, messageId);
  if (row?.recalled) throw new Error("message_recalled");
  return row ? parseInboundMedia(JSON.parse(row.media_json)) : [];
}
export async function markMessageRecalled(database: Pick<DurableObjectSqliteDatabase, "run">, scope: string, messageId: string): Promise<void> {
  await database.run(`INSERT INTO message_media (scope,message_id,recalled) VALUES (?,?,1)
    ON CONFLICT(scope,message_id) DO UPDATE SET recalled=1`, scope, messageId);
}

export type RecallOptions = { message_id?: string; query?: string; limit?: number; before?: number };
export const QQ_CONTEXT_DESCRIPTION = "只读检索本回合所在会话的聊天记录；message_id 读取单条全文及其引用原文，无 query 取最近消息，before 为 Unix 秒。";
export const QQ_CONTEXT_PARAMETERS = Type.Object({ message_id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), query: Type.Optional(Type.String({ maxLength: 1000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), before: Type.Optional(Type.Number()) }, { additionalProperties: false });
type MessageRow = { message_id: string; image_count: number | null; time: number; user_id: string; nickname: string; is_self: number; text: string; reply_to_id: string | null };
export type SummaryRow = { id: number; scope: string; kind: "day" | "week"; period_start: number; period_end: number; text: string; msg_count: number };
const beijingDate = (sec: number) => new Date((sec + 8 * 3600) * 1000).toISOString().slice(5, 10);
export const summaryLabel = (row: Pick<SummaryRow, "kind" | "period_start" | "period_end">) =>
  row.kind === "day" ? `[日摘要 ${beijingDate(row.period_start)}]` : `[周摘要 ${beijingDate(row.period_start)}~${beijingDate(row.period_end - 86400)}]`;

type MessageDatabase = Pick<DurableObjectSqliteDatabase, "get">;
function storedMessage(database: MessageDatabase, scope: string, messageId: string) {
  return database.get<MessageRow & { recalled: number | null }>(
    `SELECT m.*, mm.recalled FROM messages m LEFT JOIN message_media mm
      ON mm.scope=m.scope AND mm.message_id=m.message_id WHERE m.scope=? AND m.message_id=?`, scope, messageId);
}
async function attachReply(database: MessageDatabase, scope: string, replyToId: string | null | undefined, text: string): Promise<string> {
  if (!replyToId) return text;
  const quoted = await storedMessage(database, scope, replyToId);
  const reference = !quoted ? { message_id: replyToId, status: "原消息未保存在当前会话中" }
    : quoted.recalled ? { message_id: replyToId, status: "原消息已撤回" }
    : { message_id: quoted.message_id, user_id: quoted.user_id, nickname: cleanName(quoted.nickname), text: quoted.text };
  // 原文作为 JSON 资料传入，不改变当前回合身份，也不递归展开引用链。
  return `[引用消息（同一QQ会话）]\n${JSON.stringify(reference)}\n[当前消息]\n${text}`;
}
export async function withReplyContext(database: MessageDatabase, scope: string, messageId: string, text: string): Promise<string> {
  const row = await database.get<{ reply_to_id: string | null }>("SELECT reply_to_id FROM messages WHERE scope=? AND message_id=?", scope, messageId);
  return attachReply(database, scope, row?.reply_to_id, text);
}

export async function recall(database: DurableObjectSqliteDatabase, scope: string, options: RecallOptions): Promise<string> {
  if (options.message_id) {
    const row = await storedMessage(database, scope, options.message_id);
    if (!row) return "未找到本会话的聊天记录。";
    if (row.recalled) return `[message_id:${row.message_id} 已撤回]`;
    const text = `[message_id:${row.message_id}] ${row.is_self ? "[我]" : cleanName(row.nickname) || row.user_id}(${row.user_id}): ${row.text}`;
    return attachReply(database, scope, row.reply_to_id, text);
  }
  const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.min(50, Math.max(1, Math.floor(options.limit))) : 20;
  const before = typeof options.before === "number" && Number.isFinite(options.before) ? options.before : Number.MAX_SAFE_INTEGER;
  const query = options.query?.trim().slice(0, 1000) ?? "";
  let rows: MessageRow[], summaries: SummaryRow[] = [];
  if (!query) {
    rows = await database.all<MessageRow>("SELECT * FROM messages WHERE scope = ? AND time < ? ORDER BY time DESC, id DESC LIMIT ?", scope, before, limit);
    rows.reverse();
  } else if ([...query].length < 3) {
    // trigram 不为短于三个字符的词建立 token；转义 LIKE 通配符，避免搜索扩大成全库匹配。
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    rows = await database.all<MessageRow>(`SELECT * FROM messages WHERE scope = ? AND time < ?
      AND (text LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\') ORDER BY time DESC, id DESC LIMIT ?`, scope, before, pattern, pattern, limit);
    summaries = await database.all<SummaryRow>(`SELECT * FROM summaries WHERE scope = ? AND period_start < ?
      AND text LIKE ? ESCAPE '\\' ORDER BY period_end DESC LIMIT ?`, scope, before, pattern, limit);
  } else {
    // 把输入作为字面短语，不允许聊天内容变成 FTS 操作符或 SQL。
    const phrase = `"${query.replace(/"/g, '""')}"`;
    rows = await database.all<MessageRow>(`SELECT m.* FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.scope = ? AND m.time < ? ORDER BY m.time DESC, m.id DESC LIMIT ?`, phrase, scope, before, limit);
    summaries = await database.all<SummaryRow>(`SELECT s.* FROM summaries_fts JOIN summaries s ON s.id = summaries_fts.rowid
      WHERE summaries_fts MATCH ? AND s.scope = ? AND s.period_start < ? ORDER BY s.period_end DESC LIMIT ?`, phrase, scope, before, limit);
  }
  if (!rows.length && !summaries.length) return "未找到本会话的聊天记录。";
  const mediaRows = rows.length ? await database.all<{ message_id: string; media_json: string; recalled: number }>(
    `SELECT message_id,media_json,recalled FROM message_media WHERE scope=? AND message_id IN (${rows.map(() => "?").join(",")})`, scope, ...rows.map(row => row.message_id)) : [];
  const attachments = new Map(mediaRows.map(row => [row.message_id, row]));
  const now = new Date(Date.now() + 8 * 3600_000).toISOString();
  const entries = rows.map(row => {
    // Workers 的默认时区是 UTC，显式使用北京时间保持 QQ 历史的阅读习惯。
    const time = new Date(row.time * 1000 + 8 * 3600_000).toISOString();
    const stamp = (time.slice(0, 10) === now.slice(0, 10) ? "" : time.slice(5, 10) + " ") + time.slice(11, 16);
    const attachment = attachments.get(row.message_id);
    const label = attachment || row.image_count || row.reply_to_id ? ` [message_id:${row.message_id}${attachment?.recalled ? " 已撤回" : ""}]` : "";
    const reply = row.reply_to_id ? ` [reply_to_id:${row.reply_to_id}]` : "";
    const body = `${row.is_self ? "[我]" : cleanName(row.nickname).slice(0, 40) || row.user_id}(${row.user_id}): ${row.text.replace(/\s+/g, " ").trim()}`;
    return { at: row.time, line: `${stamp} ${body.length <= 120 ? body : body.slice(0, 119) + "…"}${label}${reply}` };
  });
  // 原文过了保留期后摘要是唯一线索，与命中的消息按时间混排后再截到同一条数上限。
  for (const row of summaries) entries.push({ at: row.period_end, line: `${summaryLabel(row)} ${row.text.replace(/\s+/g, " ").trim()}` });
  if (summaries.length) entries.sort((a, b) => b.at - a.at).splice(limit);
  const lines = entries.map(entry => entry.line);
  const selected: string[] = [];
  let used = 0;
  for (const line of query ? lines : [...lines].reverse()) {
    if (used + line.length + 1 > 2480) break;
    selected.push(line);
    used += line.length + 1;
  }
  if (!query) selected.reverse();
  if (selected.length < lines.length) selected.push(`（另有 ${lines.length - selected.length} 条未显示）`);
  return selected.join("\n");
}
