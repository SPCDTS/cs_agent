import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import type { InboundMessage } from '../../src/qq/types.js';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { highlight, messageWindow, rangeParams, rangeQuery, searchTerms, shortTerms } from '../../src/obs/ui/memory-pages.js';

const TOKEN = 'memory-pages-test-token-0123';
const DAY = 86400_000, HOUR = 3600_000, G = 'group:123';
const XSS = '<script>alert(1)</script>';
const XSCOPE = '<img src=x onerror=alert(1)>';
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

async function rig(o: { many?: boolean; running?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-memory-pages-'));
  const store = new ObsStore(dir), context = new ContextStore(dir, { tzOffsetSec: 0 });
  const NOW = Math.floor(Date.now() / 1000) * 1000;
  const add = (id: string, ts: number, text: string, sender = '789') => context.ingest({
    message_id: id, time: ts / 1000, message_type: 'group', group_id: '123', user_id: sender,
    nickname: `昵称${XSS}`, self_id: '999', text, route_text: text, segments: [], images: [], truncated: false, mentioned_self: false,
  } satisfies InboundMessage);
  add('m1', NOW - 3 * DAY, `比赛 ${XSS} 第一日`);
  add('m2', NOW - 2 * DAY, '比赛 第二日');
  for (let i = 0; i < (o.many ? 55 : 3); i++) add(`n${i}`, NOW - HOUR + i * 1000, `近期 ${i}`, i % 2 ? '790' : '789');
  context.writeSummary({ scope: G, level: 'day', period_start: (NOW - 3.5 * DAY) / 1000, period_end: (NOW - 2.5 * DAY) / 1000,
    text: `日摘要正文 ${XSS} 比赛`, msg_count: 9, created_at: NOW / 1000 });
  context.writeSummary({ scope: G, level: 'week', period_start: (NOW - 14.5 * DAY) / 1000, period_end: (NOW - 7.5 * DAY) / 1000,
    text: '周摘要正文', msg_count: 30, created_at: NOW / 1000 });
  context.writeSummary({ scope: XSCOPE, level: 'day', period_start: (NOW - 5 * DAY) / 1000, period_end: (NOW - 4 * DAY) / 1000,
    text: '奇怪的域', msg_count: 1, created_at: NOW / 1000 });
  context.setMeta('aging_last_run', String((NOW - 2 * HOUR) / 1000));
  store.append({ ticket: '@aging', scope: '', ts: NOW - 2 * HOUR, stage: 'aging', status: 'ok', duration_ms: 50,
    detail: { day_summaries: 4, week_summaries: 2, failed: 1, purged_messages: 37, purged_summaries: 5, ms: 1500 } });
  const archives = { codex: path.join(dir, 'codex-threads-archive.jsonl'), pi: path.join(dir, 'pi-threads-archive.jsonl') };
  await fs.writeFile(archives.codex, JSON.stringify({ key: 'owner', thread_id: 'thread-a', reason: `手动 ${XSS}`, created_at: NOW - DAY, archived_at: NOW }) + '\n');
  await fs.writeFile(archives.pi, JSON.stringify({ key: G, conversation: 42, reason: 'reset', archived_at: NOW - HOUR }) + '\n');
  for (const [i, reason] of ['background', 'reserve', 'background'].entries())
    store.append({ ticket: `@c${i}`, scope: G, ts: NOW - i, stage: 'compaction', status: 'ok', duration_ms: null, detail: { backend: 'pi', conversation: 42, reason } });
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN });
  const dashboard = createDashboard({ config, store, context, codex: async () => [], pi: async () => ({}), health: () => ({}), queue: () => ({}), sessionAdapters: {},
    archives, aging: { config: { rawDays: 30, summaryDays: 180, hardMaxDays: 90, dailyHour: 3, tz: 'UTC' }, nextRun: () => NOW + 5 * HOUR, running: () => o.running ?? false } });
  const server = createServer(dashboard.handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); context.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const page = async (url: string) => { const res = await fetch(base + url, { redirect: 'manual', headers: { Cookie: `obs_token=${TOKEN}` } }); return { res, html: await res.text() }; };
  const api = async (url: string) => (await fetch(base + url, { headers: { Cookie: `obs_token=${TOKEN}` } })).json();
  return { page, api, NOW, context };
}

