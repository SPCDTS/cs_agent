import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

import { SpaceId } from '../cua/spaces';
export const EnvIdsSchema = Type.Array(Type.Union([SpaceId, Type.String({ pattern: '^[a-z][a-z0-9_]{0,23}$' })]), { uniqueItems: true, maxItems: 64 });
export const EnvironmentAccessSchema = Type.Union([
  Type.Object({ kind: Type.Literal('all') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('selected'), envIds: EnvIdsSchema }, { additionalProperties: false }),
]);
export type EnvironmentAccess = Static<typeof EnvironmentAccessSchema>;
export const EnvironmentSnapshotsSchema = Type.Array(Type.Object({ server: Type.String(), access: EnvironmentAccessSchema }));
export const noEnvironments = (): EnvironmentAccess => ({ kind: 'selected', envIds: [] });
export function intersectEnvironments(current: EnvironmentAccess, limit?: EnvironmentAccess): EnvironmentAccess {
  if (!limit || limit.kind === 'all') return current;
  if (current.kind === 'all') return limit;
  return { kind: 'selected', envIds: current.envIds.filter(id => limit.envIds.includes(id)) };
}
export function environmentCallAllowed(access: EnvironmentAccess, tool: string, args: unknown): boolean {
  if (tool === 'list_spaces') return access.kind === 'all' || access.envIds.length > 0;
  if (!Check(Type.Object({ space: Type.String(), service: Type.Optional(Type.String()) }), args)) return false;
  if (access.kind === 'all') return true;
  if ((tool === 'call_tool' || tool === 'list_tools') && args.service !== 'driver') return false;
  return Check(SpaceId, args.space) && access.envIds.includes(args.space);
}
