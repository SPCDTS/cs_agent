import { createServer, type IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type, type Static, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { ServerConfig } from './domain.ts';
import { EnvIdSchema, environmentCaller, allowsEnvironment, type EnvironmentCaller } from './environment-access.ts';
import { EnvironmentStatusSchema } from './environment-status.ts';
import { Jobs } from './jobs.ts';
const uuid = Type.String({ pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' });
const timeout = Type.Optional(Type.Integer({ minimum: 1000, maximum: 1200000, description: '含排队在内的任务期限，毫秒。默认 120000。' }));
const shell = { requestId: uuid, script: Type.String({ minLength: 1, maxLength: 65536 }), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: '来宾中的目录，相对路径基于该环境工作目录。' })), timeoutMs: timeout };
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const receiptSchema = object({ requestId: uuid, jobId: uuid, sessionId: Type.Optional(uuid), deadline: Type.Number(), state: Type.Union(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'unknown'].map(x => Type.Literal(x))), result: Type.Optional(object({ exitCode: Type.Integer(), stdout: Type.String(), stderr: Type.String(), truncated: Type.Boolean() })), error: Type.Optional(Type.String()), details: Type.Union([Type.Literal('retained'), Type.Literal('archived')]), resultSummary: Type.Optional(object({ exitCode: Type.Integer(), truncated: Type.Boolean() })) });
interface Registered { tool: Tool; call(args: unknown, caller: EnvironmentCaller): Promise<CallToolResult> }
const result = (value: object): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { ...value } });
export function toolCatalog(config: ServerConfig, jobs: Jobs): Registered[] {
  const registered: Registered[] = [];
  function add<T extends TSchema>(name: string, description: string, schema: T, outputSchema: TSchema, readOnly: boolean, fn: (args: Static<T>, caller: EnvironmentCaller) => CallToolResult | Promise<CallToolResult>) {
    registered.push({ tool: { name, description, inputSchema: schema as Tool['inputSchema'], outputSchema: outputSchema as Tool['outputSchema'], annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: true } },
      async call(args, caller) { if (!Check(schema, args)) throw new Error('invalid_arguments'); return fn(args, caller); } });
  }
  const environment = { envId: EnvIdSchema };
  function targetFor(caller: EnvironmentCaller, envId: string) {
    if (!allowsEnvironment(caller.environments, envId)) throw new Error('environment_denied');
    const target = config.targets.find(target => target.id === envId);
    if (!target) throw new Error('environment_not_found');
    return target;
  }
  add('env_list', '列出当前调用身份可用的环境。不探测或启动环境；返回 envId、持久/临时类型、工作目录和用途。先选择环境，再调用其他 env 工具。', object({}), object({ environments: Type.Array(object({
    envId: EnvIdSchema, kind: Type.Union([Type.Literal('persistent'), Type.Literal('sandbox')]), workdir: Type.String(), instructions: Type.String(),
  })) }), true, (_args, caller) => result({ environments: config.targets.filter(target => allowsEnvironment(caller.environments, target.id)).map(target => ({
    envId: target.id, kind: target.kind === 'hyperv' ? 'persistent' : 'sandbox', workdir: target.kind === 'hyperv' ? target.guestWorkdir : 'C:\\AgentWork', instructions: target.instructions ?? '',
  })) }));
  add('env_submit', '在 envId 指定的环境执行 PowerShell。持久环境保留磁盘和软件；临时 sandbox 的文件在关闭或到期后都不持久保存。先 env_list 查看用途。requestId(UUID) 和原参数在重试时必须保持一致；返回收据后用 env_job_get 查询，unknown 禁止另起同一命令。sandbox 首次省略 sessionId，后续沿用；持久环境不能传 sessionId。', object({ ...environment, ...shell, sessionId: Type.Optional(uuid) }), receiptSchema, false,
    (args, caller) => result(jobs.submit(caller.subject, targetFor(caller, args.envId), args.requestId, { kind: 'powershell', script: args.script, cwd: args.cwd, timeoutMs: args.timeoutMs ?? 120000 }, args.sessionId)));
  add('env_status', '独立只读环境状态，不进入执行队列、不创建或启动 VM/sandbox。返回就绪状态、助手版本、当前身份的任务队列和账本容量。数据库容量为匿名全局指标，不包含其他任务或文件路径。', object(environment), EnvironmentStatusSchema, true,
    async (args, caller) => result(await jobs.status(caller.subject, targetFor(caller, args.envId))));
  add('env_job_get', '查询同一 envId、调用身份下的 requestId。unknown 表示执行结果不确定，应继续查询或取消；details=archived 表示正文已归档，仍保留去重和退出摘要，不得重新执行旧请求。', object({ ...environment, requestId: uuid }), receiptSchema, true,
    (args, caller) => result(jobs.get(caller.subject, targetFor(caller, args.envId), args.requestId)));
  add('env_job_cancel', '取消当前身份在指定环境中的任务；持久环境只终止对应进程，临时 sandbox 的活跃任务取消会关闭整个 session。持续查询直到确认停止。', object({ ...environment, requestId: uuid }), receiptSchema, false,
    (args, caller) => result(jobs.cancel(caller.subject, targetFor(caller, args.envId), args.requestId)));
  add('env_close', '关闭临时 sandbox session，销毁其中的文件；返回 closing 时继续查询关闭结果。持久环境不支持关闭。', object({ ...environment, sessionId: uuid }), object({ sessionId: uuid, state: Type.Union([Type.Literal('closing'), Type.Literal('closed')]) }), false,
    (args, caller) => {
      const target = targetFor(caller, args.envId);
      if (target.kind !== 'wsb') throw new Error('persistent_environment_cannot_close');
      return result(jobs.close(caller.subject, target, args.sessionId));
    });
  return registered;
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const data of req) { const bytes = Buffer.from(data); size += bytes.length; if (size > 512 * 1024) throw new Error('body_too_large'); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export function createMcpHttpServer(config: ServerConfig, jobs: Jobs, env: NodeJS.ProcessEnv = process.env) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const principals = config.principals.map(p => {
    const token = env[p.tokenEnv]; if (!token || token.length < 32) throw new Error('missing_or_short_bearer_token');
    return { id: p.id, digest: digest('Bearer ' + token) };
  });
  if (new Set(principals.map(p => p.digest.toString('hex'))).size !== principals.length) throw new Error('duplicate_bearer_token');
  const catalog = toolCatalog(config, jobs);
  return createServer(async (req, res) => {
    const expected = digest(req.headers.authorization ?? '');
    const principal = principals.find(p => timingSafeEqual(p.digest, expected));
    if (!principal) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' }).end(); return; }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '') || req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
    const server = new Server({ name: 'cs-agent-windows', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Hyper-V 提供持久工作区，WSB 提供临时隔离环境。按工具说明选择，命令均在来宾执行。先 env_list 选择当前可用环境；长操作通过 env_submit / env_job_get / env_job_cancel 管理。不要把 HTTP 断线视为执行失败。桌面操作请连接 VM 内独立的桌面 MCP 服务。' });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.map(t => t.tool) }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const tool = catalog.find(t => t.tool.name === request.params.name); if (!tool) throw new Error('tool_not_found');
        return await tool.call(request.params.arguments ?? {}, environmentCaller(principal.id, request.params._meta));
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
