/** 固定回复模板（生图路径、agent 失败、兜底）。 */
import type { ImageFailure } from "./image-gen.js";

export const FALLBACK_REPLY = "抱歉，这条消息处理失败了，请稍后再试。";
export const IMAGE_SUCCESS_REPLY = "图片生成好了";

export const IMAGE_FAILURE_REPLIES: Readonly<Record<ImageFailure, string>> = {
  unavailable: "生图服务暂时不可用，请稍后再试。",
  timeout: "生图超时了，请稍后再试。",
  refused: "这个内容画不了，换个描述试试。",
  failed: "生图失败了，请稍后再试。",
};

export const AGENT_FAILURE_REPLIES: Readonly<Record<"timeout" | "failed", string>> = {
  timeout: "处理超时了，请稍后再试。",
  failed: FALLBACK_REPLY,
};
