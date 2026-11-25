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
const requestBytes = 700 * 1024;
const maxImageBytes = 4 * 1024 * 1024;
const maxErrorTextLength = 4000;
const sessionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const deviceId = /^(?:relay:[a-z0-9][a-z0-9-]{6,62}[a-z0-9]|direct:(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5})$/;
const jobIdPattern = /^[A-Za-z0-9._-]{1,128}$/;
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const driverToolPattern = /^[a-zA-Z0-9_.-]{1,128}$/;
const spaceProperty = {type:'string' as const,pattern:deviceId.source,maxLength:256,description:'设备卡上的完整 ID'};
const untilSchema = {
  type:'object',
  description:'等待条件（start 时与 command 二选一互斥；以下条件字段四选一）。',
  properties:{
    file:{type:'string',minLength:1,maxLength:4096},
    port:{type:'integer',minimum:1,maximum:65535},
    host:{type:'string',minLength:1,maxLength:253,description:'仅与 port 配合使用，默认 127.0.0.1。'},
    command:{type:'string',minLength:1,maxLength:32768},
    pr_checks:{type:'string',minLength:1,maxLength:256},
    interval:{type:'integer',minimum:1,maximum:300},
  },
  additionalProperties:false,
};
const bridgeTools: Record<string,Tool> = {
  list_spaces: {
    name:'list_spaces', description:'列出此会话可见的设备卡，返回设备名称、完整 ID、系统与状态。',
    inputSchema:{type:'object', properties:{}, additionalProperties:false}, annotations:{readOnlyHint:true},
  },
  list_tools: {
    name:'list_tools', description:'查询选定设备的 Driver 工具清单。用 name 按名称片段筛选并读取匹配工具的参数契约。',
    inputSchema:{type:'object', properties:{
      space:spaceProperty,
      service:{type:'string',enum:['driver']}, name:{type:'string',maxLength:128},
    }, required:['space','service'], additionalProperties:false}, annotations:{readOnlyHint:true},
  },
  space_bash: {
    name:'space_bash', description:'在选定设备执行短暂的 Shell 命令（Linux/macOS 走 /bin/sh -c，Windows 走 cmd.exe /C）。默认超时 30 秒，最长 50 秒；长任务请改用 space_job。',
    inputSchema:{type:'object',properties:{
      space:spaceProperty,
      command:{type:'string',minLength:1,maxLength:32768},
      timeout:{type:'integer',minimum:1,maximum:50,description:'超时秒数，默认 30，最长 50。'},
    },required:['space','command'],additionalProperties:false}, annotations:{readOnlyHint:false},
  },
  space_job: {
    name:'space_job', description:'在 Linux 或 macOS 设备后台运行长耗时命令（start/status/logs/cancel/list）；不支持 Windows。',
    inputSchema:{type:'object',properties:{
      space:spaceProperty,
      action:{type:'string',enum:['start','status','logs','cancel','list']},
      command:{type:'string',minLength:1,maxLength:32768},
      job:{type:'string',minLength:1,maxLength:128,pattern:jobIdPattern.source},
      name:{type:'string',minLength:1,maxLength:80},
      cwd:{type:'string',minLength:1,maxLength:4096},
      env:{
        type:'object',
        maxProperties:64,
        propertyNames:{type:'string',pattern:envKeyPattern.source},
        additionalProperties:{type:'string',maxLength:4096},
      },
      timeout:{type:'integer',minimum:1,maximum:86400},
      until:untilSchema,
      offset:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},
      limit:{type:'integer',minimum:1,maximum:262144},
      follow_ms:{type:'integer',minimum:0,maximum:25000},
    },required:['space','action'],additionalProperties:false}, annotations:{readOnlyHint:false},
  },
  space_write: {
    name:'space_write', description:'向选定设备上的指定绝对路径写入文本内容（自动创建缺失父目录并覆盖目标文件）。',
    inputSchema:{type:'object',properties:{
      space:spaceProperty,
      path:{type:'string',minLength:1,maxLength:4096},
      content:{type:'string',maxLength:262144},
    },required:['space','path','content'],additionalProperties:false}, annotations:{readOnlyHint:false},
  },
  call_tool: {
    name:'call_tool', description:'调用选定设备上 Driver 服务（service="driver"）的工具；先用 list_tools 查询可用工具名与 arguments 参数结构。',
    inputSchema:{type:'object',properties:{
      space:spaceProperty,
      service:{type:'string',enum:['driver']},
      tool:{type:'string',minLength:1,maxLength:128,pattern:driverToolPattern.source},
      arguments:{type:'object',additionalProperties:true},
    },required:['space','service','tool'],additionalProperties:false}, annotations:{readOnlyHint:false},
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

function nonEmptyText(value: unknown, maxLength: number, rejectNull = true): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength && (!rejectNull || !value.includes('\0'));
}

