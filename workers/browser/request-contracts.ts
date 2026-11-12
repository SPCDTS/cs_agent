import { ContextMetrics } from "../src/requests/context-types";
import { Type, type Static } from "typebox";

const numberOrNull = Type.Union([Type.Number(), Type.Null()]);
const textOrNull = Type.Union([Type.String(), Type.Null()]);
export const Binding = Type.Object({ turnId: Type.String(), inputId: Type.String(), generation: Type.Number() });
export const RequestRecord = Type.Object({ id: Type.String(), thread: Type.String(), actor: Type.String(), purpose: Type.String(), startedAt: Type.Number(),
  endedAt: numberOrNull, provider: Type.String(), model: Type.String(), status: Type.String(), inputTokens: numberOrNull, outputTokens: numberOrNull,
  cacheRead: numberOrNull, cacheWrite: numberOrNull, durationMs: numberOrNull, contextWindow: Type.Number(),
  contextMetrics: Type.Optional(ContextMetrics),
  stopReason: Type.Optional(Type.String()), error: Type.Optional(Type.String()), binding: Type.Optional(Binding),
  toolCalls: Type.Optional(Type.Array(Type.Object({ id: Type.String(), name: Type.String() }))),
});
export type RequestRecord = Static<typeof RequestRecord>;
export const TextPart = Type.Object({ text: Type.String(), chars: Type.Optional(Type.Number()), truncated: Type.Optional(Type.Boolean()) });
export type TextPart = Static<typeof TextPart>;
export const MessagePart = Type.Object({ ...TextPart.properties,
  blocks: Type.Optional(Type.Array(Type.Object({ kind: Type.String(), start: Type.Number(), end: Type.Number(), id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }))),
});
export type MessagePart = Static<typeof MessagePart>;
export const ContextBody = Type.Object({ part: MessagePart, paired: Type.Array(Type.Object({ id: Type.String(), part: MessagePart })) });
const ContextMessage = Type.Object({ ...MessagePart.properties, role: Type.String(), toolName: Type.Optional(Type.String()), toolCallId: Type.Optional(Type.String()) });
export type ContextMessage = Static<typeof ContextMessage>;
export const Context = Type.Object({ system: TextPart, messages: Type.Array(ContextMessage), tools: Type.Array(Type.Object({ ...TextPart.properties, name: Type.String() })),
  messageCount: Type.Number(), toolCount: Type.Number(), omittedMessages: Type.Number(), truncated: Type.Boolean(),
  chars: Type.Object({ system: Type.Number(), messages: Type.Number(), tools: Type.Number() }),
});
export type Context = Static<typeof Context>;
export const ToolSummary = Type.Object({ id: Type.String(), thread: Type.String(), binding: Binding, callId: Type.String(), parentCallId: Type.Optional(Type.String()),
  name: Type.String(), startedAt: Type.Number(), endedAt: numberOrNull, status: Type.String(), detailAvailable: Type.Optional(Type.Boolean()),
});
export type ToolSummary = Static<typeof ToolSummary>;
export const ToolDetail = Type.Object({ ...ToolSummary.properties, arguments: Type.Optional(TextPart), result: Type.Optional(TextPart) });
export type ToolDetail = Static<typeof ToolDetail>;
const DetailBase = { bodyDeferred: Type.Optional(Type.Boolean()), responseAvailable: Type.Optional(Type.Boolean()), request: RequestRecord, tools: Type.Array(ToolSummary), related: Type.Array(RequestRecord), response: Type.Optional(MessagePart) };
export const RequestDetail = Type.Union([
  Type.Object({ ...DetailBase, detailAvailable: Type.Literal(true), context: Context }),
  Type.Object({ ...DetailBase, detailAvailable: Type.Literal(false) }),
]);
export type RequestDetail = Static<typeof RequestDetail>;
export const RequestPage = Type.Object({ requests: Type.Array(RequestRecord), next: Type.Optional(Type.Number()) });
const Tokens = { inputTokens: Type.Number(), outputTokens: Type.Number() };
export const Usage = Type.Object({
  summary: Type.Object({ ...Tokens, requests: Type.Number(), failed: Type.Number(), running: Type.Number(), measured: Type.Number(),
    cacheRead: Type.Number(), cacheInputTokens: Type.Number(), cacheMeasured: Type.Number(), avgDuration: numberOrNull }),
  series: Type.Array(Type.Object({ ...Tokens, at: Type.Number() })), models: Type.Array(Type.Object({ ...Tokens, model: Type.String(), requests: Type.Number() })),
  choices: Type.Array(Type.String()), bucket: Type.Number(), retainedSince: numberOrNull,
});
export type Usage = Static<typeof Usage>;
export const Asset = Type.Object({ scope: Type.String(), id: Type.String(), name: Type.String(), bytes: Type.Number() });
export type Asset = Static<typeof Asset>;
export const ChatMessage = Type.Object({ id: Type.String(), role: Type.String(), source: Type.String(), name: Type.String(), text: Type.String(), at: Type.Number(),
  status: textOrNull, turnId: textOrNull, assets: Type.Array(Asset) });
export type ChatMessage = Static<typeof ChatMessage>;
export const ChatView = Type.Object({ messages: Type.Array(ChatMessage), delta: Type.Boolean(), active: Type.Number(), syncedAt: Type.Optional(Type.Number()) });
export const Trace = Type.Object({ requests: Type.Array(RequestRecord), tools: Type.Array(ToolSummary), cursor: Type.Number(), more: Type.Boolean() });
export const PendingChat = Type.Object({ requestId: Type.String(), text: Type.String() });
export type ChatTarget = {kind:"thread";thread:string} | {kind:"subagent";thread:string;id:string;summary:string};
export interface ConsoleState {
  view: string; until: number; before: number | undefined; next: number | undefined; pages: (number | undefined)[]; requestVersion: number; detailVersion: number;
  chat: ChatTarget; chatVersion: number; fingerprint: string; timer: number | undefined; resizeTimer?: number; sending: boolean; epoch: number;
  pending: Static<typeof PendingChat> | null; chatActive: boolean; requestActive: boolean; chatLoading: boolean;
  messages: Map<string, ChatMessage>; requests: Map<string, RequestRecord>; tools: Map<string, ToolSummary>;
  traceTurns: string; traceCursor: number; chatAfter: number | null; turn: string | null; detailId: string | null;
  chart?: { u: Usage; since: number; until: number }; awaitingInput?: string | null; locateTurn?: string | null;
}
