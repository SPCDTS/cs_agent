import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { readJson } from './files.ts';
import type { ServerConfig } from './domain.ts';
const id = Type.String({ pattern: '^[a-z][a-z0-9_]{0,23}$' });
const optional = Type.Optional;
const ConfigSchema = Type.Object({
  stateDir: Type.String({ minLength: 1 }), host: Type.Literal('127.0.0.1'),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  principals: Type.Array(Type.Object({ id, tokenEnv: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,99}$' }) }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
  targets: Type.Array(Type.Object({
    kind: Type.Literal('wsb'), id, memoryMb: Type.Integer({ minimum: 2048, maximum: 65536 }),
    idleTimeoutMs: Type.Integer({ minimum: 60000, maximum: 3600000 }), maxLifetimeMs: Type.Integer({ minimum: 60000, maximum: 86400000 }),
    instructions: optional(Type.String({ maxLength: 8000 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });
export function parseConfig(value: unknown): ServerConfig {
  // 已部署的配置可以混有退役 VM。保留 WSB 的 ID、端口和调用方凭据。
  const config = Check(Type.Object({ targets: Type.Array(Type.Unknown()) }), value)
    ? { ...value, targets: value.targets.filter(target => !Check(Type.Object({ kind: Type.Literal('hyperv') }), target)) }
    : value;
  if (!Check(ConfigSchema, config)) throw new Error('invalid_windows_mcp_config');
  if (!path.isAbsolute(config.stateDir) || path.resolve(config.stateDir) === path.parse(config.stateDir).root) throw new Error('dedicated_absolute_state_directory_required');
  if (new Set(config.targets.map(t => t.id)).size !== config.targets.length || new Set(config.principals.map(p => p.id)).size !== config.principals.length) throw new Error('duplicate_id');
  if (config.targets.length > 1) throw new Error('only_one_wsb_provider_supported');
  if (config.targets[0]!.idleTimeoutMs > config.targets[0]!.maxLifetimeMs) throw new Error('invalid_session_timeout');
  return config;
}
export async function loadConfig(file: string): Promise<ServerConfig> { return parseConfig(await readJson(file, 65536)); }