function validUntil(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return;
  const keys = Object.keys(value);
  if (!keys.every(k => ['file', 'port', 'host', 'command', 'pr_checks', 'interval'].includes(k))) return;
  const conds = ['file', 'port', 'command', 'pr_checks'].filter(k => value[k] !== undefined);
  if (conds.length !== 1) return;
  if (value.file !== undefined && !nonEmptyText(value.file, 4096)) return;
  if (value.port !== undefined && !positiveInteger(value.port, 65535)) return;
  if (value.command !== undefined && !nonEmptyText(value.command, 32768)) return;
  if (value.pr_checks !== undefined && !nonEmptyText(value.pr_checks, 256)) return;
  if (value.host !== undefined && (value.port === undefined || !nonEmptyText(value.host, 253) || /\s/.test(value.host))) return;
  if (value.interval !== undefined && !positiveInteger(value.interval, 300)) return;
  return {
    ...(value.file !== undefined ? { file: value.file } : {}),
    ...(value.port !== undefined ? { port: value.port } : {}),
    ...(value.host !== undefined ? { host: value.host } : {}),
    ...(value.command !== undefined ? { command: value.command } : {}),
    ...(value.pr_checks !== undefined ? { pr_checks: value.pr_checks } : {}),
    ...(value.interval !== undefined ? { interval: value.interval } : {}),
  };
}

function parseJobArgs(space: string, args: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const action = args.action;
  if (action === 'list') return keys.length === 2 ? { space, action } : undefined;
  if (action === 'status' || action === 'cancel') {
    if (keys.length !== 3 || typeof args.job !== 'string' || !jobIdPattern.test(args.job)) return;
    return { space, action, job: args.job };
  }
  if (action === 'logs') {
    if (!keys.every(k => ['space', 'action', 'job', 'offset', 'limit', 'follow_ms'].includes(k))) return;
    if (typeof args.job !== 'string' || !jobIdPattern.test(args.job)) return;
    if (args.offset !== undefined && (typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0)) return;
    if (args.limit !== undefined && !positiveInteger(args.limit, 262144)) return;
    if (args.follow_ms !== undefined && (typeof args.follow_ms !== 'number' || !Number.isSafeInteger(args.follow_ms) || args.follow_ms < 0 || args.follow_ms > 25000)) return;
    return {
      space,
      action,
      job: args.job,
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.follow_ms !== undefined ? { follow_ms: args.follow_ms } : {}),
    };
  }
  if (action !== 'start') return;
  if (!keys.every(k => ['space', 'action', 'command', 'name', 'cwd', 'env', 'timeout', 'until'].includes(k))) return;
  if ((args.command !== undefined) === (args.until !== undefined)) return;
  if (args.command !== undefined && !nonEmptyText(args.command, 32768)) return;
  const until = args.until !== undefined ? validUntil(args.until) : undefined;
  if (args.until !== undefined && !until) return;
  if (args.name !== undefined && (!nonEmptyText(args.name, 80) || /[\r\n]/.test(args.name))) return;
  if (args.cwd !== undefined && !nonEmptyText(args.cwd, 4096)) return;
  if (args.timeout !== undefined && !positiveInteger(args.timeout, 86400)) return;
  if (args.env !== undefined) {
    if (!isRecord(args.env) || Object.keys(args.env).length > 64) return;
    for (const [k, v] of Object.entries(args.env)) {
      if (!envKeyPattern.test(k) || typeof v !== 'string' || v.length > 4096 || v.includes('\0')) return;
    }
  }
  return {
    space,
    action,
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.env !== undefined ? { env: args.env } : {}),
    ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
  };
}

function parseToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = Object.keys(args);
  if (name === 'list_spaces') return keys.length === 0 ? {} : undefined;
  if (typeof args.space !== 'string' || !args.space || args.space.length > 256) return;
  const space = args.space;
  switch (name) {
    case 'list_tools':
      if (!keys.every(k => k === 'space' || k === 'service' || k === 'name') || args.service !== 'driver') return;
      if (args.name !== undefined && (typeof args.name !== 'string' || args.name.length > 128)) return;
      return { space, service: 'driver', ...(args.name !== undefined ? { name: args.name } : {}) };
    case 'space_bash':
      if (!keys.every(k => k === 'space' || k === 'command' || k === 'timeout') || !nonEmptyText(args.command, 32768)) return;
      if (args.timeout !== undefined && !positiveInteger(args.timeout, 50)) return;
      return { space, command: args.command, timeout: typeof args.timeout === 'number' ? args.timeout : 30 };
    case 'space_job':
      return parseJobArgs(space, args, keys);
    case 'space_write':
      if (keys.length !== 3 || !nonEmptyText(args.path, 4096) || typeof args.content !== 'string'
          || args.content.length > 262144 || Buffer.byteLength(args.content, 'utf8') > 256 * 1024) return;
      return { space, path: args.path, content: args.content };
    case 'call_tool':
      if (!keys.every(k => ['space', 'service', 'tool', 'arguments'].includes(k)) || args.service !== 'driver') return;
      if (typeof args.tool !== 'string' || !driverToolPattern.test(args.tool)) return;
      if (args.arguments !== undefined && !isRecord(args.arguments)) return;
      return { space, service: 'driver', tool: args.tool, arguments: isRecord(args.arguments) ? args.arguments : {} };
    default:
      return;
  }
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
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

