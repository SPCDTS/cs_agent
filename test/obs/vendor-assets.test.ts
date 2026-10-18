import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { STYLE_INJECT_DISABLED, VENDOR, vendorAsset } from '../../src/obs/ui/vendor.js';

const TOKEN = 'vendor-assets-test-token-0123';
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-vendor-'));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN }), store, context,
    codex: async () => [], pi: async () => ({}), health: () => ({}), queue: () => ({}), sessionAdapters: {} });
  const server = createServer(dashboard.handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); context.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return (url: string, cookie = true) => fetch(base + url, { redirect: 'manual', headers: cookie ? { Cookie: `obs_token=${TOKEN}` } : {} });
}

describe('第三方前端资源 /assets/vendor/*', () => {
  it('白名单两项从 node_modules 读入内存，版本固定、去掉 sourceMappingURL', () => {
    expect(Object.keys(VENDOR).sort()).toEqual(['vis-timeline.css', 'vis-timeline.js']);
    const js = vendorAsset('vis-timeline.js')!.body.toString('utf8');
    expect(js).toContain('@version 8.5.4');
    expect(js).not.toContain('sourceMappingURL');
    // 唯一的 <style> 注入入口被关闭（样式改由同源 CSS 提供，避免无 nonce 的 style 被 CSP 拒绝）。
    expect(STYLE_INJECT_DISABLED).toBe(true);
    expect(js).toContain('if(!1){var n=document.head');
    expect(js).not.toContain('if(t&&"undefined"!=typeof document){var n=document.head');
    expect(vendorAsset('vis-timeline.css')!.body.toString('utf8')).not.toContain('sourceMappingURL');
    expect(vendorAsset('constructor')).toBeUndefined();
    expect(vendorAsset('__proto__')).toBeUndefined();
  });

  it('200 + 正确类型与缓存头；其它名字、路径穿越与未登录均不提供', async () => {
    const get = await rig();
    const js = await get('/assets/vendor/vis-timeline.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await js.text()).toContain('vis-timeline and vis-graph2d');
    const css = await get('/assets/vendor/vis-timeline.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await css.text()).toContain('.vis-timeline');
    for (const bad of ['/assets/vendor/', '/assets/vendor/vis-timeline.js.map', '/assets/vendor/vis-timeline.min.js', '/assets/vendor/../vendor/vis-timeline.js.map',
      '/assets/vendor/%2e%2e%2fpackage.json', '/assets/vendor/..%2F..%2Fpackage.json', '/assets/vendor/constructor', '/assets/constructor', '/assets/vendor/sub/vis-timeline.js'])
      expect((await get(bad)).status, bad).toBe(404);
    expect((await get('/assets/vendor/vis-timeline.js', false)).status).toBe(401);
  });

  it('CSP 只为同源样式表放开 style-src self，脚本仍只认 nonce', async () => {
    const get = await rig();
    const csp = (await get('/memory')).headers.get('content-security-policy')!;
    expect(csp).toMatch(/style-src 'self' 'nonce-[^']+';/);
    expect(csp).toMatch(/script-src 'nonce-[^']+';/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("default-src 'none'");
  });
});
