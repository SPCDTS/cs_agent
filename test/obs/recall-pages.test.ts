import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import { createDashboard } from '../../src/obs/http.js';
import { MemoryInstrumentation } from '../../src/obs/memory/instrumentation.js';
import { type RecallRecord } from '../../src/context/observer.js';
import { RecallReader } from '../../src/obs/memory/recalls.js';
import type { RecallEvent, ScopeSummary } from '../../src/obs/memory/types.js';
import { ObsStore } from '../../src/obs/store.js';
import type { Block, ObservedTurn, SessionAdapter, SessionRef } from '../../src/obs/sessions/types.js';
import { levelsNote, memoryHomeBody, type MemoryOverview } from '../../src/obs/ui/memory-pages.js';
import { IN_REQUEST_CAVEAT, recallDetailBody, recallFilters, recallQuery, recallsPageBody, safeTurnHref, turnRecallSection, type RecallDetail } from '../../src/obs/ui/recall-pages.js';

const XSS = '<script>alert(1)</script>';
const T0 = Date.parse('2026-10-18T08:00:00Z');
const TOKEN = 'recall-pages-test-token-0123';
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of clean.splice(0).reverse()) await fn(); });

const ev = (o: Partial<RecallEvent> = {}): RecallEvent => ({ id: 7, ts: T0, backend: 'codex', turn_id: 'codex:abcdef1234567', session: 'sess-1', task_id: null,
  tool: 'qq_search', args: { query: XSS, limit: 3 }, access: 'group:123', scope_hint: 'group:123', returned: [{ kind: 'message', id: 'm1' }],
  returned_count: 1, dropped_count: 2, chars: 117, max_chars: 2500, duration_ms: 4, is_error: false, turn_href: '/agents/codex/sessions/sess-1/turns/t2', ...o });
const SCOPES = [{ scope: 'group:123', label: '群 123' }] as ScopeSummary[];
const detail = (status: 'confirmed' | 'not_found' | 'unavailable', o: Partial<RecallEvent> = {}): RecallDetail => ({ ...ev(o), evidence: {
  hits: [{ kind: 'message', id: 'm1', ts: T0 - 60_000, preview: `预览 ${XSS}` }, { kind: 'message', id: 'm-gone', deleted: true }, { kind: 'summary', id: 5, ts: T0 - 3600_000, preview: '摘要预览' }],
  tool_returned: { count: 3, chars: 117, dropped: 2 },
  in_request: status === 'confirmed' ? { status, turn: 't2', call_id: 'call-xyz', note: 'O1 调用匹配；不证明模型采用。' } : { status, note: status === 'not_found' ? '回合内没有匹配的调用块。' : '没有 session，无法定位回合。' } } });

