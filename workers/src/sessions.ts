import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { Cursor, EntryRecord } from "@earendil-works/pi-durable";

// 扫描游标只原样回传给同一会话；不允许浏览器控制会话 ID。
const CursorSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]));
export function readHistoryCursor(value?: string): Cursor | undefined {
  if (!value) return;
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_cursor");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("invalid_cursor"); }
  if (!Check(CursorSchema, parsed)) throw new Error("invalid_cursor");
  return parsed;
}
export const historyCursor = (value: Cursor | undefined) => value && Buffer.from(JSON.stringify(value)).toString("base64url");
export function historyEntry(entry: EntryRecord) {
  return { id: Number(entry.id), kind: entry.kind, reset: entry.kind === "pi.reset",
    messages: (entry.model ?? []).map(message => ({
      role: message.role,
      text: (typeof message.content === "string" ? message.content : message.content.map(block => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return block.thinking;
        if (block.type === "toolCall") return block.name + " " + JSON.stringify(block.arguments);
        return "[图片]";
      }).join("\n")).slice(0, 16000),
      ...(message.role === "toolResult" ? { toolName: message.toolName, isError: message.isError } : {}),
    })),
    ...(entry.kind === "pi.reset" && Check(Type.Object({ label: Type.String(), at: Type.Number() }), entry.data)
      ? { archive: { label: entry.data.label, at: entry.data.at } } : {}),
  };
}
