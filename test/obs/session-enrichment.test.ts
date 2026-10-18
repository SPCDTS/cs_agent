import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObsStore } from '../../src/obs/store.js';
import { enrichTurns } from '../../src/obs/sessions/enrichment.js';
import type { TurnIndex } from '../../src/obs/sessions/types.js';

const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });
function rig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-session-enrich-')), store = new ObsStore(dir, 10000);
  clean.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const event = (ticket: string, ts: number, stage: string, detail: unknown) => store.append({ ticket, scope: 'group:7', ts, stage, status: 'ok', duration_ms: null, detail });
  return { store, event };
}
const turn = (started: number, ended = started + 1000): TurnIndex => ({ turn: String(started), started, ended,
  status: 'ok', preview: '来自事实源的正文', tools: 0, requests: 1 });

describe('票据补充事实', () => {
  it('按后端、真实会话 ID 和时间窗口关联，正文及模型状态不被送达状态替代', () => {
    const { store, event } = rig();
    event('t1', 100_000, 'dispatched', { backend: 'codex', thread_id: 'thread' });
    event('t1', 101_000, 'failed', { terminal: true, failure: 'timeout', text: '不得替代正文' });
    event('wrong-backend', 100_005, 'dispatched', { backend: 'pi', conversation: 'thread' });
    event('wrong-id', 100_006, 'dispatched', { backend: 'codex', thread_id: 'other' });
    event('t2', 102_000, 'dispatched', { backend: 'codex', thread_id: 'thread' });
    event('t2', 103_000, 'reply_sent', { terminal: true });
    const turns = enrichTurns(store, 'codex', 'thread', [turn(100_010), turn(102_010), turn(500_000)]);
    expect(turns[0]).toMatchObject({ ticket: 't1', preview: '来自事实源的正文', status: 'ok', delivery: { status: 'timeout', scope: 'group:7', duration_ms: 1000 } });
    expect(turns[1]).toMatchObject({ ticket: 't2', delivery: { status: 'sent' } });
    expect(turns[2]!.ticket).toBeUndefined();
  });

  it('支持 Pi 数字会话 ID，终态在 2000 行以后仍可见', () => {
    const { store, event } = rig();
    event('pi-ticket', 100_000, 'dispatched', { backend: 'pi', conversation: 42 });
    const insert = store.db.prepare("INSERT INTO events(ticket,scope,ts,stage,status,detail_json) VALUES('pi-ticket','group:7',100001,'tool:test','ok','{}')");
    for (let i = 0; i < 2100; i++) insert.run();
    event('pi-ticket', 101_000, 'reply_sent', { terminal: true });
    expect(enrichTurns(store, 'pi', '42', [turn(100_005)])[0]).toMatchObject({ ticket: 'pi-ticket', delivery: { status: 'sent' } });
  });

  it('不把歧义票据或不在时间窗内的历史派发强行关联', () => {
    const { store, event } = rig();
    for (const id of ['a', 'b']) event(id, 100_000, 'dispatched', { backend: 'pi', conversation: 1 });
    expect(enrichTurns(store, 'pi', '1', [turn(100_005)])[0]!.ticket).toBeUndefined();
    expect(enrichTurns(store, 'pi', '1', [turn(900_000)])[0]!.ticket).toBeUndefined();
    store.degrade(); expect(enrichTurns(store, 'pi', '1', [turn(100_005)])[0]!.preview).toBe('来自事实源的正文');
  });
});
