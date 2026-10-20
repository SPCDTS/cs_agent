import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { CodexSessionAdapter } from '../../src/obs/sessions/codex-adapter.js';
import { RESPONSE_BYTES } from '../../src/obs/sessions/content.js';
import type { SessionAdapter, TraceContentRef } from '../../src/obs/sessions/types.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';

const TOKEN = 'trace-content-dashboard-token', SECRET = 'trace-content-private-value';
const SESSION = 'trace-session', BUNDLE = `trace-20261020T080000-${SESSION}`;
const REF: TraceContentRef = { bundle: BUNDLE, payload: 'payloads/request.json', select: '/instructions' };
const INSTRUCTIONS = '  { "说明": "保留空白和换行" }\r\n<script>alert("正文")</script>\n';
const TOOL = { type: 'function', name: 'lookup', parameters: { password: 'hidden-password', description: '完整工具定义' } };
const INPUT = { type: 'message', role: 'user', content: '仅在 trace 中的输入' };
const OUTPUT = { type: 'message', role: 'assistant', content: `回答 ${SECRET}` };
const clean: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
const query = (ref: Partial<TraceContentRef> = {}) => new URLSearchParams({ ...REF, ...ref }).toString();
const apiUrl = (q = query(), backend = 'codex', id = SESSION) => `/api/agents/${backend}/sessions/${id}/trace-content?${q}`;
const pageUrl = (q = query(), backend = 'codex', id = SESSION) => `/agents/${backend}/sessions/${id}/content?${q}`;
const json = (file: string, data: unknown) => fs.writeFile(file, JSON.stringify(data), 'utf8');

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-trace-content-')), home = path.join(dir, 'codex');
  const payloads = path.join(home, 'trace', BUNDLE, 'payloads');
  await fs.mkdir(payloads, { recursive: true });
  await fs.mkdir(path.join(home, 'sessions'));
  await fs.writeFile(path.join(home, 'sessions', 'rollout.jsonl'), JSON.stringify({
    timestamp: '2026-10-20T08:00:00Z', type: 'session_meta', payload: { id: SESSION },
  }) + '\n', 'utf8');
  await json(path.join(payloads, 'request.json'), { instructions: INSTRUCTIONS, tools: [TOOL], input: [INPUT] });
  await json(path.join(payloads, 'response.json'), { output_items: [OUTPUT] });
  const store = new ObsStore(dir), context = new ContextStore(dir);
  const adapter = new CodexSessionAdapter({ store, codexHome: home, dataDir: dir, pollMs: 60_000 });
  await adapter.refresh();
  const pi: SessionAdapter = {
    async listSessions() { return (await adapter.listSessions()).map(s => ({ ...s, backend: 'pi' as const })); },
    async turns() { return []; }, async blocks() { return []; }, async content() { return ''; },
  };
  const dispose = registerTemporarySecrets([TOKEN, SECRET]);
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, CODEX_HOME: home, OBS_TOKEN: TOKEN }), store, context,
    codex: async () => [], pi: async () => ({}), health: () => ({}), queue: () => ({}), sessionAdapters: { codex: adapter, pi } });
  const server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => {
    await dashboard.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    dispose(); store.close(); context.close(); await fs.rm(dir, { recursive: true, force: true });
  });
  const get = (url: string, init: RequestInit = {}) => fetch(base + url, {
    ...init, redirect: 'manual', headers: { Cookie: `obs_token=${TOKEN}`, ...init.headers },
  });
  return { home, payloads, adapter, pi, base, get };
}

