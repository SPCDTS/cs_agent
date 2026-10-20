import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Channel, TurnIdentity } from "../channel/types.js";
import { isScope, scopeOf } from "../context/access.js";
import { trace, type Trace } from "../shared/trace.js";
import { GrantsDoc, type Grant } from "./docs.js";

export const TARGET_PATTERN = "^qq:(group|private):[1-9][0-9]{0,19}$";
const userSchema = z.string().regex(/^qq:[1-9][0-9]{0,19}$/, "user 必须是 qq:<QQ号>").refine(v => v === v.trim(), "user 不允许空白");
const capsSchema = z.array(z.enum(["send", "schedule"])).min(1).max(2);
const grantSchema = z.object({
  user: userSchema, caps: capsSchema,
  targets: z.array(z.string().regex(new RegExp(TARGET_PATTERN)).refine(v => v === v.trim(), "target 不允许空白")).max(200).default([]),
  scopes: z.array(z.string().refine(v => isScope(v) && v === v.trim(), "来源必须是 group:<id> 或 private:<id>")).max(200).optional(),
  expires_in_hours: z.number().positive().max(24 * 365 * 100).optional(),
}).strict();
const revokeSchema = z.object({ user: userSchema, caps: capsSchema.optional() }).strict();
export type AuthTool = "auth_grant" | "auth_revoke" | "auth_list";
export const AUTH_TOOLS: AuthTool[] = ["auth_grant", "auth_revoke", "auth_list"];
export interface GrantBinding extends Partial<TurnIdentity> {
  ticket: string;
  source?: { type: "group" | "private"; user_id: string; group_id: string | null };
}
export interface ImPermissions { actorIsOwner: boolean; target: boolean }

export function parseTarget(value: unknown): { message_type: "group" | "private"; target_id: string; scope: string } {
  if (typeof value !== "string" || value !== value.trim() || !new RegExp(TARGET_PATTERN).test(value)) throw new Error("target 必须是 qq:group:<id> 或 qq:private:<QQ号>");
  const [, type, id] = value.split(":") as [string, "group" | "private", string];
  return { message_type: type, target_id: id, scope: `${type}:${id}` };
}

/** 身份只从通道票据确认；授权存于派发 harness，两个后端共享同一份文档。 */
export class GrantsService {
  constructor(private readonly opts: {
    getHarness(): Harness;
    getChannel(): Pick<Channel, "getTicket">;
    owner?: string;
    now?: () => number;
    trace?: Pick<Trace, "event">;
  }) {}
  private now() { return (this.opts.now ?? Date.now)(); }

  async verify(binding: GrantBinding): Promise<{ actor: string; actorIsOwner: boolean; scope: string }> {
    const rec = await this.opts.getChannel().getTicket(binding.ticket);
    if (!rec) throw new Error("回合票据不存在");
    const actor = `qq:${rec.user_id}`, actorIsOwner = !!this.opts.owner && rec.user_id === this.opts.owner;
    if (binding.actor !== actor || binding.actorIsOwner !== actorIsOwner || !binding.source ||
        binding.source.type !== rec.message_type || binding.source.user_id !== rec.user_id || binding.source.group_id !== rec.group_id) {
      throw new Error("回合身份与票据不一致");
    }
    return { actor, actorIsOwner, scope: scopeOf(rec) };
  }

  async list() {
    const doc = await this.opts.getHarness().snapshot(GrantsDoc, BACKGROUND_CONTEXT);
    const now = this.now();
    return Object.values(doc ?? {}).sort((a, b) => a.user.localeCompare(b.user))
      .map(grant => ({ ...grant, expired: grant.expires_at !== undefined && grant.expires_at <= now }));
  }

  private async active(actor: string, scope: string): Promise<Grant | undefined> {
    const doc = await this.opts.getHarness().snapshot(GrantsDoc, BACKGROUND_CONTEXT), grant = doc?.[actor];
    return grant && (grant.expires_at === undefined || grant.expires_at > this.now()) &&
      (grant.scopes === undefined || grant.scopes.includes(scope)) ? grant : undefined;
  }

  async permissions(binding: GrantBinding): Promise<ImPermissions> {
    // 升级前的快照没有身份声明，关闭新增能力；不能从 access=all 推断 owner。
    if (!binding.actor || binding.actorIsOwner === undefined) return { actorIsOwner: false, target: false };
    const identity = await this.verify(binding);
    if (identity.actorIsOwner) return { actorIsOwner: true, target: true };
    const grant = await this.active(identity.actor, identity.scope);
    return { actorIsOwner: false, target: !!grant?.caps.includes("send") && grant.targets.some(t => t !== `qq:${identity.scope}`) };
  }

  async authorizeSend(binding: GrantBinding, target: string): Promise<void> {
    const identity = await this.verify(binding);
    if (identity.actorIsOwner) return;
    const grant = await this.active(identity.actor, identity.scope);
    if (!grant?.caps.includes("send") || !grant.targets.includes(target)) throw new Error("没有发往该 target 的有效 send 授权");
  }

  async tool(binding: GrantBinding, name: AuthTool, args: unknown): Promise<unknown> {
    const identity = await this.verify(binding);
    if (!identity.actorIsOwner) throw new Error("授权工具仅限 owner 回合");
    if (name === "auth_list") {
      z.object({}).strict().parse(args);
      return this.list();
    }
    return this.mutate(name, args, identity.actor, "tool", binding.ticket);
  }

  /** 面板持有 OBS_TOKEN 的运维者代表配置的 owner，沿用 HTTP 层同源与 CSRF 校验。 */
  async panel(name: "auth_grant" | "auth_revoke", args: unknown): Promise<unknown> {
    if (!this.opts.owner) throw new Error("未配置 owner，不能修改授权");
    return this.mutate(name, args, `qq:${this.opts.owner}`, "panel", "@grants");
  }

  private async mutate(name: "auth_grant" | "auth_revoke", input: unknown, actor: string, source: "panel" | "tool", ticket: string) {
    const args = name === "auth_grant" ? grantSchema.parse(input) : revokeSchema.parse(input);
    const change = await this.opts.getHarness().commit(async tx => {
      const doc = await tx.doc(GrantsDoc), before = doc[args.user] ? JSON.parse(JSON.stringify(doc[args.user])) as Grant : null;
      const now = this.now();
      if (name === "auth_grant") {
        const grant = grantSchema.parse(input);
        doc[args.user] = { user: args.user, caps: [...new Set(grant.caps)], targets: [...new Set(grant.targets)],
          ...(grant.scopes !== undefined ? { scopes: [...new Set(grant.scopes)] } : {}),
          ...(grant.expires_in_hours !== undefined ? { expires_at: now + grant.expires_in_hours * 3_600_000 } : {}),
          granted_by: actor, created_at: before?.created_at ?? now, updated_at: now };
      } else if (before) {
        const caps = args.caps ? before.caps.filter(cap => !args.caps!.includes(cap)) : [];
        if (caps.length) doc[args.user] = { ...before, caps, updated_at: now };
        else delete doc[args.user];
      }
      return { before, after: doc[args.user] ? JSON.parse(JSON.stringify(doc[args.user])) as Grant : null };
    }, BACKGROUND_CONTEXT);
    if (JSON.stringify(change.before) !== JSON.stringify(change.after)) {
      (this.opts.trace ?? trace).event(ticket, "auth_changed", { detail: { source, actor, user: args.user, ...change } });
    }
    return change.after;
  }
}
