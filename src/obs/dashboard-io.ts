/** 面板文件与表单边界；路径、大小、版本和秘密检查保持集中。 */
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactText } from '../shared/redact.js';
const MAX_BODY = 512 * 1024;
export const AGENT_MD_MAX_BYTES = 64 * 1024;

export function equal(a: string, b: string): boolean { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
/** URL 每段与 realpath 双重限制，拒绝软链接和跨票据读取；只允许校验过的位图。 */
export async function imageFile(root: string, segments: string[]): Promise<string> {
  if (segments.length < 2 || segments.length > 5 || !/^[A-Za-z0-9_-]{1,128}$/.test(segments[0]!) ||
      segments.some(s => !s || s === '.' || s === '..' || /[\\/:\0]/.test(s))) throw new Error('非法图片路径');
  if (!/\.(png|jpe?g|webp|gif)$/i.test(segments.at(-1)!)) throw new Error('不支持的图片');
  const realRoot = await fs.realpath(root);
  if (realRoot !== path.resolve(root)) throw new Error('图片根目录不可为链接');
  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('图片不可为链接');
  }
  const real = await fs.realpath(current);
  if (path.relative(realRoot, real) !== path.join(...segments)) throw new Error('图片超出目录');
  return real;
}

export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

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
    if (redactText(current, 1_000_000) !== current) throw new HttpError(409, 'agent.md 中包含凭据样式的内容，面板禁止覆盖；请在容器内直接编辑。');
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
