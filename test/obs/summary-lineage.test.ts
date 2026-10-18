import { describe, expect, it } from 'vitest';
import type { SummaryVersion } from '../../src/obs/memory/types.js';
import { lineageSection, summaryPageBody, usageText, type SummaryDetail } from '../../src/obs/ui/memory-pages.js';

const XSS = '<script>alert(1)</script>';
const T0 = Date.parse('2026-10-18T08:00:00Z');

const version = (o: Partial<SummaryVersion> = {}): SummaryVersion => ({ id: 11, summary_id: 3, level: 'week', period_start: T0 - 7 * 86400_000, period_end: T0, created_at: T0,
  batch_id: '0123456789abcdef-batch', model: 'gpt-x', provider: 'openai', usage: { input: 1200, output: 300 }, input_message_ids: [], input_summary_ids: [1, 2],
  input_chars: 5000, kept_chars: 800, text_sha256: 'a'.repeat(64), text: '周正文', replaced_by: null, replaced_at: null, ...o });

describe('摘要血缘渲染', () => {
  const base: SummaryDetail = { id: 3, scope: 'group:123', kind: 'week', period_start: T0 - 7 * 86400_000, period_end: T0, created_at: T0, text: '周正文', surviving_raw: 0, lineage: null };

  it('版本卡（批次短码、模型、用量、输入→保留、输入摘要链接、SHA 短码、替换）与被替换的日摘要快照', () => {
    const html = summaryPageBody({ ...base, lineage: { versions: [version()],
      replaced: [version({ id: 9, summary_id: 1, level: 'day', text: `日快照 ${XSS}`, replaced_by: 11, replaced_at: T0, input_message_ids: ['m1', 'm2'], input_summary_ids: [] })] } }, '群 123');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('版本 #11'); expect(html).toContain('批次 01234567'); expect(html).toContain('gpt-x / openai');
    expect(html).toContain('input 1,200 · output 300'); expect(html).toContain('5,000 字 → 800 字');
    expect(html).toContain('href="/memory/summaries/1">#1</a>'); expect(html).toContain('href="/memory/summaries/2">#2</a>');
    expect(html).toContain(`>${'a'.repeat(12)}</span>`); expect(html).toContain('未被替换');
    expect(html).toContain('被替换的日摘要快照 <small>1 条</small>'); expect(html).toContain('href="/memory/summaries/1">日摘要 #1</a>');
    expect(html).toContain('<summary>快照正文（'); expect(html).toContain('日快照 &lt;script&gt;');
    expect(html).not.toContain('暂无血缘记录');
  });

  it('日摘要版本：输入消息折叠列表、未调用模型、被替换为某版本', () => {
    const html = lineageSection({ versions: [version({ level: 'day', model: null, provider: null, usage: null, input_message_ids: ['m1', XSS], input_summary_ids: [], replaced_by: 12, replaced_at: T0 })], replaced: [] });
    expect(html).toContain('<details><summary>2 条</summary>'); expect(html).toContain('m1 &lt;script&gt;');
    expect(html).toContain('未调用模型'); expect(html).toContain('版本 <span class="mono">#12</span>');
    expect(html).not.toContain('被替换的日摘要快照');
  });

  it('lineage null 与 deleted 横幅', () => {
    expect(summaryPageBody(base, '群 123')).toContain('暂无血缘记录（埋点启用前生成，或已超过保留期）');
    const del = summaryPageBody({ ...base, kind: 'day', deleted: true, lineage: { versions: [version({ level: 'day' })], replaced: [] } }, '群 123');
    expect(del).toContain('已被折叠进周摘要并从聊天库删除'); expect(del).toContain('最后一个快照');
    expect(usageText({ a: 1, b: 'x' })).toBe('a 1'); expect(usageText('raw')).toBe('"raw"'); expect(usageText(null)).toBe('');
  });
});
