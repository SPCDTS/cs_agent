import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const ENV_TOOLS = ['env_list', 'env_status', 'env_submit', 'env_job_get', 'env_job_cancel', 'env_close'] as const;
export const EnvIdSchema = Type.String({ pattern: '^[a-z][a-z0-9_]{0,23}$' });
export const EnvIdsSchema = Type.Array(EnvIdSchema, { uniqueItems: true, maxItems: 16 });
export const EnvironmentAccessSchema = Type.Union([
  Type.Object({ kind: Type.Literal('all') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('selected'), envIds: EnvIdsSchema }, { additionalProperties: false }),
]);
export type EnvironmentAccess = Static<typeof EnvironmentAccessSchema>;
export const EnvironmentSnapshotsSchema = Type.Array(Type.Object({ server: Type.String(), access: EnvironmentAccessSchema }));
export const noEnvironments = (): EnvironmentAccess => ({ kind: 'selected', envIds: [] });
export const isEnvironmentTool = (name: string): boolean => ENV_TOOLS.some(tool => tool === name);
export function intersectEnvironments(current: EnvironmentAccess, limit?: EnvironmentAccess): EnvironmentAccess {
  if (!limit || limit.kind === 'all') return current;
  if (current.kind === 'all') return limit;
  return { kind: 'selected', envIds: current.envIds.filter(id => limit.envIds.includes(id)) };
}
export function environmentCallAllowed(access: EnvironmentAccess, tool: string, args: unknown): boolean {
  if (tool === 'env_list') return access.kind === 'all' || access.envIds.length > 0;
  return Check(Type.Object({ envId: EnvIdSchema }), args) && (access.kind === 'all' || access.envIds.includes(args.envId));
}
