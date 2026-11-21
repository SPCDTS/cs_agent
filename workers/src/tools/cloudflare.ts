import { Type } from 'typebox';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import type { AccessDeps } from './access';
import type { Env } from '../env';
import { CloudflareChange, CloudflareInventory } from '../devices/contracts';

type Management = Pick<ReturnType<Env['REGISTRY']['getByName']>, 'cloudflareInventory' | 'cloudflarePropose'>;
export function createCloudflareExtension(allowManage: AccessDeps['allowManage'], registry: () => Management) {
  const output = (value: unknown, isError = false) => ({ isError, output: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const run = async (api: Parameters<typeof allowManage>[0], context: Parameters<typeof allowManage>[1], work: () => Promise<unknown>) => {
    if (!await allowManage(api, context)) return output('仅限主人交互会话。', true);
    try { return output(await work()); }
    catch (err) { return output(err instanceof Error && /^device_[a-z_]+$/.test(err.message) ? err.message : 'device_cloudflare_api', true); }
  };
  return defineExtension({ name: 'cs.cloudflare', tools: [
    defineTool({ name: 'cloudflare_inventory', description: '查看已授权账户的 DNS 记录摘要、Tunnel 状态、Worker 名称或 R2 桶名称。每次最多返回 50 项。', replay: 'safe',
      parameters: CloudflareInventory, execute: ({resource}, api, ctx) => run(api, ctx, () => registry().cloudflareInventory(resource)) }),
    defineTool({ name: 'cloudflare_propose', description: '申请新增 DNS 记录、创建 R2 桶或按 URL 清除缓存。返回申请 ID，主人在管理台查看资源和参数并批准后才执行。', replay: 'unsafe',
      parameters: Type.Object({ change: CloudflareChange }, { additionalProperties: false }), execute: ({ change }, api, ctx) => run(api, ctx, () => registry().cloudflarePropose(change)) }),
  ].map(tool => ({ ...tool, callers: ['model'] as const })) });
}
