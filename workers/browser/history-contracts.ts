import { Type } from "typebox";
import { MemoryRow } from "./app-contracts";

export const SessionHistorySchema = Type.Object({ entries: Type.Array(Type.Object({
  id: Type.Number(), kind: Type.String(), reset: Type.Boolean(),
  archive: Type.Optional(Type.Object({ label: Type.String(), at: Type.Number() })),
  messages: Type.Array(Type.Object({ role: Type.String(), text: Type.String(), toolName: Type.Optional(Type.String()) })),
})), next: Type.Optional(Type.String()) });
export const MemoryDetailSchema = Type.Object({ row: MemoryRow, revision: Type.Number(),
  versions: Type.Array(Type.Object({ id: Type.Number(), at: Type.Number(), reason: Type.Union([Type.String(), Type.Null()]), after_json: Type.String() })),
  links: Type.Array(Type.Object({ from_id: Type.Number(), to_id: Type.Number(), rel: Type.String(), created_at: Type.Number() })),
});
export const MemoryJobsSchema = Type.Object({ jobs: Type.Array(Type.Object({ id: Type.String(), status: Type.String(), started_at: Type.Number(), report_json: Type.Union([Type.String(), Type.Null()]) })) });
export const MemoryProposalsSchema = Type.Object({ proposals: Type.Array(Type.Object({ id: Type.Number(), text: Type.String(), based_on_revision: Type.String() })) });
