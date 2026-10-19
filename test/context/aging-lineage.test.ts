import { createHash } from 'node:crypto';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { afterEach, expect, it, vi } from 'vitest';
import { runAging, type AgingOptions } from '../../src/context/aging.js';
import { ContextStore } from '../../src/context/store.js';
import { MemoryInstrumentation } from '../../src/obs/memory/instrumentation.js';
import { ObsStore } from '../../src/obs/store.js';
import { tmp } from '../agent/helpers.js';

const NOW = Date.UTC(2026, 9, 21), day = 86400, current = NOW / 1000 - day, old = current - 7 * day;
const closes: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(f => f()); });
function rig() {
  const dir = tmp(), store = new ContextStore(dir, { tzOffsetSec: 0 }), obs = new ObsStore(dir);
  closes.push(() => { store.close(); obs.close(); });
  const faux = fauxProvider(), models = createModels(), inputs: string[] = [];
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 5 }, () => context => {
    const content = context.messages.find(m => m.role === 'user')!.content;
    inputs.push(typeof content === 'string' ? content : content.map(c => c.type === 'text' ? c.text : '').join(''));
    return fauxAssistantMessage(fauxText('长摘要'.repeat(200)));
  }));
  const instrumentation = MemoryInstrumentation.fromDb(obs.db);
  const opts: AgingOptions = { store, instrumentation, models, model: () => faux.getModel(), rawDays: 30, summaryDays: 180, hour: 3, now: () => NOW };
  const seed = (start: number, n = 5) => {
    for (let i = 0; i < n; i++) store.ingest({ message_id: String(start + i), time: start + i, message_type: 'group',
      group_id: '1', user_id: '2', self_id: '3', nickname: '甲', text: '正文'.repeat(100), route_text: '', truncated: false,
      mentioned_self: false, images: [], segments: [] });
  };
  return { store, obs, opts, inputs, seed };
}
it('日版本保存实际裁剪正文、模型用量与实际进入输入的消息 ID', async () => {
  const r = rig(); r.seed(current, 200);
  expect(await runAging(r.opts)).toMatchObject({ day_summaries: 1, failed: 0 });
  const version = r.obs.db.prepare('SELECT * FROM summary_versions').get()!;
  const written = r.store.search({ kind: 'all' }, { query: '长摘要', days: 30, limit: 10, now: NOW / 1000 })[0].row;
  expect(version).toMatchObject({ summary_id: written.id, text: written.text, kept_chars: written.text.length,
    input_chars: r.inputs[0].length, model: r.opts.model().id, provider: r.opts.model().provider,
    text_sha256: createHash('sha256').update(written.text).digest('hex') });
  const ids = JSON.parse(String(version.input_message_ids_json)) as string[];
  expect(ids.length).toBeGreaterThan(0); expect(ids.length).toBeLessThan(200);
  expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => String(current + 200 - ids.length + i)));
  expect(JSON.parse(String(version.usage_json))).toHaveProperty('input');
  expect(String(version.batch_id)).toMatch(/^[a-f0-9-]{36}$/);
});
it('周折叠快照历史日摘要，保存周输入及替换关系，单日复用没有虚构 usage', async () => {
  const r = rig();
  const daily = r.store.writeSummary({ scope: 'group:1', level: 'day', period_start: old, period_end: old + day, text: '旧日摘要', msg_count: 5 });
  await runAging(r.opts);
  const versions = r.obs.db.prepare('SELECT * FROM summary_versions ORDER BY id').all();
  expect(versions).toHaveLength(2);
  expect(versions[0]).toMatchObject({ summary_id: daily.id, text: daily.text, replaced_by: versions[1].id, replaced_at: versions[1].created_at });
  expect(versions[1]).toMatchObject({ level: 'week', text: daily.text, model: null, usage_json: 'null', input_chars: 0,
    input_summary_ids_json: JSON.stringify([daily.id]), batch_id: versions[0].batch_id });
  expect(r.store.foldableWeeks(NOW / 1000)).toEqual([]);
});
it('同批次日摘要与多日周摘要版本一致，不重复快照', async () => {
  const r = rig(); r.seed(old); r.seed(old + day);
  expect(await runAging(r.opts)).toMatchObject({ day_summaries: 2, week_summaries: 1, failed: 0 });
  const versions = r.obs.db.prepare('SELECT * FROM summary_versions ORDER BY id').all();
  expect(versions).toHaveLength(3);
  expect(new Set(versions.map(v => v.batch_id)).size).toBe(1);
  expect(versions[2]).toMatchObject({ input_chars: r.inputs[2].length, input_summary_ids_json: JSON.stringify(versions.slice(0, 2).map(v => v.summary_id)) });
  expect(versions.slice(0, 2).map(v => v.replaced_by)).toEqual([versions[2].id, versions[2].id]);
});
it('版本表写入失败仍完成日摘要与周折叠', async () => {
  const r = rig(); r.seed(old); r.obs.db.exec('PRAGMA query_only=ON');
  expect(await runAging(r.opts)).toMatchObject({ day_summaries: 1, week_summaries: 1, failed: 0 });
  expect(r.store.stats().summaries).toBe(1);
  expect(r.obs.db.prepare('SELECT COUNT(*) n FROM summary_versions').get()?.n).toBe(0);
});
it('聊天库折叠失败时撤销本次快照并保留日摘要', async () => {
  const r = rig();
  r.store.writeSummary({ scope: 'group:1', level: 'day', period_start: old, period_end: old + day, text: '旧摘要', msg_count: 5 });
  vi.spyOn(r.store, 'replaceWithWeek').mockImplementation(() => { throw Error('模拟聊天库失败'); });
  expect(await runAging(r.opts)).toMatchObject({ week_summaries: 0, failed: 1 });
  expect(r.store.stats().summaries).toBe(1);
  expect(r.obs.db.prepare('SELECT COUNT(*) n FROM summary_versions').get()?.n).toBe(0);
});
