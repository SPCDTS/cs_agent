import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import { createDashboard } from '../../src/obs/http.js';
import { csrfToken } from '../../src/obs/http-util.js';
import { ObsStore } from '../../src/obs/store.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';
import type { SessionAdapters } from '../../src/obs/sessions/http.js';
import type { Block, ContentRef, ObservedTurn, SessionAdapter, SessionFilter, SessionRef } from '../../src/obs/sessions/types.js';
import { contextBody, contextUnavailable, type ContextAnalysis } from '../../src/obs/ui/context-view.js';
import { turnFacts } from '../../src/obs/ui/turn-view.js';
import { ContextUsageStub } from './fixtures/context-usage-stub.js';

const TOKEN = 'agents-pages-test-token-0123';
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

const XSS = '<script>alert(1)</script>';
const LONG = '长正文'.repeat(4000);
const T0 = Date.parse('2026-10-18T08:00:00Z');

/** 回合 t2：两次模型请求（上下文占用取第二次的 5,000，回合累计 6,000）、一次配对的工具调用、引用正文。 */
const BLOCKS: Block[] = [
  { kind: 'user', ts: T0 + 1000, text: `请看 ${XSS}` },
  { kind: 'image', ts: T0 + 1000, text: '[图片]', meta: { source: '[内嵌图片]' } },
  { kind: 'event', ts: T0 + 1100, text: '模型请求', meta: { type: 'model_request', model: 'gpt-test', effort: 'high', request: 1, usage: { input: 1000, output: 10, cached: 800, measured: true } } },
  { kind: 'thinking', ts: T0 + 1200, meta: { unavailable: true } },
  { kind: 'tool_call', ts: T0 + 1300, callId: 'call-1', text: JSON.stringify({ cmd: XSS, n: 1 }), meta: { name: 'exec', server: 'shell', status: 'running', duration_ms: 1500 } },
  { kind: 'tool_result', ts: T0 + 2800, callId: 'call-1', text: `输出 ${XSS}`, meta: { status: 'ok' } },
  { kind: 'event', ts: T0 + 2900, text: '模型请求', meta: { type: 'model_request', model: 'gpt-test', effort: 'high', request: 2, usage: { input: 5000, output: 40, measured: true } } },
  { kind: 'event', ts: T0 + 2900, text: '模型用量', meta: { type: 'model_usage', request: 2, usage: { input: 5000, output: 40, measured: true } } },
  { kind: 'assistant', ts: T0 + 3000, preview: '长正文长正文', ref: { session: 'sess-1', offset: 64, length: Buffer.byteLength(LONG), bytes: Buffer.byteLength(LONG) } },
  { kind: 'compaction', ts: T0 + 3100, text: '压缩摘要', meta: { reason: 'auto' } },
  { kind: 'system_change', ts: T0 + 3200, text: '系统提示已更新' },
  { kind: 'event', ts: T0 + 3300, text: '回合完成', meta: { type: 'turn_complete', status: 'ok' } },
];

class Fake implements SessionAdapter {
  progress = { indexing: true, files: 4, done: 1 };
  constructor(readonly backend: 'codex' | 'pi', readonly sessions: SessionRef[], readonly turnMap: Record<string, ObservedTurn[]> = {}, readonly blockMap: Record<string, Block[]> = {}) {}
  async listSessions(f: SessionFilter = {}) {
    const all = this.sessions.filter(s => (!f.status || s.status === f.status) && (!f.scope || s.scope === f.scope) && (f.since === undefined || s.updated >= f.since));
    return f.page === undefined ? all : all.slice(f.page * 50, (f.page + 1) * 50);
  }
  async turns(id: string) { return this.turnMap[id] ?? []; }
  async blocks(id: string, turn: string) { return this.blockMap[`${id}/${turn}`] ?? []; }
  async content(ref: ContentRef) { return Buffer.from(LONG).subarray(ref.offset - 64, ref.offset - 64 + ref.length).toString('utf8'); }
  subscribe() { return () => undefined; }
}

