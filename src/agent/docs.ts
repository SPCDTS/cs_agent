import { defineDoc } from "@earendil-works/pi-durable";
import type { ImageFailure } from "./image-gen.js";
import type { RouteName } from "./router.js";

export type TicketSource = {
  type: "private" | "group";
  user_id: string;
  group_id: string | null;
  nickname: string;
};

/** 已提交的 ComfyUI 任务（submit 阶段提交后立即与检查点同一提交写入；恢复时按它收取，不重复提交）。 */
export type ImageJob = { prompt_id: string; backend: string; /** 已提交次数（服务端丢失任务时最多重新提交 1 次） */ submits: number };

/** 生图阶段的结果（collect 阶段与检查点同一提交写入；任务重跑时据此跳过生图）。 */
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
  imageJob?: ImageJob;
  imageResult?: ImageResult;
  agentResult?: AgentResult;
  /** 后端回合标记：启动外部回合（codex）之前写入，崩溃恢复时据此避免重复询问 */
  codexTurn?: { outFile: string; attempts: number };
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
 * 仅保存未完成的票据；票据进入终态后才删除，基础设施错误时保留，重启后 recover() 按 ticketSeq
 * （bridge admit 顺序）与孤儿票据统一排序继续。attempts 为已开始运行的次数。
 * v2 的旧条目没有 scope/taskId（其会话里可能还有旧的模型会话任务，recover 时先中止）。
 */
export type DispatchEntry = {
  conversationId: number;
  scope?: string;
  /** bridge 票据的 seq（admit 顺序，唯一排序键） */
  ticketSeq?: number;
  /** 旧的派发器自增序号（仅旧条目；排序时作次级键） */
  seq?: number;
  taskId?: number;
  attempts?: number;
  /** 已放弃运行（giveUp 开始时写入）：任务的外部副作用阶段见到它即以 failed 结束，不再产生副作用 */
  givenUp?: boolean;
  /** failed：达到上限且兜底也发不出（bridge 不可用）；保留在索引里供审计，recover 跳过、对账不当作孤儿 */
  state?: "failed";
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
