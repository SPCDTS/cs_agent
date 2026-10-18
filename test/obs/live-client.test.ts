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

const head = (over: Record<string, unknown> = {}) => ({ ticket: 't1', scope: 'group:7', text: '你好', sender: '小明', route: '', backend: '', state: 'running', phase: '',
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
});
