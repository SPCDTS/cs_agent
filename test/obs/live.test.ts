import { describe, expect, it } from 'vitest';
import { LiveBus, summarize } from '../../src/obs/live.js';
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
});
