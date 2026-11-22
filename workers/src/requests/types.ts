import type { ContextSnapshot, TextPart, MessagePart } from "./snapshot";
export type RequestStatus = "running" | "done" | "error" | "aborted" | "interrupted";
export type RequestBinding = { turnId: string; inputId: string; generation: number };
export type RequestScope = { thread: string; actor: string; purpose: "conversation" | "background" | "subagent" | "compaction" };
export type RequestRecord = RequestScope & {
  id: string; startedAt: number; endedAt: number | null; provider: string; model: string; status: RequestStatus;
  inputTokens: number | null; outputTokens: number | null; cacheRead: number | null; cacheWrite: number | null; reasoningTokens: number | null;
  costUsd?: number | null; ttftMs?: number | null; alarmWaitMs?: number | null;
  durationMs: number | null; contextWindow: number; stopReason?: string; error?: string;
  contextMetrics?: import("./context-types").ContextMetrics;
  binding?: RequestBinding; toolCalls?: { id: string; name: string }[];
};
export type TurnTiming = {
  thread: string;
  turnId: string;
  inputId: string;
  kind: string;
  origin: "qq" | "web";
  status: "done" | "failed";
  receivedAt: number;
  admittedAt: number;
  queueWaitMs: number;
  firstDeliveredAt: number | null;
  deliveryWaitMs: number | null;
  endedAt: number;
  totalMs: number;
};
export type { ToolSummary } from "./tool-types";
export type ToolTrace = import("./tool-types").ToolSummary & {
  arguments: TextPart; result?: TextPart; structuredResult?: TextPart;
};
export type RequestDetail = { request: RequestRecord; context: ContextSnapshot; response?: MessagePart };
export type RequestQuery = { since: number; until: number; thread?: string; model?: string; status?: RequestStatus; purpose?: string; turnId?: string; excludeTurnId?: string; before?: number; limit: number };
