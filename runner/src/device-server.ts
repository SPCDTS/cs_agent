import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { DeviceShell, RequestId, ShellRequest, ShellReceipt } from './device-shell.ts';

const strict = { additionalProperties: false };
const query = Type.Object({ requestId: RequestId }, strict);
const caller = Type.Object({ scope: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, strict);
export const DEVICE_TOOLS = [
  { name: 'device_info', description: '读取本机操作系统、Shell、默认目录和持久化说明；执行命令前先查看。', inputSchema: Type.Object({}, strict), annotations: { readOnlyHint: true } },
  { name: 'shell_exec', description: '在设备本机执行命令，以当前账户权限运行。command 使用 device_info 返回的 Shell 语法；cwd 显式指定工作目录。requestId 为 UUID，同一操作重试必须保持 ID 和命令参数一致。短命令直接返回结果，running 用 shell_status 查询。unknown 表示结果不确定，先核查状态，禁止另起相同命令。', inputSchema: ShellRequest, outputSchema: ShellReceipt, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
  { name: 'shell_status', description: '读取当前调用会话的命令状态、退出码和有界输出。HTTP 断线不代表命令失败；details=archived 时输出已归档，去重记录仍保留。', inputSchema: query, outputSchema: ShellReceipt, annotations: { readOnlyHint: true } },
  { name: 'shell_cancel', description: '请求终止当前调用会话的命令及其进程树。继续查询到终态；unknown 不代表已停止。不会删除文件或关闭设备。', inputSchema: query, outputSchema: ShellReceipt, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
].map(tool => ToolSchema.parse(tool));
const result = (value: object): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { ...value } });
const digest = (value: string) => createHash('sha256').update(value).digest();

export function createDeviceServer(shell: DeviceShell, token: string, name = shell.info().hostname) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('device_token_invalid');
  const expected = digest('Bearer ' + token);
  const server = createServer(async (req, res) => {
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' }).end(); return; }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '') || req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
    const mcp = new Server({ name: 'cs-agent-device', version: '1' }, { capabilities: { tools: {} }, instructions: shell.info().instructions });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DEVICE_TOOLS.map(tool => ({ ...tool, description: '设备：' + name + '。' + tool.description })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const metadata = request.params._meta?.['cs-agent/caller'];
        if (metadata !== undefined && !Check(caller, metadata)) throw new Error('invalid_caller_metadata');
        const scope = metadata?.scope ?? 'direct';
        const args = request.params.arguments ?? {};
        switch (request.params.name) {
          case 'device_info': if (!Check(Type.Object({}, strict), args)) throw new Error('invalid_arguments'); return result({ name, ...shell.info() });
          case 'shell_exec': if (!Check(ShellRequest, args)) throw new Error('invalid_arguments'); return result(await shell.exec(scope, args));
          case 'shell_status': if (!Check(query, args)) throw new Error('invalid_arguments'); return result(shell.get(scope, args.requestId));
          case 'shell_cancel': if (!Check(query, args)) throw new Error('invalid_arguments'); return result(await shell.cancel(scope, args.requestId));
          default: throw new Error('tool_not_found');
        }
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'device_operation_failed' }] }; }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void transport.close().catch(() => {}); void mcp.close().catch(() => {}); });
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; if (size > 128 * 1024) { res.writeHead(413).end(); return; } chunks.push(bytes); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(400).end(); }
  });
  server.requestTimeout = 15000;
  return server;
}
