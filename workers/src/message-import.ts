import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { cleanName } from "./policy";
import { QQ_ID } from "./settings";

export const MESSAGE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const nullable = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));
const seconds = Type.Integer({ minimum: 0, maximum: 1e11 });
const strict = { additionalProperties: false } as const;
// 列与 Docker 的 messages / summaries 一致；outbox_key、status 由导出脚本丢弃，summaries.level 改名 kind。
const ImportedMessage = Type.Object({
  message_id: Type.String({ minLength: 1, maxLength: 64 }), time: seconds, user_id: Type.String({ pattern: "^\\d{1,20}$" }),
  nickname: Type.Optional(Type.String({ maxLength: 1000 })), is_self: Type.Union([Type.Literal(0), Type.Literal(1)]),
  text: Type.String({ maxLength: 65_536 }), reply_to_id: nullable(Type.String({ maxLength: 64 })), action: nullable(Type.String({ maxLength: 64 })),
  detail: nullable(Type.String({ maxLength: 65_536 })), image_count: nullable(Type.Integer({ minimum: 0, maximum: 1000 })),
}, strict);
const ImportedSummary = Type.Object({
  kind: Type.Union([Type.Literal("day"), Type.Literal("week")]), period_start: seconds, period_end: seconds,
  text: Type.String({ minLength: 1, maxLength: 8000 }), msg_count: Type.Integer({ minimum: 0 }), created_at: seconds,
}, strict);
const MessageImportSchema = Type.Object({
  scope: Type.String({ pattern: `^(group|private):${QQ_ID}$` }), name: Type.Optional(Type.String({ maxLength: 1000 })),
  messages: Type.Array(ImportedMessage), summaries: Type.Array(ImportedSummary),
}, strict);
export type MessageImport = Static<typeof MessageImportSchema>;
type Counts = { inserted: number; skipped: number };
export type MessageImportResult = { messages: Counts; summaries: Counts };

export function parseMessageImport(value: unknown): MessageImport {
  // 整批校验后才写库，坏条目不会造成部分导入；错误不带请求正文。
  if (!Check(MessageImportSchema, value)) throw new Error("invalid_import");
  return value;
}

/** owner 的私聊与线上一样进 owner 线程，消息仍按 private:<号> 作用域保存，qq_context 才能按当前会话召回。 */
export const importThreadKey = (scope: string, owners: readonly string[]) => owners.some(id => scope === `private:${id}`) ? "owner" : scope;

/** 按 (scope, message_id) 与 (scope, kind, period_start) 去重；FTS 由触发器同步。调用方负责事务。 */
export async function importHistory(db: Pick<SqliteDatabase, "get" | "run">, data: MessageImport): Promise<MessageImportResult> {
  const result: MessageImportResult = { messages: { inserted: 0, skipped: 0 }, summaries: { inserted: 0, skipped: 0 } };
  for (const m of data.messages) {
    const row = await db.get(`INSERT OR IGNORE INTO messages (scope, message_id, time, user_id, nickname, is_self, text, reply_to_id, action, detail, image_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, data.scope, m.message_id, m.time, m.user_id, m.nickname ?? "", m.is_self, m.text,
    m.reply_to_id ?? null, m.action ?? null, m.detail ?? null, m.image_count ?? null);
    result.messages[row ? "inserted" : "skipped"]++;
  }
  for (const s of data.summaries) {
    const row = await db.get(`INSERT OR IGNORE INTO summaries (scope, kind, period_start, period_end, text, msg_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, data.scope, s.kind, s.period_start, s.period_end, s.text, s.msg_count, s.created_at);
    result.summaries[row ? "inserted" : "skipped"]++;
  }
  const name = data.name === undefined ? "" : cleanName(data.name);
  if (name) await db.run(`INSERT INTO scope_names (scope, name, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`, data.scope, name, Math.floor(Date.now() / 1000));
  return result;
}
