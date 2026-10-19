import type { InboundMessage, ReplyTicketRecord } from "./types.js";

/**
 * 仅用于没有 route_text 的旧数据（v2 票据文档、迁移前的票据行）：去掉开头渲染出的 [at] / [reply] 占位。
 * 新消息一律用 bridge 的 route_text，不经过这里。
 */
export function legacyRouteText(text: string): string {
  return text.replace(/^(?:\s*\[(?:at|reply)\])+/, "");
}

/** 从持久化票据重建入站消息（仅用于崩溃对账；段信息不保存，置空）。 */
export function inboundFromTicket(rec: ReplyTicketRecord): InboundMessage {
  return {
    message_id: rec.source_message_id,
    time: Math.floor(Date.parse(rec.created_at) / 1000) || 0,
    message_type: rec.message_type,
    user_id: rec.user_id,
    group_id: rec.group_id,
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
