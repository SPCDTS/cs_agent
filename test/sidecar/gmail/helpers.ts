import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { GmailClient } from "../../../src/sidecar/gmail/gmail.js";
import { GmailOAuth, SCOPES, type DesktopClient } from "../../../src/sidecar/gmail/oauth.js";
import { createGmailHttp, type AuditEvent } from "../../../src/sidecar/gmail/server.js";
import { SentStore } from "../../../src/sidecar/gmail/store.js";

export async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试监听失败");
  return `http://127.0.0.1:${address.port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
export async function fixture(options: { expiresInMs?: number; token?: Handler; gmail?: Handler; missing?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gmail-sidecar-"));
  const tokenFile = join(directory, "token.json");
  const stateDir = join(directory, "state");
  const bearer = randomBytes(32).toString("hex");
  const refreshToken = randomBytes(32).toString("base64url"), accessToken = randomBytes(32).toString("base64url");
  const events: AuditEvent[] = [];
  let tokenCalls = 0, gmailCalls = 0, sendCalls = 0;
  const sent: unknown[] = [], urls: URL[] = [], tokenForms: URLSearchParams[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/token") {
        tokenCalls++;
        tokenForms.push(new URLSearchParams(await body(req)));
        if (options.token) await options.token(req, res);
        else json(res, { access_token: accessToken, expires_in: 3600, scope: SCOPES });
        return;
      }
      gmailCalls++;
      urls.push(url);
      if (url.pathname.endsWith("/send")) { sendCalls++; sent.push(JSON.parse(await body(req))); }
      if (options.gmail) { await options.gmail(req, res); return; }
      if (url.pathname.endsWith("/send")) { json(res, { id: `sent-${sendCalls}`, threadId: "thread-1" }); return; }
      if (url.pathname === "/gmail/v1/users/me/messages") { json(res, { messages: [{ id: "mail-1" }] }); return; }
      json(res, {
        id: "mail-1", threadId: "thread-1", snippet: "摘要\u0000\n" + "字".repeat(220),
        payload: {
          mimeType: "text/plain", headers: [
            { name: "From", value: "sender@example.com" }, { name: "Subject", value: "原主题" },
            { name: "Date", value: "Tue, 27 Oct 2026 10:00:00 +0800" },
            { name: "Message-ID", value: "<original@example.com>" }, { name: "References", value: "<root@example.com>" },
          ], body: { data: Buffer.from("正文").toString("base64url"), size: 6 },
        },
      });
    })().catch(() => { if (!res.headersSent) json(res, { error: "fixture_failure" }, 500); else res.end(); });
  });
  const baseUrl = await listen(upstream);
  const desktop: DesktopClient = { client_id: "fixture-client", client_secret: randomBytes(32).toString("hex"), auth_uri: "https://accounts.google.com/o/oauth2/v2/auth", token_uri: `${baseUrl}/token` };
  if (!options.missing) await writeFile(tokenFile, JSON.stringify({ refresh_token: refreshToken, access_token: accessToken,
    expires_at: Date.now() + (options.expiresInMs ?? 3600_000), scope: SCOPES, obtained_at: Date.now() }), { encoding: "utf8", mode: 0o600 });
  const oauth = await GmailOAuth.open(desktop, tokenFile);
  const store = await SentStore.open(stateDir);
  const gmail = new GmailClient(oauth, store, baseUrl);
  const http = createGmailHttp({ token: bearer, oauth, gmail, audit: event => events.push(event) });
  const endpoint = await listen(http);
  const clients: Client[] = [];
  return {
    directory, tokenFile, stateDir, bearer, desktop, oauth, store, gmail, endpoint, baseUrl, events, urls, sent, tokenForms, refreshToken, accessToken,
    get tokenCalls() { return tokenCalls; }, get gmailCalls() { return gmailCalls; }, get sendCalls() { return sendCalls; },
    async connect() {
      const client = new Client({ name: "gmail-sidecar-test", version: "1" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
      return client;
    },
    async tokenJson(): Promise<unknown> { return JSON.parse(await readFile(tokenFile, "utf8")); },
    async cleanup() {
      await Promise.all(clients.map(client => client.close()));
      await close(http);
      await close(upstream);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function textOf(result: unknown): string {
  return z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) }).parse(result).content.map(item => item.text).join("\n");
}
