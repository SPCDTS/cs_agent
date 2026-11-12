import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { CALLER_META_KEY, type Subject } from './domain.ts';

export const EnvIdSchema = Type.String({ pattern: '^[a-z][a-z0-9_]{0,23}$' });
const accessSchema = Type.Union([
  Type.Object({ kind: Type.Literal('all') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('selected'), envIds: Type.Array(EnvIdSchema, { uniqueItems: true, maxItems: 16 }) }, { additionalProperties: false }),
]);
export type EnvironmentAccess = Static<typeof accessSchema>;
export interface EnvironmentCaller { subject: Subject; environments: EnvironmentAccess }
const callerSchema = Type.Object({ scope: Type.String({ pattern: '^[a-f0-9]{64}$' }), environments: accessSchema }, { additionalProperties: false });

/** Bearer 客户端是可信宿主；调用权限来自宿主元数据，不能放进模型参数。 */
export function environmentCaller(principal: string, meta: unknown): EnvironmentCaller {
  const direct: EnvironmentCaller = { subject: { principal, scope: 'default' }, environments: { kind: 'all' } };
  if (meta === undefined) return direct;
  if (!Check(Type.Record(Type.String(), Type.Unknown()), meta)) throw new Error('invalid_caller_metadata');
  const caller = meta[CALLER_META_KEY];
  if (caller === undefined) return direct;
  // 旧宿主只传 scope 时拒绝执行，不能将缺失的环境授权解释为全部开放。
  if (!Check(callerSchema, caller)) throw new Error('invalid_caller_metadata');
  return { subject: { principal, scope: caller.scope }, environments: caller.environments };
}
export function allowsEnvironment(access: EnvironmentAccess, envId: string): boolean {
  return access.kind === 'all' || access.envIds.includes(envId);
}
