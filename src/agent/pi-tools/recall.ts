import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { parseAccess } from "../../context/access.js";
import type { MediaRecall } from "../../context/media.js";
import type { PiCallBinding } from "./request.js";

export function recallTool(binding: (conversationId: number) => Promise<PiCallBinding | undefined>, media?: Pick<MediaRecall, "recall">) {
  return defineTool({
    name: "qq_image", description: "按消息 id 召回本会话图片；只返回本地路径文本，用文件工具打开查看。",
    replay: "safe",
    parameters: Type.Object({ message_id: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
    async execute(args, api, context) {
      const bound = await binding(Number(api.conversationId));
      const access = parseAccess(bound?.access);
      if (!bound || !access) throw new Error("召回请求未绑定");
      if (!media) throw new Error("图片召回未启用");
      const signal = AbortSignal.any([AbortSignal.timeout(65_000), ...(context.abortSignal ? [context.abortSignal] : [])]);
      const result = await media.recall(access, args.message_id, signal);
      signal.throwIfAborted();
      return { output: [{ type: "text" as const, text: result.text }] };
    },
  });
}
