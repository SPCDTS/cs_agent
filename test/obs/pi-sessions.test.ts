import { afterEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Message } from '@earendil-works/pi-ai';
import { AssistantEntry, CompactionEntry, ResetEntry, SystemEntry, ToolResultEntry, UserEntry,
  type ContextView, type ConversationId, type EntryId, type EntryRecord } from '@earendil-works/pi-durable';
import { PiSessionAdapter, type PiConversation, type PiSessionSource } from '../../src/obs/sessions/pi-adapter.js';
import type { BlockFrame } from '../../src/obs/sessions/types.js';
import { ObsStore } from '../../src/obs/store.js';
import { registerTemporarySecrets } from '../../src/obs/redact.js';
import { tmp } from '../agent/helpers.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const entry = (id: number, kind: string, model?: Message[], extra: Partial<EntryRecord> = {}): EntryRecord =>
  ({ id: id as EntryId, conversationId: 2 as ConversationId, kind, model, ...extra });
const user = (id: number, text = '用户正文', ts = id * 1000) =>
  entry(id, UserEntry.kind, [{ role: 'user', content: text, timestamp: ts }]);
const assistant = (id: number, text = '助手正文', extra: Partial<AssistantMessage> = {}) =>
  entry(id, AssistantEntry.kind, [{ ...fauxAssistantMessage(text, { timestamp: id * 1000 }), ...extra }]);
const active: PiConversation = { id: '2', label: 'group:7', scope: 'group:7', status: 'active' };

function setup(items: EntryRecord[] = [], conversations: PiConversation[] = [active], live = false) {
  const change = new Set<() => void>();
  const view: ContextView = { head: undefined, entries: [], contributions: [], messages: [] };
  const source: PiSessionSource = {
    listConversations: vi.fn(async () => conversations),
    entries: vi.fn(async (id, cursor, limit = 256) => {
      const matching = items.filter(item => String(item.conversationId) === id && item.id > Number(cursor ?? 0));
      const page = matching.slice(0, limit);
      return { items: page, cursor: page.length ? String(page.at(-1)!.id) : cursor, hasMore: matching.length > page.length };
    }),
    context: vi.fn(async () => view),
    ...(live ? { subscribe: vi.fn(async (_id: string, cb: () => void) => { change.add(cb); return () => { change.delete(cb); }; }) } : {}),
  };
  const adapter = new PiSessionAdapter({ source, pollMs: 10 });
  cleanup.push(() => adapter.close());
  return { adapter, source, items, change, view };
}