describe('召回列表渲染', () => {
  it('页面查询 → 接口参数：空值省略、非法后端 / 工具丢弃、turn 需要 session、page 夹取', () => {
    const f = recallFilters(new URLSearchParams('backend=pi&tool=qq_message&scope=group:1&session=&turn_id=pi:1:2&since=2026-10-01&turn=3&page=2'));
    expect(f).toMatchObject({ backend: 'pi', tool: 'qq_message', scope: 'group:1', session: '', turn_id: 'pi:1:2', since: '2026-10-01', turn: '', page: 2 });
    expect(recallQuery(f).toString()).toBe('backend=pi&tool=qq_message&scope=group%3A1&turn_id=pi%3A1%3A2&since=2026-10-01&page=2');
    expect(recallQuery(recallFilters(new URLSearchParams('backend=x&tool=rm&page=-4'))).toString()).toBe('');
    expect(recallQuery(recallFilters(new URLSearchParams('session=s&turn=t9'))).toString()).toBe('session=s&turn=t9');
  });

  it('表格：时间 / 后端 / 工具 / 参数转义 / 权限 / 返回 / 裁掉徽章 / 字数表 / 耗时 / 错误 / 票据与回合链接 / 详情；分页链接保留过滤', () => {
    const f = recallFilters(new URLSearchParams('backend=codex&scope=group:123&page=1'));
    const html = recallsPageBody(f, SCOPES, { items: [ev(), ev({ id: 6, backend: 'pi', dropped_count: 0, is_error: true, turn_id: null, turn_href: 'javascript:alert(1)', access: 'all', scope_hint: null })], page: 1, has_more: true });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<option value="codex" selected>'); expect(html).toContain('<option value="group:123" selected>群 123</option>');
    expect(html).toContain('裁掉 2'); expect(html).toContain('<meter min="0" max="2500" value="117"');
    expect(html).toContain('href="/turns/codex%3Aabcdef1234567"'); expect(html).toContain('href="/agents/codex/sessions/sess-1/turns/t2"');
    expect(html).not.toContain('javascript:'); expect(html).toContain('全域'); expect(html).toContain('出错');
    expect(html).toContain('href="/memory/recalls/7"'); expect(html).toContain('href="/memory/recalls/6"');
    expect(html).toContain('href="/memory/recalls?backend=codex&amp;scope=group%3A123">较新</a>');
    expect(html).toContain('href="/memory/recalls?backend=codex&amp;scope=group%3A123&amp;page=2">更早</a>');
    expect(html).toContain('第 2 页');
  });

  it('空状态：无筛选说明何时出现；有筛选提示清除；接口错误显示提示', () => {
    expect(recallsPageBody(recallFilters(new URLSearchParams()), [], { items: [], page: 0, has_more: false })).toContain('模型调用 qq_recent / qq_search / qq_message 查询聊天记录时');
    expect(recallsPageBody(recallFilters(new URLSearchParams('tool=qq_recent')), [], { items: [], page: 0, has_more: false })).toContain('没有符合条件的召回记录');
    expect(recallsPageBody(recallFilters(new URLSearchParams()), [], { error: `坏了 ${XSS}` })).toContain('读取召回记录失败：坏了 &lt;script&gt;');
  });

  it('turn_href 只接受回合页路径', () => {
    expect(safeTurnHref('/agents/pi/sessions/12/turns/3')).toBe('/agents/pi/sessions/12/turns/3');
    for (const bad of [null, '', '//evil/x', '/agents/codex/sessions/a/turns/b?x=1', '/agents/x/sessions/a/turns/b', 'javascript:alert(1)']) expect(safeTurnHref(bad)).toBe('');
  });
});

describe('召回详情渲染', () => {
  it('confirmed：绿色状态 + 回合链接 + call_id + note；三面板颜色；caveat；已清理命中；命中链到时间线 / 摘要页', () => {
    const html = recallDetailBody(detail('confirmed'));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain(IN_REQUEST_CAVEAT);
    expect(html).toContain('③ 证明的是该回合里出现了匹配的工具调用，不等于模型采用了内容');
    expect(html).toContain('class="ev-panel ev-1"'); expect(html).toContain('class="ev-panel ev-2 sheet pad tool-panel"'); expect(html).toContain('class="ev-panel ev-3 ev-confirmed sheet pad"');
    expect(html).toContain('<span class="stamp s-ok">已在回合中找到调用</span>');
    expect(html).toContain('<a href="/agents/codex/sessions/sess-1/turns/t2">t2</a>'); expect(html).toContain('call-xyz');
    expect(html).toContain('O1 调用匹配；不证明模型采用。');
    expect(html).toContain('<span class="stamp s-idle">已清理</span>');
    expect(html).toContain(`href="/memory/scopes/group%3A123?from=${T0 - 60_000 - 3600_000}&amp;to=${T0 - 60_000 + 3600_000}#messages"`);
    expect(html).toContain('href="/memory/summaries/5"');
    expect(html).toContain('预览 &lt;script&gt;'); expect(html).toContain('裁掉 2'); expect(html).toContain('117 / 2,500 字');
    expect(html).toContain('href="/memory/recalls">返回召回记录</a>');
    expect(html).toContain('href="/turns/codex%3Aabcdef1234567"'); expect(html).toContain('href="/agents/codex/sessions/sess-1"');
    expect(html).not.toContain('模型采用了这些');
  });

  it('not_found 琥珀色、unavailable 灰色，都显示 note；全域调用的消息命中不出时间线链接', () => {
    const nf = recallDetailBody(detail('not_found'));
    expect(nf).toContain('<span class="stamp s-warn">回合中未找到匹配调用</span>'); expect(nf).toContain('回合内没有匹配的调用块。');
    expect(nf).not.toContain('call-xyz');
    const un = recallDetailBody(detail('unavailable', { session: null, turn_href: null, access: 'all', scope_hint: null }));
    expect(un).toContain('<span class="stamp s-idle">无法核对</span>'); expect(un).toContain('没有 session，无法定位回合。');
    expect(un).toContain('未记录（新线程首轮）'); expect(un).not.toContain('/memory/scopes/');
    expect(un).toContain(IN_REQUEST_CAVEAT);
  });
});

