import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../../src/obs/ui/client.js';
import { MESSAGE_ERROR_HINT } from '../../src/obs/ui/memory-pages.js';

type Listener = (e: unknown) => void;
/** memory.js 所需的最小 DOM：元素树、textContent、dataset、hidden / disabled、监听器。 */
class El {
  children: El[] = [];
  parentNode: El | null = null;
  className = ''; id = ''; hidden = false; disabled = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  private own = '';
  constructor(readonly tagName: string, text = '') { this.own = text; }
  get textContent(): string { return this.own + this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { this.replaceChildren(); this.own = String(v); }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  append(...ns: El[]) { for (const n of ns) { n.parentNode = this; this.children.push(n); } }
  replaceChildren(...ns: El[]) { for (const c of this.children) c.parentNode = null; this.children = []; this.own = ''; this.append(...ns); }
  all(): El[] { return this.children.flatMap(c => [c, ...c.all()]); }
  click() { for (const fn of this.listeners.click ?? []) fn({}); }
}
const mk = (tag: string, id: string, attrs: Partial<El> = {}) => Object.assign(new El(tag.toUpperCase()), { id, ...attrs });

interface Reply { status: number; body: unknown }
const R0 = Date.UTC(2026, 9, 1), R1 = Date.UTC(2026, 9, 18);
const DATA = {
  scope: 'group:123', label: '群 123', range: { first_ts: R0, last_ts: R1 },
  retention_edges: { raw_until: R0 + 86400_000, day_until: R0 - 86400_000, week_until: R0 - 86400_000 },
  tracks: {
    raw: [{ start: R0, end: R0 + 3600_000, count: 2, senders: 1, preview: '<b>首条</b>' }, { start: R1 - 3600_000, end: R1 + 3600_000, count: 8, senders: 3 }],
    day: [{ id: 7, kind: 'day', period_start: R0, period_end: R0 + 86400_000, created_at: R1, chars: 30, preview: '<script>x</script>日摘要', source_messages: 9 }],
    week: [{ id: 9, kind: 'week', period_start: R0 - 7 * 86400_000, period_end: R0, created_at: R1, chars: 90, preview: '周摘要', source_messages: null }],
  },
  gaps: [{ from: R0 + 7200_000, to: R0 + 86400_000, reason: 'purged' }, { from: R0 + 86400_000, to: R0 + 2 * 86400_000, reason: 'no_records' }],
  window: { after: R0 - 1, before: R1 }, next_before: R1 - 50_000, limit: 50,
};
const msg = (i: number, extra: Record<string, unknown> = {}) => ({ message_id: `m${i}`, ts: R1 - i * 1000, sender: '789', sender_name: `<i>用户${i}</i>`, text: `正文 <script>${i}</script>`, media: 0, ...extra });

function boot(o: { data?: unknown; vis?: boolean; fetch: (url: string) => Reply | Promise<Reply> }) {
  const root = new El('BODY');
  const data = mk('script', 'memory-data'); data.textContent = JSON.stringify(o.data ?? DATA);
  const list = mk('ol', 'msgs'), more = mk('button', 'msg-more'), note = mk('p', 'msg-note'), none = mk('div', 'msg-empty', { hidden: true }), win = mk('small', 'msg-window');
  const box = mk('div', 'mtl'), visible = mk('button', 'mtl-visible', { hidden: true }), reset = mk('button', 'mtl-reset', { hidden: true }), section = mk('section', 'messages');
  box.append(new El('P', '正在绘制时间线…'));
  for (let i = 0; i < 50; i++) list.append(mk('li', '', { className: 'msg' }));
  root.append(data, list, more, note, none, win, box, visible, reset, section);
  const requests: string[] = [];
  const timelines: FakeTimeline[] = [];
  class DataSet { constructor(readonly items: Record<string, unknown>[]) {} }
  class FakeTimeline {
    custom: Record<string, number> = {}; markers: Record<string, string> = {}; handlers: Record<string, Listener[]> = {}; window = { start: new Date(R0 + 1000), end: new Date(R0 + 5000) };
    constructor(readonly box: El, readonly items: DataSet, readonly groups: DataSet, readonly options: Record<string, unknown>) { timelines.push(this); }
    addCustomTime(t: number, id: string) { this.custom[id] = t; }
    setCustomTimeMarker(title: string, id: string) { this.markers[id] = title; }
    setCustomTime(t: number, id: string) { this.custom[id] = t; }
    on(ev: string, fn: Listener) { (this.handlers[ev] ??= []).push(fn); }
    emit(ev: string, p: unknown) { for (const fn of this.handlers[ev] ?? []) fn(p); }
    getWindow() { return this.window; }
    setWindow(a: number, b: number) { this.window = { start: new Date(a), end: new Date(b) }; }
  }
  const document = {
    getElementById: (id: string) => root.all().find(e => e.id === id) ?? null,
    createElement: (tag: string) => new El(tag.toUpperCase()),
    createTextNode: (t: string) => new El('#text', t),
  };
  const location = { href: '/memory/scopes/group%3A123' };
  const fetch = async (url: string) => { requests.push(url); const r = await o.fetch(url); return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }; };
  vm.runInNewContext(ASSETS['memory.js']!, { document, location, fetch, URLSearchParams, ...(o.vis === false ? {} : { vis: { Timeline: FakeTimeline, DataSet } }) });
  const settle = () => new Promise(r => setTimeout(r, 0));
  return { root, list, more, note, none, win, box, visible, reset, requests, timelines, location, settle };
}

