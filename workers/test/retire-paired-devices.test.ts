import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { MCP_CATALOG_SCHEMA, makeCatalog, restoreCatalog, saveCatalog } from '../src/mcp/catalog';
import { MCP_CONFIG } from '../src/mcp/config';
import { serverDigest } from '../src/mcp/names';
import { McpPolicyStore } from '../src/mcp/policy';
import { RegistryDO } from '../src/registry';
import worker from '../src/index';
import { adminEnv } from './mcp-helpers';

afterEach(reset);

it('升级清退配对入口与凭据，保留 WSB 和自行登记的服务，回滚后能再次清退', async () => {
  await runInDurableObject(env.REGISTRY.getByName('main'), (registry, state) => {
    const sql = state.storage.sql;
    const paired = '12341234-1234-1234-1234-123412341234';
    const reused = '56785678-5678-5678-5678-567856785678';
    const shell = 'device-' + paired, desktop = shell + '-desktop';
    const tunnel = 'https://device-' + paired.replaceAll('-', '') + '.example.test';
    const oldPair = () => {
      sql.exec('CREATE TABLE devices(id TEXT PRIMARY KEY, secret TEXT)');
      sql.exec('INSERT INTO devices VALUES(?,?), (?,?)', paired, 'old-secret', reused, 'expired-secret');
      registry.mcpServerPut({id:shell, url:tunnel + '/mcp', auth:'token'}, 'absent');
    };
    oldPair();
    sql.exec('CREATE TABLE device_tool_aliases(id TEXT PRIMARY KEY, alias TEXT NOT NULL)');
    registry.mcpServerPut({id:desktop, url:tunnel + '/desktop/mcp', auth:'token'}, 'absent');
    const independent = 'device-' + reused;
    registry.mcpServerPut({id:independent, url:'https://independent.example.test/mcp', auth:'token'}, 'absent');
    const standalone = registry.mcpServerPut({id:'desktop', url:'https://gui.example.test/mcp', auth:'token'}, 'absent');
    registry.mcpServerProbe('desktop', standalone.revision, {tools:[{name:'desktop_skills_get',inputSchema:{type:'object'}}]});
    const windows = registry.mcpServerPut({id:'windows', url:'https://wsb.example.test/mcp', auth:'none'}, 'absent');
    const probe = registry.mcpServerProbe('windows', windows.revision, {tools:[{name:'env_submit',inputSchema:{type:'object'}}]});
    registry.mcpServerActivate('windows', probe.revision, {allow:['env_submit']});
    for (const id of [shell, desktop, 'desktop', independent]) {
      sql.exec('UPDATE mcp_servers SET secret=? WHERE id=?','old-secret', id);
      sql.exec('INSERT INTO mcp_oauth_client VALUES(?,?)',id,'{}');
      sql.exec("INSERT INTO mcp_oauth_tokens VALUES(?,'owner','v1','issuer','token',NULL,NULL,NULL,1)",id);
      sql.exec("INSERT INTO mcp_oauth_logins VALUES(?,?,'verifier','nonce',1,2)",id,id);
    }
    const verifyRemoved = (id: string) => {
      expect(sql.exec('SELECT 1 FROM mcp_servers WHERE id=?', id).toArray()).toEqual([]);
      for (const table of ['mcp_oauth_client', 'mcp_oauth_tokens', 'mcp_oauth_logins'])
        expect(sql.exec('SELECT 1 FROM ' + table + ' WHERE server_id=?', id).toArray()).toEqual([]);
    };
    const upgraded = new RegistryDO(state, env);
    for (const id of [shell, desktop, 'desktop']) verifyRemoved(id);
    expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('devices','device_tool_aliases')").toArray()).toEqual([]);
    expect(upgraded.mcpServerGet('windows').server.tools.allow).toEqual(['env_submit']);
    expect(upgraded.mcpServerGet(independent).credentialSet).toBe(true);
    expect(sql.exec('SELECT 1 FROM mcp_oauth_tokens WHERE server_id=?', independent).toArray()).toHaveLength(1);
    upgraded.mcpServerPut({id:'desktop',url:'https://independent.example.test/mcp',auth:'none'},'absent');
    expect(new RegistryDO(state, env).mcpServerGet('desktop')).toBeDefined();
    oldPair();
    const repeated = new RegistryDO(state, env);
    verifyRemoved(shell);
    expect(repeated.mcpServerGet(independent).credentialSet).toBe(true);
    expect(repeated.mcpServerGet('desktop')).toBeDefined();
  });
});

