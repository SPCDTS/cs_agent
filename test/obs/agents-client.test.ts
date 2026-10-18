import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../../src/obs/ui/client.js';

type Listener = (e: unknown) => void;
/** agents.js 所需的最小 DOM：元素树、textContent、dataset、类名 / data 属性 / 标签选择器、details.open + toggle。 */
class El {
  children: El[] = [];
  parentNode: El | null = null;
  className = ''; id = ''; type = ''; href = ''; disabled = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  private own = '';
  private isOpen = false;
  [k: `_${string}`]: unknown;
  constructor(readonly tagName: string, text = '') { this.own = text; }
  get textContent(): string { return this.own + this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { this.detachAll(); this.own = String(v); }
  get open() { return this.isOpen; }
  set open(v: boolean) { const was = this.isOpen; this.isOpen = !!v; if (was !== this.isOpen) for (const fn of this.listeners.toggle ?? []) fn({}); }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => { if (!list().includes(c)) this.className = [...list(), c].join(' '); },
      remove: (c: string) => { this.className = list().filter(x => x !== c).join(' '); },
      contains: (c: string) => list().includes(c),
    };
  }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  private adopt(n: El) { n.remove(); n.parentNode = this; return n; }
  append(...ns: El[]) { for (const n of ns) this.children.push(this.adopt(n)); }
  prepend(...ns: El[]) { for (const n of ns.reverse()) this.children.unshift(this.adopt(n)); }
  remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  private detachAll() { for (const c of this.children) c.parentNode = null; this.children = []; this.own = ''; }
  replaceChildren(...ns: El[]) { this.detachAll(); this.append(...ns); }
  all(): El[] { return this.children.flatMap(c => [c, ...c.all()]); }
  static match(e: El, sel: string): boolean {
    let m: RegExpExecArray | null;
    if (sel.startsWith('.')) return e.className.split(/\s+/).includes(sel.slice(1));
    if ((m = /^\[data-([a-z]+)="(.*)"\]$/.exec(sel))) return e.dataset[m[1]!] === m[2];
    return e.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel: string): El[] { return this.all().filter(e => El.match(e, sel)); }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
}
const mk = (tag: string, cls = '', text = '') => { const e = new El(tag.toUpperCase(), text); e.className = cls; return e; };

interface Reply { status: number; body: unknown }
function boot(o: { data?: unknown; build?: (root: El) => void; fetch: (url: string) => Reply | Promise<Reply> }) {
  const root = new El('BODY');
  if (o.data) { const d = mk('script'); d.id = 'agents-data'; d.textContent = JSON.stringify(o.data); root.append(d); }
  o.build?.(root);
  const docListeners: Record<string, Listener[]> = {};
  const document = {
    getElementById: (id: string) => root.all().find(e => e.id === id) ?? null,
    createElement: (tag: string) => new El(tag.toUpperCase()),
    createTextNode: (t: string) => new El('#text', t),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    addEventListener: (t: string, fn: Listener) => { (docListeners[t] ??= []).push(fn); },
  };
  const requests: string[] = [];
  const sources: FakeES[] = [];
  const timers: (() => unknown)[] = [];
  class FakeES {
    onopen?: () => void; onerror?: () => void; closed = false; ls: Record<string, Listener> = {};
    constructor(readonly url: string) { sources.push(this); }
    addEventListener(t: string, fn: Listener) { this.ls[t] = fn; }
    close() { this.closed = true; }
    emit(data: unknown) { this.ls.block!({ data: JSON.stringify(data) }); }
  }
  const fetch = async (url: string) => { requests.push(url); const r = await o.fetch(url); return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }; };
  vm.runInNewContext(ASSETS['agents.js']!, { document, location: { pathname: '/agents/codex/sessions/s1', hash: '' }, fetch, EventSource: FakeES, CSS: { escape: (s: string) => s },
    TextEncoder, navigator: {}, setTimeout: (fn: () => unknown) => { timers.push(fn); return 0; }, setInterval: () => 0 });
  const click = (target: El) => { for (const fn of docListeners.click ?? []) fn({ target, preventDefault() {} }); };
  const settle = () => new Promise(r => setTimeout(r, 0));
  return { root, document, requests, sources, timers, click, settle };
}

