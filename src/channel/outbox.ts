import type { ChatType, SendStatus } from "./types.js";

/** Outbox 的持久化契约（docs/ARCHITECTURE.md §3.2）；agent 不依赖 QQ 的 SQLite 实现。 */
export interface OutboxFile {
  filename: string; name: string; bytes: number; sha256: string;
  status: SendStatus; file_id?: string;
}
/**
 * 行键 `<threadKey>:<callKey>`：模型发送的 callKey 为 pi toolCallId 或 codex 回合内序号；
 * 系统消息（出错提示）为 `<threadKey>:sys:<uuid>`。旧版按票据的行迁移后 thread_key 保留原入站键。
 */
export interface OutboxRow {
  key: string; thread_key: string;
  /** 观测用：发出时所在回合 */
  turn_id: string | null;
  /** 本轮最后一条输入：@ 与引用校验 */
  input_key: string | null;
  /** 系统消息不占模型额度、不计主动额度 */
  system: boolean;
  message_type: ChatType; target_id: string; mention_user_id: string | null;
  /** 显式跨会话发送或定时回合；旧行迁移为 false。 */
  proactive: boolean;
  status: SendStatus; message_id: string | null; text: string; text_sha256: string;
  images: string[]; files: OutboxFile[]; created_at: string; sent_at: string | null;
}
export type OutboxInput = Omit<OutboxRow, "status" | "message_id" | "text_sha256" | "created_at" | "sent_at" | "proactive" | "system"> &
  { proactive?: boolean; system?: boolean; dailyLimit?: { start: string; end: string; limit: number } };
export interface OutboxStore {
  getOutbox(key: string): OutboxRow | null;
  /** 某回合发出的全部行（定时运行统计） */
  listOutboxByTurn(turnId: string): OutboxRow[];
  /** 已发出但附件未传完的行（启动与回合结束时补传） */
  listUnfinishedOutbox(): OutboxRow[];
  countModelOutbox(type: ChatType, targetId: string, start: string, end: string): number;
  /** 同键已存在时原样返回（重放不重复写入） */
  reserveOutbox(input: OutboxInput): OutboxRow;
  markOutboxSending(key: string): boolean;
  markOutboxSent(key: string, messageId: string): void;
  markOutboxUncertain(key: string): void;
  updateOutboxFile(key: string, index: number, status: SendStatus, fileId?: string): void;
}
