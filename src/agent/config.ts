/** 配置的业务解析在组合时执行，config.ts 只负责环境变量与基础值。 */
import { loadConfig, type Config } from '../config.js';
import { resolveOwner } from '../context/access.js';
import { parseImagePrefixes } from './router.js';
import { parseBackendOverrides } from './backends/select.js';
import type { BackendName } from './backends/types.js';

export interface AgentConfig extends Config {
  /** QQ_OWNER，否则 QQ_ALLOW_USERS 第一项；QQ_ALLOW_USERS=* 且未设 QQ_OWNER 时无 owner */
  owner: string | undefined;
  imagePrefixes: string[];
  backendOverrides: Record<string, BackendName>;
}

export function resolveAgentConfig(e: Config): AgentConfig {
  let backendOverrides: Record<string, BackendName>;
  try {
    backendOverrides = parseBackendOverrides(e.AGENT_BACKEND_OVERRIDES);
  } catch (err) {
    throw new Error(`配置无效: ${(err as Error).message}`);
  }
  return {
    ...e,
    owner: resolveOwner(e.QQ_OWNER, e.allowUsers),
    imagePrefixes: parseImagePrefixes(e.IMAGE_PREFIXES),
    backendOverrides,
  };
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return resolveAgentConfig(loadConfig(env));
}