describe('检索检查器第三级、首页卡、回合段', () => {
  it('第三级链接到召回记录（带 scope 与 qq_search）', () => {
    expect(levelsNote('group:123')).toContain('<a href="/memory/recalls?scope=group%3A123&amp;tool=qq_search">在召回记录中查看该 scope 的历史调用</a>');
    expect(levelsNote('')).toContain('href="/memory/recalls?tool=qq_search"');
    expect(levelsNote('')).toContain('只对某次真实调用成立');
  });

  it('首页召回卡：计数、50+、读取失败', () => {
    const o = { scopes: [], aging: { last_run: null, next_run: null, running: false, catch_up_needed: false }, retention: { rawDays: 30, summaryDays: 180, hardMaxDays: 90, dailyHour: 3, tz: 'UTC' } } as MemoryOverview;
    expect(memoryHomeBody(o, T0, { count: 3, more: false })).toContain('最近 24 小时 3 次工具召回');
    expect(memoryHomeBody(o, T0, { count: 50, more: true })).toContain('最近 24 小时 50+ 次工具召回');
    expect(memoryHomeBody(o, T0, null)).toContain('最近 24 小时的数量暂不可用');
    expect(memoryHomeBody(o, T0, null)).toContain('href="/memory/recalls"');
  });

  it('回合段：有事件列出工具 / 参数 / 返回 / 裁掉 / 详情；空时一行；出错时一行提示', () => {
    const q = { backend: 'codex', session: 'sess-1', turn: 't2' };
    const html = turnRecallSection({ items: [ev()], page: 0, has_more: true }, q);
    expect(html).toContain('记忆调用 <small>1 次</small>'); expect(html).toContain('qq_search'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert'); expect(html).toContain('href="/memory/recalls/7"'); expect(html).toContain('裁掉 2');
    expect(html).toContain('href="/memory/recalls?backend=codex&amp;session=sess-1&amp;turn=t2">查看全部</a>');
    expect(turnRecallSection({ items: [], page: 0, has_more: false }, q)).toContain('无记忆调用');
    expect(turnRecallSection({ error: 'HTTP 503' }, q)).toContain('记忆调用暂不可用：HTTP 503');
  });
});

/* ───────── 路由集成：真实召回表 + 假会话适配器 ───────── */

class Fake implements SessionAdapter {
  progress = { indexing: false, files: 1, done: 1 };
  constructor(readonly backend: 'codex' | 'pi', readonly sessions: SessionRef[], readonly turnMap: Record<string, ObservedTurn[]>, readonly blockMap: Record<string, Block[]>) {}
  async listSessions() { return this.sessions; }
  async turns(id: string) { return this.turnMap[id] ?? []; }
  async blocks(id: string, turn: string) { return this.blockMap[`${id}/${turn}`] ?? []; }
  async content() { return ''; }
  subscribe() { return () => undefined; }
}

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-recall-pages-'));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  const NOW = Date.now();
  const turns: ObservedTurn[] = [
    { turn: 't1', started: NOW - 3600_000, ended: NOW - 3500_000, preview: '第一问', tools: 0, requests: 1, status: 'ok' },
    { turn: 't2', started: NOW - 60_000, ended: NOW - 30_000, preview: '查比赛', tools: 1, requests: 2, status: 'ok' },
  ];
  const codex = new Fake('codex', [{ backend: 'codex', id: 'sess-1', label: 'sess-1', scope: 'shared', status: 'active', started: NOW - 3600_000, updated: NOW, turns: 2 }],
    { 'sess-1': turns }, { 'sess-1/t2': [{ kind: 'tool_call', ts: NOW - 50_000, callId: 'call-1', text: JSON.stringify({ query: XSS }), meta: { name: 'mcp__qq_context__qq_search' } }], 'sess-1/t1': [] });
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN }), store, context,
    codex: async () => [], pi: async () => ({}), health: () => ({}), queue: () => ({}), sessionAdapters: { codex } });
  const server = createServer(dashboard.handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); context.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const writer = MemoryInstrumentation.fromDb(store.db);
  const record = (o: Partial<RecallRecord> = {}) => writer.recordRecall({ ts: NOW - 50_000, backend: 'codex', turn_id: 'codex:tk-1', session: 'sess-1', task_id: null, tool: 'qq_search',
    args: { query: XSS }, access: 'group:123', scope_hint: 'group:123', returned: [], returned_count: 0, dropped_count: 0, chars: 10, max_chars: 2500, duration_ms: 3, is_error: false, ...o });
  const page = async (url: string) => { const res = await fetch(base + url, { redirect: 'manual', headers: { Cookie: `obs_token=${TOKEN}` } }); return { res, html: await res.text() }; };
  return { page, record, NOW };
}

