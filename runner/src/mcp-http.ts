import { createServer, type IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const bearerDigest = (value: string) => createHash('sha256').update(value).digest();

interface LocalMcpHttpOptions<P> {
  authenticate(authorization: string): P | undefined;
  createSession(principal: P): Server;
}

export function multiBearerAuth<P>(entries: readonly { principal: P; token: string }[]): (authorization: string) => P | undefined {
  const compiled = entries.map(entry => ({ principal: entry.principal, digest: bearerDigest('Bearer ' + entry.token) }));
  if (new Set(compiled.map(entry => entry.digest.toString('hex'))).size !== compiled.length) {
    throw new Error('duplicate_bearer_token');
  }
  return authorization => {
    const actual = bearerDigest(authorization);
    return compiled.find(entry => timingSafeEqual(entry.digest, actual))?.principal;
  };
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; status: 413 }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > maxBodyBytes) return { ok: false, status: 413 };
    chunks.push(bytes);
  }
  return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
}

export function createLocalMcpHttpServer<P>(options: LocalMcpHttpOptions<P>) {
  return createServer(async (req, res) => {
    const principal = options.authenticate(req.headers.authorization ?? '');
    if (principal === undefined) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '') || req.headers.origin !== undefined) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      res.writeHead(415).end();
      return;
    }
    try {
      const body = await readJsonBody(req, 512 * 1024);
      if (!body.ok) {
        res.writeHead(body.status).end();
        return;
      }
      const session = options.createSession(principal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => {
        void transport.close().catch(() => undefined);
        void session.close().catch(() => undefined);
      });
      await session.connect(transport);
      await transport.handleRequest(req, res, body.value);
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  });
}
