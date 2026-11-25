import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registration, serveConnection } from '../src/cua-reverse-bridge.ts';

class FixtureSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  frames: string[] = [];
  send(data: string) {
    this.frames.push(data);
    this.dispatchEvent(new Event('reply'));
  }
  close() { this.dispatchEvent(new Event('close')); }
  frame(session: string, message: object) {
    this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({session,message})}));
  }
  async rpc(session: string, method: string, params: object = {}) {
    const id = randomUUID(), signal = AbortSignal.timeout(3000);
    const answered = async () => {
      for (;;) {
        for (const text of this.frames) {
          const frame = JSON.parse(text);
          if (frame.session === session && frame.message?.id === id) return frame.message;
        }
        await once(this,'reply',{signal});
      }
    };
    const waiting = answered();
    this.frame(session,{jsonrpc:'2.0',id,method,params});
    return waiting;
  }
  endSession(session: string) {
    this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({session,close:true})}));
  }
}

test('注册端点只接受预配置的 Cua WSS 地址和 Unix socket', () => {
  const env = {REVERSE_MCP_URL:'wss://test.invalid/mcp/reverse/cua', REVERSE_MCP_TOKEN:'x'.repeat(32), CUA_SOCKET_PATH:'/run/test.sock'};
  assert.equal(registration(env).socketPath, '/run/test.sock');
  for (const url of ['http://test.invalid/mcp/reverse/cua','wss://test.invalid/mcp/reverse/example','wss://test.invalid/mcp/reverse/cua?token=x'])
    assert.throws(() => registration({...env,REVERSE_MCP_URL:url}));
  assert.throws(() => registration({...env,CUA_SOCKET_PATH:'test.sock'}));
});

test('心跳收到 pong 后继续运行，下一次 pong 超时则关闭连接', async t => {
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  const ws = new FixtureSocket();
  let closed = 0;
  ws.addEventListener('close',() => { closed++; });
  const stop = serveConnection(ws as unknown as WebSocket,'/unused.sock');
  try {
    t.mock.timers.tick(30_000);
    assert.deepEqual(ws.frames,['ping']);
    ws.dispatchEvent(new MessageEvent('message',{data:'pong'}));
    t.mock.timers.tick(10_000);
    assert.equal(closed,0);
    t.mock.timers.tick(20_000);
    assert.deepEqual(ws.frames,['ping','ping']);
    t.mock.timers.tick(10_000);
    assert.equal(closed,1);
  } finally { await stop(); }
});

