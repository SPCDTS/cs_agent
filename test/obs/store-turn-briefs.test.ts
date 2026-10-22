import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsStore } from '../../src/obs/store.js';
import type { TurnBrief } from '../../src/shared/context-turns.js';

const clean: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of clean.splice(0).reverse()) fn();
});
function rig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-obs-briefs-'));
  const store = new ObsStore(dir);
  clean.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close());
  return store;
}
function add(store: ObsStore, key: string, stage: string, detail: unknown = {},
  ts = 1, status = 'ok', scope = 'group:7') {
  store.append({ key, scope, ts, stage, status, duration_ms: 999, detail });
}

describe('回合简报查询', () => {
  it('turnBriefs 聚合字段与 turns 一致：会话、种类、后端、发送者、结果（终态 detail.status，缺省按 stage）', () => {
    const store = rig();
    const cases = [
      ['turn:completed', 'reply_sent', 'completed'], ['turn:failed', 'failed', 'failed'], ['turn:lost', 'failed', 'lost'],
      ['turn:legacy-failed', 'failed', undefined], ['turn:processing', undefined, undefined],
    ] as const;
    for (const [key, terminal, status] of cases) {
      add(store, key, 'dispatched', { backend: 'pi', conversation_key: 'group:9', kind: 'user' }, 10, 'ok', 'group:9');
      add(store, key, 'received', { text: '收到的消息', sender: 'a-sender', thread_key: 'group:9', kind: 'user', inputs: ['k'] }, 20);
      if (terminal) add(store, key, terminal, { terminal: true, kind: 'user', thread_key: 'group:9', ...(status ? { status } : {}) }, 100);
      add(store, key, 'reply_sent', { reply: '非终态' }, 150);
    }
    add(store, 'turn:wake', 'dispatched', { backend: 'codex', thread_key: 'owner', kind: 'wake' }, 5);
    add(store, 'turn:empty', 'model_turn', {}, 5, 'ok', '');
    add(store, 'in:k', 'received', { text: '输入键不聚合' }, 5);
    const rows = store.turns();
    expect(rows.map(r => r.key).sort()).toEqual([...cases.map(c => c[0]), 'turn:wake', 'turn:empty'].sort());
    const briefs = store.turnBriefs(rows.map(row => row.key));
    expect(briefs.size).toBe(7);
    for (const { updated, ...row } of rows) {
      expect(briefs.get(row.key)).toMatchObject(row);
      expect(briefs.get(row.key)).not.toHaveProperty('updated');
    }
    for (const [key, terminal, status] of cases) {
      expect(briefs.get(key)).toMatchObject({
        key, scope: 'group:9', ts: 10, duration_ms: 140, status: status ?? (terminal ? 'failed' : 'processing'),
        thread: 'group:9', kind: 'user', sender: 'a-sender', backend: 'pi', text: '收到的消息', reply: '', tools: 0, sends: 0,
      });
    }
    expect(briefs.get('turn:wake')).toMatchObject({ thread: 'owner', kind: 'wake', backend: 'codex', sender: null });
    const empty: TurnBrief = { key: 'turn:empty', scope: '', ts: 5, status: 'processing', thread: null, kind: null,
      sender: null, backend: null, duration_ms: 0, text: '', reply: '', tools: 0, sends: 0 };
    expect(briefs.get('turn:empty')).toEqual(empty);
  });

  it('turnBriefs 回复取最后一条带正文的 send_message，没有发送时取最终回答；工具只数已结束的调用', () => {
    const store = rig();
    const expected = new Map([['turn:sent', '第二条'], ['turn:answer', '没发出的回答'], ['turn:none', '']]);
    for (const [key] of expected) {
      add(store, key, 'received', { text: '输入' }, 1);
      add(store, key, 'tool:web', {}, 3, 'started');
      add(store, key, 'tool:web', {}, 4);
      add(store, key, 'tool:read', {}, 5, 'failed');
      add(store, key, 'toolbox', {}, 6);
      if (key === 'turn:sent') {
        add(store, key, 'send_message', { text: '第一条', target: 'qq:group:7' }, 7);
        add(store, key, 'send_message', { text: '第二条', target: 'qq:group:7' }, 8);
        add(store, key, 'send_message', { target: 'qq:group:7' }, 9);
      }
      if (key !== 'turn:none') add(store, key, 'final_answer', { text: '没发出的回答' }, 10);
    }
    const briefs = store.turnBriefs([...expected.keys()]);
    for (const [key, reply] of expected) expect(briefs.get(key)).toMatchObject({ text: '输入', reply, tools: 2 });
    expect(briefs.get('turn:sent')!.sends).toBe(3);
  });

  it('turnBriefs 采用最后插入的终态', () => {
    const store = rig();
    add(store, 'turn:a', 'reply_sent', { terminal: true, status: 'completed' }, 100);
    add(store, 'turn:a', 'failed', { terminal: true, status: 'lost' }, 10);
    expect(store.turnBriefs(['turn:a']).get('turn:a')).toMatchObject({ status: 'lost' });
  });

  it.each([undefined, null, [], '非对象', 7, true, {}, { backend: 'codex', model: 'test', nested: { enabled: true } }])(
    'turnBriefs 仅包含 dispatched 的对象 settings（%j）', settings => {
      const store = rig();
      add(store, 'turn:a', 'received', { settings: { ignored: true } });
      add(store, 'turn:a', 'dispatched', { settings });
      const brief = store.turnBriefs(['turn:a']).get('turn:a')!;
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) expect(brief.settings).toEqual(settings);
      else expect(brief).not.toHaveProperty('settings');
    },
  );

  it('turnBriefs 去重后取前 300 个，省略缺失、管理键与非回合键，不修改输入或存储', () => {
    const store = rig();
    const ids = Array.from({ length: 301 }, (_, i) => `turn:t-${i}`);
    for (const id of ids) add(store, id, 'received', { text: id });
    add(store, '@context', 'context_usage');
    add(store, 'in:x', 'received');
    const input = Object.freeze([ids[0]!, ids[0]!, ...ids.slice(1)]);
    const before = store.db.prepare('SELECT * FROM events ORDER BY id').all();
    const briefs = store.turnBriefs(input);
    expect(briefs.size).toBe(300);
    expect([...briefs.keys()].sort()).toEqual(ids.slice(0, 300).sort());
    expect(briefs.has(ids[300]!)).toBe(false);
    expect(store.turnBriefs(['missing', ids[0]!, '@context', 'in:x', ids[0]!]).size).toBe(1);
    expect(store.turnBriefs(["' OR 1=1 --", 'missing'])).toEqual(new Map());
    expect(input).toEqual([ids[0], ids[0], ...ids.slice(1)]);
    expect(store.db.prepare('SELECT * FROM events ORDER BY id').all()).toEqual(before);
  });

  it('turnBriefs 固定两次批量查询，键过滤先于 GROUP BY，参数绑定且不逐键查询', () => {
    const store = rig();
    for (let i = 0; i < 20; i++) add(store, `turn:t${i}`, 'received', { text: `消息 ${i}` });
    const prepare = vi.spyOn(store.db, 'prepare');
    const single = vi.spyOn(store, 'events');
    const input = ['turn:t0', 'turn:t0', 'turn:t1', "' OR 1=1 --"];
    expect(store.turnBriefs(input).size).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    const [aggregate, events] = prepare.mock.calls.map(([sql]) => sql);
    expect(aggregate).toMatch(/WHERE key LIKE 'turn:%' AND key IN \(\?,\?,\?\) GROUP BY key/);
    expect(events).toMatch(/WHERE key IN \(\?,\?,\?\) ORDER BY id/);
    expect(aggregate! + events).not.toContain(input[3]);
    expect(single).not.toHaveBeenCalled();
  });

  it('turnBriefs 空输入不查询，空库与 degraded 返回空 Map', () => {
    const store = rig();
    const prepare = vi.spyOn(store.db, 'prepare');
    expect(store.turnBriefs([])).toEqual(new Map());
    expect(prepare).not.toHaveBeenCalled();
    expect(store.turnBriefs(['missing'])).toEqual(new Map());
    prepare.mockRestore();
    add(store, 'turn:a', 'received');
    store.degrade();
    expect(store.turnBriefs(['turn:a'])).toEqual(new Map());
    expect(store.turns()).toEqual([]);
  });
});
