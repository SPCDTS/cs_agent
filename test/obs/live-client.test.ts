import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../../src/obs/ui/client.js';

/** 足够 live.js 运行的最小 DOM：元素树、textContent、dataset、简单选择器。 */
class El {
  children: El[] = [];
  parentNode: El | null = null;
  className = ''; hidden = false; href = '';
  scrollTop = 0; clientHeight = 0; scrollHeight = 0;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  private own = '';
  [k: `_${string}`]: unknown;
  constructor(readonly tagName: string, text = '') { this.own = text; }
  get textContent(): string { return this.own + this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { this.detachAll(); this.own = String(v); }
  get firstChild(): El | undefined { return this.children[0]; }
  get lastElementChild(): El | undefined { return this.children.at(-1); }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => { if (!list().includes(c)) this.className = [...list(), c].join(' '); },
      toggle: (c: string, on: boolean) => { this.className = (on ? [...list().filter(x => x !== c), c] : list().filter(x => x !== c)).join(' '); },
      contains: (c: string) => list().includes(c),
    };
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  private adopt(n: El) { n.remove(); n.parentNode = this; return n; }
  append(...ns: El[]) { for (const n of ns) this.children.push(this.adopt(n)); }
  prepend(...ns: El[]) { for (const n of ns.reverse()) this.children.unshift(this.adopt(n)); }
  remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  private detachAll() { for (const c of this.children) c.parentNode = null; this.children = []; this.own = ''; }
  replaceChildren(...ns: El[]) { this.detachAll(); this.append(...ns); }
  replaceChild(n: El, old: El) { const i = this.children.indexOf(old); this.adopt(n); this.children[i] = n; old.parentNode = null; }
  private all(): El[] { return this.children.flatMap(c => [c, ...c.all()]); }
  private static match(e: El, sel: string): boolean {
    let m: RegExpExecArray | null;
    if (sel.startsWith('.')) return e.className.split(/\s+/).includes(sel.slice(1));
    if ((m = /^\[data-([a-z]+)="(.*)"\]$/.exec(sel))) return e.dataset[m[1]!] === m[2];
    if ((m = /^\[data-([a-z]+)\]$/.exec(sel))) return m[1]! in e.dataset;
    return e.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel: string): El[] { return this.all().filter(e => El.match(e, sel)); }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
}

function boot() {
  const root = new El('BODY');
  const ids: Record<string, El> = {};
  for (const id of ['inflight', 'done', 'conn', 'live-count', 'inflight-empty', 'done-empty']) { ids[id] = new El('DIV'); root.append(ids[id]!); }
  const listeners: Record<string, (e: { data: string }) => void> = {};
  const document = {
    getElementById: (id: string) => ids[id] ?? null,
    createElement: (tag: string) => new El(tag.toUpperCase()),
    createTextNode: (t: string) => new El('#text', t),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
  };
  class EventSource { onerror: unknown; constructor(readonly url: string) {} addEventListener(type: string, fn: (e: { data: string }) => void) { listeners[type] = fn; } }
  vm.runInNewContext(ASSETS['live.js']!, { document, EventSource, CSS: { escape: (s: string) => s }, setInterval: () => 0, Date, Math, JSON, Number, String, isFinite, encodeURIComponent });
  const emit = (type: string, data: unknown) => listeners[type]!({ data: JSON.stringify(data) });
  return { ids, emit };
}

const head = (over: Record<string, unknown> = {}) => ({ ticket: 't1', scope: 'group:7', text: '你好', sender: '小明', route: '', backend: '', thread: '', state: 'running', phase: '',
  phase_since: 0, started: 0, updated: 0, finished: null, outcome: '', late_images: 0, dropped: 0, seq: 0, ...over });

