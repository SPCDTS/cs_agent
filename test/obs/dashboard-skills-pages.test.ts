import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
const token = 'dashboard-skills-pages-token';
async function rig(enabled = true) {
  const root = tmp('dashboard-skills-pages-'), dir = path.join(root, 'skills');
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
  const get = (url: string) => fetch(base + url, { headers: { Cookie: 'obs_token=' + token }, redirect: 'manual' });
  const write = async (file: string, text: string) => { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), text); };
  return { dir, base, csrf: csrfToken(token), get, write };
}
const LONG = '长'.repeat(130);

describe('技能页面', () => {
  it('列表页：转义描述、截断、诊断、hidden 标记、下载链接与带 csrf 的删除表单', async () => {
    const r = await rig();
    await r.write('hello/SKILL.md', '---\nname: hello\ndescription: <b>粗体</b> & "引号"\n---\n正文');
    await r.write('hello/scripts/run.sh', 'echo hi');
    await r.write('secret/SKILL.md', '---\nname: secret\ndescription: 隐藏技能\ndisable-model-invocation: true\n---\n');
    await r.write('long/SKILL.md', `---\nname: long\ndescription: ${LONG}\n---\n`);
    await fs.mkdir(path.join(r.dir, 'nomd'));
    const res = await r.get('/skills');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>技能</h1>');
    expect(html).toContain('href="/skills" aria-current="page"');
    expect(html).toContain('<form method="post" action="/skills/upload" enctype="multipart/form-data" class="sheet pad">');
    expect(html).toContain(`<input type="hidden" name="_csrf" value="${r.csrf}">`);
    expect(html).toContain('<input type="file" name="file" accept=".zip,.md"');
    expect(html).toContain('<input type="checkbox" name="overwrite">');
    expect(html).toContain('上限 20 MiB');
    expect(html).toContain('&lt;b&gt;粗体&lt;/b&gt; &amp; &quot;引号&quot;');
    expect(html).not.toContain('<b>粗体</b>');
    expect(html).toContain('长'.repeat(120) + '…');
    expect(html).not.toContain('长'.repeat(121));
    expect(html).toContain('<a class="mono" href="/skills/hello">hello</a>');
    expect(html).toContain('2 个 / ');
    expect(html).toMatch(/<a class="mono" href="\/skills\/secret">secret<\/a>.*?不列入提示/);
    expect(html).toMatch(/<a class="mono" href="\/skills\/nomd">nomd<\/a>.*?<span class="changed">缺少 SKILL\.md<\/span>/);
    expect(html).toContain('href="/skills/hello.zip">下载</a>');
    expect(html).toContain(`<form method="post" action="/skills/hello/delete"><input type="hidden" name="_csrf" value="${r.csrf}"><button class="danger">删除</button></form>`);
    expect(html).not.toContain('confirm');
    expect(html).toContain('SKILLS_DIR');
    expect(html).not.toMatch(/<script(?![^>]*type="module")/);
    expect(html).not.toContain('style="');
  });
  it('空目录与未注入 SkillsStore 的文案', async () => {
    expect(await (await (await rig()).get('/skills')).text()).toContain('技能目录还是空的');
    const off = await rig(false);
    const res = await off.get('/skills');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('技能目录已禁用（PI_SKILLS_DIR=off）');
    expect(html).not.toContain('action="/skills/upload"');
    expect((await off.get('/skills/hello')).status).toBe(404);
  });
  it('详情页：面包屑、SKILL.md 转义、文件表、下载与删除', async () => {
    const r = await rig();
    await r.write('hello/SKILL.md', '---\nname: hello\ndescription: 说明\n---\n<script>alert(1)</script>');
    await r.write('hello/refs/a.txt', 'x'.repeat(2048));
    const res = await r.get('/skills/hello');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<nav class="crumbs" aria-label="位置"><a href="/skills">技能</a>');
    expect(html).toContain('<pre class="mono">---\nname: hello\ndescription: 说明\n---\n&lt;script&gt;alert(1)&lt;/script&gt;</pre>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('<td class="mono">SKILL.md</td>');
    expect(html).toContain('<td class="mono">refs/a.txt</td><td class="num">2.0 KB</td>');
    expect(html).toContain('href="/skills/hello.zip">下载</a>');
    expect(html).toContain(`<form method="post" action="/skills/hello/delete"><input type="hidden" name="_csrf" value="${r.csrf}">`);
  });
  it('非法名称、不存在或缺少 SKILL.md 的技能返回 404 页', async () => {
    const r = await rig();
    await fs.mkdir(path.join(r.dir, 'nomd'), { recursive: true });
    for (const name of ['UPPER', 'a%2Fb', 'a%5Cb', '%00', '%ZZ', 'missing', 'nomd', 'a/b']) {
      const res = await r.get('/skills/' + name);
      expect(res.status, name).toBe(404);
      const html = await res.text();
      expect(html).toContain('没有这个页面');
      expect(html).toContain('没有这个技能');
    }
  });
  it('FLASH detail 以转义后的 <small> 显示在提示文案之后', async () => {
    const r = await rig();
    const html = await (await r.get('/skills?' + new URLSearchParams({ ok: 'skillsUploaded', detail: '导入 1 个：<i>x</i>。' }))).text();
    expect(html).toContain('技能上传已处理，下一条消息生效。 <small>导入 1 个：&lt;i&gt;x&lt;/i&gt;。</small></div>');
    const deleted = await (await r.get('/skills?ok=skillsDeleted&detail=ignored')).text();
    expect(deleted).toContain('技能已删除，下一条消息生效。</div>');
    expect(deleted).not.toContain('ignored');
  });
});
