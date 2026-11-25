import { normalizeMessage, type InboundInput } from "../../src/policy";

export function event(messageId: number, text = "你好", userId = 10000003, groupId?: number, mention = false) {
  const message = [{ type: "text", data: { text } }];
  return {
    post_type: "message",
    message_type: groupId ? "group" : "private",
    self_id: 10000000,
    user_id: userId,
    message_id: messageId,
    time: 1700000000 + messageId,
    sender: { nickname: `成员${userId}` },
    group_id: groupId,
    message: mention ? [{ type: "at", data: { qq: "10000000" } }, ...message] : message,
  };
}

export function input(messageId: number, text = "你好", userId = 10000003, groupId?: number, mention = false): InboundInput {
  const value = normalizeMessage(event(messageId, text, userId, groupId, mention));
  if (!value) throw new Error("invalid fixture");
  return value;
}
