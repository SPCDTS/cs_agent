import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema, ListResourcesResultSchema, ListResourceTemplatesResultSchema, ReadResourceResultSchema, type Resource, type ResourceTemplate, ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Env } from "../env";
import { referencedSecret, type McpLimits, type McpServerConfig } from "./config";
import { boundedFetch, McpConnectionError } from "./transport-http";
import { connectionDigest } from "./names";

export class McpConnection {
  private readonly client = new Client({ name: "cs-agent-workers", version: "1.0.0" }, { capabilities: {} });
  private readonly transport: StreamableHTTPClientTransport;
  private failure?: McpConnectionError;
  private closing?: Promise<void>;
  private constructor(server: McpServerConfig, env: Env, private readonly limits: McpLimits, onChanged: () => void, managedHeaders: Record<string, string>) {
    const headers = new Headers({ ...server.transport.headers, ...managedHeaders });
    for (const [name, ref] of Object.entries(server.transport.secretHeaders)) {
      const value = referencedSecret(env, ref);
      if (!value) throw new McpConnectionError("missing_secret", "missing_secret");
      try { headers.set(name, value); } catch { throw new McpConnectionError("auth_failed", "auth_failed"); }
    }
    const token = async (rejected?: string) => {
      try {
        const value = await env.REGISTRY.getByName("main").accessToken(server.id, rejected, connectionDigest(server));
        if (!value) throw new Error();
        return value;
      } catch { throw new McpConnectionError("auth_required", "auth_required"); }
    };
    this.transport = new StreamableHTTPClientTransport(new URL(server.transport.url), {
      requestInit: { headers, redirect: "manual" },
      fetch: boundedFetch(new URL(server.transport.url), limits.messageBytes, error => { this.failure = error; void this.close(); },
        server.credential.kind === "oauth" ? { accessToken: () => token(), rejected: token,
          authRequired: async () => { throw new McpConnectionError("auth_required", "auth_required"); } } : undefined),
      // 禁用 SDK 自动 SSE 恢复，避免 unsafe 调用在断线后被隐式重发。
      reconnectionOptions: { initialReconnectionDelay: 250, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 2, maxRetries: 0 },
    });
    this.client.onerror = error => { if (error instanceof McpConnectionError) this.failure = error; };
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { if (!this.closing) onChanged(); });
  }
  static async open(server: McpServerConfig, env: Env, limits: McpLimits, signal: AbortSignal, onChanged: () => void): Promise<McpConnection> {
    const managed = server.credential.kind === "managed" ? await env.REGISTRY.getByName("main").mcpCredentialHeaders(server.id, connectionDigest(server)) : {};
    const connection = new McpConnection(server, env, limits, onChanged, managed);
    try {
      await connection.client.connect(connection.transport, { signal, timeout: limits.connectMs, maxTotalTimeout: limits.connectMs });
      signal.throwIfAborted();
      if (!connection.client.getServerCapabilities()?.tools && !connection.client.getServerCapabilities()?.resources) throw new McpConnectionError("protocol_error", "protocol_error");
      return connection;
    } catch (error) { await connection.close(); throw connection.failure ?? safeError(error); }
  }
  async listTools(signal: AbortSignal): Promise<Tool[]> {
    if (!this.client.getServerCapabilities()?.tools) return [];
    const tools: Tool[] = [], names = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined, bytes = 0;
    for (let page = 0; page < this.limits.maxPages; page++) {
      const result = await this.client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, ListToolsResultSchema,
        { signal, timeout: this.limits.connectMs, maxTotalTimeout: this.limits.connectMs, resetTimeoutOnProgress: false });
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > this.limits.catalogBytes || tools.length + result.tools.length > this.limits.maxTools) throw new McpConnectionError("catalog_limit", "catalog_limit");
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new McpConnectionError("protocol_error", "protocol_error");
        names.add(tool.name); tools.push(tool);
      }
      if (result.nextCursor === undefined) return tools;
      if (cursors.has(result.nextCursor)) throw new McpConnectionError("protocol_error", "protocol_error");
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new McpConnectionError("catalog_limit", "catalog_limit");
  }
  async listResources(signal: AbortSignal): Promise<Resource[]> {
    if (!this.client.getServerCapabilities()?.resources) return [];
    const rows: Resource[] = [], cursors = new Set<string>();
    let cursor: string | undefined, bytes = 0;
    for (let page = 0; page < this.limits.maxPages; page++) {
      const result = await this.client.request({ method: "resources/list", params: cursor === undefined ? {} : { cursor } }, ListResourcesResultSchema,
        { signal, timeout: this.limits.connectMs, maxTotalTimeout: this.limits.connectMs });
      bytes += Buffer.byteLength(JSON.stringify(result)); rows.push(...result.resources);
      if (bytes > this.limits.catalogBytes || rows.length > this.limits.maxTools) throw new McpConnectionError("catalog_limit", "catalog_limit");
      if (!result.nextCursor) return rows;
      if (cursors.has(result.nextCursor)) throw new McpConnectionError("protocol_error", "protocol_error");
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new McpConnectionError("catalog_limit", "catalog_limit");
  }
  async listResourceTemplates(signal: AbortSignal): Promise<ResourceTemplate[]> {
    if (!this.client.getServerCapabilities()?.resources) return [];
    const rows: ResourceTemplate[] = [], cursors = new Set<string>();
    let cursor: string | undefined, bytes = 0;
    for (let page = 0; page < this.limits.maxPages; page++) {
      const result = await this.client.request({ method: "resources/templates/list", params: cursor === undefined ? {} : { cursor } }, ListResourceTemplatesResultSchema,
        { signal, timeout: this.limits.connectMs, maxTotalTimeout: this.limits.connectMs });
      bytes += Buffer.byteLength(JSON.stringify(result)); rows.push(...result.resourceTemplates);
      if (bytes > this.limits.catalogBytes || rows.length > this.limits.maxTools) throw new McpConnectionError("catalog_limit", "catalog_limit");
      if (!result.nextCursor) return rows;
      if (cursors.has(result.nextCursor)) throw new McpConnectionError("protocol_error", "protocol_error");
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new McpConnectionError("catalog_limit", "catalog_limit");
  }
  async readResource(uri: string, signal: AbortSignal) {
    return this.client.request({ method: "resources/read", params: { uri } }, ReadResourceResultSchema,
      { signal, timeout: this.limits.callMs, maxTotalTimeout: this.limits.callMs, resetTimeoutOnProgress: false });
  }
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (this.closing || this.failure) throw this.failure ?? new McpConnectionError("closed", "closed");
    // 直接 request 避免 SDK 的逐页 outputSchema 缓存影响早期页面的工具；校验由完整目录负责。
    try { return await this.client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema,
      { signal, timeout: this.limits.callMs, maxTotalTimeout: this.limits.callMs, resetTimeoutOnProgress: false }); }
    catch (error) { throw this.failure ?? safeError(error); }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.transport.terminateSession().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(250, this.limits.closePerConnectionMs)); })]);
      } finally { clearTimeout(timer); await this.client.close(); await this.transport.close(); }
    })();
  }
}
export function safeError(error: unknown): McpConnectionError {
  return error instanceof McpConnectionError ? error : new McpConnectionError("protocol_error", "protocol_error");
}
