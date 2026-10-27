import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AUTH_TOOLS } from "../../shared/auth-tools.js";
import type { ImPermissions } from "../grants.js";
import { authDescriptions, authParameters, parseAuthCall, sendParameters, SKILL_PUBLISH_DESCRIPTION, skillPublishParameters } from "../im-tools.js";
import { SKILL_OWNER_ONLY } from "../../context/media-recall-server.js";
import { publishSkill, type SkillsStore } from "../skills-store.js";
import { parseAccess } from "../../context/access.js";
import { attachmentDirs } from "../../media/attach-paths.js";
import type { PiToolsOptions } from "./index.js";
import { PiExecutionEnv } from "./coding.js";

const output = (text: string) => ({ output: [{ type: "text" as const, text }] });
/** 三个固定注册项按回合选择，避免修改共享 schema 影响另一个并行会话；调用时仍按本轮身份复核。 */
export function createPiImExtensions(opts: Pick<PiToolsOptions, "sendService" | "grants" | "dataDir" | "binding">) {
  const make = (name: string, permissions: ImPermissions) => defineExtension({
    name,
    tools: [
      defineTool({
        name: "send_message", description: "The only way users can see your content: immediately send text with optional images and files, to this chat by default, and return message_id. You may send during a turn or after a subagent finishes.",
        parameters: sendParameters(permissions.target), replay: "safe",
        async execute(args, api, context) {
          try {
            const bound = await opts.binding(Number(api.conversationId)), env = api.env;
            const access = parseAccess(bound?.access);
            if (!bound || bound.child || !access || !(env instanceof PiExecutionEnv) || !opts.sendService) throw new Error("发送工具缺少本轮绑定");
            // 调用键为稳定的 toolCallId：重放取回同一 Outbox 行，永不重发。
            const result = await opts.sendService.send({ ...bound, access, workdir: env.policy.workspace,
              extraRoots: [attachmentDirs(opts.dataDir, bound.threadKey).attachDir] }, args, api.callId, context.abortSignal);
            return output(JSON.stringify(result));
          } catch (error) { return { ...output((error as Error).message), isError: true }; }
        },
      }),
      ...(permissions.auth ? AUTH_TOOLS.map(name => defineTool({
        name, description: authDescriptions[name], parameters: authParameters[name],
        replay: "unsafe",
        async execute(args, api, context) {
          try {
            const bound = await opts.binding(Number(api.conversationId));
            if (!bound || bound.child || !opts.grants) throw new Error("授权工具仅限 owner 回合");
            context.abortSignal?.throwIfAborted();
            const call = parseAuthCall(args);
            return output(JSON.stringify(await opts.grants.tool(bound, call.name, call.args)));
          } catch (error) { return { ...output((error as Error).message), isError: true }; }
        },
      })) : []),
    ],
  });
  return {
    basic: make("cs-pi-im", { actorIsOwner: false, target: false, auth: false }),
    targeted: make("cs-pi-im-target", { actorIsOwner: false, target: true, auth: false }),
    owner: make("cs-pi-im-owner", { actorIsOwner: true, target: true, auth: true }),
  };
}

/** skill_publish：只在 owner 本人发起的回合注册，调用时按本轮身份复核。 */
export function createPiSkillExtension(opts: Pick<PiToolsOptions, "binding"> & { skills?: SkillsStore }) {
  return defineExtension({
    name: "cs-pi-skills",
    tools: [defineTool({
      name: "skill_publish", description: SKILL_PUBLISH_DESCRIPTION, parameters: skillPublishParameters, replay: "safe",
      async execute(args, api) {
        try {
          const bound = await opts.binding(Number(api.conversationId)), env = api.env;
          if (!bound || bound.child || !bound.senderIsOwner || bound.identity.kind === "event" || !(env instanceof PiExecutionEnv)) throw new Error(SKILL_OWNER_ONLY);
          return output(JSON.stringify(await publishSkill(opts.skills, env.policy.workspace, args)));
        } catch (error) { return { ...output((error as Error).message), isError: true }; }
      },
    })],
  });
}