test('两个反向会话独立协商本机目录，兼容 JSON 与 SSE，仅列出和调用发现工具', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cua-dir-'));
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\cua-directory-' + randomUUID() : join(dir,'daemon.sock');
  const calls: string[] = [], removed: string[] = [];
  const directoryCalls: string[] = [];
  const card = {id:'relay:fixture01',name:'fixture',os:'linux',private_metadata:'not_for_directory'};
  let cards: unknown = [card], directoryFails = false;
  const running = new Set<string>();
  const removal = new EventTarget();
  const slow = new EventTarget();
  const http = createServer(async (req,res) => {
    assert.equal(req.url,'/mcp');
    assert.equal(req.headers.authorization,undefined);
    const session = String(req.headers['mcp-session-id'] ?? '');
    if (req.method === 'DELETE') {
      running.delete(session); removed.push(session);
      res.writeHead(204).end(); removal.dispatchEvent(new Event('deleted')); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (rpc.method === 'initialize') {
      assert.equal(session,'');
      const assigned = randomUUID(); running.add(assigned);
      res.setHeader('Mcp-Session-Id',assigned);
      result = {protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'cua-spaces',version:'fixture'}};
    } else {
      assert.ok(running.has(session));
      if (rpc.method === 'notifications/initialized' || rpc.method === 'notifications/cancelled') { res.writeHead(202).end(); return; }
      calls.push(session + '/' + rpc.method);
      if (rpc.method === 'tools/list') {
        result = {tools:['list_spaces','list_tools','fixture_hello','create_space','delete_space','add_space','remove_space','upload','download','send_file'].map(name => ({name,inputSchema:{type:'object'}}))};
      } else {
        assert.equal(rpc.method,'tools/call');
        directoryCalls.push(session + '/' + rpc.params.name);
        if (rpc.params.arguments.name === 'wait_for_cancel') {
          res.writeHead(200,{'Content-Type':'text/event-stream'}); res.flushHeaders();
          slow.dispatchEvent(new Event('waiting'));
          return;
        }
        if (rpc.params.name === 'list_spaces') assert.deepEqual(rpc.params.arguments,{});
        const listing = rpc.params.name === 'list_spaces' ? cards
          : {service:'driver',services:['driver','unpublished_service'],count:1,contract_version:'fixture',tools:[{name:'hello',description:'问候'}]};
        result = {content:[{type:'text',text:JSON.stringify(listing)}],isError:rpc.params.name === 'list_spaces' && directoryFails};
      }
    }
    const body = JSON.stringify({jsonrpc:'2.0',id:rpc.id,result});
    if (rpc.method === 'tools/list') {
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('event: message\r\n');
      res.end('data: ' + body + '\r\n\r\n');
    } else { res.writeHead(200,{'Content-Type':'application/json'}).end(body); }
  });
  try {
    http.listen(path); await once(http,'listening');
    const ws = new FixtureSocket(), stop = serveConnection(ws as unknown as WebSocket,path);
    try {
      const a = randomUUID(), b = randomUUID();
      const initialize = {protocolVersion:'2025-11-25', capabilities:{},clientInfo:{name:'fixture',version:'1'}};
      for (const session of [a,b]) {
        const reply = await ws.rpc(session,'initialize',initialize);
        assert.equal(reply.result.serverInfo.name,'cua-spaces');
      }
      assert.equal(running.size,2);
      const [upA,upB] = [...running];
      const catalog = await ws.rpc(a,'tools/list');
      assert.deepEqual(catalog.result.tools.map((t:{name:string}) => t.name),['list_spaces','list_tools']);
      const [listSpaces,listTools] = catalog.result.tools;
      assert.equal(listSpaces.inputSchema.additionalProperties,false);
      assert.deepEqual(listTools.inputSchema.required,['space','service']);
      assert.deepEqual(listTools.inputSchema.properties.service.enum,['driver']);
      const spacePattern = new RegExp(listTools.inputSchema.properties.space.pattern);
      assert.ok(spacePattern.test('relay:a-b1234z'));
      assert.ok(spacePattern.test('relay:'+'a'.repeat(64)));
      for (const id of ['relay:-b12345z','relay:ab12345-','relay:1234567','relay:'+'a'.repeat(65)])
        assert.equal(spacePattern.test(id),false);
      assert.ok(calls.includes(upA + '/tools/list'));
      const spaces = await ws.rpc(b,'tools/call',{name:'list_spaces',arguments:{}});
      assert.deepEqual(JSON.parse(spaces.result.content[0].text), [{id:'relay:fixture01',name:'fixture',os:'linux'}]);
      assert.ok(calls.includes(upB + '/tools/call'));
      const before = calls.length;
      assert.ok((await ws.rpc(a,'tools/call',{name:'fixture_hello',arguments:{}})).error);
      assert.ok((await ws.rpc(a,'tools/call',{name:'create_space',arguments:{on:'local',durable:false,reuse:false}})).error);
      for (const tool of ['add_space','remove_space'])
        assert.ok((await ws.rpc(a,'tools/call',{name:tool,arguments:{space:card.id}})).error);
      for (const tool of ['upload','download','send_file'])
        assert.ok((await ws.rpc(a,'tools/call',{name:tool,arguments:{space:card.id,path:'/tmp/x'}})).error);
      for (const space of ['local:session-test',card.id])
        assert.ok((await ws.rpc(a,'tools/call',{name:'delete_space',arguments:{space}})).error);
      assert.ok((await ws.rpc(a,'resources/list')).error);
      assert.ok((await ws.rpc(a,'tools/call',{name:'list_tools',arguments:{space:'relay:fixture01',service:'other'}})).error);
      assert.equal(calls.length,before);
      const driver = (space:string) => ws.rpc(a,'tools/call',{name:'list_tools',arguments:{space,service:'driver'}});
      const gateStart = directoryCalls.length;
      for (const target of ['fixture','https://fixture.invalid/mcp','direct:fixture.invalid:443','relay:unknown01'])
        assert.equal((await driver(target)).error.data.reason,'space_not_registered');
      cards = [card,card];
      assert.equal((await driver(card.id)).error.data.reason,'space_ambiguous');
      cards = {invalid:true};
      assert.equal((await driver(card.id)).error.data.reason,'directory_invalid');
      cards = [card];
      directoryFails = true;
      assert.equal((await driver(card.id)).error.data.reason,'directory_unavailable');
      directoryFails = false;
      assert.deepEqual(directoryCalls.slice(gateStart), Array(7).fill(upA + '/list_spaces'));
      cards = [{...card,id:'relay:-fixture1'}];
      assert.equal((await driver('relay:-fixture1')).error.data.reason,'space_not_registered');
      cards = [card];
      assert.ok((await driver(card.id)).result);
      assert.deepEqual(directoryCalls.slice(-2),[upA + '/list_spaces',upA + '/list_tools']);
      const deleted = once(removal,'deleted',{signal:AbortSignal.timeout(3000)});
      const waiting = once(slow,'waiting',{signal:AbortSignal.timeout(3000)});
      const pendingId = randomUUID();
      ws.frame(a,{jsonrpc:'2.0',id:pendingId,method:'tools/call',
        params:{name:'list_tools', arguments:{space:'relay:fixture01',service:'driver',name:'wait_for_cancel'}}});
      await waiting;
      ws.frame(a,{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:pendingId}});
      await deleted;
      assert.deepEqual(removed,[upA]);
      assert.ok(ws.frames.some(text => { const frame = JSON.parse(text); return frame.session === a && frame.close === true; }));
      const tools = await ws.rpc(b,'tools/call',{name:'list_tools',arguments:{space:'relay:fixture01',service:'driver'}});
      assert.deepEqual(JSON.parse(tools.result.content[0].text).services,['driver']);
      const c = randomUUID();
      await ws.rpc(c,'initialize',initialize);
      const upC = [...running].find(up => up !== upB);
      const detached = once(removal,'deleted',{signal:AbortSignal.timeout(3000)});
      ws.endSession(c); await detached;
      const disconnected = once(removal,'deleted',{signal:AbortSignal.timeout(3000)});
      ws.close(); await disconnected;
      assert.deepEqual(removed,[upA,upC,upB]);
      const next = new FixtureSocket(), stopNext = serveConnection(next as unknown as WebSocket,path);
      try {
        const callCount = calls.length;
        next.frame(b,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_spaces',arguments:{}}});
        assert.deepEqual(next.frames.map(frame => JSON.parse(frame)),[{session:b,close:true}]);
        assert.equal(calls.length,callCount);
        assert.equal(running.size,0);
        await next.rpc(b,'initialize',initialize);
        assert.ok([...running].every(id => !removed.includes(id)));
      } finally { await stopNext(); }
    } finally { await stop(); }
    assert.equal(running.size,0);
  } finally {
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});

