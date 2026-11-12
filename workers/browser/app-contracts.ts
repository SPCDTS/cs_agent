import { Type, type Static, type TSchema } from "typebox";
import { Diagnostic } from "./api";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const optionalText = Type.Optional(nullable(Type.String()));
const optionalNumber = Type.Optional(nullable(Type.Number()));
export const ModelSelection = Type.Object({ provider: Type.String(), id: Type.String(), reasoningEffort: Type.Optional(Type.String()) });
export const ThreadStats = Type.Union([
  Type.Object({ error: Type.String() }),
  Type.Object({ inbound: Type.Object({ queued: Type.Number(), done: Type.Number(), failed: Type.Number() }), outbox: Type.Number(),
    memory: Type.Object({ active: Type.Number(), profileBytes: Type.Number() }),
    subagents: Type.Optional(Type.Object({ running: Type.Number() })), lastSentAt: optionalNumber }),
]);
export const Overview = Type.Object({
  commit: Type.String(), bridge: Type.Object({ connected: Type.Boolean(), selfId: optionalText, ignored: Type.Number() }),
  model: Type.Union([ModelSelection, Type.Object({ unavailable: Type.String() })]),
  threads: Type.Array(Type.Object({ key: Type.String(), name: Type.Optional(Type.String()), kind: Type.String(), stats: ThreadStats,
    sandbox: Type.Optional(Type.String()) })),
  sendRules: Type.Array(Type.Object({ scope: Type.String(), until: Type.Number() })),
  schedule: Type.Union([Type.Object({ error: Type.String() }), Type.Object({ active: Type.Number(), paused: Type.Number() })]),
  events: Type.Union([Type.Object({ error: Type.String() }), Type.Object({ held: Type.Number() })]),
  mcp: Type.Array(Type.Object({ server: Type.String(), login: Type.String(), credential: Type.String(), enabled: Type.Boolean(), tools: nullable(Type.Number()) })),
  configured: Type.Record(Type.String(), Type.Boolean()),
});
export type Overview = Static<typeof Overview>;
export const Subagents = Type.Array(Type.Object({ id: Type.String(), task: Type.String(), status: Type.String(), createdAt: Type.Number(),
  deadline: optionalNumber, endedAt: optionalNumber, lastReportAt: optionalNumber, spawner: optionalText }));
export type Subagents = Static<typeof Subagents>;
export const EventDetail = Type.Object({ server: Type.Optional(Type.String()), action: Type.Optional(Type.String()), source: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()), ms: Type.Optional(Type.Number()), inputBytes: Type.Optional(Type.Number()), outputBytes: Type.Optional(Type.Number()),
  result: Type.Optional(Type.String()), tools: Type.Optional(Type.Number()), rejected: Type.Optional(Type.Number()), digest: Type.Optional(Type.String()),
  code: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])), status: Type.Optional(Type.String()), results: Type.Optional(Type.Number()),
  commandLength: Type.Optional(Type.Number()), candidates: Type.Optional(Type.Number()), written: Type.Optional(Type.Number()), reason: Type.Optional(Type.String()),
  usage: Type.Optional(Type.Object({ totalTokens: Type.Optional(Type.Number()) })),
});
export type EventDetail = Static<typeof EventDetail>;
export const Events = Type.Object({ events: Type.Array(Type.Object({ at: Type.Number(), kind: Type.String(), detail: Type.Unknown() })), next: Type.Optional(Type.Number()) });
const Run = Type.Object({ status: Type.String(), ended_at: optionalNumber, started_at: optionalNumber, fire_at: Type.Number(), reason: optionalText });
export const Schedules = Type.Array(Type.Object({ id: Type.String(), name: Type.String(), conversation: Type.String(), status: Type.String(),
  rule: Type.Union([Type.Object({ kind: Type.Literal("rrule"), rrule: Type.String() }), Type.Object({ kind: Type.Literal("at"), at: Type.Number() })]),
  runs: Type.Array(Run), pause_reason: optionalText, next_fire_at: optionalNumber, failures: Type.Number(),
}));
export type Schedule = Static<typeof Schedules>[number];
export const SourceSettings = Type.Object({ intervalS: Type.Number(), mergeWindowS: Type.Number(), budgetPerHour: Type.Number(),
  filters: Type.Object({ requireLabels: Type.Array(Type.String()), excludeLabels: Type.Array(Type.String()), excludeSenders: Type.Array(Type.String()) }),
  quietHours: Type.Optional(Type.Object({ start: Type.String(), end: Type.String() })),
});
const GitHubUser = Type.Object({id:Type.Number(),login:Type.String()});
export const GitHubConnections = Type.Object({configured:Type.Boolean(),slug:Type.String(),identities:Type.Array(GitHubUser),
 installations:Type.Array(Type.Object({installationId:Type.Number(),user:GitHubUser,repositories:Type.Array(Type.Object({id:Type.Number(),name:Type.String()})),status:Type.Union([Type.Literal("active"),Type.Literal("revoked")]),until:Type.Number()}))});
