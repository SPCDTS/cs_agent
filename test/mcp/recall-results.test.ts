import { afterEach, expect, it } from 'vitest';
import { ContextStore } from '../../src/context/store.js';
import { callQQContextTool } from '../../src/mcp/qq-context-server.js';
import { formatMessageFull, formatRecent, formatSearch } from '../../src/context/format.js';
import type { RecallObservation } from '../../src/obs/memory/instrumentation.js';
import { tmp } from '../agent/helpers.js';

let store: ContextStore;
afterEach(() => store?.close());
function rig(maxChars = 190) {
  store = new ContextStore(tmp());
  const access = { kind: 'scope' as const, scope: 'group:1' }, events: RecallObservation[] = [];
  const add = (id: string, text: string, reply?: string) => store.ingest({ message_id: id, time: Math.floor(Date.now() / 1000),
    message_type: 'group', group_id: '1', user_id: '2', self_id: '3', nickname: '甲', text, route_text: text,
    truncated: false, mentioned_self: false, images: [], segments: reply ? [{ type: 'reply', data: { id: reply } }] : [] });
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const result = callQQContextTool({ access, openStore: () => store, maxChars, onRecall: e => events.push(e) }, name, args);
    return { result, text: result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), event: events.at(-1)! };
  };
  return { access, events, add, call };
}
it('recent 保留末尾且按返回顺序记录，原输出逐字不变', () => {
  const r = rig(); for (let i = 0; i < 5; i++) r.add(String(i), '正文'.repeat(60));
  const out = r.call('qq_recent');
  expect(out.text).toBe(formatRecent(store.recent(r.access, { limit: 15 }), 190, { ids: true }));
  expect(out.event).toMatchObject({ tool: 'qq_recent', returned: [{ kind: 'message', id: '4' }], returned_count: 1, dropped_count: 4,
    chars: out.text.length, max_chars: 190, access: 'group:1', scope_hint: 'group:1', is_error: false });
});
it('search 消息摘要混排，按实际进入文本的顺序记录', () => {
  const r = rig(230); r.add('1', '查询消息'); r.add('2', '查询消息');
  const s = store.writeSummary({ scope: 'group:1', level: 'day', period_start: 1, period_end: Math.floor(Date.now() / 1000) + 1,
    text: '查询摘要'.repeat(60), msg_count: 5 });
  const out = r.call('qq_search', { query: '查询' });
  expect(out.text).toBe(formatSearch(store.search(r.access, { query: '查询', days: 30, limit: 10 }), 230, { ids: true }));
  expect(out.event.returned).toEqual([]); expect(out.event.dropped_count).toBe(3);
  const full: RecallObservation[] = [];
  callQQContextTool({ access: r.access, openStore: () => store, maxChars: 400, onRecall: e => full.push(e) }, 'qq_search', { query: '查询' });
  expect(full[0].returned).toEqual([{ kind: 'summary', id: s.id }, { kind: 'message', id: '2' }, { kind: 'message', id: '1' }]);
});
it('重复的机器人行按出现次数匹配，recent 选最后一条，search 选最前一条', () => {
  const r = rig(55);
  for (const ticket of ['a', 'b', 'c']) { store.recordPending('group:1', ticket, Math.floor(Date.now() / 1000));
    store.completeReply(ticket, { action: 'reply', status: '已回复', excerpt: '重复正文' }); }
  expect(r.call('qq_recent').event.returned).toEqual([{ kind: 'message', id: 'self:c' }]);
  expect(r.call('qq_search', { query: '重复' }).event).toMatchObject({ returned: [{ kind: 'message', id: 'self:c' }], dropped_count: 2 });
});
it.each([false, true])('message 大正文与引用裁剪，图片分支=%s', image => {
  const r = rig(10); r.add('base', '引用'); r.add('head', '长'.repeat(1700) + (image ? ' [image:/x.png]' : ''), 'base');
  const hit = store.message(r.access, 'head')!, out = r.call('qq_message', { message_id: 'head' });
  expect(out.text).toBe(formatMessageFull(hit, { ids: true }));
  expect(out.event).toMatchObject({ max_chars: 1500, chars: out.text.length, returned_count: image ? 0 : 1, dropped_count: image ? 2 : 1 });
  expect(out.event.returned).toEqual(image ? [] : [{ kind: 'message', id: 'head' }]);
});
it('message 计入被部分保留的引用，丢弃后续引用', () => {
  const r = rig(); r.add('a', '底部'); r.add('b', '中'.repeat(100), 'a'); r.add('c', '中'.repeat(100), 'b'); r.add('d', '头'.repeat(1380), 'c');
  expect(r.call('qq_message', { message_id: 'd' }).event).toMatchObject({ returned: [{ kind: 'message', id: 'd' }, { kind: 'message', id: 'c' }], dropped_count: 2 });
});
it('空结果和错误也记录一次，回调异常不能改变返回', () => {
  const r = rig(); expect(r.call('qq_recent').event.returned_count).toBe(0);
  expect(r.call('qq_search', { query: '' }).event.is_error).toBe(true);
  expect(r.call('qq_message', { message_id: 'missing' }).event).toMatchObject({ is_error: false, dropped_count: 0 });
  const events: RecallObservation[] = [];
  const deps = { access: undefined, openStore: () => store, onRecall: (e: RecallObservation) => { events.push(e); throw Error('callback'); } };
  expect(callQQContextTool(deps, 'qq_recent', {}).isError).toBe(true);
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ is_error: true, access: '', scope_hint: null });
  store.close(); expect(r.call('qq_recent').event.is_error).toBe(true);
});
