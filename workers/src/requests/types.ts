import type { ContextSnapshot, TextPart, MessagePart } from "./snapshot";
export type RequestStatus = "running" | "done" | "error" | "aborted" | "interrupted";
export type RequestBinding = { turnId: string; inputId: string; generation: number };
export type RequestScope = { thread: string; actor: string; purpose: "conversation" | "background" | "subagent" | "compaction" };
export type RequestRecord = RequestScope & {
  id: string; startedAt: number; endedAt: number | null; provider: string; model: string; status: RequestStatus;
  inputTokens: number | null; outputTokens: number | null; cacheRead: number | null; cacheWrite: number | null; reasoningTokens: number | null;
  durationMs: number | null; contextWindow: number; stopReason?: string; error?: string;
  binding?: RequestBinding; toolCalls?: { id: string; name: string }[];
};
export type ToolTrace = {
  id: string; thread: string; binding: RequestBinding; callId: string; parentCallId?: string; name: string;
  startedAt: number; endedAt: number | null; status: "running" | "done" | "error" | "interrupted";
  arguments: TextPart; result?: TextPart;
};
export type ToolSummary = Omit<ToolTrace, "arguments" | "result">;
export type RequestDetail = { request: RequestRecord; context: ContextSnapshot; response?: MessagePart };
export type RequestQuery = { since: number; until: number; thread?: string; model?: string; status?: RequestStatus; purpose?: string; turnId?: string; before?: number; limit: number };