/** 每页共同约束：无内联 style、所有 script/style 带同一 nonce、无外部资源、无未转义的注入。 */
function safe(html: string, res: Response) {
  expect(res.status).toBe(200);
  expect(html).not.toMatch(/\sstyle="/);
  expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  expect(html).not.toContain('<script>alert');
  expect(html).not.toContain('<img src=x');
  const nonce = /<style nonce="([^"]+)"/.exec(html)![1]!;
  expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
  for (const m of html.matchAll(/<script[^>]*>/g)) expect(m[0]).toContain(`nonce="${nonce}"`);
  for (const m of html.matchAll(/<style[^>]*>/g)) expect(m[0]).toContain(`nonce="${nonce}"`);
}
const dataOf = (html: string) => JSON.parse(/<script type="application\/json" id="memory-data" nonce="[^"]+">(.*?)<\/script>/s.exec(html)![1]!);

describe('记忆页面', () => {
  it('/memory：整理卡（上次 / 报告 / 下次 / 运行中 / 补跑 / 保留策略）+ 会话域表；标签转义；入口齐全；导航高亮', async () => {
    const r = await rig({ running: true });
    const { res, html } = await r.page('/memory');
    safe(html, res);
    expect(html).toContain('href="/memory" aria-current="page"');
    expect(html).toContain('整理中');
    expect(html).toContain('日摘要 4 · 周摘要 2 · 失败 1 · 清理原文 37 · 清理摘要 5 · 耗时 1.5 秒');
    expect(html).toContain('约 5 小时后'); expect(html).toContain('执行中可能顺延');
    expect(html).toContain('正常'); expect(html).not.toContain('需要补跑');
    expect(html).toContain('原文 30 天（未被摘要覆盖的最长 90 天），摘要 180 天');
    expect(html).toContain('每天 3 点（UTC）');
    // 会话域表：字典序，XSS 标签转义，链接到时间线
    expect(html).toContain('href="/memory/scopes/group%3A123"');
    expect(html).toContain('群 123');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain(`href="/memory/scopes/${encodeURIComponent(XSCOPE)}"`);
    const row = /<tr>\s*<td><a href="\/memory\/scopes\/group%3A123">群 123<\/a>.*?<\/tr>/s.exec(html)![0];
    expect(row).toContain('<td class="num">5</td>'); // 消息
    expect(row).toContain('<td class="num">1 / 1</td>'); // 日 / 周摘要
    for (const href of ['/memory/search', '/memory/archives', '/context']) expect(html).toContain(`href="${href}"`);
    expect(html).toContain('待 O5'); expect(html).toContain('待 O6');
  });

  it('补跑标记与未接入调度器', async () => {
    const r = await rig();
    r.context.setMeta('aging_last_run', String(Math.floor((r.NOW - 3 * DAY) / 1000)));
    const { html } = await r.page('/memory');
    expect(html).toContain('需要补跑'); expect(html).toContain('距上次成功运行已超过 24 小时'); expect(html).toContain('空闲');
  });

  it('导航：/memory/* 与 /context 都高亮"记忆"；O5 / O6 占位；未知子路由 404', async () => {
    const r = await rig();
    for (const url of ['/memory/scopes/group%3A123', '/memory/search', '/memory/archives', '/memory/recalls', '/memory/images', '/context']) {
      const { res, html } = await r.page(url);
      expect(res.status, url).toBe(200);
      expect(html, url).toContain('href="/memory" aria-current="page"');
      expect(html, url).not.toContain('href="/agents" aria-current');
    }
    expect((await r.page('/memory/recalls')).html).toContain('召回记录：待 O5');
    expect((await r.page('/memory/images')).html).toContain('图片记忆：待 O6');
    for (const url of ['/memory/nope', '/memory/scopes', '/memory/scopes/', '/memory/scopes/group%3A123/extra', '/memory/summaries/', '/memory/scopes/%E0%A4%A'])
      expect((await r.page(url)).res.status, url).toBe(404);
    // /context 链到所选会话域的时间线
    expect((await r.page('/context?scope=group%3A123')).html).toContain('href="/memory/scopes/group%3A123"');
  });

  it('时间线页：本地 vis-timeline（nonce + 同源样式表）、三轨数据、边界、空白、摘要列表与首屏消息；全部转义', async () => {
    const r = await rig();
    const { res, html } = await r.page('/memory/scopes/group%3A123');
    safe(html, res);
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/vendor\/vis-timeline.css"><script nonce="[^"]+" defer src="\/assets\/vendor\/vis-timeline.js"><\/script><style nonce=/);
    expect(html).toContain('src="/assets/memory.js"');
    expect(html).toContain('id="mtl"');
    const d = dataOf(html);
    expect(d.scope).toBe(G);
    expect(d.tracks.raw.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(5);
    expect(d.tracks.day).toHaveLength(1); expect(d.tracks.week).toHaveLength(1);
    expect(d.retention_edges.raw_until).toBeLessThan(r.NOW);
    expect(d.gaps.length).toBeGreaterThan(0);
    expect(d.window).toEqual(messageWindow(d.range.first_ts, d.range.last_ts));
    // JSON 数据块里的 < 被转义，不会提前闭合 script
    expect(/id="memory-data"[^>]*>(.*?)<\/script>/s.exec(html)![1]).not.toContain('<');
    // 摘要列表链接到摘要页；正文摘录转义
    const ids = (await r.api('/api/memory/scopes/group%3A123')).tracks.day.map((s: { id: number }) => s.id);
    expect(html).toContain(`href="/memory/summaries/${ids[0]}"`);
    expect(html).toContain('日摘要正文 &lt;script&gt;alert(1)&lt;/script&gt;');
    // 首屏消息：最新在上，发送者与正文转义
    const first = html.indexOf('近期 2'), second = html.indexOf('近期 1');
    expect(first).toBeGreaterThan(-1); expect(first).toBeLessThan(second);
    expect(html).toContain('比赛 &lt;script&gt;alert(1)&lt;/script&gt; 第一日');
    expect(html).toMatch(/<button type="button" class="quiet" id="msg-more" hidden>更早<\/button>/);
    // 区间控件：3 天 / 30 天带 from 毫秒，"全部"不带参数且当前高亮；自定义表单 GET 回本页
    expect(html).toMatch(/<a class="pill" href="\/memory\/scopes\/group%3A123\?from=\d+" data-preset="3d">最近 3 天<\/a>/);
    expect(html).toContain('<a class="pill on" href="/memory/scopes/group%3A123" data-preset="all">全部</a>');
    expect(html).toContain('<form class="range-form" method="get" action="/memory/scopes/group%3A123">');
    // 标签含 XSS 的会话域
    const x = await r.page(`/memory/scopes/${encodeURIComponent(XSCOPE)}`);
    safe(x.html, x.res);
    expect(x.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('时间线页区间参数原样交给接口；非法区间提示；未知会话域 404；首屏满 50 条时显示"更早"', async () => {
    const r = await rig({ many: true });
    const from = r.NOW - 2 * HOUR, to = r.NOW;
    const { html } = await r.page(`/memory/scopes/group%3A123?from=${from}&to=${to}&junk=1`);
    const d = dataOf(html);
    expect(d.range).toEqual({ first_ts: from, last_ts: to });
    expect(d.tracks.day).toHaveLength(0);
    expect(html.match(/<li class="msg"/g)).toHaveLength(50);
    expect(html).toContain('<button type="button" class="quiet" id="msg-more">更早</button>');
    expect(typeof d.next_before).toBe('number');
    expect(typeof d.next_before_id).toBe('number'); // 同秒决胜游标透传给客户端
    expect(d.window).toEqual({ after: from - 1, before: to });
    const date = await r.page('/memory/scopes/group%3A123?from=2026-10-01&to=2026-10-03');
    expect(date.html).toContain('value="2026-10-01"'); expect(date.html).toContain('value="2026-10-03"');
    expect(date.html).not.toContain('class="pill on"');
    const bad = await r.page('/memory/scopes/group%3A123?from=2026-02-30');
    expect(bad.res.status).toBe(200); expect(bad.html).toContain('读取时间线失败：from 日期无效');
    const rev = await r.page(`/memory/scopes/group%3A123?from=${to}&to=${from}`);
    expect(rev.html).toContain('from 必须早于 to');
    expect((await r.page('/memory/scopes/group%3A999')).res.status).toBe(404);
    expect((await r.page('/memory/scopes/a%2Fb')).res.status).toBe(404);
  });

  it('摘要页：头部、全文转义、血缘待 O5、定位到时间线与该区间消息；未知或非法 id 404', async () => {
    const r = await rig();
    const tl = await r.api('/api/memory/scopes/group%3A123');
    const s = tl.tracks.day[0];
    const { res, html } = await r.page(`/memory/summaries/${s.id}`);
    safe(html, res);
    expect(html).toContain(`日摘要 #${s.id}`);
    expect(html).toContain('<div class="sum-text">日摘要正文 &lt;script&gt;alert(1)&lt;/script&gt; 比赛</div>');
    expect(html).toContain('群 123'); expect(html).toContain('尚存原文');
    expect(html).toMatch(/<dt>尚存原文<\/dt><dd>1 条/); // m1 落在区间内
    expect(html).toContain(`<dt>字数</dt><dd>${[...`日摘要正文 ${XSS} 比赛`].length} 字</dd>`);
    expect(html).toContain('血缘：待 O5');
    expect(html).toContain(`href="/memory/scopes/group%3A123?from=${s.period_start}&amp;to=${s.period_end}#messages"`);
    expect(html).toContain(`href="/memory/scopes/group%3A123?from=${s.period_start - DAY}&amp;to=${s.period_end + DAY}"`);
    expect(html).toContain('href="/memory" aria-current="page"');
    for (const url of ['/memory/summaries/999999', '/memory/summaries/0', '/memory/summaries/abc', '/memory/summaries/1.5', '/memory/summaries/-1'])
      expect((await r.page(url)).res.status, url).toBe(404);
  });

  it('检索检查器：空关键词只显示表单；命中与工具返回两栏、高亮不破坏转义、未进入工具返回的条数；错误提示', async () => {
    const r = await rig();
    const empty = await r.page('/memory/search');
    safe(empty.html, empty.res);
    expect(empty.html).toContain('<form class="bar search-form"');
    expect(empty.html).toContain('<option value="group:123">群 123</option>');
    expect(empty.html).toContain('&lt;img src=x onerror=alert(1)&gt;</option>');
    expect(empty.html).not.toContain('class="hits"'); expect(empty.html).not.toContain('class="sheet pad tool-panel"');
    expect(empty.html).toContain('③ 进入模型请求'); expect(empty.html).toContain('待 O5');
    expect((await r.page('/memory/search?q=%20%20')).html).not.toContain('class="sheet pad tool-panel"');

    const { res, html } = await r.page('/memory/search?q=script&scope=group%3A123&days=30&limit=10');
    safe(html, res);
    expect(html).toContain('<option value="group:123" selected>');
    expect(html).toContain('value="script"');
    expect(html).toContain('&lt;<mark>script</mark>&gt;alert(1)&lt;/<mark>script</mark>&gt;');
    expect(html).toContain('<span class="pill">text</span>');
    expect(html).toMatch(/<pre class="tool-text">[^]*&lt;<mark>script<\/mark>&gt;/);
    expect(html).toMatch(/<meter min="0" max="\d+" value="\d+"/);
    expect(html).toContain('全部命中都进入了工具返回');
    expect(html).not.toContain('class="flash short-q"');
    expect(empty.html).not.toContain('class="flash short-q"');
    // FTS5 trigram：少于 3 个字符的词给出提示（仍照常检索）
    const short = await r.page('/memory/search?q=%E6%AF%94%E8%B5%9B%20script');
    expect(short.html).toContain('class="flash short-q"'); expect(short.html).toContain('FTS5 trigram');
    expect(short.html).toContain('“比赛”'); expect(short.html).not.toContain('“script”');
    expect(short.html).toContain('class="sheet pad tool-panel"');
    const api = await r.api('/api/memory/search?q=script&scope=group%3A123&days=30&limit=10');
    expect(html.match(/<li class="hit sheet pad">/g)).toHaveLength(api.hits.length);
    // 消息命中链到时间线附近，摘要命中链到摘要页
    expect(html).toMatch(/href="\/memory\/summaries\/\d+"/);
    expect(html).toMatch(/href="\/memory\/scopes\/group%3A123\?from=\d+&amp;to=\d+#messages"/);

    const unknown = await r.page('/memory/search?q=x&scope=group%3A999');
    expect(unknown.res.status).toBe(200); expect(unknown.html).toContain('检索失败：');
    expect((await r.page('/memory/search?q=x&days=999')).html).toContain('days 必须是 1 至 180 的整数');
  });

  it('归档页：Codex / Pi 归档表链到会话页，压缩按会话聚合；原因转义', async () => {
    const r = await rig();
    const { res, html } = await r.page('/memory/archives');
    safe(html, res);
    expect(html).toContain('<a class="mono" href="/agents/codex/sessions/thread-a">thread-a</a>');
    expect(html).toContain('<a class="mono" href="/agents/pi/sessions/42">42</a>');
    expect(html).toContain('手动 &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toMatch(/<td class="num">3<\/td>/);
    expect(html).toContain('<span class="pill">background</span> <span class="pill">reserve</span>');
    expect(html).toMatch(/Pi 归档会话[^]*<td class="hide-sm"><span class="faint">—<\/span><\/td>/); // 没有创建时间不冒充
  });
});

describe('记忆页面纯函数', () => {
  it('区间按钮 → 查询映射', () => {
    const now = Date.UTC(2026, 9, 18, 12);
    expect(rangeQuery('3d', now)).toEqual({ from: now - 3 * DAY });
    expect(rangeQuery('30d', now)).toEqual({ from: now - 30 * DAY });
    expect(rangeQuery('all', now)).toEqual({});
    expect(rangeParams(new URLSearchParams('from=1&to=2&x=3&scope=a')).toString()).toBe('from=1&to=2');
    expect(rangeParams(new URLSearchParams('from=&to=2026-10-18')).toString()).toBe('to=2026-10-18');
    expect(messageWindow(5000, 9000)).toEqual({ after: 4999, before: 9000 });
    expect(messageWindow(0, 9000)).toEqual({ before: 9000 });
  });

  it('高亮：先脱敏，按原文找区间再逐段转义；不切进实体，大小写不敏感，重叠合并', () => {
    expect(highlight('a <b> & amp', ['amp'])).toBe('a &lt;b&gt; &amp; <mark>amp</mark>');
    expect(highlight('Hello hello', ['HELLO'])).toBe('<mark>Hello</mark> <mark>hello</mark>');
    expect(highlight('abcdef', ['abc', 'bcd'])).toBe('<mark>abcd</mark>ef');
    expect(highlight('"q" \'x\'', ['q'])).toBe('&quot;<mark>q</mark>&quot; &#39;x&#39;');
    expect(highlight('无命中', ['x'])).toBe('无命中');
    expect(searchTerms('  a  b%_ c d e f g ')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(shortTerms('比赛 abc 𠀀𠀁 a')).toEqual(['比赛', '𠀀𠀁', 'a']);
    expect(shortTerms('三个字 abcd')).toEqual([]);
  });
});
