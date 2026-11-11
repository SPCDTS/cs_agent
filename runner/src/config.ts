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
  targets: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal('hyperv'), id, vmId: Type.String({ pattern: '^[a-fA-F0-9-]{36}$' }), credentialPath: Type.String({ minLength: 1 }), guestWorkdir: Type.String({ pattern: '^[A-Za-z]:[\\\\/]' }), desktopMcp: optional(Type.Boolean()), desktopUser: optional(Type.String({ minLength: 1, maxLength: 256 })), instructions: optional(Type.String({ maxLength: 8000 })) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('wsb'), id, memoryMb: Type.Integer({ minimum: 2048, maximum: 65536 }), idleTimeoutMs: Type.Integer({ minimum: 60000, maximum: 3600000 }), maxLifetimeMs: Type.Integer({ minimum: 60000, maximum: 86400000 }), instructions: optional(Type.String({ maxLength: 8000 })) }, { additionalProperties: false }),
  ]), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });
export function parseConfig(value: unknown): ServerConfig {
  if (!Check(ConfigSchema, value)) throw new Error('invalid_windows_mcp_config');
  if (!path.isAbsolute(value.stateDir) || path.resolve(value.stateDir) === path.parse(value.stateDir).root) throw new Error('dedicated_absolute_state_directory_required');
  if (new Set(value.targets.map(t => t.id)).size !== value.targets.length || new Set(value.principals.map(p => p.id)).size !== value.principals.length) throw new Error('duplicate_id');
  if (value.targets.filter(t => t.kind === 'wsb').length > 1) throw new Error('only_one_wsb_provider_supported');
  for (const target of value.targets) {
    if (target.kind === 'hyperv' && !path.isAbsolute(target.credentialPath)) throw new Error('absolute_credential_path_required');
    if (target.kind === 'hyperv' && target.desktopMcp && !target.desktopUser) throw new Error('desktop_user_required');
    if (target.kind === 'wsb' && target.idleTimeoutMs > target.maxLifetimeMs) throw new Error('invalid_session_timeout');
  }
  return value;
}
export async function loadConfig(file: string): Promise<ServerConfig> { return parseConfig(await readJson(file, 65536)); }
