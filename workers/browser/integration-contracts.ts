import { Type, type Static } from "typebox";
import { MaintenanceOverrideSchema, OpsSettingsSchema, SendLimitsSchema, type MaintenanceOverride } from "../src/settings-schema";
export { MaintenanceOverrideSchema, SendLimitsSchema, type MaintenanceOverride };


const strings = () => Type.Array(Type.String());
const nullableString = () => Type.Union([Type.String(), Type.Null()]);
const nullableNumber = () => Type.Union([Type.Number(), Type.Null()]);
export const PersonaSchema = Type.Object({ text: Type.String(), revision: Type.String() });
export type Persona = Static<typeof PersonaSchema>;
export const PersonaSavedSchema = Type.Object({ value: PersonaSchema });
export const GrantsSchema = Type.Object({ grants: Type.Array(Type.Object({
  user: Type.String(), caps: strings(), targets: strings(), scopes: Type.Optional(strings()),
  expired: Type.Boolean(), expires_at: Type.Optional(Type.Number()),
})) });
export const OpsSchema = Type.Object({ value: OpsSettingsSchema, revision: Type.String() });
export type OpsSnapshot = Static<typeof OpsSchema>;
export const OpsSavedSchema = Type.Object({ current: OpsSchema });
export const AlertsSchema = Type.Object({ alerts: Type.Array(Type.Object({
  updatedAt: Type.Number(), scope: Type.String(), origin: Type.String(), message: Type.String(), status: Type.String(), closedAt: nullableNumber(),
})), next: Type.Optional(Type.String()) });
export const DeliverySchema = Type.Object({ id: Type.String(), createdAt: Type.Number(), state: Type.String(), messageId: Type.Optional(Type.String()), error: Type.Optional(Type.String()) });
export const DeliveriesSchema = Type.Object({ deliveries: Type.Array(DeliverySchema), next: Type.Optional(Type.String()) });
export const ReconciledSchema = Type.Object({ state: Type.String() });

const FileSchema = Type.Object({ path: Type.String(), sha256: Type.String(), bytes: Type.Number(), mode: Type.Number() });
export const ManifestSchema = Type.Object({ revision: Type.String(), files: Type.Array(FileSchema), totalBytes: Type.Number() });
export type WorkspaceFile = Static<typeof FileSchema>;
export type WorkspaceManifest = Static<typeof ManifestSchema>;
export const WorkspaceChildSchema = Type.Object({ childId: Type.String(), parent: ManifestSchema, source: ManifestSchema });
export type WorkspaceChild = Static<typeof WorkspaceChildSchema> & { thread: string };
export const WorkspaceMergedSchema = Type.Object({ manifest: ManifestSchema });

export const McpServerRecordSchema = Type.Object({
  online: Type.Optional(Type.Boolean()),
  server: Type.Object({ id: Type.String(), enabled: Type.Boolean(),
    transport: Type.Object({ kind: Type.Optional(Type.String()), url: Type.String(), headers: Type.Record(Type.String(), Type.String()) }),
    credential: Type.Object({ kind: Type.String(), scope: Type.Optional(Type.String()) }),
    resourceAllow: strings(), access: Type.Object({ revision: Type.Optional(Type.String()) }),
    tools: Type.Object({ allow: strings(), readOnly: Type.Optional(strings()) }),
  }),
  revision: Type.String(), credentialSet: Type.Boolean(),
  discovered: Type.Union([Type.Null(), Type.Array(Type.Object({
    name: Type.String(),
    description: Type.String(),
    declaration: Type.Optional(Type.String()),
    inputSchema: Type.Optional(Type.String()),
    outputSchema: Type.Optional(Type.String()),
    schemaTruncated: Type.Optional(Type.Boolean()),
  }))]),
});
export const McpServersSchema = Type.Object({ servers: Type.Array(McpServerRecordSchema) });
export type McpServerRecord = Static<typeof McpServerRecordSchema>;
export const McpGrantSchema = Type.Object({ environments: Type.Optional(strings()), environmentApproval: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("none")])),  revision: Type.String(), tools: strings(), actors: strings(), resourceAllow: strings(), expiresAt: nullableNumber(), serverRevision: Type.Optional(Type.String()) });
export type McpGrant = Static<typeof McpGrantSchema>;
export const McpAccessSchema = Type.Object({ grant: Type.Union([McpGrantSchema, Type.Null()]) });
const McpApprovalSchema = Type.Object({ id: Type.String(), scope: Type.String(), status: Type.String(), server_id: Type.String(), tool_name: Type.String(),
  actor: Type.String(), generation: Type.Number(), reply_channel: Type.String(), operation_id: Type.String(), contract: Type.String(), args_json: Type.String(),
  created_at: Type.Number(), expires_at: Type.Number(), result_json: nullableString(),
});
export type McpApproval = Static<typeof McpApprovalSchema>;
export const McpApprovalsSchema = Type.Object({ approvals: Type.Array(McpApprovalSchema) });
export const McpToolResultSchema = Type.Object({ output: Type.Optional(Type.Array(Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("image"), mimeType: Type.String() }),
]))) });
export type McpToolResult = Static<typeof McpToolResultSchema>;
export const McpDecisionSchema = Type.Object({ result: Type.Optional(McpToolResultSchema) });
export const McpManageResultSchema = Type.Object({ status: Type.Optional(Type.String()), url: Type.Optional(Type.String()), message: Type.Optional(Type.String()), code: Type.Optional(Type.String()) });
export const McpRejectedToolsSchema = Type.Object({ error: Type.Literal("tools_rejected"), rejectedTools: Type.Array(Type.Object({ name: Type.String(), reason: Type.String() })) });
export const McpThreadsSchema = Type.Object({ threads: Type.Array(Type.Object({ key: Type.String(), name: Type.Optional(Type.String()) })) });

const SkillRuntimeStateFileSchema = Type.Object({ path: Type.String(), bytes: Type.Number(), mode: Type.Number() });
const SkillRuntimeStateSchema = Type.Union([
  Type.Object({
    skill: Type.String(),
    revision: Type.String(),
    updatedAt: Type.Number(),
    totalBytes: Type.Number(),
    fileCount: Type.Number(),
    files: Type.Array(SkillRuntimeStateFileSchema),
  }),
  Type.Object({ error: Type.Literal("unavailable") }),
]);
const SkillRuntimeGrantItemSchema = Type.Object({
  group: Type.String(),
  revision: Type.String(),
  updatedAt: Type.Number(),
});
export const SkillRuntimeItemSchema = Type.Object({
  skill: Type.String(),
  description: Type.String(),
  enabled: Type.Boolean(),
  updatedAt: Type.Number(),
  deps: Type.Union([Type.String(), Type.Null()]),
  grants: Type.Array(SkillRuntimeGrantItemSchema),
  state: SkillRuntimeStateSchema,
});
export const SkillRuntimeOverviewSchema = Type.Object({
  skills: Type.Array(SkillRuntimeItemSchema),
  groups: Type.Array(Type.Object({ key: Type.String(), name: Type.Optional(Type.String()) })),
});
export type SkillRuntimeOverview = Static<typeof SkillRuntimeOverviewSchema>;
export const SkillRuntimeGrantSavedSchema = Type.Object({
  skill: Type.String(),
  group: Type.String(),
  enabled: Type.Boolean(),
  revision: Type.String(),
});
export const SkillRuntimeClearedSchema = Type.Object({
  skill: Type.String(),
  cleared: Type.Literal(true),
});
