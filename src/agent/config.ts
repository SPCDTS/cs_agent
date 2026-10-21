/** 配置的业务解析在组合时执行，config.ts 只负责环境变量与基础值。 */
import { loadConfig, type Config } from '../config.js';
import { resolveOwners } from '../context/access.js';
import { parseImagePrefixes } from './router.js';
import { parseBackendOverrides } from './backends/select.js';
import type { BackendName } from './backends/types.js';

export interface AgentConfig extends Config {
  /** QQ_OWNER 首项，否则 QQ_ALLOW_USERS 第一项；QQ_ALLOW_USERS=* 且未设 QQ_OWNER 时无 owner。 */
  owner: string | undefined;
  /** 同一人的全部 QQ 账号，拥有相同权限并共享 owner 私聊线程。 */
  owners: string[];
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
  const owners = resolveOwners(e.QQ_OWNER, e.allowUsers);
  return {
    ...e,
    owner: owners[0], owners,
    imagePrefixes: parseImagePrefixes(e.IMAGE_PREFIXES),
    backendOverrides,
  };
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return resolveAgentConfig(loadConfig(env));
}
