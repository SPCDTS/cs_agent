import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { parseAccess } from "../../context/access.js";
import type { MediaRecall } from "../../context/media.js";
import { PiRequestDoc } from "./request.js";

export function recallTool(media?: Pick<MediaRecall, "recall">) {
  return defineTool({
    name: "qq_image", description: "按消息 id 召回本会话图片，每轮最多 5 次；只返回本地路径文本，用文件工具打开查看。",
    replay: "safe",
    parameters: Type.Object({ message_id: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
    async execute(args, api, context) {
      const request = await api.snapshot(PiRequestDoc, api.conversationId, context);
      const access = parseAccess(request?.access);
      if (!request?.ticket || !access || request.calls[String(api.taskId)]?.kind !== "qq_image") throw new Error("召回请求未绑定");
      if (!media) throw new Error("图片召回未启用");
      if (request.deadline <= Date.now()) throw new Error("pi 请求已超时");
      const signal = AbortSignal.any([AbortSignal.timeout(request.deadline - Date.now()), ...(context.abortSignal ? [context.abortSignal] : [])]);
      const result = await media.recall(access, args.message_id, signal);
      signal.throwIfAborted();
      return { output: [{ type: "text" as const, text: result.text }] };
    },
  });
}
