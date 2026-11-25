import type { Env } from '../env';
import { MCP_CONFIG } from '../mcp/config';
import { McpConnection } from '../mcp/connection';
import { connectionDigest } from '../mcp/names';

/** 首次连接与定时补偿共用同一份待启用记录。管理员手动修改后旧版本自动失效。 */
export async function finishCuaSetup(env: Env) {
  const registry = env.REGISTRY.getByName('main');
  const pending = await registry.cuaPendingSetup();
  if (!pending) return;
  const relay = env.BRIDGE.getByName('mcp-reverse:' + connectionDigest(pending.server));
  if (!await relay.reverseOnline()) return;

  const signal = AbortSignal.timeout(MCP_CONFIG.limits.connectMs);
  let connection: McpConnection | undefined;
  let activated: boolean;
  try {
    connection = await McpConnection.open(pending.server, env, MCP_CONFIG.limits, signal, () => {});
    const tools = await connection.listTools(signal);
    activated = await registry.cuaFinishSetup(pending.revision, tools);
  } catch {
    // 节点可能仍在握手或上报了不兼容的工具。保留待办，下一次连接或定时检查会重试。
    return;
  } finally {
    await connection?.close();
  }
  if (activated) {
    const owner = env.THREAD.getByName('owner');
    await owner.recordMcpChange({action:'activate', server:'cua'});
    await owner.refreshMcp();
  }
}
