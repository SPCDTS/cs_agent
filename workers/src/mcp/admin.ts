import type { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import type { Env } from '../env';
import type { ThreadMcp } from './index';
import type { McpAuthority } from './access';
import type { McpGrantInput } from './policy';
import type { McpAdminRpc } from './contracts';
import type { McpChange } from './manage';

export interface McpAdminHost {
  env: Pick<Env, 'REGISTRY'>;
  database: DurableObjectSqliteDatabase;
  initialize(): Promise<void>;
  prepare(scope: string): Promise<void>;
  open(): Promise<ThreadMcp | undefined>;
  generation(): Promise<number>;
  currentAuthority(original: McpAuthority): Promise<McpAuthority | undefined>;
  publish(): Promise<void>;
  audit(kind: string, detail: object): Promise<unknown>;
}

/** 目录刷新、授权与审批的管理事务，不决定 agent 的执行时机。 */
export class McpAdmin implements McpAdminRpc {
  constructor(private readonly host: McpAdminHost) {}
  private async open(scope?: string): Promise<ThreadMcp> {
    if (scope !== undefined) await this.host.prepare(scope);
    const mcp = await this.host.open();
    if (!mcp) throw new Error('mcp_unavailable');
    await mcp.syncConfig(await this.host.env.REGISTRY.getByName('main').mcpConfig());
    return mcp;
  }
  private async reviewer(scope: string): Promise<McpAuthority> {
    return { scope, actor: 'admin:web', owner: true, kind: 'message', generation: await this.host.generation(), replyChannel: 'web' };
  }
  async mcpAccess(scope: string, server: string): ReturnType<McpAdminRpc['mcpAccess']> {
    return (await (await this.open(scope)).policy.grant(scope, server)) ?? null;
  }
  async mcpSetAccess(scope: string, server: string, input: McpGrantInput, expected: string): ReturnType<McpAdminRpc['mcpSetAccess']> {
    const mcp = await this.open(scope), grant = await mcp.setAccess(scope, server, input, expected, await this.reviewer(scope));
    await mcp.refreshAll(); await this.host.publish(); return grant;
  }
  async mcpApprovals(scope: string): ReturnType<McpAdminRpc['mcpApprovals']> {
    return (await this.open(scope)).policy.list(scope);
  }
  async mcpReviewApproval(scope: string, id: string, decision: 'approve' | 'reject'): ReturnType<McpAdminRpc['mcpReviewApproval']> {
    const mcp = await this.open(scope);
    const reviewed = await mcp.reviewApproval(scope, id, decision, await this.reviewer(scope), async original => {
      if (original.scope !== scope || original.generation !== await this.host.generation()) return;
      return this.host.currentAuthority(original);
    });
    await this.host.publish();
    if (!reviewed.result) return { status: reviewed.status };
    return { status: reviewed.status, result: { isError: reviewed.result.isError, output: (reviewed.result.output ?? []).map(content =>
      content.type === 'text' ? { type: 'text' as const, text: content.text } : { type: 'image' as const, data: content.data, mimeType: content.mimeType }) } };
  }
  async refreshMcp(): Promise<{ server: string; status: string; tools: number }[]> {
    const result = await (await this.open()).refreshAll();
    await this.host.publish(); return result;
  }
  async recordMcpChange(change: McpChange): Promise<void> {
    await this.host.initialize();
    await this.host.audit('mcp_management', { action: change.action, server: change.server, source: 'admin' });
  }
  async mcpToolCounts(): Promise<Record<string, number>> {
    await this.host.initialize();
    const rows = await this.host.database.all<{ server_id: string; n: number }>('SELECT server_id, COUNT(*) AS n FROM mcp_catalog GROUP BY server_id');
    return Object.fromEntries(rows.map(row => [row.server_id, row.n]));
  }
}
