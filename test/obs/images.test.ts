import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore, type MediaRow } from '../../src/context/store.js';
import { MediaRecall } from '../../src/context/media.js';
import { normalizeMessage } from '../../src/qq/policy.js';
import { createDashboard } from '../../src/obs/http.js';
import { imageBinary } from '../../src/obs/memory/images.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';
import { ObsStore } from '../../src/obs/store.js';
import { PNG_1PX as PNG } from '../agent/helpers.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const JPEG = Buffer.from([255,216,255,192,0,8,8,0,1,0,1,0]);
const WEBP = Buffer.alloc(30);
WEBP.write('RIFF'); WEBP.writeUInt32LE(22, 4); WEBP.write('WEBPVP8X', 8); WEBP.writeUInt32LE(10, 16);
const TOKEN = 'images-fixture-password', G = 'group:123', NOW = 1792281600000;
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of clean.splice(0).reverse()) await fn(); });

async function rig() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-gallery-')));
  const context = new ContextStore(dir), store = new ObsStore(dir);
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN }), context, store,
    codex: async () => [], pi: async () => ({}), health: () => ({}), queue: () => ({}), sessionAdapters: {} });
  const server = createServer(dashboard.handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    context.close(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const get = (url: string, auth = true, method = 'GET') => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${url}`,
    { method, headers: auth ? { Cookie: `obs_token=${TOKEN}` } : {}, redirect: 'manual' });
  const json = async (url: string) => { const res = await get(url); return { status: res.status, body: await res.json() }; };
  const file = async (bytes = PNG, ext = 'png') => {
    const sha256 = createHash('sha256').update(bytes).digest('hex'), target = path.join(dir, 'media', sha256.slice(0, 2), `${sha256}.${ext}`);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    return { path: target, sha256 };
  };
  const add = (id: string, media: Partial<MediaRow>[] = [{}], scope = G, time = NOW, text = '<img onerror=alert(1)> token=hidden-value') => {
    context.ingest(normalizeMessage({ post_type: 'message', message_type: 'group', group_id: scope.slice(6),
      user_id: '456', self_id: '999', message_id: id, time: time / 1000, sender: { nickname: '<img onerror=alert(2)>' },
      message: [{ type: 'text', data: { text } }] })!);
    const row = context.message({ kind: 'scope', scope }, id)!.row;
    context.saveMedia(row, media.map((m, n) => ({ scope, message_id: id, ordinal: n + 1, status: 'skipped',
      sha256: null, path: null, reason: null, created_at: time / 1000, ...m })), row.text);
  };
  return { dir, context, get, json, file, add };
}

describe('图片记忆 API 和页面', () => {
  it('过滤和稳定分页，所有筛选总计包含已清理与 skipped，元数据不推测', async () => {
    const r = await rig(), f = await r.file();
    for (let n = 0; n < 53; n++) r.add(`m${n}`, [{ ...f, status: 'ok' }], G, NOW + n * 1000);
    r.add('skip'); r.add('other', [{}], 'group:789');
    r.add('gone', [{ status: 'ok', path: path.join(r.dir, 'media', 'aa', `${'a'.repeat(64)}.png`), sha256: 'a'.repeat(64) }]);
    const first = await r.json('/api/memory/images');
    expect(first.status).toBe(200); expect(first.body.items).toHaveLength(50); expect(first.body.has_more).toBe(true);
    expect(first.body.totals).toEqual({ ok: 54, skipped: 2, bytes: PNG.length * 53 });
    expect(first.body.items[0]).toMatchObject({ message_id: 'm52', bytes: PNG.length, present: true, mime: null, width: null, height: null,
      href: `/media/${f.sha256}`, thumb_href: `/media/${f.sha256}` });
    const second = await r.json('/api/memory/images?page=1');
    expect(second.body.items).toHaveLength(6); expect(second.body.has_more).toBe(false); expect(second.body.totals).toEqual(first.body.totals);
    expect(new Set([...first.body.items, ...second.body.items].map(i => `${i.scope}/${i.message_id}/${i.ordinal}`)).size).toBe(56);
    expect(second.body.items.find((i: { message_id: string }) => i.message_id === 'gone')).toMatchObject({ present: false, href: null, bytes: null });
    expect((await r.json('/api/memory/images?scope=group:123&status=skipped')).body.totals).toEqual({ ok: 0, skipped: 1, bytes: 0 });
    expect((await r.json(`/api/memory/images?since=${NOW + 50_000}`)).body.items).toHaveLength(3);
    expect((await r.json('/api/memory/images?since=2026-10-18')).body.totals).toEqual(first.body.totals);
    expect((await r.json('/api/memory/images?page=2')).body.items).toEqual([]);
    expect((await r.json('/api/memory/images?scope=group:404')).body.totals).toEqual({ ok: 0, skipped: 0, bytes: 0 });
    expect((await r.json('/api/memory/images?scope=&status=&since=&page=')).body.totals).toEqual(first.body.totals);
  });

  it.each(['status=bad', 'since=2026-02-30', 'page=-1', 'page=1000001', 'scope=..', 'extra=1', 'page=0&page=1'])('拒绝非法或重复参数 %s', async q => {
    const r = await rig(); expect((await r.get('/api/memory/images?' + q)).status).toBe(400);
  });

  it('详情精确匹配三元组、单列同消息媒体和时间线，脱敏先于摘录裁剪', async () => {
    const r = await rig(), f = await r.file(); clean.push(registerTemporarySecrets(['cross-boundary-secret']));
    r.add('same', [{ ...f, status: 'ok' }, {}], G, NOW, 'x'.repeat(110) + 'cross-boundary-secret' + 'z'.repeat(40));
    r.add('same', [{}], 'group:789');
    const d = await r.json('/api/memory/images/group%3A123/same/1');
    expect(d.status).toBe(200); expect(d.body.item.excerpt.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(d.body)).not.toContain('cross-boundary'); expect(JSON.stringify(d.body)).not.toContain(r.dir);
    expect(d.body.other_media).toHaveLength(1); expect(d.body.other_media[0]).toMatchObject({ ordinal: 2, status: 'skipped', scope: G });
    expect(d.body.timeline_href).toBe(`/memory/scopes/group%3A123?from=${NOW - 3600_000}&to=${NOW + 3600_000}#messages`);
    for (const suffix of ['group:404/same/1', 'group:123/missing/1', 'group:123/same/3'])
      expect((await r.get('/api/memory/images/' + suffix)).status).toBe(404);
    for (const suffix of ['group:123/same/-1', 'group:123/same/1?extra=1', '%ZZ/same/1'])
      expect((await r.get('/api/memory/images/' + suffix)).status).toBe(400);
  });

  it('画廊与详情使用 CSP、懒加载、转义、总数、跳过和清理占位，返回链接及分页保留筛选', async () => {
    const r = await rig(), f = await r.file();
    r.add('x', [{ ...f, status: 'ok' }, {}, { ...f, status: 'ok', path: null }]);
    for (let n = 0; n < 51; n++) r.add(String(n));
    const res = await r.get('/memory/images?scope=group%3A123&since=2026-10-18'), html = await res.text();
    expect(res.status).toBe(200); expect(html).toContain('画廊只展示模型通过 qq_image 召回并入库的图片，不会主动下载');
    expect(html).toContain('scope=group%3A123&amp;since=2026-10-18&amp;page=1');
    const last = await (await r.get('/memory/images?page=1')).text();
    expect(last).toContain(`src="/media/${f.sha256}"`); expect(last).toContain('loading="lazy"');
    expect(last).toContain('文件已清理'); expect(last).toContain('已跳过 · 未入库'); expect(last).toContain('消息时间线');
    expect(last).not.toContain('<img onerror'); expect(last).toContain('&lt;img onerror'); expect(last).not.toContain('hidden-value');
    const nonce = /<style nonce="([^"]+)"/.exec(html)![1];
    expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
    for (const m of html.matchAll(/<style[^>]*>/g)) expect(m[0]).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/\sstyle="/);
    const detail = await (await r.get('/memory/images/group%3A123/x/1')).text();
    expect(detail).toContain('image-large'); expect(detail).toContain('同消息其它图片'); expect(detail).toContain('返回本会话画廊');
    expect(detail).not.toContain('<img onerror'); expect(detail).not.toContain('hidden-value');
    expect((await r.get('/memory/images/group:123/missing/1')).status).toBe(404);
    expect(await (await r.get('/memory')).text()).toContain('共 54 张（含已跳过）');
  });

  it('已登记的越界路径不取元数据或提供字节，撤回和清理后不再提供图片', async () => {
    const r = await rig(), f = await r.file();
    r.add('bad', [{ ...f, path: path.join(r.dir, 'outside.png'), status: 'ok' }]);
    await fs.writeFile(path.join(r.dir, 'outside.png'), PNG);
    expect((await r.json('/api/memory/images')).body.items[0]).toMatchObject({ present: false, bytes: null, href: null });
    expect((await r.get('/media/' + f.sha256)).status).toBe(404);
    r.add('good', [{ ...f, status: 'ok' }]);
    await fs.unlink(f.path);
    expect((await r.get('/media/' + f.sha256)).status).toBe(404);
    expect((await r.json('/api/memory/images/group:123/good/1')).body.item.present).toBe(false);
  });
});

