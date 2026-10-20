import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { ContextStore } from '../../src/context/store.js';
import { loadConfig } from '../../src/config.js';
import type { ContextUsage } from '../../src/shared/format.js';
import { ContextUsageStub } from './fixtures/context-usage-stub.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'dashboard-context-usage-token';

async function rig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-ctx-usage-'));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  const contextUsage = new ContextUsageStub([{ backend: 'codex', key: 'owner', usedTokens: 52_000, cachedTokens: 1000, windowTokens: 400_000, turns: 1, updatedAt: Date.now(), source: 'turn' }]);
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, OBS_TOKEN: token }), store, context, contextUsage,
    health: () => ({}), queue: () => ({}), codex: async () => [{ thread_key: 'owner', thread_id: 'thread-1' }],
    pi: async () => ({ threads: { 'group:7': 1 }, keys: ['group:7'] }) });
  const server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  cleanup.push(async () => {
    await dashboard.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); context.close(); rmSync(dir, { recursive: true, force: true });
  });
  const html = async (url: string) => {
    const res = await fetch(base + url, { headers: { Cookie: 'obs_token=' + token } });
    return { status: res.status, html: await res.text() };
  };
  const usage = (ts: number, ticket: string, patch: Partial<ContextUsage>) => store.append({ ticket, ts, scope: '', stage: 'context_usage', status: 'ok', duration_ms: null,
    detail: { backend: 'codex', key: 'owner', usedTokens: 10_000, cachedTokens: 0, windowTokens: 400_000, turns: 2, updatedAt: ts, source: 'turn', ...patch } });
  const event = (ts: number, ticket: string, stage: string, detail: unknown = {}) => store.append({ ticket, ts, scope: 'private:1', stage, status: 'ok', duration_ms: 5, detail });
  /** model_request 在回合末批量入库（事件 ts = 入库时间），at 是请求自身时间。 */
  const request = (ts: number, ticket: string, seq: number, at: number, input: number, cached: number, turn: number) => store.append({ ticket, ts, scope: '', stage: 'model_request', status: 'ok', duration_ms: null,
    detail: { backend: 'codex', key: 'owner', ticket, seq, turn, input, cached, output: 100, window: 400_000, at } });
  return { store, html, usage, event, request };
}

const MIN = 60_000;
/**
 * codex owner：首轮 → 命中 → 间隔 90 分钟后未命中 → 部分命中 → 压缩 → 压缩后一轮（以上为旧 context_usage 记录）
 * → tk-multi 一个票据三次请求（model_request，第 3 次部分命中；同票据的 context_usage 回合记录被请求取代）；另有 pi 群 7 一轮。
 */
function seed(r: Awaited<ReturnType<typeof rig>>) {
  const t0 = Date.now() - 6 * 3600_000, t1 = t0 + MIN, t2 = t1 + 90 * MIN, t3 = t2 + MIN, t4 = t3 + MIN / 2, t5 = t4 + MIN / 2, t6 = t5 + MIN;
  r.usage(t0, 'tk-first', { usedTokens: 200_000, turns: 5 });
  r.usage(t1, 't<"x">', { usedTokens: 208_000, cachedTokens: 200_000, turns: 6 });
  r.event(t2 - 1, 'tk-miss', 'received', { text: '你好', sender: '小明' });
  r.event(t2 - 1, 'tk-miss', 'model_turn', { thread_key: 'owner', input_tokens: 215_000 });
  r.usage(t2, 'tk-miss', { usedTokens: 215_000, cachedTokens: 3712, turns: 7 });
  r.usage(t3, 'tk-partial', { usedTokens: 220_000, cachedTokens: 160_000, turns: 8 });
  r.usage(t4, '@context', { usedTokens: 50_000, source: 'compact', turns: 8 });
  r.event(t5 - 1, 'tk-after', 'received', { text: '压缩后', sender: '小明' });
  r.event(t5 - 1, 'tk-after', 'model_turn', { thread_key: 'owner' });
  r.usage(t5, 'tk-after', { usedTokens: 52_000, cachedTokens: 1000, turns: 9 });
  r.event(t6 - 1, 'tk-multi', 'received', { text: '查一下', sender: '小明' });
  r.request(t6 + 30_000, 'tk-multi', 1, t6, 53_000, 51_000, 10);
  r.request(t6 + 30_000, 'tk-multi', 2, t6 + 10_000, 54_000, 53_000, 10);
  r.request(t6 + 30_000, 'tk-multi', 3, t6 + 20_000, 60_000, 40_000, 10);
  r.event(t6 + 30_000, 'tk-multi', 'model_turn', { thread_key: 'owner' });
  r.usage(t6 + 30_000, 'tk-multi', { usedTokens: 60_000, cachedTokens: 40_000, turns: 10 });
  r.usage(t0 + 5, 'tk-pi', { backend: 'pi', key: 'group:7', usedTokens: 30_000, windowTokens: 100_000, turns: 1 });
  r.event(t0, 'tk-plain', 'received', { text: '没有占用记录', sender: '小明' });
  r.event(t0 + 1, 'tk-plain', 'model_turn', { thread_key: 'owner' });
}
const sectionOf = (html: string, label: string) => {
  const start = html.indexOf(`<h2>${label} <small>最近`);
  return html.slice(start, html.indexOf('</section>', start));
};