function detectedImageMime(raw: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  if (raw.length >= 33 && raw.readBigUInt64BE(0) === 0x89504e470d0a1a0an && raw.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return 'image/jpeg';
  if (raw.length >= 6) {
    const gif = raw.toString('ascii', 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (raw.length >= 12 && raw.toString('ascii', 0, 4) === 'RIFF' && raw.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function validatedImage(data: unknown, mimeType: unknown) {
  if (typeof data !== 'string' || typeof mimeType !== 'string' || !data || data.length % 4 !== 0
      || data.length > 4 * Math.ceil(maxImageBytes / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
  const raw = Buffer.from(data, 'base64');
  if (!raw.length || raw.length > maxImageBytes || raw.toString('base64') !== data) return;
  const detected = detectedImageMime(raw);
  if (!detected || detected !== mimeType) return;
  return {type:'image' as const, mimeType:detected, data};
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
        return {nextCursor:page.nextCursor, tools:page.tools.filter(t => Object.hasOwn(bridgeTools,t.name)).map(t => bridgeTools[t.name]!)};
      } catch { throw new McpError(ErrorCode.InternalError, '无法读取 Cua 工具目录'); }
    });
    this.server.setRequestHandler(CallToolRequestSchema, async ({params}, {signal}) => {
      const normalized = parseToolArgs(params.name, params.arguments ?? {});
      if (!normalized) throw new McpError(ErrorCode.InvalidParams,'不支持此设备操作或参数。');
      const cards = spaceCards(await this.readDirectory('list_spaces',{},signal));
      if (params.name === 'list_spaces') return {content:[{type:'text',text:JSON.stringify(cards)}]};

      // Cua 还接受裸名称、URL 和未登记的地址。只使用本次目录中的唯一规范 ID。
      const space = normalized.space as string, matching = cards.filter(card => card.id === space);
      if (!deviceId.test(space) || !matching.length)
        throw new McpError(ErrorCode.InvalidParams,'未登记此设备 ID，请使用 list_spaces 返回的完整 ID。',{reason:'space_not_registered'});
      if (matching.length > 1)
        throw new McpError(ErrorCode.InternalError,'Cua 目录中此设备 ID 出现多次，无法确认目标。',{reason:'space_ambiguous'});
      if (params.name === 'list_tools') {
        const directory = driverDirectory(await this.readDirectory('list_tools', normalized, signal));
        return {content:[{type:'text',text:JSON.stringify(directory)}]};
      }
      return this.forwardOperation(params.name, normalized, signal);
    });
  }

  private async forwardOperation(name: string, upstreamArgs: Record<string,unknown>, signal: AbortSignal): Promise<CallToolResult> {
    let result: CallToolResult;
    try {
      result = await this.client.request({method:'tools/call',params:{name,arguments:upstreamArgs}},CallToolResultSchema,{signal});
    } catch {
      throw new McpError(ErrorCode.InternalError,'Cua 未能完成设备操作。',{reason:'device_operation_failed'});
    }
    if (result.isError) {
      const message = result.content
        .flatMap(part => part.type === 'text' ? [part.text] : [])
        .join('\n')
        .trim()
        .slice(0, maxErrorTextLength);
      return {isError:true, content:[{type:'text', text:message || 'Cua 设备操作返回错误。'}]};
    }
    const content: CallToolResult['content'] = [];
    let imageCount = 0;
    for (const part of result.content) {
      if (part.type === 'text') {
        content.push({type:'text', text:part.text});
      } else if (part.type === 'image') {
        const checked = imageCount < 4 ? validatedImage(part.data, part.mimeType) : undefined;
        if (checked) {
          imageCount++;
          content.push(checked);
        } else {
          content.push({type:'text', text:'[Cua 图片超出格式或大小限制，已省略]'});
        }
      } else if (part.type === 'resource') {
        content.push({type:'text', text:'text' in part.resource ? `[Cua 资源：${part.resource.uri}]\n${part.resource.text}` : '[Cua 二进制资源已省略]'});
      } else if (part.type === 'resource_link') {
        content.push({type:'text', text:`[Cua 链接，未访问] ${part.uri}`});
      } else if (part.type === 'audio') {
        content.push({type:'text', text:'[Cua 音频已省略]'});
      }
    }
    return {
      content,
      ...(isRecord(result.structuredContent) ? {structuredContent:result.structuredContent} : {}),
    };
  }

  private async call(name: string, args: Record<string,unknown>, signal: AbortSignal): Promise<CallToolResult> {
    try {
      const result = await this.client.request({method:'tools/call',params:{name,arguments:args}},CallToolResultSchema,{signal});
      if (!result.isError) return result;
    } catch { /* 上游报错可能包含窗口标题、设备路径或命令输出。 */ }
    const directory = name === 'list_spaces' || name === 'list_tools';
    throw new McpError(ErrorCode.InternalError,directory ? '无法读取 Cua 目录，请检查 Spaces 连接。' : 'Cua 未能完成设备操作。',
      {reason: directory ? 'directory_unavailable' : 'device_operation_failed'});
  }
  private async readDirectory(name: string, args: Record<string,unknown>, signal: AbortSignal): Promise<unknown> {
    const result = await this.call(name,args,signal);
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
