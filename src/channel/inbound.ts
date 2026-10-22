import { isOwner, type OwnerIds } from "../shared/owners.js";
import type { InboundMessage, InboundRecord } from "./types.js";

/** 从 Inbox 记录重建入站消息（恢复时补下载附件；引用段按保存的 reply_to 还原）。 */
export function inboundFromRecord(rec: InboundRecord): InboundMessage {
  return {
    message_id: rec.message_id, time: rec.time, message_type: rec.message_type, user_id: rec.user_id, group_id: rec.group_id,
    ...(rec.group_name ? { group_name: rec.group_name } : {}),
    self_id: rec.self_id, nickname: rec.nickname, text: rec.text, route_text: rec.route_text, truncated: false,
    mentioned_self: rec.message_type === "group",
    segments: rec.reply_to ? [{ type: "reply", data: { id: rec.reply_to } }] : [],
    images: rec.images, attachments: rec.attachments,
    ...(rec.image_error ? { image_error: rec.image_error } : {}),
  };
}

/** 会话线程键（docs/ARCHITECTURE.md §1）：群为 group:<id>；owner 的任一账号私聊共用 owner；其余私聊为 private:<qq>。 */
export function threadKeyOf(m: { message_type: "group" | "private"; group_id: string | null; user_id: string }, owners: OwnerIds): string {
  if (m.message_type === "group") return `group:${m.group_id}`;
  return isOwner(owners, m.user_id) ? "owner" : `private:${m.user_id}`;
}
