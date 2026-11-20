import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Check } from 'typebox/value';
import { Type } from 'typebox';
import type { DesktopConfig } from './desktop-config.ts';
import { createLocalMcpHttpServer, singleBearerAuth } from './mcp-http.ts';

const resultBytes = 12 * 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const callerSchema = Type.Object({ scope: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false });
const defaultGuidance = '这是 VM 内已登录用户的持久桌面。首次使用读取 desktop_skills_get 的 desktop/platform 指南。窗口、文件、剪贴板和焦点与用户及其他调用者共享；控件引用按调用会话隔离。锁屏或未登录时不可用。执行结果未知时先观察状态，不要自动重放操作。';
type Entry = { client: Client; stamp: string; lastUsed: number; busy: boolean };

/** 在登录桌面内将原生 stdio MCP 暴露为独立 HTTP MCP，不经过宿主执行后端。 */
export function createDesktopServer(config: DesktopConfig, context: () => Promise<string>, options: {
  idleMs?: number; maxClients?: number; callTimeoutMs?: number; path?: string; instructions?: string;
} = {}) {
  const guidance = options.instructions ?? defaultGuidance;
  const clients = new Map<string, Entry>();
  const active = new Set<AbortController>();
  let pending = 0, stopped = false;
  let tail: Promise<void> = Promise.resolve();
  async function discard(scope: string) {
    const entry = clients.get(scope);
    if (!entry) return;
    clients.delete(scope);
    await entry.client.close().catch(() => undefined);
  }
  async function getClient(scope: string, stamp: string, signal: AbortSignal) {
    const prior = clients.get(scope);
    if (prior && prior.stamp !== stamp) await discard(scope);
    let entry = clients.get(scope);
    if (!entry) {
      if (clients.size >= (options.maxClients ?? 8)) {
        const oldest = [...clients.entries()].filter(([, candidate]) => !candidate.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!oldest) throw new Error('desktop_mcp_busy');
        await discard(oldest[0]);
      }
      const namespace = hash(config.desktopSid + '\0' + scope + '\0' + stamp);
      const client = new Client({ name: 'cs-agent-desktop', version: '1' });
      const transport = new StdioClientTransport({ command: config.command,
        args: [...config.args, ...(config.scopeArgument ? [config.scopeArgument, namespace] : [])], cwd: config.cwd, stderr: 'ignore', maxBufferSize: resultBytes });
      try { await client.connect(transport, { signal, timeout: 10_000 }); }
      catch (error) { await client.close().catch(() => undefined); throw error; }
      entry = { client, stamp, lastUsed: Date.now(), busy: false };
      clients.set(scope, entry);
    }
    return entry;
  }
  async function execute<T>(scope: string, signal: AbortSignal, run: (client: Client) => Promise<T>): Promise<T> {
    if (stopped || pending >= 16) throw new Error('desktop_mcp_busy');
    pending++;
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>(resolve => { release = resolve; });
    let entry: Entry | undefined;
    try {
      await previous;
      signal.throwIfAborted();
      entry = await getClient(scope, await context(), signal);
      entry.busy = true;
      signal.throwIfAborted();
      const result = await run(entry.client);
      if (Buffer.byteLength(JSON.stringify(result)) > resultBytes) throw new Error('desktop_mcp_result_limit');
      return result;
    } catch (error) {
      if (signal.aborted || !(error instanceof Error && error.message === 'desktop_unavailable')) await discard(scope);
      throw error;
    } finally {
      if (entry) { entry.busy = false; entry.lastUsed = Date.now(); }
      pending--; release();
    }
  }
  const server = createLocalMcpHttpServer({
    authenticate: singleBearerAuth(config.token),
    path: options.path,
    requestTimeout: 60_000,
    createSession() {
      const abort = new AbortController(); active.add(abort);
      const timer = setTimeout(() => abort.abort(new Error('desktop_mcp_expired')), options.callTimeoutMs ?? 45_000);
      const mcp = new Server({ name: 'cs-agent-desktop', version: '1' }, { capabilities: { tools: {} }, instructions: guidance });
      mcp.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        const signal = AbortSignal.any([abort.signal, extra.signal]);
        return execute('catalog', signal, async client => {
          const tools = [];
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10_000 });
            tools.push(...result.tools.map(tool => ({ ...tool, description: guidance + '\n' + (tool.description ?? '') +
              (tool.name === 'desktop_skills_get' ? '\n' + (client.getInstructions() ?? '') : '') })));
            if (tools.length > 128) throw new Error('desktop_mcp_catalog_limit');
            cursor = result.nextCursor;
            if (!cursor) return { tools };
          }
          throw new Error('desktop_mcp_catalog_limit');
        });
      });
      mcp.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
        let invoked = false;
        try {
          const caller = request.params._meta?.['cs-agent/caller'];
          if (caller !== undefined && !Check(callerSchema, caller)) throw new Error('invalid_caller_metadata');
          const scope = caller?.scope ?? 'default';
          const signal = AbortSignal.any([abort.signal, extra.signal]);
          return await execute(scope, signal, async client => {
            invoked = true;
            return CallToolResultSchema.parse(await client.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} }, CallToolResultSchema, { signal, timeout: options.callTimeoutMs ?? 45_000 }));
          });
        } catch (error) {
          const code = invoked ? 'desktop_mcp_outcome_unknown' : error instanceof Error && /^(desktop_[a-z_]+|invalid_caller_metadata)$/.test(error.message) ? error.message : 'desktop_mcp_unavailable';
          return { isError: true, content: [{ type: 'text', text: code }] };
        }
      });
      return {
        server: mcp,
        onClose() { clearTimeout(timer); active.delete(abort); abort.abort(new Error('desktop_mcp_disconnected')); },
      };
    },
  });
  const reap = setInterval(() => { for (const [scope, entry] of clients) if (!entry.busy && entry.lastUsed + (options.idleMs ?? 600_000) < Date.now()) void discard(scope); }, 30_000);
  reap.unref();
  return {
    server,
    async close() {
      stopped = true; clearInterval(reap);
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const abort of active) abort.abort(new Error('desktop_mcp_stopped'));
      server.closeAllConnections();
      await tail; await Promise.all([...clients.keys()].map(discard)); await closed;
    },
  };
}
