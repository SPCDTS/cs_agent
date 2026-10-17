import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { QQBridge } from "../../qq/types.js";
import { TicketDoc } from "../docs.js";
import { ticketImageDir } from "./generate-image.js";
import { log } from "../../log.js";

/** QQ 文本上限，按 UTF-16 code unit 计（与 QQBridge 的校验口径一致） */
export const QQ_TEXT_LIMIT = 4000;
const TRUNC_NOTE = "\n…（内容过长，已截断）";

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** 截断到 ≤ limit 个 UTF-16 code unit（不拆开代理对），超长时附加提示。 */
export function fitText(text: string, limit = QQ_TEXT_LIMIT): { text: string; truncated: boolean } {
  const trimmed = text.trim() || "（无内容）";
  if (trimmed.length <= limit) return { text: trimmed, truncated: false };
  let cut = trimmed.slice(0, Math.max(0, limit - TRUNC_NOTE.length));
  if (cut.length && isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  return { text: cut + TRUNC_NOTE, truncated: true };
}

export type ReplyBridge = Pick<QQBridge, "reply">;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 校验图片路径：realpath 必须位于 <imagesDir>/<ticket>/ 之下，且在本会话 generate_image 记录的列表中。
 * 返回 realpath 列表；不合规时抛出说明原因的错误。
 */
export async function resolveReplyImages(
  paths: string[],
  imagesDir: string,
  ticket: string,
  recorded: string[] | undefined,
): Promise<string[]> {
  if (!paths.length) return [];
  if (!recorded?.length) throw new Error("本会话没有 generate_image 生成的图片，不能附带 image_paths");
  const root = await fs.realpath(ticketImageDir(imagesDir, ticket)).catch(() => {
    throw new Error("本会话的图片目录不存在，不能附带 image_paths");
  });
  const allowed = new Set(recorded);
  const out: string[] = [];
  for (const p of paths) {
    const real = await fs.realpath(p).catch(() => null);
    if (!real || !isInside(real, root) || !allowed.has(real)) {
      throw new Error(`图片路径不合法：${p}（只能使用本会话 generate_image 返回的路径）`);
    }
    out.push(real);
  }
  return out;
}

export function createReplyQQTool(getBridge: () => ReplyBridge, imagesDir: string) {
  return defineTool({
    name: "reply_qq",
    description:
      "把最终回复发回本条 QQ 消息的原会话（目标由系统绑定，无法更改）。text 为纯中文文本；image_paths 只能是本会话 generate_image 返回的本地图片路径。调用后本轮结束。",
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
      let images: string[];
      try {
        images = await resolveReplyImages((args.image_paths ?? []).slice(0, 4), imagesDir, doc.ticket, doc.images);
      } catch (err) {
        // 未发送任何内容：不终止，让模型改正后重试（例如去掉 image_paths）
        log.warn("reply_qq rejected image paths", { ticket: doc.ticket.slice(0, 12), error: err });
        return { output: [{ type: "text", text: `未发送：${(err as Error).message}` }], isError: true };
      }
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
      // 记录回复正文与图片数（派发器据此更新消息库的机器人行）；记录失败不影响已发送的结果
      try {
        await api.commit(async (tx) => {
          const d = await tx.doc(TicketDoc, api.conversationId);
          d.replyText = text;
          d.replyImages = images.length;
        }, context);
      } catch (err) {
        log.warn("reply_qq record failed", { ticket: doc.ticket.slice(0, 12), error: err });
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
