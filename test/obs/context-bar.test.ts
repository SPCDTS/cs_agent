import { describe, expect, it } from 'vitest';
import { contextBar, fmtShort, fmtInt, sortUsage, toContextUsage, type ContextUsage } from '../../src/obs/ui/context-bar.js';
import { THEME_CSS } from '../../src/obs/ui/theme.js';

const NOW = Date.UTC(2026, 9, 18, 12);
const usage = (over: Partial<ContextUsage> = {}): ContextUsage =>
  ({ backend: 'codex', key: 'owner', usedTokens: 123_456, windowTokens: 400_000, turns: 7, updatedAt: NOW - 60_000, source: 'turn', ...over });

describe('上下文占用条渲染', () => {
  it('有效窗口优先用于数字、百分比、提示和排序；旧记录及 pi 保持名义窗口', () => {
    const u = usage({ usedTokens: 237500, windowTokens: 500000, effectiveWindowTokens: 475000 });
    for (const mini of [false, true]) {
      const html = contextBar('codex', 'owner', u, { mini, now: NOW });
      expect(html).toContain('50%'); expect(html).toContain('data-w="50"'); expect(html).toContain('238k / 475k');
      expect(html).toContain('名义 500,000 / 有效 475,000');
      expect(html).toContain('237,500 / 475,000 tokens');
    }
    const old = contextBar('codex', 'owner', { ...u, effectiveWindowTokens: undefined });
    expect(old).toContain('48%'); expect(old).toContain('238k / 500k'); expect(old).not.toContain('名义');
    expect(contextBar('pi', 'owner', { ...u, backend: 'pi' })).toContain('238k / 500k');
    const a = { ...u, key: 'a' }, b = usage({ key: 'b', usedTokens: 245000, windowTokens: 500000 });
    expect(sortUsage([b, a]).map(u => u.key)).toEqual(['a', 'b']);
    expect(toContextUsage({ ...u })?.effectiveWindowTokens).toBe(475000);
    expect(toContextUsage({ ...u, effectiveWindowTokens: 0 })?.effectiveWindowTokens).toBeUndefined();
  });
  it('codex 动态会话键显示群和私聊标签', () => {
    expect(contextBar('codex', 'group:42', null)).toContain('Codex · 群 42');
    expect(contextBar('codex', 'private:99', null)).toContain('Codex · 私聊 99');
  });

  it('数字带千分位与 k/M 简写', () => {
    expect(fmtInt(1234567)).toBe('1,234,567');
    expect([999, 1000, 9_876, 12_345, 400_000, 1_000_000, 1_050_000, 2_345_678].map(fmtShort)).toEqual(['999', '1k', '9.9k', '12k', '400k', '1M', '1.05M', '2.35M']);
  });

  it('按占比分三档：<60% 常态、60–85% 提醒、>85% 警示；宽度用 data-w，不写内联 style', () => {
    const at = (used: number) => contextBar('codex', 'owner', usage({ usedTokens: used }), { now: NOW });
    const low = at(123_456);
    expect(low).toContain('ctx ctx-t-ok'); expect(low).toContain('data-w="31"'); expect(low).toContain('31%');
    expect(low).toContain('123,456'); expect(low).toContain('400,000'); expect(low).toContain('123k / 400k');
    expect(low).toContain('Codex · owner 线程'); expect(low).toContain('data-ctx="codex|owner"'); expect(low).toContain('aria-valuenow="31"');
    expect(at(240_000)).toContain('ctx-t-warn'); expect(at(340_000)).toContain('ctx-t-warn');   // 60%、85% 属提醒
    expect(at(344_000)).toContain('ctx-t-hot');
    expect(at(500_000)).toContain('data-w="100"'); expect(at(500_000)).toContain('125%');      // 溢出时条满格，百分比如实
    for (const html of [low, at(500_000)]) expect(html).not.toMatch(/\sstyle=/);
  });

  it('pi 条画出后台压缩与阻塞压缩两道阈值刻口，带中文说明', () => {
    const html = contextBar('pi', 'group:7', usage({ backend: 'pi', key: 'group:7', usedTokens: 50_000, windowTokens: 128_000, compaction: { background: 89_600, reserve: 112_000 } }), { now: NOW });
    expect(html).toContain('Pi · 群 7');
    expect(html).toMatch(/class="ctx-tick ctx-bg" data-at="70" title="后台压缩阈值：89,600 tokens（70%）/);
    expect(html).toMatch(/class="ctx-tick ctx-rs" data-at="88" title="阻塞压缩阈值：112,000 tokens（88%）/);
    expect(html).toContain('压缩阈值 70% / 88%');
    expect(contextBar('codex', 'owner', usage(), { now: NOW })).not.toContain('ctx-tick');
  });

  it('估算值虚线、超过 24 小时褪色并显示"上次更新 x 小时前"、无数据占位', () => {
    const est = contextBar('pi', 'owner', usage({ backend: 'pi', source: 'estimate' }), { now: NOW });
    expect(est).toContain('ctx-est'); expect(est).toContain('估算值'); expect(est).toContain('owner 私聊');
    const stale = contextBar('codex', 'shared', usage({ key: 'shared', updatedAt: NOW - 30 * 3600_000 }), { now: NOW });
    expect(stale).toContain('ctx-stale'); expect(stale).toContain('上次更新 30 小时前');
    expect(contextBar('codex', 'shared', usage({ updatedAt: NOW - 23 * 3600_000 }), { now: NOW })).not.toContain('ctx-stale');
    const none = contextBar('codex', 'shared', null);
    expect(none).toContain('ctx-none'); expect(none).toContain('暂无占用数据'); expect(none).toContain('data-ctx="codex|shared"');
    const mini = contextBar('pi', 'group:7', usage({ backend: 'pi', key: 'group:7' }), { mini: true, now: NOW });
    expect(mini).toContain('ctx-mini'); expect(mini).not.toContain('ctx-meta'); expect(mini).toContain('<span class="ctx-track"');
  });

  it('排序：codex 在前、pi 在后，同后端内占比降序', () => {
    const list = sortUsage([usage({ backend: 'pi', key: 'owner', usedTokens: 390_000 }), usage({ key: 'shared', usedTokens: 10 }), usage({ key: 'owner', usedTokens: 300_000 }), usage({ backend: 'pi', key: 'group:7', usedTokens: 1 })]);
    expect(list.map(u => `${u.backend}|${u.key}`)).toEqual(['codex|owner', 'codex|shared', 'pi|owner', 'pi|group:7']);
  });

  it('事件 detail 只取白名单字段，非法记录丢弃', () => {
    expect(toContextUsage({ backend: 'pi', key: 'owner', usedTokens: 1, windowTokens: 2, turns: 1, updatedAt: 5, source: 'turn', extra: 'x', compaction: { background: 1, reserve: 'x' } }))
      .toEqual({ backend: 'pi', key: 'owner', usedTokens: 1, windowTokens: 2, turns: 1, updatedAt: 5, source: 'turn' });
    expect(toContextUsage({ backend: 'gpt', key: 'owner', usedTokens: 1, windowTokens: 2 })).toBeNull();
    expect(toContextUsage({ backend: 'pi', key: 'owner', usedTokens: '1', windowTokens: 2 })).toBeNull();
  });

  it('375px 宽度不产生横向滚动：占用条相关规则没有超过视口的固定宽度，列表列宽受 min(100%,…) 约束', () => {
    const rules = THEME_CSS.split('\n').filter(l => /\.ctx|\.thread-ctx/.test(l) && !/data-(w|at)=/.test(l));
    expect(rules.join('\n')).toContain('minmax(min(100%,380px),1fr)');
    for (const r of rules) for (const m of r.matchAll(/(?:^|[;{])\s*(?:min-)?width:(\d+)px/g)) expect(Number(m[1]), r).toBeLessThanOrEqual(343 - 32);
    expect(rules.join('\n')).toMatch(/\.ctx-head\{display:flex;flex-wrap:wrap/);
    expect(THEME_CSS).toContain('.ctx-fill[data-w="57"]{width:57%}'); expect(THEME_CSS).toContain('.ctx-tick[data-at="100"]{left:100%}');
  });
});
