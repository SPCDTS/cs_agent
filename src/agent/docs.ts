import type { ImageOptions } from "../media/gen/image-options.js";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ImageFailure, ImageSubmission, ReconcileStep, RemoteUpload } from "../media/gen/image-gen.js";
import type { RouteName } from "./router.js";

import type { TicketSource } from "./backends/types.js";

/** 已提交的 ComfyUI 任务（submit 阶段提交后立即与检查点同一提交写入；恢复时按它收取，不重复提交）。 */
type ImageJob = { prompt_id: string; backend: string; /** 已提交次数（服务端丢失任务时最多重新提交 1 次） */ submits: number; status?: "running"; deadline?: number; extensions?: number; nextCollectAt?: number };

/** 生图阶段的结果（collect 阶段与检查点同一提交写入；任务重跑时据此跳过生图）。 */
export type ImageResult =
  | { ok: true; images: string[] }
  | { ok: false; failure: ImageFailure; message?: string };

/**
 * 生图前缀路由的票据文档（第 2 阶段保留，设计 §11）：每条生图消息一个会话。ticket 只来自这里。
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
  imageOptions?: ImageOptions;
  source_images?: string[];
  image_error?: string;
  imageJob?: ImageJob;
  remoteUploads?: RemoteUpload[];
  /** 提交前落盘；没有 prompt_id 时按前缀对账，不能盲目重新提交。 */
  submitIntent?: ImageSubmission & { attempt: number };
  /** 每次对账查询前后的持久化记录；matched 的 prompt_id 同时写入 imageJob。 */
  imageReconciliation?: (ReconcileStep & { attempt: number })[];
  imageResult?: ImageResult;
  /** 实际发出的正文、图片数与 QQ 消息 id */
  replyText?: string;
  replyImages?: number;
  replyMessageId?: string;
  /** 入站消息时间（unix 秒）与 message_id */
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
 * Session 级生图派发索引：ticket → conversationId / 当前任务。
 * 仅保存未完成的票据；票据进入终态后才删除，基础设施错误时保留，重启后 recover() 按 ticketSeq 继续。
 * attempts 为已开始运行的次数。
 */
export type DispatchEntry = {
  conversationId: number;
  scope?: string;
  /** 票据的 seq（开票顺序，唯一排序键） */
  ticketSeq?: number;
  /** 旧的派发器自增序号（仅旧条目；排序时作次级键） */
  seq?: number;
  taskId?: number;
  attempts?: number;
  /** 无原文的孤儿票据只发兜底，但仍占据 scope 队首并持久化重试次数。 */
  fallbackOnly?: boolean;
  /** 已放弃运行（giveUp 开始时写入）：任务的外部副作用阶段见到它即以 failed 结束，不再产生副作用 */
  givenUp?: boolean;
  /** failed：达到上限且兜底也发不出（bridge 不可用）；保留在索引里供审计，recover 跳过、对账不当作孤儿 */
  state?: "failed";
  /** v2 旧条目的提交内容（仅用于识别旧条目） */
  content?: string;
  /** 部署前的条目可能是 agent / 定时运行（第 2 阶段起不再由派发器处理） */
  kind?: "message" | "scheduled";
};
export type DispatchState = { pending: Record<string, DispatchEntry>; nextSeq?: number };

export const DispatchDoc = defineDoc<DispatchState>({
  kind: "cs.dispatch",
  version: 1,
  scope: "session",
  initial: () => ({ pending: {} }),
});

/** owner 管理的动作授权：send 主动发往别处，schedule 创建并管理自己的定时任务。 */
export type Grant = {
  user: string;
  caps: ("send" | "schedule")[];
  targets: string[];
  scopes?: string[];
  expires_at?: number;
  granted_by: string;
  created_at: number;
  updated_at: number;
};
export const GrantsDoc = defineDoc<Record<string, Grant>>({
  kind: "cs.grants", version: 1, scope: "session", initial: () => ({}),
});
