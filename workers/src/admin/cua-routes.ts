import type { AdminRoute } from './routes';
import { adminJson } from './http';
import { CUA_SERVER, spaceCards } from '../cua/spaces';
import { McpConnection } from '../mcp/connection';
import { MCP_CONFIG } from '../mcp/config';
import { serverDigest } from '../mcp/names';

/** 管理台读取同一已启用的聚合目录。控制节点保管 Cua 账户和 Relay 会话。 */
export const CUA_ROUTES: AdminRoute[] = [{
  method: 'GET', path: '/admin/cua/spaces', async handle({ env }) {
    const registry = env.REGISTRY.getByName('main');
    const config = await registry.mcpConfig();
    const server = config.servers.find(item => item.id === CUA_SERVER);
    if (!config.enabled || !server?.enabled || !server.tools.allow.includes('list_spaces')) {
      return adminJson({ configured: false, spaces: [] });
    }
    const signal = AbortSignal.timeout(MCP_CONFIG.limits.connectMs);
    let connection: McpConnection | undefined;
    try {
      connection = await McpConnection.open(server, env, MCP_CONFIG.limits, signal, () => {});
      const result = await connection.callTool('list_spaces', {}, { scope: 'admin:cua' }, signal);
      const spaces = spaceCards(result);
      if (!await registry.mcpServerCurrent(CUA_SERVER, serverDigest(server))) return adminJson({ error: 'cua_changed' }, 409);
      return adminJson({ configured: true, spaces });
    } catch { return adminJson({ error: 'cua_unavailable' }, 502); }
    finally { await connection?.close(); }
  },
}];
