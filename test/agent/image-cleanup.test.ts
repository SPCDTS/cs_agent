import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpImageBackend, recoverRemoteUploads, TRANSPARENT_PNG } from '../../src/agent/image-gen.js';
import { validateImageHeader } from '../../src/qq/image-header.js';
import { tmp } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
afterEach(() => vi.restoreAllMocks());
const json = (v: unknown) => new Response(JSON.stringify(v));
describe('远端参考图覆盖与恢复', () => {
  it.each([false,true])('collect 成功/失败=%s 后同名覆盖 1x1 透明 PNG', async failed => {
    const root = tmp(), ref = path.join(root,'ref.jpg'), out = path.join(root,'ticket','call-1');
    await fs.writeFile(ref,PNG); const uploaded: Buffer[] = [];
    vi.spyOn(globalThis,'fetch').mockImplementation(async (url,init) => {
      const p = new URL(String(url)).pathname;
      if (p === '/upload/image') {
        const form = init!.body as FormData;
        expect(form.get('overwrite')).toBe('true'); expect(form.get('subfolder')).toBe('ticket-call-1');
        expect(form.get('type')).toBe('input'); expect((form.get('image') as File).name).toBe('ref.jpg');
        // 真实上传前已有 write-ahead 清单，即使上传响应丢失也可恢复。
        expect(JSON.parse(await fs.readFile(path.join(out,'remote-uploads.json'),'utf8'))).toEqual([{ name: 'ref.jpg', subfolder: 'ticket-call-1' }]);
        uploaded.push(Buffer.from(await (form.get('image') as Blob).arrayBuffer()));
        return json({ name: 'ref.jpg', subfolder: 'ticket-call-1' });
      }
      if (p === '/prompt') return json({ prompt_id: 'one' });
      if (p === '/history/one') return json({ one: failed ? { status: { status_str: 'error' } } : { status: { completed: true }, outputs: { a: { images: [{ filename: 'out.png' }] } } } });
      if (p === '/view') return new Response(PNG);
      throw new Error('unexpected fake request');
    });
    const backend = new HttpImageBackend({ baseUrl: 'http://fake.test', timeoutMs: 1000 });
    const result = backend.generate({ prompt: '改色', reference_images: [ref] },out);
    if (failed) await expect(result).rejects.toThrow('任务执行失败'); else expect(await result).toHaveLength(1);
    expect(uploaded).toEqual([PNG,TRANSPARENT_PNG]);
    expect(validateImageHeader(uploaded[1]!)).toEqual({ width: 1,height: 1 });
    expect(uploaded[1]![25]).toBe(6); // RGBA
    await expect(fs.access(path.join(out,'remote-uploads.json'))).rejects.toThrow();
  });
  it('覆盖失败保留清单，恢复时重做同名覆盖后删除清单', async () => {
    const root = tmp(), manifest = path.join(root,'remote-uploads.json');
    await fs.writeFile(manifest,JSON.stringify([{ name: '1.png',subfolder: 'ticket' }]),'utf8');
    const backend = new HttpImageBackend({ baseUrl: 'http://fake.test',timeoutMs: 1000 });
    const fetch = vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(json({ name: '1.png',subfolder: 'ticket' }));
    await expect(recoverRemoteUploads(root,backend)).rejects.toThrow('offline'); expect(await fs.readFile(manifest,'utf8')).toContain('1.png');
    await recoverRemoteUploads(root,backend); expect(fetch).toHaveBeenCalledTimes(2);
    await expect(fs.access(manifest)).rejects.toThrow();
  });
  it('上传前拒绝超大尺寸参考图，不访问 ComfyUI', async () => {
    const root = tmp(), ref = path.join(root,'bomb.png'); const bytes = Buffer.from(PNG); bytes.writeUInt32BE(100000,16); await fs.writeFile(ref,bytes);
    const fetch = vi.spyOn(globalThis,'fetch');
    const backend = new HttpImageBackend({ baseUrl: 'http://fake.test',timeoutMs: 1000 });
    await expect(backend.submit({ prompt: '改色',reference_images: [ref] })).rejects.toThrow('4096'); expect(fetch).not.toHaveBeenCalled();
  });
});