describe('Pi 会话适配器', () => {
  it('用户输入分回合，工具按 callId 配对，每个模型请求保留实测用量与模型强度', async () => {
    const tool = fauxToolCall('qq_search', { query: '历史资料' });
    const first: AssistantMessage = { ...fauxAssistantMessage([{ type: 'thinking', thinking: '思考摘要' }, tool]),
      timestamp: 3000, stopReason: 'toolUse', thinkingLevel: 'high', durationMs: 15,
      usage: { input: 10, output: 3, cacheRead: 4, cacheWrite: 2, reasoning: 1, totalTokens: 19,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const s = setup([user(2), entry(3, AssistantEntry.kind, [first]), entry(4, ToolResultEntry.kind, [{
      role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: [{ type: 'text', text: '工具正文' }],
      isError: false, timestamp: 4000, durationMs: 20,
    }]), assistant(5, '完成', { durationMs: 30 }), user(6), assistant(7, '', { stopReason: 'error', errorMessage: '请求失败' })]);
    const turns = await s.adapter.turns('2');
    expect(turns.map(turn => turn.turn)).toEqual(['2', '6']);
    expect(turns[0]).toMatchObject({ tools: 1, requests: 2, status: 'ok', started: 2000, ended: 5030,
      usage: { input: 16, output: 3, cached: 4, reasoning: 1, measured: true } });
    expect(turns[1]).toMatchObject({ status: 'failed' });
    const blocks = await s.adapter.blocks('2', '2');
    expect(blocks.find(block => block.kind === 'tool_call')).toMatchObject({ callId: tool.id,
      text: '{"query":"历史资料"}', meta: { name: 'qq_search', status: 'ok', resultEntry: '4', duration_ms: 20 } });
    expect(blocks.find(block => block.kind === 'tool_result')).toMatchObject({ callId: tool.id, text: '工具正文',
      meta: { paired: true, callEntry: '3' } });
    expect(blocks.find(block => block.kind === 'thinking')).toMatchObject({ text: '思考摘要' });
    expect(blocks.find(block => block.meta?.type === 'model_request')).toMatchObject({ meta: { effort: 'high', duration_ms: 15 } });
    expect((await s.adapter.listSessions())[0]).toMatchObject({ turns: 2, started: 2000, updated: 7000 });
  });

  it('SystemEntry、CompactionEntry 和 ResetEntry 不被其中 user 消息错误拆成新回合', async () => {
    const s = setup([
      entry(1, SystemEntry.kind, [{ role: 'system', content: '', sections: { role: '系统约束' },
        toolsAdded: [{ name: 'lookup', description: '查资料', parameters: { type: 'object', properties: {} } }], timestamp: 1000 }]),
      user(2), assistant(3), entry(4, CompactionEntry.kind, [{ role: 'user', content: '压缩摘要', timestamp: 4000 }],
        { data: { reason: 'manual' }, head: 2 as EntryId }),
      entry(5, ResetEntry.kind, [{ role: 'user', content: '交接说明', timestamp: 5000 }]), user(6),
    ]);
    expect(await s.adapter.turns('2')).toHaveLength(2);
    const blocks = await s.adapter.blocks('2', '2');
    expect(blocks[0]).toMatchObject({ kind: 'system_change' });
    expect(blocks[0].text).toContain('系统约束');
    expect(blocks.find(block => block.kind === 'compaction')).toMatchObject({ text: '压缩摘要', meta: { head: '2', reason: 'manual' } });
    expect(blocks.find(block => block.meta?.reset)).toMatchObject({ kind: 'system_change', text: '交接说明' });
  });

  it('图片与不可用 thinking 只输出占位，不泄露二进制与签名', async () => {
    const s = setup([entry(2, UserEntry.kind, [{ role: 'user', timestamp: 2000,
      content: [{ type: 'text', text: '看图片' }, { type: 'image', data: 'private-image-body', mimeType: 'image/png' }] }]),
      entry(3, AssistantEntry.kind, [fauxAssistantMessage([{ type: 'thinking', thinking: 'private-thinking',
        thinkingSignature: 'private-signature', redacted: true }])])]);
    const blocks = await s.adapter.blocks('2', '2');
    expect(blocks.find(block => block.kind === 'image')).toMatchObject({ meta: { unavailable: true, mimeType: 'image/png' } });
    expect(blocks.find(block => block.kind === 'thinking')).toMatchObject({ meta: { unavailable: true } });
    expect(JSON.stringify(blocks)).not.toContain('private-');
  });

  it('大正文懒加载且所有子范围在完整脱敏之后切分，拒绝跨块与非法范围', async () => {
    const secret = 'test-private-credential';
    cleanup.push(registerTemporarySecrets([secret]));
    const s = setup([user(2), assistant(3, 'a'.repeat(9000) + secret + '尾部')]);
    const block = (await s.adapter.blocks('2', '2')).find(item => item.kind === 'assistant')!;
    expect(block.text).toBeUndefined();
    expect(block.preview).toHaveLength(512);
    const ref = block.ref!;
    const text = await s.adapter.content(ref);
    expect(text).toContain('[已隐藏]');
    expect(text).not.toContain(secret);
    expect(await s.adapter.content({ ...ref, offset: ref.offset + 9002, length: 8 })).not.toContain('test-private');
    for (const invalid of [{ ...ref, offset: -1 }, { ...ref, length: 0 }, { ...ref, length: ref.length + 1 },
      { ...ref, offset: ref.offset + 0.5 }, { ...ref, offset: Number.MAX_SAFE_INTEGER }]) {
      await expect(s.adapter.content(invalid)).rejects.toMatchObject({ status: 400 });
    }
    await expect(s.adapter.turns('../private')).rejects.toMatchObject({ status: 404 });
    await expect(s.adapter.blocks('2', 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('工具 JSON 参数的敏感字段经结构化脱敏', async () => {
    const call = fauxToolCall('request', { cookie: 'cookie-private', password: 'password-private', nested: { credential: 'credential-private' } });
    const s = setup([user(2), entry(3, AssistantEntry.kind, [fauxAssistantMessage(call, { stopReason: 'toolUse' })])]);
    const text = JSON.stringify(await s.adapter.blocks('2', '2'));
    expect(text).toContain('已隐藏');
    expect(text).not.toContain('-private');
  });

  it('枚举包含活动、归档与 scope 筛选，显式 page 才分页', async () => {
    const conversations = Array.from({ length: 52 }, (_, i) => ({ id: String(i + 2), label: `会话 ${i}`,
      status: i === 0 ? 'active' as const : 'archived' as const, ...(i === 0 ? { scope: 'group:7' } : {}), updated: 1000 + i }));
    const s = setup([], conversations);
    await s.adapter.refresh();
    expect(await s.adapter.listSessions()).toHaveLength(52);
    expect(await s.adapter.listSessions({ page: 0 })).toHaveLength(50);
    expect(await s.adapter.listSessions({ page: 1 })).toHaveLength(2);
    expect(await s.adapter.listSessions({ scope: 'group:7', status: 'active' })).toHaveLength(1);
    expect(await s.adapter.listSessions({ status: 'archived', since: 1050 })).toHaveLength(2);
    expect(s.adapter.progress).toEqual({ indexing: false, files: 52, done: 52 });
  });

  it('历史分页完成后只读取尾游标之后新增 entries，context(at) 交给公开源', async () => {
    const items = Array.from({ length: 300 }, (_, i) => user(i + 1));
    const s = setup(items);
    expect(await s.adapter.turns('2')).toHaveLength(300);
    expect(s.source.entries).toHaveBeenCalledWith('2', '256', 256);
    vi.mocked(s.source.entries).mockClear();
    s.items.push(assistant(301));
    await s.adapter.turns('2');
    expect(s.source.entries).toHaveBeenCalledTimes(1);
    expect(s.source.entries).toHaveBeenCalledWith('2', '300', 256);
    expect(await s.adapter.context('2', '256')).toBe(s.view);
    expect(s.source.context).toHaveBeenCalledWith('2', '256');
  });

  it('后台索引未完成时列表立即返回进度，关闭后不再调用 entries', async () => {
    const s = setup([user(2)]);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = s.source.entries;
    s.source.entries = vi.fn(async (id: string, cursor?: string, limit?: number) => { await blocked; return original(id, cursor, limit); });
    await vi.waitFor(() => expect(s.adapter.progress).toMatchObject({ indexing: true, files: 1, done: 0 }));
    expect(await s.adapter.listSessions()).toHaveLength(1);
    expect(s.adapter.progress.indexing).toBe(true);
    release();
    await s.adapter.refresh();
    expect(s.adapter.progress).toEqual({ indexing: false, files: 1, done: 1 });
    await s.adapter.close();
    vi.mocked(s.source.entries).mockClear();
    await expect(s.adapter.turns('2')).rejects.toMatchObject({ status: 503 });
    expect(s.source.entries).not.toHaveBeenCalled();
  });

  it('刷新与详情请求先读取新增条目时，订阅仍收到一次完整块', async () => {
    const s = setup([user(2)], [active], true);
    await s.adapter.turns('2');
    const frames: BlockFrame[] = [];
    const stop = s.adapter.subscribe('2', frame => frames.push(frame));
    await vi.waitFor(() => expect(s.change.size).toBe(1));
    s.items.push(user(3, '并发新增'));
    await Promise.all([s.adapter.refresh(), s.adapter.listSessions(), s.adapter.turns('2')]);
    for (const cb of s.change) cb();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0].block.text).toBe('并发新增');
    stop();
  });

  it('订阅已缓存会话时同步注册，首轮异步读取包含的新块不会在建立监听前丢失', async () => {
    const s = setup([user(2)]);
    await s.adapter.refresh();
    const original = s.source.entries;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    s.source.entries = vi.fn(async (id: string, cursor?: string, limit?: number) => {
      await blocked;
      return original(id, cursor, limit);
    });
    const frames: BlockFrame[] = [];
    const stop = s.adapter.subscribe('2', frame => frames.push(frame));
    s.items.push(user(3, '建立订阅时到达'));
    release();
    await s.adapter.turns('2');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ session: '2', turn: '3', block: { kind: 'user', text: '建立订阅时到达' } });
    stop();
  });

  it.each([false, true])('新增已提交块通过 %s 订阅一次，取消后不再通知', async live => {
    const s = setup([user(2), assistant(3)], [active], live);
    await s.adapter.turns('2');
    const frames: BlockFrame[] = [];
    const stop = s.adapter.subscribe('2', frame => frames.push(frame));
    if (live) await vi.waitFor(() => expect(s.change.size).toBe(1));
    else await new Promise(resolve => setTimeout(resolve, 20));
    s.items.push(user(4, '新增正文'));
    for (const cb of s.change) cb();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ session: '2', turn: '4', block: { kind: 'user', text: '新增正文' } });
    stop();
    s.items.push(assistant(5));
    for (const cb of s.change) cb();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(frames).toHaveLength(1);
    expect(s.change.size).toBe(0);
  });

  it('票据与送达只补充回合头部，不使用 ObsStore 正文', async () => {
    const store = new ObsStore(tmp('cs-pi-sessions-'));
    cleanup.push(() => store.close());
    const s = setup([user(2, '真实用户正文'), assistant(3, '真实助手正文')]);
    const adapter = new PiSessionAdapter({ source: s.source, store });
    cleanup.push(() => adapter.close());
    store.append({ ticket: 'ticket-pi', scope: 'group:7', ts: 1900, stage: 'dispatched', status: 'ok', duration_ms: null,
      detail: { backend: 'pi', conversation: 2, text: '不能读取的观测正文' } });
    store.append({ ticket: 'ticket-pi', scope: 'group:7', ts: 3100, stage: 'reply_sent', status: 'ok', duration_ms: null,
      detail: { terminal: true, reply: '不能读取的观测回复' } });
    expect((await adapter.turns('2'))[0]).toMatchObject({ ticket: 'ticket-pi', delivery: { status: 'sent', scope: 'group:7', duration_ms: 1200 } });
    const text = JSON.stringify(await adapter.blocks('2', '2'));
    expect(text).toContain('真实用户正文');
    expect(text).toContain('真实助手正文');
    expect(text).not.toContain('不能读取');
  });
});
