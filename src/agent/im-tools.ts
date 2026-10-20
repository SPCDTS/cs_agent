import { Type } from "@earendil-works/pi-ai";
import { TARGET_PATTERN } from "./grants.js";

const user = Type.String({ pattern: "^qq:[1-9][0-9]{0,19}$", description: "真实 QQ 身份，如 qq:10001" });
const caps = Type.Array(Type.Union([Type.Literal("send"), Type.Literal("schedule")]), { minItems: 1, maxItems: 2 });
export const authParameters = {
  auth_grant: Type.Object({
    user, caps,
    targets: Type.Optional(Type.Array(Type.String({ pattern: TARGET_PATTERN }), { maxItems: 200 })),
    scopes: Type.Optional(Type.Array(Type.String({ pattern: "^(group|private):[1-9][0-9]{0,19}$" }), { maxItems: 200 })),
    expires_in_hours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 24 * 365 * 100 })),
  }, { additionalProperties: false }),
  auth_revoke: Type.Object({ user, caps: Type.Optional(caps) }, { additionalProperties: false }),
  auth_list: Type.Object({}, { additionalProperties: false }),
};
export const authDescriptions = {
  auth_grant: "授予或替换一人的授权。targets 留空不能主动发往别处，scopes 省略表示任何来源；schedule 允许在授权来源会话管理自己的定时任务。",
  auth_revoke: "撤销一人的指定能力；省略 caps 则撤销全部授权。",
  auth_list: "列出授权及到期状态；仅限 owner 回合。",
};
export function sendParameters(target: boolean) {
  return Type.Object({
    text: Type.String({ minLength: 1, maxLength: 4000 }),
    images: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 4 })),
    files: Type.Optional(Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })) }, { additionalProperties: false }), { maxItems: 3 })),
    ...(target ? { target: Type.Optional(Type.String({ pattern: TARGET_PATTERN,
      description: "省略则回复来源会话；跨会话发送必须有授权，且目标是 bot 所在群或好友。主动发送不 @。" })) } : {}),
  }, { additionalProperties: false });
}