describe('live.js 客户端渲染', () => {
  it('事件流超过 80 条后继续渲染新事件（按 seq 增量），并只保留最近 80 行', () => {
    const { ids, emit } = boot();
    emit('snapshot', { now: Date.now(), count: 0 }); emit('snapshot_end', { count: 0 });
    for (let seq = 1; seq <= 100; seq++)
      emit('card', { card: head({ seq, updated: seq }), item: { seq, ts: seq, stage: 'tool:shell', status: 'ok', duration_ms: null, summary: `事件 ${seq}` } });
    const feed = ids.inflight!.querySelector('.feed')!;
    expect(feed.children).toHaveLength(80);
    expect(feed.lastElementChild!.textContent).toContain('事件 100');
    expect(feed.firstChild!.textContent).toContain('事件 21');
    // 重复（已在快照中的）事件不再渲染
    emit('card', { card: head({ seq: 100 }), item: { seq: 100, ts: 100, stage: 'tool:shell', status: 'ok', duration_ms: null, summary: '重复' } });
    expect(feed.textContent).not.toContain('重复');
  });

  it('快照逐卡到达后，增量从卡片已有 seq 之后续接', () => {
    const { ids, emit } = boot();
    const items = Array.from({ length: 80 }, (_, i) => ({ seq: i + 21, ts: i, stage: 'tool:shell', status: 'ok', duration_ms: null, summary: `事件 ${i + 21}` }));
    emit('snapshot', { now: Date.now(), count: 2 });
    emit('snapcard', { card: { ...head({ seq: 100 }), items } });
    emit('snapcard', { card: { ...head({ ticket: 't2', finished: 5, state: 'done', outcome: 'reply_sent' }), items: [] } });
    emit('snapshot_end', { count: 2 });
    expect(ids.done!.children).toHaveLength(1);
    expect(ids.conn!.textContent).toBe('实时连接中');
    emit('card', { card: head({ seq: 101 }), item: { seq: 101, ts: 101, stage: 'tool:shell', status: 'ok', duration_ms: null, summary: '事件 101' } });
    const feed = ids.inflight!.querySelector('.feed')!;
    expect(feed.children).toHaveLength(80);
    expect(feed.lastElementChild!.textContent).toContain('事件 101');
  });

  it('卡片页头的路由、后端、发送者在后续更新中刷新', () => {
    const { ids, emit } = boot();
    emit('snapshot', { now: Date.now(), count: 0 }); emit('snapshot_end', { count: 0 });
    const item = (seq: number) => ({ seq, ts: seq, stage: 'routed', status: 'ok', duration_ms: null, summary: '' });
    emit('card', { card: head({ seq: 1, sender: '' }), item: item(1) });
    const top = ids.inflight!.querySelector('.slip-top')!;
    const pills = () => top.querySelectorAll('.pill');
    expect(pills().every(p => p.hidden)).toBe(true);
    emit('card', { card: head({ seq: 2, route: 'agent' }), item: item(2) });
    emit('card', { card: head({ seq: 3, route: 'agent', backend: 'pi', state: 'running' }), item: item(3) });
    expect(pills().filter(p => !p.hidden).map(p => p.textContent)).toEqual(['执行 agent', 'Pi']);
    expect(top.querySelector('.who')!.textContent).toBe('小明');
    expect(ids.inflight!.querySelectorAll('.slip-top')).toHaveLength(1);
  });

  it('卡片头部的小型占用条：首帧 context 快照填充，context 增量原地更新（档位、宽度、阈值、估算）', () => {
    const { ids, emit } = boot();
    const u = (over: Record<string, unknown> = {}) => ({ backend: 'pi', key: 'group:7', usedTokens: 64_000, windowTokens: 128_000, turns: 3, updatedAt: Date.now(), source: 'turn', ...over });
    emit('snapshot', { now: Date.now(), count: 1 });
    emit('context', { usage: u() });
    emit('snapcard', { card: { ...head({ seq: 1, backend: 'pi', thread: 'group:7' }), items: [] } });
    emit('snapshot_end', { count: 1 });
    const bar = () => ids.inflight!.querySelector('[data-ctx="pi|group:7"]')!;
    const first = bar();
    expect(first.className).toBe('ctx ctx-t-ok ctx-mini');
    expect(first.querySelector('.ctx-fill')!.dataset.w).toBe('50');
    expect(first.querySelector('.ctx-pct')!.textContent).toBe('50%');
    expect(first.querySelector('.ctx-short')!.textContent).toBe('64k / 128k');
    expect(first.parentNode!.className).toBe('slip-top');
    emit('context', { usage: u({ usedTokens: 120_000, compaction: { background: 89_600, reserve: 112_000 } }) });
    expect(bar()).toBe(first); // 原地更新，不重建
    expect(first.className).toBe('ctx ctx-t-hot ctx-mini');
    expect(first.querySelector('.ctx-fill')!.dataset.w).toBe('94');
    expect(first.querySelector('.ctx-pct')!.textContent).toBe('94%');
    expect(first.querySelector('.ctx-bg')!.dataset.at).toBe('70');
    expect(first.querySelector('.ctx-rs')!.attrs.title).toContain('阻塞压缩阈值：112,000 tokens');
    emit('context', { usage: u({ usedTokens: 1_000, source: 'estimate', updatedAt: Date.now() - 48 * 3600_000 }) });
    expect(first.className).toBe('ctx ctx-t-ok ctx-est ctx-stale ctx-mini');
    expect(first.querySelector('.ctx-bg')).toBeNull();
    // 别的线程的增量不影响本卡
    emit('context', { usage: u({ key: 'owner', usedTokens: 127_000 }) });
    expect(first.querySelector('.ctx-pct')!.textContent).toBe('<1%');
  });

  it('线程键在后续事件中才出现时补上占用条；没有记录时显示占位', () => {
    const { ids, emit } = boot();
    emit('snapshot', { now: Date.now(), count: 0 }); emit('snapshot_end', { count: 0 });
    const item = (seq: number) => ({ seq, ts: seq, stage: 'thread_wait', status: 'started', duration_ms: null, summary: '' });
    emit('card', { card: head({ seq: 1, backend: 'codex' }), item: item(1) });
    expect(ids.inflight!.querySelector('.ctx')).toBeNull();
    emit('card', { card: head({ seq: 2, backend: 'codex', thread: 'shared' }), item: item(2) });
    const bar = ids.inflight!.querySelector('[data-ctx="codex|shared"]')!;
    expect(bar.className).toContain('ctx-none'); expect(bar.textContent).toContain('暂无占用数据');
    emit('context', { usage: { backend: 'codex', key: 'shared', usedTokens: 300_000, windowTokens: 400_000, turns: 1, updatedAt: Date.now(), source: 'turn' } });
    expect(bar.className).toBe('ctx ctx-t-warn ctx-mini'); expect(bar.querySelector('.ctx-pct')!.textContent).toBe('75%');
    emit('card', { card: head({ seq: 3, backend: 'codex', thread: 'shared' }), item: item(3) });
    expect(ids.inflight!.querySelectorAll('.ctx')).toHaveLength(1);
    emit('context', { usage: { backend: 'codex', key: 'shared', usedTokens: 237500, windowTokens: 500000, effectiveWindowTokens: 475000, turns: 2, updatedAt: Date.now(), source: 'turn' } });
    expect(bar.querySelector('.ctx-pct')!.textContent).toBe('50%');
    expect(bar.attrs.title).toContain('名义 500,000 / 有效 475,000');
  });
});