describe('Codex trace 正文接口', () => {
  it.each([
    ['/instructions', 'payloads/request.json', INSTRUCTIONS],
    ['/tools/0', 'payloads/request.json', JSON.stringify({ ...TOOL, parameters: { ...TOOL.parameters, password: '[已隐藏]' } })],
    ['/input/0', 'payloads/request.json', JSON.stringify(INPUT)],
    ['/output_items/0', 'payloads/response.json', JSON.stringify({ ...OUTPUT, content: '回答 [已隐藏]' })],
  ])('合法节点 %s 返回完整正文、保留字符串原样并按字段脱敏', async (select, payload, text) => {
    const r = await rig(), response = await r.get(apiUrl(query({ select, payload })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text, truncated: false });
  });

  it('字符串数组项原样返回，空字符串与 null 节点不误报不存在', async () => {
    const r = await rig();
    const raw = ' { "text": "空格" }\r\n';
    await json(path.join(r.payloads, 'request.json'), { instructions: '', tools: [null], input: [raw] });
    for (const [select, text] of [['/instructions', ''], ['/tools/0', 'null'], ['/input/0', raw]]) {
      const response = await r.get(apiUrl(query({ select })));
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ text, truncated: false });
    }
  });

  it('要求 cookie 鉴权且仅支持 GET', async () => {
    const r = await rig();
    expect((await fetch(r.base + apiUrl())).status).toBe(401);
    const post = await r.get(apiUrl(), { method: 'POST' });
    expect(post.status).toBe(405); expect(post.headers.get('allow')).toBe('GET');
  });

  it('跨会话 bundle 与目录穿越返回 400，即使目标负载存在也不读取', async () => {
    const r = await rig(), other = 'trace-20261020T080000-other-session';
    await fs.mkdir(path.join(r.home, 'trace', other, 'payloads'), { recursive: true });
    await json(path.join(r.home, 'trace', other, 'payloads', 'request.json'), { instructions: '不应读取的其它会话' });
    for (const bundle of [other, '../' + BUNDLE, BUNDLE + '/child', BUNDLE + '\\child', 'trace-' + SESSION, BUNDLE + '\n', 'trace-a_b-' + SESSION]) {
      const response = await r.get(apiUrl(query({ bundle })));
      expect(response.status, bundle).toBe(400);
      expect(await response.text()).not.toContain('不应读取');
    }
    await expect(r.adapter.traceContent(SESSION, { ...REF, bundle: other })).rejects.toMatchObject({ status: 400 });
  });

  it('payload 只允许 payloads 下的 JSON 文件白名单', async () => {
    const r = await rig();
    for (const payload of ['../request.json', 'payloads/../request.json', 'payloads/sub/request.json', '/payloads/request.json',
      'payloads\\request.json', 'payloads/request.txt', 'payloads/request.json\n', 'payloads/a%2fb.json', 'payloads/a\u0000.json']) {
      expect((await r.get(apiUrl(query({ payload })))).status, payload).toBe(400);
    }
  });

  it('select 拒绝任意属性、嵌套指针与非法索引格式', async () => {
    const r = await rig();
    for (const select of ['', '/', '/__proto__', '/tools', '/tools/-1', '/tools/1.5', '/tools/1e2',
      '/tools/0/parameters', '/input/length', '/instructions/text', '/instructions\n', '/output_items/0/']) {
      expect((await r.get(apiUrl(query({ select })))).status, select).toBe(400);
    }
  });

  it('缺少、重复或混入 offset/length/page 的参数返回 400', async () => {
    const r = await rig();
    const invalid = ['', 'bundle=' + BUNDLE, ...['bundle', 'payload', 'select'].map(key => {
      const q = new URLSearchParams(query()); q.delete(key); return q.toString();
    }), ...['bundle=x', 'payload=x', 'select=/input/0', 'offset=0', 'length=1', 'page=0'].map(extra => query() + '&' + extra)];
    for (const q of invalid) expect((await r.get(apiUrl(q))).status, q).toBe(400);
  });

  it('不存在的 bundle、负载、节点、越界索引和 pi 后端返回 404', async () => {
    const r = await rig();
    for (const ref of [{ bundle: `trace-missing-${SESSION}` }, { payload: 'payloads/missing.json' },
      { select: '/output_items/0' }, { select: '/tools/1' }, { select: '/input/999' }, { select: '/input/9007199254740992' }]) {
      expect((await r.get(apiUrl(query(ref)))).status, JSON.stringify(ref)).toBe(404);
    }
    // 即使误接入同名能力，pi 路由也不能读取 codex trace。
    r.pi.traceContent = async () => '不应读取';
    expect((await r.get(apiUrl(query(), 'pi'))).status).toBe(404);
    expect((await r.get(apiUrl(query(), 'codex', 'missing'))).status).toBe(404);
    await json(path.join(r.payloads, 'request.json'), { tools: { '0': '不是数组' } });
    expect((await r.get(apiUrl(query({ select: '/tools/0' })))).status).toBe(404);
  });

  it('损坏、目录和超过 smallJson 8 MiB 上限的负载返回 404', async () => {
    const r = await rig(), file = path.join(r.payloads, 'request.json');
    await fs.writeFile(file, '{invalid', 'utf8');
    expect((await r.get(apiUrl())).status).toBe(404);
    await json(file, { instructions: 'x'.repeat(8 * 1024 * 1024) });
    expect((await r.get(apiUrl())).status).toBe(404);
    await fs.mkdir(path.join(r.payloads, 'directory.json'));
    expect((await r.get(apiUrl(query({ payload: 'payloads/directory.json' })))).status).toBe(404);
  });

  it('拒绝经目录链接读取其它位置的负载', async () => {
    const r = await rig(), linked = `trace-linked-${SESSION}`;
    await fs.symlink(path.dirname(r.payloads), path.join(r.home, 'trace', linked), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await r.get(apiUrl(query({ bundle: linked })))).status).toBe(404);
  });

  it('超过 1 MiB 按最终 JSON 字节截断，保留中文字符并标记 truncated', async () => {
    const r = await rig(), text = SECRET + '\n' + '\u0000中文🙂'.repeat(120_000);
    await json(path.join(r.payloads, 'request.json'), { instructions: text });
    const response = await r.get(apiUrl()), bytes = Buffer.from(await response.arrayBuffer());
    const body = JSON.parse(bytes.toString('utf8'));
    expect(response.status).toBe(200); expect(bytes.length).toBeLessThanOrEqual(RESPONSE_BYTES);
    expect(body.truncated).toBe(true); expect(body.text).not.toContain(SECRET);
    expect(body.text).not.toContain('\ufffd'); expect(body.text).toContain('[已隐藏]');
    expect(text.replace(SECRET, '[已隐藏]').startsWith(body.text)).toBe(true);
  });
});