describe('召回路由', () => {
  it('列表、过滤、详情（confirmed）、首页卡、回合页记忆调用；全部转义且带 nonce', async () => {
    const r = await rig();
    r.record(); r.record({ backend: 'pi', session: 'other', tool: 'qq_recent', args: { limit: 5 }, ts: r.NOW - 3 * 86400_000 });
    const list = await r.page('/memory/recalls');
    expect(list.res.status).toBe(200);
    expect(list.html).not.toContain('<script>alert'); expect(list.html).toContain('href="/memory" aria-current="page"');
    expect((list.html.match(/href="\/memory\/recalls\/\d+">详情/g) ?? []).length).toBe(2);
    const nonce = /<style nonce="([^"]+)"/.exec(list.html)![1]!;
    for (const m of list.html.matchAll(/<script[^>]*>/g)) expect(m[0]).toContain(`nonce="${nonce}"`);
    const pi = await r.page('/memory/recalls?backend=pi&session=&tool=');
    expect((pi.html.match(/href="\/memory\/recalls\/\d+">详情/g) ?? []).length).toBe(1); expect(pi.html).toContain('qq_recent');
    const bad = await r.page('/memory/recalls?since=2026-02-30');
    expect(bad.res.status).toBe(200); expect(bad.html).toContain('读取召回记录失败');

    const d = await r.page('/memory/recalls/1');
    expect(d.res.status).toBe(200); expect(d.html).not.toContain('<script>alert');
    expect(d.html).toContain('已在回合中找到调用'); expect(d.html).toContain('call-1'); expect(d.html).toContain(IN_REQUEST_CAVEAT);
    expect(d.html).toContain('href="/agents/codex/sessions/sess-1/turns/t2"');

    expect((await r.page('/memory')).html).toContain('最近 24 小时 1 次工具召回');

    const t2 = await r.page('/agents/codex/sessions/sess-1/turns/t2');
    expect(t2.res.status).toBe(200); expect(t2.html).toContain('记忆调用 <small>1 次</small>'); expect(t2.html).toContain('href="/memory/recalls/1"');
    expect(t2.html).not.toContain('<script>alert');
    expect((await r.page('/agents/codex/sessions/sess-1/turns/t1')).html).toContain('无记忆调用');
    const sess = await r.page('/agents/codex/sessions/sess-1');
    expect(sess.html).toContain('href="/memory/recalls?backend=codex&amp;session=sess-1&amp;turn=t2">记忆调用</a>');
  });

  it('召回接口出错时回合页照常渲染，只显示一行提示', async () => {
    const r = await rig();
    vi.spyOn(RecallReader.prototype, 'list').mockRejectedValue(new Error('观测库坏了'));
    const t2 = await r.page('/agents/codex/sessions/sess-1/turns/t2');
    expect(t2.res.status).toBe(200); expect(t2.html).toContain('记忆调用暂不可用'); expect(t2.html).toContain('正文');
    const home = await r.page('/memory');
    expect(home.res.status).toBe(200); expect(home.html).toContain('最近 24 小时的数量暂不可用');
  });
});