describe('usage.js（总览 / Codex / Pi 页）', () => {
  it('context 帧把服务端的"暂无数据"占位换成完整条，再次到达时原地更新数字与说明', () => {
    const root = new El('BODY');
    const placeholder = new El('DIV'); placeholder.className = 'ctx ctx-none'; placeholder.dataset.ctx = 'codex|owner';
    root.append(placeholder);
    const listeners: Record<string, (e: { data: string }) => void> = {};
    const document = { createElement: (t: string) => new El(t.toUpperCase()), createTextNode: (t: string) => new El('#text', t), querySelectorAll: (sel: string) => root.querySelectorAll(sel) };
    class EventSource { constructor(readonly url: string) { expect(url).toBe('/usage/stream'); } addEventListener(type: string, fn: (e: { data: string }) => void) { listeners[type] = fn; } }
    vm.runInNewContext(ASSETS['usage.js']!, { document, EventSource, CSS: { escape: (s: string) => s }, setInterval: () => 0, Date, Math, JSON, Number, String, isFinite, encodeURIComponent });
    const send = (usage: unknown) => listeners.context!({ data: JSON.stringify({ usage }) });
    send({ backend: 'codex', key: 'owner', usedTokens: 123_456, windowTokens: 400_000, cachedTokens: 100_000, turns: 7, updatedAt: Date.now(), source: 'turn' });
    const bar = root.querySelector('[data-ctx="codex|owner"]')!;
    expect(bar).not.toBe(placeholder);
    expect(bar.className).toBe('ctx ctx-t-ok');
    expect(bar.querySelector('.ctx-label')!.textContent).toBe('Codex · owner 线程');
    expect(bar.querySelector('.ctx-used')!.textContent).toBe('123,456');
    expect(bar.querySelector('.ctx-num')!.textContent).toBe('123,456 / 400,000 tokens');
    expect(bar.querySelector('.ctx-meta')!.textContent).toContain('缓存命中 100,000');
    send({ backend: 'codex', key: 'owner', usedTokens: 380_000, windowTokens: 400_000, turns: 8, updatedAt: Date.now() - 25 * 3600_000, source: 'turn' });
    expect(root.querySelector('[data-ctx="codex|owner"]')).toBe(bar);
    expect(bar.className).toBe('ctx ctx-t-hot ctx-stale');
    expect(bar.querySelector('.ctx-fill')!.dataset.w).toBe('95');
    expect(bar.querySelector('.ctx-meta')!.textContent).toContain('上次更新 25 小时前');
    send({ backend: 'codex', key: 'owner', usedTokens: 237500, windowTokens: 500000, effectiveWindowTokens: 475000, turns: 9, updatedAt: Date.now(), source: 'turn' });
    expect(bar.querySelector('.ctx-pct')!.textContent).toBe('50%');
    expect(bar.querySelector('.ctx-num')!.textContent).toBe('237,500 / 475,000 tokens');
    expect(bar.attrs.title).toBe('名义 500,000 / 有效 475,000');
    send({ backend: 'codex', key: 'owner', usedTokens: 237500, windowTokens: 500000, turns: 10, updatedAt: Date.now(), source: 'turn' });
    expect(bar.querySelector('.ctx-pct')!.textContent).toBe('48%');
    expect(bar.querySelector('.ctx-num')!.textContent).toBe('237,500 / 500,000 tokens');
    expect(bar.attrs.title).toBe('');
    send({ backend: 'codex', key: 'owner', usedTokens: 10701, windowTokens: 500000, turns: 10, updatedAt: Date.now(), source: 'compact' });
    expect(root.querySelector('[data-ctx="codex|owner"]')).toBe(bar);
    expect(bar.className).toBe('ctx ctx-t-ok ctx-est');
    expect(bar.querySelector('.ctx-num')!.textContent).toBe('10,701 / 500,000 tokens');
    expect(bar.querySelector('.ctx-meta')!.textContent).toContain('压缩后估算');
    expect(bar.querySelector('.ctx-meta')!.textContent).toContain('第 10 回合');
    expect(bar.querySelector('.ctx-meta')!.textContent).not.toContain('尚无真实回合用量');
  });

  it('总览的迷你条（无 .ctx-head / .ctx-meta）原地更新，不换节点、不抛错', () => {
    const root = new El('BODY');
    const mini = new El('DIV'); mini.className = 'ctx ctx-mini ctx-none'; mini.dataset.ctx = 'pi|group:7';
    const track = new El('SPAN'); track.className = 'ctx-track'; const fill = new El('I'); fill.className = 'ctx-fill'; fill.dataset.w = '0'; track.append(fill);
    const pct = new El('SPAN', '—'); pct.className = 'ctx-pct'; const short = new El('SPAN', '暂无占用数据'); short.className = 'ctx-short';
    mini.append(track, pct, short); root.append(mini);
    const listeners: Record<string, (e: { data: string }) => void> = {};
    const document = { createElement: (t: string) => new El(t.toUpperCase()), createTextNode: (t: string) => new El('#text', t), querySelectorAll: (sel: string) => root.querySelectorAll(sel) };
    class EventSource { addEventListener(type: string, fn: (e: { data: string }) => void) { listeners[type] = fn; } }
    vm.runInNewContext(ASSETS['usage.js']!, { document, EventSource, CSS: { escape: (s: string) => s }, setInterval: () => 0, Date, Math, JSON, Number, String, isFinite, encodeURIComponent });
    expect(() => listeners.context!({ data: JSON.stringify({ usage: { backend: 'pi', key: 'group:7', usedTokens: 64_000, windowTokens: 128_000, turns: 3, updatedAt: Date.now(), source: 'turn' } }) })).not.toThrow();
    expect(root.querySelector('[data-ctx="pi|group:7"]')).toBe(mini);
    expect(mini.className).toBe('ctx ctx-t-ok ctx-mini');
    expect(pct.textContent).toBe('50%'); expect(short.textContent).toBe('64k / 128k'); expect(fill.dataset.w).toBe('50');
    expect(mini.attrs.title).toContain('64,000 / 128,000 tokens');
  });
});

