/** 面板文件与表单边界；路径、大小、版本和秘密检查保持集中。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { containsSecret, redactText } from '../shared/redact.js';
const MAX_BODY = 512 * 1024;
export const AGENT_MD_MAX_BYTES = 64 * 1024;

export function equal(a: string, b: string): boolean { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** 表单与 JSON 写接口共用同源策略；Origin 缺省时仍须通过各自的 CSRF 校验。 */
export function guardDashboardOrigin(req: IncomingMessage, host: string): void {
  const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  if (origin && origin !== `http://${host}` && !(origin === 'null' && site === 'same-origin') ||
      site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, '跨站请求被拒绝');
}

export async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '只接受表单提交');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, '提交内容过大');
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** 有界二进制解析；只认完整 boundary 行，文件内同名片段不会被截断。 */
export async function readMultipart(req: IncomingMessage, { maxBytes }: { maxBytes: number }): Promise<{
  fields: URLSearchParams; file?: { name: string; type: string; data: Buffer };
}> {
  const contentType = req.headers['content-type'] ?? '';
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s"]+))\s*$/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70 || !/^[\x20-\x7e]+$/.test(boundary)) throw new HttpError(415, '只接受 multipart/form-data 上传');
  const limit = Math.min(maxBytes, 20 * 1024 * 1024);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new HttpError(400, '无效上传限额');
  const chunks: Buffer[] = []; let size = 0;
  // 超限后继续排空输入，使 HTTP 层仍能发送 413，而不是销毁连接。
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) { req.resume(); throw new HttpError(413, '上传内容超过大小上限'); }
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks), marker = Buffer.from('--' + boundary), separator = Buffer.from('\r\n--' + boundary);
  const fields = new URLSearchParams();
  let file: { name: string; type: string; data: Buffer } | undefined;
  let offset = 0;
  const invalid = () => new HttpError(400, 'multipart 表单格式无效');
  if (!body.subarray(0, marker.length).equals(marker)) throw invalid();
  offset = marker.length;
  while (true) {
    if (body.subarray(offset, offset + 2).toString() === '--') {
      const tail = body.subarray(offset + 2).toString();
      if (tail !== '' && tail !== '\r\n') throw invalid();
      return { fields, file };
    }
    if (body.subarray(offset, offset + 2).toString() !== '\r\n') throw invalid();
    offset += 2;
    const endHeaders = body.indexOf('\r\n\r\n', offset);
    if (endHeaders < 0 || endHeaders - offset > 8192) throw invalid();
    const headers = new Map<string, string>();
    for (const line of body.subarray(offset, endHeaders).toString('utf8').split('\r\n')) {
      const header = /^([\w-]+):\s*(.*)$/.exec(line);
      if (!header || headers.has(header[1].toLowerCase())) throw invalid();
      headers.set(header[1].toLowerCase(), header[2]);
    }
    const disposition = /^form-data;\s*name="([^"\r\n]+)"(?:;\s*filename="([^"\r\n]*)")?$/i.exec(headers.get('content-disposition') ?? '');
    if (!disposition || headers.has('content-transfer-encoding')) throw invalid();
    const start = endHeaders + 4;
    let end = body.indexOf(separator, start);
    while (end >= 0 && !['\r\n', '--'].includes(body.subarray(end + separator.length, end + separator.length + 2).toString())) {
      end = body.indexOf(separator, end + separator.length);
    }
    if (end < 0) throw invalid();
    const data = body.subarray(start, end), name = disposition[1], filename = disposition[2];
    if (filename !== undefined) {
      if (file || name !== 'file' || /[\\/\x00-\x1f]/.test(filename)) throw new HttpError(400, '只允许一个 file 文件字段');
      if (/\.zip$/i.test(filename)) {
        if (!data.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new HttpError(415, 'ZIP 文件签名无效');
      } else if (!/\.md$/i.test(filename)) throw new HttpError(415, '只接受 ZIP 或 Markdown 文件');
      file = { name: filename, type: headers.get('content-type') ?? 'application/octet-stream', data };
    } else {
      if (fields.has(name)) throw new HttpError(400, '不接受重复表单字段');
      fields.append(name, data.toString('utf8'));
    }
    offset = end + separator.length;
  }
}

