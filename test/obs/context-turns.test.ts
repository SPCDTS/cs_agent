import { describe, expect, it } from 'vitest';
import { analyzeContextTurns, type ContextUsageEvent, type SystemEvent } from '../../src/obs/context-turns.js';
import type { ContextUsage } from '../../src/shared/format.js';

const minute = 60_000;
function event(ts: number, detail: Partial<ContextUsage> = {}): ContextUsageEvent {
  return { ts, ticket: `t${ts}`, detail: { backend: 'codex', key: 'owner', usedTokens: 10_000,
    cachedTokens: 0, windowTokens: 100_000, turns: 2, updatedAt: ts, source: 'turn', ...detail } };
}
function change(ts: number, stage: string, detail: Record<string, unknown> = {}): SystemEvent {
  return { ts, stage, detail };
}
const unknownReason = '未知（可能是服务端缓存过期或驱逐）';

describe('上下文回合分析', () => {
  it('空输入返回空序列', () => {
    expect(analyzeContextTurns([], [])).toEqual([]);
  });
  it.each([9000, 10_000, 20_000])('命中率至少 0.9 不标记（cached=%i）', cachedTokens => {
    const turn = analyzeContextTurns([event(0), event(1, { cachedTokens })], [change(1, 'prompt_changed')])[1];
    expect(turn.mark).toBeUndefined();
    expect(turn.reasons).toEqual([]);
  });
  it.each([
    [4999, 'miss'], [5000, 'partial'], [8999, 'partial'], [9000, undefined],
  ] as const)('默认阈值边界 cached=%i → %s', (cachedTokens, mark) => {
    const turn = analyzeContextTurns([event(0), event(1, { cachedTokens })], [])[1];
    expect(turn.mark).toBe(mark);
    expect(turn.reasons).toEqual(mark ? [unknownReason] : []);
  });
  it('首条可见 turn 标 first，即使 turns 为 1', () => {
    expect(analyzeContextTurns([event(0, { turns: 1 })], [])[0]).toMatchObject({ mark: 'first', reasons: [] });
    expect(analyzeContextTurns([event(0, { turns: 7 })], [])[0].gapMs).toBeUndefined();
  });
  it('压缩记录与压缩后下一轮标 compact，随后恢复判定', () => {
    const turns = analyzeContextTurns([
      event(0), event(10, { source: 'compact', usedTokens: 500 }),
      event(20, { turns: 3 }), event(30, { turns: 4 }),
    ], []);
    expect(turns.map(turn => turn.mark)).toEqual(['first', 'compact', 'compact', 'miss']);
    expect(turns[2]).toMatchObject({ gapMs: 20, reasons: [] });
  });
  it('只有压缩记录时仍标 compact，其后无历史 turn 也保留压缩标记', () => {
    expect(analyzeContextTurns([event(0, { source: 'compact' }), event(1)], []).map(turn => turn.mark))
      .toEqual(['compact', 'compact']);
  });
  it('重建后 turns 回到 1 标 reset，下一轮使用重建后的基准', () => {
    const turns = analyzeContextTurns([event(0), event(1, { turns: 1, usedTokens: 5000 }),
      event(2, { turns: 2, cachedTokens: 4500 })], []);
    expect(turns.map(turn => turn.mark)).toEqual(['first', 'reset', undefined]);
    expect(turns[1].reasons).toEqual([]);
  });
  it('压缩标记优先于 turns 为 1 的重建标记', () => {
    expect(analyzeContextTurns([event(0), event(1, { source: 'compact' }), event(2, { turns: 1 })], [])[2].mark)
      .toBe('compact');
  });
  it.each([[4095, undefined], [4096, 'miss']] as const)('minPrevTokens 默认边界 prev.used=%i → %s', (usedTokens, mark) => {
    expect(analyzeContextTurns([event(0, { usedTokens }), event(1)], [])[1].mark).toBe(mark);
  });
  it('小基准优先跳过压缩后与重建后的判定', () => {
    const small = event(0, { usedTokens: 4095 });
    expect(analyzeContextTurns([small, event(1, { source: 'compact' }), event(2)], [])[2].mark).toBeUndefined();
    expect(analyzeContextTurns([small, event(1, { turns: 1 })], [])[1].mark).toBeUndefined();
  });
  it.each([
    [2999, 'miss'], [3000, 'partial'], [6999, 'partial'], [7000, undefined],
  ] as const)('自定义 miss/partial 阈值 cached=%i → %s', (cachedTokens, mark) => {
    expect(analyzeContextTurns([event(0), event(1, { cachedTokens })], [], { missRatio: 0.3, partialRatio: 0.7 })[1].mark)
      .toBe(mark);
  });
  it('自定义 minPrevTokens 生效，零基准不会产生除零误报', () => {
    expect(analyzeContextTurns([event(0, { usedTokens: 1000 }), event(1)], [], { minPrevTokens: 1001 })[1].mark).toBeUndefined();
    expect(analyzeContextTurns([event(0, { usedTokens: 1000 }), event(1)], [], { minPrevTokens: 1000 })[1].mark).toBe('miss');
    expect(analyzeContextTurns([event(0, { usedTokens: 0 }), event(1)], [], { minPrevTokens: 0 })[1].mark).toBeUndefined();
  });
  it.each(['codexModel', 'piModel', 'agentBackend'])('模型设置 %s 变化解释为切换模型', field => {
    expect(analyzeContextTurns([event(0), event(2)], [change(1, 'settings_changed',
      { changed: [field], before: { [field]: 'old' }, after: { [field]: 'new' } })])[1].reasons).toEqual(['切换模型']);
  });
  it('无关设置与非法 changed 不解释为模型变化', () => {
    const system = [change(1, 'settings_changed', { changed: ['alertOwner'] }),
      change(1, 'settings_changed', { changed: 'codexModel' }), change(1, 'settings_changed')];
    expect(analyzeContextTurns([event(0), event(2)], system)[1].reasons).toEqual([unknownReason]);
  });
  it('prompt_changed 解释为提示词变更，也适用于 partial', () => {
    expect(analyzeContextTurns([event(0), event(2, { cachedTokens: 5000 })], [change(1, 'prompt_changed')])[1])
      .toMatchObject({ mark: 'partial', reasons: ['提示词变更'] });
  });
  it.each([[60 * minute, unknownReason], [61 * minute, '间隔 61 分钟']] as const)(
    '长间隔采用严格大于 60 分钟的边界（gap=%i）', (ts, reason) => {
      expect(analyzeContextTurns([event(0), event(ts)], [])[1]).toMatchObject({ gapMs: ts, reasons: [reason] });
    },
  );
  it('自定义 gapMs 生效，间隔分钟数四舍五入', () => {
    expect(analyzeContextTurns([event(0), event(90_000)], [], { gapMs: 89_999 })[1].reasons).toEqual(['间隔 2 分钟']);
    expect(analyzeContextTurns([event(0), event(90_000)], [], { gapMs: 90_000 })[1].reasons).toEqual([unknownReason]);
  });
  it('有效窗口变化解释为窗口变化，名义窗口变化但有效窗口相同不解释', () => {
    expect(analyzeContextTurns([event(0), event(1, { effectiveWindowTokens: 80_000 })], [])[1].reasons).toEqual(['窗口变化']);
    expect(analyzeContextTurns([event(0, { effectiveWindowTokens: 80_000 }),
      event(1, { effectiveWindowTokens: 80_000, windowTokens: 200_000 })], [])[1].reasons).toEqual([unknownReason]);
  });
  it('没有已知原因时使用未知原因', () => {
    expect(analyzeContextTurns([event(0), event(1)], [])[1].reasons).toEqual([unknownReason]);
  });
  it('多原因按系统事件发生顺序去重，再追加间隔与窗口', () => {
    const system = [change(30, 'settings_changed', { changed: ['codexModel'] }), change(10, 'prompt_changed'),
      change(20, 'settings_changed', { changed: ['piModel'] }), change(40, 'prompt_changed')];
    expect(analyzeContextTurns([event(0), event(61 * minute, { windowTokens: 200_000 })], system)[1].reasons)
      .toEqual(['提示词变更', '切换模型', '间隔 61 分钟', '窗口变化']);
  });
  it('系统事件区间左开右闭，不关联上一轮之前或当前轮之后的变更', () => {
    const system = [change(0, 'prompt_changed'), change(10, 'prompt_changed'),
      change(20, 'settings_changed', { changed: ['agentBackend'] }), change(21, 'prompt_changed')];
    expect(analyzeContextTurns([event(10), event(20)], system)[1].reasons).toEqual(['切换模型']);
  });
  it('uncached 下限为零且 cached 保留原值，缺少缓存量按零计算', () => {
    expect(analyzeContextTurns([event(0, { usedTokens: 5000, cachedTokens: 8000 })], [])[0])
      .toMatchObject({ used: 5000, cached: 8000, uncached: 0 });
    expect(analyzeContextTurns([event(0, { cachedTokens: undefined })], [])[0])
      .toMatchObject({ cached: 0, uncached: 10_000 });
    expect(analyzeContextTurns([event(0, { cachedTokens: 3000 })], [])[0].uncached).toBe(7000);
  });
  it('pct 使用有效窗口或名义窗口，返回比例且不裁剪，零窗口不除零', () => {
    expect(analyzeContextTurns([event(0)], [])[0]).toMatchObject({ window: 100_000, pct: 0.1 });
    expect(analyzeContextTurns([event(0, { effectiveWindowTokens: 8000 })], [])[0])
      .toMatchObject({ window: 8000, pct: 1.25 });
    expect(analyzeContextTurns([event(0, { windowTokens: 0 })], [])[0].pct).toBe(0);
  });
  it('estimate 被跳过，不影响上一回合、间隔或压缩标记', () => {
    const turns = analyzeContextTurns([event(0, { source: 'estimate' }), event(10),
      event(20, { source: 'estimate', usedTokens: 1 }), event(30, { cachedTokens: 9000 }),
      event(40, { source: 'compact' }), event(50, { source: 'estimate' }), event(60)], []);
    expect(turns.map(turn => turn.ts)).toEqual([10, 30, 40, 60]);
    expect(turns.map(turn => turn.mark)).toEqual(['first', undefined, 'compact', 'compact']);
    expect(turns[1].gapMs).toBe(20);
    expect(turns[3].gapMs).toBe(30);
    expect(analyzeContextTurns([event(0, { source: 'estimate' })], [])).toEqual([]);
  });
  it('不修改输入数组、事件或系统 detail，重复分析结果相同', () => {
    const events = [event(0), event(60 * minute + 1)];
    const system = [change(20, 'prompt_changed'), change(10, 'settings_changed', { changed: ['piModel'] })];
    const before = structuredClone({ events, system });
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    };
    freeze(events); freeze(system);
    const first = analyzeContextTurns(events, system);
    expect(analyzeContextTurns(events, system)).toEqual(first);
    expect({ events, system }).toEqual(before);
  });
});
