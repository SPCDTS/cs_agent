import { Type, type Static } from "typebox";
import { MemoryRow } from "./app-contracts";

export const SessionHistorySchema = Type.Object({ entries: Type.Array(Type.Object({
  id: Type.Number(), kind: Type.String(), reset: Type.Boolean(),
  archive: Type.Optional(Type.Object({ label: Type.String(), at: Type.Number() })),
  messages: Type.Array(Type.Object({ role: Type.String(), text: Type.String(), toolName: Type.Optional(Type.String()) })),
})), next: Type.Optional(Type.String()) });
export const SubagentConversationSchema = Type.Object({
  ...SessionHistorySchema.properties,
  entries: Type.Array(Type.Object({
    ...SessionHistorySchema.properties.entries.items.properties,
    messages: Type.Array(Type.Object({
      role: Type.String(), text: Type.String(), at: Type.Optional(Type.Number()),
      toolName: Type.Optional(Type.String()), isError: Type.Optional(Type.Boolean()),
      toolCalls: Type.Optional(Type.Array(Type.Object({id: Type.String(), name: Type.String(), arguments: Type.String()}))),
    })),
  })),
  status: Type.Union([Type.Literal("running"),Type.Literal("done"),Type.Literal("failed"),Type.Literal("cancelled")]),
  summary: Type.String(), syncedAt: Type.Number(),
});
export type SubagentConversation = Static<typeof SubagentConversationSchema>;
export const MemoryDetailSchema = Type.Object({ row: MemoryRow, revision: Type.Number(), inProfile:Type.Optional(Type.Boolean()),
  evidence:Type.Optional(Type.Array(Type.Object({scope:Type.String(),message_id:Type.String(),speaker:Type.String(),quote:Type.String()}))),
  versions: Type.Array(Type.Object({ id: Type.Number(), at: Type.Number(), reason: Type.Union([Type.String(), Type.Null()]), before_json: Type.Union([Type.String(),Type.Null()]), by: Type.String(), after_json: Type.String() })),
  links: Type.Array(Type.Object({ from_id: Type.Number(), to_id: Type.Number(), rel: Type.String(), created_at: Type.Number() })),
});
export const MemoryJobsSchema = Type.Object({ jobs: Type.Array(Type.Object({ id: Type.String(), status: Type.String(), started_at: Type.Number(), report_json: Type.Union([Type.String(), Type.Null()]) })) });
export const MemoryProposalsSchema = Type.Object({ proposals: Type.Array(Type.Object({ id: Type.Number(), text: Type.String(), based_on_revision: Type.String() })) });

export const MemoryCandidatesSchema=Type.Object({candidates:Type.Array(Type.Object({id:Type.Number(),input_json:Type.String(),target_id:Type.Number(),target_version:Type.Number(),created_at:Type.Number()}))});