test('开放完整 6 个桥工具，校验参数与大载荷写入并过滤图片与错误细节', async t => {
  const dir = await mkdtemp(join(tmpdir(),'cua-exec-'));
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\cua-exec-' + randomUUID() : join(dir,'daemon.sock');
  const space = 'relay:fixture01';
  const driverArgs = (tool:string,args?:object) => ({space,service:'driver',tool,...(args === undefined ? {} : {arguments:args})});
  const png = {type:'image' as const,mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC'};
  const jpgBytes = Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0xff,0xd9]);
  const jpg = {type:'image' as const,mimeType:'image/jpeg',data:jpgBytes.toString('base64')};
  const largeContent = 'line-0123456789abcdef\n'.repeat(4000); // > 80 KiB
  assert.ok(Buffer.byteLength(largeContent, 'utf8') > 80 * 1024);

  const seen: Array<{name:string; args:Record<string,unknown> | undefined}> = [];
  let nextResult: CallToolResult | undefined;
  let nextThrow: Error | undefined;

  const server = new Server({name:'cua-spaces',version:'test'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools:['list_spaces','list_tools','space_bash','space_job','space_write','call_tool','create_space','delete_space','upload','download','send_file']
      .map(name => ({name,inputSchema:{type:'object' as const}})),
  }));
  server.setRequestHandler(CallToolRequestSchema,async ({params:{name,arguments:args}}) => {
    seen.push({name,args});
    const json = (data: unknown) => ({content:[{type:'text' as const,text:JSON.stringify(data)}]});
    if (name === 'list_spaces') return json([{id:space,name:'fixture',os:'macos'}]);
    if (name === 'list_tools') return json({service:'driver',tools:[{name:'screenshot',description:'截图',inputSchema:{type:'object'}}]});
    if (nextThrow) { const err = nextThrow; nextThrow = undefined; throw err; }
    if (nextResult) { const res = nextResult; nextResult = undefined; return res; }
    if (name === 'space_bash') {
      const cmd = String(args?.command ?? '');
      if (cmd.includes('exit 7')) return {content:[{type:'text',text:'stderr notice\n[exit 7]'}]};
      return {content:[{type:'text',text:`ran:${cmd}:timeout=${args?.timeout}\n[exit 0]`}]};
    }
    if (name === 'space_job') {
      return json({job:{job_id:'job-1',action:args?.action},...(args?.action === 'list' ? {jobs:[{job_id:'job-1',status:'running'}]} : {})});
    }
    if (name === 'space_write') {
      return {content:[{type:'text',text:`wrote ${String((args?.content as string).length)} chars to ${args?.path}`}]};
    }
    if (name === 'call_tool') {
      return {
        _meta:{upstream_secret:'do-not-leak'},
        content:[{type:'text',text:`called:${args?.tool}`},png,jpg],
        structuredContent:{ok:true,tool:args?.tool,echoArgs:args?.arguments},
      } as CallToolResult;
    }
    throw new Error('unexpected upstream tool');
  });
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true});
  await server.connect(transport);
  const http = createServer((req,res) => { void transport.handleRequest(req,res); });
  const ws = new FixtureSocket(), stop = serveConnection(ws as unknown as WebSocket,path);
  t.after(async () => {
    await stop(); await server.close(); http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir,{recursive:true,force:true});
  });
  http.listen(path); await once(http,'listening');
  const session = randomUUID();
  await ws.rpc(session,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const listed = (await ws.rpc(session,'tools/list')).result.tools as Array<{name:string; annotations?:{readOnlyHint?:boolean}; inputSchema:{properties?:Record<string,unknown>}}>;
  assert.deepEqual(listed.map(t => t.name),['list_spaces','list_tools','space_bash','space_job','space_write','call_tool']);
  assert.equal(listed.find(t => t.name === 'list_spaces')?.annotations?.readOnlyHint,true);
  assert.equal(listed.find(t => t.name === 'list_tools')?.annotations?.readOnlyHint,true);
  for (const op of ['space_bash','space_job','space_write','call_tool']) {
    assert.equal(listed.find(t => t.name === op)?.annotations?.readOnlyHint,false);
  }
  assert.equal((listed.find(t => t.name === 'space_bash')?.inputSchema.properties?.command as {enum?:unknown})?.enum,undefined);
  assert.equal((listed.find(t => t.name === 'call_tool')?.inputSchema.properties?.tool as {enum?:unknown})?.enum,undefined);

  const call = (name: string,args: object) => ws.rpc(session,'tools/call',{name,arguments:args});

  // 非法参数及屏蔽工具应在到达上游之前被拒
  for (const [name,args] of [
    ['create_space',{on:'local'}],
    ['delete_space',{space}],
    ['upload',{space,path:'/tmp/a'}],
    ['download',{space,path:'/tmp/a'}],
    ['send_file',{space,path:'/tmp/a'}],
    ['space_bash',{space,command:''}],
    ['space_bash',{space,command:'echo\0hi'}],
    ['space_bash',{space,command:'echo hi',timeout:51}],
    ['space_bash',{space,command:'echo hi',cwd:'/tmp'}],
    ['space_job',{space,action:'start',command:'sleep 1',notify:{channel:'qq'}}],
    ['space_job',{space,action:'start',command:'sleep 1',wake:true}],
    ['space_job',{space,action:'start'}],
    ['space_job',{space,action:'start',command:'sleep 1',until:{port:8080}}],
    ['space_job',{space,action:'start',until:{file:'/tmp/a',port:80}}],
    ['space_job',{space,action:'list',job:'job-1'}],
    ['space_job',{space,action:'logs',job:'job-1',follow_ms:25001}],
    ['space_job',{space,action:'start',command:'env',env:{'BAD-KEY':'1'}}],
    ['space_job',{space,action:'start',command:'env',env:{OK:'a\0b'}}],
    ['space_write',{space,path:'/tmp/a\0b',content:'hi'}],
    ['space_write',{space,path:'/tmp/a',content:'x'.repeat(262145)}],
    ['space_write',{space,path:'/tmp/a',content:'你'.repeat(90000)}], // <= 200k chars 但超过 256 KiB UTF-8
    ['space_write',{space,path:'/tmp/a',content:'hi',mode:'0644'}],
    ['call_tool',{space,service:'spaces',tool:'list_windows'}],
    ['call_tool',{space,service:'driver',tool:'bad/tool'}],
    ['call_tool',{space,service:'driver',tool:'click',arguments:['not-object']}],
  ] as const) {
    assert.ok((await call(name,args)).error,`应拒绝非法调用 ${name}:${JSON.stringify(args)}`);
  }
  assert.equal(seen.length,0);

  // 未登记设备拒绝
  for (const [name,args] of [
    ['space_bash',{command:'pwd'}],
    ['space_job',{action:'list'}],
    ['space_write',{path:'/tmp/x',content:'ok'}],
    ['call_tool',{service:'driver',tool:'get_desktop_state'}],
  ] as const) {
    assert.equal((await call(name,{...args,space:'direct:unknown:18181'})).error.data.reason,'space_not_registered');
  }

  // space_bash 通用命令与默认/上限超时、非零退出透传
  const bashDefault = await call('space_bash',{space,command:'uname -a && ls'});
  assert.equal(bashDefault.result.content[0].text,'ran:uname -a && ls:timeout=30\n[exit 0]');
  const bashMax = await call('space_bash',{space,command:'false; exit 7',timeout:50});
  assert.equal(bashMax.result.content[0].text,'stderr notice\n[exit 7]');

  // space_job 5 类动作与 until 等待条件
  assert.deepEqual(JSON.parse((await call('space_job',{space,action:'start',command:'npm test',name:'tests',cwd:'/work',env:{CI:'1'},timeout:600})).result.content[0].text),
    {job:{job_id:'job-1',action:'start'}});
  assert.deepEqual(seen.at(-1)?.args,{space,action:'start',command:'npm test',name:'tests',cwd:'/work',env:{CI:'1'},timeout:600});
  assert.ok((await call('space_job',{space,action:'start',until:{port:8080,host:'127.0.0.1',interval:2}})).result);
  assert.ok((await call('space_job',{space,action:'status',job:'job-1'})).result);
  assert.ok((await call('space_job',{space,action:'logs',job:'job-1',offset:0,limit:4096,follow_ms:25000})).result);
  assert.ok((await call('space_job',{space,action:'cancel',job:'job-1'})).result);
  assert.ok((await call('space_job',{space,action:'list'})).result);

  // space_write 小文本、满 256 KiB UTF-8 与高转义大载荷（验证抬高后的 requestBytes）
  const smallWrite = await call('space_write',{space,path:'/tmp/hello.txt',content:'hello'});
  assert.equal(smallWrite.result.content[0].text,'wrote 5 chars to /tmp/hello.txt');
  const bigWrite = await call('space_write',{space,path:'/tmp/large.txt',content:largeContent});
  assert.equal(bigWrite.result.content[0].text,`wrote ${largeContent.length} chars to /tmp/large.txt`);
  const full256KiB = 'a'.repeat(262144);
  const fullWrite = await call('space_write',{space,path:'/tmp/256k.txt',content:full256KiB});
  assert.equal(fullWrite.result.content[0].text,'wrote 262144 chars to /tmp/256k.txt');
  const escaped256KiB = '"\n'.repeat(131072);
  assert.equal(Buffer.byteLength(escaped256KiB, 'utf8'), 262144);
  assert.ok(Buffer.byteLength(JSON.stringify({space,path:'/tmp/esc.txt',content:escaped256KiB}), 'utf8') > 512 * 1024);
  const escapedWrite = await call('space_write',{space,path:'/tmp/esc.txt',content:escaped256KiB});
  assert.equal(escapedWrite.result.content[0].text,'wrote 262144 chars to /tmp/esc.txt');

  // call_tool 通用调用：默认空 arguments、保留图片与 structuredContent、剔除 _meta
  const shot = await call('call_tool',driverArgs('get_desktop_state'));
  assert.deepEqual(seen.at(-1)?.args,{space,service:'driver',tool:'get_desktop_state',arguments:{}});
  assert.equal((shot.result as {_meta?:unknown})._meta,undefined);
  assert.deepEqual(shot.result.content,[{type:'text',text:'called:get_desktop_state'},png,jpg]);
  assert.deepEqual(shot.result.structuredContent,{ok:true,tool:'get_desktop_state',echoArgs:{}});

  const click = await call('call_tool',driverArgs('click',{x:100,y:200,button:'left'}));
  assert.deepEqual(click.result.structuredContent,{ok:true,tool:'click',echoArgs:{x:100,y:200,button:'left'}});

  // 非法图片、MIME 伪造与超过 4 张上限时省略替换
  const fakePng = Buffer.from('not-a-valid-png').toString('base64');
  nextResult = {content:[png,png,png,png,png,{type:'image',mimeType:'image/png',data:fakePng},{...png,mimeType:'image/jpeg'}]};
  const filteredImages = await call('call_tool',driverArgs('get_desktop_state',{}));
  assert.deepEqual(filteredImages.result.content,[
    png,png,png,png,
    {type:'text',text:'[Cua 图片超出格式或大小限制，已省略]'},
    {type:'text',text:'[Cua 图片超出格式或大小限制，已省略]'},
    {type:'text',text:'[Cua 图片超出格式或大小限制，已省略]'},
  ]);

  // 上游工具返回的 isError 保留并按 4000 字截断
  nextResult = {isError:true,content:[{type:'text',text:'E'.repeat(5000)}]};
  const upstreamErr = await call('call_tool',driverArgs('click',{x:1,y:2}));
  assert.equal(upstreamErr.result.isError,true);
  assert.equal(upstreamErr.result.content[0].text.length,4000);

  // RPC 传输异常脱敏为 device_operation_failed，不泄露内部异常消息
  nextThrow = new Error('internal socket stack trace secret_path');
  const rpcErr = await call('space_bash',{space,command:'pwd'});
  assert.equal(rpcErr.error.data.reason,'device_operation_failed');
  assert.ok(!JSON.stringify(rpcErr).includes('secret_path'));
});