describe('memory.js 消息列表', () => {
  it('"更早"沿 next_before 翻页（保持窗口 after），追加到末尾；没有下一页时隐藏', async () => {
    const pages: Reply[] = [{ status: 200, body: { items: [msg(50), msg(51)], next_before: R1 - 51_000 } }, { status: 200, body: { items: [msg(52)] } }];
    const b = boot({ fetch: () => pages.shift()! });
    b.more.click(); await b.settle();
    const u1 = new URL(b.requests[0]!, 'http://x');
    expect(u1.pathname).toBe('/api/memory/scopes/group%3A123/messages');
    expect(Object.fromEntries(u1.searchParams)).toEqual({ before: String(R1 - 50_000), after: String(R0 - 1), limit: '50' });
    expect(b.list.children).toHaveLength(52);
    expect(b.more.hidden).toBe(false); expect(b.more.disabled).toBe(false);
    b.more.click(); await b.settle();
    expect(new URL(b.requests[1]!, 'http://x').searchParams.get('before')).toBe(String(R1 - 51_000));
    expect(b.list.children).toHaveLength(53);
    expect(b.more.hidden).toBe(true);
    expect(b.note.textContent).toBe('已到这个窗口最早的消息。');
    // 条目只用 textContent：标签字符原样作为文本，不成为元素
    const last = b.list.children.at(-1)!;
    expect(last.className).toBe('msg'); expect(last.dataset.ts).toBe(String(R1 - 52_000));
    expect(last.textContent).toContain('<i>用户52</i>'); expect(last.textContent).toContain('正文 <script>52</script>');
    expect(last.all().some(e => e.tagName === 'SCRIPT' || e.tagName === 'I')).toBe(false);
  });

  it('接口给出 next_before_id 时"更早"同时带 before 与 before_id；缺席时只带 before；换窗口后清空 id 游标', async () => {
    const pages: Reply[] = [
      { status: 200, body: { items: [msg(51)], next_before: R1 - 51_000, next_before_id: 4242 } },
      { status: 200, body: { items: [msg(52)], next_before: R1 - 52_000 } },
      { status: 200, body: { items: [msg(53)], next_before: R1 - 53_000 } },
    ];
    const b = boot({ data: { ...DATA, next_before_id: 777 }, fetch: () => pages.shift() ?? { status: 200, body: { items: [] } } });
    const q = (i: number) => Object.fromEntries(new URL(b.requests[i]!, 'http://x').searchParams);
    b.more.click(); await b.settle();
    expect(q(0)).toEqual({ before: String(R1 - 50_000), before_id: '777', after: String(R0 - 1), limit: '50' });
    b.more.click(); await b.settle();
    expect(q(1)).toEqual({ before: String(R1 - 51_000), before_id: '4242', after: String(R0 - 1), limit: '50' });
    b.more.click(); await b.settle();
    expect(q(2)).toEqual({ before: String(R1 - 52_000), after: String(R0 - 1), limit: '50' });
    // 点击原文桶：首页只带窗口界限，不沿用旧 id
    b.timelines[0]!.emit('click', { item: 'r0' }); await b.settle();
    expect(q(3)).toEqual({ before: String(R0 + 3600_000), after: String(R0 - 1), limit: '50' });
  });

  it('错误显示通用提示，可重试（400 不再特殊处理）', async () => {
    const replies: Reply[] = [{ status: 400, body: { error: 'before 必须晚于 after' } }, { status: 500, body: { error: '坏了' } }];
    const b = boot({ fetch: () => replies.shift()! });
    b.more.click(); await b.settle();
    expect(b.note.textContent).toBe(`${MESSAGE_ERROR_HINT}（HTTP 400：before 必须晚于 after），可重试`);
    expect(b.note.className).toBe('hint err'); expect(b.more.hidden).toBe(false); expect(b.more.disabled).toBe(false);
    expect(b.list.children).toHaveLength(50);
    b.more.click(); await b.settle();
    expect(b.note.textContent).toContain('HTTP 500'); expect(b.more.hidden).toBe(false);
  });

  it('并发点击只发一个请求', async () => {
    let release: (r: Reply) => void = () => undefined;
    const b = boot({ fetch: () => new Promise<Reply>(r => { release = r; }) });
    b.more.click(); b.more.click();
    expect(b.requests).toHaveLength(1);
    release({ status: 200, body: { items: [] } }); await b.settle();
  });
});

