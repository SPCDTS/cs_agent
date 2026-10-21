import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Channel } from "../../channel/types.js";
import { parseAccess } from "../../context/access.js";
import { listChatsText } from "../../context/chats.js";
import type { PiCallBinding } from "./request.js";

export function chatsTool(binding: (conversationId: number) => Promise<PiCallBinding | undefined>, channel?: Pick<Channel, "listChats">) {
  return defineTool({
    name: "qq_chats", description: "只读列出群名、群号及好友备注；仅限主人回合，用于按名称确认会话。",
    replay: "safe", parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, api, context) {
      try {
        const bound = await binding(Number(api.conversationId));
        if (!bound) throw new Error("会话列表请求未绑定");
        const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(context.abortSignal ? [context.abortSignal] : [])]);
        const text = await listChatsText(parseAccess(bound.access), channel, signal);
        return { output: [{ type: "text" as const, text }] };
      } catch (err) {
        return { output: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  });
}