/** 模拟服务端 /content：脱敏正文的虚拟 UTF-8 区间，切片保留完整字符（与 sessions/content.ts 的 utf8Slice 同语义）。 */
function contentServer(text: string, base: number) {
  const buf = Buffer.from(text);
  return (url: string): Reply => {
    const u = new URL(url, 'http://x'); const offset = Number(u.searchParams.get('offset')), length = Number(u.searchParams.get('length'));
    if (length > 256 * 1024) return { status: 400, body: { error: 'too big for client' } };
    let start = offset - base, end = Math.min(start + length, buf.length);
    while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
    while (end < buf.length && (buf[end]! & 0xc0) === 0x80) end++;
    return { status: 200, body: { text: buf.subarray(start, end).toString('utf8'), truncated: false } };
  };
}
function loadable(root: El, o: { offset: number; length: number; json?: boolean }) {
  const blk = mk('div', 'blk assistant'), bt = mk(o.json ? 'pre' : 'div', 'bt partial', '预览'), row = mk('div', 'load-row'), btn = mk('button', 'quiet load-full', '加载全文'), note = mk('span', 'load-note');
  if (o.json) bt.dataset.json = '1';
  Object.assign(btn.dataset, { session: 's1', offset: String(o.offset), length: String(o.length) });
  row.append(btn, note); blk.append(bt, row); root.append(blk);
  return { bt, btn, note, row };
}

describe('agents.js 加载全文', () => {
  it('按 ≤256 KiB 分段读取，按收到的字节推进偏移，跨段边界的汉字不丢失', async () => {
    const text = 'a' + '汉字测试'.repeat(60_000); // ~720 KB，3 字节字符必然跨段
    const bytes = Buffer.byteLength(text);
    let el!: ReturnType<typeof loadable>;
    const b = boot({ data: { backend: 'codex', session: 's1' }, build: root => { el = loadable(root, { offset: 1000, length: bytes }); }, fetch: contentServer(text, 1000) });
    b.click(el.btn); await b.settle(); for (let i = 0; i < 10; i++) await b.settle();
    expect(el.bt.textContent).toBe(text);
    expect(el.bt.classList.contains('partial')).toBe(false);
    expect(el.btn.parentNode).toBeNull();
    expect(el.note.textContent).toContain('全文');
    expect(b.requests.length).toBeGreaterThanOrEqual(3);
    const urls = b.requests.map(u => new URL(u, 'http://x'));
    expect(urls[0]!.pathname).toBe('/api/agents/codex/sessions/s1/content');
    for (const u of urls) expect(Number(u.searchParams.get('length'))).toBeLessThanOrEqual(256 * 1024);
    const buf = Buffer.from(text); let cut = 256 * 1024; while ((buf[cut]! & 0xc0) === 0x80) cut--;
    expect(Number(urls[1]!.searchParams.get('offset')) - 1000).toBe(cut); // 第二段从第一段实际收到的字符边界继续
  });

  it('参数 JSON 读完后美化；409 / 400 提示索引已刷新并允许重试', async () => {
    const json = JSON.stringify({ cmd: 'ls', list: [1, 2] });
    let el!: ReturnType<typeof loadable>;
    const b = boot({ data: { backend: 'pi', session: 's1' }, build: root => { el = loadable(root, { offset: 0, length: Buffer.byteLength(json), json: true }); }, fetch: contentServer(json, 0) });
    b.click(el.btn); for (let i = 0; i < 5; i++) await b.settle();
    expect(el.bt.textContent).toBe(JSON.stringify(JSON.parse(json), null, 2));
    expect(b.requests[0]).toContain('/api/agents/pi/sessions/s1/content?offset=0&length=');

    let stale!: ReturnType<typeof loadable>;
    const s = boot({ data: { backend: 'codex', session: 's1' }, build: root => { stale = loadable(root, { offset: 0, length: 10 }); }, fetch: () => ({ status: 409, body: { error: 'dirty' } }) });
    s.click(stale.btn); for (let i = 0; i < 5; i++) await s.settle();
    expect(stale.note.textContent).toContain('索引已刷新'); expect(stale.note.className).toContain('err');
    expect(stale.btn.disabled).toBe(false); expect(stale.bt.textContent).toBe('预览');
  });
});

