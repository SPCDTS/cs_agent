import { createServer, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { AssistantEntry, UserEntry, type EntryRecord } from '@earendil-works/pi-durable';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import { createDashboard } from '../../src/obs/http.js';
import { createMemoryRoutes } from '../../src/obs/memory/http.js';
import { MemoryInstrumentation } from '../../src/obs/memory/instrumentation.js';
import { type RecallRecord } from '../../src/context/observer.js';
import type { MemoryDeps } from '../../src/obs/memory/types.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';
import { CodexSessionAdapter } from '../../src/obs/sessions/codex-adapter.js';
import { PiSessionAdapter } from '../../src/obs/sessions/pi-adapter.js';
import { RESPONSE_BYTES } from '../../src/obs/sessions/content.js';
import { ObsStore } from '../../src/obs/store.js';
import { tmp } from '../agent/helpers.js';

const NOW = Date.UTC(2026, 9, 18, 12), SESSION = 'recall-fixture';
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of clean.splice(0).reverse()) await fn(); });
const event = (overrides: Partial<RecallRecord> = {}): RecallRecord => ({ ts: NOW + 3000, backend: 'codex', turn_id: 'codex:t1',
  session: SESSION, task_id: null, tool: 'qq_search', args: { query: '比赛', limit: 2 }, access: 'group:1', scope_hint: 'group:1',
  returned: [{ kind: 'message', id: 'm1' }], returned_count: 1, dropped_count: 2, chars: 55, max_chars: 2500,
  duration_ms: 4, is_error: false, ...overrides });