describe('trace 来源的服务端正文页', () => {
  it('渲染 trace 正文与 bundle/payload/select，超过 256 KiB 仍完整展示且不分段', async () => {
    const r = await rig(), text = INSTRUCTIONS + '汉🙂'.repeat(50_000);
    await json(path.join(r.payloads, 'request.json'), { instructions: text });
    const response = await r.get(pageUrl()), html = await response.text();
    expect(response.status).toBe(200);
    for (const [key, value] of Object.entries(REF)) expect(html).toContain(`<dt>${key}</dt><dd><code class="mono">${value}</code></dd>`);
    expect(html).toContain(`<pre class="mono wrap full">  { &quot;说明&quot;: &quot;保留空白和换行&quot; }\r\n&lt;script&gt;alert(&quot;正文&quot;)&lt;/script&gt;\n${'汉🙂'.repeat(50_000)}</pre>`);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('上一段'); expect(html).not.toContain('下一段');
    expect(html).not.toMatch(/\sstyle="/);
    const nonce = /<style nonce="([^"]+)"/.exec(html)![1];
    expect(response.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
    for (const script of html.matchAll(/<script[^>]*>/g)) expect(script[0]).toContain(`nonce="${nonce}"`);
  });

  it('trace 与 offset/length/page 互斥，部分 trace 参数也不能回退到区间形式', async () => {
    const r = await rig();
    for (const extra of ['offset=0', 'length=1', 'offset=0&length=1', 'page=0', 'page=']) {
      expect((await r.get(pageUrl(query() + '&' + extra))).status, extra).toBe(404);
    }
    for (const key of ['bundle', 'payload', 'select'])
      expect((await r.get(pageUrl(`offset=0&length=1&${key}=`))).status, key).toBe(404);
  });

  it('非法或缺失 trace 参数、缺失正文、越界索引及 pi 页面返回 404', async () => {
    const r = await rig();
    for (const q of ['bundle=' + BUNDLE, query({ bundle: '../bad' }), query({ payload: '../bad.json' }),
      query({ select: '/tools/-1' }), query({ select: '/input/99' }), query({ payload: 'payloads/missing.json' }),
      query({ bundle: `trace-missing-${SESSION}` }), query() + '&select=/input/0']) {
      expect((await r.get(pageUrl(q))).status, q).toBe(404);
    }
    expect((await r.get(pageUrl(query(), 'pi'))).status).toBe(404);
  });

  it('响应被截断时显示警告，不提供分段导航', async () => {
    const r = await rig();
    await json(path.join(r.payloads, 'request.json'), { instructions: '汉🙂'.repeat(200_000) });
    const response = await r.get(pageUrl()), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('正文超出单次响应上限，已被服务端截断。');
    expect(html).not.toContain('下一段'); expect(html).not.toContain('上一段');
    expect(html).not.toContain('\ufffd');
  });

  it('接口异常显示已转义错误，空字符串正文仍正常渲染', async () => {
    const r = await rig();
    await json(path.join(r.payloads, 'request.json'), { instructions: '' });
    expect(await (await r.get(pageUrl())).text()).toContain('<pre class="mono wrap full"></pre>');
    r.adapter.traceContent = async () => { throw new Error('private filesystem path'); };
    const response = await r.get(pageUrl()), html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('读取正文失败：会话读取暂不可用');
    expect(html).not.toContain('private filesystem path'); expect(html).not.toContain('<pre');
  });
});