function adapters(): SessionAdapters {
  const codex = new Fake('codex', [
    { backend: 'codex', id: 'sess-1', label: XSS, scope: 'group:1', status: 'active', started: T0, updated: T0 + 3300, turns: 2 },
    { backend: 'codex', id: 'sess-old', label: 'sess-old', scope: 'owner', status: 'archived', started: T0 - 9e6, updated: T0 - 8e6, turns: 0 },
  ], {
    'sess-1': [
      { turn: 't1', started: T0 - 60_000, ended: T0 - 50_000, preview: '第一问', tools: 0, requests: 1, status: 'ok', usage: { input: 900, output: 5, measured: true } },
      { turn: 't2', started: T0 + 1000, ended: T0 + 3300, preview: `请看 ${XSS}`, tools: 1, requests: 2, status: 'ok', ticket: 'ticket-abcdef123456', delivery: { status: 'sent', scope: 'group:7', duration_ms: 4200 },
        usage: { input: 6000, output: 50, cached: 800, measured: true } },
    ],
  }, { 'sess-1/t2': BLOCKS, 'sess-1/t1': [{ kind: 'user', text: '第一问' }] });
  const pi = new Fake('pi', Array.from({ length: 53 }, (_, i) => ({ backend: 'pi' as const, id: String(i + 1), label: `会话 ${i}`, scope: i % 2 ? 'group:7' : 'owner',
    status: i % 2 ? 'archived' as const : 'active' as const, started: T0 + i, updated: T0 + i, turns: 1 })));
  return { codex, pi };
}

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-agents-pages-'));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  const dispose = registerTemporarySecrets([TOKEN]);
  const usage = new ContextUsageStub([{ backend: 'codex', key: 'group:1', usedTokens: 5000, windowTokens: 20_000, turns: 2, updatedAt: Date.now(), source: 'turn' }]);
  const resetCodex = vi.fn(async () => 'old'), resetPi = vi.fn(async () => 1);
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN }), store, context, contextUsage: usage, resetCodex, resetPi,
    codex: async () => [{ thread_key: 'owner', thread_id: null }, { thread_key: 'group:1', thread_id: 'sess-1' }, { thread_key: 'private:99', thread_id: 'sess-99' }],
    pi: async () => ({ threads: { 'group:7': 2 }, keys: ['group:7'] }), health: () => ({}), queue: () => ({}), sessionAdapters: adapters() });
  const server = createServer(dashboard.handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); dispose(); store.close(); context.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const get = (url: string) => fetch(base + url, { redirect: 'manual', headers: { Cookie: `obs_token=${TOKEN}` } });
  const page = async (url: string) => { const res = await get(url); const html = await res.text(); return { res, html }; };
  return { get, page };
}

/** 每页共同约束：无内联 style、所有 script 带 nonce、无外部资源、无未转义的注入。 */
function safe(html: string, res: Response) {
  expect(html).not.toMatch(/\sstyle="/);
  expect(html).not.toMatch(/(src|href)="https?:/);
  expect(html).not.toContain('<script>alert');
  const nonce = /<style nonce="([^"]+)"/.exec(html)![1]!;
  expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
  for (const m of html.matchAll(/<script[^>]*>/g)) expect(m[0]).toContain(`nonce="${nonce}"`);
}

