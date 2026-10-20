import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { SkillsStore } from '../../src/agent/skills-store.js';
import { SkillsLoader } from '../../src/agent/pi-tools/skills.js';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { ContextStore } from '../../src/context/store.js';
import { csrfToken } from '../../src/obs/http-util.js';
import { loadConfig } from '../../src/config.js';
import { tmp } from '../agent/helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'dashboard-skills-test-token';
const md = (description = '技能说明') => `---\nname: hello\ndescription: ${description}\n---\n正文`;
async function rig(enabled = true) {
  const root = tmp('dashboard-skills-'), dir = path.join(root, 'skills');
  const skills = new SkillsStore({ dir, loader: new SkillsLoader({ dir }) });
  const store = new ObsStore(root), context = new ContextStore(root);
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: root, OBS_TOKEN: token }), store, context,
    ...(enabled ? { skills } : {}), health: () => ({}), queue: () => ({}), codex: async () => ({}), pi: async () => ({}) });
  const server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  cleanup.push(async () => {
    await dashboard.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); context.close(); await fs.rm(root, { recursive: true, force: true });
  });
  const csrf = csrfToken(token), cookie = 'obs_token=' + token;
  const get = (url: string) => fetch(base + url, { headers: { Cookie: cookie }, redirect: 'manual' });
  const upload = (data: string | Uint8Array = md(), filename = 'SKILL.md', fields: Record<string, string> = { _csrf: csrf }, headers: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: 'application/octet-stream' }), filename);
    return fetch(base + '/skills/upload', { method: 'POST', body: form, headers: { Cookie: cookie, ...headers }, redirect: 'manual' });
  };
  const remove = (name = 'hello', value = csrf) => fetch(base + `/skills/${name}/delete`, { method: 'POST', body: new URLSearchParams({ _csrf: value }), headers: { Cookie: cookie }, redirect: 'manual' });
  return { skills, dir, base, csrf, cookie, get, upload, remove };
}

describe('技能非 HTML 端点', () => {
  it('上传 Markdown、下载 ZIP 头和内容、删除并 303 返回技能页', async () => {
    const r = await rig();
    const upload = await r.upload();
    expect(upload.status).toBe(303); expect(upload.headers.get('location')).toContain('/skills?ok=skillsUploaded');
    const downloaded = await r.get('/skills/hello.zip');
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toBe('application/zip');
    expect(downloaded.headers.get('content-disposition')).toBe('attachment; filename="hello.zip"');
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
    expect(downloaded.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(Buffer.from(unzipSync(new Uint8Array(await downloaded.arrayBuffer()))['hello/SKILL.md']).toString()).toBe(md());
    const deleted = await r.remove();
    expect(deleted.status).toBe(303); expect(deleted.headers.get('location')).toBe('/skills?ok=skillsDeleted');
    expect((await r.get('/skills/hello.zip')).status).toBe(404);
    expect((await r.remove()).status).toBe(404);
  });
  it('ZIP 部分导入附带跳过原因，覆盖只有 overwrite=on 才生效', async () => {
    const r = await rig();
    const bytes = zipSync({ 'hello/SKILL.md': strToU8(md()), 'invalid/SKILL.md': strToU8('---\nname: invalid\n---') });
    const response = await r.upload(bytes, 'skills.zip');
    expect(response.status).toBe(303);
    const detail = new URL(response.headers.get('location')!, r.base).searchParams.get('detail');
    expect(detail).toContain('导入 1 个'); expect(detail).toContain('跳过 1 个'); expect(detail).toContain('description is required');
    expect((await r.upload(md('新版'))).status).toBe(409);
    expect((await r.upload(md('新版'), 'other.md', { _csrf: r.csrf, overwrite: 'true' })).status).toBe(409);
    expect((await r.upload(md('新版'), 'other.md', { _csrf: r.csrf, overwrite: 'on' })).status).toBe(303);
    expect(await r.skills.readSkillMd('hello')).toContain('新版');
  });
  it('上传和删除强制 cookie、CSRF 与同源，URL token 不授权写入', async () => {
    const r = await rig();
    expect((await r.upload(md(), 'SKILL.md', {})).status).toBe(403);
    expect((await r.upload(md(), 'SKILL.md', { _csrf: 'wrong' })).status).toBe(403);
    expect((await r.upload(md(), 'SKILL.md', { _csrf: r.csrf }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await r.upload(md(), 'SKILL.md', { _csrf: r.csrf }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await r.upload(md(), 'SKILL.md', { _csrf: r.csrf }, { Cookie: '' })).status).toBe(401);
    expect((await fetch(r.base + '/skills/upload?token=' + token, { method: 'POST', redirect: 'manual' })).status).toBe(401);
    expect(await r.skills.list()).toEqual([]);
    await r.upload();
    expect((await r.remove('hello', '')).status).toBe(403);
    expect((await fetch(r.base + '/skills/hello.zip')).status).toBe(401);
    expect(await r.skills.list()).toHaveLength(1);
  });
  it('非法类型、无文件、坏 UTF-8、ZIP slip 和非法路由名不落盘', async () => {
    const r = await rig();
    expect((await r.upload('bad', 'x.exe')).status).toBe(415);
    expect((await r.upload('bad', 'x.zip')).status).toBe(415);
    expect((await r.upload(new Uint8Array([255]))).status).toBe(400);
    expect((await r.upload(zipSync({ '../evil': strToU8('x') }), 'x.zip')).status).toBe(400);
    const form = new FormData(); form.append('_csrf', r.csrf);
    expect((await fetch(r.base + '/skills/upload', { method: 'POST', body: form, headers: { Cookie: r.cookie } })).status).toBe(400);
    for (const name of ['a%2Fb', 'a%5Cb', '%00', '%ZZ', 'UPPER']) {
      expect((await r.remove(name)).status).toBe(400);
      expect((await r.get(`/skills/${name}.zip`)).status).toBe(400);
    }
    expect(await r.skills.list()).toEqual([]);
  });
  it('真实 HTTP 超过 20 MiB 返回 413，未断开连接或写入', async () => {
    const r = await rig();
    expect((await r.upload('x'.repeat(20 * 1024 * 1024), 'large.md')).status).toBe(413);
    expect(await r.skills.list()).toEqual([]);
  });
  it('未注入 SkillsStore 时下载、上传、删除返回 404', async () => {
    const r = await rig(false);
    expect((await r.get('/skills/hello.zip')).status).toBe(404);
    expect((await r.upload()).status).toBe(404);
    expect((await r.remove()).status).toBe(404);
  });
});
