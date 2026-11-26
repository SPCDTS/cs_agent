import { ExecutionReference } from "./tool-types";
import { Type, type Static } from "typebox";

export const ContextTotals = Type.Object({ system: Type.Number(), tools: Type.Number(), summary: Type.Number(), user: Type.Number(), assistant: Type.Number(), result: Type.Number() });
export type ContextTotals = Static<typeof ContextTotals>;
export const ContextCategory = Type.KeyOf(ContextTotals);
export type ContextCategory = Static<typeof ContextCategory>;
export const CompactionPlan = Type.Object({
  firstKept: Type.Number(), selectedThrough: Type.Number(), startedAt: Type.Number(),
  summarizedChars: Type.Number(), summarizedMessages: Type.Number(), retainedChars: Type.Number(), retainedMessages: Type.Number(),
});
export type CompactionPlan = Static<typeof CompactionPlan>;
export const CodemodeCatalogSummary = Type.Object({
  digest: Type.String(),
  total: Type.Number(),
  inlined: Type.Number(),
  hidden: Type.Number(),
});
export type CodemodeCatalogSummary = Static<typeof CodemodeCatalogSummary>;
export const CodemodeNamespaceItem = Type.Object({
  name: Type.String(),
  description: Type.String(),
  instructions: Type.Optional(Type.String()),
  total: Type.Number(),
  inlined: Type.Number(),
});
export type CodemodeNamespaceItem = Static<typeof CodemodeNamespaceItem>;
export const CodemodeToolItem = Type.Object({
  name: Type.String(),
  jsName: Type.String(),
  namespace: Type.Optional(Type.String()),
  inlined: Type.Boolean(),
  deferred: Type.Optional(Type.Boolean()),
  chars: Type.Number(),
  truncated: Type.Boolean(),
  description: Type.String(),
  declaration: Type.String(),
  inputSchema: Type.String(),
  outputSchema: Type.Optional(Type.String()),
});
export type CodemodeToolItem = Static<typeof CodemodeToolItem>;
export const CodemodeCatalogView = Type.Object({
  summary: Type.Union([CodemodeCatalogSummary, Type.Null()]),
  catalogAvailable: Type.Boolean(),
  truncated: Type.Boolean(),
  namespaces: Type.Array(CodemodeNamespaceItem),
  tools: Type.Array(CodemodeToolItem),
});
export type CodemodeCatalogView = Static<typeof CodemodeCatalogView>;
export const ContextHead = Type.Union([
  Type.Object({ kind: Type.Literal("reset"), id: Type.Number() }),
  Type.Object({ kind: Type.Literal("compaction"), id: Type.Number(), at: Type.Number(), reason: Type.String(),
    firstKept: Type.Number(), plan: Type.Optional(CompactionPlan) }),
]);
export type ContextHead = Static<typeof ContextHead>;
export const ContextMetrics = Type.Object({ version: Type.Literal(1), chars: ContextTotals, messageCount: Type.Number(), toolCount: Type.Number(), imageCount: Type.Number(),
  head: Type.Optional(ContextHead), retainedChars: Type.Optional(Type.Number()), addedChars: Type.Optional(Type.Number()),
  codemode: Type.Optional(CodemodeCatalogSummary) });
export type ContextMetrics = Static<typeof ContextMetrics>;
export const ContextItem = Type.Object({ id: Type.String(), key: Type.String(), category: ContextCategory, chars: Type.Number(),
  label: Type.String(), images: Type.Number(), bodyAvailable: Type.Boolean(), truncated: Type.Boolean(),
  toolCallId: Type.Optional(Type.String()), at: Type.Optional(Type.Number()), execution: Type.Optional(ExecutionReference),
  phase: Type.Optional(Type.Union([Type.Literal("retained"), Type.Literal("added")])),
});
export type ContextItem = Static<typeof ContextItem>;
export const ContextAnalysis = Type.Object({ metrics: ContextMetrics, items: Type.Array(ContextItem) });
export type ContextAnalysis = Static<typeof ContextAnalysis>;
export const ContextRequestSummary = Type.Object({ id: Type.String(), startedAt: Type.Number(), model: Type.String(), provider: Type.String(),
  inputTokens: Type.Union([Type.Number(), Type.Null()]), cacheRead: Type.Union([Type.Number(), Type.Null()]), contextWindow: Type.Number(),
  status: Type.String(), metrics: Type.Optional(ContextMetrics) });
export type ContextRequestSummary = Static<typeof ContextRequestSummary>;
export const ContextInspection = Type.Object({
  current: ContextRequestSummary, previous: Type.Union([ContextRequestSummary, Type.Null()]),
  analysis: Type.Union([ContextAnalysis, Type.Null()]),
  comparison: Type.Union([Type.Object({ added: Type.Array(ContextItem), removed: Type.Array(ContextItem), kept: Type.Number(),
    reset: Type.Boolean(), compactionApplied: Type.Boolean() }), Type.Null()]),
});
export type ContextInspection = Static<typeof ContextInspection>;
export const ContextTimeline = Type.Object({ points: Type.Array(ContextRequestSummary), next: Type.Optional(Type.String()) });
export type ContextTimeline = Static<typeof ContextTimeline>;

export const emptyTotals = (): ContextTotals => ({ system: 0, tools: 0, summary: 0, user: 0, assistant: 0, result: 0 });
export const totalChars = (values: ContextTotals) => Object.values(values).reduce((total, count) => total + count, 0);
