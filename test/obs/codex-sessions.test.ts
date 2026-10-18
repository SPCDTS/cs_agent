import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexSessionAdapter, MAX_ROLLOUT_LINE_BYTES } from '../../src/obs/sessions/codex-adapter.js';
import { ObsStore } from '../../src/obs/store.js';
import { registerTemporarySecrets } from '../../src/obs/redact.js';
import type { BlockFrame, ContentRef } from '../../src/obs/sessions/types.js';

const fixture = fileURLToPath(new URL('./fixtures/codex-rollout-anonymized.jsonl', import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const ts = '2026-10-17T14:37:00.000Z';
const record = (type: string, payload: unknown, timestamp = ts) => JSON.stringify({ timestamp, type, payload }) + '\n';
const user = (text = '继续检查') => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text = '已完成') => record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const done = () => record('event_msg', { type: 'task_complete' });

async function rig(initial?: string, map: unknown = { shared: { thread_id: 'thread-fixture' } }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sessions-'));
  const codexHome = path.join(dir, 'codex');
  const directory = path.join(codexHome, 'sessions', '2026', '10', '17');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'rollout-test-thread-fixture.jsonl');
  await fs.writeFile(file, initial ?? await fs.readFile(fixture, 'utf8'), 'utf8');
  await fs.writeFile(path.join(dir, 'codex-threads.json'), JSON.stringify(map), 'utf8');
  const store = new ObsStore(dir);
  let adapter = new CodexSessionAdapter({ store, codexHome, dataDir: dir, pollMs: 60_000 });
  await adapter.refresh();
  cleanup.push(async () => { await adapter.close(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, codexHome, file, store, get adapter() { return adapter; }, async restart() {
    await adapter.close(); adapter = new CodexSessionAdapter({ store, codexHome, dataDir: dir, pollMs: 60_000 });
    await adapter.refresh(); return adapter;
  } };
}

describe('Codex 会话正文适配器', () => {
  it('真实结构匿名样本：用户条目分轮、过滤重复事件、模型强度、工具配对及用量去重', async () => {
    const r = await rig();
    expect(await r.adapter.listSessions()).toEqual([expect.objectContaining({ backend: 'codex', id: 'thread-fixture', label: 'shared', scope: 'shared', status: 'active', turns: 1 })]);
    const [turn] = await r.adapter.turns('thread-fixture');
    expect(turn).toMatchObject({ tools: 1, requests: 1, status: 'ok', usage: { input: 1000, output: 50, cached: 800, reasoning: 20, measured: true } });
    const blocks = await r.adapter.blocks('thread-fixture', turn!.turn);
    expect(blocks.slice(0, 3).map(b => [b.kind, b.meta?.type])).toEqual([['system_change', 'agents_md'], ['system_change', 'user_instructions'], ['system_change', 'environment_context']]);
    expect(blocks.splice(0, 3)).toHaveLength(3);
    expect(blocks.map(b => b.kind)).toEqual(['user', 'event', 'thinking', 'tool_call', 'tool_result', 'assistant', 'event', 'event']);
    expect(blocks[1]?.meta).toMatchObject({ type: 'model_request', model: 'gpt-fixture', effort: 'high' });
    expect(blocks[2]).toMatchObject({ text: '先读取目录结构', meta: { unavailable: true } });
    expect(JSON.stringify(blocks)).not.toContain('[匿名加密占位]');
    expect(blocks[3]).toMatchObject({ callId: 'fixture-call-1', meta: { name: 'exec_command', paired: true, duration_ms: 2000, status: 'ok' } });
    expect(blocks[4]).toMatchObject({ callId: 'fixture-call-1', text: 'obs\nagent', meta: { paired: true, duration_ms: 2000, name: 'exec_command' } });
  });

  it('回合间指令持久化为下一轮 prelude，回合内指令与标记不分轮', async () => {
    const r = await rig();
    const first = (await r.adapter.turns('thread-fixture'))[0]!;
    const before = await r.adapter.blocks('thread-fixture', first.turn);
    const firstEnd = (await fs.stat(r.file)).size;
    await fs.appendFile(r.file, user('<environment_context>下一轮环境</environment_context>') + user('<turn_aborted>上一轮已停止</turn_aborted>'), 'utf8');
    await r.adapter.refresh();
    expect((await r.adapter.listSessions())[0]?.turns).toBe(1);
    expect(await r.adapter.blocks('thread-fixture', first.turn)).toEqual(before);
    const stored = r.store.db.prepare('SELECT state_json FROM session_index').get() as { state_json: string };
    expect(JSON.parse(stored.state_json).turns[0].endOffset).toBe(firstEnd);
    await r.restart();
    expect(r.adapter.diagnostics.scannedBytes).toBe(0);
    await fs.appendFile(r.file, user('真正的下一轮输入') + user('<user_instructions>回合内指令</user_instructions>') +
      user('# AGENTS.md instructions for /workspace\n回合内仓库指令') + user('<turn_aborted>回合内标记</turn_aborted>'), 'utf8');
    await r.adapter.refresh();
    const turns = await r.adapter.turns('thread-fixture');
    expect(turns).toHaveLength(2);
    expect((await r.adapter.listSessions())[0]?.turns).toBe(2);
    expect(turns[1]?.preview).toBe('真正的下一轮输入');
    const blocks = await r.adapter.blocks('thread-fixture', turns[1]!.turn);
    expect(blocks.map(b => b.kind)).toEqual(['system_change', 'system_change', 'user', 'system_change', 'system_change', 'system_change']);
    expect(blocks.map(b => b.meta?.type)).toEqual(['environment_context', 'marker', undefined, 'user_instructions', 'agents_md', 'marker']);
  });

  it('前缀仅在开头生效，正文中引用指令标记仍然是用户输入', async () => {
    const r = await rig(record('session_meta', { id: 'thread-fixture' }) + user('解释 <environment_context> 和 <turn_aborted> 的用途'));
    expect((await r.adapter.turns('thread-fixture'))[0]?.preview).toContain('解释');
    expect((await r.adapter.listSessions())[0]?.turns).toBe(1);
  });

  it('旧版持久化索引整体重建，不复用错误回合与正文偏移', async () => {
    const r = await rig();
    await r.adapter.close();
    const stored = r.store.db.prepare('SELECT state_json FROM session_index').get() as { state_json: string };
    const state = JSON.parse(stored.state_json);
    state.version = 1;
    state.turns.push({ ...state.turns[0], index: { ...state.turns[0].index, preview: '旧版伪回合' } });
    r.store.db.prepare('UPDATE session_index SET state_json=?').run(JSON.stringify(state));
    await r.restart();
    expect(r.adapter.diagnostics.fullScans).toBe(1);
    expect((await r.adapter.listSessions())[0]?.turns).toBe(1);
    expect(await r.adapter.turns('thread-fixture')).toHaveLength(1);
    const fresh = r.store.db.prepare('SELECT state_json FROM session_index').get() as { state_json: string };
    expect(JSON.parse(fresh.state_json).version).toBe(2);
    expect(fresh.state_json).not.toContain('旧版伪回合');
  });

  it('function/MCP 调用配对、图片占位、system_change、compaction 与失败状态', async () => {
    const body = await fs.readFile(fixture, 'utf8') + user() +
      record('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '新提示' }] }) +
      record('response_item', { type: 'function_call', call_id: 'f1', name: 'mcp__qq__recent', arguments: '{"scope":"group:fixture"}' }) +
      record('response_item', { type: 'function_call_output', call_id: 'f1', output: '工具结果' }) +
      record('response_item', { type: 'mcp_tool_call', call_id: 'm1', server: 'fixture', name: 'search', arguments: { q: '测试' }, result: '命中' }) +
      record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'image', image_url: 'data:image/png;base64,REDACTED' }] }) +
      record('compacted', { message: '压缩摘要', replacement_history: [{ role: 'user', content: '旧输入' }] }) +
      record('event_msg', { type: 'turn_aborted', message: '已取消' });
    const r = await rig(body);
    const turns = await r.adapter.turns('thread-fixture');
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ tools: 2, status: 'failed' });
    const blocks = await r.adapter.blocks('thread-fixture', turns[1]!.turn);
    expect(blocks.find(b => b.callId === 'f1')?.meta).toMatchObject({ paired: true, server: 'qq' });
    expect(blocks.filter(b => b.callId === 'm1').map(b => b.kind)).toEqual(['tool_call', 'tool_result']);
    expect(blocks.find(b => b.kind === 'system_change')?.text).toBe('新提示');
    expect(blocks.find(b => b.kind === 'compaction')).toMatchObject({ text: '压缩摘要', meta: { replacement_history: true } });
    expect(blocks.find(b => b.kind === 'image')?.meta?.source).toBe('[内嵌图片]');
  });

  it('token_count 多请求累计实测 usage，重复累计值不会重复计数', async () => {
    const usage = (input: number, output: number, total: number) => record('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: input, output_tokens: output }, total_token_usage: { input_tokens: total, output_tokens: total } } });
    const r = await rig(await fs.readFile(fixture, 'utf8') + user() + usage(20, 3, 1020) + usage(20, 3, 1020) + usage(30, 4, 1050) + done());
    expect((await r.adapter.turns('thread-fixture'))[1]).toMatchObject({ requests: 2, usage: { input: 50, output: 7, measured: true } });
    const turn = (await r.adapter.turns('thread-fixture'))[1]!;
    const requests = (await r.adapter.blocks('thread-fixture', turn.turn)).filter(block => block.meta?.type === 'model_request');
    expect(requests).toHaveLength(2);
    expect(requests.map(block => block.meta?.usage)).toEqual([expect.objectContaining({ input: 20, output: 3, measured: true }), expect.objectContaining({ input: 30, output: 4, measured: true })]);
    expect(requests[1]?.meta).toMatchObject({ model: 'gpt-fixture', effort: 'high', request: 2 });
  });

  it('归档映射、未映射 thread id、scope/status/since 和显式 page 筛选', async () => {
    const r = await rig(undefined, {});
    expect(await r.adapter.listSessions()).toEqual([expect.objectContaining({ status: 'archived', label: 'thread-fixture' })]);
    await fs.writeFile(path.join(r.dir, 'codex-threads-archive.jsonl'), JSON.stringify({ key: 'owner', thread_id: 'thread-fixture', archived_at: ts }) + '\n', 'utf8');
    await r.adapter.refresh();
    expect(await r.adapter.listSessions({ status: 'archived', scope: 'owner' })).toHaveLength(1);
    expect(await r.adapter.listSessions({ status: 'active' })).toHaveLength(0);
    expect(await r.adapter.listSessions({ scope: 'shared' })).toHaveLength(0);
    expect(await r.adapter.listSessions({ since: Date.parse(ts) })).toHaveLength(0);
    expect(await r.adapter.listSessions({ page: 1 })).toHaveLength(0);
    await expect(Promise.resolve().then(() => r.adapter.subscribe('thread-fixture', () => {}))).rejects.toMatchObject({ status: 400 });
  });

  it('追加仅扫描新增字节，原偏移和 turn id 保持稳定；重启后从持久化索引恢复', async () => {
    const r = await rig();
    const original = await r.adapter.turns('thread-fixture');
    const firstBytes = r.adapter.diagnostics.scannedBytes;
    await r.adapter.refresh();
    expect(r.adapter.diagnostics.scannedBytes).toBe(firstBytes);
    const appended = user() + assistant() + done();
    await fs.appendFile(r.file, appended, 'utf8');
    await r.adapter.refresh();
    expect(r.adapter.diagnostics.scannedBytes - firstBytes).toBe(Buffer.byteLength(appended));
    expect(r.adapter.diagnostics).toMatchObject({ fullScans: 1, incrementalScans: 1 });
    expect((await r.adapter.turns('thread-fixture'))[0]?.turn).toBe(original[0]?.turn);
    await r.restart();
    expect(r.adapter.diagnostics.scannedBytes).toBe(0);
    expect(await r.adapter.turns('thread-fixture')).toHaveLength(2);
    const index = r.store.db.prepare('SELECT last_offset,turns_json,backend,session_id FROM session_index').get() as { last_offset: number; turns_json: string; backend: string; session_id: string };
    expect(index).toMatchObject({ backend: 'codex', session_id: 'thread-fixture', last_offset: (await fs.stat(r.file)).size });
    expect(JSON.parse(index.turns_json)[0]).toMatchObject({ startOffset: expect.any(Number), endOffset: expect.any(Number) });
  });

  it('截短及同大小重写触发全量重建，清除失效回合', async () => {
    const r = await rig();
    await fs.appendFile(r.file, user() + assistant(), 'utf8'); await r.adapter.refresh();
    expect(await r.adapter.turns('thread-fixture')).toHaveLength(2);
    const shorter = record('session_meta', { id: 'thread-fixture' }) + user('旧字');
    await fs.writeFile(r.file, shorter, 'utf8'); await r.adapter.refresh();
    expect(await r.adapter.turns('thread-fixture')).toHaveLength(1);
    await fs.writeFile(r.file, shorter.replace('旧字', '新字'), 'utf8');
    const future = new Date(Date.now() + 1000); await fs.utimes(r.file, future, future);
    await r.adapter.refresh();
    expect((await r.adapter.turns('thread-fixture'))[0]?.preview).toBe('新字');
    expect(r.adapter.diagnostics.fullScans).toBe(3);
  });

  it('增长文件若原边界已变化也全量重建', async () => {
    const r = await rig();
    const previous = await fs.readFile(r.file, 'utf8');
    await fs.writeFile(r.file, previous.replace('请检查测试目录', '请审查测试目录') + user(), 'utf8');
    await r.adapter.refresh();
    expect(r.adapter.diagnostics).toMatchObject({ fullScans: 2, incrementalScans: 0 });
    expect((await r.adapter.turns('thread-fixture'))[0]?.preview).toContain('请审查');
  });

  it('半行追加与损坏行可恢复；4 MiB 以上单行变成事件而不解析', async () => {
    const r = await rig(await fs.readFile(fixture, 'utf8') + user());
    const partial = assistant('尚未写完');
    await fs.appendFile(r.file, partial.slice(0, 35), 'utf8'); await r.adapter.refresh();
    const before = (await r.adapter.turns('thread-fixture'))[1]!;
    expect((await r.adapter.blocks('thread-fixture', before.turn)).some(b => b.text === '尚未写完')).toBe(false);
    await fs.appendFile(r.file, partial.slice(35) + '{bad json}\n' + 'x'.repeat(MAX_ROLLOUT_LINE_BYTES + 5) + '\n' + assistant('随后恢复'), 'utf8');
    await r.adapter.refresh();
    const blocks = await r.adapter.blocks('thread-fixture', before.turn);
    expect(blocks.map(b => b.text)).toEqual(expect.arrayContaining(['尚未写完', '行过大', '随后恢复']));
    expect(blocks.find(b => b.text === '行过大')?.meta?.bytes).toBe(MAX_ROLLOUT_LINE_BYTES + 5);
  });

  it('大正文仅预览与 ref；整块脱敏后再按 UTF-8 范围读取，拒绝跨块及任意文件路径', async () => {
    const secret = 'private-secret-across-the-request-range';
    const dispose = registerTemporarySecrets([secret]); cleanup.push(async () => dispose());
    const large = '首'.repeat(3000) + secret + '尾'.repeat(1000);
    const r = await rig(await fs.readFile(fixture, 'utf8') + user() + assistant(large));
    const turn = (await r.adapter.turns('thread-fixture'))[1]!;
    const blocks = await r.adapter.blocks('thread-fixture', turn.turn);
    const largeBlock = blocks.find(b => b.kind === 'assistant')!;
    expect(largeBlock.text).toBeUndefined(); expect(largeBlock.preview).toBeTruthy(); expect(largeBlock.ref).toBeTruthy();
    const ref = largeBlock.ref!;
    const text = await r.adapter.content(ref);
    expect(text).toContain('[已隐藏]'); expect(text).not.toContain(secret);
    expect(ref.length).toBe(Buffer.byteLength(text));
    const partial = await r.adapter.content({ ...ref, offset: ref.offset + 9001, length: 8 });
    expect(partial).not.toContain('private'); expect(partial).not.toContain('\uFFFD');
    await expect(r.adapter.content({ ...ref, length: ref.length + 1 })).rejects.toMatchObject({ status: 400 });
    await expect(r.adapter.content({ ...ref, offset: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(r.adapter.content({ ...ref, length: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(r.adapter.content({ ...ref, session: '../../.env' })).rejects.toMatchObject({ status: 404 });
    const raw = r.store.db.prepare('SELECT state_json FROM session_index').get() as { state_json: string };
    expect(raw.state_json).not.toContain(secret); expect(raw.state_json).not.toContain('首'.repeat(3000));
  });

  it('同 session 的多个 rollout 合并，content 虚拟区间互不冲突', async () => {
    const r = await rig(await fs.readFile(fixture, 'utf8') + user() + assistant('甲'.repeat(3000)));
    const other = path.join(path.dirname(r.file), 'rollout-resume-thread-fixture.jsonl');
    await fs.writeFile(other, record('session_meta', { id: 'thread-fixture' }) + user('恢复后的用户输入') + assistant('乙'.repeat(3000)), 'utf8');
    await r.adapter.refresh();
    expect(await r.adapter.listSessions()).toHaveLength(1);
    expect((await r.adapter.listSessions())[0]?.turns).toBe(3);
    const refs: ContentRef[] = [];
    for (const turn of await r.adapter.turns('thread-fixture')) for (const block of await r.adapter.blocks('thread-fixture', turn.turn)) if (block.ref) refs.push(block.ref);
    expect(refs).toHaveLength(2); expect(refs[0]?.offset).not.toBe(refs[1]?.offset);
    expect((await Promise.all(refs.map(ref => r.adapter.content(ref)))).sort()).toEqual(['乙'.repeat(3000), '甲'.repeat(3000)].sort());
  });

  it('首条 user 之前的 system/compaction/超大行保留在首轮前置块', async () => {
    const r = await rig(record('session_meta', { id: 'thread-fixture' }) +
      record('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '前置提示' }] }) +
      record('compacted', { message: '恢复检查点摘要' }) + 'x'.repeat(MAX_ROLLOUT_LINE_BYTES + 1) + '\n' + user('首轮输入'));
    const turn = (await r.adapter.turns('thread-fixture'))[0]!;
    expect(turn.preview).toBe('首轮输入');
    expect((await r.adapter.blocks('thread-fixture', turn.turn)).map(b => b.kind)).toEqual(['system_change', 'compaction', 'event', 'user']);
  });

  it('JSON 工具参数先按字段脱敏，call_id 的特殊对象键也可以配对', async () => {
    const r = await rig(await fs.readFile(fixture, 'utf8') + user() +
      record('response_item', { type: 'function_call', call_id: '__proto__', name: 'fixture', arguments: JSON.stringify({ credential: { value: 'nested private value' }, items: [{ password: 'some other private value' }], visible: '保留' }) }) +
      record('response_item', { type: 'function_call_output', call_id: '__proto__', output: JSON.stringify({ cookie: { value: 'private cookie value' } }) }));
    const turn = (await r.adapter.turns('thread-fixture'))[1]!;
    const blocks = await r.adapter.blocks('thread-fixture', turn.turn);
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('nested private value'); expect(json).not.toContain('some other private value'); expect(json).not.toContain('private cookie value');
    expect(json).toContain('保留');
    expect(blocks.find(b => b.callId === '__proto__')?.meta?.paired).toBe(true);
  });

  it('回源拒绝尚未重建的旧索引，正常追加不阻止读取已有正文', async () => {
    const r = await rig(await fs.readFile(fixture, 'utf8') + user() + assistant('甲'.repeat(3000)));
    const turn = (await r.adapter.turns('thread-fixture'))[1]!;
    const ref = (await r.adapter.blocks('thread-fixture', turn.turn)).find(b => b.ref)!.ref!;
    await fs.appendFile(r.file, assistant('追加'), 'utf8');
    expect(await r.adapter.content(ref)).toBe('甲'.repeat(3000));
    const text = await fs.readFile(r.file, 'utf8');
    await fs.writeFile(r.file, text.replace('甲'.repeat(3000), '乙'.repeat(3000)), 'utf8');
    await expect(r.adapter.content(ref)).rejects.toMatchObject({ status: 409 });
    await r.adapter.refresh();
    await expect(r.adapter.content(ref)).rejects.toMatchObject({ status: 400 });
  });

  it('首尾不变的中段改写并追加，逐行摘要阻止旧内容引用且下次刷新强制重建', async () => {
    const initial = await fs.readFile(fixture, 'utf8') + user() + assistant('甲'.repeat(5000)) + record('event_msg', { type: 'item_completed', padding: 'x'.repeat(6000) });
    const r = await rig(initial);
    const turn = (await r.adapter.turns('thread-fixture'))[1]!;
    const ref = (await r.adapter.blocks('thread-fixture', turn.turn)).find(b => b.ref)!.ref!;
    await fs.writeFile(r.file, initial.replace('甲'.repeat(5000), '乙'.repeat(5000)) + assistant('新消息'), 'utf8');
    await r.adapter.refresh();
    expect(r.adapter.diagnostics.incrementalScans).toBe(1);
    await expect(r.adapter.content(ref)).rejects.toMatchObject({ status: 409 });
    await r.adapter.refresh();
    expect(r.adapter.diagnostics.fullScans).toBe(2);
    const fresh = (await r.adapter.blocks('thread-fixture', turn.turn)).find(b => b.ref)!.ref!;
    expect(await r.adapter.content(fresh)).toBe('乙'.repeat(5000));
  });

  it('临时秘密注册或注销后 lazy ref 使用当前脱敏长度', async () => {
    const secret = 'short-secret-value';
    const r = await rig(await fs.readFile(fixture, 'utf8') + user() + assistant('甲'.repeat(3000) + secret));
    const turn = (await r.adapter.turns('thread-fixture'))[1]!;
    const original = (await r.adapter.blocks('thread-fixture', turn.turn)).find(b => b.ref)!.ref!;
    const dispose = registerTemporarySecrets([secret]);
    cleanup.push(async () => dispose());
    const hidden = (await r.adapter.blocks('thread-fixture', turn.turn)).find(b => b.ref)!.ref!;
    expect(hidden.length).not.toBe(original.length);
    expect(await r.adapter.content(hidden)).toBe('甲'.repeat(3000) + '[已隐藏]');
    dispose();
    const visible = (await r.adapter.blocks('thread-fixture', turn.turn)).find(b => b.ref)!.ref!;
    expect(await r.adapter.content(visible)).toBe('甲'.repeat(3000) + secret);
  });

  it('索引 schema 故障只停用会话适配器，不阻断 ObsStore 原事件功能', async () => {
    const r = await rig();
    await r.adapter.close();
    r.store.db.exec('DROP TABLE session_index; CREATE TABLE session_index(broken TEXT)');
    const adapter = new CodexSessionAdapter({ store: r.store, codexHome: r.codexHome, dataDir: r.dir });
    cleanup.push(() => adapter.close());
    await adapter.refresh();
    expect(await adapter.listSessions()).toEqual([]);
    r.store.append({ ticket: 'test-index-degraded', scope: 'shared', ts: Date.now(), stage: 'received', status: 'ok', duration_ms: null });
    expect(r.store.events('test-index-degraded')).toHaveLength(1);
    expect(r.store.degraded).toBe(false);
  });

  it('目录 junction 不能使旧索引读取 sessions 外文件，发现阶段也忽略 root junction', async () => {
    const r = await rig();
    const turn = (await r.adapter.turns('thread-fixture'))[0]!;
    const root = path.join(r.codexHome, 'sessions');
    const moved = path.join(r.dir, 'sessions-original');
    await fs.rename(root, moved);
    await fs.symlink(moved, root, 'junction');
    await expect(r.adapter.blocks('thread-fixture', turn.turn)).rejects.toMatchObject({ status: 409 });
    await r.adapter.refresh();
    expect(await r.adapter.listSessions()).toEqual([]);
  });

  it('追加新正文推送 block，取消订阅后不再发送', async () => {
    const r = await rig();
    const frames: BlockFrame[] = [];
    const unsubscribe = r.adapter.subscribe('thread-fixture', frame => frames.push(frame));
    await fs.appendFile(r.file, user('实时用户') + assistant('实时助手'), 'utf8'); await r.adapter.refresh();
    expect(frames.map(f => f.block.kind)).toEqual(['user', 'event', 'assistant']);
    expect(frames[2]).toMatchObject({ session: 'thread-fixture', block: { text: '实时助手' } });
    unsubscribe(); await fs.appendFile(r.file, assistant('不推送'), 'utf8'); await r.adapter.refresh();
    expect(frames).toHaveLength(3);
  });

  it('三次模型请求的分隔始终位于对应正文之前，context 不制造双占位', async () => {
    const usage = (n: number) => record('token_usage_record', { usage: { input_tokens: 100, output_tokens: 3 }, thread_token_usage: { input_tokens: n * 100, output_tokens: n * 3 } });
    const tokens = (n: number) => record('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 3 }, total_token_usage: { input_tokens: n * 100, output_tokens: n * 3 } } });
    const call = (id: string) => record('response_item', { type: 'function_call', call_id: id, name: 'fixture', arguments: '{}' });
    const output = (id: string) => record('response_item', { type: 'function_call_output', call_id: id, output: '结果' });
    const context = record('turn_context', { model: 'model-three', effort: 'high' });
    const body = record('session_meta', { id: 'thread-fixture' }) + context + user() + context +
      assistant('先检查') + call('first') + usage(1) + output('first') + tokens(1) +
      call('second') + usage(2) + output('second') + tokens(2) +
      assistant('最终回复') + usage(3) + tokens(3) + done();
    const r = await rig(body);
    const turn = (await r.adapter.turns('thread-fixture'))[0]!;
    expect(turn).toMatchObject({ requests: 3, tools: 2, usage: { input: 300, output: 9, measured: true } });
    const blocks = await r.adapter.blocks('thread-fixture', turn.turn);
    expect(blocks.filter(b => !['model_usage', 'turn_complete'].includes(String(b.meta?.type))).map(b => b.meta?.type === 'model_request' ? 'request-' + b.meta.request : b.kind))
      .toEqual(['user', 'request-1', 'assistant', 'tool_call', 'tool_result', 'request-2', 'tool_call', 'tool_result', 'request-3', 'assistant']);
    expect(blocks.filter(b => b.kind === 'tool_call').every(b => b.meta?.paired)).toBe(true);
    expect(blocks.filter(b => b.meta?.type === 'model_request').every(b => b.meta?.model === 'model-three' && b.meta?.usage)).toBe(true);
  });

  it('只追加 usage 或终态也发送可关联的 SSE 增量事件', async () => {
    const r = await rig(record('session_meta', { id: 'thread-fixture' }) + user() + assistant('回复'));
    const frames: BlockFrame[] = [];
    r.adapter.subscribe('thread-fixture', frame => frames.push(frame));
    await fs.appendFile(r.file, record('token_usage_record', { usage: { input_tokens: 10, output_tokens: 2 } }), 'utf8');
    await r.adapter.refresh();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.block).toMatchObject({ kind: 'event', meta: { type: 'model_usage', request: 1, usage: { input: 10, output: 2, measured: true } } });
    await fs.appendFile(r.file, record('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } }) + done(), 'utf8');
    await r.adapter.refresh();
    expect(frames).toHaveLength(2);
    expect(frames[1]?.block).toMatchObject({ meta: { type: 'turn_complete', status: 'ok', ended: Date.parse(ts) } });
    await fs.appendFile(r.file, user() + assistant('下一轮') + record('event_msg', { type: 'turn_aborted' }), 'utf8');
    await r.adapter.refresh();
    expect(frames.at(-1)?.block).toMatchObject({ meta: { type: 'turn_failed', status: 'failed' } });
  });

  it('定时后台轮询与进度状态，不需要请求触发索引', async () => {
    const r = await rig();
    const adapter = new CodexSessionAdapter({ store: r.store, codexHome: r.codexHome, dataDir: r.dir, pollMs: 25 });
    cleanup.push(() => adapter.close());
    await adapter.refresh();
    await fs.appendFile(r.file, user(), 'utf8');
    await vi.waitFor(async () => expect((await adapter.listSessions())[0]?.turns).toBe(2));
    await adapter.refresh();
    expect(adapter.progress).toEqual({ indexing: false, files: 1, done: 1 });
  });

  it('50 MiB rollout 逐块流式扫描，缓存索引后不再次读取正文', async () => {
    const r = await rig(record('session_meta', { id: 'thread-fixture' }) + user());
    const filler = record('event_msg', { type: 'item_completed', padding: 'x'.repeat(1900) });
    const batch = filler.repeat(Math.ceil(1024 * 1024 / Buffer.byteLength(filler)));
    const handle = await fs.open(r.file, 'a');
    try { for (let i = 0; i < 50; i++) await handle.write(batch, undefined, 'utf8'); }
    finally { await handle.close(); }
    await fs.appendFile(r.file, assistant('大文件读取完成') + done(), 'utf8');
    await r.adapter.refresh();
    expect(r.adapter.diagnostics.scannedBytes).toBeGreaterThan(50 * 1024 * 1024);
    expect(r.adapter.diagnostics.fullScans).toBe(1);
    const scanned = r.adapter.diagnostics.scannedBytes;
    await r.adapter.refresh(); expect(r.adapter.diagnostics.scannedBytes).toBe(scanned);
    const turn = (await r.adapter.turns('thread-fixture'))[0]!;
    expect((await r.adapter.blocks('thread-fixture', turn.turn)).find(b => b.kind === 'assistant')?.text).toBe('大文件读取完成');
  }, 20_000);
});
