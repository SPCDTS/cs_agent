import { Type, type Static } from "typebox";
import { IdSchema, ToolDeclarationSchema, SandboxInstructionsSchema, SandboxPersistenceSchema, OutcomeSchema, JobInputSchema, parse } from "../../../runner/src/protocol";

const strict = { additionalProperties: false };
export const CatalogEntrySchema = Type.Object({
  id: Type.String(), name: Type.String(), provider: Type.String(), os: Type.String(), arch: Type.String(),
  tools: Type.Array(ToolDeclarationSchema), codeModeTools: Type.Optional(Type.Array(Type.String())),
  workspacePreparation: Type.Optional(Type.Literal("git-clone-v1")),
  environment: Type.Optional(Type.Array(Type.Object({ name: Type.String(), version: Type.String() }, strict))),
  memoryMiB: Type.Union([Type.Integer(), Type.Null()]), maxTimeoutMs: Type.Integer(), capabilityRevision: Type.String(),
  availability: Type.Union([Type.Literal("ready"), Type.Literal("busy"), Type.Literal("offline"), Type.Literal("draining")]),
  activeJobs: Type.Integer(), workspaceRoot: Type.String(), instructions: SandboxInstructionsSchema, persistence: SandboxPersistenceSchema, mismatch: Type.Array(Type.String()),
}, strict);
export type CatalogEntry = Static<typeof CatalogEntrySchema>;
export const JobViewSchema = Type.Object({
  jobId: IdSchema, leaseId: IdSchema,
  phase: Type.Union(["dispatched", "accepted", "cancel_requested", "completed", "cancelled", "failed", "unknown"].map(value => Type.Literal(value))),
  outcome: Type.Union([OutcomeSchema, Type.Null()]),
  log: Type.Object({ sequence: Type.Integer(), text: Type.String() }, strict),
}, strict);

/** 递归 JSON 只通过字符串跨越 DO RPC；消费端在此恢复类型并校验协议。 */
export const readCatalog = (json: string): CatalogEntry[] => parse(Type.Array(CatalogEntrySchema), JSON.parse(json));
export const readJob = (json: string) => parse(JobViewSchema, JSON.parse(json));
export const readJobInput = (json: string) => parse(JobInputSchema, JSON.parse(json));
