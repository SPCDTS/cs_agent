import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, type Message } from '@earendil-works/pi-ai';
import { AssistantEntry, CompactionEntry, SystemEntry, UserEntry, type ContextView, type ConversationId, type EntryId, type EntryRecord } from '@earendil-works/pi-durable';
import { analyzeContext } from '../../src/obs/context/index.js';
import { readCodexTrace } from '../../src/obs/context/codex-trace.js';
import { CodexSessionAdapter } from '../../src/obs/sessions/codex-adapter.js';
import { PiSessionAdapter } from '../../src/obs/sessions/pi-adapter.js';
import { type PiSessionSource } from '../../src/agent/backends/pi-session-types.js';
import { ObsStore } from '../../src/obs/store.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';
import { contextBody } from '../../src/obs/ui/context-view.js';

const clean: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
async function rig(resume = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-o3-')), home = path.join(dir, 'codex'), sessions = path.join(home, 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, 'a.jsonl');
  await fs.copyFile(new URL('./fixtures/context-compaction.jsonl', import.meta.url), file);
  if (resume) await fs.copyFile(new URL('./fixtures/context-resume-abort.jsonl', import.meta.url), path.join(sessions, 'b.jsonl'));
  const store = new ObsStore(dir), adapter = new CodexSessionAdapter({ store, codexHome: home, dataDir: dir, pollMs: 60000 });
  clean.push(async () => { await adapter.close(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await adapter.refresh();
  return { dir, home, file, adapter, turns: await adapter.turns('context-fixture'),
    analyze: (at?: string, phase: 'before' | 'after' = 'after') => analyzeContext({ codex: adapter }, 'codex', 'context-fixture', { at, phase }) };
}
const json = (file: string, data: unknown) => fs.writeFile(file, JSON.stringify(data), 'utf8');

async function traceBundle(home: string) {
  const dir = path.join(home, 'trace', 'bundle'), payloads = path.join(dir, 'payloads');
  await fs.mkdir(payloads, { recursive: true });
  await json(path.join(dir, 'manifest.json'), { schema_version: 1, root_thread_id: 'context-fixture', rollout_id: 'rollout-id', raw_event_log: 'trace.jsonl' });
  const ref = (name: string) => ({ raw_payload_id: name, kind: { type: 'inference_request' }, path: `payloads/${name}.json` });
  const base = Date.parse('2026-10-18T00:00:08Z');
  const request = { instructions: 'trace 精确系统规则', input: [{ type: 'message', id: 'user-b', role: 'user', content: [{ type: 'input_text', text: '第二问' }] }],
    tools: [{ type: 'function', name: 'lookup', description: '精确工具 schema', parameters: { type: 'object' } }] };
  await json(path.join(payloads, 'request.json'), request);
  await json(path.join(payloads, 'response.json'), { response_id: 'response-1', token_usage: { input_tokens: 222, cached_input_tokens: 55 },
    output_items: [{ type: 'message', role: 'assistant', id: 'answer-b', content: [{ type: 'output_text', text: '第二答' }] }] });
  const events: Array<{ schema_version: number; seq: number; wall_time_unix_ms: number; thread_id: string; codex_turn_id: string;
    payload: { type: string; inference_call_id: string; thread_id?: string; codex_turn_id?: string;
      request_payload?: ReturnType<typeof ref>; response_payload?: ReturnType<typeof ref> } }> = [
    { schema_version: 1, seq: 0, wall_time_unix_ms: base + 500, thread_id: 'context-fixture', codex_turn_id: 'turn-b', payload: {
      type: 'inference_started', inference_call_id: 'inference-1', thread_id: 'context-fixture', codex_turn_id: 'turn-b', request_payload: ref('request') } },
    { schema_version: 1, seq: 1, wall_time_unix_ms: base + 4000, thread_id: 'context-fixture', codex_turn_id: 'turn-b', payload: {
      type: 'inference_completed', inference_call_id: 'inference-1', response_payload: ref('response') } },
  ];
  const writeEvents = () => fs.writeFile(path.join(dir, 'trace.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  await writeEvents();
  return { dir, payloads, request, events, ref, writeEvents };
}

describe('Codex 上下文分析', () => {
  it('分析窗口仍来自 rollout，头部同时显示 contextUsage 的名义值', async () => {
    const r = await rig(), sessions = await r.adapter.listSessions();
    vi.spyOn(r.adapter, 'listSessions').mockResolvedValue(sessions.map(s => ({ ...s, scope: 'owner' })));
    const result = await analyzeContext({ codex: r.adapter }, 'codex', 'context-fixture', {
      contextUsage: { all: () => [{ backend: 'codex', key: 'owner', windowTokens: 500000 }] },
    });
    expect(result.window).toEqual({ tokens: 258400, source: 'codex.rollout.model_context_window', nominalTokens: 500000 });
    const html = contextBody({ backend: 'codex', session: 'context-fixture' }, result);
    expect(html).toContain('名义 500,000 / 有效 258,400');
    expect(html).toContain('来源：codex.rollout.model_context_window');
  });
  it('before 是首次请求输入，after 包含输出，当前态是最后回合之后', async () => {
    const r = await rig(), turn = r.turns[1].turn;
    const before = await r.analyze(turn, 'before'), after = await r.analyze(turn, 'after'), current = await r.analyze();
    expect(before.messages.some(m => m.kind === 'tool_call')).toBe(false);
    expect(after.messages.some(m => m.kind === 'tool_call')).toBe(true);
    expect(before.messages.some(m => m.preview === '第二问')).toBe(true);
    expect(before.messages.some(m => m.preview === '第二答')).toBe(false);
    expect(current.at).toEqual(after.at); expect(current.estimated.total).toBe(after.estimated.total);
    expect(before.measured).toMatchObject({ input: 180, cached: 30, stale: false });
    expect(before.window).toEqual({ tokens: 258400, source: 'codex.rollout.model_context_window' });
    expect(before.unexplained).toBe(180 - before.estimated.total);
    expect(after.categories.reduce((sum, c) => sum + (c.tokens.estimated ?? 0), 0)).toBe(after.estimated.total);
  });
  it('resume 中止的最新回合使用旧 usage 时标 stale，密文不出接口', async () => {
    const r = await rig(true), result = await r.analyze();
    expect(result.measured).toMatchObject({ input: 180, stale: true });
    expect(result.messages.at(-1)).toMatchObject({ preview: 'aborted', provenance: 'reconstructed' });
    expect(JSON.stringify(result)).not.toContain('fixture-encrypted-private-body');
    expect(result.categories.find(c => c.key === 'other')).toMatchObject({ provenance: 'unavailable' });
  });
  it('usage 后压缩使旧实测过期，未解释差额可为负', async () => {
    const r = await rig();
    await fs.appendFile(r.file, JSON.stringify({ timestamp: '2026-10-18T00:00:14Z', type: 'compacted', payload: {
      replacement_history: [{ type: 'message', role: 'user', content: 'Another language model started to solve this problem. ' + '大摘要 '.repeat(400) }] } }) + '\n', 'utf8');
    const result = await r.analyze();
    expect(result.measured?.stale).toBe(true); expect(result.unexplained).toBeLessThan(0);
  });
  it('当前 AGENTS 与自定义段不重复，base instructions 已记录，其余来源诚实', async () => {
    const r = await rig();
    await fs.mkdir(path.join(r.dir, 'prompts'));
    await fs.writeFile(path.join(r.dir, 'prompts', 'codex.md'), '当前自定义规则', 'utf8');
    await fs.writeFile(path.join(r.home, 'AGENTS.md'), '当前受管规则\n\n当前自定义规则', 'utf8');
    const result = await r.analyze();
    const instructions = result.messages.filter(m => m.category === 'instructions');
    expect(instructions.map(m => m.preview)).toEqual(['匿名基础规则', '当前受管规则', '当前自定义规则']);
    expect(instructions.map(m => m.provenance)).toEqual(['recorded', 'reconstructed', 'reconstructed']);
    expect(result.categories.find(c => c.key === 'instructions')).toMatchObject({ provenance: 'reconstructed' });
    expect(result.categories.find(c => c.key === 'tools')?.provenance).toBe('estimated');
    expect(result.notes.join('')).toContain('可能与回合当时不同');
  });
  it('已记录的 AGENTS 注入归入指令并沿用用户块的正文引用', async () => {
    const r = await rig();
    await fs.writeFile(path.join(r.home, 'AGENTS.md'), '当前版本不应重复加入', 'utf8');
    const text = '# AGENTS.md instructions\n历史受管指令';
    await fs.appendFile(r.file, JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n', 'utf8');
    const result = await r.analyze(), instruction = result.messages.find(m => m.preview === text)!;
    expect(instruction).toMatchObject({ category: 'instructions', provenance: 'recorded' });
    expect(await r.adapter.content(instruction.ref!)).toBe(text);
    expect(result.messages.some(m => m.preview === '当前版本不应重复加入')).toBe(false);
  });
  it('所有对应正文引用由适配器签发，可以懒加载同一正文', async () => {
    const r = await rig();
    await fs.appendFile(r.file, JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'developer', content: '已记录的开发者指令' } }) + '\n', 'utf8');
    const result = await r.analyze();
    const answer = result.messages.find(m => m.preview === '第二答')!;
    expect(answer.ref).toBeDefined(); expect(await r.adapter.content(answer.ref!)).toBe('第二答');
    const synthetic = result.messages.find(m => m.category === 'compaction')!;
    expect(synthetic.ref).toBeUndefined();
    const developer = result.messages.find(m => m.preview === '已记录的开发者指令')!;
    expect(await r.adapter.content(developer.ref!)).toBe('已记录的开发者指令');
  });
  it('同文件 size/mtime 变更后刷新缓存，超大行不会崩溃或假装完整', async () => {
    const r = await rig(); await r.analyze();
    await fs.appendFile(r.file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: '新增正文' } }) + '\n' + 'x'.repeat(4 * 1024 * 1024 + 1) + '\n', 'utf8');
    const result = await r.analyze();
    expect(result.messages.some(m => m.preview === '新增正文')).toBe(true);
    expect(result.notes.join('')).toContain('超过 4 MiB');
  });
  it('缓存预览在新的凭据注册后仍整体脱敏', async () => {
    const r = await rig();
    await fs.appendFile(r.file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'late-secret-fixture' } }) + '\n', 'utf8');
    await r.analyze(); clean.push(registerTemporarySecrets(['late-secret-fixture']));
    expect(JSON.stringify(await r.analyze())).not.toContain('late-secret-fixture');
  });
  it('参数错误与未知回合使用约定状态码', async () => {
    const r = await rig();
    await expect(r.analyze('missing')).rejects.toMatchObject({ status: 404 });
    await expect(r.analyze('../bad')).rejects.toMatchObject({ status: 400 });
    await expect(r.analyze('', 'before')).rejects.toMatchObject({ status: 400 });
  });
  it('被回滚回合的基础指令不能覆盖存活上下文基线', async () => {
    const r = await rig();
    await fs.appendFile(r.file, [
      { type: 'turn_context', payload: { turn_id: 'turn-b', base_instructions: { text: '已撤销规则' } } },
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    const result = await r.analyze();
    expect(result.messages.some(m => m.preview === '匿名基础规则')).toBe(true);
    expect(result.messages.some(m => m.preview === '已撤销规则')).toBe(false);
  });
});

