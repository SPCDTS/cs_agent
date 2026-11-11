import { createServer, type IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type, type Static, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import { CALLER_META_KEY, type Backend, type HypervTarget, type ServerConfig, type Subject } from './domain.ts';
import { Jobs } from './jobs.ts';
const uuid = Type.String({ pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' });
const timeout = Type.Optional(Type.Integer({ minimum: 1000, maximum: 1200000, description: '含排队在内的任务期限，毫秒。默认 120000。' }));
const shell = { requestId: uuid, script: Type.String({ minLength: 1, maxLength: 65536 }), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: '来宾中的目录，相对路径基于该环境工作目录。' })), timeoutMs: timeout };
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const receiptSchema = object({ requestId: uuid, jobId: uuid, sessionId: Type.Optional(uuid), deadline: Type.Number(), state: Type.Union(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'unknown'].map(x => Type.Literal(x))), result: Type.Optional(object({ exitCode: Type.Integer(), stdout: Type.String(), stderr: Type.String(), truncated: Type.Boolean() })), error: Type.Optional(Type.String()) });
const actionSchema = Type.Union([
  object({ kind: Type.Literal('click'), x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right')])) }),
  object({ kind: Type.Literal('scroll'), x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), delta: Type.Integer({ minimum: -1200, maximum: 1200, not: { const: 0 } }) }),
  object({ kind: Type.Literal('keys'), keys: Type.Array(Type.String({ minLength: 1, maxLength: 12, description: '修饰键、导航键、A–Z、0–9 或 F1–F24，具体支持由来宾验证。' }), { minItems: 1, maxItems: 6 }) }),
  object({ kind: Type.Literal('text'), text: Type.String({ minLength: 1, maxLength: 2048 }) }),
]);
interface Registered { tool: Tool; call(args: unknown, subject: Subject): Promise<CallToolResult> }
const result = (value: object): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { ...value } });
function subjectFor(principal: string, meta: unknown): Subject {
  if (meta === undefined) return { principal, scope: 'default' };
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('invalid_caller_metadata');
  const caller = Object.getOwnPropertyDescriptor(meta, CALLER_META_KEY)?.value as unknown;
  if (caller === undefined) return { principal, scope: 'default' };
  if (!Check(object({ scope: Type.String({ pattern: '^[a-f0-9]{64}$' }) }), caller)) throw new Error('invalid_caller_metadata');
  return { principal, scope: caller.scope };
}
export function toolCatalog(config: ServerConfig, jobs: Jobs, backends: Record<'hyperv' | 'wsb', Backend>): Registered[] {
  const registered: Registered[] = [];
  function add<T extends TSchema>(name: string, description: string, schema: T, outputSchema: TSchema, readOnly: boolean, fn: (args: Static<T>, subject: Subject) => CallToolResult | Promise<CallToolResult>) {
    registered.push({ tool: { name, description, inputSchema: schema as Tool['inputSchema'], outputSchema: outputSchema as Tool['outputSchema'], annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: true } },
      async call(args, subject) { if (!Check(schema, args)) throw new Error('invalid_arguments'); return fn(args, subject); } });
  }
  for (const target of config.targets) {
    const prefix = (target.kind === 'hyperv' ? 'vm_' : 'wsb_') + target.id;
    const guidance = target.kind === 'hyperv'
      ? '这是预先配置的 Hyper-V Windows 持久工作区；系统、安装的软件和文件保留在 VM 磁盘中。它适合受信任的开发操作，不是隔离恶意代码的临时沙箱。取消只终止本任务，不关闭或回滚 VM。'
      : '这是 Windows Sandbox 临时隔离环境；同一 sessionId 内文件可复用，关闭、取消活跃任务或到期会销毁实例及全部文件。C:\\AgentWork 和其他来宾目录都不持久保存；没有宿主项目或缓存映射。首次 submit 省略 sessionId，后续沿用返回的 ID。';
    const submitSchema = target.kind === 'wsb' ? object({ ...shell, sessionId: Type.Optional(uuid) }) : object(shell);
    add(prefix + '_submit', guidance + '\n' + (target.instructions ?? '') + '\n在来宾执行 PowerShell。先生成 requestId(UUID)，重试必须沿用它及原参数；立即返回任务收据，用 job_get 查询，unknown 禁止另起同一命令。HTTP 断线不取消任务。', submitSchema, receiptSchema, false, (args, subject) => result(jobs.submit(subject, target, args.requestId, { kind: 'powershell', script: args.script, cwd: args.cwd, timeoutMs: args.timeoutMs ?? 120000 }, 'sessionId' in args && typeof args.sessionId === 'string' ? args.sessionId : undefined)));
    add(prefix + '_job_get', '查询此前 requestId 的任务状态和输出。首次 WSB submit 丢失响应时用它找回 sessionId。unknown 表示不能确定副作用；继续查询或取消，不能自动重放。', object({ requestId: uuid }), receiptSchema, true, (args, subject) => result(jobs.get(subject, target, args.requestId)));
    add(prefix + '_job_cancel', '请求取消任务；只有确认原生进程或 WSB 实例停止后才返回 cancelled。WSB 活跃任务取消会关闭整个临时 session。请持续查询到停止确认。', object({ requestId: uuid }), receiptSchema, false, (args, subject) => result(jobs.cancel(subject, target, args.requestId)));
    if (target.kind === 'wsb') {
      add(prefix + '_close', '销毁临时 WSB session。首次返回 closing 时请继续调用直到 closed；关闭开始后不再接收该 session 的新命令。', object({ sessionId: uuid }), object({ sessionId: uuid, state: Type.Union([Type.Literal('closing'), Type.Literal('closed')]) }), false, (args, subject) => result(jobs.close(subject, target, args.sessionId)));
    } else if (target.desktopUser) {
      add(prefix + '_screen', '截取这台 VM 内已登录用户的桌面，返回图片与 frameId；不使用宿主显示器。锁屏、UAC 安全桌面或未登录时不可用。', object({}), object({ frameId: Type.String(), width: Type.Integer(), height: Type.Integer() }), true, async (_args, subject) => {
        const screen = backends.hyperv.screen; if (!screen) throw new Error('desktop_unavailable');
        const frame = await screen(target, subject);
        return { ...result({ frameId: frame.frameId, width: frame.width, height: frame.height }), content: [{ type: 'image', data: frame.data, mimeType: frame.mimeType }] };
      });
      add(prefix + '_input', '在最近一次 screen 的 frameId 对应来宾桌面输入。坐标为图片中的像素；只影响 VM。过期帧需要重新截图。提交后用 job_get 查询，不确定结果禁止重复输入。', object({ requestId: uuid, frameId: Type.String({ minLength: 1, maxLength: 256 }), action: actionSchema }), receiptSchema, false, (args, subject) => result(jobs.submit(subject, target, args.requestId, { kind: 'desktop', frameId: args.frameId, action: args.action, timeoutMs: 30000 })));
    }
  }
  return registered;
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const data of req) { const bytes = Buffer.from(data); size += bytes.length; if (size > 512 * 1024) throw new Error('body_too_large'); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export function createMcpHttpServer(config: ServerConfig, jobs: Jobs, backends: Record<'hyperv' | 'wsb', Backend>, env: NodeJS.ProcessEnv = process.env) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const principals = config.principals.map(p => {
    const token = env[p.tokenEnv]; if (!token || token.length < 32) throw new Error('missing_or_short_bearer_token');
    return { id: p.id, digest: digest('Bearer ' + token) };
  });
  if (new Set(principals.map(p => p.digest.toString('hex'))).size !== principals.length) throw new Error('duplicate_bearer_token');
  const catalog = toolCatalog(config, jobs, backends);
  const native = new Map<string, { tools: Registered[]; at: number; pending?: Promise<Registered[]> }>();
  async function desktopCatalog(target: HypervTarget, principal: string): Promise<Registered[]> {
    const key = JSON.stringify([target.id, principal]);
    let cached = native.get(key);
    if (cached?.pending) return cached.pending;
    if (cached && cached.at + 300_000 > Date.now()) return cached.tools;
    if (!cached) { cached = { tools: [], at: 0 }; native.set(key, cached); }
    const entry = cached;
    entry.pending = (async () => {
      try {
        const { desktopTools, desktopCall } = backends.hyperv;
        if (!desktopTools || !desktopCall) throw new Error('desktop_mcp_unavailable');
        const remote = await desktopTools(target, { principal, scope: 'catalog' });
        const seen = new Set<string>();
        const tools = remote.tools.map(tool => {
          const name = 'vm_' + target.id + '_' + tool.name;
          if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || seen.has(name) || catalog.some(row => row.tool.name === name)) throw new Error('desktop_mcp_invalid_catalog');
          seen.add(name);
          return { tool: { ...tool, name, description: '在 VM 的已登录交互桌面执行原生 MCP。首次使用先读取同前缀 desktop_skills_get 的 desktop 和 platform 指南；桌面引用按调用会话隔离。结果未知时禁止重放。\n' + (tool.description ?? '') + (tool.name === 'desktop_skills_get' && remote.instructions ? '\n原生 MCP 使用说明：\n' + remote.instructions : '') },
            call: async (args: unknown, subject: Subject) => {
              if (!Check(Type.Record(Type.String(), Type.Unknown()), args)) throw new Error('invalid_arguments');
              return desktopCall(target, subject, tool.name, args);
            } };
        });
        entry.tools = tools; entry.at = Date.now(); return tools;
      } catch { return entry.tools; }
    })().finally(() => { entry.pending = undefined; });
    return entry.pending;
  }
  const desktopTargets = config.targets.filter((target): target is HypervTarget => target.kind === 'hyperv' && !!target.desktopMcp);
  async function nativeTools(principal: string) { return (await Promise.all(desktopTargets.map(target => desktopCatalog(target, principal)))).flat(); }
  return createServer(async (req, res) => {
    const expected = digest(req.headers.authorization ?? '');
    const principal = principals.find(p => timingSafeEqual(p.digest, expected));
    if (!principal) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' }).end(); return; }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '') || req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
    const server = new Server({ name: 'cs-agent-windows', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Hyper-V 提供持久工作区，WSB 提供临时隔离环境。按工具说明选择，命令均在来宾执行。长操作通过 submit / job_get / job_cancel 管理。不要把 HTTP 断线视为执行失败。desktop_* 是已登录交互桌面中的原生 MCP 工具，与 submit 的后台 Session 0 不同。首次使用读取 desktop_skills_get 的 desktop/platform 指南。调用会话独立保存桌面引用，但同一 VM 的窗口、文件与焦点共享；截图和结构化结果按原生 MCP 返回。' });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...catalog, ...await nativeTools(principal.id)].map(t => t.tool) }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const tool = catalog.find(t => t.tool.name === request.params.name) ?? (await nativeTools(principal.id)).find(t => t.tool.name === request.params.name); if (!tool) throw new Error('tool_not_found');
        return await tool.call(request.params.arguments ?? {}, subjectFor(principal.id, request.params._meta));
      } catch (error) {
        const message = error instanceof Error && /^[a-z][a-z0-9_]{0,95}$/.test(error.message) ? error.message : 'operation_failed';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close().catch(() => undefined); void server.close().catch(() => undefined); });
    try { const parsed = await body(req); await server.connect(transport); await transport.handleRequest(req, res, parsed); }
    catch { if (!res.headersSent) res.writeHead(400).end(); }
  });
}
