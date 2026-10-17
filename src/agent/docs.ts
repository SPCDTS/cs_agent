import { defineDoc } from "@earendil-works/pi-durable";
import type { ImageFailure } from "./image-gen.js";
import type { RouteName } from "./router.js";

export type TicketSource = {
  type: "private" | "group";
  user_id: string;
  group_id: string | null;
  nickname: string;
};

/** 生图阶段的结果（generate 阶段与检查点同一提交写入；任务重跑时据此跳过生图）。 */
export type ImageResult =
  | { ok: true; images: string[] }
  | { ok: false; failure: ImageFailure };

/** 执行 agent 的结果（handle 阶段与检查点同一提交写入；任务重跑时据此不再调用后端）。 */
export type AgentResult =
  | { ok: true; backend: string; text: string; images: string[] }
  | { ok: false; backend: string; failure: "timeout" | "failed" };

/**
 * 每个 QQ 消息会话的文档。ticket 只来自这里，后端无法指定回复目标。
 * 各阶段的结果写在这里（而不只是任务检查点）：任务失败后派发器新建的任务能跳过已完成的阶段。
 */
export type TicketState = {
  ticket: string;
  source: TicketSource;
  text: string;
  /** 规则分流结果（§4.1）与命中的前缀 */
  route?: RouteName;
  prefix?: string;
  /** 生图提示词（route=image） */
  prompt?: string;
  imageResult?: ImageResult;
  agentResult?: AgentResult;
  /** 后处理后的回复正文（agent 路径 postprocess 阶段写入） */
  replyDraft?: string;
  /** 实际发出的正文、图片数与 QQ 消息 id */
  replyText?: string;
  replyImages?: number;
  replyMessageId?: string;
  /** 入站消息时间（unix 秒）与 message_id（[来源] 头部 / 引用查找用） */
  time?: number;
  messageId?: string;
  /** 入站消息 reply 段引用的 message_id */
  replyTo?: string;
};

export const TicketDoc = defineDoc<TicketState>({
  kind: "cs.ticket",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    ticket: "",
    source: { type: "private", user_id: "", group_id: null, nickname: "" },
    text: "",
  }),
});

/**
 * Session 级派发索引：ticket → conversationId / 当前任务。
 * 仅保存未完成的票据；票据进入终态（sent/uncertain）后才删除，基础设施错误时保留，重启后 recover() 按
 * scope 内 seq 顺序继续。attempts 为已开始运行的次数。
 * v2 的旧条目没有 scope/seq/taskId（其会话里可能还有旧的模型会话任务，recover 时先中止）。
 */
export type DispatchEntry = {
  conversationId: number;
  scope?: string;
  seq?: number;
  taskId?: number;
  attempts?: number;
  /** v2 旧条目的提交内容（仅用于识别旧条目） */
  content?: string;
};
export type DispatchState = { pending: Record<string, DispatchEntry>; nextSeq?: number };

export const DispatchDoc = defineDoc<DispatchState>({
  kind: "cs.dispatch",
  version: 1,
  scope: "session",
  initial: () => ({ pending: {} }),
});
