import type { ThreadKey } from "../backends/types.js";

export type { ThreadKey };

/**
 * ThreadHost 与后端适配器的契约（设计 §3、§4.2）。
 * 适配器只负责"把输入送进后端"并回报回合事件；开新一轮、插话还是排队由 ThreadHost 决定。
 */

/** user：QQ 消息；scheduled：定时任务到点的输入（§10） */
export type InputKind = "user" | "scheduled";
/** wake：后端自己开的回合（子 agent 完成唤醒），没有新输入 */
export type TurnKind = InputKind | "wake";

/** 投递给 ThreadHost 的一条输入。正文、图片等由 Inbox 按 inboundKey 保存，宿主只持有引用。 */
export type HostInput = {
  /** 入站消息的确定性键（定时为触发键）；同一键重复投递是空操作 */
  inboundKey: string;
  kind: InputKind;
  /** user：发送者 QQ 号；scheduled：创建者 */
  sender: string;
};

/** 宿主持久化的输入引用：seq 为全局到达序号（跨会话单调递增），at 为到达时间（毫秒）。 */
export type InputRef = HostInput & { seq: number; at: number };

/**
 * 开一轮时随输入一起交给适配器的回合信息。
 * admit：定时输入的准入复核（宿主在首次开轮前已调用）；适配器内部重试开轮时，每次重试前须再调用，
 * 返回 false 时不再开轮、返回 { denied: true }。适配器不得把它传给后端本身。
 * backend：会话后端（宿主落盘在会话文档，由 plan 选定）；适配器按它开轮，不得重新选择。
 */
export type TurnContext = { kind: InputKind; sender: string; admit?: () => Promise<boolean>; backend?: string };

export type TurnStatus = "completed" | "failed" | "lost";

/**
 * 开轮结果：
 * - turnId：新回合（输入已送入）。
 * - backendTurnId：后端已有宿主尚未确认的回合（子 agent 唤醒等）——输入没有送入（并入会让唤醒工作拿到本轮发送者的身份），
 *   宿主按唤醒回合接管该回合，输入放回队列等它结束。
 * - denied：重试前准入复核被拒（见 TurnContext.admit），没有开轮。
 */
export type StartTurnResult = { turnId: string } | { backendTurnId: string } | { denied: true };

/** 回合结果（与 onTurnCompleted 回报的一致）。 */
export type TurnOutcome = { status: TurnStatus; error?: string };

export interface ThreadAdapter {
  /**
   * 选定会话后端（宿主在会话串行内、开新回合之前调用：会话首次开轮，或会话空闲、队列只有这一条且它从未交给过后端时）。
   * current 为会话当前后端：配置改为别的后端时，current 在该会话仍忙（pi 子 agent 在跑等）则返回 current。
   * 返回值落盘为会话后端，作为 ctx.backend 交回 startTurn。抛错时宿主沿用当前后端（新会话则稍后重试）。
   */
  plan?(threadKey: ThreadKey, input: InputRef, current?: string): Promise<string>;
  /** 开一轮（宿主每轮只送一条输入；同一发送者随后的输入走插话）。抛错视为投递失败，宿主按回合失败结束这条输入。 */
  startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], ctx: TurnContext): Promise<StartTurnResult>;
  /** 插话进当前回合；回合恰好已结束（或 id 不符）时返回 no_active_turn，宿主回退为排队。 */
  steer(threadKey: ThreadKey, turnId: string, input: InputRef): Promise<"ok" | "no_active_turn">;
  /** 中止当前回合（面板"停止"、看门狗）；回合结束仍由 onTurnCompleted 回报。 */
  interrupt(threadKey: ThreadKey): Promise<void>;
  /** 重启恢复：持久化为进行中的回合是否仍存在（pi 回合可续跑 → alive；codex 随进程丢失 → lost）。 */
  recoverTurn(threadKey: ThreadKey, turnId: string): Promise<"alive" | "lost">;
  /**
   * 宿主已不再跟踪这个回合（被唤醒回合取代）：仍在运行的后端工作不能再以该回合的身份行事。返回宿主应记下的该回合结果：
   * - 回合已在后端结束（结束事件还排在宿主队列里）→ 后端回报的真实结果（如 failed）；
   * - codex 回合仍在跑 → turn/interrupt 中止，lost；
   * - pi run 降为唤醒身份、继续运行 → completed。
   * 之后到达的结束事件宿主按过期忽略。
   */
  abandon?(threadKey: ThreadKey, turnId: string): Promise<TurnOutcome>;
  /** 后端在该会话是否仍有工作（回合或 run 未结束、子 agent 在跑、codex 正在压缩）；后端切换须等它为 false。 */
  busy?(threadKey: ThreadKey): Promise<boolean>;
}

/**
 * 适配器回报回合事件的入口（ThreadHost 实现）。
 * 调用立即返回，事件在该会话的串行队列里处理；适配器可以在 startTurn / steer 返回之前回调，但不能等待回调完成。
 */
export interface HostCallbacks {
  /** initiatedBy=backend 表示后端自己开的唤醒回合；host 表示 startTurn 开的回合（仅刷新活动时间）。 */
  onTurnStarted(threadKey: ThreadKey, turnId: string, initiatedBy: "host" | "backend"): void;
  onTurnCompleted(threadKey: ThreadKey, turnId: string, result: { status: TurnStatus; error?: string }): void;
  /** 模型输出、工具调用、子 agent 活动；只刷新看门狗时间。 */
  onActivity(threadKey: ThreadKey): void;
}

/** 工具调用（发送、召回、生图、定时、授权）取用的本轮身份（§7.3）；契约定义在通道层，工具与通道共用。 */
export type { TurnIdentity } from "../../channel/types.js";
import type { TurnIdentity } from "../../channel/types.js";

/** 回合结束（含开轮失败、重启后丢失）：外层据此发出错提示、把输入标记 done、统计定时运行结果。 */
export type TurnEnded = {
  threadKey: ThreadKey;
  /** 开轮失败时没有 turnId */
  turnId?: string;
  kind: TurnKind;
  sender?: string;
  inputs: InputRef[];
  status: TurnStatus;
  error?: string;
};

export interface ThreadHostEvents {
  /** 输入已被后端确认收下（开轮成功或插话成功） */
  inputsDelivered?(threadKey: ThreadKey, turnId: string, inputs: readonly InputRef[]): void;
  turnEnded?(event: TurnEnded): void;
}

export type DeliverResult = "duplicate" | "steered" | "queued";
