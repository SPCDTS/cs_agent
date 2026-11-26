import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type, type Static, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { ServerConfig } from './domain.ts';
import { EnvIdSchema, environmentCaller, allowsEnvironment, type EnvironmentCaller } from './environment-access.ts';
import { EnvironmentStatusSchema } from './environment-status.ts';
import { Jobs } from './jobs.ts';
import { createLocalMcpHttpServer, multiBearerAuth } from './mcp-http.ts';
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
  // 输出 schema 纳入 Worker 工具名摘要，保留原契约以兼容已有 WSB 调用。
  add('env_list', '列出当前调用身份可用的临时 Windows Sandbox，返回 envId、工作目录和用途。', object({}), object({ environments: Type.Array(object({
    envId: EnvIdSchema, kind: Type.Union([Type.Literal('persistent'), Type.Literal('sandbox')]), workdir: Type.String(), instructions: Type.String(), drainOnly: Type.Optional(Type.Boolean()),
  })) }), true, (_args, caller) => result({ environments: config.targets.filter(target => allowsEnvironment(caller.environments, target.id)).map(target => ({
    envId: target.id, kind: 'sandbox', workdir: 'C:\\AgentWork', instructions: target.instructions ?? '',
  })) }));
  add('env_submit', '在 envId 指定的临时 Windows Sandbox 执行 PowerShell。文件在 session 关闭或到期后清除。首次省略 sessionId，后续命令沿用。重试需使用同一 requestId 和参数。用 env_job_get 查询收据，unknown 时先核实结果。', object({ ...environment, ...shell, sessionId: Type.Optional(uuid) }), receiptSchema, false,
    (args, caller) => result(jobs.submit(caller.subject, targetFor(caller, args.envId), args.requestId, { kind: 'powershell', script: args.script, cwd: args.cwd, timeoutMs: args.timeoutMs ?? 120000 }, args.sessionId)));
  add('env_status', '独立只读环境状态，不进入执行队列、不创建或启动 sandbox。返回就绪状态、助手版本、当前身份的任务队列和账本容量。数据库容量为匿名全局指标，不包含其他任务或文件路径。', object(environment), EnvironmentStatusSchema, true,
    async (args, caller) => result(await jobs.status(caller.subject, targetFor(caller, args.envId))));
  add('env_job_get', '查询同一 envId、调用身份下的 requestId。unknown 表示执行结果不确定，应继续查询或取消；details=archived 表示正文已归档，仍保留去重和退出摘要，不得重新执行旧请求。', object({ ...environment, requestId: uuid }), receiptSchema, true,
    (args, caller) => result(jobs.get(caller.subject, targetFor(caller, args.envId), args.requestId)));
  add('env_job_cancel', '取消当前身份在指定环境中的任务；取消活跃任务会关闭整个临时 session。持续查询直到确认停止。', object({ ...environment, requestId: uuid }), receiptSchema, false,
    (args, caller) => result(jobs.cancel(caller.subject, targetFor(caller, args.envId), args.requestId)));
  add('env_close', '关闭临时 sandbox session，销毁其中的文件；返回 closing 时继续查询关闭结果。', object({ ...environment, sessionId: uuid }), object({ sessionId: uuid, state: Type.Union([Type.Literal('closing'), Type.Literal('closed')]) }), false,
    (args, caller) => result(jobs.close(caller.subject, targetFor(caller, args.envId), args.sessionId)));
  return registered;
}
export function createMcpHttpServer(config: ServerConfig, jobs: Jobs, env: NodeJS.ProcessEnv = process.env) {
  const authenticate = multiBearerAuth(config.principals.map(p => {
    const token = env[p.tokenEnv]; if (!token || token.length < 32) throw new Error('missing_or_short_bearer_token');
    return { principal: p.id, token };
  }));
  const catalog = toolCatalog(config, jobs);
  return createLocalMcpHttpServer({
    authenticate,
    createSession(principalId) {
      const server = new Server({ name: 'joule-windows', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: '此服务管理宿主机的临时 Windows Sandbox。先用 env_list 查看授权范围。HTTP 断线后用 env_job_get 查询原任务。' });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.map(t => t.tool) }));
      server.setRequestHandler(CallToolRequestSchema, async request => {
        try {
          const tool = catalog.find(t => t.tool.name === request.params.name); if (!tool) throw new Error('tool_not_found');
          return await tool.call(request.params.arguments ?? {}, environmentCaller(principalId, request.params._meta));
        } catch (error) {
          const message = error instanceof Error && /^[a-z][a-z0-9_]{0,95}$/.test(error.message) ? error.message : 'operation_failed';
          return { isError: true, content: [{ type: 'text', text: message }] };
        }
      });
      return server;
    },
  });
}
