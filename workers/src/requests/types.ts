import type { ContextSnapshot, TextPart } from "./snapshot";
export type RequestStatus = "running" | "done" | "error" | "aborted" | "interrupted";
export type RequestScope = { thread: string; actor: string; purpose: "conversation" | "background" | "subagent" | "compaction" };
export type RequestRecord = RequestScope & {
  id: string; startedAt: number; endedAt: number | null; provider: string; model: string; status: RequestStatus;
  inputTokens: number | null; outputTokens: number | null; cacheRead: number | null; cacheWrite: number | null; reasoningTokens: number | null;
  durationMs: number | null; contextWindow: number; stopReason?: string; error?: string;
};
export type RequestDetail = { request: RequestRecord; context: ContextSnapshot; response?: TextPart };
export type RequestQuery = { since: number; until: number; thread?: string; model?: string; status?: RequestStatus; purpose?: string; before?: number; limit: number };
