import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';
import { contentSlice } from '../../src/obs/sessions/content.js';
import type { SessionAdapters } from '../../src/obs/sessions/http.js';
import type { ContentRef, SessionAdapter, SessionRef } from '../../src/obs/sessions/types.js';
import { contextBody, type ContextAnalysis } from '../../src/obs/ui/context-view.js';

const TOKEN = 'context-fulltext-test-token-0123';
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

const XSS = '<script>alert(1)</script>';
// 首段超过 10 万字符（验证不被 esc 的 10 万字上限截断），256 KiB 分界落在三字节汉字中间（验证不丢不重）。
const TEXT = `ab${XSS}` + 'x'.repeat(150_000) + '汉'.repeat(50_000);
const BYTES = Buffer.byteLength(TEXT);
const BASE = 64;
const PAGE = 256 * 1024;
const T0 = Date.parse('2026-10-18T08:00:00Z');

class Fake implements SessionAdapter {
  progress = { indexing: false, files: 1, done: 1 };
  readonly backend = 'codex' as const;
  readonly sessions: SessionRef[] = [
    { backend: 'codex', id: 'sess-1', label: '测试会话', scope: 'group:1', status: 'active', started: T0, updated: T0, turns: 0 },
    { backend: 'codex', id: 'boom', label: 'boom', scope: 'owner', status: 'active', started: T0, updated: T0, turns: 0 },
  ];
  async listSessions() { return this.sessions; }
  async turns() { return []; }
  async blocks() { return []; }
  async content(ref: ContentRef) {
    if (ref.session === 'boom') throw new Error('disk on fire');
    // 与真实适配器相同的切分规则：范围校验（越界 400）+ 按 UTF-8 字符边界切分。
    return contentSlice(TEXT, ref, { session: 'sess-1', offset: BASE, length: BYTES, bytes: BYTES });
  }
  subscribe() { return () => undefined; }
}

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-ctx-fulltext-'));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  const dispose = registerTemporarySecrets([TOKEN]);
  const sessionAdapters = { codex: new Fake() } as unknown as SessionAdapters;
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN }), store, context,
    resetCodex: async () => 'old', resetPi: async () => 1, codex: async () => [], pi: async () => ({ threads: {}, keys: [] }),
    health: () => ({}), queue: () => ({}), sessionAdapters });
  const server = createServer(dashboard.handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); dispose(); store.close(); context.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const get = (url: string) => fetch(base + url, { redirect: 'manual', headers: { Cookie: `obs_token=${TOKEN}` } });
  const page = async (url: string) => { const res = await get(url); return { res, html: await res.text() }; };
  return { get, page };
}

