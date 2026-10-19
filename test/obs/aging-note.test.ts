import { describe, expect, it } from 'vitest';
import { agingNote } from '../../src/obs/ui/dashboard-pages.js';
import { epochMs, fmtTime } from '../../src/obs/ui/html.js';

describe('聊天记录整理时间', () => {
  const now = 1_792_300_000_000;

  it('epochMs：小于 1e12 视为秒，数字字符串可用，无效值返回 null', () => {
    expect(epochMs(1_792_292_399)).toBe(1_792_292_399_000);
    expect(epochMs('1792292399')).toBe(1_792_292_399_000);
    expect(epochMs(1_792_292_399_000)).toBe(1_792_292_399_000);
    expect(epochMs('abc')).toBeNull(); expect(epochMs(0)).toBeNull(); expect(epochMs(null)).toBeNull();
  });

  it('秒级 last_run 与毫秒级 ts 都格式化为日期时间 + 相对时间', () => {
    const sec = { last_run: '1792292399' }, ms = { ts: 1_792_292_399_000 };
    const expected = `上次 ${fmtTime(1_792_292_399_000)}（2 小时前）`;
    expect(agingNote(sec, now)).toBe(expected);
    expect(agingNote(ms, now)).toBe(expected);
    expect(agingNote(sec, now)).not.toContain('1792292399');
    expect(agingNote({ last_run: null }, now)).toBe('尚未运行');
    expect(agingNote({}, now)).toBe('尚未运行');
  });
});
