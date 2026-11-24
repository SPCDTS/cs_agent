import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
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
        result = {tools:['list_spaces','list_tools','fixture_hello'].map(name => ({name,inputSchema:{type:'object'}}))};
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
      assert.ok(calls.includes(upA + '/tools/list'));
      const spaces = await ws.rpc(b,'tools/call',{name:'list_spaces',arguments:{}});
      assert.deepEqual(JSON.parse(spaces.result.content[0].text), [{id:'relay:fixture01',name:'fixture',os:'linux'}]);
      assert.ok(calls.includes(upB + '/tools/call'));
      const before = calls.length;
      assert.ok((await ws.rpc(a,'tools/call',{name:'fixture_hello',arguments:{}})).error);
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
