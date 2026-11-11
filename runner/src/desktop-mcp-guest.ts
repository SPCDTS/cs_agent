import { createServer, type Server, type Socket } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Check } from 'typebox/value';
import { DesktopMcpRequestSchema, DESKTOP_MCP_REQUEST_BYTES, DESKTOP_MCP_RESULT_BYTES, type DesktopMcpSettings } from './desktop-mcp-protocol.ts';

type Entry = { client: Client; stamp: string; lastUsed: number; busy: boolean };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = (code: string) => ({ ok: false, error: code });
const publicError = (error: unknown) => error instanceof Error && /^desktop_[a-z_]+$/.test(error.message) ? error.message : 'desktop_mcp_outcome_unknown';

/** 来宾内的认证管道只代理原生 MCP；工具名称、参数和内容块保持上游定义。 */
export function createDesktopMcpGuest(settings: DesktopMcpSettings, context: () => Promise<string>, options: {
  pipe?: string; idleMs?: number; maxClients?: number;
} = {}) {
  const clients = new Map<string, Entry>();
  const sockets = new Set<Socket>();
  const expectedToken = Buffer.from(hash(settings.token), 'hex');
  const idleMs = options.idleMs ?? 600_000;
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
      const namespace = hash(scope + '\0' + stamp);
      const client = new Client({ name: 'cs-agent-interactive-mcp', version: '1' });
      const transport = new StdioClientTransport({ command: settings.command,
        args: [...settings.args, ...(settings.scopeArgument ? [settings.scopeArgument, namespace] : [])], cwd: settings.cwd, stderr: 'ignore', maxBufferSize: DESKTOP_MCP_RESULT_BYTES });
      try { await client.connect(transport, { signal, timeout: 10_000 }); }
      catch (error) { await client.close().catch(() => undefined); throw error; }
      entry = { client, stamp, lastUsed: Date.now(), busy: false };
      clients.set(scope, entry);
    }
    return entry;
  }
  async function handle(value: unknown, socket: Socket) {
    if (!Check(DesktopMcpRequestSchema, value) || !timingSafeEqual(Buffer.from(hash(value.token), 'hex'), expectedToken)) return failure('desktop_mcp_denied');
    if (value.deadline <= Date.now() || value.deadline > Date.now() + 60_000) return failure('desktop_mcp_expired');
    if (stopped || pending >= 16) return failure('desktop_mcp_busy');
    pending++;
    const abort = new AbortController();
    const disconnected = () => abort.abort(new Error('desktop_mcp_disconnected'));
    socket.once('close', disconnected);
    const timer = setTimeout(() => abort.abort(new Error('desktop_mcp_expired')), Math.max(1, value.deadline - Date.now()));
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>(resolve => { release = resolve; });
    let entry: Entry | undefined;
    let invoked = false;
    try {
      await previous;
      abort.signal.throwIfAborted();
      const stamp = await context();
      entry = await getClient(value.scope, stamp, abort.signal);
      entry.busy = true;
      const requestOptions = { signal: abort.signal, timeout: Math.max(1, value.deadline - Date.now()) };
      if (value.operation.kind === 'list') {
        const tools = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = await entry.client.listTools(cursor ? { cursor } : {}, requestOptions);
          tools.push(...result.tools);
          if (tools.length > 128) throw new Error('desktop_mcp_catalog_limit');
          cursor = result.nextCursor;
          if (!cursor) return { ok: true, result: { tools, instructions: entry.client.getInstructions() ?? '' } };
        }
        throw new Error('desktop_mcp_catalog_limit');
      }
      invoked = true;
      const result = CallToolResultSchema.parse(await entry.client.callTool({ name: value.operation.name, arguments: value.operation.arguments }, CallToolResultSchema, requestOptions));
      return { ok: true, result };
    } catch (error) {
      if (abort.signal.aborted || !(error instanceof Error && error.message === 'desktop_unavailable')) await discard(value.scope);
      return failure(invoked ? 'desktop_mcp_outcome_unknown' : publicError(error));
    } finally {
      if (entry) { entry.busy = false; entry.lastUsed = Date.now(); }
      clearTimeout(timer); socket.off('close', disconnected); pending--; release();
    }
  }
  const server: Server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(60_000, () => socket.destroy());
    let data = Buffer.alloc(0), accepted = false;
    socket.on('data', (chunk: Buffer) => {
      if (accepted) { socket.destroy(); return; }
      if (data.length + chunk.length > DESKTOP_MCP_REQUEST_BYTES) { socket.destroy(); return; }
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(10);
      if (end < 0) return;
      accepted = true;
      let request: unknown;
      try { request = JSON.parse(data.subarray(0, end).toString('utf8')); }
      catch { socket.end(JSON.stringify(failure('desktop_mcp_invalid_request')) + '\n'); return; }
      void handle(request, socket).then(result => {
        const encoded = JSON.stringify(result);
        socket.end((Buffer.byteLength(encoded) <= DESKTOP_MCP_RESULT_BYTES ? encoded : JSON.stringify(failure('desktop_mcp_result_limit'))) + '\n');
      }, () => socket.end(JSON.stringify(failure('desktop_mcp_outcome_unknown')) + '\n'));
    });
  });
  const reap = setInterval(() => { for (const [scope, entry] of clients) if (!entry.busy && entry.lastUsed + idleMs < Date.now()) void discard(scope); }, 30_000);
  reap.unref();
  return {
    server,
    async listen() { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.pipe ?? '\\\\.\\pipe\\' + settings.pipeName, resolve); }); },
    async close() {
      stopped = true; clearInterval(reap);
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await tail; await Promise.all([...clients.keys()].map(discard)); await closed;
    },
  };
}
