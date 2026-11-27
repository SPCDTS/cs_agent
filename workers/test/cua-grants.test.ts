import { createExecutionContext, env, reset, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { ThreadMcp, type McpAuthority } from '../src/mcp';
import { MCP_CATALOG_SCHEMA, restoreCatalog } from '../src/mcp/catalog';
import { serverDigest, toolNames } from '../src/mcp/names';
import { afterEach, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import worker from '../src/index';
import { adminEnv } from './mcp-helpers';
import { manageMcp } from '../src/mcp/manage';
import { cuaCards, type CuaDirectory } from '../src/cua/contracts';
import { CuaGrants } from '../src/cua/grants';
import { cuaResult } from '../src/cua/discovery';
import { MCP_CONFIG } from '../src/mcp/config';
import { MediaRepository } from '../src/media/repository';

afterEach(reset);
const id = 'cua', scope = 'group:123456', device = 'direct:fixture-a.test:8080', second = 'direct:fixture-b.test:8080';
const bearer = 'Bearer '+'g'.repeat(43);
const windowPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
const fixtureTools = ['list_spaces','list_tools','space_bash','space_job','space_write','call_tool'];
const fixtureSchemas: Record<string,Record<string,unknown>> = {
  list_spaces: {type:'object', properties:{}, additionalProperties:false},
  list_tools: {
    type:'object',
    properties:{space:{type:'string',maxLength:256}, service:{type:'string',enum:['driver']}, name:{type:'string',maxLength:128}},
    required:['space','service'], additionalProperties:false,
  },
  space_bash: {
    type:'object',
    properties:{space:{type:'string',maxLength:256}, command:{type:'string',minLength:1,maxLength:32768}, timeout:{type:'integer',minimum:1,maximum:50}},
    required:['space','command'], additionalProperties:false,
  },
  space_job: {
    type:'object',
    properties:{
      space:{type:'string',maxLength:256},
      action:{type:'string',enum:['start','status','logs','cancel','list']},
      command:{type:'string',minLength:1,maxLength:32768},
      job:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9._-]{1,128}$'},
      name:{type:'string',minLength:1,maxLength:80},
      cwd:{type:'string',minLength:1,maxLength:4096},
      env:{type:'object',maxProperties:64,propertyNames:{type:'string',pattern:'^[A-Za-z_][A-Za-z0-9_]{0,127}$'},additionalProperties:{type:'string',maxLength:4096}},
      timeout:{type:'integer',minimum:1,maximum:86400},
      until:{
        type:'object',
        properties:{
          file:{type:'string',minLength:1,maxLength:4096}, port:{type:'integer',minimum:1,maximum:65535},
          host:{type:'string',minLength:1,maxLength:253}, command:{type:'string',minLength:1,maxLength:32768},
          pr_checks:{type:'string',minLength:1,maxLength:256}, interval:{type:'integer',minimum:1,maximum:300},
        },
        additionalProperties:false,
      },
      offset:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},
      limit:{type:'integer',minimum:1,maximum:262144},
      follow_ms:{type:'integer',minimum:0,maximum:25000},
    },
    required:['space','action'], additionalProperties:false,
  },
  space_write: {
    type:'object',
    properties:{space:{type:'string',maxLength:256}, path:{type:'string',minLength:1,maxLength:4096}, content:{type:'string',maxLength:262144}},
    required:['space','path','content'], additionalProperties:false,
  },
  call_tool: {
    type:'object',
    properties:{
      space:{type:'string',maxLength:256}, service:{type:'string',enum:['driver']},
      tool:{type:'string',minLength:1,maxLength:128,pattern:'^[a-zA-Z0-9_.-]{1,128}$'},
      arguments:{type:'object',additionalProperties:true},
    },
    required:['space','service','tool'], additionalProperties:false,
  },
};
const admin = (path:string, input?:unknown, authorized = true) => worker.fetch(new Request(env.PUBLIC_ORIGIN+'/admin/cua/'+path,{
  method:input ? 'PUT' : 'GET',headers:authorized ? {Authorization:'Bearer synthetic-admin','Content-Type':'application/json'} : {},
  body:input ? JSON.stringify(input) : undefined,
}),adminEnv());

