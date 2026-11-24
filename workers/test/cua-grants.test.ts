import { env, reset, runInDurableObject } from 'cloudflare:test';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { ThreadMcp, type McpAuthority } from '../src/mcp';
import { MCP_CATALOG_SCHEMA, restoreCatalog } from '../src/mcp/catalog';
import { toolNames } from '../src/mcp/names';
import { afterEach, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import worker from '../src/index';
import { adminEnv } from './mcp-helpers';
import { manageMcp } from '../src/mcp/manage';
import { cuaCards, type CuaDirectory } from '../src/cua/contracts';

afterEach(reset);
const id = 'cua', scope = 'group:123456', device = 'direct:fixture-a.test:8080', second = 'direct:fixture-b.test:8080';
const bearer = 'Bearer '+'g'.repeat(43);
const fixtureTools = ['list_spaces','list_tools','get_hostname','get_window_screenshot'];
const admin = (path:string, input?:unknown, authorized = true) => worker.fetch(new Request(env.PUBLIC_ORIGIN+'/admin/cua/'+path,{
  method:input ? 'PUT' : 'GET',headers:authorized ? {Authorization:'Bearer synthetic-admin','Content-Type':'application/json'} : {},
  body:input ? JSON.stringify(input) : undefined,
}),adminEnv());

async function directoryNode(onQuery?: (name:string) => void | Promise<void>) {
  const registry = env.REGISTRY.getByName('main');
  const initial = await registry.mcpServerPut({id,transport:'reverse-websocket'},'absent');
  const record = await registry.mcpCredentialPut(id,initial.revision,{Authorization:bearer});
  const ws = (await worker.fetch(new Request(env.PUBLIC_ORIGIN+'/mcp/reverse/cua',{headers:{Upgrade:'websocket',Authorization:bearer}}),env)).webSocket!;
  const sessions = new Map<string,Transport>();
  async function receive(data:string) {
    const frame = JSON.parse(data) as {session:string;close?:boolean;message:JSONRPCMessage};
    let transport = sessions.get(frame.session);
    if (frame.close) { await transport?.close(); sessions.delete(frame.session); return; }
    if (!transport) {
      const server = new Server({name:'cua-spaces',version:'0.31.0'},{capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema,() => ({tools:fixtureTools.map(name => ({name,inputSchema:{type:'object' as const}}))}));
      server.setRequestHandler(CallToolRequestSchema,async ({params}) => {
        await onQuery?.(params.name);
        if (params.name === 'get_hostname') return {content:[{type:'text',text:'mac-fixture.local'}]};
        const data = params.name === 'list_tools' ? {service:'driver', tools:[{name:'inspect',description:'查看窗口',inputSchema:{type:'object'}}]} : [
          {id:device,name:'fixture-a',display_name:'测试设备',os:'windows',phase:'ready',power_state:'stopped',labels:{private:'sensitive'}},
          {id:second,name:'fixture-b'},
        ];
        return {content:[{type:'text',text:JSON.stringify(data)}]};
      });
      transport = {async start(){},async close(){this.onclose?.();},async send(message){ws.send(JSON.stringify({session:frame.session,message}));}};
      sessions.set(frame.session,transport);
      await server.connect(transport);
    }
    transport.onmessage?.(frame.message);
  }
  ws.addEventListener('message',event => { void receive(String(event.data)); });
  ws.accept();
  expect(await manageMcp(env,{action:'probe',id,expectedRevision:record.revision})).toMatchObject({status:'ready'});
  const ready = await registry.mcpServerActivate(id,(await registry.mcpServerGet(id)).revision,{allow:fixtureTools});
  if ('error' in ready || !ready.server.access.revision) throw new Error('fixture_activation_failed');
  return {ws,registry,ready,accessRevision:ready.server.access.revision};
}

it('管理员从反向节点取得精简目录，私聊与群使用独立分配，离线可撤销，轮换凭据取消全部旧授权',async () => {
  expect((await admin('devices',undefined,false)).status).toBe(401);
  expect((await admin('grants',undefined,false)).status).toBe(401);
  const {ws,registry,ready,accessRevision} = await directoryNode();
  const view = await (await admin('devices')).json<CuaDirectory>();
  expect(view).toMatchObject({configured:true,online:true,enabled:true,available:true,
    devices:[{id:device,name:'fixture-a',os:'windows',status:'stopped',scopes:[]},{id:second}]});
  expect(JSON.stringify(view)).not.toContain('sensitive');
  const update = (key:string,spaces:string[],revision:string) => admin('grants',{scope:key,spaces,expectedRevision:revision});
  expect((await update(scope,['local:desktop'],view.revision)).status).toBe(400);
  expect((await update(scope,['direct:missing.test:8080'],view.revision)).status).toBe(400);
  const grant = await (await update(scope,[device],view.revision)).json<{revision:string}>();
  expect(await registry.cuaAssigned(scope,accessRevision)).toEqual([device]);
  expect((await registry.mcpConfig(scope)).cuaSpaces).toEqual([device]);
  expect((await update('private:123456',[second],view.revision)).status).toBe(409);
  const next = await (await update('private:123456',[second],grant.revision)).json<{revision:string}>();
  expect((await registry.mcpConfig('private:123456')).cuaSpaces).toEqual([second]);
  expect((await (await admin('devices')).json<CuaDirectory>()).devices[0]?.scopes).toEqual([scope]);
  ws.close(1000);
  expect((await update(scope,[],next.revision)).status).toBe(200);
  expect(await registry.cuaAssigned(scope,accessRevision)).toEqual([]);
  await registry.mcpCredentialPut(id,ready.revision,{Authorization:'Bearer '+'r'.repeat(43)});
  expect(await registry.cuaAssigned('private:123456',accessRevision)).toEqual([]);
  expect((await registry.cuaGrantsList()).grants).toEqual([]);
});

it('停用并重新启用同一个节点使旧授权版本永久失效，重复的设备 ID 不可分配',async () => {
  const {ws,registry,ready,accessRevision:prior} = await directoryNode();
  const latest = await registry.cuaGrantsList();
  expect(await registry.cuaGrantsPut({scope,spaces:[device],expectedRevision:latest.revision},prior)).toMatchObject({status:'ok'});
  const disabled = await registry.mcpServerDisable(id,ready.revision);
  const restored = await registry.mcpServerActivate(id,disabled.revision,{allow:['list_spaces']});
  if ('error' in restored) throw new Error('fixture_reactivation_failed');
  expect(restored.server.access.revision).not.toBe(prior);
  expect(await registry.cuaAssigned(scope,prior)).toEqual([]);
  expect((await registry.mcpConfig(scope)).cuaSpaces).toEqual([]);
  ws.close(1000);
  expect(() => cuaCards({content:[{type:'text',text:JSON.stringify([{id:device,name:'A'},{id:device,name:'B'}])}]})).toThrow('ambiguous');
});

it('设备改名保留 ID 和已有分配，过时的改名不能覆盖新名称，清空后跟随默认名称',async () => {
  const {ws,registry,ready,accessRevision} = await directoryNode();
  const devices = async () => (await admin('devices')).json<CuaDirectory>();
  try {
    const first = await devices();
    const grant = await (await admin('grants',{scope,spaces:[device],expectedRevision:first.revision})).json<{revision:string}>();
    const rename = (expectedName:string,name:string,authorized = true,space = device) => admin('name',{
      space,name,expectedName,expectedRevision:grant.revision,
    },authorized);
    expect((await rename('','测试 Mac',false)).status).toBe(401);
    expect((await rename('','测试 Mac',true,'direct:unknown.test:80')).status).toBe(400);
    expect((await rename('','测试\nMac')).status).toBe(400);
    expect(await (await rename('',' 测试 Mac ')).json()).toEqual({name:'测试 Mac'});
    const renamed = await devices();
    expect(renamed.devices[0]).toMatchObject({id:device,defaultName:'fixture-a',name:'测试 Mac',alias:'测试 Mac',scopes:[scope]});
    expect(renamed.revision).toBe(grant.revision);
    expect(await registry.cuaAssigned(scope,accessRevision)).toEqual([device]);
    expect((await rename('','旧标签')).status).toBe(409);
    expect((await rename('测试 Mac','')).status).toBe(200);
    expect((await devices()).devices[0]?.name).toBe('fixture-a');
    expect((await rename('','个人电脑')).status).toBe(200);
    await registry.mcpCredentialPut(id,ready.revision,{Authorization:'Bearer '+'r'.repeat(43)});
    expect(await registry.cuaNames([device],accessRevision)).toEqual({});
  } finally { ws.close(1000); }
});

it('私聊主模型与子任务的目录使用实时授权，撤权中的 Driver 响应无法回传',async () => {
  const chat = 'private:123456';
  let revokeOnReply = false, requests = 0;
  const {ws,accessRevision} = await directoryNode(async name => {
    requests++;
    if (revokeOnReply && name === 'list_tools') await set([]);
  });
  async function set(spaces:string[]) {
    const registry = env.REGISTRY.getByName('main');
    const {revision} = await registry.cuaGrantsList();
    expect(await registry.cuaGrantsPut({scope:chat,spaces,expectedRevision:revision},accessRevision)).toMatchObject({status:'ok'});
  }
  const who: McpAuthority = {scope:chat,kind:'message',actor:'123456',owner:false,generation:2,replyChannel:'qq'};
  await set([device]);
  try {
    await runInDurableObject(env.THREAD.getByName(chat), async (_instance, state) => {
      const registry = env.REGISTRY.getByName('main');
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA + 'CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)');
      const config = await registry.mcpConfig(chat);
      const mcp = new ThreadMcp(db,env,createRegistry(),async () => who,{...config,servers:config.servers.filter(row => row.id === id)},
        {scope:chat,current:(server,digest) => registry.mcpServerCurrent(server,digest)});
      try {
        await mcp.refreshAll();
        const snapshot = await mcp.captureCapabilities(who);
        expect(snapshot.tools.some(tool => tool.includes('get_hostname') || tool.includes('get_window_screenshot'))).toBe(false);
        expect(snapshot.cua?.spaces).toEqual([device]);
        const list = snapshot.tools.find(tool => tool.startsWith('mcp_cua_list_spaces_'))!;
        const tools = snapshot.tools.find(tool => tool.startsWith('mcp_cua_list_tools_'))!;
        const child = {...who,kind:'subagent' as const,subagentId:'child'};
        let seq = 0;
        const call = (name:string, args:object, actor = who, freeze = false) =>
          mcp.invoke({name,args,operationId:String(++seq),...(freeze ? {snapshot} : {})},async () => actor);
        expect((await call(list,{})).structuredOutput).toMatchObject({spaces:[{id:device}]});
        await set([device,second]);
        expect((await call(list,{},child,true)).structuredOutput).toMatchObject({spaces:[{id:device}]});
        const before = requests;
        expect((await call(tools,{space:second,service:'driver'},child,true)).isError).toBe(true);
        expect((await call(list,{}, {...who,kind:'agent'})).isError).toBe(true);
        expect((await call(tools,{space:device,service:'other'})).isError).toBe(true);
        expect(requests).toBe(before);
        expect((await call(tools,{space:device,service:'driver'})).structuredOutput).toMatchObject({tools:[{name:'inspect'}]});
        revokeOnReply = true;
        const withheld = await call(tools,{space:device,service:'driver'},child,true);
        expect(withheld.isError).toBe(true);
        expect(JSON.stringify(withheld)).not.toContain('查看窗口');
        expect((await call(list,{})).isError).toBe(true);
      } finally { await mcp.close(); }
    });
  } finally { ws.close(1000); }
});

it('主人发消息可读主机名，额外的命令参数、定时任务与委派调用在到达桥之前被拒',async () => {
  let inspections = 0;
  const {ws} = await directoryNode(name => { if (name === 'get_hostname') inspections++; });
  try {
    await runInDurableObject(env.THREAD.getByName('owner'),async (_instance,state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA + 'CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)');
      const config = await env.REGISTRY.getByName('main').mcpConfig('owner');
      const server = config.servers.find(row => row.id === id)!;
      const who: McpAuthority = {scope:'owner',kind:'message',actor:'owner',owner:true,generation:1,replyChannel:'web'};
      const mcp = new ThreadMcp(db,env,createRegistry(),async () => who,{...config,servers:[server]},{scope:'owner'});
      try {
        await mcp.refreshAll();
        const catalog = (await restoreCatalog(db,server,config.limits))!;
        const tool = catalog.tools.find(tool => tool.name === 'get_hostname')!;
        const name = toolNames(catalog,tool).nativeName;
        const call = (args:object,actor = who) => mcp.invoke({name,args,operationId:crypto.randomUUID()},async () => actor);
        expect((await call({space:device})).structuredOutput).toEqual({hostname:'mac-fixture.local'});
        const audit = state.storage.sql.exec<{detail:string}>("SELECT detail FROM events WHERE kind='mcp_call'").one();
        const remoteBytes = Buffer.byteLength(JSON.stringify({content:[{type:'text',text:'mac-fixture.local'}]}));
        expect(JSON.parse(audit.detail)).toMatchObject({server:'cua',tool:name,result:'ok',outputBytes:remoteBytes});
        expect(audit.detail).not.toContain('mac-fixture.local');
        for (const kind of ['schedule','subagent','event','agent'] as const) {
          expect((await call({space:device},{...who,kind})).isError).toBe(true);
        }
        expect((await call({space:device,command:'hostname'})).isError).toBe(true);
        const snapshot = await mcp.captureCapabilities(who);
        expect(snapshot.tools).not.toContain(name);
        expect(inspections).toBe(1);
      } finally { await mcp.close(); }
    });
  } finally { ws.close(1000); }
});
