import { describe, expect, it, vi } from 'vitest';
import { LiveBus, summarize, type LiveMessage, type LiveThreadState } from '../../src/obs/live.js';
import { Trace, type LiveEvent } from '../../src/shared/trace.js';
import { registerSecrets } from '../../src/shared/redact.js';

/** 手动驱动的总线：ev(key, stage, status, detail, scope) 直接投递一条 trace 事件。 */
function rig(options: ConstructorParameters<typeof LiveBus>[1] = {}) {
  let now = 1000;
  const listeners: ((e: LiveEvent) => void)[] = [];
  const bus = new LiveBus({ tap: fn => { listeners.push(fn); return () => {}; } }, { now: () => now, ...options });
  const got: LiveMessage[] = []; bus.subscribe(m => got.push(m));
  const ev = (key: string, stage: string, status = 'ok', detail: Record<string, unknown> = {}, scope = 'group:7') =>
    listeners.forEach(fn => fn({ key, stage, status, scope, ts: now++, duration_ms: null, detail }));
  return { bus, ev, got, tick: (ms: number) => { now += ms; }, conv: (thread = 'group:7') => bus.snapshot().find(c => c.thread === thread) };
}

describe('实时总线：每会话一行', () => {
  it('输入入队 → 开轮 → 插话 → 发送 → 结束：空闲/工作中、回合种类与发送者、本轮输入、已发消息、排队数', () => {
    const { bus, ev, conv } = rig();
    ev('in:k1', 'received', 'ok', { text: '帮我查天气', sender: '小明' });
    ev('in:k1', 'queued', 'ok', { thread_key: 'group:7', kind: 'user', result: 'queued' });
    expect(conv()).toMatchObject({ thread: 'group:7', state: 'idle', turn: null, queued: ['k1'] });
    ev('turn:pi:7:1', 'dispatched', 'ok', { backend: 'pi', conversation_key: 'group:7', kind: 'user', inputs: ['k1'] });
    ev('in:k1', 'delivered', 'ok', { turn: 'pi:7:1' });
    ev('turn:pi:7:1', 'received', 'ok', { text: '帮我查天气', sender: '小明', thread_key: 'group:7', kind: 'user', inputs: ['k1'] });
    expect(conv()).toMatchObject({ state: 'working', backend: 'pi', queued: [], turn: { id: 'pi:7:1', kind: 'user', sender: '小明' } });
    expect(conv()!.turn!.inputs).toEqual([{ key: 'k1', kind: 'user', sender: '小明', text: '帮我查天气' }]);
    // 他人的消息排队等本轮结束；同一发送者插话进本轮
    ev('in:k2', 'received', 'ok', { text: '我也要', sender: '小红' });
    ev('in:k2', 'queued', 'ok', { thread_key: 'group:7', kind: 'user', result: 'queued' });
    ev('in:k3', 'received', 'ok', { text: '还有明天', sender: '小明' });
    ev('in:k3', 'queued', 'ok', { thread_key: 'group:7', kind: 'user', result: 'steered' });
    ev('in:k3', 'delivered', 'ok', { turn: 'pi:7:1' });
    ev('turn:pi:7:1', 'steered', 'ok', { inputs: ['k3'], text: '还有明天' });
    ev('turn:pi:7:1', 'tool:web_search', 'started', { input: { query: '天气' } });
    expect(conv()!.turn).toMatchObject({ phase: 'tool:web_search', tools: 0 });
    ev('turn:pi:7:1', 'tool:web_search', 'ok');
    ev('turn:pi:7:1', 'send_message', 'ok', { target: 'qq:group:7', text: '晴', status: 'sent', system: false });
    const working = conv()!;
    expect(working.queued).toEqual(['k2']);
    expect(working.turn!.inputs.map(i => i.text)).toEqual(['帮我查天气', '还有明天']);
    expect(working.turn).toMatchObject({ phase: '', tools: 1, sends: [{ target: 'qq:group:7', text: '晴', status: 'sent', system: false }] });
    ev('turn:pi:7:1', 'reply_sent', 'ok', { terminal: true, status: 'completed', kind: 'user', thread_key: 'group:7' });
    const idle = conv()!;
    expect(idle).toMatchObject({ state: 'idle', turn: null, queued: ['k2'] });
    expect(idle.recent).toHaveLength(1);
    expect(idle.recent[0]).toMatchObject({ id: 'pi:7:1', outcome: 'completed', tools: 1 });
    expect(idle.recent[0]).not.toHaveProperty('items');
    // 迟到的事件不重开已结束的回合；排队的输入开下一轮
    ev('turn:pi:7:1', 'context_usage', 'ok', {});
    expect(conv()!.turn).toBeNull();
    ev('turn:pi:7:2', 'received', 'ok', { text: '我也要', sender: '小红', thread_key: 'group:7', kind: 'user', inputs: ['k2'] });
    expect(conv()).toMatchObject({ state: 'working', queued: [], turn: { id: 'pi:7:2', sender: '小红' } });
    bus.close();
  });

  it('空闲会话的输入先送达后入队（delivered 先于 queued）也不计入排队', () => {
    const { bus, ev, conv } = rig();
    ev('turn:pi:7:1', 'dispatched', 'ok', { backend: 'pi', conversation_key: 'group:7', kind: 'user', inputs: ['k1'] });
    ev('in:k1', 'delivered', 'ok', { turn: 'pi:7:1' });
    ev('turn:pi:7:1', 'reply_sent', 'ok', { terminal: true, status: 'completed' });
    ev('in:k1', 'queued', 'ok', { thread_key: 'group:7', kind: 'user', result: 'queued' });
    expect(conv()!.queued).toEqual([]);
    bus.close();
  });

  it('会话键未知的回合事件先暂存，dispatched / received 带出会话键后补入；唤醒回合与定时回合按种类显示', () => {
    const { bus, ev, conv } = rig();
    ev('turn:codex:a', 'model_turn', 'started', { backend: 'codex' });
    expect(bus.snapshot()).toEqual([]);
    ev('turn:codex:a', 'dispatched', 'ok', { backend: 'codex', thread_key: 'owner', kind: 'wake' });
    expect(conv('owner')).toMatchObject({ state: 'working', backend: 'codex', turn: { id: 'codex:a', kind: 'wake', phase: 'model_turn' } });
    expect(conv('owner')!.turn!.items.map(i => i.stage)).toEqual(['model_turn', 'dispatched']);
    ev('turn:pi:1:1', 'received', 'ok', { text: '[定时任务] 早报', sender: '9', thread_key: 'private:9', kind: 'scheduled', inputs: ['run_x'] });
    expect(conv('private:9')!.turn).toMatchObject({ kind: 'scheduled', inputs: [{ key: 'run_x', text: '[定时任务] 早报' }] });
    // 回合失败与丢失记入最近完成
    ev('turn:codex:a', 'failed', 'failed', { terminal: true, status: 'lost', thread_key: 'owner' });
    ev('turn:pi:1:1', 'failed', 'failed', { terminal: true, status: 'failed' });
    expect(conv('owner')!.recent[0]).toMatchObject({ outcome: 'lost' });
    expect(conv('private:9')!.recent[0]).toMatchObject({ outcome: 'failed' });
    // @ 系统事件、旧版键与只剩终态的回合不建行；thr: 事件进当前回合的事件流
    ev('@settings', 'settings_changed'); ev('legacy', 'received', 'ok', { text: '旧' });
    ev('turn:old', 'reply_sent', 'ok', { terminal: true, thread_key: 'group:5' });
    expect(bus.snapshot().map(c => c.thread).sort()).toEqual(['owner', 'private:9']);
    ev('turn:codex:b', 'dispatched', 'ok', { backend: 'codex', thread_key: 'owner', kind: 'user' });
    ev('thr:owner', 'stalled', 'failed', { thread_key: 'owner' });
    expect(conv('owner')!.turn!.items.at(-1)).toMatchObject({ stage: 'stalled', status: 'failed' });
    // 新回合取代未结束的旧回合（后端唤醒取代）
    ev('turn:codex:c', 'dispatched', 'ok', { backend: 'codex', thread_key: 'owner', kind: 'wake' });
    expect(conv('owner')).toMatchObject({ turn: { id: 'codex:c' } });
    expect(conv('owner')!.recent[0]).toMatchObject({ id: 'codex:b', outcome: 'superseded' });
    bus.close();
  });

  it('会话宿主快照补齐排队输入、子 agent 数与重启后仍在进行的回合；只在有变化时推送', async () => {
    let states: LiveThreadState[] = [
      { thread: 'group:7', busy: true, turnId: 'pi:7:5', turnKind: 'user', turnSender: '42', pending: ['k8', 'k9'], backend: 'pi', subagents: 2 },
      { thread: 'private:3', busy: false, pending: [], backend: 'codex', subagents: 0 },
      { thread: 'shared', busy: true, pending: [] },
    ];
    const { bus, ev, got, conv } = rig({ threads: () => states });
    await bus.refresh();
    expect(bus.snapshot().map(c => c.thread)).toEqual(['group:7']); // 空闲且没有排队的会话不凭空建行，非法会话键忽略
    expect(conv()).toMatchObject({ state: 'working', backend: 'pi', subagents: 2, queued: ['k8', 'k9'], turn: { id: 'pi:7:5', kind: 'user', sender: '42' } });
    const pushed = got.filter(m => m.type === 'conversation').length;
    await bus.refresh();
    expect(got.filter(m => m.type === 'conversation').length).toBe(pushed);
    // 后续事件续接这个回合
    ev('turn:pi:7:5', 'tool:read', 'ok');
    expect(conv()!.turn).toMatchObject({ id: 'pi:7:5', tools: 1 });
    states = [{ thread: 'group:7', busy: true, turnId: 'pi:7:5', pending: ['k9'], backend: 'pi', subagents: 1 }];
    await bus.refresh();
    expect(conv()).toMatchObject({ subagents: 1, queued: ['k9'] });
    expect(got.at(-1)).toMatchObject({ type: 'conversation', conversation: { thread: 'group:7', subagents: 1 } });
    // 后端不提供子 agent 数时为 null（界面不显示）
    states = [{ thread: 'private:3', busy: false, pending: ['k1'], backend: 'codex', subagents: null }];
    await bus.refresh();
    expect(conv('private:3')).toMatchObject({ state: 'idle', subagents: null, queued: ['k1'] });
    // 快照读取失败只保留 trace 推出的状态
    const failing = rig({ threads: () => { throw new Error('宿主未就绪'); } });
    await expect(failing.bus.refresh()).resolves.toBeUndefined();
    bus.close(); failing.bus.close();
  });

  it('事件 seq 在每个回合内单调递增，环形截断后继续增长；增量只带新的一条事件', () => {
    const { bus, ev, got, conv } = rig();
    ev('turn:a', 'received', 'ok', { thread_key: 'private:1' });
    for (let i = 0; i < 99; i++) ev('turn:a', 'tool:x', 'ok');
    const turn = conv('private:1')!.turn!;
    expect(turn.items).toHaveLength(80);
    expect(turn.items.map(i => i.seq)).toEqual(Array.from({ length: 80 }, (_, i) => i + 21));
    expect(turn.seq).toBe(100);
    const last = got.at(-1)!;
    expect(last.type === 'conversation' && last.item?.seq).toBe(100);
    expect(last.type === 'conversation' && 'items' in (last.conversation.turn ?? {})).toBe(false);
    bus.close();
  });

  it('空闲会话在最后活动之后超过保留期淘汰并推送 remove；工作中或有排队的会话保留；close 清除定时器', () => {
    vi.useFakeTimers();
    try {
      const timersBefore = vi.getTimerCount();
      const { bus, ev, got, tick } = rig({ idleTtlMs: 5_000, pruneIntervalMs: 1_000 });
      expect(vi.getTimerCount()).toBe(timersBefore + 1);
      ev('turn:a', 'received', 'ok', { thread_key: 'private:1' }); ev('turn:a', 'reply_sent', 'ok', { terminal: true });
      ev('turn:b', 'received', 'ok', { thread_key: 'private:2' });
      ev('in:q', 'queued', 'ok', { thread_key: 'private:3', result: 'queued' });
      tick(6_000); vi.advanceTimersByTime(1_000);
      expect(got.filter(m => m.type === 'remove')).toEqual([{ type: 'remove', thread: 'private:1' }]);
      expect(bus.snapshot().map(c => c.thread).sort()).toEqual(['private:2', 'private:3']);
      bus.close();
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally { vi.useRealTimers(); }
  });

  it('快照顺序：工作中的会话在前（按回合开始），空闲的按最近活动倒序；显示名来自 label', () => {
    const { bus, ev } = rig({ label: thread => thread === 'group:7' ? '家庭群' : undefined });
    ev('turn:a', 'received', 'ok', { thread_key: 'group:7' }); ev('turn:a', 'reply_sent', 'ok', { terminal: true });
    ev('turn:b', 'received', 'ok', { thread_key: 'private:2' }); ev('turn:b', 'reply_sent', 'ok', { terminal: true });
    ev('turn:c', 'received', 'ok', { thread_key: 'owner' });
    ev('turn:d', 'received', 'ok', { thread_key: 'private:4' });
    expect(bus.snapshot().map(c => c.thread)).toEqual(['owner', 'private:4', 'private:2', 'group:7']);
    expect(bus.snapshot().find(c => c.thread === 'group:7')!.label).toBe('家庭群');
    bus.close();
  });

  it('trace.tap 在无存储时也推送，并先脱敏；摘要把工具参数展开为键值', () => {
    const secret = 'tap-secret-445566'; registerSecrets([secret]);
    const t = new Trace(); const got: LiveEvent[] = [];
    const off = t.tap(e => got.push(e));
    t.event('x', 'tool:web_search', { status: 'started', detail: { input: { query: '查 ' + secret }, api_key: 'k' } });
    off(); t.event('x', 'after');
    expect(got).toHaveLength(1);
    expect(got[0]!.key).toBe('x');
    expect(JSON.stringify(got[0])).not.toContain(secret);
    expect(got[0]!.detail.api_key).toBe('[已隐藏]');
    expect(summarize(got[0]!)).toBe('query 查 [已隐藏]');
  });
});

describe('LiveBus 的 context 增量', () => {
  it('context_usage 事件推送脱敏后的白名单记录（线程键不被当作密钥隐藏），回合内的占用事件也进事件流', () => {
    const trace = new Trace();
    const bus = new LiveBus(trace);
    const got: LiveMessage[] = [];
    bus.subscribe(m => got.push(m));
    trace.event('turn:t1', 'received', { scope: 'group:7', detail: { text: '你好', thread_key: 'group:7' } });
    trace.event('turn:t1', 'dispatched', { detail: { backend: 'pi', conversation_key: 'group:7' } });
    trace.event('@pi', 'context_usage', { detail: { backend: 'pi', key: 'group:7', usedTokens: 64_000, windowTokens: 128_000, compaction: { background: 89_600, reserve: 112_000 }, turns: 3, updatedAt: 9, source: 'turn', secret: 'x' } });
    const ctx = got.filter(m => m.type === 'context');
    expect(ctx).toEqual([{ type: 'context', usage: { backend: 'pi', key: 'group:7', usedTokens: 64_000, windowTokens: 128_000, compaction: { background: 89_600, reserve: 112_000 }, turns: 3, updatedAt: 9, source: 'turn' } }]);
    expect(bus.snapshot()).toHaveLength(1); // @ 系统键不建行
    expect(bus.snapshot()[0]).toMatchObject({ thread: 'group:7', backend: 'pi' });
    trace.event('turn:t1', 'context_usage', { detail: { backend: 'pi', key: 'group:7', usedTokens: 70_000, windowTokens: 128_000, turns: 4, updatedAt: 10, source: 'turn' } });
    const last = got.filter(m => m.type === 'conversation').at(-1)!;
    expect(last.type === 'conversation' && last.item?.summary).toBe('上下文 70k / 128k（55%）');
    bus.close();
  });
});

it('用量摘要明确标注线程累计量，并兼容旧观测字段；发送摘要带正文', () => {
  expect(summarize({ stage: 'model_usage', status: 'ok', detail: { backend: 'codex', total_input_tokens: 3000000, total_output_tokens: 10000 } }))
    .toBe('线程累计输入 3000000 / 输出 10000 tokens');
  expect(summarize({ stage: 'model_usage', status: 'ok', detail: { input_tokens: 1000, output_tokens: 50 } }))
    .toBe('输入 1000 / 输出 50 tokens');
  expect(summarize({ stage: 'send_message', status: 'ok', detail: { text: '晴', message_id: '5', target: 'qq:group:7' } }))
    .toBe('→ 晴 · 消息 #5 · 目标 qq:group:7');
});