describe('Agent 页面', () => {
  it('/agents 两张卡：会话计数、索引进度、每线程占用条、重置表单与会话列表入口；导航高亮 Agent', async () => {
    const r = await rig();
    const { res, html } = await r.page('/agents');
    expect(res.status).toBe(200); safe(html, res);
    expect(html).toContain('href="/agents" aria-current="page"');
    expect(html).toMatch(/data-backend="codex"[^]*?<div class="figure">1<\/div><div class="muted">活动会话<\/div><\/div><div><div class="figure">1<\/div><div class="muted">归档会话/);
    expect(html).toContain('索引中 1 / 4');
    expect(html).toContain('私聊 99'); expect(html).toContain('name="key" value="private:99"');
    expect(html).not.toContain('name="key" value="shared"');
    expect(html).toContain('data-ctx="codex|group:1"'); expect(html).toContain('5,000');
    expect(html).toContain('action="/codex/reset"'); expect(html).toContain('action="/pi/reset"'); expect(html).toContain('name="_csrf"');
    expect(html).toContain(`value="${csrfToken(TOKEN)}"`);
    expect(html).toContain('href="/agents/codex/sessions"'); expect(html).toContain('href="/agents/pi/sessions"');
  });

  it('会话列表：标签转义、真实 ID 可复制、筛选映射到接口参数、50 条分页、非法筛选提示', async () => {
    const r = await rig();
    const { res, html } = await r.page('/agents/codex/sessions');
    expect(res.status).toBe(200); safe(html, res);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<code class="mono sel">sess-1</code>'); expect(html).toContain('data-copy="sess-1"');
    expect(html).toContain('href="/agents/codex/sessions/sess-1"'); expect(html).toContain('群 1');
    expect(html).toContain('src="/assets/agents.js"');
    const active = await r.page('/agents/codex/sessions?status=active');
    expect(active.html).toContain('sess-1'); expect(active.html).not.toContain('sess-old'); expect(active.html).toContain('<option value="active" selected>');
    expect((await r.page('/agents/codex/sessions?scope=owner')).html).not.toContain('data-copy="sess-1"');
    expect((await r.page('/agents/codex/sessions?since=2026-10-18')).html).toContain('sess-1');
    const bad = await r.page('/agents/codex/sessions?since=yesterday');
    expect(bad.res.status).toBe(200); expect(bad.html).toContain('since 必须是时间戳或 ISO 时间');
    const p0 = await r.page('/agents/pi/sessions');
    expect(p0.html.match(/data-copy=/g)).toHaveLength(50); expect(p0.html).toContain('href="/agents/pi/sessions?page=1"');
    const p1 = await r.page('/agents/pi/sessions?page=1');
    expect(p1.html.match(/data-copy=/g)).toHaveLength(3); expect(p1.html).toContain('上一页'); expect(p1.html).not.toContain('下一页');
  });

  it('会话页：回合目录 + 回合流，最新回合展开并预载；回合头的上下文占用取最后一次请求，累计单列；QQ 送达与分析链接', async () => {
    const r = await rig();
    const { res, html } = await r.page('/agents/codex/sessions/sess-1');
    expect(res.status).toBe(200); safe(html, res);
    expect(html).toContain('id="tdir"'); expect(html).toContain('id="tstream"');
    const t2 = html.indexOf('data-turn="t2"'), t1 = html.indexOf('data-turn="t1"');
    expect(t2).toBeGreaterThan(-1); expect(t2).toBeLessThan(t1); // 最新在上
    expect(html).toMatch(/<details class="turn sheet" id="t-2" data-turn="t2" open>/);
    expect(html).toMatch(/<details class="turn sheet" id="t-1" data-turn="t1">/);
    expect(html).toContain('上下文 5,000 / 20,000（25%） tokens');
    expect(html).toContain('回合累计 输入 6,000（缓存 800） · 输出 50，2 次请求');
    expect(html).toContain('gpt-test · high');
    expect(html).toContain('href="/tickets/ticket-abcdef123456"'); expect(html).toContain('已回复'); expect(html).toContain('群 7');
    expect(html).toContain('href="/agents/codex/sessions/sess-1/context?at=t2&amp;phase=before"');
    expect(html).toContain('href="/agents/codex/sessions/sess-1/context?at=t2&amp;phase=after"');
    expect(html).toContain('href="/agents/codex/sessions/sess-1/turns/t2"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const data = /<script type="application\/json" id="agents-data" nonce="[^"]+">([^<]*)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(data)).toMatchObject({ backend: 'codex', session: 'sess-1', active: true, window: 20_000, base: 2 });
    expect(html).toContain('src="/assets/agents.js"'); expect(html).toContain('id="conn"');
    // 归档会话：不订阅
    const old = await r.page('/agents/codex/sessions/sess-old');
    expect(old.html).toContain('归档会话，不再更新'); expect(old.html).toContain('"active":false'); expect(old.html).toContain('id="no-turns"');
  });

  it('回合详情：按种类渲染块，工具结果挂在调用卡片下，参数 JSON 美化并转义，引用正文给加载全文', async () => {
    const r = await rig();
    const { res, html } = await r.page('/agents/codex/sessions/sess-1/turns/t2');
    expect(res.status).toBe(200); safe(html, res);
    expect(html).toContain('<div class="blk user"'); expect(html).toContain('请看 &lt;script&gt;');
    expect(html).toContain('<div class="blk image"'); expect(html).toContain('[内嵌图片]');
    expect(html).toContain('模型请求 #1 · gpt-test · high · 输入 1,000（缓存 800） · 输出 10');
    expect(html).toContain('模型请求 #2 · gpt-test · high · 输入 5,000 · 输出 40');
    expect(html).not.toContain('模型用量');
    expect(html).toContain('不可用（加密或已省略）');
    const card = /<div class="blk tc" data-call="call-1"[^]*?<\/div><\/div>\s*<\/details><\/div><\/div>/.exec(html)?.[0] ?? html.slice(html.indexOf('data-call="call-1"'), html.indexOf('模型请求 #2'));
    expect(card).toContain('<b class="tc-name">exec</b>'); expect(card).toContain('<span class="pill">shell</span>'); expect(card).toContain('1.5 秒');
    expect(card).toContain('&quot;cmd&quot;: &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;,\n  &quot;n&quot;: 1');
    expect(card).toContain('<details class="tc-res"><summary>结果 <span class="stamp s-ok">成功</span>');
    expect(card).toContain('输出 &lt;script&gt;');
    expect(html.match(/data-call="call-1"/g)).toHaveLength(1); // 结果不单独成卡
    expect(html).toContain(`class="quiet load-full" data-session="sess-1" data-offset="64" data-length="${Buffer.byteLength(LONG)}"`);
    expect(html).toContain('<details class="blk compaction"'); expect(html).toContain('上下文压缩 · auto');
    expect(html).toContain('<details class="blk sysch"'); expect(html).toContain('回合完成');
    expect(html).toContain('href="/agents/codex/sessions/sess-1/turns/t1"'); // 较早的回合
    expect(html).toContain('id="agents-data"');
  });

  it('未知后端、会话、回合返回 404；路径编码错误 404；旧页面跳转', async () => {
    const r = await rig();
    for (const url of ['/agents/foo/sessions', '/agents/codex/nope', '/agents/codex/sessions/missing', '/agents/codex/sessions/sess-1/turns/nope',
      '/agents/codex/sessions/%E0%A4%A/turns/x', '/agents/codex/sessions/sess-1/other', '/agents/codex/sessions/sess-1/turns/t2/extra'])
      expect((await r.get(url)).status, url).toBe(404);
    for (const b of ['codex', 'pi']) { const res = await r.get('/' + b); expect(res.status).toBe(303); expect(res.headers.get('location')).toBe(`/agents/${b}/sessions`); }
    expect((await r.get('/codex/agents-md')).status).toBe(200);
  });

  it('/memory 总览与导航；/context 指向记忆', async () => {
    const r = await rig();
    const m = await r.page('/memory');
    expect(m.res.status).toBe(200); expect(m.html).toContain('聊天记录整理'); expect(m.html).toContain('href="/memory" aria-current="page"');
    const c = await r.page('/context');
    expect(c.html).toContain('href="/memory"'); expect(c.html).toContain('href="/memory" aria-current="page"');
  });

  it('上下文分析页：分析接口缺席时显示"分析引擎暂不可用"，带阶段切换与回合链接；缺 at 时默认最新回合', async () => {
    const r = await rig();
    const { res, html } = await r.page('/agents/codex/sessions/sess-1/context?at=t1&phase=before');
    expect(res.status).toBe(200); safe(html, res);
    // 测试注入的桩适配器不是 CodexSessionAdapter，分析引擎返回 503，页面按不可用状态渲染。
    expect(html).toContain('分析引擎暂不可用（HTTP 503）');
    expect(html).toContain('<span class="pill on" aria-current="true">回合请求发出前</span>');
    expect(html).toContain('href="/agents/codex/sessions/sess-1/context?at=t1&amp;phase=after"');
    expect(html).toContain('href="/agents/codex/sessions/sess-1/turns/t1"');
    expect((await r.page('/agents/codex/sessions/sess-1/context')).html).toContain('context?at=t2&amp;phase=before');
    expect((await r.get('/agents/codex/sessions/missing/context?at=t1')).status).toBe(404);
  });
});

describe('上下文分析渲染（O3 接口契约桩）', () => {
  const stub: ContextAnalysis = {
    backend: 'codex', session: 'sess-1', at: { turn: 't2', phase: 'after' }, generatedAt: T0,
    window: { tokens: 20_000, source: 'model_context_window' },
    measured: { input: 5000, cached: 800, at: T0, stale: true, source: 'token_count' },
    estimated: { total: 4600, tokenizer: 'o200k_base' }, unexplained: 400,
    categories: [
      { key: 'instructions', label: '指令', items: 2, tokens: { estimated: 1200 }, provenance: 'reconstructed', note: '按当前 codex.md 重建' },
      { key: 'tools', label: '工具定义', items: 12, tokens: { estimated: 2000 }, provenance: 'estimated' },
      { key: 'history', label: '历史消息', items: 3, tokens: { estimated: 1400, measured: 1500 }, provenance: 'recorded' },
      { key: 'other', label: '其他 / 不可见', items: 1, tokens: {}, provenance: 'unavailable', note: '加密 reasoning' },
    ],
    messages: [
      { index: 0, kind: 'user', category: 'history', provenance: 'recorded', tokens: { estimated: 30 }, preview: `问 ${XSS}` },
      { index: 1, kind: 'function_call_output', category: 'tool_output', provenance: 'recorded', tokens: { estimated: 900 }, preview: '输出…', callId: 'call-1',
        ref: { session: 'sess-1', offset: 64, length: 9000, bytes: 9000 } },
    ],
    notes: [`注入 ${XSS}`],
  };
  const ctx = { backend: 'codex', session: 'sess-1', window: 20_000 };

  it('头部、构成表（来源标签、百分比条、不可用不计 0、差额单列）、逐消息表（展开引用）与说明；全部转义', () => {
    const html = contextBody(ctx, stub);
    expect(html).toContain('20,000'); expect(html).toContain('来源：model_context_window');
    expect(html).toMatch(/实测输入 <span class="stamp s-warn">过期<\/span>/); expect(html).toContain('5,000'); expect(html).toContain('缓存 800');
    expect(html).toContain('4,600'); expect(html).toContain('分词器：o200k_base'); expect(html).toContain('未解释差额 <b class="">+400</b>');
    expect(html).toMatch(/<tr data-cat="instructions"><td>指令<br><small>按当前 codex.md 重建<\/small><\/td><td class="num">2<\/td><td class="num">1,200<\/td><td class="num">—<\/td><td><span class="stamp s-warn">重建<\/span>/);
    expect(html).toMatch(/data-cat="tools"[^]*?<span class="stamp s-queue">估算<\/span>/);
    expect(html).toMatch(/data-cat="history"[^]*?1,500[^]*?<span class="stamp s-ok">已记录<\/span>[^]*?data-w="8"/);
    expect(html).toMatch(/<tr data-cat="other"><td>其他 \/ 不可见<br><small>加密 reasoning<\/small><\/td><td class="num">1<\/td><td class="num">—<\/td><td class="num">—<\/td><td><span class="stamp s-idle">不可用<\/span><\/td><td><span class="faint">—<\/span>/);
    expect(html).toContain('<tr class="unexplained">');
    expect(html).toContain('问 &lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).toContain('注入 &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('data-session="sess-1" data-offset="64" data-length="9000"'); expect(html).toContain('>tool_output<');
    expect(html).toContain('<small class="mono">call-1</small>');
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('不可用状态与缺失实测', () => {
    const html = contextUnavailable(ctx, 't2', 'after', 503, '引擎 <b>忙</b>');
    expect(html).toContain('分析引擎暂不可用（HTTP 503）'); expect(html).toContain('引擎 &lt;b&gt;忙&lt;/b&gt;');
    const { measured: _m, unexplained: _u, ...rest } = stub;
    const noMeasure = contextBody(ctx, rest);
    expect(noMeasure).toContain('没有可用的实测值'); expect(noMeasure).not.toContain('未解释差额 <b');
  });

  it('turnFacts：上下文占用取最后一次带 usage 的请求', () => {
    expect(turnFacts(BLOCKS)).toMatchObject({ requests: 2, model: 'gpt-test', effort: 'high', context: { input: 5000 } });
    expect(turnFacts([]).context).toBeUndefined();
  });
});