describe('Codex 官方 trace', () => {
  it.each([10, 0])('历史含 %s 条可见消息与一条加密 reasoning：主来源和不可用计数独立', async count => {
    const r = await rig(), b = await traceBundle(r.home);
    await json(path.join(b.payloads, 'request.json'), { input: [
      ...Array.from({ length: count }, (_, n) => ({ type: 'message', role: 'user', content: '可见消息 ' + n })),
      { type: 'reasoning', encrypted_content: 'private-reasoning', summary: [] },
    ] });
    const result = await r.analyze(r.turns[1].turn, 'before');
    const category = result.categories.find(c => c.key === 'history')!;
    expect(category).toMatchObject({ items: count + 1, provenance: count ? 'recorded' : 'unavailable', unavailable_items: 1 });
    expect(category.tokens.estimated).toBe(count ? result.estimated.total : undefined);
    expect(category.note).toContain('估算与百分比仅覆盖可见部分');
    const html = contextBody({ backend: 'codex', session: 'context-fixture' }, result);
    expect(html).not.toContain('private-reasoning');
    if (count) expect(html).toContain('已记录</span> <span class="s-warn">部分不可用 1 条');
    else expect(html).not.toContain('部分不可用');
  });
  it('不存在时标不可用；存在时优先精确请求、工具及同请求实测', async () => {
    const r = await rig(), turn = r.turns[1].turn;
    expect((await r.analyze(turn, 'before')).notes.join('')).toContain('trace 不可用');
    await traceBundle(r.home);
    const result = await r.analyze(turn, 'before');
    expect(result.measured).toMatchObject({ input: 222, cached: 55, source: 'codex.trace.token_usage' });
    expect(result.messages.map(m => m.category)).toEqual(['instructions', 'tools', 'history']);
    expect(result.messages.every(m => m.provenance === 'recorded')).toBe(true);
    expect(result.messages[0].preview).toBe('trace 精确系统规则');
    expect((await r.analyze(turn, 'after')).messages.at(-1)?.preview).toBe('第二答');
  });
  it('未知 schema、缺失 payload 与跨目录引用容错回退', async () => {
    const r = await rig(), bundle = await traceBundle(r.home), turn = r.turns[1].turn;
    bundle.events[0].schema_version = 999; await bundle.writeEvents();
    expect((await r.analyze(turn, 'before')).measured?.source).toContain('token_count');
    bundle.events[0].schema_version = 1; bundle.events[0].payload.request_payload!.path = '../private.json'; await bundle.writeEvents();
    expect(await readCodexTrace(r.home, 'context-fixture', 'turn-b', 'before')).toBeUndefined();
    bundle.events[0].payload.request_payload!.path = 'payloads/missing.json'; await bundle.writeEvents();
    expect(await readCodexTrace(r.home, 'context-fixture', 'turn-b', 'before')).toBeUndefined();
  });
  it('精确筛选线程与回合，不能把其它线程的 trace 认作当前窗口', async () => {
    const r = await rig(); await traceBundle(r.home);
    expect(await readCodexTrace(r.home, 'other-thread', 'turn-b', 'before')).toBeUndefined();
    expect(await readCodexTrace(r.home, 'context-fixture', 'turn-c', 'before')).toBeUndefined();
  });
  it('previous_response_id 增量请求回溯已有输入输出，未知链标 unavailable', async () => {
    const r = await rig(), b = await traceBundle(r.home);
    await json(path.join(b.payloads, 'next.json'), { previous_response_id: 'response-1', input: [{ type: 'message', role: 'user', content: '继续' }] });
    await json(path.join(b.payloads, 'next-response.json'), { response_id: 'response-2', token_usage: { input_tokens: 333 }, output_items: [] });
    b.events.push({ ...b.events[0], seq: 2, wall_time_unix_ms: b.events[0].wall_time_unix_ms + 5000,
      payload: { ...b.events[0].payload, inference_call_id: 'inference-2', request_payload: b.ref('next') } },
    { ...b.events[1], seq: 3, wall_time_unix_ms: b.events[1].wall_time_unix_ms + 5000,
      payload: { ...b.events[1].payload, inference_call_id: 'inference-2', response_payload: b.ref('next-response') } });
    await b.writeEvents();
    const trace = await readCodexTrace(r.home, 'context-fixture', 'turn-b', 'after');
    expect(trace?.messages.map(m => m.preview)).toEqual(['第二问', '第二答', '继续']);
    expect(trace?.measured?.input).toBe(333);
    await json(path.join(b.payloads, 'next.json'), { previous_response_id: 'missing', input: [] });
    expect(await readCodexTrace(r.home, 'context-fixture', 'turn-b', 'after')).toBeUndefined();
  });
  it('trace 请求后发生压缩时 after 使用重建窗口并标旧 usage 过期', async () => {
    const r = await rig(); await traceBundle(r.home);
    await fs.appendFile(r.file, JSON.stringify({ timestamp: '2026-10-18T00:00:20Z', type: 'compacted', payload: {
      replacement_history: [{ type: 'message', role: 'user', content: '新的压缩窗口' }] } }) + '\n', 'utf8');
    const result = await r.analyze();
    expect(result.messages.some(m => m.preview === '新的压缩窗口')).toBe(true);
    expect(result.measured).toMatchObject({ source: 'codex.token_count.last_token_usage', stale: true });
  });
  it('回滚后的当前窗口不能由已撤销回合的 trace 复活，历史 before 仍可读取', async () => {
    const r = await rig(); await traceBundle(r.home);
    await fs.appendFile(r.file, JSON.stringify({ timestamp: '2026-10-18T00:00:20Z', type: 'event_msg',
      payload: { type: 'thread_rolled_back', num_turns: 1 } }) + '\n', 'utf8');
    const result = await r.analyze();
    expect(result.messages.some(m => m.preview === '第一问')).toBe(true);
    expect(result.messages.some(m => m.preview === '第二答' || m.preview === 'trace 精确系统规则')).toBe(false);
    expect(result.measured).toMatchObject({ source: 'codex.token_count.last_token_usage', stale: true });
    expect((await r.analyze(r.turns[1].turn, 'before')).measured?.source).toBe('codex.trace.token_usage');
  });
});

