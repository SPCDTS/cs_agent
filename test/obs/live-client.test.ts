import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../../src/obs/ui/client.js';
import { THEME_CSS } from '../../src/obs/ui/theme.js';

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

function boot(stop = true) {
  const root = new El('BODY');
  const ids: Record<string, El> = {};
  for (const id of ['convs', 'conn', 'live-count', 'convs-empty']) { ids[id] = new El('DIV'); root.append(ids[id]!); }
  ids.convs!.dataset.csrf = 'csrf-token'; if (stop) ids.convs!.dataset.stop = '1';
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
  const row = (thread = 'group:7') => ids.convs!.querySelector(`[data-thread="${thread}"]`);
  return { ids, emit, row };
}

const turn = (over: Record<string, unknown> = {}) => ({ id: 'pi:7:1', kind: 'user', sender: '小明', started: 0, updated: 0, finished: null, outcome: '',
  inputs: [{ key: 'k1', kind: 'user', sender: '小明', text: '帮我查天气' }], sends: [], tools: 0, subagent_events: 0, phase: '', phase_since: 0, seq: 0, dropped: 0, ...over });
const conv = (over: Record<string, unknown> = {}) => ({ thread: 'group:7', scope: 'group:7', label: '', backend: 'pi', state: 'working', turn: turn(),
  queued: [], subagents: null, recent: [], updated: 0, ...over });
const item = (seq: number, summary = `事件 ${seq}`) => ({ seq, ts: seq, stage: 'tool:shell', status: 'ok', duration_ms: null, summary });

