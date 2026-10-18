import { describe, expect, it, vi } from 'vitest';
import { LiveBus, summarize, type LiveMessage } from '../../src/obs/live.js';
import { Trace, type LiveEvent } from '../../src/obs/trace.js';
import { registerSecrets } from '../../src/obs/redact.js';

describe('实时总线', () => {
  it('卡片状态机：排队 → 运行 → 阶段栈 → 终态；系统票据与无主终态不建卡；完成卡片有上限', () => {
    let now = 1000;
    const listeners: ((e: LiveEvent) => void)[] = [];
    const bus = new LiveBus({ tap: fn => { listeners.push(fn); return () => {}; } }, { maxFinished: 2, now: () => now });
    const ev = (ticket: string, stage: string, status = 'ok', detail: Record<string, unknown> = {}) => listeners.forEach(fn => fn({ ticket, stage, status, scope: 'private:1', ts: now++, duration_ms: null, detail }));
    ev('a', 'received', 'ok', { text: '你好' });
    expect(bus.snapshot()[0]).toMatchObject({ state: 'queued', phase: '' });
    ev('a', 'dispatched'); ev('a', 'phase:handle', 'started'); ev('a', 'backend:pi', 'started'); ev('a', 'tool:web_search', 'started', { input: { query: 'CS2' } });
    expect(bus.snapshot()[0]).toMatchObject({ state: 'running', phase: 'tool:web_search', backend: 'pi' });
    ev('a', 'backend:pi', 'failed'); // 父阶段结束 → 子阶段一并出栈
    expect(bus.snapshot()[0]!.phase).toBe('phase:handle');
    ev('a', 'failed', 'failed', { terminal: true });
    expect(bus.snapshot()[0]).toMatchObject({ state: 'failed', outcome: 'failed' });
    ev('@settings', 'settings_changed'); ev('old', 'reply_sent', 'ok', { terminal: true });
    expect(bus.snapshot().map(c => c.ticket)).toEqual(['a']);
    for (const t of ['b', 'c', 'd']) { ev(t, 'received'); ev(t, 'reply_sent', 'ok', { terminal: true }); }
    expect(bus.snapshot().map(c => c.ticket)).toEqual(['d', 'c']);
    ev('e', 'received');
    now += 31 * 60_000;
    expect(bus.snapshot().map(c => c.ticket)).toEqual(['e']);
  });

  it('trace.tap 在无存储时也推送，并先脱敏；摘要把工具参数展开为键值', () => {
    const secret = 'tap-secret-445566'; registerSecrets([secret]);
    const t = new Trace(); const got: LiveEvent[] = [];
    const off = t.tap(e => got.push(e));
    t.event('x', 'tool:web_search', { status: 'started', detail: { input: { query: '查 ' + secret }, api_key: 'k' } });
    off(); t.event('x', 'after');
    expect(got).toHaveLength(1);
    expect(JSON.stringify(got[0])).not.toContain(secret);
    expect(got[0]!.detail.api_key).toBe('[已隐藏]');
    expect(summarize(got[0]!)).toBe('query 查 [已隐藏]');
  });

  it('事件 seq 每张卡片单调递增，环形截断后继续增长', () => {
    const listeners: ((e: LiveEvent) => void)[] = [];
    const bus = new LiveBus({ tap: fn => { listeners.push(fn); return () => {}; } });
    const got: LiveMessage[] = []; bus.subscribe(m => got.push(m));
    let ts = 0;
    for (let i = 0; i < 100; i++) listeners.forEach(fn => fn({ ticket: 'a', stage: 'tool:x', status: 'ok', scope: 'private:1', ts: ts++, duration_ms: null, detail: {} }));
    const card = bus.snapshot()[0]!;
    expect(card.items).toHaveLength(80);
    expect(card.items.map(i => i.seq)).toEqual(Array.from({ length: 80 }, (_, i) => i + 21));
    expect(card.seq).toBe(100);
    const last = got.at(-1)!; expect(last.type === 'event' && last.item.seq).toBe(100);
    bus.close();
  });

  it('完成卡片超过 30 张时在终态事件后立即推送 remove，无需快照请求；过期由定时器淘汰，close 清除定时器', () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const listeners: ((e: LiveEvent) => void)[] = [];
      const timersBefore = vi.getTimerCount();
      const bus = new LiveBus({ tap: fn => { listeners.push(fn); return () => {}; } }, { now: () => now, finishedTtlMs: 5_000, pruneIntervalMs: 1_000 });
      expect(vi.getTimerCount()).toBe(timersBefore + 1);
      const removed: string[] = []; bus.subscribe(m => { if (m.type === 'remove') removed.push(m.ticket); });
      const ev = (ticket: string, stage: string, detail: Record<string, unknown> = {}) => listeners.forEach(fn => fn({ ticket, stage, status: 'ok', scope: 'private:1', ts: now++, duration_ms: null, detail }));
      for (let i = 0; i < 31; i++) { ev(`t${i}`, 'received'); ev(`t${i}`, 'reply_sent', { terminal: true }); }
      expect(removed).toEqual(['t0']);
      ev('live', 'received');
      now += 6_000; vi.advanceTimersByTime(1_000);
      expect(removed).toHaveLength(31);
      expect(removed).not.toContain('live');
      bus.close();
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally { vi.useRealTimers(); }
  });
});

describe('LiveBus 的 context 增量', () => {
  it('context_usage 事件推送脱敏后的白名单记录（线程键不被当作密钥隐藏），卡片记下线程键', () => {
    const trace = new Trace();
    const bus = new LiveBus(trace);
    const got: LiveMessage[] = [];
    bus.subscribe(m => got.push(m));
    trace.event('t1', 'received', { scope: 'group:7', detail: { text: '你好' } });
    trace.event('t1', 'dispatched', { detail: { backend: 'pi', conversation_key: 'group:7' } });
    trace.event('@pi', 'context_usage', { detail: { backend: 'pi', key: 'group:7', usedTokens: 64_000, windowTokens: 128_000, compaction: { background: 89_600, reserve: 112_000 }, turns: 3, updatedAt: 9, source: 'turn', secret: 'x' } });
    const ctx = got.filter(m => m.type === 'context');
    expect(ctx).toEqual([{ type: 'context', usage: { backend: 'pi', key: 'group:7', usedTokens: 64_000, windowTokens: 128_000, compaction: { background: 89_600, reserve: 112_000 }, turns: 3, updatedAt: 9, source: 'turn' } }]);
    expect(bus.snapshot()[0]).toMatchObject({ ticket: 't1', backend: 'pi', thread: 'group:7' });
    expect(bus.snapshot()).toHaveLength(1); // @ 系统票据不建卡
    // 同票据内的 context_usage 也进事件流，摘要可读
    trace.event('t1', 'context_usage', { detail: { backend: 'pi', key: 'group:7', usedTokens: 70_000, windowTokens: 128_000, turns: 4, updatedAt: 10, source: 'turn' } });
    const last = got.filter(m => m.type === 'event').at(-1)!;
    expect(last.type === 'event' && last.item.summary).toBe('上下文 70k / 128k（55%）');
    bus.close();
  });
});
