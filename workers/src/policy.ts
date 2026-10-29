import type { GroupTrigger, Settings } from "./settings";

export type Target = { kind: "private"; userId: string } | { kind: "group"; groupId: string };
export type InboundInput = {
  messageId: string; selfId: string; userId: string; nickname: string;
  target: Target; text: string; routeText: string; time: number;
  mentionedSelf: boolean; replyToId: string | null; imageCount: number;
  scopeName?: string;
};
export type PolicyConfig = { owners: string[]; allowUsers: string[]; allowGroups: string[]; groupTrigger: GroupTrigger };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function id(value: unknown): string {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : "";
}
const validId = (value: string) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
export const cleanName = (value: string) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}\[\]<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);
const data = (segment: Record<string, unknown>) => isRecord(segment.data) ? segment.data : {};
const segmentText = (segment: Record<string, unknown>) => typeof data(segment).text === "string" ? String(data(segment).text) : "";

export function renderText(segments: Record<string, unknown>[], selfId?: string): string {
  return segments.map(segment => {
    if (segment.type === "text") return segmentText(segment);
    if (segment.type !== "at") return `[${typeof segment.type === "string" ? segment.type : "unknown"}]`;
    const qq = id(data(segment).qq);
    if (qq === "all") return "[@全体成员]";
    if (qq === selfId) return "[@你]";
    if (!validId(qq)) return "[at]";
    const name = typeof data(segment).name === "string" ? cleanName(String(data(segment).name)) : "";
    return `[@${name ? name + " " : ""}qq:${qq}]`;
  }).join("");
}

export function normalizeMessage(event: unknown): InboundInput | undefined {
  if (!isRecord(event) || event.post_type !== "message") return;
  if (event.message_type !== "private" && event.message_type !== "group") return;
  const sender = isRecord(event.sender) ? event.sender : {};
  const messageId = id(event.message_id), selfId = id(event.self_id), userId = id(event.user_id ?? sender.user_id);
  if (!messageId || !validId(selfId) || !validId(userId)) return;
  const groupId = id(event.group_id);
  if (event.message_type === "group" && !validId(groupId)) return;
  // 只信任结构化消息段，文本里的 CQ 码和 @昵称不能取得触发权限。
  const segments = Array.isArray(event.message) ? event.message.filter(isRecord) : [];
  const route = segments.filter(segment => segment.type !== "image");
  const start = route.findIndex(segment => segment.type !== "at" && segment.type !== "reply" && (segment.type !== "text" || !!segmentText(segment).trim()));
  const reply = segments.find(segment => segment.type === "reply");
  const card = typeof sender.card === "string" ? sender.card : "";
  const nick = typeof sender.nickname === "string" ? sender.nickname : "";
  return {
    messageId, selfId, userId, nickname: cleanName(card || nick),
    target: event.message_type === "group" ? { kind: "group", groupId } : { kind: "private", userId },
    text: renderText(segments, selfId).slice(0, 16000),
    routeText: start < 0 ? "" : renderText(route.slice(start), selfId).slice(0, 16000),
    time: typeof event.time === "number" && Number.isFinite(event.time) ? event.time : 0,
    mentionedSelf: segments.some(segment => segment.type === "at" && id(data(segment).qq) === selfId),
    replyToId: reply ? id(data(reply).id) || null : null,
    imageCount: segments.filter(segment => segment.type === "image").length,
  };
}

export function isAllowed(policy: PolicyConfig, message: InboundInput): boolean {
  if (policy.owners.includes(message.userId) || policy.allowUsers.includes(message.userId)) return true;
  return message.target.kind === "group" && policy.allowGroups.includes(message.target.groupId);
}
const GROUP_TRIGGER: Record<GroupTrigger, (message: InboundInput, repliedToSelf: boolean) => boolean> = {
  mention_or_reply: (message, repliedToSelf) => message.mentionedSelf || repliedToSelf,
  mention_only: message => message.mentionedSelf,
  off: () => false,
};
export function isTriggered(policy: PolicyConfig, message: InboundInput, repliedToSelf = false): boolean {
  if (message.userId === message.selfId || !isAllowed(policy, message)) return false;
  return message.target.kind === "private" || GROUP_TRIGGER[policy.groupTrigger](message, repliedToSelf);
}
export const idList = (value = "") => value.split(",").map(value => value.trim()).filter(validId);
// owner 只来自 secret，面板设置不能把任何人升为 owner。
export const ownerIds = (env: { QQ_OWNER?: string }) => idList(env.QQ_OWNER);
export const policyFrom = (env: { QQ_OWNER?: string }, settings: Settings): PolicyConfig =>
  ({ owners: ownerIds(env), allowUsers: settings.allowUsers, allowGroups: settings.allowGroups, groupTrigger: settings.groupTrigger });
export const scopeOf = (target: Target) => target.kind === "group" ? `group:${target.groupId}` : `private:${target.userId}`;
export const threadKey = (policy: PolicyConfig, message: InboundInput) => message.target.kind === "private" && policy.owners.includes(message.userId) ? "owner" : scopeOf(message.target);
export const inboundKey = (message: InboundInput) => `${message.selfId}:${message.target.kind}:${message.target.kind === "group" ? message.target.groupId : ""}:${message.userId}:${message.messageId}`;