describe('上下文监控页面 /context-usage', () => {
  it('导航入口、汇总表（线程名、当前占用文字、24 h 回合 / 未命中 / 平均命中率）', async () => {
    const r = await rig(); seed(r);
    const { status, html } = await r.html('/context-usage');
    expect(status).toBe(200);
    expect(html).toContain('<h1>上下文监控</h1>');
    expect(html).toContain('<a href="/context-usage" aria-current="page">上下文监控</a>');
    expect(html).toMatch(/<a href="\/memory"[^>]*>记忆<\/a><a href="\/context-usage"/);
    // codex 在最近活动的前面；6 个票据、8 次请求（tk-multi 的 3 次请求取代其 context_usage 回合记录）、1 次未命中、
    // 命中率 (364,712 + 51,000 + 53,000 + 40,000) / (895,000 + 53,000 + 54,000 + 60,000) ≈ 48%。
    expect(html).toContain('<th>线程</th><th class="num">当前占用（占比 · 已用 / 窗口）</th><th class="num">24 h 回合数</th><th class="num">请求数</th><th class="num">未命中</th><th class="num">平均命中率</th>');
    expect(html).toContain('<tr><td><a href="#cu-0">Codex · owner 线程</a></td><td class="num">13% · 52,000 / 400,000</td><td class="num">6</td><td class="num">8</td><td class="num"><span class="s-fail">1</span></td><td class="num">48%</td></tr>');
    expect(html).toContain('<tr><td><a href="#cu-1">Pi · 群 7</a></td><td class="num">—</td><td class="num">1</td><td class="num">1</td><td class="num">0</td><td class="num">0%</td></tr>');
    // 进度条组件不再出现在本页（完整条在 Agent 页）。
    expect(html).not.toContain('data-ctx=');
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<script(?![^>]*type="module")/);
  });

  it('走势条：data-h / data-c 整数百分比、title 写时间 · 输入 · 命中 · 原因，miss / partial / compact 样式与一道分隔符', async () => {
    const r = await rig(); seed(r);
    const codex = sectionOf((await r.html('/context-usage')).html, 'Codex · owner 线程');
    expect(codex).toContain('最近 8 次请求（6 个票据） · 未命中 1 次 · 窗口 400,000');
    const bars = [...codex.matchAll(/<span class="(cu-bar[^"]*)" data-h="(\d+)" title="([^"]*)"><i class="cu-c" data-c="(\d+)"><\/i><\/span>/g)].map(m => [m[1], m[2], m[4], m[3]]);
    expect(bars.map(b => b.slice(0, 3))).toEqual([
      ['cu-bar cu-first', '50', '0'], ['cu-bar', '52', '96'], ['cu-bar cu-miss', '54', '2'],
      ['cu-bar cu-partial', '55', '73'], ['cu-bar cu-compact', '13', '0'], ['cu-bar cu-compact', '13', '2'],
      ['cu-bar', '13', '96'], ['cu-bar', '14', '98'], ['cu-bar cu-partial', '15', '67'],
    ]);
    // title：票据 <短 id> · 第 n/N 次请求 · 时间 · 输入 · 命中 · 原因；票据 id 转义。压缩记录没有票据，不带前缀。
    expect(bars[2]![3]).toMatch(/^票据 tk-miss · 第 1\/1 次请求 · [^·]+ · 输入 215,000 · 命中 3,712（2%） · 未命中：间隔 90 分钟$/);
    expect(bars[3]![3]).toMatch(/^票据 tk-partial · 第 1\/1 次请求 · [^·]+ · 输入 220,000 · 命中 160,000（73%） · 部分命中：未知（可能是服务端缓存过期或驱逐）$/);
    expect(bars[1]![3]).toMatch(/^票据 t&lt;&quot;x&quot;&gt; · 第 1\/1 次请求 · [^·]+ · 输入 208,000 · 命中 200,000（96%）$/);
    expect(bars[4]![3]).toMatch(/^[^·]+ · 输入 50,000 · 命中 0（0%） · 压缩后$/);
    expect(bars[7]![3]).toMatch(/^票据 tk-multi · 第 2\/3 次请求 · [^·]+ · 输入 54,000 · 命中 53,000（98%）$/);
    expect(bars[8]![3]).toMatch(/^票据 tk-multi · 第 3\/3 次请求 · [^·]+ · 输入 60,000 · 命中 40,000（67%） · 部分命中：/);
    // 分组：每个票据一个 .cu-group，data-g 随票据交替；tk-multi 三根条在同一组内；压缩记录在组外。
    const groups = [...codex.matchAll(/<span class="cu-group" data-g="([01])">((?:<span class="cu-bar[^"]*"[^>]*><i[^>]*><\/i><\/span>)+)<\/span>/g)]
      .map(m => [m[1], (m[2]!.match(/class="cu-bar/g) ?? []).length]);
    expect(groups).toEqual([['0', 1], ['1', 1], ['0', 1], ['1', 1], ['0', 1], ['1', 3]]);
    expect(codex).toMatch(/<\/span><\/span><i class="cu-sep" title="压缩后" aria-hidden="true"><\/i><span class="cu-bar cu-compact" data-h="13" title="[^"]*"><i class="cu-c" data-c="0"><\/i><\/span><span class="cu-group" data-g="0">/);
    expect(codex.match(/class="cu-sep"/g)).toHaveLength(1);
    expect(codex).toContain('role="img" aria-label="Codex · owner 线程 最近 8 次请求（6 个票据）的上下文占用走势，未命中 1 次"');
    expect(codex).toContain('<i class="cu-key k-g" aria-hidden="true"></i>同一票据的请求');
    expect(codex).toContain('<a href="/context-usage?backend=codex&amp;key=owner">只看此线程</a>');
    const page = (await r.html('/context-usage')).html;
    expect(page).toContain('.cu-bar[data-h="54"]{height:54%}.cu-c[data-c="54"]{height:54%}');
    expect(page).toContain('.cu-group[data-g="1"]{');
  });

  it('明细表：默认折叠，票据段最新在上、段内按请求顺序，请求列 n/N，同票据后续行 └ 第 n 次，票据链接转义', async () => {
    const r = await rig(); seed(r);
    const codex = sectionOf((await r.html('/context-usage')).html, 'Codex · owner 线程');
    expect(codex).toContain('<details class="mt"><summary>明细（9 条，最新票据在上）</summary>');
    expect(codex).toContain('<th>时间</th><th>票据</th><th class="num">请求</th><th class="num">输入</th><th class="num">缓存命中</th><th class="num">未命中</th><th class="num">占窗口</th><th>标记</th><th>原因</th><th class="num">与上一请求间隔</th>');
    const tickets = [...codex.matchAll(/<a class="mono" href="\/tickets\/([^"]+)">/g)].map(m => m[1]);
    expect(tickets).toEqual(['tk-multi', 'tk-after', '%40context', 'tk-partial', 'tk-miss', 't%3C%22x%22%3E', 'tk-first']);
    // tk-multi 只在首行放链接，后两行写 └ 第 n 次；请求列 n/N；间隔为与上一请求（票据内）的间隔。
    expect(codex).toMatch(/<a class="mono" href="\/tickets\/tk-multi">tk-multi<\/a><\/td><td class="num">1\/3<\/td><td class="num">53,000<\/td>[^]*?<td class="num">1 分 0 秒<\/td><\/tr><tr><td>[^<]+<\/td><td><span class="muted">└ 第 2 次<\/span><\/td><td class="num">2\/3<\/td><td class="num">54,000<\/td><td class="num">53,000<\/td><td class="num">1,000<\/td><td class="num">14%<\/td><td>—<\/td><td>—<\/td><td class="num">10 秒<\/td><\/tr><tr><td>[^<]+<\/td><td><span class="muted">└ 第 3 次<\/span><\/td><td class="num">3\/3<\/td><td class="num">60,000<\/td>[^]*?<span class="changed cu-m-partial"/);
    expect(codex.match(/└ 第 \d 次/g)).toEqual(['└ 第 2 次', '└ 第 3 次']);
    // 压缩记录行没有请求序号。
    expect(codex).toMatch(/href="\/tickets\/%40context">@context<\/a><\/td><td class="num">—<\/td><td class="num">50,000<\/td>/);
    expect(codex).toContain('<a class="mono" href="/tickets/t%3C%22x%22%3E">t&lt;&quot;x&quot;&gt;</a>');
    expect(codex).not.toContain('t<"x">');
    expect(codex).toMatch(/<a class="mono" href="\/tickets\/tk-miss">tk-miss<\/a><\/td><td class="num">1\/1<\/td><td class="num">215,000<\/td><td class="num">3,712<\/td><td class="num">211,288<\/td><td class="num">54%<\/td><td><span class="changed cu-m-miss" title="间隔 90 分钟">未命中<\/span><\/td><td>间隔 90 分钟<\/td><td class="num">1 时 30 分<\/td>/);
    expect(codex).toMatch(/href="\/tickets\/tk-partial">tk-partial<\/a>[^]*?<span class="changed cu-m-partial" title="未知（可能是服务端缓存过期或驱逐）">部分命中<\/span>/);
    expect(codex).toMatch(/href="\/tickets\/tk-first">tk-first<\/a>[^]*?<td><span class="muted">首轮<\/span><\/td><td>—<\/td><td class="num">—<\/td><\/tr>/);
    expect(codex).toMatch(/href="\/tickets\/t%3C%22x%22%3E">[^<]*<\/a><\/td><td class="num">1\/1<\/td><td class="num">208,000<\/td><td class="num">200,000<\/td><td class="num">8,000<\/td><td class="num">52%<\/td><td>—<\/td><td>—<\/td><td class="num">1 分 0 秒<\/td>/);
  });

  it('参数：backend / key 过滤、limit 截取与上限、miss / partial 阈值覆盖、非法 backend 忽略', async () => {
    const r = await rig(); seed(r);
    const pi = (await r.html('/context-usage?backend=pi')).html;
    expect(pi).toContain('Pi · 群 7'); expect(pi).not.toContain('Codex · owner 线程');
    expect(pi).toContain('<option value="pi" selected>Pi</option>');
    expect(pi).toContain('<a class="btn quiet" href="/context-usage">清除</a>');
    const one = (await r.html('/context-usage?backend=codex&key=owner&limit=5')).html;
    expect(one).not.toContain('Pi · 群 7');
    expect(one).not.toContain('只看此线程');
    expect(one).toContain('name="key" value="owner"'); expect(one).toContain('name="limit" value="5"');
    // limit=5 保留五次请求（tk-partial、tk-after、tk-multi×3），期间的一条压缩分隔不占请求预算。
    expect(one.match(/<span class="cu-bar/g)).toHaveLength(6);
    expect(one).toContain('最近 5 次请求（3 个票据）');
    // 截断窗口只剩 tk-multi 的后两次时，N 仍为已知最大 seq。
    const tail = (await r.html('/context-usage?backend=codex&key=owner&limit=2')).html;
    expect(tail).toContain('最近 2 次请求（1 个票据）');
    expect(tail).toMatch(/<span class="cu-group" data-g="0"><span class="cu-bar cu-first" data-h="14" title="票据 tk-multi · 第 2\/3 次请求 · /);
    expect((await r.html('/context-usage?limit=999')).html).toContain('name="limit" value="200"');
    const loose = (await r.html('/context-usage?backend=codex&miss=0.01&partial=0.5')).html;
    expect(loose).toContain('name="miss" value="0.01"'); expect(loose).toContain('name="partial" value="0.5"');
    expect(loose).not.toContain('cu-bar cu-miss');
    expect(loose).toContain('cu-bar cu-partial" data-h="54"');
    expect(loose).toContain('最近 8 次请求（6 个票据） · 未命中 0 次');
    const bogus = (await r.html('/context-usage?backend=nope&miss=7')).html;
    expect(bogus).toContain('Pi · 群 7'); expect(bogus).toContain('Codex · owner 线程');
    expect(bogus).toContain('name="miss" value=""'); expect(bogus).toContain('cu-bar cu-miss');
  });

  it('空数据：无记录与过滤后无线程分别给出 empty 提示', async () => {
    const r = await rig();
    const none = await r.html('/context-usage');
    expect(none.status).toBe(200);
    expect(none.html).toContain('<div class="empty">还没有上下文占用记录。');
    expect(none.html).not.toContain('线程汇总');
    r.usage(Date.now(), 'tk', {});
    expect((await r.html('/context-usage?backend=pi')).html).toContain('<div class="empty">没有符合条件的线程。');
  });
});

describe('票据页与 agents 页的上下文监控入口', () => {
  it('票据页模型回合行显示命中 X / Y（Z%）与 miss 标记，压缩后的回合不标 miss，无数据不显示', async () => {
    const r = await rig(); seed(r);
    const miss = (await r.html('/tickets/tk-miss')).html;
    expect(miss).toMatch(/<span class="stage">模型回合<\/span><span class="muted cu-hit" title="[^"]* · 输入 215,000 · 命中 3,712（2%） · 未命中：间隔 90 分钟">命中 3,712 \/ 215,000（2%）<\/span><span class="changed cu-m-miss" title="间隔 90 分钟">未命中<\/span>/);
    expect(miss.match(/class="muted cu-hit"/g)).toHaveLength(1);
    // 基准与本回合之间夹着 @context 的压缩记录：与 /context-usage 同一判定，标 compact 而不是 miss。
    const after = (await r.html('/tickets/tk-after')).html;
    expect(after).toMatch(/<span class="muted cu-hit" title="[^"]* · 输入 52,000 · 命中 1,000（2%） · 压缩后">命中 1,000 \/ 52,000（2%）<\/span>/);
    expect(after).not.toContain('class="changed cu-m-');
    const plain = (await r.html('/tickets/tk-plain')).html;
    expect(plain).toContain('模型回合');
    expect(plain).not.toContain('class="muted cu-hit"'); expect(plain).not.toContain('命中 ');
  });

  it('票据页多请求：模型回合行给请求数，下方逐次列出 第 n 次：命中 X / Y（Z%）与标记', async () => {
    const r = await rig(); seed(r);
    const multi = (await r.html('/tickets/tk-multi')).html;
    expect(multi).toMatch(/<span class="stage">模型回合<\/span><span class="muted cu-hit">3 次请求<\/span>/);
    const list = /<ul class="cu-reqs">(.*?)<\/ul>/.exec(multi)?.[1] ?? '';
    const items = [...list.matchAll(/<li>(.*?)<\/li>/g)].map(m => m[1]!.replace(/ title="[^"]*"/g, ''));
    expect(items).toEqual([
      '<span class="muted cu-hit">第 1 次：命中 51,000 / 53,000（96%）</span>',
      '<span class="muted cu-hit">第 2 次：命中 53,000 / 54,000（98%）</span>',
      '<span class="muted cu-hit">第 3 次：命中 40,000 / 60,000（67%）</span><span class="changed cu-m-partial">部分命中</span>',
    ]);
    // 第 1 次以 tk-after（不同票据）为基准：52,000 → 命中 51,000，不标记。
    expect(list).toMatch(/title="[^"]* · 输入 53,000 · 命中 51,000（96%）">第 1 次/);
    expect(multi.match(/class="cu-reqs"/g)).toHaveLength(1);
    expect(multi).not.toMatch(/\sstyle="/);
  });

  it('agents 页每条线程行带"监控"链接到 /context-usage?backend=…&key=…', async () => {
    const r = await rig();
    const { status, html } = await r.html('/agents');
    expect(status).toBe(200);
    expect(html).toContain('<a class="btn quiet" href="/context-usage?backend=codex&amp;key=owner" title="上下文长度走势与缓存未命中">监控</a>');
    expect(html).toContain('<a class="btn quiet" href="/context-usage?backend=pi&amp;key=group%3A7" title="上下文长度走势与缓存未命中">监控</a>');
  });
});
