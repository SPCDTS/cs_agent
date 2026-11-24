import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import worker from '../src/index';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { ThreadMcp, type McpAuthority } from '../src/mcp';
import { MCP_CONFIG } from '../src/mcp/config';
import { makeCatalog, MCP_CATALOG_SCHEMA } from '../src/mcp/catalog';
import { cuaTools, cuaSpaceTools } from '../src/cua/spaces';
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
  const input = { tools: ['notion-search'], resourceAllow: [], actors: [actor.actor], expiresAt: null, environments: ['relay:shared-vm1'], environmentApproval: 'none' };
  const saved = await request('PUT', { server: 'notion', expected: 'none', input });
  expect(saved.status).toBe(200);
  const grant = await saved.json();
  expect(grant).toMatchObject(input);
  const fetched = await request('GET');
  expect(fetched.status).toBe(200);
  expect(await fetched.json()).toEqual({ grant });
});

it('环境授权在审批前校验；查询、写操作和子 agent 都不能越过环境范围', async () => {
  const remote = fakeRemote();
  remote.state.tools = cuaTools.map((name): Tool => ({ name, inputSchema: name === 'list_spaces' ? { type: 'object', properties: {}, additionalProperties: false }
    : { type: 'object', properties: { space: { type: 'string' }, service: { type: 'string' }, command: { type: 'string' } }, required: ['space'], additionalProperties: false } }));
  remote.state.toolResult = { content: [{ type: 'text', text: 'checked' }] };
  const config = { ...MCP_CONFIG, servers: [{ ...MCP_CONFIG.servers[0]!, id: 'cua', credential: { kind: 'none' as const }, tools: { allow: [...cuaTools], eventAllow: [], readOnly: ['list_spaces', 'list_tools'] } }] };
  const server = config.servers[0]!;
  const catalog = makeCatalog(server, remote.state.tools, config.limits).revision;
  const name = (raw: string) => {
    const tool = catalog.tools.find(t => t.name === raw); if (!tool) throw new Error('missing_tool');
    return toolNames(catalog, tool).nativeName;
  };
  await env.THREAD.getByName(group).syncAdminView(group);
  await runInDurableObject(env.THREAD.getByName(group), async (_instance, state) => {
    const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
    const mcp = new ThreadMcp(db, env, createRegistry(), async () => actor, config, { scope: group });
    const groupTools = [...cuaSpaceTools];
    const settings = { tools: groupTools, actors: [actor.actor], resourceAllow: [], expiresAt: null, environments: ['relay:shared-vm1'] };
    let op = 0;
    const call = (raw: string, args: object, who = actor) => mcp.invoke({ name: name(raw), args, operationId: String(++op) }, async () => who);
    try {
      await expect(mcp.setAccess(group, server.id, { ...settings, tools: ['delete_space'] }, 'none', owner)).rejects.toThrow('invalid');
      await expect(mcp.setAccess(group, server.id, { ...settings, environments: ['vm'] }, 'none', owner)).rejects.toThrow('invalid');
      let grant = await mcp.setAccess(group, server.id, { tools: groupTools, actors: [actor.actor], resourceAllow: [], expiresAt: null }, 'none', owner);
      await mcp.refreshAll();
      expect((await call('list_spaces', {})).isError).toBe(true); // 旧群授权没有环境范围，不自动扩大。
      grant = await mcp.setAccess(group, server.id, { ...settings, environments: ['relay:shared-vm1'] }, grant.revision, owner);
      for (const tool of cuaTools.filter(tool => tool !== 'list_spaces')) expect((await call(tool, { space: 'relay:private-mac' })).isError).toBe(true);
      expect((await call('list_tools', { space: 'relay:shared-vm1', service: 'driver' }, { ...actor, actor: '10000004' })).isError).toBe(true);
      expect(remote.state.calls).toBe(0);
      expect(await mcp.policy.list(group)).toEqual([]);
      remote.state.toolResult = { content: [{ type: 'text', text: JSON.stringify([
        {id:'relay:shared-vm1', name:'共享 VM'}, {id:'relay:private-mac', name:'私人 Mac'},
      ]) }] };
      const visible = await call('list_spaces', {});
      expect(visible.isError).not.toBe(true);
      expect(JSON.stringify(visible)).toContain('共享 VM');
      expect(JSON.stringify(visible)).not.toContain('私人 Mac');
      expect((await call('call_tool', {space:'relay:shared-vm1', service:'other'})).isError).toBe(true);
      expect((await call('delete_space', {space:'relay:shared-vm1'})).isError).toBe(true);
      expect((await call('list_tools', { space: 'relay:shared-vm1', service: 'driver' })).isError).not.toBe(true);
      const requests = remote.requests.filter(row => row.body.includes('"tools/call"')).map(row => JSON.parse(row.body));
      expect(requests.at(-1).params._meta['cs-agent/caller']).toMatchObject({ environments: { kind: 'selected', envIds: ['relay:shared-vm1'] } });
      expect(requests.at(-1).params.arguments).toEqual({ space: 'relay:shared-vm1', service: 'driver' });
      const prior = remote.state.calls;
      expect(JSON.stringify(await call('space_bash', { space: 'relay:shared-vm1', command: 'hostname' }))).toContain('pending');
      expect(remote.state.calls).toBe(prior);
      const pending = (await mcp.policy.list(group))[0]!;
      await mcp.reviewApproval(group, pending.id, 'approve', owner, async () => actor);
      expect(remote.state.calls).toBe(prior + 1);
      grant = await mcp.setAccess(group, server.id, { ...settings, environmentApproval: 'none' }, grant.revision, owner);
      expect((await call('space_bash', { space: 'relay:shared-vm1', command: 'hostname' })).isError).not.toBe(true);
      expect(remote.state.calls).toBe(prior + 2);

      const snapshot = await mcp.captureCapabilities(actor);
      const child: McpAuthority = { ...actor, kind: 'subagent', subagentId: 'child' };
      const host = createSubagentCapabilityHost({ validateSubagentAccess: async () => ({ authority: child, capabilities: { mcp: snapshot } }) });
      expect((await host.validateSubagentAccess('child'))?.capabilities.mcp?.environments).toEqual(snapshot.environments);
      grant = await mcp.setAccess(group, server.id, { ...settings, environments: ['relay:shared-vm1', 'relay:second-vm'] }, grant.revision, owner);
      const childCall = (space: string) => mcp.invoke({ name: name('list_tools'), args: { space, service: 'driver' }, operationId: String(++op), snapshot }, async () => child);
      expect((await childCall('relay:second-vm')).isError).toBe(true);
      expect((await childCall('relay:shared-vm1')).isError).not.toBe(true);
      await mcp.setAccess(group, server.id, { ...settings, environments: [] }, grant.revision, owner);
      expect((await childCall('relay:shared-vm1')).isError).toBe(true);
      expect((await call('list_tools', { space: 'relay:private-mac' }, owner)).isError).not.toBe(true);
    } finally { await mcp.close(); }
  });
});
