import type { ChatType, TicketStatus } from "./types.js";

/** Outbox 的持久化契约；agent 不依赖 QQ 的 SQLite 实现。 */
export interface OutboxFile {
  filename: string; name: string; bytes: number; sha256: string;
  status: TicketStatus; file_id?: string;
}
export interface OutboxRow {
  key: string; ticket: string; ordinal: number; call_id: string | null;
  message_type: ChatType; target_id: string; mention_user_id: string | null;
  status: TicketStatus; message_id: string | null; text: string; text_sha256: string;
  images: string[]; files: OutboxFile[]; created_at: string; sent_at: string | null;
}
export type OutboxInput = Omit<OutboxRow, "ordinal" | "status" | "message_id" | "text_sha256" | "created_at" | "sent_at" | "key"> &
  { sequence?: number; suffix?: "fallback" | "late"; dailyLimit?: { start: string; end: string; limit: number } };
export interface OutboxStore {
  getOutbox(key: string): OutboxRow | null;
  listOutbox(ticket: string): OutboxRow[];
  countModelOutbox(type: ChatType, targetId: string, start: string, end: string): number;
  reserveOutbox(input: OutboxInput): OutboxRow;
  markOutboxSending(key: string): boolean;
  markOutboxSent(key: string, messageId: string): void;
  markOutboxUncertain(key: string): void;
  updateOutboxFile(key: string, index: number, status: TicketStatus, fileId?: string): void;
}

/** 系统补发独立记账，不占模型发送额度。 */
export function isModelOutboxRow(row: OutboxRow): boolean {
  return row.key !== row.ticket + "#late" && row.key !== row.ticket + "#fallback";
}
