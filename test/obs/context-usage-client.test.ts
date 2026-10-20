import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../../src/obs/ui/client.js';

type Listener = (e: unknown) => void;
/** context-usage.js 所需的最小 DOM：元素树、className / classList、hidden、aria 属性、类名选择器与 focus。 */
class El {
  children: El[] = [];
  parentNode: El | null = null;
  className = ''; id = ''; hidden = false; focused = 0;
  attrs: Record<string, string> = {};
  constructor(readonly tagName: string) {}
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => { if (!list().includes(c)) this.className = [...list(), c].join(' '); },
      remove: (c: string) => { this.className = list().filter(x => x !== c).join(' '); },
      contains: (c: string) => list().includes(c),
    };
  }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  focus() { this.focused++; }
  append(...ns: El[]) { for (const n of ns) { n.parentNode = this; this.children.push(n); } return this; }
  all(): El[] { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelectorAll(sel: string): El[] { return this.all().filter(e => sel.startsWith('.') && e.className.split(/\s+/).includes(sel.slice(1))); }
}
const mk = (tag: string, cls: string, attrs: Record<string, string> = {}) => {
  const e = new El(tag.toUpperCase()); e.className = cls; Object.assign(e.attrs, attrs); return e;
};

/** 两条线程：线程 0 两个票据组，线程 1 一个；结构与服务端渲染一致（组在图里，pop 在 .cu-pane 里，默认 hidden）。 */
function boot() {
  const root = new El('BODY');
  const thread = (i: number, n: number) => {
    const chart = mk('div', 'cu-chart'), pane = mk('div', 'cu-pane'); pane.id = `cu-pane-${i}`;
    const groups: El[] = [], pops: El[] = [], closes: El[] = [], bars: El[] = [];
    for (let k = 0; k < n; k++) {
      const id = `cu-pop-${i}-${k}`;
      const bar = mk('span', 'cu-bar'), hit = mk('i', 'cu-c');
      const group = mk('button', 'cu-group', { 'aria-controls': id, 'aria-expanded': 'false' }).append(bar.append(hit));
      const close = mk('button', 'btn quiet cu-close');
      const pop = mk('div', 'cu-pop').append(mk('div', 'cu-pop-head').append(close)); pop.id = id; pop.hidden = true;
      chart.append(group); pane.append(pop);
      groups.push(group); pops.push(pop); closes.push(close); bars.push(hit);
    }
    root.append(mk('section', '').append(chart, pane));
    return { groups, pops, closes, bars };
  };
  const t0 = thread(0, 2), t1 = thread(1, 1);
  const listeners: Record<string, Listener[]> = {};
  const document = {
    getElementById: (id: string) => root.all().find(e => e.id === id) ?? null,
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    addEventListener: (t: string, fn: Listener) => { (listeners[t] ??= []).push(fn); },
  };
  vm.runInNewContext(ASSETS['context-usage.js']!, { document });
  const fire = (type: string, e: Record<string, unknown>) => { for (const fn of listeners[type] ?? []) fn(e); };
  const click = (target: El) => fire('click', { target, preventDefault() {} });
  const key = (k: string) => fire('keydown', { key: k });
  const state = (t: typeof t0) => t.groups.map((g, k) => [t.pops[k]!.hidden, g.classList.contains('is-active'), g.getAttribute('aria-expanded')]);
  return { t0, t1, click, key, state };
}

describe('上下文监控预览面板脚本 /assets/context-usage.js', () => {
  it('资源已注册，只切换 hidden / className / aria-*，不拼 HTML、不设 style', () => {
    const js = ASSETS['context-usage.js']!;
    expect(js).toBeTruthy();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\.style\b|createElement/);
  });

  it('点击组显示对应 pop 并收起同面板其他 pop；组 .is-active 与 aria-expanded 随之切换；其他线程不受影响', () => {
    const { t0, t1, click, state } = boot();
    expect(state(t0)).toEqual([[true, false, 'false'], [true, false, 'false']]);
    click(t0.bars[0]!); // 点在组内的条上，冒泡到组按钮
    expect(state(t0)).toEqual([[false, true, 'true'], [true, false, 'false']]);
    click(t1.groups[0]!);
    expect(state(t1)).toEqual([[false, true, 'true']]);
    click(t0.groups[1]!);
    expect(state(t0)).toEqual([[true, false, 'false'], [false, true, 'true']]);
    expect(state(t1)).toEqual([[false, true, 'true']]);
    expect(t0.groups[1]!.className).toBe('cu-group is-active');
  });

  it('再点同一组收起；点"关闭"收起并把焦点还给组按钮', () => {
    const { t0, click, state } = boot();
    click(t0.groups[0]!);
    click(t0.groups[0]!);
    expect(state(t0)).toEqual([[true, false, 'false'], [true, false, 'false']]);
    click(t0.groups[1]!);
    click(t0.closes[1]!);
    expect(state(t0)).toEqual([[true, false, 'false'], [true, false, 'false']]);
    expect(t0.groups[1]!.focused).toBe(1);
    // 收起后再点同一组重新展开。
    click(t0.groups[1]!);
    expect(state(t0)).toEqual([[true, false, 'false'], [false, true, 'true']]);
  });

  it('Esc 收起所有面板，其他按键不处理', () => {
    const { t0, t1, click, key, state } = boot();
    click(t0.groups[0]!); click(t1.groups[0]!);
    key('Enter');
    expect(state(t0)[0]).toEqual([false, true, 'true']);
    key('Escape');
    expect(state(t0)).toEqual([[true, false, 'false'], [true, false, 'false']]);
    expect(state(t1)).toEqual([[true, false, 'false']]);
    expect(t0.groups[0]!.focused + t1.groups[0]!.focused).toBe(1);
  });

  it('点击组外或 aria-controls 指向不存在的 pop 时不改动', () => {
    const { t0, click, state } = boot();
    click(t0.pops[0]!);
    t0.groups[1]!.setAttribute('aria-controls', 'cu-pop-9-9');
    click(t0.groups[1]!);
    expect(state(t0)).toEqual([[true, false, 'false'], [true, false, 'false']]);
  });
});
