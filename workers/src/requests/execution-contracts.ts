import { Type, type Static } from "typebox";

const nullable = Type.Union([Type.Number(), Type.Null()]);
export const Delegation = Type.Object({ actor: Type.String(), inputId: Type.String() });
export type Delegation = Static<typeof Delegation>;

export const TraceSummary = Type.Object({
  thread: Type.String(),
  root: Type.String(),
  started: Type.Number(),
  last: Type.Number(),
  running: Type.Number(),
  failures: Type.Number(),
  requests: Type.Number(),
  tools: Type.Number(),
  children: Type.Number(),
  input: nullable,
  output: nullable,
  cost: nullable,
  priced: Type.Number(),
  cached: nullable,
  cacheInput: nullable,
  measured: Type.Number(),
});
export type TraceSummary = Static<typeof TraceSummary>;
export const TracePage = Type.Object({ traces: Type.Array(TraceSummary), next: Type.Optional(Type.String()) });

export const Observation = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("model"), Type.Literal("tool"), Type.Literal("turn")]),
  actor: Type.String(),
  turn: Type.String(),
  inputId: Type.String(),
  label: Type.String(),
  status: Type.String(),
  started: Type.Number(),
  ended: nullable,
  input: nullable,
  output: nullable,
  cached: nullable,
  written: nullable,
  cost: nullable,
  firstEvent: nullable,
  alarmWait: nullable,
  reasoning: nullable,
  callId: Type.String(),
  timing: Type.Optional(Type.Object({ queue: Type.Number(), firstVisible: nullable, delivery: nullable })),
  target: Type.Optional(Delegation),
  calls: Type.Array(Type.String()),
  parentCall: Type.String(),
  dispatch: Type.String(),
});
export type Observation = Static<typeof Observation>;

const Fields = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]));
export const PiSpan = Type.Object({
  id: Type.String(),
  trace: Type.String(),
  parent: Type.String(),
  actor: Type.String(),
  inputId: Type.String(),
  name: Type.String(),
  started: Type.Number(),
  ended: Type.Number(),
  status: Type.String(),
  attrs: Fields,
  events: Type.Array(Type.Object({ name: Type.String(), at: Type.Number(), attrs: Fields })),
  links: Type.Array(Type.Object({ trace: Type.String(), id: Type.String() })),
  omitted: Type.Number(),
});
export type PiSpan = Static<typeof PiSpan>;
export const TraceDetail = Type.Object({
  observations: Type.Array(Observation),
  next: Type.Optional(Type.String()),
});
export type TraceDetail = Static<typeof TraceDetail>;
export const PiPage = Type.Object({ spans: Type.Array(PiSpan), next: Type.Optional(Type.Number()) });

export const ModelBreakdown = Type.Object({
  actor: Type.String(),
  model: Type.String(),
  round: Type.String(),
  n: Type.Number(),
  input: nullable,
  output: nullable,
  cached: nullable,
  cacheInput: nullable,
  measured: Type.Number(),
  ms: nullable,
  cost: nullable,
  priced: Type.Number(),
});
export const ExecutionAnalysis = Type.Object({ groups: Type.Array(ModelBreakdown), more: Type.Boolean() });
