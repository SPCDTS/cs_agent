import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { QQBridge } from "../../qq/types.js";
import { TicketDoc } from "../docs.js";
import { log } from "../../log.js";

export const QQ_TEXT_LIMIT = 4000;
const TRUNC_NOTE = "\n…（内容过长，已截断）";

/** 截断到 ≤ limit 字符（按 code point，避免截断代理对），超长时附加提示。 */
export function fitText(text: string, limit = QQ_TEXT_LIMIT): { text: string; truncated: boolean } {
  const trimmed = text.trim() || "（无内容）";
  const chars = Array.from(trimmed);
  if (chars.length <= limit) return { text: trimmed, truncated: false };
  const keep = limit - Array.from(TRUNC_NOTE).length;
  return { text: chars.slice(0, keep).join("") + TRUNC_NOTE, truncated: true };
}

export type ReplyBridge = Pick<QQBridge, "reply">;

export function createReplyQQTool(getBridge: () => ReplyBridge) {
  return defineTool({
    name: "reply_qq",
    description:
      "把最终回复发回本条 QQ 消息的原会话（目标由系统绑定，无法更改）。text 为纯中文文本；image_paths 为 generate_image 返回的本地图片路径。调用后本轮结束。",
    parameters: Type.Object({
      text: Type.String({ description: "回复正文，纯文本，不要 Markdown，不要 @" }),
      image_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
    }),
    replay: "unsafe",
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const doc = await api.snapshot(TicketDoc, api.conversationId, context);
      if (!doc?.ticket) throw new Error("本会话没有绑定 QQ 票据");
      const { text, truncated } = fitText(args.text);
      const images = (args.image_paths ?? []).slice(0, 4);
      let result;
      try {
        result = await getBridge().reply(doc.ticket, text, images);
      } catch (err) {
        // 发送结果不确定/失败：永不重试，直接结束本轮，避免重复发送
        log.error("reply_qq failed", { ticket: doc.ticket.slice(0, 12), error: err });
        return {
          output: [{ type: "text", text: `发送失败：${(err as Error).message.slice(0, 200)}` }],
          isError: true,
          control: { terminate: true },
        };
      }
      log.info("reply_qq sent", {
        ticket: doc.ticket.slice(0, 12),
        message_id: result.message_id,
        already_sent: result.already_sent,
        images: images.length,
        truncated,
      });
      return {
        output: [
          {
            type: "text",
            text: `已发送${result.already_sent ? "（此前已发送）" : ""}${truncated ? "，文本已截断到 4000 字" : ""}`,
          },
        ],
        control: { terminate: true },
      };
    },
  });
}
