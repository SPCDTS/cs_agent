import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeContext, type ContextAnalysis } from '../../src/obs/context/index.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';
import { CodexSessionAdapter } from '../../src/obs/sessions/codex-adapter.js';
import { createSessionRoutes } from '../../src/obs/sessions/http.js';
import type { BlockFrame, ContentRef } from '../../src/obs/sessions/types.js';
import { ObsStore } from '../../src/obs/store.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const session = 'baseline-fixture';
const record = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';
const meta = (base?: unknown) => record('session_meta', { id: session, base_instructions: base });
const message = (role: string, content: string) => record('response_item', { type: 'message', role, content });
const event = (type: string, payload: object = {}) => record('event_msg', { type, ...payload });
const turn = (id: string, base: unknown) => event('task_started', { turn_id: id })
  + record('turn_context', { turn_id: id, base_instructions: base, model: 'fixture-model' })
  + message('user', `问题 ${id}`) + message('assistant', `回答 ${id}`) + event('task_complete', { turn_id: id });

async function rig(initial: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-baseline-'));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const codexHome = path.join(dir, 'codex'), sessions = path.join(codexHome, 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, 'baseline.jsonl');
  await fs.writeFile(file, initial, 'utf8');
  await fs.writeFile(path.join(dir, 'codex-threads.json'), JSON.stringify({ owner: { thread_id: session } }), 'utf8');
  const store = new ObsStore(dir);
  cleanup.push(() => store.close());
  const createAdapter = () => new CodexSessionAdapter({ store, codexHome, dataDir: dir, pollMs: 60000 });
  let adapter = createAdapter();
  cleanup.push(() => adapter.close());
  await adapter.refresh();
  const server = createServer((req, res) => {
    void createSessionRoutes({ codex: adapter }, () => null)(new URL(req.url!, 'http://localhost'), res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const get = (suffix: string) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/agents/codex/sessions/${session}/${suffix}`);
  return { file, store, get, get adapter() { return adapter; },
    content: (ref: ContentRef) => get(`content?offset=${ref.offset}&length=${ref.length}`),
    analyze: (at?: string, phase: 'before' | 'after' = 'after') => analyzeContext({ codex: adapter }, 'codex', session, { at, phase }),
    async restart() { await adapter.close(); adapter = createAdapter(); await adapter.refresh(); } };
}

const baseline = (analysis: ContextAnalysis) => {
  const messages = analysis.messages.filter(m => m.kind === 'system');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ category: 'instructions', provenance: 'recorded', ref: { session } });
  return messages[0].ref!;
};

describe('Codex 基础指令正文引用', () => {
  it.each([
    ['session_meta', 'string'], ['session_meta', 'object'], ['turn_context', 'string'], ['turn_context', 'object'],
  ])('%s 的 %s 基础指令可从 content 端点完整展开，回合流没有多余块', async (type, shape) => {
    const text = '基础指令开头\n' + '中文正文🙂\n'.repeat(900) + '基础指令结尾';
    const base = shape === 'string' ? text : { text };
    const r = await rig((type === 'session_meta' ? meta(base) : meta()) + message('user', '问题')
      + (type === 'turn_context' ? record(type, { base_instructions: base }) : '')
      + message('assistant', '回答') + event('task_complete'));
    const turns = await r.adapter.turns(session);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ preview: '问题', requests: 1, tools: 0, status: 'ok' });
    const response = await r.get(`context?at=${turns[0].turn}&phase=after`);
    expect(response.status).toBe(200);
    const analysis = await response.json() as ContextAnalysis, ref = baseline(analysis);
    expect(analysis.messages[0].preview.length).toBeLessThanOrEqual(240);
    expect(ref).toMatchObject({ length: Buffer.byteLength(text), bytes: Buffer.byteLength(text) });
    const content = await r.content(ref);
    expect(content.status).toBe(200);
    expect(await content.json()).toEqual({ text, truncated: false });
    expect((await r.adapter.blocks(session, turns[0].turn)).map(b => b.kind)).toEqual(['user', 'event', 'assistant', 'event']);
    expect((await r.content({ ...ref, length: ref.length + 4 })).status).toBe(400);
  });

  it('历史 before/after 与回滚只引用当时最后生效的一条 baseline', async () => {
    const r = await rig(meta('会话基础规则') + turn('a', { text: '第一轮规则' }) + turn('b', '第二轮规则'));
    const turns = await r.adapter.turns(session);
    for (const [i, text] of ['第一轮规则', '第二轮规则'].entries()) {
      for (const phase of ['before', 'after'] as const) {
        const ref = baseline(await r.analyze(turns[i].turn, phase));
        expect(await r.adapter.content(ref)).toBe(text);
      }
    }
    const first = baseline(await r.analyze(turns[0].turn));
    await fs.appendFile(r.file, event('thread_rolled_back', { num_turns: 1 }), 'utf8');
    expect(baseline(await r.analyze())).toEqual(first);
    expect(await r.adapter.content(first)).toBe('第一轮规则');
  });

  it('增量索引不推送 baseline，重启恢复引用，版本 3 自动重建', async () => {
    const r = await rig(meta('最初规则') + turn('a', undefined));
    const original = baseline(await r.analyze()), frames: BlockFrame[] = [];
    r.adapter.subscribe(session, frame => frames.push(frame));
    await fs.appendFile(r.file, turn('b', { text: '更新规则' }), 'utf8');
    const current = baseline(await r.analyze());
    expect(current.offset).not.toBe(original.offset);
    expect(await r.adapter.content(current)).toBe('更新规则');
    expect(frames.map(f => f.block.kind)).toEqual(['user', 'event', 'assistant', 'event']);
    expect(r.adapter.diagnostics).toMatchObject({ fullScans: 1, incrementalScans: 1 });
    await r.restart();
    expect(r.adapter.diagnostics.scannedBytes).toBe(0);
    expect(baseline(await r.analyze())).toEqual(current);
    expect(await r.adapter.content(original)).toBe('最初规则');
    await r.adapter.close();
    const row = r.store.db.prepare('SELECT state_json FROM session_index').get() as { state_json: string };
    const state = JSON.parse(row.state_json);
    expect(state.version).toBe(4);
    expect(row.state_json).not.toContain('最初规则');
    expect(row.state_json).not.toContain('更新规则');
    state.version = 3; delete state.baselines;
    r.store.db.prepare('UPDATE session_index SET state_json=?').run(JSON.stringify(state));
    await r.restart();
    expect(r.adapter.diagnostics.fullScans).toBe(1);
    const rebuilt = baseline(await r.analyze());
    expect(rebuilt.offset).not.toBe(current.offset);
    expect(await r.adapter.content(rebuilt)).toBe('更新规则');
    expect((await r.content(current)).status).toBe(400);
  });

  it('完整正文与子范围统一脱敏，注销秘密后签发当前 UTF-8 长度', async () => {
    const secret = 'baseline-private-test-secret';
    const text = '首部中文🙂\n' + '正文'.repeat(1600) + secret + '\n尾部';
    const dispose = registerTemporarySecrets([secret]);
    cleanup.push(dispose);
    const r = await rig(meta({ text }) + turn('a', undefined));
    const ref = baseline(await r.analyze()), safe = text.replace(secret, '[已隐藏]');
    expect(ref.bytes).toBe(Buffer.byteLength(safe));
    expect(await (await r.content(ref)).json()).toEqual({ text: safe, truncated: false });
    const start = Buffer.byteLength(text.slice(0, text.indexOf(secret)));
    const partial = await (await r.content({ ...ref, offset: ref.offset + start + 1, length: 8 })).json() as { text: string };
    expect(partial.text).toBe('已隐藏');
    dispose();
    const visible = baseline(await r.analyze());
    expect(visible.offset).toBe(ref.offset);
    expect(visible.bytes).toBe(Buffer.byteLength(text));
    expect(await (await r.content(visible)).json()).toEqual({ text, truncated: false });
  });

  it('旧引用遇到同大小改写返回 409，刷新后返回新全文', async () => {
    const initial = meta('旧规则'.repeat(3000)) + turn('a', undefined);
    const r = await rig(initial), ref = baseline(await r.analyze());
    await fs.appendFile(r.file, event('fixture_append'), 'utf8');
    expect((await r.content(ref)).status).toBe(200);
    await r.adapter.refresh();
    const text = await fs.readFile(r.file, 'utf8');
    await fs.writeFile(r.file, text.replaceAll('旧规则', '新规则'), 'utf8');
    const future = new Date(Date.now() + 1000);
    await fs.utimes(r.file, future, future);
    expect((await r.content(ref)).status).toBe(409);
    const fresh = baseline(await r.analyze());
    expect(fresh.offset).not.toBe(ref.offset);
    expect(await (await r.content(fresh)).json()).toEqual({ text: '新规则'.repeat(3000), truncated: false });
    expect((await r.content(ref)).status).toBe(400);
  });
});