type DirectoryQuery = (name:string,args?:Record<string,unknown>) => CallToolResult | void | Promise<CallToolResult | void>;
async function connectDirectory(onQuery?: DirectoryQuery, ctx?: ExecutionContext) {
  const ws = (await worker.fetch(new Request(env.PUBLIC_ORIGIN+'/mcp/reverse/cua',{headers:{Upgrade:'websocket',Authorization:bearer}}),env,ctx)).webSocket!;
  const sessions = new Map<string,Transport>();
  let sessionOpens = 0;
  async function receive(data:string) {
    const frame = JSON.parse(data) as {session:string;close?:boolean;message:JSONRPCMessage};
    let transport = sessions.get(frame.session);
    if (frame.close) { await transport?.close(); sessions.delete(frame.session); return; }
    if (!transport) {
      sessionOpens++;
      const server = new Server({name:'cua-spaces',version:'0.31.0'},{capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema,() => ({tools:fixtureTools.map(name => ({
        name,inputSchema:fixtureSchemas[name] ?? {type:'object' as const},
      }))}));
      server.setRequestHandler(CallToolRequestSchema,async ({params}) => {
        const override = await onQuery?.(params.name,params.arguments);
        if (override) return override;
        if (params.name === 'space_bash') return {content:[{type:'text',text:`bash:${String(params.arguments?.command ?? '')}\n[exit 0]`}]};
        if (params.name === 'space_write') return {content:[{type:'text',text:`wrote:${String(params.arguments?.path ?? '')}:${String((params.arguments?.content as string | undefined)?.length ?? 0)}`}]};
        if (params.name === 'space_job') {
          const action = params.arguments?.action;
          if (action === 'list') return {content:[{type:'text',text:JSON.stringify({jobs:[{job_id:'job-1',status:'running'}]})}]};
          if (action === 'logs') return {content:[{type:'text',text:JSON.stringify({job_id:params.arguments?.job,chunk:'line-1\n',offset:0,next_offset:7})}]};
          if (action === 'cancel') return {content:[{type:'text',text:JSON.stringify({job:{job_id:params.arguments?.job,status:'cancelled'}})}]};
          if (action === 'start') return {content:[{type:'text',text:JSON.stringify({job:{job_id:'job-1',status:'running',command:params.arguments?.command}})}]};
          return {content:[{type:'text',text:JSON.stringify({job:{job_id:params.arguments?.job,status:'running'}})}]};
        }
        if (params.name === 'call_tool' && params.arguments?.tool === 'bring_to_front')
          return {content:[{type:'text',text:JSON.stringify({pid:121,window_id:5,activated:true})}],structuredContent:{pid:121,window_id:5,activated:true}};
        if (params.name === 'call_tool' && params.arguments?.tool === 'click')
          return {content:[{type:'text',text:'clicked'}],structuredContent:{ok:true,point:params.arguments?.arguments}};
        if (params.name === 'call_tool' && (params.arguments?.tool === 'get_window_state' || params.arguments?.tool === 'get_desktop_state' || params.arguments?.tool === 'zoom'))
          return {content:[{type:'image',mimeType:'image/png',data:windowPng}]};
        if (params.name === 'call_tool' && params.arguments?.tool !== 'list_windows') {
          const tool = String(params.arguments?.tool ?? '');
          return {content:[{type:'text',text:tool}],structuredContent:{ok:true,tool,args:params.arguments?.arguments ?? {}}};
        }
        if (params.name === 'call_tool') {
          const windowId = params.arguments?.space === second ? Number.MAX_SAFE_INTEGER : 5;
          const payload = {windows:[{pid:121,window_id:windowId,title:'测试窗口'}]};
          return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload};
        }
        const data = params.name === 'list_tools' ? {service:'driver', tools:[{name:'inspect',description:'查看窗口',inputSchema:{type:'object'}}]} : [
          {id:device,name:'fixture-a',display_name:'测试设备',os:'macos',phase:'ready',power_state:'stopped',labels:{private:'sensitive'}},
          {id:second,name:'fixture-b',os:'windows'},
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
  return {ws,sessionsOpened:() => sessionOpens};
}

async function directoryNode(onQuery?: DirectoryQuery) {
  const registry = env.REGISTRY.getByName('main');
  const initial = await registry.mcpServerPut({id,transport:'reverse-websocket'},'absent');
  const record = await registry.mcpCredentialPut(id,initial.revision,{Authorization:bearer});
  const node = await connectDirectory(onQuery);
  expect(await manageMcp(env,{action:'probe',id,expectedRevision:record.revision})).toMatchObject({status:'ready'});
  const ready = await registry.mcpServerActivate(id,(await registry.mcpServerGet(id)).revision,{allow:fixtureTools});
  if ('error' in ready || !ready.server.access.revision) throw new Error('fixture_activation_failed');
  return {...node,registry,ready,accessRevision:ready.server.access.revision};
}

it('一次保存桥令牌，关闭管理页后仍由真实 WebSocket 握手完成工具启用',async () => {
  const token = bearer.slice(7), registry = env.REGISTRY.getByName('main');
  expect((await admin('setup',{token},false)).status).toBe(401);
  expect((await admin('setup',{token:'short'})).status).toBe(400);
  expect(await registry.cuaSetupState()).toBe('new');
  const saved = await Promise.all([admin('setup',{token}),admin('setup',{token})]);
  for (const result of saved) expect(await result.json()).toEqual({saved:true});
  const before = await registry.mcpServerGet(id);
  expect((await admin('setup',{token:'q'.repeat(43)})).status).toBe(409);
  expect((await registry.mcpServerGet(id)).revision).toBe(before.revision);
  const offline = await (await admin('devices')).json<CuaDirectory>();
  expect(offline).toMatchObject({setup:'pending',online:false,enabled:false,devices:[]});
  expect(offline.bridgeUrl).toMatch(/^wss:.*\/mcp\/reverse\/cua$/);
  expect(JSON.stringify(offline)).not.toContain(token);
  // 不完整的远端目录不能部分提交，下一次真实握手仍可继续。
  expect(await registry.cuaFinishSetup(before.revision,[])).toBe(false);
  expect(await registry.mcpServerGet(id)).toEqual(before);
  // 只读探测可以更新目录版本，但不能取消管理员已保存的启用请求。
  await registry.mcpServerProbe(id,before.revision,{tools:[]});
  expect(await registry.cuaSetupState()).toBe('pending');
  const ctx = createExecutionContext(), node = await connectDirectory(undefined,ctx);
  try {
    await waitOnExecutionContext(ctx);
    const active = await registry.mcpServerGet(id);
    expect(active.server.tools.allow).toEqual(fixtureTools);
    expect((await (await admin('devices')).json<CuaDirectory>())).toMatchObject({
      setup:'managed',online:true,enabled:true,available:true,devices:[{id:device},{id:second}],grants:[],
    });
    await registry.mcpServerDisable(id,active.revision);
    await admin('setup',{token});
    expect(await registry.cuaFinishSetup(before.revision,[])).toBe(false);
    expect((await registry.mcpServerGet(id)).server.enabled).toBe(false);
  } finally { node.ws.close(1000); }
});

it('兼容已创建但未保存令牌的草稿，管理员停用后取消迟到的自动启用',async () => {
  const registry = env.REGISTRY.getByName('main');
  await registry.mcpServerPut({id,transport:'reverse-websocket'},'absent');
  expect(await registry.cuaSetupState()).toBe('new');
  await admin('setup',{token:bearer.slice(7)});
  const pending = await registry.mcpServerGet(id);
  await registry.mcpServerDisable(id,pending.revision);
  expect(await registry.cuaSetupState()).toBe('managed');
  expect(await registry.cuaFinishSetup(pending.revision,[])).toBe(false);
  expect((await registry.mcpServerGet(id)).server.enabled).toBe(false);
});

it('管理员从反向节点取得精简目录，私聊与群使用独立分配，离线可撤销，轮换凭据取消全部旧授权',async () => {
  expect((await admin('devices',undefined,false)).status).toBe(401);
  expect((await admin('grants',undefined,false)).status).toBe(401);
  const {ws,registry,ready,accessRevision} = await directoryNode();
  const view = await (await admin('devices')).json<CuaDirectory>();
  expect(view).toMatchObject({configured:true,online:true,enabled:true,available:true,
    devices:[{id:device,name:'fixture-a',os:'macos',status:'stopped',scopes:[]},{id:second,os:'windows'}]});
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

it('停用保留会话分配并允许撤销，重新启用同一节点后只恢复剩余分配',async () => {
  const {ws,registry,ready,accessRevision:prior} = await directoryNode();
  const latest = await registry.cuaGrantsList();
  expect(await registry.cuaGrantsPut({scope,spaces:[device,second],expectedRevision:latest.revision},prior)).toMatchObject({status:'ok'});
  await runInDurableObject(registry,(_instance,state) => {
    // 用旧版清退触发器模拟数据库升级，后续第一次停用也应保留这两条记录。
    state.storage.sql.exec('ALTER TABLE cua_device_grants DROP COLUMN grant_id');
    state.storage.sql.exec(`CREATE TRIGGER cua_grants_on_update AFTER UPDATE OF config ON mcp_servers
      WHEN NEW.id='cua' AND json_extract(OLD.config,'$.enabled') IS NOT json_extract(NEW.config,'$.enabled')
      BEGIN DELETE FROM cua_device_grants; END`);
    state.storage.transactionSync(() => new CuaGrants(state.storage).initialize());
  });
  const upgraded = await registry.cuaGrantVersions(scope,prior);
  expect(Object.keys(upgraded).sort()).toEqual([device,second]);
  expect(new Set(Object.values(upgraded)).size).toBe(2);
  const disabled = await registry.mcpServerDisable(id,ready.revision);
  const paused = await (await admin('devices')).json<CuaDirectory>();
  expect(paused).toMatchObject({enabled:false,devices:[],grants:[{scope,spaces:[device,second]}]});
  expect(await registry.cuaAssigned(scope,prior)).toEqual([]);
  expect((await registry.mcpConfig(scope)).cuaSpaces).toEqual([]);
  expect((await admin('grants',{scope,spaces:[device],expectedRevision:paused.revision})).status).toBe(200);
  const reduced = await registry.cuaGrantsList();
  expect((await admin('grants',{scope,spaces:[device,second],expectedRevision:reduced.revision})).status).toBe(503);
  expect(await registry.cuaGrantsPut({scope,spaces:[device,second],expectedRevision:reduced.revision})).toMatchObject({status:'invalid'});
  const restored = await registry.mcpServerActivate(id,disabled.revision,{allow:['list_spaces']});
  if ('error' in restored) throw new Error('fixture_reactivation_failed');
  expect(restored.server.access.revision).not.toBe(prior);
  expect(await registry.cuaAssigned(scope,prior)).toEqual([]);
  expect((await registry.mcpConfig(scope)).cuaSpaces).toEqual([device]);
  await registry.mcpServerPut({id,transport:'reverse-websocket'},restored.revision);
  expect((await registry.cuaGrantsList()).grants).toEqual([]);
  ws.close(1000);
  expect(() => cuaCards({content:[{type:'text',text:JSON.stringify([{id:device,name:'A'},{id:device,name:'B'}])}]})).toThrow('ambiguous');
});

it('已启用节点取消工具再恢复原选择，原调用版本失效且群分配保留',async () => {
  const {ws,registry,ready,accessRevision} = await directoryNode();
  try {
    const {revision} = await registry.cuaGrantsList();
    expect(await registry.cuaGrantsPut({scope,spaces:[device],expectedRevision:revision},accessRevision)).toMatchObject({status:'ok'});
    const prior = await registry.cuaGrantVersions(scope,accessRevision);
    const reduced = await registry.mcpServerActivate(id,ready.revision,{allow:fixtureTools.filter(tool => tool !== 'call_tool')});
    if ('error' in reduced) throw new Error('fixture_selection_failed');
    const restored = await registry.mcpServerActivate(id,reduced.revision,{allow:fixtureTools});
    if ('error' in restored) throw new Error('fixture_selection_failed');
    expect(await registry.mcpServerCurrent(id,serverDigest(ready.server))).toBe(false);
    expect(await registry.cuaGrantVersions(scope,accessRevision)).toEqual({});
    expect(await registry.cuaGrantVersions(scope,restored.server.access.revision!)).toEqual(prior);
  } finally { ws.close(1000); }
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

it('获配会话与子任务的设备只读调用仅限连续有效的分配，撤权重授后重新派发才能访问',async () => {
  const chat = 'group:123456';
  let onReply: (name:string) => Promise<void> = async () => {}, requests = 0;
  const {ws,accessRevision} = await directoryNode(async name => {
    requests++;
    await onReply(name);
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
      const toolRegistry = createRegistry();
      const mcp = new ThreadMcp(db,env,toolRegistry,async () => who,{...config,servers:config.servers.filter(row => row.id === id)},
        {scope:chat,current:(server,digest) => registry.mcpServerCurrent(server,digest)});
      try {
        await mcp.restore();
        let snapshot = await mcp.captureCapabilities(who);
        const callTool = snapshot.tools.find(tool => tool.startsWith('mcp_cua_call_tool_'))!;
        const jobTool = snapshot.tools.find(tool => tool.startsWith('mcp_cua_space_job_'))!;
        expect(callTool).toBeTruthy();
        expect(jobTool).toBeTruthy();
        expect(snapshot.cua?.spaces).toEqual([device]);
        expect(toolRegistry.snapshot().tools().map(row => row.tool.name)).toEqual(expect.arrayContaining(snapshot.tools));
        const list = snapshot.tools.find(tool => tool.startsWith('mcp_cua_list_spaces_'))!;
        const tools = snapshot.tools.find(tool => tool.startsWith('mcp_cua_list_tools_'))!;
        const child = {...who,kind:'subagent' as const,subagentId:'child'};
        let seq = 0;
        const call = (name:string, args:object, actor = who, freeze = false) =>
          mcp.invoke({name,args,operationId:String(++seq),...(freeze ? {snapshot} : {})},async () => actor);
        expect((await call(list,{})).structuredOutput).toMatchObject({spaces:[{id:device}]});
        await set([device,second]);
        expect((await call(list,{},child,true)).structuredOutput).toMatchObject({spaces:[{id:device}]});
        const windows = (space:string, args:object) => ({space,service:'driver',tool:'list_windows',arguments:args});
        expect((await call(callTool,windows(device,{pid:121}),child,true)).structuredOutput).toEqual({windows:[{pid:121,window_id:5,title:'测试窗口'}]});
        expect((await call(callTool,windows(second,{pid:121}))).structuredOutput).toEqual({windows:[{pid:121,window_id:Number.MAX_SAFE_INTEGER,title:'测试窗口'}]});
        expect((await call(jobTool,{space:device,action:'list'},child,true)).structuredOutput).toEqual({jobs:[{job_id:'job-1',status:'running'}]});
        expect((await call(jobTool,{space:device,action:'status',job:'job-1'},child,true)).structuredOutput).toEqual({job:{job_id:'job-1',status:'running'}});
        expect((await call(jobTool,{space:device,action:'logs',job:'job-1',offset:0,limit:100},child,true)).structuredOutput)
          .toEqual({job_id:'job-1',chunk:'line-1\n',offset:0,next_offset:7});

        const before = requests;
        expect((await call(tools,{space:second,service:'driver'},child,true)).isError).toBe(true);
        expect((await call(list,{}, {...who,kind:'agent'})).isError).toBe(true);
        expect((await call(tools,{space:device,service:'other'})).isError).toBe(true);
        expect((await call(callTool,windows(second,{}),child,true)).isError).toBe(true);
        expect((await call(jobTool,{space:second,action:'list'},child,true)).isError).toBe(true);
        const legacy = {...snapshot,cua:{revision:accessRevision,spaces:[device]}};
        expect((await mcp.invoke({name:callTool,args:windows(device,{}),operationId:'legacy',snapshot:legacy},async () => child)).isError).toBe(true);
        expect(requests).toBe(before);
        expect((await call(tools,{space:device,service:'driver'})).structuredOutput).toMatchObject({tools:[{name:'inspect'}]});
        // 在截图回包途中撤销并重新授予相同设备，主模型和冻结子任务都不能取回上一份授权下拍的图。
        const capture = {space:device,service:'driver',tool:'get_desktop_state',arguments:{}};
        onReply = async name => { if (name === 'call_tool') { await set([second]); await set([device,second]); } };
        expect((await call(callTool,capture,child,true)).isError).toBe(true);
        expect((await call(callTool,capture)).isError).toBe(true);
        expect((await env.ASSETS.list()).objects).toEqual([]);
        onReply = async () => {};
        const requestCount = requests;
        expect((await call(callTool,capture,child,true)).isError).toBe(true);
        expect(requests).toBe(requestCount);
        snapshot = await mcp.captureCapabilities(who);
        const image = (await call(callTool,capture,child,true)).structuredOutput;
        if (!image || typeof image !== 'object' || !('imageId' in image) || typeof image.imageId !== 'string')
          throw new Error('missing_window_image');
        const {imageId} = image;
        const media = new MediaRepository({bucket:env.ASSETS,scope:chat});
        expect(Buffer.from((await media.get(imageId)).bytes).toString('base64')).toBe(windowPng);
        await expect(new MediaRepository({bucket:env.ASSETS,scope:'owner'}).get(imageId)).rejects.toThrow('asset_not_found');
        onReply = async name => { if (name === 'list_tools') await set([]); };
        const withheld = await call(tools,{space:device,service:'driver'},child,true);
        expect(withheld.isError).toBe(true);
        expect(JSON.stringify(withheld)).not.toContain('查看窗口');
        expect((await call(list,{})).isError).toBe(true);
        await set([device]);
        snapshot = await mcp.captureCapabilities(who);
        onReply = async name => {
          if (name !== 'list_tools') return;
          const server = await registry.mcpServerGet(id);
          const disabled = await registry.mcpServerDisable(id,server.revision);
          await registry.mcpServerActivate(id,disabled.revision,{allow:fixtureTools});
        };
        const stale = await call(tools,{space:device,service:'driver'},child,true);
        expect(stale.isError).toBe(true);
        expect(JSON.stringify(stale)).not.toContain('查看窗口');
        expect((await registry.mcpConfig(chat)).cuaSpaces).toEqual([device]);
      } finally { await mcp.close(); }
    });
  } finally { ws.close(1000); }
});

it('群首次获配和重新启用均可离线装配目录，旧子任务保持失效',async () => {
  const {ws,ready,accessRevision} = await directoryNode();
  ws.close(1000);
  const who: McpAuthority = {scope,kind:'message',actor:'123456',owner:false,generation:1,replyChannel:'qq'};
  await runInDurableObject(env.THREAD.getByName(scope),async (_instance,state) => {
    const registry = env.REGISTRY.getByName('main');
    const grant = async (revision:string) => {
      const saved = await registry.cuaGrantsList();
      expect(await registry.cuaGrantsPut({scope,spaces:[device],expectedRevision:saved.revision},revision)).toMatchObject({status:'ok'});
    };
    const db = new DurableObjectSqliteDatabase(state.storage);
    await db.exec(MCP_CATALOG_SCHEMA + 'CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)');
    const config = async () => {
      const config = await registry.mcpConfig(scope);
      return {...config,servers:config.servers.filter(server => server.id === id)};
    };
    const tools = createRegistry(), mcp = new ThreadMcp(db,env,tools,async () => who,await config(),
      {scope,current:(id,digest) => registry.mcpServerCurrent(id,digest)});
    const visible = () => tools.snapshot().tools().map(row => row.tool.name).filter(name => name.startsWith('mcp_cua_'));
    try {
      await mcp.restore();
      expect(visible()).toEqual([]);
      await grant(accessRevision);
      await mcp.syncConfig(await config());
      const first = visible();
      expect(first).toHaveLength(fixtureTools.length);
      const prior = await mcp.captureCapabilities(who);
      expect(prior.tools).toEqual(first);

      const disabled = await registry.mcpServerDisable(id,ready.revision);
      await mcp.syncConfig(await config());
      expect(visible()).toEqual([]);
      const enabled = await registry.mcpServerActivate(id,disabled.revision,{allow:['list_spaces']});
      if ('error' in enabled) throw new Error('fixture_reactivation_failed');
      await mcp.syncConfig(await config());
      expect(visible()).toEqual([expect.stringMatching(/^mcp_cua_list_spaces_/)]);
      expect(first).not.toContain(visible()[0]);
      expect((await mcp.captureCapabilities(who)).tools).toEqual(visible());
      expect((await mcp.invoke({name:first[0],args:{},operationId:'old-operation',snapshot:prior},
        async () => ({...who,kind:'subagent',subagentId:'child'}))).isError).toBe(true);
    } finally { await mcp.close(); }
  });
});

it('主人交互会话与快照子任务可执行通用执行工具，定时任务、事件、越界参数与无快照子任务被拒',async () => {
  let executions = 0;
  const {ws} = await directoryNode(name => {
    if (name !== 'list_spaces' && name !== 'list_tools') executions++;
  });
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
        const toolNamed = (base:string) => toolNames(catalog,catalog.tools.find(tool => tool.name === base)!).nativeName;
        const bashName = toolNamed('space_bash'), writeName = toolNamed('space_write');
        const jobName = toolNamed('space_job'), callName = toolNamed('call_tool');
        const invoke = (name:string, args:object, actor = who, snapshot?:Awaited<ReturnType<typeof mcp.captureCapabilities>>) =>
          mcp.invoke({name,args,operationId:crypto.randomUUID(),...(snapshot ? {snapshot} : {})},async () => actor);

        const bashRes = await invoke(bashName,{space:device,command:'uname -a && ls'});
        expect(bashRes.isError).toBeFalsy();
        expect(bashRes.output?.[0]).toEqual({type:'text',text:'bash:uname -a && ls\n[exit 0]'});
        const audit = state.storage.sql.exec<{detail:string}>("SELECT detail FROM events WHERE kind='mcp_call'").one();
        const remoteBytes = Buffer.byteLength(JSON.stringify({content:[{type:'text',text:'bash:uname -a && ls\n[exit 0]'}]}));
        expect(JSON.parse(audit.detail)).toMatchObject({server:'cua',tool:bashName,result:'ok',outputBytes:remoteBytes});
        expect(audit.detail).not.toContain('uname -a');

        expect((await invoke(writeName,{space:device,path:'/tmp/note.txt',content:'hello cua'})).output?.[0])
          .toEqual({type:'text',text:'wrote:/tmp/note.txt:9'});
        expect((await invoke(jobName,{space:device,action:'start',command:'npm test'})).structuredOutput)
          .toEqual({job:{job_id:'job-1',status:'running',command:'npm test'}});
        expect((await invoke(callName,{space:device,service:'driver',tool:'click',arguments:{x:12,y:34}})).structuredOutput)
          .toEqual({ok:true,point:{x:12,y:34}});

        const beforeDenied = executions;
        for (const kind of ['schedule','subagent','event','agent'] as const) {
          expect((await invoke(bashName,{space:device,command:'id'},{...who,kind})).isError).toBe(true);
        }
        for (const [name,args] of [
          [bashName,{space:device,command:'id',timeout:51}],
          [bashName,{space:device,command:'echo\0x'}],
          [jobName,{space:device,action:'start',command:'id',notify:{channel:'qq'}}],
          [writeName,{space:device,path:'/tmp/x',content:'你'.repeat(90000)}],
          [callName,{space:device,service:'spaces',tool:'click'}],
        ] as const) {
          expect((await invoke(name,args)).isError).toBe(true);
        }
        expect(executions).toBe(beforeDenied);

        const snapshot = await mcp.captureCapabilities(who);
        expect(snapshot.tools).toEqual(expect.arrayContaining([bashName,writeName,jobName,callName]));
        const child: McpAuthority = {...who,kind:'subagent',subagentId:'owner-child'};
        expect((await invoke(bashName,{space:second,command:'ver'},child,snapshot)).isError).toBeFalsy();
        expect(executions).toBe(beforeDenied + 1);
      } finally { await mcp.close(); }
    });
  } finally { ws.close(1000); }
});

it('设备变更免审防重放、区分 remote_error 与异常响应，收紧只读后旧子任务失效',async () => {
  let writes = 0, afterDispatch: () => Promise<void> = async () => {}, overrideReply: CallToolResult | undefined;
  const {ws,ready,accessRevision} = await directoryNode(async (name,args) => {
    if (name === 'space_bash' || name === 'space_write' || (name === 'space_job' && (args?.action === 'start' || args?.action === 'cancel'))
        || (name === 'call_tool' && (args?.tool === 'bring_to_front' || args?.tool === 'click'))) {
      writes++;
      await afterDispatch();
      if (overrideReply) { const res = overrideReply; overrideReply = undefined; return res; }
    }
  });
  expect(ready.server.tools.readOnly).toEqual(['list_spaces','list_tools']);
  const assign = async (spaces:string[]) => {
    const registry = env.REGISTRY.getByName('main');
    const {revision} = await registry.cuaGrantsList();
    expect(await registry.cuaGrantsPut({scope,spaces,expectedRevision:revision},accessRevision)).toMatchObject({status:'ok'});
  };
  await assign([device]);
  const who: McpAuthority = {scope,kind:'message',actor:'123456',owner:false,generation:2,replyChannel:'qq'};
  try {
    await runInDurableObject(env.THREAD.getByName(scope),async (_instance,state) => {
      const registry = env.REGISTRY.getByName('main');
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA + 'CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)');
      const config = await registry.mcpConfig(scope);
      const cua = config.servers.find(server => server.id === id)!;
      const mcp = new ThreadMcp(db,env,createRegistry(),async () => who,{...config,servers:[cua]},
        {scope,current:(server,digest) => registry.mcpServerCurrent(server,digest)});
      try {
        await mcp.restore();
        const snapshot = await mcp.captureCapabilities(who);
        const callName = snapshot.tools.find(name => name.startsWith('mcp_cua_call_tool_'))!;
        const bashName = snapshot.tools.find(name => name.startsWith('mcp_cua_space_bash_'))!;
        const jobName = snapshot.tools.find(name => name.startsWith('mcp_cua_space_job_'))!;
        const writeName = snapshot.tools.find(name => name.startsWith('mcp_cua_space_write_'))!;
        const args = {space:device,service:'driver',tool:'bring_to_front',arguments:{pid:121,window_id:5}};
        const invoke = (operationId:string, space = device, actor = who) => mcp.invoke({
          name:callName,args:{...args,space},operationId,...(actor.subagentId ? {snapshot} : {}),
        },async () => actor);
        expect((await invoke('not-assigned',second)).isError).toBe(true);
        expect((await invoke('passive',device,{...who,kind:'event'})).isError).toBe(true);
        expect(writes).toBe(0);

        const child = {...who,kind:'subagent' as const,subagentId:'test-child'};
        const result = await invoke('delegated',device,child);
        expect(result.structuredOutput).toEqual({pid:121,window_id:5,activated:true});
        expect((await invoke('delegated',device,child)).structuredOutput).toEqual(result.structuredOutput);
        expect(writes).toBe(1);

        // 获配群无需审批即可执行写文件、后台任务启动与通用命令，并保留回执防重放。
        expect((await mcp.invoke({name:writeName,args:{space:device,path:'/tmp/a.txt',content:'ok'},operationId:'write-1'},async () => who)).isError).toBeFalsy();
        expect((await mcp.invoke({name:jobName,args:{space:device,action:'start',command:'sleep 5'},operationId:'job-1'},async () => who)).structuredOutput)
          .toEqual({job:{job_id:'job-1',status:'running',command:'sleep 5'}});

        // remote.isError 返回业务失败而非 outcome_unknown，并记入 remote_error 回执与审计日志。
        overrideReply = {isError:true,content:[{type:'text',text:'permission denied on guest'}]};
        const remoteErr = await mcp.invoke({name:bashName,args:{space:device,command:'cat /root/secret'},operationId:'remote-err'},async () => who);
        expect(remoteErr.isError).toBe(true);
        expect(JSON.stringify(remoteErr)).toContain('permission denied on guest');
        expect(JSON.stringify(remoteErr)).not.toContain('outcome_unknown');
        const lastAudit = state.storage.sql.exec<{detail:string}>("SELECT detail FROM events WHERE kind='mcp_call' ORDER BY rowid DESC LIMIT 1").one();
        expect(JSON.parse(lastAudit.detail)).toMatchObject({tool:bashName,result:'remote_error'});
        expect(JSON.stringify(await mcp.invoke({name:bashName,args:{space:device,command:'cat /root/secret'},operationId:'remote-err'},async () => who)))
          .toContain('permission denied on guest');

        // !remote.isError 但返回畸形截图导致 cuaResult 报错时，写操作收敛为 outcome_unknown 且不再重放。
        overrideReply = {content:[{type:'image',mimeType:'image/png',data:Buffer.from('not-valid-png').toString('base64')}]};
        const badShape = await mcp.invoke({name:callName,args:{space:device,service:'driver',tool:'click',arguments:{x:1,y:2}},operationId:'bad-shape'},async () => who);
        expect(JSON.stringify(badShape)).toContain('outcome_unknown');
        expect(JSON.stringify(await mcp.invoke({name:callName,args:{space:device,service:'driver',tool:'click',arguments:{x:1,y:2}},operationId:'bad-shape'},async () => who)))
          .toContain('outcome_unknown');

        expect((await invoke('user')).structuredOutput).toEqual(result.structuredOutput);
        const beforeFailure = writes;
        afterDispatch = async () => { throw new Error('fixture_lost_reply'); };
        expect(JSON.stringify(await invoke('uncertain'))).toContain('outcome_unknown');
        afterDispatch = async () => {};
        expect(JSON.stringify(await invoke('uncertain'))).toContain('outcome_unknown');
        expect(writes).toBe(beforeFailure + 1);
        afterDispatch = async () => { await assign([]); await assign([device]); };
        expect(JSON.stringify(await invoke('in-flight'))).toContain('outcome_unknown');
        afterDispatch = async () => {};
        // 新分配无法取回上一份分配的成功回执，也不能重新发出相同操作。
        expect(JSON.stringify(await invoke('user'))).toContain('operation_conflict');
        expect((await invoke('delegated',device,child)).isError).toBe(true);
        expect(writes).toBe(beforeFailure + 2);

        const beforeRestriction = await mcp.captureCapabilities(who);
        const current = await registry.mcpServerGet(id);
        const limited = await registry.mcpServerActivate(id,current.revision,{allow:fixtureTools,readOnly:['call_tool','space_job']});
        if ('error' in limited) throw new Error('fixture_activation_failed');
        expect(limited.server.access.revision).not.toBe(accessRevision);
        expect(await registry.cuaAssigned(scope,limited.server.access.revision!)).toEqual([device]);
        const sync = async () => {
          const config = await registry.mcpConfig(scope);
          await mcp.syncConfig({...config,servers:config.servers.filter(server => server.id === id)});
        };
        const delegated = (snap:typeof beforeRestriction) => mcp.invoke({
          name:snap.tools.find(name => name.startsWith('mcp_cua_call_tool_'))!,args,operationId:'after-reopen',snapshot:snap,
        },async () => child);
        await sync();
        const tightSnap = await mcp.captureCapabilities(who);
        const tightJob = tightSnap.tools.find(name => name.startsWith('mcp_cua_space_job_'))!;
        const tightCall = tightSnap.tools.find(name => name.startsWith('mcp_cua_call_tool_'))!;
        expect((await delegated(tightSnap)).isError).toBe(true);
        expect((await mcp.invoke({name:tightJob,args:{space:device,action:'start',command:'sleep 1'},operationId:'tight-job-write',snapshot:tightSnap},async () => child)).isError).toBe(true);
        expect((await mcp.invoke({name:tightJob,args:{space:device,action:'status',job:'job-1'},operationId:'tight-job-read',snapshot:tightSnap},async () => child)).structuredOutput)
          .toEqual({job:{job_id:'job-1',status:'running'}});
        expect((await mcp.invoke({name:tightCall,args:{space:device,service:'driver',tool:'list_windows'},operationId:'tight-win-read',snapshot:tightSnap},async () => child)).structuredOutput)
          .toMatchObject({windows:[{pid:121,window_id:5}]});

        const reopened = await registry.mcpServerActivate(id,limited.revision,{allow:fixtureTools,readOnly:[]});
        if ('error' in reopened) throw new Error('fixture_activation_failed');
        expect(reopened.server.access.revision).toBe(limited.server.access.revision);
        await sync();
        const writesBeforeReopen = writes;
        expect((await delegated(beforeRestriction)).isError).toBe(true);
        expect(writes).toBe(writesBeforeReopen);
        expect((await delegated(await mcp.captureCapabilities(who))).structuredOutput).toEqual(result.structuredOutput);
        expect(writes).toBe(writesBeforeReopen + 1);
        expect(await mcp.policy.list(scope)).toEqual([]);
      } finally { await mcp.close(); }
    });
  } finally { ws.close(1000); }
});

it('旧只读授权或含静态 enum 探测在重新检测前不能开放写操作，旧 call_tool 只读保持安全',async () => {
  let writes = 0;
  const {ws,registry,ready} = await directoryNode((name,args) => {
    if (name === 'space_bash' || args?.tool === 'bring_to_front') writes++;
  });
  try {
    const owner: McpAuthority = {scope:'owner',kind:'message',actor:'10000001',owner:true,generation:1,replyChannel:'qq'};
    // 模拟升级前遗留的 tools.readOnly = tools.allow：更新节点后 space_bash 和 call_tool 写操作均 fail-closed 被拒。
    await runInDurableObject(registry,(_instance,state) => {
      state.storage.sql.exec("UPDATE mcp_servers SET config=json_set(config,'$.tools.readOnly',json_extract(config,'$.tools.allow')) WHERE id='cua'");
    });
    await runInDurableObject(env.THREAD.getByName('owner'),async (_instance,state) => {
      const ownerRegistry = env.REGISTRY.getByName('main');
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA + 'CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)');
      const config = await ownerRegistry.mcpConfig();
      const tools = createRegistry(), mcp = new ThreadMcp(db,env,tools,async () => owner,
        {...config,servers:config.servers.filter(row => row.id === id)},{scope:'owner',current:(id,hash) => ownerRegistry.mcpServerCurrent(id,hash)});
      try {
        await mcp.refreshAll();
        const names = tools.snapshot().tools().map(row => row.tool.name);
        const callName = names.find(n => n.startsWith('mcp_cua_call_tool_'))!;
        const bashName = names.find(n => n.startsWith('mcp_cua_space_bash_'))!;
        expect((await mcp.invoke({name:callName,args:{space:device,service:'driver',tool:'list_windows'},operationId:'legacy-ro'},async () => owner)).structuredOutput)
          .toMatchObject({windows:[{pid:121,window_id:5}]});
        expect((await mcp.invoke({name:callName,args:{space:device,service:'driver',tool:'bring_to_front',arguments:{pid:121,window_id:5}},operationId:'legacy-rw'},async () => owner)).isError).toBe(true);
        expect((await mcp.invoke({name:bashName,args:{space:device,command:'uname -a'},operationId:'legacy-bash'},async () => owner)).isError).toBe(true);
        expect(writes).toBe(0);
      } finally { await mcp.close(); }
    });

    // 探测结果中 call_tool.tool 仍含 enum 时禁止开放写入，仅可保持 call_tool 只读。
    const callEnumProbe = await registry.mcpServerProbe(id,ready.revision,{tools:fixtureTools.map(name => ({
      name,
      inputSchema: name === 'call_tool'
        ? {type:'object',properties:{tool:{type:'string',enum:['list_windows','get_window_state']}}}
        : fixtureSchemas[name] ?? {type:'object'},
    }))});
    const expectStaleProbeRejected = async (expectedRevision:string) => {
      const blocked = await worker.fetch(new Request(env.PUBLIC_ORIGIN+'/admin/mcp/manage',{method:'POST',
        headers:{Authorization:'Bearer synthetic-admin','Content-Type':'application/json'},
        body:JSON.stringify({action:'activate',id,expectedRevision,selection:{allow:fixtureTools}})}),adminEnv());
      expect(blocked.status).toBe(400);
      expect(await blocked.json()).toEqual({error:'probe_required'});
    };
    await expectStaleProbeRejected(callEnumProbe.revision);
    const readOnlyOld = await registry.mcpServerActivate(id,callEnumProbe.revision,{allow:fixtureTools,readOnly:['call_tool']});
    if ('error' in readOnlyOld) throw new Error('fixture_activation_failed');
    expect(readOnlyOld.server.tools.readOnly).toEqual(['list_spaces','list_tools','call_tool']);

    // 探测结果中 space_bash.command 仍含 enum 时，即使限制 call_tool 只读也不得激活 space_bash。
    const bashEnumProbe = await registry.mcpServerProbe(id,readOnlyOld.revision,{tools:fixtureTools.map(name => ({
      name,
      inputSchema: name === 'space_bash'
        ? {type:'object',properties:{command:{type:'string',enum:['hostname']}}}
        : fixtureSchemas[name] ?? {type:'object'},
    }))});
    const blockedBash = await worker.fetch(new Request(env.PUBLIC_ORIGIN+'/admin/mcp/manage',{method:'POST',
      headers:{Authorization:'Bearer synthetic-admin','Content-Type':'application/json'},
      body:JSON.stringify({action:'activate',id,expectedRevision:bashEnumProbe.revision,selection:{allow:fixtureTools,readOnly:['call_tool']}})}),adminEnv());
    expect(blockedBash.status).toBe(400);
    expect(await blockedBash.json()).toEqual({error:'probe_required'});

    // 重新探测最新桥契约后即可完整激活。
    expect(await manageMcp(env,{action:'probe',id,expectedRevision:bashEnumProbe.revision})).toMatchObject({status:'ready'});
    const readOnlyNew = await registry.mcpServerActivate(id,(await registry.mcpServerGet(id)).revision,{allow:fixtureTools,readOnly:['call_tool']});
    if ('error' in readOnlyNew) throw new Error('fixture_activation_failed');
    expect(readOnlyNew.server.tools.readOnly).toEqual(['list_spaces','list_tools','call_tool']);
    const active = await registry.mcpServerActivate(id,readOnlyNew.revision,{allow:fixtureTools,readOnly:[]});
    expect(active).toMatchObject({server:{tools:{readOnly:['list_spaces','list_tools']}}});
  } finally { ws.close(1000); }
});

it('cuaResult 解析 space_job JSON，写入合法截图并拦截纯伪造图片',async () => {
  const jobJson = {job:{job_id:'j1',status:'done'}};
  expect((await cuaResult('space_job',{space:device,action:'status',job:'j1'},
    {content:[{type:'text',text:JSON.stringify(jobJson)}]},[device],MCP_CONFIG.limits,env,scope,'rev')).structuredOutput)
    .toEqual(jobJson);
  expect((await cuaResult('space_job',{space:device,action:'list'},
    {content:[{type:'text',text:'plain log output'}]},[device],MCP_CONFIG.limits,env,scope,'rev')).structuredOutput)
    .toBeUndefined();

  const shot = await cuaResult('call_tool',{space:device,service:'driver',tool:'get_desktop_state',arguments:{}},
    {content:[{type:'image',mimeType:'image/png',data:windowPng}]},[device],MCP_CONFIG.limits,env,scope,'rev');
  expect(shot.isError).toBeFalsy();
  const shotOut = shot.structuredOutput as {imageId?:string; imageIds?:string[]};
  expect(shotOut.imageIds).toHaveLength(1);
  expect(shotOut.imageId).toBe(shotOut.imageIds?.[0]);
  expect(shot.output?.some(part => part.type === 'text' && part.text.includes(shotOut.imageId!))).toBe(true);
  await expect(new MediaRepository({bucket:env.ASSETS,scope:'owner'}).get(shotOut.imageId!)).rejects.toThrow('asset_not_found');

  const invalidOnly = await cuaResult('call_tool',{space:device,service:'driver',tool:'get_window_state',arguments:{pid:1,window_id:2}},
    {content:[{type:'image',mimeType:'image/png',data:Buffer.from('not-png').toString('base64')}]},[device],MCP_CONFIG.limits,env,scope,'rev');
  expect(invalidOnly.isError).toBe(true);

  const mixed = await cuaResult('call_tool',{space:device,service:'driver',tool:'get_desktop_state',arguments:{}},
    {content:[{type:'text',text:'desktop ok'},{type:'image',mimeType:'image/png',data:Buffer.from('not-png').toString('base64')}]},
    [device],MCP_CONFIG.limits,env,scope,'rev');
  expect(mixed.isError).toBeFalsy();
  expect(mixed.output).toEqual([{type:'text',text:'desktop ok\n[Cua 图片内容无效，已省略]'}]);
});

it('space_write 支持满 256 KiB 高转义载荷，argumentBytes 超限返回 invalid_arguments 且不断开连接',async () => {
  const {ws,sessionsOpened} = await directoryNode();
  try {
    await runInDurableObject(env.THREAD.getByName('owner'),async (_instance,state) => {
      const registry = env.REGISTRY.getByName('main');
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA + 'CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)');
      const config = await registry.mcpConfig('owner');
      const cua = config.servers.find(row => row.id === id)!;
      const who: McpAuthority = {scope:'owner',kind:'message',actor:'owner',owner:true,generation:1,replyChannel:'web'};
      const mcp = new ThreadMcp(db,env,createRegistry(),async () => who,{...config,servers:[cua]},
        {scope:'owner',current:(server,digest) => registry.mcpServerCurrent(server,digest)});
      try {
        await mcp.refreshAll();
        const catalog = (await restoreCatalog(db,cua,config.limits))!;
        const toolNamed = (base:string) => toolNames(catalog,catalog.tools.find(tool => tool.name === base)!).nativeName;
        const writeName = toolNamed('space_write'), callName = toolNamed('call_tool'), bashName = toolNamed('space_bash');
        const invoke = (name:string, args:object) => mcp.invoke({name,args,operationId:crypto.randomUUID()},async () => who);

        const full256KiB = 'a'.repeat(262_144);
        const fullRes = await invoke(writeName,{space:device,path:'/tmp/256k.txt',content:full256KiB});
        expect(fullRes.isError).toBeFalsy();
        expect(fullRes.output?.[0]).toEqual({type:'text',text:'wrote:/tmp/256k.txt:262144'});

        const escaped256KiB = '"\n'.repeat(131_072);
        const escapedRes = await invoke(writeName,{space:device,path:'/tmp/esc.txt',content:escaped256KiB});
        expect(escapedRes.isError).toBeFalsy();
        expect(escapedRes.output?.[0]).toEqual({type:'text',text:'wrote:/tmp/esc.txt:262144'});

        const opensBefore = sessionsOpened();
        const controlOverflow = await invoke(writeName,{space:device,path:'/tmp/ctl.txt',content:'\u0001'.repeat(150_000)});
        expect(controlOverflow.isError).toBe(true);
        expect(JSON.stringify(controlOverflow)).toContain('invalid_arguments');
        expect(JSON.stringify(controlOverflow)).not.toContain('not_started');

        const blobOverflow = await invoke(callName,{space:device,service:'driver',tool:'click',arguments:{blob:'x'.repeat(700_000)}});
        expect(blobOverflow.isError).toBe(true);
        expect(JSON.stringify(blobOverflow)).toContain('invalid_arguments');

        const recentAudits = state.storage.sql.exec<{detail:string}>("SELECT detail FROM events WHERE kind='mcp_call' ORDER BY rowid DESC LIMIT 2").toArray();
        expect(recentAudits.map(row => JSON.parse(row.detail).result)).toEqual(['invalid_arguments','invalid_arguments']);

        const afterRes = await invoke(bashName,{space:device,command:'pwd'});
        expect(afterRes.isError).toBeFalsy();
        expect(sessionsOpened()).toBe(opensBefore);
      } finally { await mcp.close(); }
    });
  } finally { ws.close(1000); }
});

it('call_tool 收紧为只读时放行真实 cua-driver 只读查询与 prompt=false，拦截写操作与误名工具',async () => {
  let driverCalls = 0;
  const {ws,registry,ready} = await directoryNode(name => { if (name === 'call_tool') driverCalls++; });
  try {
    const readOnly = await registry.mcpServerActivate(id,ready.revision,{allow:fixtureTools,readOnly:['call_tool']});
    if ('error' in readOnly || !readOnly.server.access.revision) throw new Error('fixture_activation_failed');
    const grants = await registry.cuaGrantsList();
    expect(await registry.cuaGrantsPut({scope,spaces:[device],expectedRevision:grants.revision},readOnly.server.access.revision)).toMatchObject({status:'ok'});

    const who: McpAuthority = {scope,kind:'message',actor:'123456',owner:false,generation:2,replyChannel:'qq'};
    await runInDurableObject(env.THREAD.getByName(scope),async (_instance,state) => {
      const scopeRegistry = env.REGISTRY.getByName('main');
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA + 'CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)');
      const config = await scopeRegistry.mcpConfig(scope);
      const cua = config.servers.find(server => server.id === id)!;
      const mcp = new ThreadMcp(db,env,createRegistry(),async () => who,{...config,servers:[cua]},
        {scope,current:(server,digest) => scopeRegistry.mcpServerCurrent(server,digest)});
      try {
        await mcp.restore();
        const snapshot = await mcp.captureCapabilities(who);
        const callName = snapshot.tools.find(name => name.startsWith('mcp_cua_call_tool_'))!;
        const invoke = (tool:string, args?:object) => mcp.invoke({
          name:callName, args:{space:device,service:'driver',tool,...(args ? {arguments:args} : {})}, operationId:crypto.randomUUID(), snapshot,
        },async () => ({...who,kind:'subagent',subagentId:'ro-child'}));

        for (const [tool, args] of [
          ['clipboard_read'], ['get_browser_state'], ['get_session'], ['list_sessions'],
          ['get_guide'], ['get_agent_cursor_state'], ['get_recording_state'],
          ['verify_state'], ['parse_visual_regions'], ['get_desktop_state'], ['zoom'],
          ['check_permissions', { prompt: false }],
        ] as const) {
          const res = await invoke(tool, args);
          expect(res.isError, `只读工具 ${tool} 应允许执行`).toBeFalsy();
        }
        const desktopShot = await invoke('get_desktop_state');
        expect((desktopShot.structuredOutput as {imageId?:string}).imageId).toMatch(/^[a-f0-9]{64}$/);

        const callsBeforeDenied = driverCalls;
        for (const [tool, args] of [
          ['clipboard_write', { text: 'secret' }],
          ['get_clipboard'],
          ['check_permissions', {}],
          ['check_permissions', { prompt: true }],
          ['click', { x: 1, y: 2 }],
          ['bring_to_front', { pid: 1, window_id: 2 }],
        ] as const) {
          expect((await invoke(tool, args)).isError, `非只读或未收录工具 ${tool} 应被拒`).toBe(true);
        }
        expect(driverCalls).toBe(callsBeforeDenied);
      } finally { await mcp.close(); }
    });
  } finally { ws.close(1000); }
});

