import { request } from 'node:http';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, CallToolResultSchema, ErrorCode, JSONRPCMessageSchema, ListToolsRequestSchema, ListToolsResultSchema, McpError, type CallToolResult, type JSONRPCMessage, type Tool } from '@modelcontextprotocol/sdk/types.js';

const localMcp = new URL('http://localhost/mcp');
const bytes = 12 * 1024 * 1024;
const frameBytes = bytes + 4096;
const requestBytes = 32 * 1024;
const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const deviceId = /^(?:relay:[a-z0-9-]{8,64}|direct:(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5})$/;
const directoryTools: Record<string,Tool> = {
  list_spaces: {
    name:'list_spaces', description:'列出此会话可见的设备卡，返回设备名称、完整 ID、系统与状态。',
    inputSchema:{type:'object', properties:{}, additionalProperties:false}, annotations:{readOnlyHint:true},
  },
  list_tools: {
    name:'list_tools', description:'查询选定设备的 Driver 工具清单。用 name 按名称片段筛选并读取匹配工具的参数契约。',
    inputSchema:{type:'object', properties:{
      space:{type:'string',pattern:deviceId.source,maxLength:256,description:'设备卡上的完整 ID'},
      service:{type:'string',enum:['driver']}, name:{type:'string',maxLength:128},
    }, required:['space','service'], additionalProperties:false}, annotations:{readOnlyHint:true},
  },
};
const methods = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping', 'tools/list', 'tools/call']);

export function registration(env: NodeJS.ProcessEnv) {
  const endpoint = URL.parse(env.REVERSE_MCP_URL ?? '');
  const token = env.REVERSE_MCP_TOKEN ?? '', socketPath = env.CUA_SOCKET_PATH ?? '';
  if (endpoint?.protocol !== 'wss:' || endpoint.pathname !== '/mcp/reverse/cua' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !/^[A-Za-z0-9._~-]{32,256}$/.test(token) || !posix.isAbsolute(socketPath)) {
    throw new Error('请配置 Cua 专用 WSS 注册地址、独立 Bearer 和本机 Unix socket 绝对路径。');
  }
  return {endpoint, token, socketPath};
}

/** SDK 管理会话头、Content-Type、JSON 及 SSE。代理只访问启动配置中的同一个本机 socket。 */
function localFetch(socketPath: string): FetchLike {
  return async (url, init = {}) => {
    if (String(url) !== localMcp.href) throw new Error('local_endpoint_required');
    // 发现服务不发布订阅通知；SDK 支持服务端拒绝独立 GET 事件流。
    if (init.method === 'GET') return new Response(null, {status:405});
    if (init.method !== 'POST' && init.method !== 'DELETE') throw new Error('local_method_denied');
    if (init.body != null && (typeof init.body !== 'string' || Buffer.byteLength(init.body) > requestBytes)) throw new Error('request_limit');
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(55_000)]) : AbortSignal.timeout(55_000);
    return new Promise<Response>((resolve, reject) => {
      const req = request({ socketPath, path:'/mcp', method:init.method, signal,
        headers:{...Object.fromEntries(new Headers(init.headers)), host:'localhost'} }, res => {
        const status = res.statusCode ?? 502;
        if (status < 200 || status >= 300) {
          res.destroy();
          resolve(new Response(null, {status: status >= 400 ? status : 502}));
          return;
        }
        const headers = new Headers();
        for (const key of ['content-type','mcp-session-id']) {
          const value = res.headers[key];
          if (typeof value === 'string') headers.set(key, value);
        }
        if (status === 204 || status === 205) {
          res.resume(); resolve(new Response(null,{status,headers})); return;
        }
        async function* limited() {
          let received = 0;
          try {
            for await (const chunk of res) {
              received += chunk.length;
              if (received > bytes) throw new Error('response_limit');
              yield chunk;
            }
          } finally { res.destroy(); }
        }
        resolve(new Response(Readable.toWeb(Readable.from(limited())) as ReadableStream<Uint8Array>, {status, headers}));
      });
      req.on('error', reject);
      req.end(init.body);
    });
  };
}

