/** 固定回复模板（生图路径与回合出错提示）。 */
import type { ImageFailure } from "../media/gen/image-gen.js";

export const IMAGE_SUCCESS_REPLY = "图片生成好了";

export const IMAGE_FAILURE_REPLIES: Readonly<Record<ImageFailure, string>> = {
  unavailable: "生图服务暂时不可用，请稍后再试。",
  timeout: "生图超时了，请稍后再试。",
  refused: "这个内容画不了，换个描述试试。",
  failed: "生图失败了，请稍后再试。",
};

/**
 * 出错提示（设计 §8.1）：只在出错时向会话发一条系统消息，模型正常结束但没发消息时不提示。
 * failed：回合失败（模型/提供方报错、codex 超时、pi 回合 error、看门狗中止）；lost：后端崩溃导致回合丢失；
 * undeliverable：后端不可用超过 2 分钟，输入无法投递。
 */
export const TURN_NOTICES = {
  failed: "这次处理出错了，需要的话请再说一次。",
  lost: "处理中断了，需要的话请再说一次。",
  undeliverable: "现在暂时处理不了，请稍后再试。",
} as const;