it('管理台签发并通过真实反向连接兑换，未授权、过期、伪造和轮换后的命令无法下发凭据',async () => {
  const post = (path:string,headers:Record<string,string>={}) => worker.fetch(new Request(env.PUBLIC_ORIGIN+path,{method:'POST',headers}),adminEnv());
  expect((await post('/admin/cua/pair')).status).toBe(401);
  const node = await directoryNode();
  // 用只实现管理子协议的节点替换探测节点，两者经过同一个真实的 BridgeDO。
  const ws = (await worker.fetch(new Request(env.PUBLIC_ORIGIN+'/mcp/reverse/cua',{headers:{Upgrade:'websocket',Authorization:bearer}}),env)).webSocket!;
  const claims: Record<string,string>[] = [];
  ws.addEventListener('message',ev => {
    const frame = JSON.parse(String(ev.data));
    if (frame.close || frame.message.method !== 'cs-agent/cua/pair') return;
    const {params,id} = frame.message;
    if (params.action === 'claim') claims.push(params);
    const result = params.action === 'ready' ? {status:'ready'} :
      {status:'ok',machineId:'paired-1',relay:'wss://relay.example.test',registration:'a'.repeat(64),deviceToken:'b'.repeat(64)};
    ws.send(JSON.stringify({session:frame.session,message:{jsonrpc:'2.0',id,result}}));
  });
  ws.accept();
  try {
    const issued = await post('/admin/cua/pair',{Authorization:'Bearer synthetic-admin'});
    expect(issued.status).toBe(200);
    const {ticket,expires} = await issued.json<{ticket:string,expires:number}>();
    const redeem = (t:string) => post('/cua/join/claim',{Authorization:'Bearer '+t,'X-Cua-Client':'c'.repeat(64)});
    const forged = ticket.slice(0,-1)+(ticket.endsWith('a') ? 'b' : 'a');
    expect((await redeem(forged)).status).toBe(401);
    const clock = vi.spyOn(Date,'now').mockReturnValue(expires);
    try { expect((await redeem(ticket)).status).toBe(401); }
    finally { clock.mockRestore(); }
    expect(claims).toHaveLength(0);
    const response = await redeem(ticket);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.text()).trim().split('\n')).toEqual(['wss://relay.example.test','paired-1','a'.repeat(64),'b'.repeat(64)]);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.client).not.toBe('c'.repeat(64));
    await node.registry.mcpCredentialPut(id,node.ready.revision,{Authorization:'Bearer '+'q'.repeat(43)});
    expect((await redeem(ticket)).status).not.toBe(200);
    expect(claims).toHaveLength(1);
  } finally { ws.close(); node.ws.close(); }
});

