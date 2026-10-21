import { isOwner, type OwnerIds } from "../shared/owners.js";
import type { InboundMessage, InboundRecord, ReplyTicketRecord } from "./types.js";

/**
 * 仅用于没有 route_text 的旧数据（v2 票据文档、迁移前的票据行）：去掉开头渲染出的 [at] / [reply] 占位。
 * 新消息一律用 bridge 的 route_text，不经过这里。
 */
export function legacyRouteText(text: string): string {
  return text.replace(/^(?:\s*\[(?:at|reply)\])+/, "");
}

/** 从持久化票据重建入站消息（仅用于生图票据的崩溃对账；段信息不保存，置空）。 */
export function inboundFromTicket(rec: ReplyTicketRecord): InboundMessage {
  return {
    message_id: rec.source_message_id,
    time: Math.floor(Date.parse(rec.created_at) / 1000) || 0,
    message_type: rec.message_type,
    user_id: rec.user_id,
    group_id: rec.group_id,
    ...(rec.group_name ? { group_name: rec.group_name } : {}),
    self_id: rec.self_id,
    nickname: rec.source_nickname,
    text: rec.source_text,
    // 旧行没有保存分流文本：按旧规则从渲染文本推导（仅限迁移前的票据）
    route_text: rec.source_route_text ?? legacyRouteText(rec.source_text),
    truncated: false,
    mentioned_self: rec.message_type === "group",
    segments: [],
    images: rec.source_images ?? [],
    attachments: rec.attachments ?? [],
    ...(rec.source_image_error ? { image_error: rec.source_image_error } : {}),
  };
}

/** 从 Inbox 记录重建入站消息（恢复时重新分流；引用段按保存的 reply_to 还原）。 */
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

/** 票据回复地址：群号或私聊对方。 */
export function ticketTarget(rec: Pick<ReplyTicketRecord, "message_type" | "group_id" | "user_id">): string {
  return rec.message_type === "group" ? rec.group_id! : rec.user_id;
}

/** 会话线程键（设计 §4.2）：群为 group:<id>；owner 的任一账号私聊共用 owner；其余私聊为 private:<qq>。 */
export function threadKeyOf(m: { message_type: "group" | "private"; group_id: string | null; user_id: string }, owners: OwnerIds): string {
  if (m.message_type === "group") return `group:${m.group_id}`;
  return isOwner(owners, m.user_id) ? "owner" : `private:${m.user_id}`;
}