function safe(html: string, res: Response) {
  expect(html).not.toMatch(/\sstyle="/);
  expect(html).not.toMatch(/(src|href)="https?:/);
  expect(html).not.toContain('<script>alert');
  const nonce = /<style nonce="([^"]+)"/.exec(html)![1]!;
  expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
  for (const m of html.matchAll(/<script[^>]*>/g)) expect(m[0]).toContain(`nonce="${nonce}"`);
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const preText = (html: string) => unescape(/<pre class="mono wrap full">([^]*?)<\/pre>/.exec(html)![1]!);
const url = (q: string) => `/agents/codex/sessions/sess-1/content?${q}`;

describe('正文页 /agents/:backend/sessions/:id/content', () => {
  it('渲染面包屑、kv、转义的 <pre> 与"下一段"链接；首段超过 10 万字不截断', async () => {
    const r = await rig();
    const { res, html } = await r.page(url(`offset=${BASE}&length=${BYTES}`));
    expect(res.status).toBe(200); safe(html, res);
    expect(html).toMatch(/<nav class="crumbs"[^>]*><a href="\/agents">Agent<\/a>.*<a href="\/agents\/codex\/sessions">.*<a href="\/agents\/codex\/sessions\/sess-1">测试会话<\/a>.*<span aria-current="page">正文<\/span><\/nav>/);
    expect(html).toContain('<dt>区间</dt><dd>offset <span class="mono">64</span> · length <span class="mono">300,027</span></dd>');
    expect(html).toContain('第 1 / 2 段');
    expect(html).toContain('<dt>来源会话</dt><dd><a href="/agents/codex/sessions/sess-1">测试会话</a> <code class="mono">sess-1</code>');
    expect(html).toContain('ab&lt;script&gt;alert(1)&lt;/script&gt;xxx');
    const first = preText(html);
    expect(first.length).toBeGreaterThan(100_000);
    expect(first.endsWith('…')).toBe(false);
    expect(html).toContain(`href="/agents/codex/sessions/sess-1/content?offset=${BASE}&amp;length=${BYTES}&amp;page=1">下一段</a>`);
    expect(html).not.toContain('上一段');
  });

  it('分段按字节寻址：两段拼接与原文逐字节相同，跨界汉字不丢不重；末段只有"上一段"', async () => {
    const r = await rig();
    const p0 = await r.page(url(`offset=${BASE}&length=${BYTES}`));
    const p1 = await r.page(url(`offset=${BASE}&length=${BYTES}&page=1`));
    expect(p1.res.status).toBe(200); safe(p1.html, p1.res);
    const a = preText(p0.html), b = preText(p1.html);
    expect(Buffer.byteLength(a)).toBeGreaterThan(PAGE); // 跨界字符归前一段
    expect(a + b).toBe(TEXT);
    expect(Buffer.byteLength(a) + Buffer.byteLength(b)).toBe(BYTES);
    expect(p1.html).toContain('第 2 / 2 段');
    expect(p1.html).toContain(`href="/agents/codex/sessions/sess-1/content?offset=${BASE}&amp;length=${BYTES}">上一段</a>`);
    expect(p1.html).not.toContain('下一段');
  });

  it('区间起点落在字符中间、长度越过正文末尾 3 字节：跳过续字节读到末尾，单段不给"下一段"', async () => {
    const r = await rig();
    const { res, html } = await r.page(url(`offset=${BASE + PAGE}&length=${BYTES - PAGE + 3}`));
    expect(res.status).toBe(200);
    expect(html).not.toContain('下一段');
    expect(TEXT.endsWith(preText(html))).toBe(true);
  });

  it('参数非法返回 404', async () => {
    const r = await rig();
    for (const q of ['', `length=${BYTES}`, `offset=${BASE}`, `offset=-1&length=10`, `offset=${BASE}&length=0`, `offset=${BASE}&length=abc`,
      `offset=1.5&length=10`, `offset=${BASE}&length=1e3`, `offset=99999999999999999&length=10`, `offset=${BASE}&length=${BYTES}&page=-1`,
      `offset=${BASE}&length=${BYTES}&page=2`, `offset=${BASE}&length=${BYTES}&page=x`])
      expect((await r.get(url(q))).status, q).toBe(404);
  });

  it('接口 400/404 → 404 页；其他错误 → flash err', async () => {
    const r = await rig();
    expect((await r.get(url('offset=0&length=10'))).status).toBe(404); // 不在已索引正文块内（接口 400）
    expect((await r.get('/agents/codex/sessions/missing/content?offset=64&length=10')).status).toBe(404);
    const { res, html } = await r.page('/agents/codex/sessions/boom/content?offset=64&length=10');
    expect(res.status).toBe(200); safe(html, res);
    expect(html).toContain('<div class="flash err" role="alert">读取正文失败：会话读取暂不可用</div>');
    expect(html).not.toContain('<pre');
  });
});

describe('上下文分析逐消息表的"全文"链接', () => {
  const stub: ContextAnalysis = {
    backend: 'codex', session: 'sess-1', at: { turn: 't2', phase: 'after' }, generatedAt: T0,
    window: { tokens: 20_000, source: 'model_context_window' }, estimated: { total: 100, tokenizer: 'o200k_base' },
    categories: [{ key: 'history', label: '历史消息', items: 2, tokens: { estimated: 100 }, provenance: 'recorded' }],
    messages: [
      { index: 0, kind: 'user', category: 'history', provenance: 'recorded', tokens: { estimated: 30 }, preview: '短消息' },
      { index: 1, kind: 'function_call_output', category: 'history', provenance: 'recorded', tokens: { estimated: 70 }, preview: '输出…',
        ref: { session: 'sess-src', offset: 64, length: 9000, bytes: 8000 } },
    ],
    notes: [],
  };

  it('只有 traceRef 的行带编码并转义的全文链接；同时有 ref 时优先区间链接', () => {
    const traceRef = { bundle: 'trace-fixture-sess-1', payload: 'payloads/request.json', select: '/tools/3' };
    const analysis: ContextAnalysis = { ...stub, messages: [
      { ...stub.messages[0], traceRef },
      { ...stub.messages[1], traceRef },
    ] };
    const html = contextBody({ backend: 'codex', session: 'sess-1' }, analysis);
    const short = html.split('<tr>').find(row => row.includes('短消息'))!;
    const long = html.split('<tr>').find(row => row.includes('输出…'))!;
    expect(short).toContain('<a class="btn quiet" href="/agents/codex/sessions/sess-1/content?bundle=trace-fixture-sess-1&amp;payload=payloads%2Frequest.json&amp;select=%2Ftools%2F3">全文</a>');
    expect(short).not.toContain('load-full');
    expect(long).toContain('/sessions/sess-src/content?offset=64&amp;length=9000');
    expect(long).not.toContain('bundle=');
  });

  it('trace 引用中的特殊字符不能注入 HTML 属性或额外查询参数', () => {
    const analysis: ContextAnalysis = { ...stub, messages: [{ ...stub.messages[0],
      traceRef: { bundle: 'trace-"><script>', payload: 'payloads/a.json&offset=1', select: "/tools/0' onclick='bad" },
    }] };
    const html = contextBody({ backend: 'codex', session: 'sess-1' }, analysis);
    expect(html).not.toContain('<script>'); expect(html).not.toContain(' onclick=');
    expect(html).toContain('bundle=trace-%22%3E%3Cscript%3E');
    expect(html).toContain('payload=payloads%2Fa.json%26offset%3D1');
    expect(html).toContain('select=%2Ftools%2F0&#39;%20onclick%3D&#39;bad');
  });

  it('有 ref 的行带指向来源会话的全文链接（length 取 ref.length）并保留原地展开按钮；无 ref 的行不带；表头说明预览', () => {
    const html = contextBody({ backend: 'codex', session: 'sess-1' }, stub);
    const rows = html.split('<tr>').slice(1);
    const short = rows.find(x => x.includes('短消息'))!, long = rows.find(x => x.includes('输出…'))!;
    expect(short).not.toContain('全文');
    expect(long).toContain('<a class="btn quiet" href="/agents/codex/sessions/sess-src/content?offset=64&amp;length=9000">全文</a>');
    expect(long).toContain('class="quiet load-full" data-session="sess-src" data-offset="64" data-length="9000"');
    expect(html).toContain('预览 240 字；点全文查看完整正文');
    expect(html).not.toMatch(/\sstyle="/);
  });
});