it('按设备原子保存授权会保留未变会话的 grant_id，且离线或停用时仅可撤销',async () => {
  const {ws,registry,ready,accessRevision} = await directoryNode();
  const secondScope = 'private:654321', thirdScope = 'group:789012';
  const putDevice = (input:unknown, authorized = true) => worker.fetch(new Request(env.PUBLIC_ORIGIN+'/admin/cua/device-grants',{
    method:'PUT',
    headers:authorized ? {Authorization:'Bearer synthetic-admin','Content-Type':'application/json'} : {},
    body:JSON.stringify(input),
  }),adminEnv());
  try {
    expect((await putDevice({space:device,scopes:[scope],expectedRevision:'any'},false)).status).toBe(401);

    const initial = await (await admin('devices')).json<CuaDirectory>();
    expect(initial.tools).toEqual(fixtureTools);

    expect((await putDevice({space:device,scopes:[scope,secondScope],expectedRevision:'stale'})).status).toBe(409);
    expect((await putDevice({space:'direct:missing.test:8080',scopes:[scope],expectedRevision:initial.revision})).status).toBe(400);

    const granted = await putDevice({space:device,scopes:[scope,secondScope],expectedRevision:initial.revision});
    expect(granted.status).toBe(200);
    const rev1 = (await granted.json<{revision:string}>()).revision;
    const versionsBefore = await registry.cuaGrantVersions(scope,accessRevision);
    expect(Object.keys(versionsBefore)).toEqual([device]);

    // 新增一个会话并撤销 secondScope，保留的 scope 应延续原有的 grant_id。
    const updated = await putDevice({space:device,scopes:[scope,thirdScope],expectedRevision:rev1});
    expect(updated.status).toBe(200);
    const rev2 = (await updated.json<{revision:string}>()).revision;
    expect(await registry.cuaGrantVersions(scope,accessRevision)).toEqual(versionsBefore);

    const listed = await (await admin('devices')).json<CuaDirectory>();
    expect(listed.devices.find(d => d.id === device)?.scopes.sort()).toEqual([scope,thirdScope].sort());

    // 节点断开后禁止新增，仍可撤销已有会话。
    ws.close(1000);
    expect((await putDevice({space:device,scopes:[scope,secondScope,thirdScope],expectedRevision:rev2})).status).toBe(503);
    const revoked = await putDevice({space:device,scopes:[scope],expectedRevision:rev2});
    expect(revoked.status).toBe(200);
    expect((await revoked.json<{grants:CuaDirectory['grants']}>()).grants).toEqual([{scope,spaces:[device]}]);

    // 停用 Cua 服务后仍可清空残留授权。
    await registry.mcpServerDisable(id,ready.revision);
    const rev3 = (await registry.cuaGrantsList()).revision;
    expect((await putDevice({space:device,scopes:[],expectedRevision:rev3})).status).toBe(200);
    expect((await registry.cuaGrantsList()).grants).toEqual([]);
  } finally { try { ws.close(1000); } catch {} }
});

