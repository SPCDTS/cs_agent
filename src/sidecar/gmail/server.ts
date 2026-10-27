import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GmailError, safeError } from "./errors.js";
import type { GmailClient } from "./gmail.js";
import { sendSchema } from "./mime.js";
import type { GmailOAuth } from "./oauth.js";

type ToolName = "gmail_search" | "gmail_read" | "gmail_send";
export type AuditEvent = { tool?: ToolName; duration_ms?: number; status: "ok" | "error"; error?: string; google_status?: number };
export type Audit = (event: AuditEvent) => void;
export const auditJson: Audit = event => { process.stdout.write(JSON.stringify(event) + "\n"); };

export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export function createGmailMcp(gmail: GmailClient, audit: Audit = auditJson): McpServer {
  const server = new McpServer({ name: "gmail-sidecar", version: "1.0.0" }, { capabilities: { tools: {} } });
  async function call(tool: ToolName, action: () => Promise<string>): Promise<CallToolResult> {
    const started = performance.now();
    try {
      const text = await action();
      audit({ tool, duration_ms: Math.round(performance.now() - started), status: "ok" });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      const safe = safeError(error);
      audit({ tool, duration_ms: Math.round(performance.now() - started), status: "error", error: safe.kind, google_status: safe.googleStatus });
      return { isError: true, content: [{ type: "text", text: safe.message }] };
    }
  }
  server.registerTool("gmail_search", {
    description: "Search Gmail using Gmail query syntax. Returns message IDs, metadata and short snippets; max_results defaults to 10.",
    inputSchema: z.strictObject({ query: z.string().min(1).max(500), max_results: z.number().int().min(1).max(25).optional() }),
    annotations: { readOnlyHint: true },
  }, args => call("gmail_search", () => gmail.search(args.query, args.max_results)));
  server.registerTool("gmail_read", {
    description: "Read a Gmail message by ID. Returns headers, up to 32 KiB of text and attachment metadata without downloading attachments.",
    inputSchema: z.strictObject({ id: z.string().min(1).max(128) }), annotations: { readOnlyHint: true },
  }, args => call("gmail_read", () => gmail.read(args.id)));
  server.registerTool("gmail_send", {
    description: "Send a plain-text Gmail message, optionally replying to a Gmail message ID. Use comma-separated addresses. Reuse the same idempotency_key for the same send; receipts are retained for 7 days. After an uncertain result, check Sent mail before retrying.",
    inputSchema: sendSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => call("gmail_send", () => gmail.send(args)));
  return server;
}

const BODY_LIMIT = 1024 * 1024;

function rejectBody(req: IncomingMessage, res: ServerResponse, status: number): void {
  // 未鉴权或超限时不排空请求体，关闭连接，避免 SDK/JSON 解析先消耗任意输入。
  req.pause();
  res.writeHead(status, { Connection: "close" }).end();
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  if (Number(req.headers["content-length"]) > BODY_LIMIT) { rejectBody(req, res, 413); return; }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        req.off("data", onData);
        rejectBody(req, res, 413);
        resolve(undefined);
      } else chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("error", reject);
    req.on("aborted", () => reject(new Error()));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { res.writeHead(400).end(); resolve(undefined); }
    });
  });
}

export function createGmailHttp(options: { token: string; oauth: GmailOAuth; gmail: GmailClient; audit?: Audit }) {
  if (options.token.length < 32 || /[^\x21-\x7e]/u.test(options.token)) {
    throw new GmailError("config", "GMAIL_SIDECAR_TOKEN 必须为至少 32 字符的无空白 ASCII 随机串");
  }
  const expected = `Bearer ${options.token}`;
  const http = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/healthz" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: options.oauth.auth === "ready", auth: options.oauth.auth, tools: 3 }));
        return;
      }
      if (pathname !== "/mcp") { res.writeHead(404).end(); return; }
      if (req.method === "GET") { res.writeHead(405, { Allow: "POST, DELETE" }).end(); return; }
      if (req.method === "DELETE") { res.writeHead(204).end(); return; }
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST, DELETE" }).end(); return; }
      if (!constantTimeEqual(req.headers.authorization ?? "", expected)) { rejectBody(req, res, 401); return; }
      const body = await readBody(req, res);
      if (res.writableEnded) return;
      const server = createGmailMcp(options.gmail, options.audit);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once("close", () => { void server.close().catch(() => {}); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch {
        await server.close().catch(() => {});
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  return http;
}
