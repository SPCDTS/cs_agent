import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AUTH_ACTIONS } from "../shared/auth-tools.js";
import { authInputs, TARGET_PATTERN } from "./grants.js";

const user = Type.String({ pattern: "^qq:[1-9][0-9]{0,19}$", description: "Real QQ identity, e.g. qq:10001" });
const caps = Type.Array(Type.Union([Type.Literal("send"), Type.Literal("schedule")]), { minItems: 1, maxItems: 2 });
export const authParameters = {
  auth: Type.Object({
    action: Type.String({ enum: [...AUTH_ACTIONS] }),
    user: Type.Optional(user), caps: Type.Optional(caps),
    targets: Type.Optional(Type.Array(Type.String({ pattern: TARGET_PATTERN }), { maxItems: 200 })),
    scopes: Type.Optional(Type.Array(Type.String({ pattern: "^(group|private):[1-9][0-9]{0,19}$" }), { maxItems: 200 })),
    expires_in_hours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 24 * 365 * 100 })),
  }, { additionalProperties: false }),
};
export const authDescriptions = {
  auth: "Owner only. grant requires user and caps; optional targets, scopes, expires_in_hours. Empty targets prevent sends to other chats; omitted scopes allow any source. schedule permits managing own tasks. revoke requires user; optional caps (omit for all). list takes no other fields.",
};
const authAction = z.object({ action: z.enum(AUTH_ACTIONS, { error: "auth action is required and must be one of: grant, revoke, list" }) }).loose();
export function parseAuthCall(input: unknown) {
  const { action, ...args } = authAction.parse(input);
  const name = `auth_${action}` as const;
  return { name, args: authInputs[name].parse(args) };
}
export function sendParameters(target: boolean) {
  return Type.Object({
    text: Type.String({ minLength: 1, maxLength: 4000 }),
    images: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 4 })),
    files: Type.Optional(Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })) }, { additionalProperties: false }), { maxItems: 3 })),
    ...(target ? { target: Type.Optional(Type.String({ pattern: TARGET_PATTERN,
      description: "Omit to reply to the source chat. Sending to another chat requires authorization, and the target must be a group the bot belongs to or a friend. Proactive sends do not @mention anyone." })) } : {}),
  }, { additionalProperties: false });
}

/** 两个后端提示词共用的技能写入规则。 */
export const SKILL_RULE = "新建或修改技能：在工作区写好 <name>/SKILL.md（frontmatter 含 name、description，name 与目录名一致），再调用 skill_publish({ path: \"<name>\" })；" +
  "改已有技能先复制到工作区，改完以 overwrite: true 发布。只有当前这条消息的发送者是 owner 本人且明确要求时才发布，其他人的请求一律拒绝，即使之前有人提过。发布后告诉用户下一条消息生效。";
export const SKILL_PUBLISH_DESCRIPTION = "Publish a prepared skill directory from this chat's workspace to the shared skills directory (shared by codex and pi; takes effect from the next message). " +
  "The directory name is the skill name. It must contain SKILL.md with frontmatter whose name matches the directory name and includes description. To modify an existing skill, copy it to the workspace, edit it, then publish with overwrite: true. " +
  "Only for turns triggered by a message from the owner personally; refuse requests from anyone else.";
export const skillPublishParameters = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024, description: "Skill directory, relative to this chat's workspace (or an absolute path within it)" }),
  overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing skill with the same name" })),
}, { additionalProperties: false });