export const GitHubView = Type.Object({
 mode:Type.Union([Type.Literal("manual"),Type.Literal("app")]),connections:GitHubConnections,
 configured: Type.Boolean(), revision: Type.String(), count: Type.Number(), capacity: Type.Number(), pendingCapacity: Type.Number(),
 value: Type.Object({ repositoryIds:Type.Optional(Type.Array(Type.Object({installationId:Type.Number(),repositoryId:Type.Number()}))), repositories: Type.Array(Type.String()), selections: Type.Array(Type.String()), paused: Type.Boolean(), settings: SourceSettings }),
 pins: Type.Array(Type.Object({ name: Type.String(), repository_id: Type.Number() })),
 receipts: Type.Array(Type.Object({ delivery_id: Type.String(), received_at: Type.Number(), repository: Type.String(), event: Type.String(),
 action: Type.String(), state: Type.String(), reason: Type.Union([Type.String(),Type.Null()]), outcome: Type.Union([Type.String(),Type.Null()]) })),
});
export type GitHubView = Static<typeof GitHubView>;

export const Sources = Type.Object({ sources: Type.Array(Type.Object({ id: Type.String(), paused: Type.Boolean(), degraded: Type.Boolean(),
  cursor: Type.Unknown(), lastPollAt: optionalNumber, held: Type.Number(), budget: Type.Object({ used: Type.Number(), perHour: Type.Number() }),
  pauseReason: optionalText, failures: Type.Number(), lastErrorCode: optionalText, configured: Type.Boolean(), settings: SourceSettings })),
  github: GitHubView,
  watch: Type.Object({ topic: Type.Boolean(), expiration: optionalNumber }),
  runs: Type.Array(Type.Object({ source: Type.String(), status: Type.String(), deliveredAt: Type.Number(), events: Type.Number(), endedAt: optionalNumber })),
});
export type Sources = Static<typeof Sources>;
const SettingsValue = Type.Object({ groupTrigger: Type.String(), allowGroups: Type.Array(Type.String()), allowUsers: Type.Array(Type.String()),
  extractNamespaces: Type.Array(Type.String()), model: ModelSelection });
export const Settings = Type.Object({ value: SettingsValue, defaults: SettingsValue, overrides: nullable(SettingsValue), revision: Type.String(), updatedAt: optionalNumber,
  applied: Type.Optional(Type.Boolean()) });
export type Settings = Static<typeof Settings>;
const Account = Type.Object({ id: Type.String(), label: Type.String(), status: Type.String(), catalogFailure: Type.Optional(Diagnostic) });
export const ModelView = Type.Object({ revision: Type.String(), current: ModelSelection,
  providers: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), available: Type.Boolean(), reason: Type.Optional(Type.String()),
    models: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })) })),
  codex: Type.Object({ status: Type.String(), loggedIn: Type.Boolean(), needsReauth: Type.Optional(Type.Boolean()), email: optionalText,
    imageGeneration: Type.Optional(Type.Boolean()), hasCredential: Type.Boolean(), flow: optionalText, expiresAt: optionalNumber,
    refreshFailure: Type.Optional(Type.Intersect([Diagnostic, Type.Object({ at: Type.Number() })])), catalogFailure: Type.Optional(Diagnostic),
    accounts: Type.Array(Account), activeId: optionalText }),
});
export type ModelView = Static<typeof ModelView>;
export const Profile = Type.Object({ text: Type.String(), revision: Type.String() });
export type Profile = Static<typeof Profile>;
export const MemoryRow = Type.Object({ id: Type.Number(), text: Type.String(), kind: Type.String(), status: Type.String(), subject: optionalText,
  due_at: optionalNumber, author: Type.String(), updated_at: Type.Number() });
export const MemoryView = Type.Object({ profile: Profile, memories: Type.Array(MemoryRow) });
export type MemoryView = Static<typeof MemoryView>;
export const MemoryList = Type.Object({ items: Type.Array(MemoryRow), total: Type.Number() });
export const Skills = Type.Object({ skills: Type.Array(Type.Object({ name: Type.String(), description: Type.String(), files: Type.Array(Type.Unknown()), enabled: Type.Boolean() })) });
export type Skills = Static<typeof Skills>["skills"];
export const Skill = Type.Object({ name: Type.String(), body: Type.String(), files: Type.Record(Type.String(), Type.String()) });
export const StatusResult = Type.Object({ status: Type.String() });
export const ScheduleResult = Type.Object({ status: Type.Optional(Type.String()), name: Type.Optional(Type.String()), next_fire_at: optionalNumber });
export const UrlResult = Type.Object({ url: Type.String() });
export const TicketResult = Type.Object({ ticket: Type.String() });
export const RevokedResult = Type.Object({ revoked: Type.Boolean() });
export const RefreshResult = Type.Object({ results: Type.Array(Type.Object({ server: Type.String(), status: Type.String(), tools: Type.Number() })) });

export type SourceFields = Record<"intervalS" | "mergeWindowS" | "budgetPerHour" | "requireLabels" | "excludeLabels" | "excludeSenders" | "quietStart" | "quietEnd", HTMLInputElement>;
export interface AppState {
  overview: Overview | null; settings: Settings | null; model: ModelView | null;
  eventKind: string; eventThread: string; before: number | undefined; history: (number | undefined)[]; next: number | undefined;
  memoryNs: string; memoryQuery: string; memoryView: MemoryView | null; profile: Profile | null;
  armedDelete: number | null; skills: Skills; armedSkill: string | null; timer: number | undefined; noticeTimer: number | undefined;
  subagents: Record<string, { list: Subagents | null }>; schedules: Schedule[]; armedSchedule: string | null;
  sources: Sources | null; editingSource: string | null; sourceForms: Record<string, HTMLDetailsElement>;
}

export const StopResult = Type.Object({ stopped: Type.Boolean() });
export const ResetResult = Type.Object({ reset: Type.Boolean() });
