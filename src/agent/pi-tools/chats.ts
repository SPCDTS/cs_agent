import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Channel } from "../../channel/types.js";
import { parseAccess } from "../../context/access.js";
import { listChatsText } from "../../context/chats.js";
import { PiRequestDoc } from "./request.js";

export function chatsTool(channel?: Pick<Channel, "listChats">) {
  return defineTool({
    name: "qq_chats", description: "只读列出群名、群号及好友备注；仅限主人私聊，用于按名称确认会话。",
    replay: "safe", parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_args, api, context) {
      try {
        const request = await api.snapshot(PiRequestDoc, api.conversationId, context);
        if (!request?.ticket) throw new Error("会话列表请求未绑定");
        if (request.deadline <= Date.now()) throw new Error("pi 请求已超时");
        const signal = AbortSignal.any([AbortSignal.timeout(request.deadline - Date.now()), ...(context.abortSignal ? [context.abortSignal] : [])]);
        const text = await listChatsText(parseAccess(request.access), channel, signal);
        return { output: [{ type: "text" as const, text }] };
      } catch (err) {
        return { output: [{ type: "text" as const, text: (err as Error).message }], isError: true };
      }
    },
  });
}
