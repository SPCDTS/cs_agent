import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { RegistryDO } from '../src/registry';
import { manageMcp } from '../src/mcp/manage';
import { compileMcpSchema } from '../src/mcp/schema';
import { MCP_CONFIG } from '../src/mcp/config';
import { adminEnv, fakeRemote } from './mcp-helpers';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('升级清理配对、已知旧服务和对应凭据，保留其他服务，重复启动不重做清理', async () => {
  const registry = env.REGISTRY.getByName('main');
  await runInDurableObject(registry, (_instance, state) => {
    const sql = state.storage.sql;
    const add = (id: string, allow: string[], discovered?: string) => {
      sql.exec('INSERT INTO mcp_servers VALUES(?,?,?,?,?)', id, JSON.stringify({ tools: { allow } }), 'old',
        discovered ? JSON.stringify({ tools: [{ name: discovered }] }) : null, 'old-encrypted-value');
      sql.exec('INSERT INTO mcp_oauth_client VALUES(?,?)', id, '{}');
    };
    sql.exec("DELETE FROM mcp_server_meta WHERE key='cua-cutover-v1'");
    sql.exec('CREATE TABLE devices (id TEXT PRIMARY KEY)');
    sql.exec("INSERT INTO devices VALUES('paired')");
    sql.exec('CREATE TABLE device_tool_aliases (id TEXT PRIMARY KEY, alias TEXT)');
    add('device-paired', []); add('device-paired-desktop', []);
    add('windows', ['env_submit']); add('desktop', [], 'desktop_skills_get'); add('device-independent', []);
    const exists = (table: string, key: string, value: string) =>
      sql.exec(`SELECT 1 FROM ${table} WHERE ${key}=?`, value).toArray().length === 1;
    new RegistryDO(state, env);
    for (const id of ['device-paired', 'device-paired-desktop', 'windows', 'desktop']) {
      expect(exists('mcp_servers', 'id', id)).toBe(false);
      expect(exists('mcp_oauth_client', 'server_id', id)).toBe(false);
    }
    expect(exists('mcp_servers', 'id', 'device-independent')).toBe(true);
    expect(exists('sqlite_master', 'name', 'devices')).toBe(false);
    expect(exists('sqlite_master', 'name', 'device_tool_aliases')).toBe(false);
    add('windows', ['unrelated']); add('desktop', ['unrelated']);
    sql.exec("DELETE FROM mcp_server_meta WHERE key='cua-cutover-v1'");
    new RegistryDO(state, env);
    expect(exists('mcp_servers', 'id', 'windows')).toBe(true);
    sql.exec("UPDATE mcp_servers SET config=? WHERE id='desktop'", JSON.stringify({ tools: { allow: ['desktop_skills_get'] } }));
    new RegistryDO(state, env);
    expect(exists('mcp_servers', 'id', 'desktop')).toBe(true);
  });
});

it('管理台用配置的聚合服务取设备目录，单机入口和上游故障都有明确结果', async () => {
  const url = 'https://controller.example.test/mcp', registry = env.REGISTRY.getByName('main');
  const remote = fakeRemote(url);
  const directory = (authorized = true) => worker.fetch(new Request(env.PUBLIC_ORIGIN + '/admin/cua/spaces', {
    headers: authorized ? { Authorization: 'Bearer synthetic-admin' } : {},
  }), adminEnv());
  expect((await directory(false)).status).toBe(401);
  expect(await (await directory()).json()).toEqual({configured:false, spaces:[]});
  const record = await registry.mcpServerPut({ id:'cua', url, auth:'token' }, 'absent');
  await registry.mcpCredentialPut('cua', record.revision, { Authorization:'Bearer synthetic-controller' });
  const probe = async () => manageMcp(env, { action:'probe', id:'cua', expectedRevision:(await registry.mcpServerGet('cua')).revision });
  expect(await probe()).toMatchObject({ code:'cua_directory_missing' });
  remote.state.tools = ['list_spaces','unrelated'].map(name => ({name, inputSchema:{type:'object'}}));
  expect(await probe()).toMatchObject({status:'ready'});
  const ready = await registry.mcpServerGet('cua');
  await registry.mcpServerActivate('cua', ready.revision, {allow:['list_spaces'], readOnly:['list_spaces']});
  remote.state.toolResult = {content:[{type:'text', text:JSON.stringify([{id:'relay:testing1', name:'host', display_name:'开发机',
    os:'windows', phase:'ready', status:'', services:['driver'], features:['shell'], sharing:{owner:'private'}}])}]};
  expect(await (await directory()).json()).toEqual({configured:true, spaces:[{id:'relay:testing1',name:'开发机',os:'windows',
    status:'ready',features:['shell'],services:['driver']}]});
  expect(remote.requests.every(row => row.headers.get('authorization') === 'Bearer synthetic-controller')).toBe(true);
  remote.state.toolResult = {content:[{type:'text', text:'unavailable'}], isError:true};
  expect((await directory()).status).toBe(502);
});

it('保留 Cua 可空无符号整数的位宽及 JavaScript 精度边界', () => {
  const schema = compileMcpSchema({type:'object', properties:{
    timeout:{type:['integer','null'],format:'uint64',minimum:1},
    port:{type:'integer',format:'uint16'}, follow_ms:{type:'integer',format:'uint32',maximum:1000},
  }}, MCP_CONFIG.limits);
  expect(schema.check({timeout:null,port:65535,follow_ms:1000})).toBe(true);
  expect(schema.check({timeout:0})).toBe(false);
  expect(schema.check({timeout:Number.MAX_SAFE_INTEGER + 1})).toBe(false);
  expect(schema.check({port:65536})).toBe(false);
  expect(schema.check({follow_ms:1001})).toBe(false);
});