describe('live.js 客户端渲染（每会话一行）', () => {
  it('事件流超过 80 条后继续渲染新事件（按 seq 增量），只保留最近 80 行；已在快照里的事件不重复', () => {
    const { emit, row } = boot();
    emit('snapshot', { now: Date.now(), count: 0 }); emit('snapshot_end', { count: 0 });
    for (let seq = 1; seq <= 100; seq++) emit('conversation', { conversation: conv({ turn: turn({ seq, updated: seq }) }), item: item(seq) });
    const feed = row()!.querySelector('.feed')!;
    expect(feed.children).toHaveLength(80);
    expect(feed.lastElementChild!.textContent).toContain('事件 100');
    expect(feed.firstChild!.textContent).toContain('事件 21');
    emit('conversation', { conversation: conv({ turn: turn({ seq: 100 }) }), item: item(100, '重复') });
    expect(feed.textContent).not.toContain('重复');
  });

  it('快照逐会话到达后，增量从已有 seq 之后续接；换了回合清空事件流', () => {
    const { ids, emit, row } = boot();
    const items = Array.from({ length: 80 }, (_, i) => item(i + 21));
    emit('snapshot', { now: Date.now(), count: 2 });
    emit('snapconversation', { conversation: conv({ turn: { ...turn({ seq: 100 }), items } }) });
    emit('snapconversation', { conversation: conv({ thread: 'private:5', scope: 'private:5', state: 'idle', turn: null, updated: 5 }) });
    emit('snapshot_end', { count: 2 });
    expect(ids.convs!.children).toHaveLength(2);
    expect(ids.conn!.textContent).toBe('实时连接中');
    expect(ids['live-count']!.textContent).toBe('1 个会话工作中');
    emit('conversation', { conversation: conv({ turn: turn({ seq: 101 }) }), item: item(101) });
    const feed = row()!.querySelector('.feed')!;
    expect(feed.children).toHaveLength(80);
    expect(feed.lastElementChild!.textContent).toContain('事件 101');
    emit('conversation', { conversation: conv({ turn: turn({ id: 'pi:7:2', seq: 1 }) }), item: item(1, '新回合') });
    expect(feed.children).toHaveLength(1);
    expect(feed.textContent).toContain('新回合');
    expect(row()!.querySelector('.conv-foot')!.querySelector('A')!.href).toBe('/turns/pi%3A7%3A2');
  });

  it('快照替换服务端渲染的会话行，不留下重复行', () => {
    const { ids, emit } = boot();
    const ssr = new El('ARTICLE'); ssr.className = 'slip conv'; ssr.dataset.thread = 'group:7'; ids.convs!.append(ssr);
    emit('snapshot', { now: Date.now(), count: 1 });
    expect(ids.convs!.children).toHaveLength(0);
    emit('snapconversation', { conversation: { ...conv(), turn: { ...turn(), items: [] } } });
    emit('snapshot_end', { count: 1 });
    expect(ids.convs!.querySelectorAll('[data-thread="group:7"]')).toHaveLength(1);
    expect(ids.convs!.children[0]).not.toBe(ssr);
  });

  it('空闲行用 hidden 收起的元素（.pill、.conv-foot）自带 display，主题需让 [hidden] 优先', () => {
    expect(THEME_CSS).toContain('[hidden]{display:none!important}');
  });

  it('页头与数字随更新刷新：会话名（群名）、后端、回合种类与发送者、本轮输入、已发消息、子 agent、排队；空闲时收起回合部分', () => {
    const { ids, emit, row } = boot();
    emit('snapshot', { now: Date.now(), count: 0 }); emit('snapshot_end', { count: 0 });
    emit('conversation', { conversation: conv({ label: '家庭群', backend: '' }), item: item(1) });
    const top = row()!.querySelector('.slip-top')!;
    expect(top.querySelector('.who')!.textContent).toBe('群 家庭群(7)');
    expect(top.querySelector('.who')!.href).toBe('/conversations/group%3A7');
    const pills = () => top.querySelectorAll('.pill').filter(p => !p.hidden).map(p => p.textContent);
    expect(pills()).toEqual(['用户消息 · 小明']);
    emit('conversation', { conversation: conv({ subagents: 2, queued: ['k2'], turn: turn({ seq: 2, kind: 'scheduled', sender: '9', tools: 3,
      inputs: [{ key: 'run_1', kind: 'scheduled', sender: '', text: '[定时任务] 早报' }], sends: [{ ts: 2, target: 'qq:group:7', text: '早报来了', status: 'sent', system: false }] }) }), item: item(2) });
    expect(pills()).toEqual(['Pi', '定时任务 · 9']);
    const facts = row()!.querySelector('.conv-facts')!.children.map(c => c.textContent);
    expect(facts).toEqual(['本轮输入 1', '已发消息 1', '工具调用 3', '子 agent 2', '排队 1']);
    expect(row()!.querySelector('.conv-inputs')!.textContent).toBe('[定时任务] 早报');
    expect(row()!.querySelector('.conv-sends')!.textContent).toContain('早报来了');
    expect(ids.convs!.querySelectorAll('.slip-top')).toHaveLength(1);
    // 回合结束：空闲、没有回合部分，最近完成里出现这个回合
    emit('conversation', { conversation: conv({ state: 'idle', turn: null, subagents: null, updated: 10,
      recent: [{ ...turn({ kind: 'scheduled', sender: '9', finished: 9, outcome: 'completed', started: 1 }) }] }) });
    const r = row()!;
    expect(r.className).toContain('idle');
    expect(r.querySelector('.conv-facts')!.children.map(c => c.textContent)).toEqual(['排队 0']);
    expect(r.querySelector('.feed')!.hidden).toBe(true);
    expect(r.querySelector('.conv-foot')!.hidden).toBe(true);
    expect(r.querySelector('.conv-recent')!.hidden).toBe(false);
    expect(r.querySelector('SUMMARY')!.textContent).toBe('最近完成 1 个回合');
    expect(r.querySelector('.conv-recent')!.querySelector('A')!.href).toBe('/turns/pi%3A7%3A1');
    expect(r.querySelector('.conv-recent')!.textContent).toContain('已完成');
    expect(ids['live-count']!.textContent).toBe('所有会话空闲');
  });

  it('停止按钮只在工作中出现，带 CSRF、会话键与返回实时页；未启用停止时没有表单', () => {
    const { emit, row } = boot();
    emit('snapshot', { now: Date.now(), count: 0 }); emit('snapshot_end', { count: 0 });
    emit('conversation', { conversation: conv(), item: item(1) });
    const form = row()!.querySelector('FORM')!;
    expect(form.attrs.action).toBe('/thread/stop'); expect(form.attrs.method).toBe('post');
    expect(form.dataset.confirm).toContain('群 7');
    expect(form.querySelectorAll('INPUT').map(i => [i.attrs.name, i.attrs.value])).toEqual([['_csrf', 'csrf-token'], ['key', 'group:7'], ['return', '/live']]);
    expect(form.hidden).toBe(false);
    emit('conversation', { conversation: conv({ state: 'idle', turn: null }) });
    expect(form.hidden).toBe(true);
    const plain = boot(false);
    plain.emit('snapshot', { now: Date.now(), count: 0 }); plain.emit('snapshot_end', { count: 0 });
    plain.emit('conversation', { conversation: conv(), item: item(1) });
    expect(plain.row()!.querySelector('FORM')).toBeNull();
  });

  it('remove 删除会话行；工作中的会话排在空闲会话前面', () => {
    const { ids, emit, row } = boot();
    emit('snapshot', { now: Date.now(), count: 0 }); emit('snapshot_end', { count: 0 });
    emit('conversation', { conversation: conv({ thread: 'private:5', scope: 'private:5', state: 'idle', turn: null, updated: 5 }) });
    emit('conversation', { conversation: conv(), item: item(1) });
    expect(ids.convs!.children.map(c => c.dataset.thread)).toEqual(['group:7', 'private:5']);
    emit('remove', { thread: 'private:5' });
    expect(row('private:5')).toBeNull();
    expect(ids.convs!.children).toHaveLength(1);
    expect(ids['convs-empty']!.hidden).toBe(true);
    emit('remove', { thread: 'group:7' });
    expect(ids['convs-empty']!.hidden).toBe(false);
    expect(ids['live-count']!.textContent).toBe('没有活动的会话');
  });

  it('会话行头部的小型占用条：首帧 context 快照填充，context 增量原地更新（档位、宽度、阈值、估算）', () => {
    const { ids, emit, row } = boot();
    const u = (over: Record<string, unknown> = {}) => ({ backend: 'pi', key: 'group:7', usedTokens: 64_000, windowTokens: 128_000, turns: 3, updatedAt: Date.now(), source: 'turn', ...over });
    emit('snapshot', { now: Date.now(), count: 1 });
    emit('context', { usage: u() });
    emit('snapconversation', { conversation: { ...conv(), turn: { ...turn(), items: [] } } });
    emit('snapshot_end', { count: 1 });
    const bar = () => ids.convs!.querySelector('[data-ctx="pi|group:7"]')!;
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
    expect(first.querySelector('.ctx-bg')!.dataset.at).toBe('70');
    expect(first.querySelector('.ctx-rs')!.attrs.title).toContain('阻塞压缩阈值：112,000 tokens');
    emit('context', { usage: u({ usedTokens: 1_000, source: 'estimate', updatedAt: Date.now() - 48 * 3600_000 }) });
    expect(first.className).toBe('ctx ctx-t-ok ctx-est ctx-stale ctx-mini');
    expect(first.querySelector('.ctx-bg')).toBeNull();
    // 别的线程的增量不影响本行；后端改变时换一条
    emit('context', { usage: u({ key: 'owner', usedTokens: 127_000 }) });
    expect(first.querySelector('.ctx-pct')!.textContent).toBe('<1%');
    emit('conversation', { conversation: conv({ backend: 'codex' }), item: item(1) });
    expect(row()!.querySelector('[data-ctx="pi|group:7"]')).toBeNull();
    expect(row()!.querySelector('[data-ctx="codex|group:7"]')!.className).toContain('ctx-none');
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