it('Android 点击仅派发给当前分配的设备，不能借机执行 shell；断线回执不重放', async () => {
  const phone='android:fixture', who:McpAuthority={scope,kind:'message',actor:'123456',owner:false,generation:2,replyChannel:'qq'};
  let clicks=0;
  const {ws,registry,accessRevision}=await directoryNode((name,args)=>{
    if (name==='call_tool' && args?.tool==='android_click_node') { clicks++; return {isError:true,content:[{type:'text',text:'outcome_unknown'}]}; }
  });
  try {
    const {revision}=await registry.cuaGrantsList();
    expect(await registry.cuaGrantsPut({scope,spaces:[phone],expectedRevision:revision},accessRevision)).toMatchObject({status:'ok'});
    await runInDurableObject(env.THREAD.getByName(scope),async (_instance,state)=>{
      const registry=env.REGISTRY.getByName('main');
      const db=new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA+'CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)');
      const config=await registry.mcpConfig(scope);
      const mcp=new ThreadMcp(db,env,createRegistry(),async()=>who,{...config,servers:config.servers.filter(row=>row.id===id)},
        {scope,current:(server,digest)=>registry.mcpServerCurrent(server,digest)});
      try {
        await mcp.restore();
        const snapshot=await mcp.captureCapabilities(who);
        const name=snapshot.tools.find(n=>n.startsWith('mcp_cua_call_tool_'))!;
        const invoke=(space:string,tool:string)=>mcp.invoke({name,args:{space,service:'driver',tool,arguments:{node_id:'node_12'}},operationId:'phone-click'},async()=>who);
        expect((await invoke('android:other','android_click_node')).isError).toBe(true);
        expect((await invoke(phone,'shell')).isError).toBe(true);
        expect(clicks).toBe(0);
        expect(JSON.stringify(await invoke(phone,'android_click_node'))).toContain('outcome_unknown');
        expect(JSON.stringify(await invoke(phone,'android_click_node'))).toContain('outcome_unknown');
        expect(clicks).toBe(1);
      } finally { await mcp.close(); }
    });
  } finally {ws.close();}
});