function discoveryArgs(name: string, args: Record<string, unknown>): boolean {
  if (name === 'list_spaces') return Object.keys(args).length === 0;
  return name === 'list_tools' && Object.keys(args).every(k => ['space','service','name'].includes(k))
    && typeof args.space === 'string' && args.space.length > 0 && args.space.length <= 256
    && args.service === 'driver' && (args.name === undefined || typeof args.name === 'string' && args.name.length <= 128);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDirectory() {
  return new McpError(ErrorCode.InternalError,'Cua 返回的目录格式无效。',{reason:'directory_invalid'});
}

function spaceCards(data: unknown) {
  if (!Array.isArray(data)) throw invalidDirectory();
  return data.map(row => {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string') throw invalidDirectory();
    const card: Record<string,string> = {id:row.id, name:row.name};
    for (const key of ['display_name','os','status','phase','power_state']) {
      if (row[key] === undefined) continue;
      if (typeof row[key] !== 'string') throw invalidDirectory();
      card[key] = row[key];
    }
    return card;
  });
}

function driverDirectory(data: unknown) {
  if (!isRecord(data) || data.service !== 'driver' || !Array.isArray(data.tools)) throw invalidDirectory();
  const tools = data.tools.map(row => {
    if (!isRecord(row) || typeof row.name !== 'string' || typeof row.description !== 'string') throw invalidDirectory();
    if (row.inputSchema !== undefined && !isRecord(row.inputSchema)) throw invalidDirectory();
    return {name:row.name, description:row.description, inputSchema:row.inputSchema};
  });
  return {service:'driver',services:['driver'],count:tools.length,tools};
}

class DirectorySession {
  readonly server = new Server({name:'cua-spaces',version:'1'}, {capabilities:{tools:{}}});
  readonly client = new Client({name:'cs-agent-cua-directory',version:'1'}, {capabilities:{}});
  readonly upstream: StreamableHTTPClientTransport;
  readonly controller = new AbortController();
  readonly transport: Transport;
  ready = false;
  done?: Promise<void>;

  constructor(socketPath: string, send: (reply: JSONRPCMessage) => void) {
    this.transport = { async start() {}, async close() { this.onclose?.(); }, async send(reply) { send(reply); } };
    this.upstream = new StreamableHTTPClientTransport(localMcp, {fetch:localFetch(socketPath),
      reconnectionOptions:{maxRetries:0, initialReconnectionDelay:0, maxReconnectionDelay:0, reconnectionDelayGrowFactor:1}});
    this.server.setRequestHandler(ListToolsRequestSchema, async (req, {signal}) => {
      try {
        const page = await this.client.request({method:'tools/list',params:{cursor:req.params?.cursor}}, ListToolsResultSchema,{signal});
        return {nextCursor:page.nextCursor, tools:page.tools.filter(t => Object.hasOwn(directoryTools,t.name)).map(t => directoryTools[t.name]!)};
      } catch { throw new McpError(ErrorCode.InternalError, '无法读取 Cua 工具目录'); }
    });
    this.server.setRequestHandler(CallToolRequestSchema, async ({params}, {signal}) => {
      const args = params.arguments ?? {};
      if (!discoveryArgs(params.name, args)) throw new McpError(ErrorCode.InvalidParams,'仅支持设备目录和指定设备的 Driver 工具目录。');
      const cards = spaceCards(await this.readDirectory('list_spaces',params.name === 'list_spaces' ? args : {},signal));
      let directory: unknown = cards;
      if (params.name === 'list_tools') {
        // Cua 自身也解析裸名称、URL 和未登记的 direct 地址。只把本次目录中的唯一规范 ID 交给它。
        const target = args.space as string;
        const matching = cards.filter(card => card.id === target);
        if (!deviceId.test(target) || !matching.length)
          throw new McpError(ErrorCode.InvalidParams,'未登记此设备 ID，请使用 list_spaces 返回的完整 ID。',{reason:'space_not_registered'});
        if (matching.length > 1)
          throw new McpError(ErrorCode.InternalError,'Cua 目录中此设备 ID 出现多次，无法确认目标。',{reason:'space_ambiguous'});
        directory = driverDirectory(await this.readDirectory('list_tools',args,signal));
      }
      return {content:[{type:'text',text:JSON.stringify(directory)}]};
    });
  }
  private async readDirectory(name: string, args: Record<string,unknown>, signal: AbortSignal): Promise<unknown> {
    let result: CallToolResult;
    try {
      result = await this.client.request({method:'tools/call',params:{name,arguments:args}},CallToolResultSchema,{signal});
      if (result.isError) throw new Error();
    } catch {
      throw new McpError(ErrorCode.InternalError,'无法读取 Cua 目录，请检查 Spaces 连接。',{reason:'directory_unavailable'});
    }
    const block = result.content[0];
    if (result.content.length !== 1 || block?.type !== 'text') throw invalidDirectory();
    try { return JSON.parse(block.text); } catch { throw invalidDirectory(); }
  }
  async start() {
    await this.client.connect(this.upstream, {signal:this.controller.signal,timeout:10_000});
    if (this.client.getServerVersion()?.name !== 'cua-spaces' || !this.client.getServerCapabilities()?.tools) throw new Error('wrong_local_server');
    this.controller.signal.throwIfAborted();
    await this.server.connect(this.transport);
    this.ready = true;
  }
  close() {
    if (this.done) return this.done;
    this.controller.abort();
    this.done = (async () => {
      await this.server.close().catch(() => {});
      const deadline = setTimeout(() => { void this.client.close().catch(() => {}); }, 2000);
      try { await this.upstream.terminateSession(); } catch { /* 断线后会话不能重用。 */ }
      finally { clearTimeout(deadline); await this.client.close().catch(() => {}); }
    })();
    return this.done;
  }
}

type Session = { directory: DirectorySession; request?: {id: string | number; timer: NodeJS.Timeout} };
export function serveConnection(socket: WebSocket, socketPath: string) {
  const sessions = new Map<string,Session>();
  let inFlight = 0, closed = false, pongDeadline: NodeJS.Timeout | undefined;
  function send(frame: object) {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(frame), size = Buffer.byteLength(data);
    if (size > frameBytes || socket.bufferedAmount + size > 2 * frameBytes) throw new Error('outbound_limit');
    socket.send(data);
  }
  function release(s: Session) {
    if (s.request) { clearTimeout(s.request.timer); s.request = undefined; inFlight--; }
  }
  function drop(id: string, notify: boolean) {
    const s = sessions.get(id);
    if (!s) return;
    // 保留关闭中的槽位，防止大量 initialize/close 导致任意多条本机会话同时关闭。
    release(s);
    if (notify && !s.directory.done) {
      try { send({session:id,close:true}); } catch { socket.close(4002,'backpressure'); }
    }
    void s.directory.close().finally(() => { if (sessions.get(id) === s) sessions.delete(id); });
  }
  async function receive(event: MessageEvent) {
    if (event.data === 'pong') { clearTimeout(pongDeadline); pongDeadline = undefined; return; }
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > requestBytes + 4096) throw new Error('invalid_frame');
    const frame = JSON.parse(event.data);
    if (!isRecord(frame) || typeof frame.session !== 'string' || !sessionId.test(frame.session)) throw new Error('invalid_session');
    const id = frame.session;
    if (frame.close === true && !('message' in frame)) { drop(id,false); return; }
    const parsed = JSONRPCMessageSchema.safeParse(frame.message);
    if (!parsed.success || !('method' in parsed.data)) { drop(id,true); return; }
    const msg = parsed.data;
    let s = sessions.get(id);
    if (!methods.has(msg.method)) {
      if ('id' in msg) send({session:id,message:{jsonrpc:'2.0',id:msg.id,error:{code:ErrorCode.MethodNotFound,message:'不提供此方法'}}});
      return;
    }
    if (s?.directory.done) return;
    if (!s && (msg.method !== 'initialize' || !('id' in msg) || sessions.size >= 16)) { send({session:id,close:true}); return; }
    if (s && (!s.directory.ready || msg.method === 'initialize')) { drop(id,true); return; }
    if (msg.method === 'notifications/cancelled') {
      // SDK 先通知本机取消，再终止该会话的 HTTP 请求，避免仍在等待的 SSE 占用连接。
      if (s?.request && s.request.id === msg.params?.requestId) {
        s.directory.transport.onmessage?.(msg);
        drop(id,true);
      }
      return;
    }
    if ('id' in msg && (s?.request || inFlight >= 4)) {
      send({session:id,message:{jsonrpc:'2.0',id:msg.id,error:{code:-32000,message:'目录查询繁忙'}}}); return;
    }
    const fresh = !s;
    if (!s) {
      const directory = new DirectorySession(socketPath, reply => {
        const active = sessions.get(id);
        if (active?.directory !== directory || active.directory.done || !('id' in reply) || reply.id !== active.request?.id) return;
        release(active);
        try { send({session:id,message:reply}); } catch { drop(id,true); }
      });
      s = {directory}; sessions.set(id,s);
    }
    if ('id' in msg) {
      s.request = {id:msg.id, timer:setTimeout(() => drop(id,true),60_000)};
      inFlight++;
    }
    try {
      if (fresh) await s.directory.start();
      if (!closed && !s.directory.done) s.directory.transport.onmessage?.(msg);
    } catch { drop(id,true); }
  }
  const heartbeat = setInterval(() => {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    socket.send('ping');
    if (!pongDeadline) pongDeadline = setTimeout(() => socket.close(4001,'heartbeat'),10_000);
  },30_000);
  const stop = () => {
    closed = true;
    clearInterval(heartbeat); clearTimeout(pongDeadline);
    return Promise.all([...sessions.entries()].map(([id,s]) => { drop(id,false); return s.directory.close(); }));
  };
  socket.addEventListener('close', () => { void stop(); }, {once:true});
  socket.addEventListener('message', event => { if (!closed) void receive(event).catch(() => socket.close(4002,'invalid frame')); });
  return stop;
}
