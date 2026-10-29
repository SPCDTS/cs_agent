import { Type, type Static } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { MEMORY_KINDS, MEMORY_STATUSES, isMemoryNs } from "./types";
import { containsSecret } from "./secrets";

const nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>>(schema: T) => Type.Union([schema, Type.Null()]);
const time = nullable(Type.Integer({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }));
const source = nullable(Type.String({ maxLength: 200 }));
const MemoryImportRow = Type.Object({
  id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), ns: Type.Optional(Type.String()),
  kind: Type.Union(MEMORY_KINDS.map(k => Type.Literal(k))), text: Type.String({ minLength: 1, maxLength: 500 }),
  subject: Type.Optional(nullable(Type.String({ maxLength: 40 }))),
  since: Type.Optional(time), until: Type.Optional(time), due_at: Type.Optional(time), done_at: Type.Optional(time),
  status: Type.Optional(Type.Union(MEMORY_STATUSES.map(s => Type.Literal(s)))), author: Type.String({ minLength: 1, maxLength: 100 }),
  source_scope: Type.Optional(source), source_message_id: Type.Optional(source), source_turn_id: Type.Optional(source),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), created_at: Type.Optional(time), updated_at: Type.Optional(time),
  last_recalled_at: Type.Optional(time), recall_count: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  hash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
}, { additionalProperties: false });
const ImportSchema = Type.Object({
  ns: Type.String(), profile: Type.Optional(Type.Object({ text: Type.String() }, { additionalProperties: false })),
  memories: Type.Array(MemoryImportRow),
}, { additionalProperties: false });
export type MemoryImport = Static<typeof ImportSchema>;

export function parseImport(value: unknown): MemoryImport {
  // 边界一次校验整批，避免后面的坏条目造成部分导入；不把原请求放进错误或日志。
  if (!Check(ImportSchema, value) || !isMemoryNs(value.ns)) throw new Error("导入数据格式无效");
  if (value.profile && (new TextEncoder().encode(value.profile.text).byteLength > 4096 || containsSecret(value.profile.text))) throw new Error("导入画像超限或包含凭据");
  for (const row of value.memories) {
    if ((row.ns !== undefined && row.ns !== value.ns) || !row.text.trim()
      || Object.values(row).some(v => typeof v === "string" && containsSecret(v))) throw new Error("导入条目无效、跨命名空间或包含凭据");
  }
  return value;
}
