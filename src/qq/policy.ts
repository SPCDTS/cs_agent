/**
 * 消息规范化与授权 / 触发规则。
 * - @ 检测只看真实 at 段，永不解析文本里的 CQ 码或 "@昵称"。
 * - allowUsers 中的用户在任何会话可触发；allowGroups 中的群，任何成员可触发（群内仍需真实 @）。
 */
import { isOwner } from "../shared/owners.js";
import type { ChatType, InboundMessage, MessageSegment } from "../channel/types.js";
import type { QQBridgeConfig } from "./types.js";
import { isRecord, isValidId } from "./onebot.js";

const MAX_TEXT = 16000;
const MAX_SEGMENTS = 100;
const MAX_NICKNAME = 200;

function idString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function rawSegments(event: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(event.message) ? event.message.filter(isRecord) : [];
}

function segmentType(segment: Record<string, unknown>): string {
  return typeof segment.type === "string" ? segment.type : "unknown";
}

/** 观测只记录原始段类型，去重保序，最多 20 项，不受正文段截断影响。 */
export function messageSegmentTypes(event: Record<string, unknown>): string[] {
  return [...new Set(rawSegments(event).map(segmentType))].slice(0, 20);
}

/** 空文字且无图片、附件时，不进入 agent 派发。 */
export function hasUsableContent(message: Pick<InboundMessage, "text" | "route_text" | "images" | "attachments">): boolean {
  return !!(message.route_text.trim() || message.text.trim() || message.images.length || message.attachments?.length);
}

function segmentData(segment: Record<string, unknown>): Record<string, unknown> {
  return isRecord(segment.data) ? segment.data : {};
}

function segmentText(segment: Record<string, unknown>): string {
  const text = segmentData(segment).text;
  return typeof text === "string" ? text : "";
}

/** @ 段写出对象：成员用 qq:<号码>（与记忆的 subject 同格式），机器人自己写成「你」。 */
function renderAt(segment: Record<string, unknown>, selfId?: string): string {
  const data = segmentData(segment), qq = idString(data.qq);
  if (qq === "all") return "[@全体成员]";
  if (!isValidId(qq)) return "[at]";
  if (qq === selfId) return "[@你]";
  const name = typeof data.name === "string" ? data.name.replace(/[\p{Cc}\p{Zl}\p{Zp}\[\]]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NICKNAME) : "";
  return `[@${name ? name + " " : ""}qq:${qq}]`;
}

export function renderText(segments: Record<string, unknown>[], selfId?: string): string {
  return segments.map(s => {
    const type = segmentType(s);
    return type === "text" ? segmentText(s) : type === "at" ? renderAt(s, selfId) : "[" + type + "]";
  }).join("");
}

/** 分流文本：跳过开头的 at / reply 段（以及夹在其间的纯空白 text 段），跳过图片占位，其余按 renderText 渲染。 */
function renderRouteText(segments: Record<string, unknown>[], selfId: string): string {
  segments = segments.filter(s => segmentType(s) !== "image");
  let i = 0;
  for (; i < segments.length; i++) {
    const s = segments[i]!;
    const type = segmentType(s);
    if (type === "at" || type === "reply") continue;
    if (type === "text" && !segmentText(s).trim()) continue;
    break;
  }
  return renderText(segments.slice(i), selfId);
}

function compactSegments(segments: Record<string, unknown>[]): MessageSegment[] {
  let budget = MAX_TEXT;
  return segments.slice(0, MAX_SEGMENTS).map((s): MessageSegment => {
    const type = segmentType(s);
    const data = segmentData(s);
    if (type === "text") {
      const text = segmentText(s).slice(0, budget);
      budget -= text.length;
      return { type: "text", data: { text } };
    }
    if (type === "at") return { type: "at", data: { qq: idString(data.qq) } };
    if (type === "reply") return { type: "reply", data: { id: idString(data.id) } };
    return { type, data: {} };
  });
}

function nickname(event: Record<string, unknown>): string {
  const sender = isRecord(event.sender) ? event.sender : {};
  const card = typeof sender.card === "string" ? sender.card : "";
  const nick = typeof sender.nickname === "string" ? sender.nickname : "";
  // 控制字符（含换行）与行/段分隔符换成空格：昵称会进入 codex 的单行 [来源] 头部
  return (card || nick).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NICKNAME);
}

/**
 * 把 OneBot 消息事件规范化为 InboundMessage；结构不合法（缺 id、类型不对）时返回 null。
 * 仅接受 array 格式消息，字符串格式（CQ 码）一律按无段处理，绝不解析。
 */
export function normalizeMessage(event: unknown): InboundMessage | null {
  if (!isRecord(event) || event.post_type !== "message") return null;
  const type = event.message_type;
  if (type !== "private" && type !== "group") return null;

  const message_id = idString(event.message_id);
  const self_id = idString(event.self_id);
  const sender = isRecord(event.sender) ? event.sender : {};
  const user_id = idString(event.user_id ?? sender.user_id);
  const group_id = type === "group" ? idString(event.group_id) : null;
  if (!message_id || !isValidId(self_id) || !isValidId(user_id)) return null;
  if (type === "group" && (!group_id || !isValidId(group_id))) return null;

  const segments = rawSegments(event);
  const text = renderText(segments, self_id);
  return {
    message_id,
    time: typeof event.time === "number" && Number.isFinite(event.time) ? event.time : 0,
    message_type: type,
    user_id,
    group_id,
    self_id,
    nickname: nickname(event),
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
    route_text: renderRouteText(segments, self_id).slice(0, MAX_TEXT),
    mentioned_self: segments.some(s => segmentType(s) === "at" && idString(segmentData(s).qq) === self_id),
    segments: compactSegments(segments),
    images: [],
  };
}

export type PolicyConfig = Pick<QQBridgeConfig, "allowUsers" | "allowGroups" | "groupMentions" | "owners">;

export interface AuthSubject {
  message_type: ChatType;
  user_id: string;
  group_id: string | null;
}

/** 发送者是否被授权（不含触发条件）。 */
export function isAllowed(policy: Pick<PolicyConfig, "allowUsers" | "allowGroups" | "owners">, m: AuthSubject): boolean {
  if (isOwner(policy.owners, m.user_id) || policy.allowUsers === "*" || policy.allowUsers.includes(m.user_id)) return true;
  return m.message_type === "group" && m.group_id !== null && policy.allowGroups.includes(m.group_id);
}

/** 是否应触发 agent：已授权，且为私聊或（开启群 @ 且真实 @ 了机器人）。 */
export function isTriggered(policy: PolicyConfig, m: InboundMessage): boolean {
  if (m.user_id === m.self_id || !isAllowed(policy, m)) return false;
  if (m.message_type === "private") return true;
  return policy.groupMentions && m.mentioned_self;
}

/** 校验配置中的 QQ 号 / 群号列表。 */
export function validatePolicy(policy: PolicyConfig): void {
  if (policy.owners !== undefined && (!Array.isArray(policy.owners) || policy.owners.some(id => !isValidId(id)))) {
    throw new Error("owners 必须为 QQ 号字符串列表。");
  }
  if (policy.allowUsers !== "*") {
    if (!Array.isArray(policy.allowUsers) || policy.allowUsers.some(id => !isValidId(id))) {
      throw new Error("allowUsers 必须为 \"*\" 或 QQ 号字符串列表。");
    }
  }
  if (!Array.isArray(policy.allowGroups) || policy.allowGroups.some(id => !isValidId(id))) {
    throw new Error("allowGroups 必须为群号字符串列表。");
  }
}
