/**
 * 消息库访问范围：存储不分域，读取一律带访问过滤。
 * - `{kind:"scope"}`：只见该会话（群 `group:<id>` / 私聊 `private:<qq>`）；
 * - `{kind:"all"}`：全部会话，owner 在私聊和群聊均可使用。
 */
import { isOwner, type OwnerIds } from "../shared/owners.js";
import type { ChatType } from "../channel/types.js";

export type Access = { kind: "scope"; scope: string } | { kind: "all" };

const SCOPE_RE = /^(group|private):[1-9][0-9]{0,19}$/;

export function isScope(value: unknown): value is string {
  return typeof value === "string" && SCOPE_RE.test(value);
}

export function scopeOf(m: { message_type: ChatType; group_id: string | null; user_id: string }): string {
  return m.message_type === "group" ? `group:${m.group_id}` : `private:${m.user_id}`;
}

/** 输入来源 → 访问范围：owner → all；其他群消息 → 本群；其他私聊 → 本人。 */
export function accessForSource(
  source: { type: ChatType; user_id: string; group_id: string | null },
  owners: OwnerIds,
): Access {
  if (isOwner(owners, source.user_id)) return { kind: "all" };
  if (source.type === "group") return { kind: "scope", scope: `group:${source.group_id}` };
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

/** QQ_OWNER 列表；空列表仅回退到 QQ_ALLOW_USERS 首项（为 "*" 时无 owner）。 */
export function resolveOwners(qqOwner: string, allowUsers: string[] | "*"): string[] {
  const owners = qqOwner.split(",").map(id => id.trim()).filter(Boolean);
  return owners.length ? [...new Set(owners)] : allowUsers === "*" ? [] : allowUsers.slice(0, 1);
}

/** 需要单一投递目标或面板身份时使用首个 owner。 */
export function resolveOwner(qqOwner: string, allowUsers: string[] | "*"): string | undefined {
  return resolveOwners(qqOwner, allowUsers)[0];
}

export function scopeLabel(scope: string): string {
  const m = /^(group|private):(\d+)$/.exec(scope);
  if (!m) return scope === 'owner' ? 'owner 私聊' : scope === 'shared' ? '共享线程' : scope || '未知会话';
  return (m[1] === 'group' ? '群 ' : '私聊 ') + m[2];
}
