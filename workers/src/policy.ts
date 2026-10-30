import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { GroupTrigger, Settings } from "./settings";

export type Target = { kind: "private"; userId: string } | { kind: "group"; groupId: string };
export const InboundMediaSchema = Type.Object({
  kind: Type.Union([Type.Literal("image"), Type.Literal("file"), Type.Literal("audio"), Type.Literal("video")]),
  ordinal: Type.Integer({ minimum: 1, maximum: 100 }),
  url: Type.Optional(Type.String({ maxLength: 8192 })), file: Type.Optional(Type.String({ maxLength: 8192 })),
  fileId: Type.Optional(Type.String({ maxLength: 512 })), name: Type.Optional(Type.String({ maxLength: 255 })),
  size: Type.Optional(Type.Number({ minimum: 0 })), assetId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
}, { additionalProperties: false });
export type InboundMedia = Static<typeof InboundMediaSchema>;
export function parseInboundMedia(value: unknown): InboundMedia[] {
  if (!Check(Type.Array(InboundMediaSchema, { maxItems: 100 }), value)) throw new Error("invalid_media");
  return value;
}
export type InboundNotice = { kind: "upload"; input: InboundInput }
  | { kind: "recall"; target: Target; messageId: string; userId: string; selfId: string; time: number };
export type InboundInput = {
  messageId: string; selfId: string; userId: string; nickname: string;
  target: Target; text: string; routeText: string; time: number;
  mentionedSelf: boolean; replyToId: string | null; imageCount: number;
  scopeName?: string;
  media?: InboundMedia[];
  /** 仅可信宿主投递可指定；QQ 归一化不会从外部消息读取此字段。 */
  replyChannel?: "web";
  /** 缺省为 message；schedule 由 ScheduleDO 投递，入站键就是 messageId（run_<fire_key>）；subagent 是子 agent 的汇报，入站键同样是 messageId。 */
  kind?: "message" | "schedule" | "event" | "subagent";
  meta?: { fireKey: string };
};
export type TurnKind = NonNullable<InboundInput["kind"]>;
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

/** 保留平台媒体引用，不把 file 字段当可读本地路径，也不在归一化阶段访问 URL。 */
export function normalizeMedia(segments: Record<string, unknown>[]): InboundMedia[] {
  return segments.flatMap<InboundMedia>(segment => {
    const kind = segment.type === "record" ? "audio" : segment.type;
    if (kind !== "image" && kind !== "file" && kind !== "audio" && kind !== "video") return [];
    const value = data(segment);
    const string = (field: string, max: number) => typeof value[field] === "string" ? value[field].slice(0, max) : undefined;
    const fileId = id(value.file_id ?? value.id).slice(0, 512), size = Number(value.file_size ?? value.size);
    return [{ kind, ordinal: 1, ...(string("url", 8192) ? { url: string("url", 8192) } : {}),
      ...(string("file", 8192) ? { file: string("file", 8192) } : {}), ...(fileId ? { fileId } : {}),
      ...(string("name", 255) ? { name: string("name", 255) } : {}), ...(Number.isFinite(size) && size >= 0 ? { size } : {}) }];
  }).slice(0,100).map((media, index) => ({ ...media, ordinal: index + 1 }));
}

export function normalizeNotice(event: unknown): InboundNotice | undefined {
  if (!isRecord(event) || event.post_type !== "notice") return;
  const selfId = id(event.self_id), userId = id(event.user_id), groupId = id(event.group_id);
  if (!validId(selfId) || !validId(userId) || groupId && !validId(groupId)) return;
  const target: Target = groupId ? { kind: "group", groupId } : { kind: "private", userId };
  const time = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : 0;
  if (event.notice_type === "group_recall" || event.notice_type === "friend_recall") {
    const messageId = id(event.message_id);
    return messageId ? { kind: "recall", target, messageId, selfId, userId, time } : undefined;
  }
  if (event.notice_type !== "group_upload" && event.notice_type !== "offline_file") return;
  if (!isRecord(event.file)) return;
  const media = normalizeMedia([{ type: "file", data: event.file }]);
  const item = media[0];
  if (!item || !item.fileId && !item.url) return;
  return { kind: "upload", input: { messageId: id(event.message_id) || `upload:${item.fileId || item.url}:${time}`, selfId, userId, nickname: "",
    target, text: `[file] ${item.name ?? "附件"}`, routeText: "", time, mentionedSelf: false, replyToId: null, imageCount: 0, media } };
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
  const media = normalizeMedia(segments);
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
    ...(media.length ? { media } : {}),
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
export const inboundKey = (message: InboundInput) => message.kind === "schedule" ? message.messageId : `${message.selfId}:${message.target.kind}:${message.target.kind === "group" ? message.target.groupId : ""}:${message.userId}:${message.messageId}`;
