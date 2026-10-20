import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readMultipart } from '../../src/obs/dashboard-io.js';

const boundary = 'test-boundary';
const part = (name: string, data: string | Buffer, filename?: string, type = 'application/octet-stream') => Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n${filename === undefined ? '' : `Content-Type: ${type}\r\n`}\r\n`),
  Buffer.isBuffer(data) ? data : Buffer.from(data), Buffer.from('\r\n'),
]);
function request(body: Buffer, contentType = `multipart/form-data; boundary="${boundary}"`, chunk = 7): IncomingMessage {
  const pieces = Array.from({ length: Math.ceil(body.length / chunk) }, (_, i) => body.subarray(i * chunk, (i + 1) * chunk));
  return Object.assign(Readable.from(pieces), { headers: { 'content-type': contentType } }) as IncomingMessage;
}
const body = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
const read = (bytes: Buffer) => readMultipart(request(bytes), { maxBytes: 1024 * 1024 });

describe('multipart 上传解析', () => {
  it('单文件和多个字段跨 chunk 解析，保持二进制与 boundary 相似内容', async () => {
    const binary = Buffer.concat([Buffer.from([80, 75, 3, 4, 0, 255]), Buffer.from(`\r\n--${boundary}extra\r\n中文`)]);
    const result = await read(body(part('_csrf', 'token'), part('file', binary, 'skills.zip', 'application/zip'), part('overwrite', 'on')));
    expect([...result.fields]).toEqual([['_csrf', 'token'], ['overwrite', 'on']]);
    expect(result.file).toEqual({ name: 'skills.zip', type: 'application/zip', data: binary });
  });
  it('接受 Markdown 和无文件字段，支持不带引号的 boundary', async () => {
    expect((await read(body(part('file', '中文', 'SKILL.md', 'text/markdown')))).file?.data.toString()).toBe('中文');
    expect((await read(body(part('file', '中文', 'other.md')))).file?.name).toBe('other.md');
    const parsed = await readMultipart(request(body(part('_csrf', 'token')), `multipart/form-data; boundary=${boundary}`), { maxBytes: 1024 });
    expect(parsed.file).toBeUndefined(); expect(parsed.fields.get('_csrf')).toBe('token');
  });
  it('按实际流量限制大小，边界等于上限可解析，超过返回 413', async () => {
    const bytes = body(part('file', 'hello', 'a.md'));
    expect((await readMultipart(request(bytes), { maxBytes: bytes.length })).file).toBeDefined();
    await expect(readMultipart(request(bytes), { maxBytes: bytes.length - 1 })).rejects.toMatchObject({ status: 413 });
  });
  it.each(['bad.exe', 'bad.txt', 'bad.zip'])('非法类型或 ZIP 假签名返回 415：%s', async filename => {
    await expect(read(body(part('file', 'not zip', filename)))).rejects.toMatchObject({ status: 415 });
  });
  it('拒绝多个文件、错误文件字段、重复 CSRF 与路径文件名', async () => {
    for (const bytes of [body(part('file', 'x', 'a.md'), part('file', 'y', 'b.md')), body(part('other', 'x', 'a.md')),
      body(part('_csrf', 'x'), part('_csrf', 'y')), body(part('file', 'x', '../SKILL.md'))]) {
      await expect(read(bytes)).rejects.toMatchObject({ status: 400 });
    }
  });
  it('拒绝错误 Content-Type、缺失 boundary、截断与畸形报文', async () => {
    for (const type of ['text/plain', 'multipart/form-data', 'multipart/form-data; boundary=""']) {
      await expect(readMultipart(request(Buffer.alloc(0), type), { maxBytes: 1000 })).rejects.toMatchObject({ status: 415 });
    }
    for (const bytes of [Buffer.from('garbage'), part('file', 'text', 'a.md'), body(Buffer.from(`--${boundary}\r\ninvalid header\r\n\r\nx\r\n`))]) {
      await expect(read(bytes)).rejects.toMatchObject({ status: 400 });
    }
  });
});
