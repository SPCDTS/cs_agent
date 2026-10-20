import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsStore } from '../../src/obs/store.js';
import type { TicketBrief } from '../../src/shared/context-turns.js';

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
function add(store: ObsStore, ticket: string, stage: string, detail: unknown = {},
  ts = 1, status = 'ok', scope = 'group:7') {
  store.append({ ticket, scope, ts, stage, status, duration_ms: 999, detail });
}

describe('票据简报查询', () => {
  it('ticketBriefs 聚合字段与 tickets 一致，保留超时、后端优先级及空值口径', () => {
    const store = rig();
    const cases = [
      ['sent', 'reply_sent', {}], ['timeout', 'failed', { failure: 'timeout' }],
      ['failed', 'failed', {}], ['fallback', 'fallback', {}], ['processing', undefined, {}],
    ] as const;
    for (const [ticket, terminal, extra] of cases) {
      add(store, ticket, 'recovered', { route: 'z-recovered', sender: 'z-sender' }, 30, 'ok', 'group:9');
      add(store, ticket, 'received', { text: '收到的消息', sender: 'a-sender' }, 10);
      add(store, ticket, 'routed', { route: 'a-routed' }, 40);
      add(store, ticket, 'image:submit', { backend: 'z-image' }, 50);
      add(store, ticket, 'backend:codex', { backend: 'codex' }, 60);
      if (terminal) add(store, ticket, terminal, { terminal: true, reply: '终态回复', ...extra }, 100);
      add(store, ticket, 'reply_sent', { reply: '非终态回复' }, 150);
    }
    add(store, 'image-only', 'image:submit', { backend: 'comfy' }, 5);
    add(store, 'empty', 'admitted', {}, 5, 'ok', '');
    const rows = store.tickets();
    const briefs = store.ticketBriefs(rows.map(row => row.ticket));
    expect(briefs.size).toBe(7);
    for (const { updated, ...row } of rows) {
      expect(briefs.get(row.ticket)).toMatchObject(row);
      expect(briefs.get(row.ticket)).not.toHaveProperty('updated');
    }
    for (const [ticket, terminal] of cases) {
      expect(briefs.get(ticket)).toMatchObject({
        ticket, scope: 'group:9', ts: 10, duration_ms: 140, status: ticket,
        route: 'z-recovered', sender: 'z-sender', backend: 'codex',
        text: '收到的消息', reply: terminal ? '终态回复' : '', tools: 0,
      });
    }
    expect(briefs.get('image-only')?.backend).toBe('comfy');
    const empty: TicketBrief = { ticket: 'empty', scope: '', ts: 5, status: 'processing',
      sender: null, route: null, backend: null, duration_ms: 0, text: '', reply: '', tools: 0 };
    expect(briefs.get('empty')).toEqual(empty);
  });

  it('ticketBriefs 回复按 terminal、postprocess、model_turn 三级回退，与 threadTurns 一致', () => {
    const store = rig();
    const expected = new Map([
      ['terminal', '终态回复'], ['postprocess', '最终发送内容'], ['raw', '原始回复'],
      ['reply', '旧版回复'], ['none', ''],
    ]);
    for (const [ticket] of expected) {
      add(store, ticket, 'received', { text: '原文' }, 1);
      add(store, ticket, 'model_turn', { backend: 'codex', thread_key: 'owner' }, 2);
      add(store, ticket, 'tool:web', {}, 3, 'started');
      add(store, ticket, 'tool:web', {}, 4);
      add(store, ticket, 'tool:read', {}, 5, 'failed');
      add(store, ticket, 'toolbox', {}, 6);
      if (ticket !== 'none') {
        add(store, ticket, 'model_turn', { backend: 'codex', thread_key: 'owner', raw_reply: '过时回复' }, 100);
        add(store, ticket, 'model_turn', { backend: 'codex', thread_key: 'owner', reply: '旧版回复',
          ...(ticket === 'reply' ? {} : { raw_reply: '原始回复' }) }, 10);
      }
      if (['terminal', 'postprocess'].includes(ticket)) {
        add(store, ticket, 'postprocess', { sent_text: '过时发送内容' }, 200);
        add(store, ticket, 'postprocess', { sent_text: '最终发送内容' }, 20);
      }
      if (ticket === 'terminal') add(store, ticket, 'reply_sent', { terminal: true, reply: '终态回复' }, 30);
      add(store, ticket, 'model_turn', { raw_reply: '未完成模型输出' }, 300, 'started');
      add(store, ticket, 'postprocess', { sent_text: '未完成后处理' }, 400, 'started');
      add(store, ticket, 'reply_sent', { terminal: false, reply: '非终态' }, 500);
    }
    const briefs = store.ticketBriefs([...expected.keys()]);
    const turns = store.threadTurns('codex', 'owner');
    for (const [ticket, reply] of expected) {
      expect(briefs.get(ticket)).toMatchObject({ text: '原文', reply, tools: 2 });
      const turn = turns.find(value => value.ticket === ticket)!;
      expect(briefs.get(ticket)).toMatchObject({ text: turn.text, reply: turn.reply, tools: turn.tools });
    }
  });

  it('ticketBriefs 采用最后插入的终态，支持 terminal=1，缺失回复回退且空回复不回退', () => {
    const store = rig();
    for (const ticket of ['last', 'missing-reply', 'empty-reply']) {
      add(store, ticket, 'model_turn', { raw_reply: '模型输出' }, 1);
      add(store, ticket, 'postprocess', { sent_text: '发送内容' }, 2);
      add(store, ticket, 'reply_sent', { terminal: true, reply: '较早终态' }, 100);
    }
    add(store, 'last', 'failed', { terminal: 1, reply: '最后终态' }, 10);
    add(store, 'missing-reply', 'fallback', { terminal: true }, 10);
    add(store, 'empty-reply', 'fallback', { terminal: true, reply: '' }, 10);
    const briefs = store.ticketBriefs(['last', 'missing-reply', 'empty-reply']);
    expect(briefs.get('last')).toMatchObject({ status: 'failed', reply: '最后终态' });
    expect(briefs.get('missing-reply')).toMatchObject({ status: 'fallback', reply: '发送内容' });
    expect(briefs.get('empty-reply')?.reply).toBe('');
  });

  it('ticketBriefs 原文取首条 received 或带 text 的 recovered，缺失时为空', () => {
    const store = rig();
    add(store, 'recovered', 'recovered', { route: 'agent' }, 1);
    add(store, 'recovered', 'recovered', { text: '恢复的消息' }, 2);
    add(store, 'recovered', 'received', { text: '较晚消息' }, 3);
    add(store, 'received', 'received', { text: '最初消息' }, 5);
    add(store, 'received', 'recovered', { text: '后续恢复' }, 1);
    add(store, 'empty', 'recovered', { sender: '发送者' });
    expect([...store.ticketBriefs(['recovered', 'received', 'empty']).values()]
      .map(brief => [brief.ticket, brief.text])).toEqual([
      ['empty', ''], ['received', '最初消息'], ['recovered', '恢复的消息'],
    ]);
  });

  it.each([undefined, null, [], '非对象', 7, true, {}, { backend: 'codex', model: 'test', nested: { enabled: true } }])(
    'ticketBriefs 仅包含 admitted 的对象 settings（%j）', settings => {
      const store = rig();
      add(store, 'a', 'received', { settings: { ignored: true } });
      add(store, 'a', 'admitted', { settings });
      const brief = store.ticketBriefs(['a']).get('a')!;
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
        expect(brief.settings).toEqual(settings);
      } else {
        expect(brief).not.toHaveProperty('settings');
      }
    },
  );

  it('ticketBriefs 去重后取前 300 个，省略缺失与管理票据，不修改输入或存储', () => {
    const store = rig();
    const ids = Array.from({ length: 301 }, (_, i) => `ticket-${i}`);
    for (const id of ids) add(store, id, 'received', { text: id });
    add(store, '@context', 'context_usage');
    const input = Object.freeze([ids[0], ids[0], ...ids.slice(1)]);
    const before = store.db.prepare('SELECT * FROM events ORDER BY id').all();
    const briefs = store.ticketBriefs(input);
    expect(briefs.size).toBe(300);
    expect([...briefs.keys()].sort()).toEqual(ids.slice(0, 300).sort());
    expect(briefs.has(ids[300])).toBe(false);
    expect(store.ticketBriefs(['missing', ids[0], '@context', ids[0]]).size).toBe(1);
    expect(store.ticketBriefs(["' OR 1=1 --", 'missing'])).toEqual(new Map());
    expect(store.ticketBriefs(['missing', ...ids]).size).toBe(299);
    expect(input).toEqual([ids[0], ids[0], ...ids.slice(1)]);
    expect(store.db.prepare('SELECT * FROM events ORDER BY id').all()).toEqual(before);
  });

  it('ticketBriefs 固定两次批量查询，票据过滤先于 GROUP BY，参数绑定且不逐票据查询', () => {
    const store = rig();
    for (let i = 0; i < 20; i++) add(store, `t${i}`, 'received', { text: `消息 ${i}` });
    const prepare = vi.spyOn(store.db, 'prepare');
    const single = vi.spyOn(store, 'events');
    const input = ['t0', 't0', 't1', "' OR 1=1 --"];
    expect(store.ticketBriefs(input).size).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    const [aggregate, events] = prepare.mock.calls.map(([sql]) => sql);
    expect(aggregate).toMatch(/WHERE ticket NOT LIKE '@%' AND ticket IN \(\?,\?,\?\) GROUP BY ticket/);
    expect(events).toMatch(/WHERE ticket IN \(\?,\?,\?\) ORDER BY id/);
    expect(aggregate + events).not.toContain(input[3]);
    expect(single).not.toHaveBeenCalled();
    prepare.mockClear();
    expect(store.ticketBriefs(Array.from({ length: 20 }, (_, i) => `t${i}`)).size).toBe(20);
    expect(prepare).toHaveBeenCalledTimes(2);
    prepare.mockClear();
    expect(store.ticketBriefs(['missing'])).toEqual(new Map());
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('ticketBriefs 空输入不查询，空库与 degraded 返回空 Map', () => {
    const store = rig();
    const prepare = vi.spyOn(store.db, 'prepare');
    expect(store.ticketBriefs([])).toEqual(new Map());
    expect(prepare).not.toHaveBeenCalled();
    expect(store.ticketBriefs(['missing'])).toEqual(new Map());
    prepare.mockRestore();
    add(store, 'a', 'received');
    store.degrade();
    expect(store.ticketBriefs(['a'])).toEqual(new Map());
    expect(store.ticketBriefs([])).toEqual(new Map());
  });
});
