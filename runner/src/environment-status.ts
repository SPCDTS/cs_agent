import { Type, type Static } from 'typebox';

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const ReadinessSchema = Type.Union([
  object({ state: Type.Literal('ready'), protocolVersion: Type.Integer(), helperVersion: Type.String() }),
  object({ state: Type.Literal('unavailable'), error: Type.String() }),
  object({ state: Type.Literal('unknown'), error: Type.String() }),
]);
export type Readiness = Static<typeof ReadinessSchema>;
const job = {
  requestId: Type.String(), jobId: Type.String(), sessionId: Type.Optional(Type.String()),
  deadline: Type.Number(), queuedAt: Type.Number(),
};
export const LastErrorSchema = object({ requestId: Type.String(), jobId: Type.String(), error: Type.String(), queuedAt: Type.Number() });
export const LedgerCountsSchema = object({ jobs: Type.Integer({ minimum: 0 }), retainedPayloads: Type.Integer({ minimum: 0 }) });
export const LedgerStorageSchema = object({ allocatedBytes: Type.Integer({ minimum: 0 }), reusableBytes: Type.Integer({ minimum: 0 }) });
export const EnvironmentStatusSchema = object({
  targetId: Type.String(), kind: Type.Union([Type.Literal('hyperv'), Type.Literal('wsb')]), checkedAt: Type.Number(),
  readiness: ReadinessSchema,
  ledger: object({ ...LedgerCountsSchema.properties, ...LedgerStorageSchema.properties, databaseBytes: Type.Integer({ minimum: 0 }), walBytes: Type.Integer({ minimum: 0 }) }),
  queue: object({
    busy: Type.Boolean(), queued: Type.Integer(), oldestQueuedAt: Type.Union([Type.Number(), Type.Null()]),
    current: Type.Union([Type.Null(), object({ ...job, state: Type.Union([Type.Literal('running'), Type.Literal('cancelling'), Type.Literal('unknown')]), error: Type.Optional(Type.String()) })]),
  }),
  lastError: Type.Union([Type.Null(), LastErrorSchema]),
});
export type EnvironmentStatus = Static<typeof EnvironmentStatusSchema>;
