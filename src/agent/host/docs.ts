import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { InputRef, RunPerson, TurnKind, TurnStatus } from "./types.js";

/**
 * 每个会话键一份（family 成员键 = threadKey，docs/ARCHITECTURE.md §2.3）。
 * 不同会话的状态互不读写：投递、插话、回合事件只改本会话的小文档，不重写全局大表。
 */
export type ThreadHostState = {
  threadKey: string;
  /** 有回合进行中，或开轮请求已发出、尚未拿到 turnId */
  busy: boolean;
  turnId?: string;
  turnKind?: TurnKind;
  /** 本轮发送者：用户回合为 QQ 号，定时为创建者，唤醒回合为空 */
  turnSender?: string;
  turnSource?: string;
  /** 唤醒回合确证继承的人（派出子 agent 那一轮的人，§5.1）；缺省为会话基础权限。随会话文档持久化，重启后保持 */
  turnInherited?: RunPerson;
  /** 本轮已送入的输入（开轮时的批次 + 之后的插话） */
  turnInputs: InputRef[];
  /** 等本轮结束的输入，按 seq 升序 */
  pending: InputRef[];
  /** 本轮是否已 @ 过发送者（§3.2） */
  mentioned: boolean;
  /** 开轮时写入；回合中的活动只在内存刷新，不逐条落盘 */
  lastActivityAt?: number;
  /**
   * 会话后端（一个会话同一时间只由一个后端服务，§2.4）：开轮、插话、放弃与恢复都用它；空闲后保留。
   * 只在开新回合、会话空闲、队列里只有这一条且它从未交给过后端、旧后端不忙时才可能改变。
   */
  backend?: string;
};

export const ThreadHostDoc = defineDocFamily<ThreadHostState, string>({
  kind: "cs.thread-host", version: 1, scope: "session", family: true,
  initial: threadKey => ({ threadKey, busy: false, turnInputs: [], pending: [], mentioned: false }),
});

/**
 * 全局到达序号与"需要恢复"的会话集合（忙或有排队输入）。
 * Session 无法枚举 family 成员，重启时据此找回会话；空闲且无排队的会话从集合中移除。
 */
export const ThreadHostIndexDoc = defineDoc<{ nextSeq: number; active: Record<string, true> }>({
  kind: "cs.thread-host.index", version: 1, scope: "session",
  initial: () => ({ nextSeq: 1, active: {} }),
});

/**
 * 每条输入一份（成员键 = inboundKey），只作幂等凭据与投递状态：
 * 回合结束后输入从会话文档移除，这里仍保留，重复投递永远是空操作。
 * state：queued（未交给后端）→ starting（开轮或插话请求已发出、未确认；崩溃后它可能已在会话后端里）
 * → delivered（后端已收下）→ done（所在回合结束）。插话被拒时 starting 改回 queued。
 * done 时同一提交写入所在回合的结果（status、turnId）：外层的结算（定时运行统计）崩溃丢失后据此重放同一结果。
 */
export type HostInputState = {
  threadKey: string; seq: number; state: "new" | "queued" | "starting" | "delivered" | "done";
  status?: TurnStatus; turnId?: string; reason?: "backend_unsupported";
};
export const HostInputDoc = defineDocFamily<HostInputState, string>({
  kind: "cs.thread-host.input", version: 1, scope: "session", family: true,
  initial: threadKey => ({ threadKey, seq: 0, state: "new" }),
});
