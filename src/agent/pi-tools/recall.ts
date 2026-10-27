import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { parseAccess } from "../../context/access.js";
import type { MediaRecall } from "../../context/media.js";
import type { PiCallBinding } from "./request.js";

export function recallTool(binding: (conversationId: number) => Promise<PiCallBinding | undefined>, media?: Pick<MediaRecall, "recall">) {
  return defineTool({
    name: "qq_image", description: "Recall an image by message id within the current authorization scope; return only its local path as text. In messages, '[image]' means not yet recalled: call qq_image(message_id) when you need to view it, then open the returned path with read. '[image:<path>]' means already recalled and can be opened directly with read. Reading an image with read returns its image content.",
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
