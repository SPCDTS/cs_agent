import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { Env } from '../env';
import { CloudflareChange, CloudflareInventory } from '../cloudflare/contracts';

type Management = Pick<ReturnType<Env['REGISTRY']['getByName']>, 'cloudflareInventory' | 'cloudflarePropose'>;
export function createCloudflareExtension(allowed: (api: ToolExecutionApi, context: Context) => Promise<boolean>, registry: () => Management,
  audit: (detail: { tool: string; action: string; result: string }) => Promise<unknown>) {
  const output = (value: unknown, isError = false) => ({ isError, output: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const run = async (api: ToolExecutionApi, context: Context, tool: string, action: string, work: () => Promise<unknown>) => {
    let result = 'error';
    try {
      if (!await allowed(api, context)) { result = 'denied'; return output('仅限主人交互会话。', true); }
      const value = await work();
      result = 'ok';
      return output(value);
    } catch (err) {
      return output(err instanceof Error && /^device_[a-z_]+$/.test(err.message) ? err.message : 'device_cloudflare_api', true);
    } finally {
      await audit({ tool, action, result }).catch(() => console.warn('cloudflare_audit_failed'));
    }
  };
  return defineExtension({ name: 'cs.cloudflare', tools: [
    defineTool({ name: 'cloudflare_inventory', description: '查看已授权账户的 DNS 记录摘要、Tunnel 状态、Worker 名称或 R2 桶名称。每次最多返回 50 项；查看下一页 Worker 时传 page（从 1 开始）。', replay: 'safe',
      parameters: CloudflareInventory, execute: ({ resource, page }, api, ctx) => run(api, ctx, 'cloudflare_inventory', resource, () => registry().cloudflareInventory(resource, page)) }),
    defineTool({ name: 'cloudflare_propose', description: '申请新增 DNS 记录、创建 R2 桶或按 URL 清除缓存。返回申请 ID，主人在管理台查看资源和参数并批准后才执行。', replay: 'unsafe',
      parameters: Type.Object({ change: CloudflareChange }, { additionalProperties: false }), execute: ({ change }, api, ctx) => run(api, ctx, 'cloudflare_propose', change.action, () => registry().cloudflarePropose(change)) }),
  ].map(tool => ({ ...tool, callers: ['model'] as const })) });
}
