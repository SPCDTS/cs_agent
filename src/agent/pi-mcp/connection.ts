import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ErrorCode, ListToolsResultSchema, McpError, ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { EnvironmentSecrets, McpLimits, McpServerConfig } from "./config.js";
import { boundedFetch, McpConnectionError } from "./transport-http.js";

export { McpConnectionError } from "./transport-http.js";

type OpenOptions = {
  server: McpServerConfig;
  limits: McpLimits;
  secrets: EnvironmentSecrets;
  signal: AbortSignal;
  onToolsChanged: () => void;
};

/** 一个已隔离的协议连接；排队、身份与总调用预算由宿主管理。 */
export class McpConnection {
  private closed = false;
  private closePromise?: Promise<void>;
  private failure?: McpConnectionError;

  private constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
    private readonly limits: McpLimits,
  ) {}

  static async open(options: OpenOptions): Promise<McpConnection> {
    options.signal.throwIfAborted();
    const { server, limits, secrets } = options;
    const client = new Client({ name: "cs-agent-pi-mcp", version: "1.0.0" }, { capabilities: {} });
    let connection: McpConnection | undefined;
    const fail = (error: McpConnectionError) => {
      if (!connection) return;
      connection.failure ??= error;
      void connection.close();
    };
    const settings = server.transport;
    const headers = new Headers();
    try {
      for (const [name, value] of Object.entries(settings.headers)) headers.set(name, value);
      for (const [name, reference] of Object.entries(settings.secretHeaders)) headers.set(name, secret(secrets, reference));
    } catch (error) {
      if (error instanceof McpConnectionError) throw error;
      throw new McpConnectionError("auth_failed", "MCP 凭据请求头无效");
    }
    const transport = new StreamableHTTPClientTransport(new URL(settings.url), {
      requestInit: { headers, redirect: "manual", credentials: "omit" },
      fetch: boundedFetch(new URL(settings.url), limits.messageBytes, fail),
      // 不安排 SDK 后台重连；断流按本次调用预算结算，避免关闭后残留恢复计时器。
      reconnectionOptions: { initialReconnectionDelay: 250, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 2, maxRetries: 0 },
    });
    connection = new McpConnection(client, transport, limits);
    client.onerror = error => {
      // 只保留本模块产生的有界错误，不保存第三方消息或堆栈。
      if (error instanceof McpConnectionError) connection.failure ??= error;
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (!connection.closed) options.onToolsChanged();
    });
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(limits.connectMs)]);
    const abort = () => { void connection.close(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.connect(transport, { signal, timeout: limits.connectMs, maxTotalTimeout: limits.connectMs, resetTimeoutOnProgress: false });
      signal.throwIfAborted();
      if (!client.getServerCapabilities()?.tools) throw new McpConnectionError("protocol_error", "MCP 服务未声明工具能力");
      return connection;
    } catch (error) {
      await connection.close();
      options.signal.throwIfAborted();
      if (signal.aborted) throw new McpConnectionError("timeout", "MCP 连接初始化超时");
      throw connection.failure ?? safeError(error);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async listTools(signal: AbortSignal): Promise<readonly Tool[]> {
    this.assertOpen(signal);
    const tools: Tool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    try {
      for (let page = 0; page < this.limits.maxPages; page++) {
        this.assertOpen(signal);
        const result = await this.client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, ListToolsResultSchema,
          { signal, timeout: this.limits.connectMs, maxTotalTimeout: this.limits.connectMs, resetTimeoutOnProgress: false });
        bytes += Buffer.byteLength(JSON.stringify(result));
        if (bytes > this.limits.catalogBytes || tools.length + result.tools.length > this.limits.maxTools) {
          throw new McpConnectionError("catalog_limit", "MCP 工具目录超出限额");
        }
        for (const tool of result.tools) {
          if (names.has(tool.name)) throw new McpConnectionError("protocol_error", "MCP 工具目录包含重复名称");
          names.add(tool.name);
          tools.push(tool);
        }
        if (result.nextCursor === undefined) return tools;
        if (cursors.has(result.nextCursor)) throw new McpConnectionError("protocol_error", "MCP 工具分页游标重复");
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new McpConnectionError("catalog_limit", "MCP 工具目录页数超出限额");
    } catch (error) {
      signal.throwIfAborted();
      throw this.failure ?? safeError(error);
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    this.assertOpen(signal);
    try {
      // 不走 SDK callTool 的逐页 outputSchema 缓存；独立目录校验由宿主完成。
      return await this.client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema,
        { signal, timeout: this.limits.callMs, maxTotalTimeout: this.limits.callMs, resetTimeoutOnProgress: false });
    } catch (error) {
      signal.throwIfAborted();
      throw this.failure ?? safeError(error);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const deadline = Date.now() + this.limits.closePerConnectionMs;
      // DELETE 只是尽力终止会话，失败不得阻止本地关闭。
      await boundedWait(this.transport.terminateSession().catch(() => {}), Math.min(250, this.limits.closePerConnectionMs / 4));
      await boundedWait(Promise.allSettled([this.client.close(), this.transport.close()]).then(() => {}), Math.max(1, deadline - Date.now()));
    })();
    return this.closePromise;
  }

  private assertOpen(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed) throw this.failure ?? new McpConnectionError("closed", "MCP 连接已关闭");
  }
}

function secret(secrets: EnvironmentSecrets, name: string): string {
  const value = secrets.readReferencedVariable(name);
  if (value === undefined) throw new McpConnectionError("missing_secret", "MCP 服务缺少配置引用的凭据");
  return value;
}

function safeError(error: unknown): McpConnectionError {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return new McpConnectionError("timeout", "MCP 协议请求超时");
  return error instanceof McpConnectionError ? error : new McpConnectionError("protocol_error", "MCP 协议请求失败");
}

async function boundedWait(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
