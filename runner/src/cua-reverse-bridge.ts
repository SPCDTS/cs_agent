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
const deviceId = /^(?:relay:[a-z0-9][a-z0-9-]{6,62}[a-z0-9]|direct:(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5})$/;
const spaceProperty = {type:'string' as const,pattern:deviceId.source,maxLength:256,description:'设备卡上的完整 ID'};
const maxScreenshotDimension = 768;
const maxScreenshotBytes = 3 * 1024 * 1024;
const frameKeys = ['x','y','width','height'] as const;
const positionSchema = {type:'integer',minimum:-32768,maximum:32767};
const sizeSchema = {type:'integer',minimum:1,maximum:32767};
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
    name:'space_bash', description:'在选定设备运行 hostname，读取系统主机名。',
    inputSchema:{type:'object',properties:{space:spaceProperty,command:{type:'string',enum:['hostname']}},
      required:['space','command'],additionalProperties:false}, annotations:{readOnlyHint:true},
  },
  call_tool: {
    name:'call_tool', description:'用 list_windows 查询窗口，按 PID 和窗口 ID 用 set_window_frame 调整位置与大小。macOS 提供 get_window_state 截图与 bring_to_front 前置窗口，前置也可能带起同一应用的其他窗口。',
    inputSchema:{type:'object',properties:{
      space:spaceProperty, service:{type:'string',enum:['driver']}, tool:{type:'string',enum:['list_windows','get_window_state','bring_to_front','set_window_frame']},
      arguments:{type:'object',properties:{app:{type:'string',minLength:1,maxLength:128},pid:{type:'integer',minimum:1,maximum:0x7fffffff},
        window_id:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},x:positionSchema,y:positionSchema,width:sizeSchema,height:sizeSchema},additionalProperties:false},
    },required:['space','service','tool','arguments'],additionalProperties:false},annotations:{readOnlyHint:false},
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