describe('memory.js 时间线', () => {
  it('三条轨 + 空白背景 + 保留边界；内容与提示是元素（文本不解析为 HTML）', () => {
    const b = boot({ fetch: () => ({ status: 200, body: { items: [] } }) });
    const t = b.timelines[0]!;
    expect(t.box).toBe(b.box); expect(b.box.children).toHaveLength(0);
    expect(t.groups.items.map(g => [g.id, (g.content as El).textContent])).toEqual([['raw', '原文'], ['day', '日摘要'], ['week', '周摘要']]);
    const items = t.items.items as { id: string; group?: string; type: string; className: string; content: El; title?: El; start: number; end: number }[];
    expect(items.map(i => [i.id, i.group, i.type, i.className])).toEqual([
      ['r0', 'raw', 'range', 'm-raw d1'], ['r1', 'raw', 'range', 'm-raw d4'],
      ['s7', 'day', 'range', 'm-day'], ['s9', 'week', 'range', 'm-week'],
      ['g0', undefined, 'background', 'gap-purged'], ['g1', undefined, 'background', 'gap-none'],
    ]);
    expect(items[0]!.content.textContent).toBe('2');
    expect(items[0]!.title!.textContent).toContain('2 条 · 1 人'); expect(items[0]!.title!.textContent).toContain('首条：<b>首条</b>');
    expect(items[2]!.content.textContent).toBe('<script>x</script>日摘要');
    expect(items[2]!.title!.textContent).toContain('生成时 9 条原文');
    expect(items[4]!.content.textContent).toBe('早于保留边界（推算）'); expect(items[5]!.content.textContent).toBe('无现存记录');
    for (const i of items) { expect(i.content).toBeInstanceOf(El); if (i.title) expect(i.title).toBeInstanceOf(El); }
    expect(t.options).toMatchObject({ start: R0, end: R1, stack: false });
    expect(t.custom).toEqual({ 'edge-raw': DATA.retention_edges.raw_until, 'edge-sum': DATA.retention_edges.day_until });
    expect(t.markers).toEqual({ 'edge-raw': '原文保留边界', 'edge-sum': '摘要保留边界' });
    // 边界线被拖动后复位
    t.custom['edge-raw'] = 1; t.emit('timechanged', { id: 'edge-raw' });
    expect(t.custom['edge-raw']).toBe(DATA.retention_edges.raw_until);
    expect(b.visible.hidden).toBe(false); expect(b.reset.hidden).toBe(false);
  });

  it('点击原文桶 → 以桶区间（裁到查询范围）重新列消息；点击摘要 → 摘要页；可视范围按钮', async () => {
    const b = boot({ fetch: () => ({ status: 200, body: { items: [msg(1)], next_before: R1 - 1000 } }) });
    const t = b.timelines[0]!;
    t.emit('click', { item: 'r1' }); await b.settle();
    const q = new URL(b.requests[0]!, 'http://x').searchParams;
    expect(Object.fromEntries(q)).toEqual({ before: String(R1), after: String(R1 - 3600_000 - 1), limit: '50' });
    expect(b.list.children).toHaveLength(1);
    expect(b.win.textContent).toContain('原文桶：');
    expect(b.more.hidden).toBe(false);
    b.more.click(); await b.settle();
    expect(Object.fromEntries(new URL(b.requests[1]!, 'http://x').searchParams)).toEqual({ before: String(R1 - 1000), after: String(R1 - 3600_000 - 1), limit: '50' });
    b.visible.click(); await b.settle();
    expect(Object.fromEntries(new URL(b.requests[2]!, 'http://x').searchParams)).toEqual({ before: String(R0 + 5000), after: String(R0 + 999), limit: '50' });
    t.emit('click', { item: 'g0' }); t.emit('click', { item: null });
    expect(b.requests).toHaveLength(3);
    t.emit('click', { item: 's7' });
    expect(b.location.href).toBe('/memory/summaries/7');
  });

  it('没有 vis（组件未加载）时不报错，消息翻页仍可用', async () => {
    const b = boot({ vis: false, fetch: () => ({ status: 200, body: { items: [] } }) });
    expect(b.timelines).toHaveLength(0);
    expect(b.box.textContent).toBe('时间线组件未能加载，下面仍可查看摘要与消息列表。');
    expect(b.box.children[0]!.className).toBe('flash err');
    b.more.click(); await b.settle();
    expect(b.requests).toHaveLength(1);
  });
});
