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
 */
export type TurnContext = { kind: InputKind; sender: string; admit?: () => Promise<boolean> };

export type TurnStatus = "completed" | "failed" | "lost";

/**
 * 开轮结果：
 * - turnId：新回合。accepted 存在时只有列出的入站键真正送入了后端（如重启后重放、首条所在 run 已结束），
 *   宿主只把这些标记为已送达，其余放回队列；缺省表示全部送入。
 * - backendTurnId：后端已有宿主尚未确认的回合（子 agent 唤醒等）——输入没有送入（并入会让唤醒工作拿到本轮发送者的身份），
 *   宿主按唤醒回合接管该回合，输入放回队列等它结束。
 * - denied：重试前准入复核被拒（见 TurnContext.admit），没有开轮。
 */
export type StartTurnResult = { turnId: string; accepted?: readonly string[] } | { backendTurnId: string } | { denied: true };

/** 放弃回合的结果：aborted = 后端工作被中止（回合按 lost 结束）；detached = 工作继续但不再代表该回合（按 completed 结束）。 */
export type AbandonResult = "aborted" | "detached";

export interface ThreadAdapter {
  /** 开一轮。抛错视为投递失败，宿主按回合失败结束这些输入。 */
  startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], ctx: TurnContext): Promise<StartTurnResult>;
  /** 插话进当前回合；回合恰好已结束（或 id 不符）时返回 no_active_turn，宿主回退为排队。 */
  steer(threadKey: ThreadKey, turnId: string, input: InputRef): Promise<"ok" | "no_active_turn">;
  /** 中止当前回合（面板"停止"、看门狗）；回合结束仍由 onTurnCompleted 回报。 */
  interrupt(threadKey: ThreadKey): Promise<void>;
  /** 重启恢复：持久化为进行中的回合是否仍存在（pi 回合可续跑 → alive；codex 随进程丢失 → lost）。 */
  recoverTurn(threadKey: ThreadKey, turnId: string): Promise<"alive" | "lost">;
  /**
   * 宿主已不再跟踪这个回合（被唤醒回合取代）：仍在运行的后端工作不能再以该回合的身份行事——
   * codex 中止 exec（aborted）；pi 把该 run 降为唤醒身份、继续运行（detached）。之后的结束事件宿主按过期忽略。
   */
  abandon?(threadKey: ThreadKey, turnId: string): Promise<AbandonResult>;
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