it('预留 cua 后旧身份不能重连或恢复会话缓存；新版登记只在旧版写入时重新清退', async () => {
  const scope = 'group:123', space = 'relay:fixture01';
  const oldBearer = 'Bearer ' + 'a'.repeat(40), newBearer = 'Bearer ' + 'b'.repeat(40);
  const tools = [{name:'list_spaces',inputSchema:{type:'object' as const}}];
  const records = await runInDurableObject(env.REGISTRY.getByName('main'), async (registry,state) => {
    const sql = state.storage.sql;
    async function register(instance: RegistryDO, bearer: string) {
      const row = instance.mcpServerPut({id:'cua',transport:'reverse-websocket'},'absent');
      const credentials = await instance.mcpCredentialPut('cua',row.revision,{Authorization:bearer});
      const probe = instance.mcpServerProbe('cua',credentials.revision,{tools});
      const active = instance.mcpServerActivate('cua',probe.revision,{allow:['list_spaces']});
      if ('error' in active) throw new Error('fixture_activation_failed');
      return active;
    }
    // 旧的通用反向服务可以具有与新版目录完全相同的 transport、名称和工具。
    sql.exec("DELETE FROM mcp_server_meta WHERE key='reserved-cua-id-v1'");
    const old = await register(registry,oldBearer);
    const assign = (instance: RegistryDO, revision: string) => instance.cuaGrantsPut({
      scope,spaces:[space],expectedRevision:instance.cuaGrantsList().revision,
    },revision);
    expect(assign(registry,old.server.access.revision!)).toMatchObject({status:'ok'});
    sql.exec("INSERT INTO mcp_oauth_client VALUES('cua','{}')");
    sql.exec("INSERT INTO mcp_oauth_tokens VALUES('cua','owner','v1','issuer','token',NULL,NULL,NULL,1)");
    sql.exec("INSERT INTO mcp_oauth_logins VALUES('login','cua','verifier','nonce',1,2)");
    const upgraded = new RegistryDO(state,env);
    expect(await upgraded.mcpReverseRegistration('cua',oldBearer)).toBeNull();
    expect(upgraded.mcpServerCurrent('cua',serverDigest(old.server))).toBe(false);
    expect(upgraded.cuaGrantsList().grants).toEqual([]);
    expect(() => upgraded.mcpServerGet('cua')).toThrow('not_found');
    for (const table of ['mcp_oauth_client','mcp_oauth_tokens','mcp_oauth_logins'])
      expect(sql.exec('SELECT 1 FROM ' + table + " WHERE server_id='cua'").toArray()).toEqual([]);

    const fresh = await register(upgraded,newBearer);
    expect(assign(upgraded,fresh.server.access.revision!)).toMatchObject({status:'ok'});
    const writeLegacySchema = () => sql.exec('CREATE TABLE devices(id TEXT PRIMARY KEY)');
    for (const rollback of [false,true]) {
      if (rollback) writeLegacySchema();
      const restarted = new RegistryDO(state,env);
      expect(await restarted.mcpReverseRegistration('cua',newBearer)).toBeTruthy();
      expect(await restarted.mcpReverseRegistration('cua',oldBearer)).toBeNull();
      expect(restarted.cuaAssigned(scope,fresh.server.access.revision!)).toEqual([space]);
    }
    writeLegacySchema();
    upgraded.mcpServerProbe('cua',fresh.revision,{tools});
    const upgradedAgain = new RegistryDO(state,env);
    expect(await upgradedAgain.mcpReverseRegistration('cua',newBearer)).toBeNull();
    expect(upgradedAgain.cuaGrantsList().grants).toEqual([]);
    writeLegacySchema();
    await register(upgradedAgain,oldBearer);
    expect(new RegistryDO(state,env).mcpConfig().servers.some(server => server.id === 'cua')).toBe(false);
    return {old:old.server,fresh:fresh.server};
  });

  await runInDurableObject(env.THREAD.getByName(scope), async (_thread,state) => {
    const db = new DurableObjectSqliteDatabase(state.storage);
    await db.exec(MCP_CATALOG_SCHEMA);
    const policy = new McpPolicyStore(db,{...MCP_CONFIG,servers:[records.old]});
    const grant = await policy.setGrant(scope,'cua',{tools:['list_spaces'],resourceAllow:[],actors:['*'],expiresAt:null},'none');
    expect(policy.matches(records.fresh,grant)).toBe(false);
    await saveCatalog(db,makeCatalog(records.old,tools,MCP_CONFIG.limits).revision);
    expect(await restoreCatalog(db,records.old,MCP_CONFIG.limits)).toBeDefined();
    await expect(restoreCatalog(db,records.fresh,MCP_CONFIG.limits)).rejects.toThrow('catalog_invalid');
  });
});

it('旧客户端下载和配对 RPC 不再可达，独立 Cloudflare 状态仍由管理台读取', async () => {
  const request = (method: string, path: string) => worker.fetch(new Request(env.PUBLIC_ORIGIN + path, {
    method, headers:{Authorization:'Bearer synthetic-admin'},
  }), adminEnv());
  const id = crypto.randomUUID();
  expect((await request('GET','/admin/device-client.cjs')).status).toBe(404);
  expect((await request('GET','/admin/devices')).status).toBe(404);
  expect((await request('POST','/admin/devices')).status).toBe(404);
  for (const action of ['pair','ready','revoke'])
    expect((await request('POST','/admin/devices/' + id + '/' + action)).status).toBe(404);
  expect(await (await request('GET','/admin/cloudflare')).json()).toMatchObject({domain:null, reauth:false});
  for (const prefix of ['/admin/cloudflare','/admin/devices/cloudflare'])
    expect(await (await request('GET',prefix + '/changes')).json()).toEqual([]);
});
