/**
 * 执行 agent 的后端抽象（设计 §4.3）。两后端：codex（容器内 CLI 固定线程）与 pi（进程内 durable 会话，第 3 组）。
 * 后端只产出文本（与回合内生成的图片）；回复目标、发送与后处理由 agent 任务负责，后端不能也不需要指定。
 */
export type ThreadKey = "owner" | `group:${string}` | `private:${string}`;
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** 派发时冻结；执行、后处理与恢复只读此快照。 */
export type TicketSettings = {
  backend: BackendName;
  codexReasoningEffort: ReasoningEffort;
};

export type TicketSource = {
  type: "private" | "group";
  user_id: string;
  group_id: string | null;
  nickname: string;
};

export type BackendName = "codex" | "pi";
export const BACKEND_NAMES = ["codex", "pi"] as const;

export interface AgentRequest {
  ticket: string;
  settings?: Readonly<TicketSettings>;
  /** 会话 scope：group:<id> / private:<qq> */
  scope: string;
  /** 聊天记录访问范围（group:<id> / private:<qq> / all） */
  access: string;
  /** 记忆隔离键：owner 私聊 → owner，其余 → scope */
  threadKey: ThreadKey;
  source: TicketSource;
  /** 用户原文 */
  text: string;
  images?: string[];
  /** 入站消息时间（unix 秒） */
  time?: number;
  /** 被引用消息（≤200 字，由调用方从消息库查得） */
  quote?: { message_id: string; nickname: string; text: string };
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/** 后端回合的持久化标记（写在 TicketDoc，跨崩溃保留）：回合已开始的次数与回合输出文件。 */
export interface TurnState {
  outFile: string;
  attempts: number;
}

export interface AgentHandleContext {
  signal: AbortSignal;
  onEvent(e: AgentEvent): void;
  /** 上次（崩溃前）记录的回合标记；首次处理时为 undefined */
  turn?: Readonly<TurnState>;
  piTurn?: Readonly<{ requestId: string; retries: number }>;
  persistPiTurn?(state: { requestId: string; retries: number }): Promise<void>;
  /** 启动外部回合之前持久化回合标记（durable 任务提供；单独调用后端时可省略） */
  persistTurn?(state: TurnState): Promise<void>;
}

export interface AgentResponse {
  text: string;
  /** 回合内生成、随回复发送的图片（realpath，≤4，已过魔数检查） */
  images?: string[];
}

export interface AgentBackend {
  readonly name: BackendName;
  handle(req: AgentRequest, ctx: AgentHandleContext): Promise<AgentResponse>;
}

/** 后端超时：agent 任务据此选"处理超时"模板。 */
export class BackendTimeoutError extends Error {}