function validToolArgs(name: string, args: Record<string, unknown>): boolean {
  const keys = Object.keys(args);
  if (name === 'list_spaces') return keys.length === 0;
  if (typeof args.space !== 'string' || !args.space || args.space.length > 256) return false;
  switch (name) {
    case 'space_bash': return keys.length === 2 && args.command === 'hostname';
    case 'call_tool': {
      const input = args.arguments;
      if (keys.length !== 4 || args.service !== 'driver' || !isRecord(input)) return false;
      if (args.tool === 'get_window_state' || args.tool === 'bring_to_front')
        return Object.keys(input).length === 2 && positiveInteger(input.pid,0x7fffffff) && positiveInteger(input.window_id,0xffffffff);
      if (args.tool === 'set_window_frame')
        return Object.keys(input).length === 6 && positiveInteger(input.pid,0x7fffffff) && positiveInteger(input.window_id,Number.MAX_SAFE_INTEGER)
          && frameKeys.every(key => Number.isSafeInteger(input[key]) && (input[key] as number) >= (key === 'x' || key === 'y' ? -32768 : 1)
            && (input[key] as number) <= 32767);
      return args.tool === 'list_windows' && Object.keys(input).every(key => key === 'app' || key === 'pid')
        && (input.pid === undefined || positiveInteger(input.pid,0x7fffffff))
        && (input.app === undefined || typeof input.app === 'string' && !!input.app.trim() && input.app.length <= 128);
    }
    case 'list_tools':
      return keys.every(k => ['space','service','name'].includes(k)) && args.service === 'driver'
        && (args.name === undefined || typeof args.name === 'string' && args.name.length <= 128);
    default: return false;
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

function hostnameResult(result: CallToolResult): CallToolResult {
  const block = result.content[0];
  const match = result.content.length === 1 && block?.type === 'text' && block.text.length <= 265
    && /^([^\r\n]+)\r?\n\[exit 0\]$/.exec(block.text);
  const hostname = match && match[0] === block.text && match[1];
  if (!hostname || hostname.length > 253 || !hostname.replace(/\.$/,'').split('.').every(
    label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new McpError(ErrorCode.InternalError,'设备未返回有效主机名。',{reason:'hostname_unavailable'});
  }
  return {content:[{type:'text',text:hostname}]};
}

function screenshotUnavailable() {
  return new McpError(ErrorCode.InternalError,'无法确认目标窗口或获取其截图。',{reason:'window_screenshot_unavailable'});
}

function windowChangeUnverified() {
  return new McpError(ErrorCode.InternalError,'无法确认所选窗口或操作结果。',{reason:'window_change_unverified'});
}

function selectedWindow(result: CallToolResult, pid: number, windowId: number) {
  const windows = result.structuredContent?.windows;
  if (!Array.isArray(windows) || windows.length > 1024) throw windowChangeUnverified();
  const matches = windows.filter((row:unknown) => isRecord(row) && row.window_id === windowId);
  if (matches.length !== 1 || matches[0].pid !== pid || matches[0].layer !== 0) throw windowChangeUnverified();
  return matches[0] as Record<string,unknown>;
}

function windowImage(result: CallToolResult, pid: number, windowId: number) {
  const meta = result.structuredContent;
  const images = result.content.filter(part => part.type === 'image');
  const image = images[0];
  if (meta?.pid !== pid || meta.window_id !== windowId || meta.screenshot_frame_valid !== true
      || !positiveInteger(meta.screenshot_width,maxScreenshotDimension) || !positiveInteger(meta.screenshot_height,maxScreenshotDimension)
      || images.length !== 1 || image?.mimeType !== 'image/png' || image.data.length > 4 * Math.ceil(maxScreenshotBytes / 3))
    throw screenshotUnavailable();
  const png = Buffer.from(image.data,'base64');
  // 对照实际 PNG 的 IHDR 和 IEND，防止伪报尺寸或无效 base64 穿过桥接层。
  if (png.length < 45 || png.length > maxScreenshotBytes || png.toString('base64') !== image.data
      || png.readBigUInt64BE(0) !== 0x89504e470d0a1a0an || png.readUInt32BE(8) !== 13 || png.toString('ascii',12,16) !== 'IHDR'
      || png.readUInt32BE(16) !== meta.screenshot_width || png.readUInt32BE(20) !== meta.screenshot_height
      || png.subarray(-12).toString('hex') !== '0000000049454e44ae426082') throw screenshotUnavailable();
  return {type:'image' as const, mimeType:'image/png', data:image.data};
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
      const args = params.arguments ?? {};
      if (!validToolArgs(params.name, args)) throw new McpError(ErrorCode.InvalidParams,'不支持此设备操作或参数。');
      const cards = spaceCards(await this.readDirectory('list_spaces',{},signal));
      if (params.name === 'list_spaces') return {content:[{type:'text',text:JSON.stringify(cards)}]};

      // Cua 还接受裸名称、URL 和未登记的地址。只使用本次目录中的唯一规范 ID。
      const space = args.space as string, matching = cards.filter(card => card.id === space);
      if (!deviceId.test(space) || !matching.length)
        throw new McpError(ErrorCode.InvalidParams,'未登记此设备 ID，请使用 list_spaces 返回的完整 ID。',{reason:'space_not_registered'});
      if (matching.length > 1)
        throw new McpError(ErrorCode.InternalError,'Cua 目录中此设备 ID 出现多次，无法确认目标。',{reason:'space_ambiguous'});
      if (params.name === 'space_bash')
        return hostnameResult(await this.call('space_bash',{space,command:'hostname',timeout:5},signal));
      if (params.name === 'call_tool') {
        const os = matching[0]!.os;
        if (args.tool === 'get_window_state' && os !== 'macos')
          throw new McpError(ErrorCode.InvalidParams,'此设备尚未提供经验证的精确窗口截图。',{reason:'window_screenshot_unsupported'});
        if (args.tool === 'bring_to_front' && os !== 'macos')
          throw new McpError(ErrorCode.InvalidParams,'此设备的 Driver 无法按 PID 验证要前置的窗口。',{reason:'window_change_unsupported'});
        if (os !== 'macos' && os !== 'windows')
          throw new McpError(ErrorCode.InvalidParams,'此设备不支持窗口查询。',{reason:'window_list_unsupported'});
        const input = args.arguments as Record<string,unknown>;
        if (os === 'macos' && input.window_id !== undefined && !positiveInteger(input.window_id,0xffffffff))
          throw new McpError(ErrorCode.InvalidParams,'窗口 ID 超出 macOS 的范围。');
        return this.windowTool(os,space,args.tool as string,input,signal);
      }
      const directory = driverDirectory(await this.readDirectory('list_tools',args,signal));
      return {content:[{type:'text',text:JSON.stringify(directory)}]};
    });
  }

  private async windowTool(os: 'macos'|'windows', space: string, name: string, input: Record<string,unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const {tools} = driverDirectory(await this.readDirectory('list_tools',{space,service:'driver',name:'window'},signal));
    const supports = (name: string, keys: string[]) => {
      const matches = tools.filter(tool => tool.name === name);
      const properties = matches[0]?.inputSchema?.properties;
      return matches.length === 1 && isRecord(properties) && keys.every(key => Object.hasOwn(properties,key));
    };
    const callDriver = (tool: string, args: Record<string,unknown>) =>
      this.call('call_tool',{space,service:'driver',tool,arguments:args},signal);
    if (name === 'list_windows') {
      if (!supports('list_windows',Object.keys(input))) throw new McpError(ErrorCode.InvalidParams,'设备不支持该窗口查询。');
      const {windows} = (await callDriver(name,input)).structuredContent ?? {};
      if (!Array.isArray(windows) || windows.length > 1024) throw invalidDirectory();
      const maxWindowId = os === 'windows' ? Number.MAX_SAFE_INTEGER : 0xffffffff;
      const rows = windows.map(row => {
        if (!isRecord(row) || !positiveInteger(row.pid,0x7fffffff) || !positiveInteger(row.window_id,maxWindowId)
            || (input.pid !== undefined && row.pid !== input.pid)) throw invalidDirectory();
        const title = typeof row.title === 'string' ? row.title.slice(0,128) : '';
        return {pid:row.pid,window_id:row.window_id,title};
      });
      return {content:[{type:'text',text:JSON.stringify({windows:rows})}]};
    }
    const pid = input.pid as number, windowId = input.window_id as number;
    if (name === 'bring_to_front' || name === 'set_window_frame') {
      // Cua 的 name 只匹配工具名子串；bring_to_front 不在 window 目录中。
      if (name === 'bring_to_front') {
        const focus = driverDirectory(await this.readDirectory('list_tools',{space,service:'driver',name},signal));
        tools.push(...focus.tools);
      }
      if (!supports(name,Object.keys(input)) || !supports('list_windows',['pid']))
        throw new McpError(ErrorCode.InvalidParams,'当前设备的 Driver 缺少此窗口操作。',{reason:'window_change_unsupported'});
      const checkTarget = async () => selectedWindow(await callDriver('list_windows',{pid}),pid,windowId);
      await checkTarget();
      const report = (await callDriver(name,input)).structuredContent;
      if (name === 'bring_to_front') {
        const effect = report?.exact_window_effect, observed = report?.observed;
        if (report?.code !== 'bring_to_front_exact_window_verified' || report.status !== 'activated' || report.activated !== true
            || report.pid !== pid || report.window_id !== windowId || report.process_activated !== true
            || !isRecord(effect) || effect.verified !== true || effect.focused !== true || effect.front_in_process_on_display !== true
            || !isRecord(observed) || observed.frontmost_pid !== pid || observed.focused_window_id !== windowId
            || observed.process_front_window_on_display !== windowId) throw windowChangeUnverified();
        await checkTarget();
        return {content:[{type:'text',text:JSON.stringify({pid,window_id:windowId,activated:true})}]};
      }
      if (report?.effect !== 'confirmed' || !Array.isArray(report.evidence) || !report.evidence.some(
        (item:unknown) => isRecord(item) && item.kind === 'value_readback')) throw windowChangeUnverified();
      const {bounds} = await checkTarget();
      // WindowServer 的原生核验容许每项最多两个点的误差；Windows 的 DWM 读回要求逐项相等。
      const tolerance = os === 'macos' ? 2 : 0;
      if (!isRecord(bounds) || !frameKeys.every(key => typeof bounds[key] === 'number' && Number.isFinite(bounds[key])
        && ((key !== 'width' && key !== 'height') || bounds[key] > 0)
        && Math.abs(bounds[key] - (input[key] as number)) <= tolerance)) throw windowChangeUnverified();
      const {x,y,width,height} = input;
      return {content:[{type:'text',text:JSON.stringify({pid,window_id:windowId,frame:{x,y,width,height}})}]};
    }
    const capture = {pid,window_id:windowId,include_accessibility_tree:false,include_screenshot:true,
      display_only:true,screenshot_format:'png',max_dimension:maxScreenshotDimension};
    if (!supports('get_window_state',Object.keys(capture)) || !supports('list_windows',['pid']))
      throw new McpError(ErrorCode.InvalidParams,'设备的 Driver 缺少精确窗口截图支持。',{reason:'window_screenshot_unsupported'});
    const image = windowImage(await callDriver('get_window_state',capture),pid,windowId);
    // Driver 拍摄前已检查窗口归属；拍摄期间退出或易主时，也须丢弃图像。
    const {windows} = (await callDriver('list_windows',{pid})).structuredContent ?? {};
    if (!Array.isArray(windows) || windows.filter(w => isRecord(w) && w.pid === pid && w.window_id === windowId).length !== 1)
      throw screenshotUnavailable();
    return {content:[image]};
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