const record = (type: string, payload: unknown, offset: number) => JSON.stringify({ timestamp: new Date(NOW + offset).toISOString(), type, payload }) + '\n';
function rollout(args: unknown = { limit: 2, query: '比赛' }, name = 'mcp__qq_context__qq_search') {
  return record('session_meta', { id: SESSION }, 0) +
    record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '查一下比赛' }] }, 0) +
    record('response_item', { type: 'mcp_tool_call', call_id: 'recall-call', name, arguments: JSON.stringify(args) }, 3000) +
    record('response_item', { type: 'mcp_tool_call_output', call_id: 'recall-call', output: '比赛' }, 4000) +
    record('event_msg', { type: 'task_complete' }, 6000) +
    record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '下一轮' }] }, 600000) +
    record('event_msg', { type: 'task_complete' }, 606000);
}
async function rig(body = rollout()) {
  const dir = tmp('cs-recalls-'), context = new ContextStore(dir), store = new ObsStore(dir), writer = MemoryInstrumentation.fromDb(store.db);
  clean.push(async () => { context.close(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  context.ingest({ message_id: 'm1', time: NOW / 1000, message_type: 'group', group_id: '1', user_id: '2', self_id: '3',
    nickname: '甲', text: '比赛 token=abc', route_text: '', truncated: false, mentioned_self: false, images: [], segments: [] });
  const codexHome = path.join(dir, 'codex'), sessions = path.join(codexHome, 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, 'rollout-recall-fixture.jsonl'), body, 'utf8');
  const adapter = new CodexSessionAdapter({ store, codexHome, dataDir: dir, pollMs: 60000 });
  clean.push(() => adapter.close()); await adapter.refresh();
  const deps: MemoryDeps = { context, store, sessionAdapters: { codex: adapter },
    retention: { rawDays: 30, summaryDays: 180, hardMaxDays: 90, dailyHour: 3, tz: 'UTC' } };
  const route = createMemoryRoutes(deps);
  const get = async (url: string) => {
    let status = 0, text = '';
    const res = { writeHead(n: number) { status = n; return res; }, end(body: string) { text = body; } };
    await route(new URL(url, 'http://localhost'), res as unknown as ServerResponse);
    return { status, text, body: JSON.parse(text) };
  };
  return { dir, context, store, writer, deps, adapter, get };
}

it('日摘要详情有不可变版本，周折叠后仍可查看已删除日摘要及周替换血缘', async () => {
  const r = await rig();
  const day = r.context.writeSummary({ scope: 'group:1', level: 'day', period_start: NOW / 1000, period_end: NOW / 1000 + 86400,
    text: '日摘要 token=abc', msg_count: 5 });
  expect((await r.get(`/api/memory/summaries/${day.id}`)).body.lineage).toBeNull();
  const version = r.writer.recordSummaryVersion(day, { batch_id: 'day', input_message_ids: ['m1'], model: 'model', provider: 'provider', usage: { input: 1 }, input_chars: 20 });
  const before = await r.get(`/api/memory/summaries/${day.id}`);
  expect(before.body.lineage.versions).toEqual([expect.objectContaining({ summary_id: day.id, period_start: NOW, text: '日摘要 token=[已隐藏]',
    input_message_ids: ['m1'], input_summary_ids: [], usage: { input: 1 }, input_chars: 20 })]);
  const week = r.context.replaceWithWeek({ scope: 'group:1', period_start: day.period_start, period_end: day.period_end + 6 * 86400, days: [day] }, '周摘要');
  const weekVersion = r.writer.recordSummaryVersion(week, { batch_id: 'week', input_summary_ids: [day.id] }, [version!]);
  const old = await r.get(`/api/memory/summaries/${day.id}`), current = await r.get(`/api/memory/summaries/${week.id}`);
  expect(old.status).toBe(200); expect(old.body).toMatchObject({ deleted: true, surviving_raw: 1 });
  expect(old.body.lineage.versions[0].replaced_by).toBe(weekVersion);
  expect(current.body.lineage.replaced[0].id).toBe(version);
  expect(current.body.lineage.versions[0].input_summary_ids).toEqual([day.id]);
});
it('召回列表倒序、同毫秒以 ID 决胜、50 条分页及全部组合过滤', async () => {
  const r = await rig();
  for (let i = 0; i < 52; i++) r.writer.recordRecall(event());
  r.writer.recordRecall(event({ backend: 'pi', session: 'other', turn_id: 'pi:9:9', scope_hint: 'group:2', tool: 'qq_recent', ts: NOW - 5000 }));
  const first = await r.get('/api/memory/recalls?scope=group:1&session=recall-fixture&turn_id=codex:t1&backend=codex&tool=qq_search&since=2026-10-18T12:00:00Z');
  expect(first.status).toBe(200); expect(first.body.items).toHaveLength(50); expect(first.body).toMatchObject({ page: 0, has_more: true });
  expect(first.body.items.map((e: { id: number }) => e.id)).toEqual(Array.from({ length: 50 }, (_, i) => 52 - i));
  const next = await r.get('/api/memory/recalls?scope=group:1&page=1');
  expect(next.body.items.map((e: { id: number }) => e.id)).toEqual([2, 1]); expect(next.body.has_more).toBe(false);
  for (const filter of ['session=other', 'turn_id=pi:9:9', 'backend=pi', 'tool=qq_recent', 'scope=group:2'])
    expect((await r.get(`/api/memory/recalls?${filter}`)).body.items.map((e: { id: number }) => e.id)).toEqual([53]);
  expect((await r.get(`/api/memory/recalls?since=${NOW + 3001}`)).body.items).toEqual([]);
  expect((await r.get('/api/memory/recalls?page=2')).body).toEqual({ items: [], page: 2, has_more: false });
});
it('真实 O1 rollout 的 mcp_tool_call 以 JSON 等价参数确认，按 session/turn 时间窗筛选', async () => {
  const r = await rig(), [turn, next] = await r.adapter.turns(SESSION);
  const id = r.writer.recordRecall(event());
  r.writer.recordRecall(event({ ts: NOW + 603000 }));
  const res = await r.get(`/api/memory/recalls/${id}`);
  expect(res.status).toBe(200);
  expect(res.body.turn_href).toBe(`/agents/codex/sessions/${SESSION}/turns/${turn.turn}`);
  expect(res.body.evidence).toMatchObject({ hits: [{ kind: 'message', id: 'm1', ts: NOW, preview: '比赛 token=[已隐藏]' }],
    tool_returned: { count: 1, chars: 55, dropped: 2 }, in_request: { status: 'confirmed', call_id: 'recall-call', turn: turn.turn } });
  expect(res.body.evidence.in_request.note).toContain('不证明');
  expect((await r.get(`/api/memory/recalls?session=${SESSION}&turn=${turn.turn}`)).body.items.map((e: { id: number }) => e.id)).toEqual([id]);
  expect((await r.get(`/api/memory/recalls?session=${SESSION}&turn=${next.turn}&backend=codex`)).body.items).toHaveLength(1);
  expect((await r.get(`/api/memory/recalls?session=${SESSION}&turn=missing`)).body.items).toEqual([]);
});
it.each(['qq_search', 'mcp__qq_context__search'])('兼容 O1 工具名 %s', async name => {
  const r = await rig(rollout(undefined, name)), id = r.writer.recordRecall(event());
  expect((await r.get(`/api/memory/recalls/${id}`)).body.evidence.in_request.status).toBe('confirmed');
});
it('参数不等价、名称不同、超过 120 秒或缺少 call_id 均不能确认', async () => {
  const r = await rig();
  for (const change of [{ args: { query: '其它', limit: 2 } }, { tool: 'qq_recent' }, { ts: NOW - 117001 }]) {
    const id = r.writer.recordRecall(event(change));
    expect((await r.get(`/api/memory/recalls/${id}`)).body.evidence.in_request.status).toBe('not_found');
  }
  const boundary = r.writer.recordRecall(event({ ts: NOW - 117000 }));
  expect((await r.get(`/api/memory/recalls/${boundary}`)).body.evidence.in_request.status).toBe('confirmed');
  const blocks = await r.adapter.blocks(SESSION, (await r.adapter.turns(SESSION))[0].turn);
  vi.spyOn(r.adapter, 'blocks').mockResolvedValue(blocks.map(b => ({ ...b, callId: undefined })));
  const id = r.writer.recordRecall(event());
  expect((await r.get(`/api/memory/recalls/${id}`)).body.evidence.in_request.status).toBe('not_found');
});
it('缺 session、未知回合和不可读 O1 正文均标 unavailable', async () => {
  const r = await rig();
  for (const change of [{ session: null }, { session: 'unknown' }, { ts: NOW + 9999999 }, { backend: 'other' }]) {
    const id = r.writer.recordRecall(event(change)), res = await r.get(`/api/memory/recalls/${id}`);
    expect(res.body.turn_href).toBeNull(); expect(res.body.evidence.in_request.status).toBe('unavailable');
  }
  vi.spyOn(r.adapter, 'blocks').mockRejectedValue(Error('私有路径'));
  const id = r.writer.recordRecall(event()), res = await r.get(`/api/memory/recalls/${id}`);
  expect(res.body.evidence.in_request.status).toBe('unavailable'); expect(res.text).not.toContain('私有路径');
});
it('命中证据保持返回顺序，摘要与缺失消息来自聊天库，已删除条目明确标记', async () => {
  const r = await rig();
  const s = r.context.writeSummary({ scope: 'group:1', level: 'day', period_start: 1, period_end: 2, text: '摘要 token=abc', msg_count: 3 });
  const id = r.writer.recordRecall(event({ returned: [{ kind: 'summary', id: s.id }, { kind: 'message', id: 'gone' }, { kind: 'message', id: 'm1' }], returned_count: 3 }));
  expect((await r.get(`/api/memory/recalls/${id}`)).body.evidence.hits).toEqual([
    { kind: 'summary', id: s.id, ts: 2000, preview: '摘要 token=[已隐藏]' }, { kind: 'message', id: 'gone', deleted: true },
    { kind: 'message', id: 'm1', ts: NOW, preview: '比赛 token=[已隐藏]' }]);
  r.context.purge(NOW / 1000, 0, 0);
  expect((await r.get(`/api/memory/recalls/${id}`)).body.evidence.hits[0]).toEqual({ kind: 'summary', id: s.id, deleted: true });
});
it('参数与预览先整体脱敏；不同秘密不能因同一占位符而误确认', async () => {
  const secret = 'secret-test-credential'; clean.push(registerTemporarySecrets([secret]));
  const r = await rig(rollout({ query: secret })), id = r.writer.recordRecall(event({ args: { query: secret, token: 'abc' } }));
  const res = await r.get(`/api/memory/recalls/${id}`);
  expect(res.body.args).toEqual({ query: '[已隐藏]', token: '[已隐藏]' });
  expect(res.text).not.toContain(secret); expect(res.text).not.toContain('token=abc');
  expect(res.body.evidence.in_request.status).toBe('not_found');
});
it('O1 lazy 参数正文可匹配，列表不读取块或 O3', async () => {
  const args = { query: '中'.repeat(4000) }, r = await rig(rollout(args));
  const id = r.writer.recordRecall(event({ args })), blocks = vi.spyOn(r.adapter, 'blocks'), content = vi.spyOn(r.adapter, 'content');
  await r.get('/api/memory/recalls'); expect(blocks).not.toHaveBeenCalled();
  expect((await r.get(`/api/memory/recalls/${id}`)).body.evidence.in_request.status).toBe('confirmed');
  expect(content).toHaveBeenCalled();
});
it('pi O1 公开条目可定位回合与工具调用，无需 context 重建', async () => {
  const r = await rig(), tool = fauxToolCall('qq_search', { limit: 2, query: '比赛' });
  const entries = [{ id: 1, conversationId: 2, kind: UserEntry.kind, model: [{ role: 'user', content: '查询', timestamp: NOW }] },
    { id: 2, conversationId: 2, kind: AssistantEntry.kind, model: [fauxAssistantMessage(tool, { timestamp: NOW + 3000, stopReason: 'toolUse' })] },
    { id: 3, conversationId: 2, kind: AssistantEntry.kind, model: [fauxAssistantMessage('完成', { timestamp: NOW + 6000 })] }] as unknown as EntryRecord[];
  const context = vi.fn(async () => ({ head: undefined, entries: [], contributions: [], messages: [] }));
  const pi = new PiSessionAdapter({ source: {
    listConversations: async () => [{ id: '2', label: 'group:1', status: 'active', scope: 'group:1' }],
    entries: async (_id, cursor) => ({ items: entries.filter(e => e.id > Number(cursor ?? 0)), hasMore: false, cursor: '3' }), context,
  } });
  clean.push(() => pi.close()); await pi.refresh(); r.deps.sessionAdapters!.pi = pi;
  const id = r.writer.recordRecall(event({ backend: 'pi', session: '2', task_id: '9' }));
  const res = await r.get(`/api/memory/recalls/${id}`);
  expect(res.body.turn_href).toBe('/agents/pi/sessions/2/turns/1');
  expect(res.body.evidence.in_request).toMatchObject({ status: 'confirmed', turn: '1', call_id: tool.id });
  expect(context).not.toHaveBeenCalled();
});
it('读取 API 不产生新的召回或版本写入', async () => {
  const r = await rig(); const id = r.writer.recordRecall(event());
  const before = r.store.db.prepare('SELECT total_changes() n').get()?.n;
  await r.get('/api/memory/recalls'); await r.get(`/api/memory/recalls/${id}`);
  expect(r.store.db.prepare('SELECT total_changes() n').get()?.n).toBe(before);
});
it('JSON 列表和详情按 UTF-8 编码后的 1 MiB 限制返回 413', async () => {
  const r = await rig(), id = r.writer.recordRecall(event({ args: { query: '中'.repeat(400000) } }));
  for (const url of ['/api/memory/recalls', `/api/memory/recalls/${id}`]) {
    const res = await r.get(url); expect(res.status).toBe(413); expect(Buffer.byteLength(res.text)).toBeLessThan(RESPONSE_BYTES);
  }
});
it.each(['page=-1', 'page=1000001', 'page=01', 'backend=x', 'tool=x', 'scope=', 'session=..',
  'session=a%2Fb', 'turn=1', 'turn_id=', 'since=2026-02-30', 'since=bad', 'x=1', 'page=1&page=2'])('召回参数校验：%s', async query => {
  const r = await rig(); expect((await r.get(`/api/memory/recalls?${query}`)).status).toBe(400);
});
it('非法 ID、未知记录、降级和存储错误有明确状态且不泄露路径', async () => {
  const r = await rig();
  for (const id of ['0', '-1', 'abc']) expect((await r.get(`/api/memory/recalls/${id}`)).status).toBe(400);
  expect((await r.get('/api/memory/recalls/999')).status).toBe(404);
  expect((await r.get('/api/memory/recalls/1?x=1')).status).toBe(400);
  r.store.degrade(); expect((await r.get('/api/memory/recalls')).status).toBe(503);
});
it.each(['/api/memory/recalls', '/api/memory/recalls/1'])('dashboard %s 沿用鉴权和安全头且仅允许 GET', async url => {
  const r = await rig(); r.writer.recordRecall(event()); const token = 'recall-dashboard-test';
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: r.dir, OBS_TOKEN: token }), context: r.context, store: r.store,
    codex: async () => [], pi: async () => ({}), health: () => ({}), queue: () => ({}), sessionAdapters: r.deps.sessionAdapters });
  const server = createServer(dashboard.handle); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, headers = { Cookie: `obs_token=${token}` };
  expect((await fetch(base + url)).status).toBe(401);
  const res = await fetch(base + url, { headers }); expect(res.status).toBe(200);
  expect(res.headers.get('referrer-policy')).toBe('same-origin'); expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect((await fetch(base + url, { method: 'POST', headers })).status).toBe(405);
});