describe('已鉴权的媒体字节路由', () => {
  it('鉴权、非法 sha、未登记路径和只读方法限制', async () => {
    const r = await rig(), f = await r.file();
    for (const url of ['/media/' + f.sha256, '/api/memory/images', '/memory/images']) expect((await r.get(url, false)).status).toBe(401);
    expect((await r.get('/media/' + f.sha256)).status).toBe(404);
    for (const sha of ['bad', 'z'.repeat(64), 'a'.repeat(63), '%252e%252e', 'a/b']) expect((await r.get('/media/' + sha)).status).toBe(400);
    expect((await r.get('/media/' + f.sha256, true, 'POST')).status).toBe(405);
    expect((await r.get('/api/memory/images', true, 'POST')).status).toBe(405);
  });

  it.each([[PNG, 'png'], [JPEG, 'jpeg'], [GIF, 'gif'], [WEBP, 'webp']] as const)('魔数决定 MIME（%s / %s），不信任扩展名', async (bytes, mime) => {
    const r = await rig(), f = await r.file(bytes, 'png'); r.add('m', [{ ...f, status: 'ok' }]);
    const res = await r.get('/media/' + f.sha256.toUpperCase());
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toBe('image/' + mime);
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('未知魔数 415，哈希不一致 404', async () => {
    const r = await rig(), bad = await r.file(Buffer.from('not-an-image-at-all')); r.add('m', [{ ...bad, status: 'ok' }]);
    expect((await r.get('/media/' + bad.sha256)).status).toBe(415);
    const f = await r.file(); r.add('n', [{ ...f, status: 'ok' }]);
    await fs.writeFile(f.path, Buffer.concat([PNG, Buffer.from('changed')]));
    expect((await r.get('/media/' + f.sha256)).status).toBe(404);
  });

  it('桩 store 仅允许登记查询，拒绝时连文件正文都不读，浏览过程不调用召回', async () => {
    const r = await rig(), f = await r.file();
    const recall = vi.spyOn(MediaRecall.prototype, 'recall').mockRejectedValue(new Error('禁止召回'));
    const stub = { mediaPathReferenced: vi.fn(() => false) };
    const read = vi.spyOn(fs, 'readFile');
    await expect(imageBinary(r.dir, stub, f.sha256)).rejects.toMatchObject({ status: 404 });
    expect(read).not.toHaveBeenCalled(); expect(stub.mediaPathReferenced).toHaveBeenCalledTimes(4);
    read.mockRestore(); r.add('m', [{ ...f, status: 'ok' }]);
    await r.get('/api/memory/images'); await r.get('/memory/images'); await r.get('/media/' + f.sha256);
    expect(recall).not.toHaveBeenCalled();
  });
});