describe('agents.js 实时追加', () => {
  function sessionDom(root: El) {
    const conn = mk('span', 'conn'); conn.id = 'conn';
    const dir = mk('ol'); dir.id = 'tdir';
    const stream = mk('div', 'tstream'); stream.id = 'tstream';
    // 服务端渲染的已加载回合 t1
    const d = mk('details', 'turn sheet'); d.id = 't-1'; d.dataset.turn = 't1'; d.open = true;
    const sum = mk('summary', 'turn-head'), st = mk('span', 'th-status'), tm = mk('span', 'tm');
    st.append(mk('span', 'stamp s-run', '进行中')); tm.append(mk('span', 'tm-model'), mk('span', 'tm-ctx'));
    sum.append(st, mk('span', 'th-preview', '旧问题'), tm);
    const body = mk('div', 'turn-body'); body.append(mk('p', 'faint placeholder', '这个回合还没有正文块。'));
    d.append(sum, body); stream.append(d);
    // 折叠未加载的回合 t0
    const lazy = mk('details', 'turn sheet'); lazy.id = 't-0'; lazy.dataset.turn = 't0';
    const lb = mk('div', 'turn-body'); lb.dataset.lazy = '1'; lazy.append(mk('summary', 'turn-head'), lb); stream.append(lazy);
    root.append(conn, dir, stream);
  }
  const data = { backend: 'codex', session: 's1', active: true, window: 10_000, base: 1 };

  it('订阅 /agents/stream，块追加到对应回合：工具结果挂到调用卡片，model_usage 补到请求行与回合头，终态更新印章', async () => {
    const b = boot({ data, build: sessionDom, fetch: () => ({ status: 404, body: {} }) });
    expect(b.sources).toHaveLength(1);
    expect(b.sources[0]!.url).toBe('/agents/stream?backend=codex&session=s1');
    const es = b.sources[0]!; es.onopen!();
    expect(b.document.getElementById('conn')!.textContent).toBe('实时更新中');
    const send = (block: unknown, turn = 't1') => es.emit({ session: 's1', turn, block });
    send({ kind: 'event', ts: 1, text: '模型请求', meta: { type: 'model_request', model: 'gpt-x', effort: 'low', request: 1 } });
    send({ kind: 'tool_call', ts: 2, callId: 'c1', text: '{"cmd":"<b>x</b>"}', meta: { name: 'exec', status: 'running' } });
    send({ kind: 'tool_result', ts: 3, callId: 'c1', text: 'done', meta: { status: 'failed', duration_ms: 2500 } });
    send({ kind: 'event', ts: 4, text: '模型用量', meta: { type: 'model_usage', usage: { input: 1234, output: 5 } } });
    send({ kind: 'assistant', ts: 5, text: '好的' });
    send({ kind: 'assistant', ts: 5, text: '好的' }); // 重复帧去重
    send({ kind: 'event', ts: 6, text: '回合完成', meta: { type: 'turn_complete' } });
    const d = b.document.getElementById('t-1')!, body = d.querySelector('.turn-body')!;
    expect(body.querySelector('.placeholder')).toBeNull();
    const cards = body.querySelectorAll('.tc');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelector('.tc-slot')!.textContent).toContain('结果 失败done');
    expect(cards[0]!.querySelector('.tc-status')!.textContent).toBe('失败');
    expect(cards[0]!.querySelector('.tc-dur')!.textContent).toBe('2.5 秒');
    expect(cards[0]!.querySelector('pre')!.textContent).toBe('{\n  "cmd": "<b>x</b>"\n}'); // textContent，不解析 HTML
    expect(body.querySelector('.req')!.textContent).toBe('模型请求 #1 · gpt-x · low · 输入 1,234 · 输出 5');
    expect(d.querySelector('.tm-ctx')!.textContent).toBe('上下文 1,234 / 10,000（12%） tokens');
    expect(d.querySelector('.tm-model')!.textContent).toBe('gpt-x · low');
    expect(body.querySelectorAll('.assistant')).toHaveLength(1);
    expect(d.querySelector('.th-status')!.textContent).toBe('完成');
    expect(body.querySelector('.end')!.textContent).toBe('回合完成');
    // 未加载的折叠回合不追加
    send({ kind: 'assistant', ts: 7, text: '旧' }, 't0');
    expect(b.document.getElementById('t-0')!.querySelector('.turn-body')!.children).toHaveLength(0);
  });

  it('未知回合的帧新建回合（流与目录各插在最前，展开），用户输入成为预览', async () => {
    const b = boot({ data, build: sessionDom, fetch: () => ({ status: 404, body: {} }) });
    b.sources[0]!.emit({ session: 's1', turn: 't9', block: { kind: 'user', ts: 10, text: '新问题' } });
    const stream = b.document.getElementById('tstream')!, dir = b.document.getElementById('tdir')!;
    const d = stream.children[0]!;
    expect(d.dataset.turn).toBe('t9'); expect(d.id).toBe('t-2'); expect(d.open).toBe(true);
    expect(d.querySelector('.th-preview')!.textContent).toBe('新问题');
    expect(d.querySelector('.user')!.textContent).toBe('用户新问题');
    expect(d.querySelector('.th-status')!.textContent).toBe('进行中');
    expect(dir.children[0]!.dataset.turn).toBe('t9');
    const links = d.querySelectorAll('A').map(a => a.href);
    expect(links).toContain('/agents/codex/sessions/s1/turns/t9');
    expect(links).toContain('/memory/recalls?backend=codex&session=s1&turn=t9');
    expect(links).toContain('/agents/codex/sessions/s1/context?at=t9&phase=before');
  });

  it('断线后重取会话快照与最新回合，再重新订阅；期间的帧排队并去重', async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>(r => { releaseTurn = r; });
    const b = boot({ data, build: sessionDom, fetch: async url => {
      if (url === '/api/agents/codex/sessions/s1') return { status: 200, body: { session: { status: 'active' }, turns: [{ turn: 't1', started: 1, status: 'ok' }, { turn: 't2', started: 2, status: 'running', preview: '第二问' }] } };
      if (url === '/api/agents/codex/sessions/s1/turns/t2') { await turnGate; return { status: 200, body: { turn: { turn: 't2', status: 'running' }, blocks: [
        { kind: 'user', ts: 20, text: '第二问' }, { kind: 'event', ts: 21, text: '模型请求', meta: { type: 'model_request', model: 'm', usage: { input: 3000, output: 1 } } }] } }; }
      return { status: 404, body: {} };
    } });
    const es = b.sources[0]!; es.onerror!();
    expect(es.closed).toBe(true);
    expect(b.document.getElementById('conn')!.textContent).toContain('秒后重取快照并重连');
    expect(b.timers).toHaveLength(1);
    const done = b.timers[0]!() as Promise<void>;
    for (let i = 0; i < 5; i++) await b.settle();
    // 快照进行中到达的帧（一条重复、一条新）排队
    es.emit({ session: 's1', turn: 't2', block: { kind: 'user', ts: 20, text: '第二问' } });
    es.emit({ session: 's1', turn: 't2', block: { kind: 'assistant', ts: 22, text: '答' } });
    releaseTurn(); await done;
    expect(b.requests).toEqual(['/api/agents/codex/sessions/s1', '/api/agents/codex/sessions/s1/turns/t2']);
    const t2 = b.document.getElementById('tstream')!.children[0]!;
    expect(t2.dataset.turn).toBe('t2'); expect(t2.open).toBe(true);
    const body = t2.querySelector('.turn-body')!;
    expect(body.querySelectorAll('.user')).toHaveLength(1);
    expect(body.querySelectorAll('.assistant')).toHaveLength(1);
    expect(t2.querySelector('.tm-ctx')!.textContent).toBe('上下文 3,000 / 10,000（30%） tokens');
    expect(b.document.getElementById('t-1')!.querySelector('.th-status')!.textContent).toBe('完成');
    expect(b.sources).toHaveLength(2); expect(b.sources[1]!.url).toBe('/agents/stream?backend=codex&session=s1');
  });

  it('展开折叠回合时懒加载正文；归档会话不订阅', async () => {
    const b = boot({ data: { ...data, active: false }, build: sessionDom, fetch: url => url.endsWith('/turns/t0')
      ? { status: 200, body: { turn: { turn: 't0', status: 'ok' }, blocks: [{ kind: 'thinking', meta: { unavailable: true } }, { kind: 'tool_call', callId: 'c', text: 'x', meta: { name: 'n' } }, { kind: 'tool_result', callId: 'c', text: 'y' }] } }
      : { status: 404, body: {} } });
    expect(b.sources).toHaveLength(0);
    const lazy = b.document.getElementById('t-0')!; lazy.open = true;
    for (let i = 0; i < 5; i++) await b.settle();
    const body = lazy.querySelector('.turn-body')!;
    expect(body.dataset.lazy).toBeUndefined();
    expect(body.querySelector('.thinking')!.textContent).toContain('不可用');
    expect(body.querySelectorAll('.tc')).toHaveLength(1);
    expect(body.querySelector('.tc-slot')!.textContent).toContain('y');
  });
});