/** 只认普通文件（非链接、≤256 KB）；内容先脱敏。 */
export async function readText(file: string): Promise<string> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > 256_000 || await fs.realpath(file) !== path.resolve(file)) return '文件不可读取';
    return redactText(await fs.readFile(file,'utf8'),100_000);
  } catch { return '文件不存在'; }
}

/** agent.md 原子写：目录与目标都不能是链接，内容规范为 LF，大小有上限。 */
/** 编辑框所见版本：mtime + 大小的摘要；文件不存在为 'none'。 */
export const agentMdRevision = (st: { mtimeMs: number; size: number } | null): string =>
  st ? createHash('sha256').update(`${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16) : 'none';

/**
 * 服务端守卫（不只依赖界面只读）：当前文件含已注册秘密时拒绝覆盖；表单 revision 与当前文件不符
 * （被容器内或另一个标签页改过）时拒绝，避免覆盖他人修改。
 */
export async function guardAgentMd(file: string, revision: string): Promise<void> {
  let st: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try { st = await fs.lstat(file); } catch { /* 不存在 */ }
  if (st && st.isFile() && !st.isSymbolicLink() && st.size <= 256_000) {
    const current = await fs.readFile(file, 'utf8');
    if (containsSecret(current)) throw new HttpError(409, 'agent.md 中包含凭据样式的内容，面板禁止覆盖；请在容器内直接编辑。');
  }
  if (revision !== agentMdRevision(st)) throw new HttpError(409, 'agent.md 已在别处被修改，请刷新页面查看最新内容后再保存。');
}

export async function writeAgentMd(file: string, content: string): Promise<{ before: number; after: number }> {
  const text = content.replace(/\r\n?/g, '\n');
  const bytes = Buffer.byteLength(text);
  if (bytes > AGENT_MD_MAX_BYTES) throw new HttpError(400, `agent.md 超过 ${AGENT_MD_MAX_BYTES / 1024} KB 上限`);
  if (!text.trim()) throw new HttpError(400, 'agent.md 不能为空');
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const dst = await fs.lstat(dir);
  if (!dst.isDirectory() || dst.isSymbolicLink()) throw new HttpError(400, 'prompts 目录不可为链接');
  let before = 0;
  try { const st = await fs.lstat(file); if (!st.isFile() || st.isSymbolicLink()) throw new HttpError(400, 'agent.md 不是普通文件'); before = st.size; }
  catch (e) { if (e instanceof HttpError) throw e; }
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => undefined); }
  return { before, after: bytes };
}

/** 子路由注入同源和表单校验，避免子目录反向依赖 HTTP 组合层。 */
export async function validateDashboardPost(req: IncomingMessage, host: string, csrf: string): Promise<void> {
  guardDashboardOrigin(req, host);
  const form = await readBody(req);
  if (!csrf || form.getAll('_csrf').length !== 1 || !equal(form.get('_csrf') ?? '', csrf)) throw new HttpError(403, 'CSRF 令牌无效');
}

/** 页面内部读取与浏览器相同的 JSON 路由；不启动 HTTP 请求。 */
export async function readDashboardJson(pathQuery: string, route: (url: URL, res: ServerResponse) => Promise<void>): Promise<{ status: number; body: unknown }> {
  let text = '';
  const res = { statusCode: 200, headersSent: false, destroyed: false, writableEnded: false,
    setHeader() { return res; }, getHeader() { return undefined; }, on() { return res; }, once() { return res; }, off() { return res; },
    writeHead(status: number) { res.statusCode = status; res.headersSent = true; return res; },
    write(chunk: unknown) { text += String(chunk); return true; },
    end(chunk?: unknown) { if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) text += String(chunk); res.headersSent = true; res.writableEnded = true; return res; } };
  await route(new URL(pathQuery, 'http://localhost'), res as unknown as ServerResponse);
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  return { status: res.statusCode, body };
}
