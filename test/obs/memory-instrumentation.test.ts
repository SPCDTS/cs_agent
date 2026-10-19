import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { MemoryInstrumentation, purgeMemoryInstrumentation } from '../../src/obs/memory/instrumentation.js';
import { ensureMemoryTables } from '../../src/obs/schema.js';
import { type RecallRecord } from '../../src/context/observer.js';
import { ObsStore } from '../../src/obs/store.js';
import { tmp } from '../agent/helpers.js';

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
export const recallEvent = (ts = Date.now()): RecallRecord => ({ ts, backend: 'pi', ticket: 'tk', session: '1', task_id: '2',
  tool: 'qq_search', args: { query: '中文' }, access: 'group:1', scope_hint: 'group:1', returned: [{ kind: 'message', id: 'm1' }],
  returned_count: 1, dropped_count: 2, chars: 20, max_chars: 100, duration_ms: 3, is_error: false });
const summary = { id: 1, scope: 'group:1', level: 'day' as const, period_start: 1, period_end: 2, text: '中文摘要', msg_count: 5, created_at: 3 };
function rig() {
  const obs = new ObsStore(tmp()); closes.push(() => obs.close());
  return { db: obs.db, writer: MemoryInstrumentation.fromDb(obs.db) };
}

it('建表幂等并完整保存正文、来源、用量与有序召回引用', () => {
  const { db, writer } = rig(); ensureMemoryTables(db); ensureMemoryTables(db);
  writer.recordSummaryVersion(summary, { batch_id: 'batch', model: 'm', provider: 'p', usage: { input: 9 }, input_message_ids: ['m1'], input_chars: 70 });
  writer.recordRecall(recallEvent());
  expect(db.prepare('SELECT * FROM summary_versions').get()).toMatchObject({ summary_id: 1, text: '中文摘要', kept_chars: 4,
    input_message_ids_json: '["m1"]', usage_json: '{"input":9}', input_chars: 70, text_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(db.prepare('SELECT * FROM recall_events').get()).toMatchObject({ ticket: 'tk', task_id: '2', returned_json: '[{"kind":"message","id":"m1"}]', is_error: 0 });
});
it('快照复用已记录的同一版本；替换关系与周版本一起写入', () => {
  const { db, writer } = rig();
  const id = writer.recordSummaryVersion(summary, { batch_id: 'a' })!;
  expect(writer.snapshotReplaced(summary, { batch_id: 'b' })).toBe(id);
  const week = writer.recordSummaryVersion({ ...summary, id: 2, level: 'week' }, { batch_id: 'b', input_summary_ids: [1], created_at: 100 }, [id]);
  expect(db.prepare('SELECT * FROM summary_versions WHERE id=?').get(id)).toMatchObject({ batch_id: 'a', replaced_by: week, replaced_at: 100 });
});
it('业务失败回滚版本，数据库只读或已关闭时写入只降级自身', () => {
  const { db, writer } = rig();
  expect(() => writer.transaction(() => { writer.recordSummaryVersion(summary, { batch_id: 'a' }); throw Error('业务失败'); })).toThrow('业务失败');
  expect(db.prepare('SELECT COUNT(*) n FROM summary_versions').get()?.n).toBe(0);
  db.exec('PRAGMA query_only=ON');
  expect(writer.recordRecall(recallEvent())).toBeUndefined();
  expect(writer.recordSummaryVersion(summary, { batch_id: 'a' })).toBeUndefined();
  db.close(); expect(() => writer.recordRecall(recallEvent())).not.toThrow();
});
it('独立连接设置 WAL 与 busy_timeout，关闭共享写入器不关闭主库', () => {
  const dir = tmp(), writer = MemoryInstrumentation.openOwn(dir);
  writer.recordRecall({ ...recallEvent(), session: '' });
  writer.close();
  const db = new DatabaseSync(path.join(dir, 'observability.sqlite')); closes.push(() => db.close());
  expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
  expect(db.prepare('SELECT session FROM recall_events').get()?.session).toBeNull();
  MemoryInstrumentation.fromDb(db).close(); expect(db.isOpen).toBe(true);
});
it('独立库打不开时仍可调用写入方法', () => {
  const dir = tmp(); mkdirSync(path.join(dir, 'observability.sqlite'));
  const writer = MemoryInstrumentation.openOwn(dir);
  expect(() => writer.recordRecall(recallEvent())).not.toThrow(); writer.close();
});
it('记忆保留期独立清理两张表，0 禁用，边界保留且不清理 events', () => {
  const { db, writer } = rig(), now = 100 * 86400_000, cutoff = now - 90 * 86400_000;
  for (const ts of [cutoff - 1, cutoff]) {
    writer.recordRecall(recallEvent(ts)); writer.recordSummaryVersion(summary, { batch_id: 'a', created_at: ts });
  }
  db.prepare("INSERT INTO events(ticket,scope,ts,stage,status,detail_json) VALUES('tk','',0,'test','ok','{}')").run();
  expect(purgeMemoryInstrumentation(db, 0, now)).toEqual({ versions: 0, recalls: 0 });
  expect(purgeMemoryInstrumentation(db, 90, now)).toEqual({ versions: 1, recalls: 1 });
  expect(db.prepare('SELECT COUNT(*) n FROM events').get()?.n).toBe(1);
});
it('记忆保留期默认 90 天，接受 0 并拒绝负数和小数', () => {
  expect(loadConfig({}).OBS_MEMORY_RETENTION_DAYS).toBe(90);
  expect(loadConfig({ OBS_MEMORY_RETENTION_DAYS: '0' }).OBS_MEMORY_RETENTION_DAYS).toBe(0);
  for (const value of ['-1', '1.5']) expect(() => loadConfig({ OBS_MEMORY_RETENTION_DAYS: value })).toThrow(/OBS_MEMORY_RETENTION_DAYS/);
});
