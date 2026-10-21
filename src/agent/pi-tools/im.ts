import path from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AUTH_TOOLS, type ImPermissions } from "../grants.js";
import { authDescriptions, authParameters, sendParameters } from "../im-tools.js";
import { parseAccess } from "../../context/access.js";
import type { PiToolsOptions } from "./index.js";
import { PiExecutionEnv } from "./coding.js";
import { PiRequestDoc } from "./request.js";

const output = (text: string) => ({ output: [{ type: "text" as const, text }] });
/** 三个固定注册项按回合选择，避免修改共享 schema 影响另一个并行会话。 */
export function createPiImExtensions(opts: Pick<PiToolsOptions, "sendService" | "grants" | "dataDir">) {
  const make = (name: string, permissions: ImPermissions) => defineExtension({
    name,
    tools: [
      defineTool({
        name: "send_message", description: "用户能看到你内容的唯一方式：立即发送文字及可选图片、文件，默认回复本回合会话，返回 message_id。",
        parameters: sendParameters(permissions.target), replay: "safe",
        async execute(args, api, context) {
          try {
            const bound = await api.snapshot(PiRequestDoc, api.conversationId, context), env = api.env;
            const access = parseAccess(bound?.access);
            if (!bound?.ticket || !bound.source || !access || !(env instanceof PiExecutionEnv) ||
                env.policy.ticket !== bound.ticket || !opts.sendService) throw new Error("发送工具缺少本轮绑定");
            if (bound.deadline <= Date.now()) throw new Error("pi 请求已超时");
            const signal = AbortSignal.any([...(context.abortSignal ? [context.abortSignal] : []), AbortSignal.timeout(Math.max(1, bound.deadline - Date.now()))]);
            const result = await opts.sendService.send({ ticket: bound.ticket, source: bound.source,
              actor: bound.actor, actorIsOwner: bound.actorIsOwner, access,
              workdir: env.policy.workspace, extraRoots: [path.join(opts.dataDir, "images", bound.ticket)] }, args, { callId: api.callId }, signal);
            return output(JSON.stringify(result));
          } catch (error) { return { ...output((error as Error).message), isError: true }; }
        },
      }),
      ...(permissions.auth ? AUTH_TOOLS.map(name => defineTool({
        name, description: authDescriptions[name], parameters: authParameters[name],
        replay: name === "auth_list" ? "safe" as const : "unsafe" as const,
        async execute(args, api, context) {
          try {
            const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
            if (!bound?.ticket || !bound.actorIsOwner || !opts.grants) throw new Error("授权工具仅限 owner 回合");
            if (bound.deadline <= Date.now()) throw new Error("pi 请求已超时");
            context.abortSignal?.throwIfAborted();
            return output(JSON.stringify(await opts.grants.tool(bound, name, args)));
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
