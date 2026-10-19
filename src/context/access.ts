/**
 * 消息库访问范围：存储不分域，读取一律带访问过滤。
 * - `{kind:"scope"}`：只见该会话（群 `group:<id>` / 私聊 `private:<qq>`）；
 * - `{kind:"all"}`：全部会话，仅 owner 私聊使用。
 */
import type { ChatType } from "../qq/types.js";

export type Access = { kind: "scope"; scope: string } | { kind: "all" };

const SCOPE_RE = /^(group|private):[1-9][0-9]{0,19}$/;

export function isScope(value: unknown): value is string {
  return typeof value === "string" && SCOPE_RE.test(value);
}

export function scopeOf(m: { message_type: ChatType; group_id: string | null; user_id: string }): string {
  return m.message_type === "group" ? `group:${m.group_id}` : `private:${m.user_id}`;
}

/** 票据来源 → 访问范围：群 → 本群；owner 私聊 → all；其他私聊 → 本人。 */
export function accessForSource(
  source: { type: ChatType; user_id: string; group_id: string | null },
  owner: string | undefined,
): Access {
  if (source.type === "group") return { kind: "scope", scope: `group:${source.group_id}` };
  if (owner && source.user_id === owner) return { kind: "all" };
  return { kind: "scope", scope: `private:${source.user_id}` };
}

export function accessToString(a: Access): string {
  return a.kind === "all" ? "all" : a.scope;
}

/** 解析 `QQ_ACCESS`：`group:<id>` | `private:<qq>` | `all`；非法返回 undefined。 */
export function parseAccess(value: string | undefined): Access | undefined {
  const v = (value ?? "").trim();
  if (v === "all") return { kind: "all" };
  if (isScope(v)) return { kind: "scope", scope: v };
  return undefined;
}

/** owner：QQ_OWNER，否则 QQ_ALLOW_USERS 的第一项（为 "*" 时无 owner）。 */
export function resolveOwner(qqOwner: string, allowUsers: string[] | "*"): string | undefined {
  if (qqOwner.trim()) return qqOwner.trim();
  return allowUsers === "*" ? undefined : allowUsers[0];
}

export function scopeLabel(scope: string): string {
  const m = /^(group|private):(\d+)$/.exec(scope);
  if (!m) return scope === 'owner' ? 'owner 私聊' : scope === 'shared' ? '共享线程' : scope || '未知会话';
  return (m[1] === 'group' ? '群 ' : '私聊 ') + m[2];
}