const entry = (id: number, kind: string, model: Message[]): EntryRecord => ({ id: id as EntryId, conversationId: 1 as ConversationId, kind, model });
async function piRig(change?: (items: EntryRecord[]) => void) {
  const tool = { name: 'lookup', description: '匿名工具', parameters: { type: 'object' as const, properties: {} } };
  const items = [entry(1, SystemEntry.kind, [{ role: 'system', content: '系统规则', toolsAdded: [tool], timestamp: 1000 }]),
    entry(2, UserEntry.kind, [{ role: 'user', content: '第一问', timestamp: 2000 }]),
    entry(3, AssistantEntry.kind, [{ ...fauxAssistantMessage('第一答', { timestamp: 3000 }), usage: { input: 20, output: 3, cacheRead: 5, cacheWrite: 2, totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }]),
    entry(4, UserEntry.kind, [{ role: 'user', content: '第二问', timestamp: 4000 }]),
    entry(5, CompactionEntry.kind, [{ role: 'user', content: '压缩摘要', timestamp: 5000 }])];
  change?.(items);
  const source: PiSessionSource = { listConversations: async () => [{ id: '1', label: 'owner', scope: 'owner', status: 'active' }],
    entries: async (_id, cursor) => ({ items: items.filter(e => e.id > Number(cursor ?? 0)), hasMore: false, cursor: '5' }),
    context: vi.fn(async (_id, at): Promise<ContextView> => {
      const active = items.filter(e => e.id <= Number(at ?? 5));
      return { head: undefined, entries: active, contributions: active.map(e => e.model!), messages: active.flatMap(e => e.model!) };
    }) };
  const adapter = new PiSessionAdapter({ source, pollMs: 60000 }); clean.push(() => adapter.close()); await adapter.refresh();
  return { adapter, source, analyze: (at?: string, phase: 'before' | 'after' = 'after') => analyzeContext({ pi: adapter }, 'pi', '1', { at, phase, windowTokens: { pi: 12345 } }) };
}
describe('Pi 公开 ContextView 分析', () => {
  it('组合用户文本和含思考的助手消息不借用单块引用', async () => {
    const r = await piRig(items => {
      const user = items[1].model![0], assistant = items[2].model![0];
      user.content = [{ type: 'text', text: '首段 '.repeat(1500) }, { type: 'text', text: '尾段 '.repeat(1500) }];
      if (assistant.role === 'assistant') assistant.content = [{ type: 'thinking', thinking: '公开摘要' }, { type: 'text', text: '最终回答' }];
    });
    const result = await r.analyze('2', 'after');
    expect(result.messages.filter(m => m.kind === 'user' || m.kind === 'assistant').every(m => !m.ref)).toBe(true);
  });
  it('适配器拒绝引用时不绕过其校验，也不重复读取每个回合的 blocks', async () => {
    const r = await piRig(items => { items[1].model![0].content = '长正文 '.repeat(1000); });
    vi.spyOn(r.adapter, 'contextRef').mockResolvedValue(undefined);
    const blocks = vi.spyOn(r.adapter, 'blocks');
    const result = await r.analyze('2', 'before');
    expect(result.messages.find(m => m.kind === 'user')?.ref).toBeUndefined();
    expect(blocks).not.toHaveBeenCalled();
  });
  it('before/after 定位到正确 entry；after 不混入下一轮，默认读取当前 ContextView', async () => {
    const r = await piRig();
    const before = await r.analyze('2', 'before'), after = await r.analyze('2', 'after');
    expect(r.source.context).toHaveBeenNthCalledWith(1, '1', '2');
    expect(r.source.context).toHaveBeenNthCalledWith(2, '1', '3');
    expect(before.messages.map(m => m.kind)).toEqual(['system', 'tool_definition', 'user']);
    expect(after.messages.at(-1)?.preview).toContain('第一答');
    expect(after.measured).toMatchObject({ input: 27, cached: 5, stale: false });
    await r.analyze(); expect(r.source.context).toHaveBeenLastCalledWith('1', undefined);
  });
  it('系统/工具 API、compaction 分类、pi-ai 对照与窗口配置保持契约', async () => {
    const r = await piRig(), result = await r.analyze();
    expect(result.categories.find(c => c.key === 'compaction')).toMatchObject({ items: 1, provenance: 'recorded' });
    expect(result.categories.find(c => c.key === 'tools')).toMatchObject({ items: 1, provenance: 'recorded' });
    expect(result.measured?.stale).toBe(true);
    expect(result.notes.join('')).toContain('pi-ai estimateMessageTokens');
    expect(result.estimated.tokenizer).toBe('o200k_base'); expect(result.window.tokens).toBe(12345);
    const user = result.messages.find(m => m.preview === '第一问')!;
    expect(await r.adapter.content(user.ref!)).toBe('第一问');
  });
});
