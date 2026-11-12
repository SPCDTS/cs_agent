import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import worker from '../src/index';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { ThreadMcp, type McpAuthority } from '../src/mcp';
import { MCP_CONFIG } from '../src/mcp/config';
import { makeCatalog, MCP_CATALOG_SCHEMA } from '../src/mcp/catalog';
import { ENV_TOOLS } from '../src/mcp/environments';
import { toolNames } from '../src/mcp/names';
import { createSubagentCapabilityHost } from '../src/mcp/delegated';
import { fakeRemote, login } from './mcp-helpers';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const group = 'group:200000001';
const actor: McpAuthority = { kind: 'message', scope: group, actor: '10000003', owner: false, generation: 1, replyChannel: 'web' };
const owner: McpAuthority = { ...actor, scope: 'owner', actor: '10000001', owner: true };

it('管理 API 保存环境范围与独立审批设置，读投影返回同一授权', async () => {
  fakeRemote(); await login();
  const path = '/admin/mcp/access?scope=' + encodeURIComponent(group) + '&server=notion';
  const request = (method: string, body?: object) => worker.fetch(new Request('https://test' + path, {
    method, headers: { Authorization: 'Bearer environment-test', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }), { ...env, ADMIN_TOKEN: 'environment-test' });
  const input = { tools: ['notion-search'], resourceAllow: [], actors: [actor.actor], expiresAt: null, environments: ['group852'], environmentApproval: 'none' };
  const saved = await request('PUT', { server: 'notion', expected: 'none', input });
  expect(saved.status).toBe(200);
  const grant = await saved.json();
  expect(grant).toMatchObject(input);
  const fetched = await request('GET');
  expect(fetched.status).toBe(200);
  expect(await fetched.json()).toEqual({ grant });
});

it('环境授权在审批前校验；查询、写操作和子 agent 都不能越过环境范围', async () => {
  const remote = fakeRemote(); await login();
  remote.state.tools = ENV_TOOLS.map((name): Tool => ({ name, inputSchema: name === 'env_list' ? { type: 'object', properties: {}, additionalProperties: false }
    : { type: 'object', properties: { envId: { type: 'string' } }, required: ['envId'], additionalProperties: false } }));
  remote.state.toolResult = { content: [{ type: 'text', text: 'checked' }] };
  const config = { ...MCP_CONFIG, servers: [{ ...MCP_CONFIG.servers[0]!, tools: { allow: [...ENV_TOOLS], eventAllow: [], readOnly: ['env_list', 'env_status', 'env_job_get'] } }] };
  const server = config.servers[0]!;
  const catalog = makeCatalog(server, remote.state.tools, config.limits).revision;
  const name = (raw: string) => {
    const tool = catalog.tools.find(t => t.name === raw); if (!tool) throw new Error('missing_tool');
    return toolNames(catalog, tool).nativeName;
  };
  await env.THREAD.getByName(group).stats();
  await runInDurableObject(env.THREAD.getByName(group), async (_instance, state) => {
    const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
    const mcp = new ThreadMcp(db, env, createRegistry(), async () => actor, config, { scope: group });
    const settings = { tools: [...ENV_TOOLS], actors: [actor.actor], resourceAllow: [], expiresAt: null, environments: ['group852'] };
    let op = 0;
    const call = (raw: string, args: object, who = actor) => mcp.invoke({ name: name(raw), args, operationId: String(++op) }, async () => who);
    try {
      let grant = await mcp.setAccess(group, server.id, { tools: [...ENV_TOOLS], actors: [actor.actor], resourceAllow: [], expiresAt: null }, 'none', owner);
      await mcp.refreshAll();
      expect((await call('env_list', {})).isError).toBe(true); // 旧群授权没有环境范围，不自动扩大。
      grant = await mcp.setAccess(group, server.id, { ...settings, environments: ['group852'] }, grant.revision, owner);
      for (const tool of ENV_TOOLS.filter(tool => tool !== 'env_list')) expect((await call(tool, { envId: 'dev' })).isError).toBe(true);
      expect((await call('env_status', { envId: 'group852' }, { ...actor, actor: '10000004' })).isError).toBe(true);
      expect(remote.state.calls).toBe(0);
      expect(await mcp.policy.list(group)).toEqual([]);
      expect((await call('env_list', {})).isError).not.toBe(true);
      expect((await call('env_status', { envId: 'group852' })).isError).not.toBe(true);
      const requests = remote.requests.filter(row => row.body.includes('"tools/call"')).map(row => JSON.parse(row.body));
      expect(requests.at(-1).params._meta['cs-agent/caller']).toMatchObject({ environments: { kind: 'selected', envIds: ['group852'] } });
      expect(requests.at(-1).params.arguments).toEqual({ envId: 'group852' });
      const prior = remote.state.calls;
      expect(JSON.stringify(await call('env_submit', { envId: 'group852' }))).toContain('pending');
      expect(remote.state.calls).toBe(prior);
      const pending = (await mcp.policy.list(group))[0]!;
      await mcp.reviewApproval(group, pending.id, 'approve', owner, async () => actor);
      expect(remote.state.calls).toBe(prior + 1);
      grant = await mcp.setAccess(group, server.id, { ...settings, environmentApproval: 'none' }, grant.revision, owner);
      expect((await call('env_submit', { envId: 'group852' })).isError).not.toBe(true);
      expect(remote.state.calls).toBe(prior + 2);

      const snapshot = await mcp.captureCapabilities(actor);
      const child: McpAuthority = { ...actor, kind: 'subagent', subagentId: 'child' };
      const host = createSubagentCapabilityHost({ validateSubagentAccess: async () => ({ authority: child, capabilities: { mcp: snapshot } }) });
      expect((await host.validateSubagentAccess('child'))?.capabilities.mcp?.environments).toEqual(snapshot.environments);
      grant = await mcp.setAccess(group, server.id, { ...settings, environments: ['group852', 'second'] }, grant.revision, owner);
      const childCall = (envId: string) => mcp.invoke({ name: name('env_status'), args: { envId }, operationId: String(++op), snapshot }, async () => child);
      expect((await childCall('second')).isError).toBe(true);
      expect((await childCall('group852')).isError).not.toBe(true);
      await mcp.setAccess(group, server.id, { ...settings, environments: [] }, grant.revision, owner);
      expect((await childCall('group852')).isError).toBe(true);
      expect((await call('env_status', { envId: 'dev' }, owner)).isError).not.toBe(true);
    } finally { await mcp.close(); }
  });
});
