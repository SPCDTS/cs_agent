import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ContextStore } from '../../src/context/store.js';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';
import { CodexSessionAdapter } from '../../src/obs/sessions/codex-adapter.js';
import { contentSlice, inlineBlock, RESPONSE_BYTES } from '../../src/obs/sessions/content.js';
import type { SessionAdapters } from '../../src/obs/sessions/http.js';
import { type BlockFrame, type ContentRef, type SessionAdapter, type SessionFilter, type SessionRef } from '../../src/obs/sessions/types.js';

const TOKEN = 'dashboard-session-test-token', SECRET = 'fixture-secret-long-value';
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

class FakeAdapter implements SessionAdapter {
  progress = { indexing: true, files: 53, done: 2 };
  sessions: SessionRef[] = Array.from({ length: 53 }, (_, i) => ({ backend: 'pi', id: String(i + 1), label: `会话 ${i} ${SECRET}`,
    scope: i % 2 ? 'group:7' : 'owner', status: i % 2 ? 'archived' : 'active', started: i + 100, updated: i + 200, turns: 1 }));
  text = `正文 ${SECRET} ` + '中文正文\n'.repeat(3000);
  listeners = new Set<(frame: BlockFrame) => void>();
  ref(id = '1'): ContentRef { const bytes = Buffer.byteLength(this.text); return { session: id, offset: 100, length: bytes, bytes }; }
  async listSessions(f: SessionFilter = {}) {
    const all = this.sessions.filter(s => (!f.status || s.status === f.status) && (!f.scope || s.scope === f.scope)
      && (f.since === undefined || s.updated >= f.since));
    return f.page === undefined ? all : all.slice(f.page * 50, (f.page + 1) * 50);
  }
  async turns(_id: string) { return [{ turn: 'turn-1', started: 100, preview: `提问 ${SECRET}`, tools: 1, requests: 1, status: 'ok' as const }]; }
  async blocks(id: string, _turn: string) {
    return [inlineBlock({ kind: 'tool_result', text: this.text, meta: { authorization: 'test-credential', nested: [`Bearer abcdefghijkl`, SECRET] } }, this.ref(id))];
  }
  async content(ref: ContentRef) { return contentSlice(this.text, ref, this.ref(ref.session)); }
  subscribe(_id: string, cb: (frame: BlockFrame) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
}

async function rig(factory?: (dir: string, store: ObsStore) => Promise<SessionAdapters>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-session-api-'));
  const store = new ObsStore(dir), context = new ContextStore(dir), fake = new FakeAdapter();
  const adapters = factory ? await factory(dir, store) : { pi: fake };
  const disposeSecret = registerTemporarySecrets([TOKEN, SECRET]);
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN }), store, context,
    codex: async () => [], pi: async () => ({}), health: () => ({}), queue: () => ({}), sessionAdapters: adapters });
  const server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => {
    await dashboard.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    disposeSecret(); store.close(); context.close(); await fs.rm(dir, { recursive: true, force: true });
  });
  const get = (url: string, init: RequestInit = {}) => fetch(base + url, { ...init, headers: { Cookie: `obs_token=${TOKEN}`, ...init.headers } });
  return { dir, store, fake, get, base, adapters };
}

const sessionPath = '/api/agents/pi/sessions/1';
const routes = ['/api/agents', '/api/agents/pi/sessions', sessionPath, `${sessionPath}/turns/turn-1`,
  `${sessionPath}/content?offset=100&length=1`, `${sessionPath}/context`, '/agents/stream?backend=pi&session=1'];

describe('会话 API 鉴权与只读边界', () => {
  it.each(routes)('%s 要求鉴权，URL 口令只换 cookie，POST 拒绝', async route => {
    const r = await rig();
    expect((await fetch(r.base + route)).status).toBe(401);
    const login = await fetch(r.base + route + (route.includes('?') ? '&' : '?') + `token=${TOKEN}`, { redirect: 'manual' });
    expect(login.status).toBe(303); expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    expect(login.headers.get('location')).not.toContain(TOKEN);
    const post = await r.get(route, { method: 'POST' });
    expect(post.status).toBe(405); expect(post.headers.get('allow')).toBe('GET');
  });

  it('统计包含后台进度，列表筛选分页和旧页面继续可用', async () => {
    const r = await rig();
    const summary = await r.get('/api/agents');
    expect(summary.headers.get('referrer-policy')).toBe('same-origin');
    expect(summary.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(summary.headers.get('content-type')).toContain('application/json');
    expect(await summary.json()).toEqual([
      { backend: 'codex', sessions_active: 0, sessions_archived: 0, last_turn_at: null, indexing: { indexing: false, files: 0, done: 0 } },
      { backend: 'pi', sessions_active: 27, sessions_archived: 26, last_turn_at: 252, indexing: r.fake.progress },
    ]);
    expect((await (await r.get('/api/agents/pi/sessions')).json()).length).toBe(50);
    expect((await (await r.get('/api/agents/pi/sessions?page=1')).json()).length).toBe(3);
    const filtered = await (await r.get('/api/agents/pi/sessions?status=archived&scope=group%3A7&since=249')).json();
    expect(filtered.map((s: SessionRef) => s.id)).toEqual(['50', '52']);
    for (const url of ['/agents', '/agents/pi/sessions', '/context']) expect((await r.get(url)).status).toBe(200);
  });

  it('回合和懒加载正文都脱敏，元数据及预览没有凭据', async () => {
    const r = await rig();
    const detail = await (await r.get(sessionPath)).json();
    expect(detail.turns[0].turn).toBe('turn-1');
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    const turn = await (await r.get(`${sessionPath}/turns/turn-1`)).json();
    expect(turn.blocks[0].text).toBeUndefined(); expect(turn.blocks[0].preview).toContain('[已隐藏]');
    expect(turn.blocks[0].meta.authorization).toBe('[已隐藏]');
    const ref = turn.blocks[0].ref;
    const response = await r.get(`${sessionPath}/content?offset=${ref.offset}&length=${ref.length}`);
    const content = await response.json();
    expect(content.truncated).toBe(false); expect(content.text).toContain('中文正文'); expect(content.text).not.toContain(SECRET);
    expect(content.text).toContain('[已隐藏]');
    const slice = await (await r.get(`${sessionPath}/content?offset=107&length=10`)).json();
    expect(slice.text).not.toContain(SECRET.slice(0, 6));
  });

  it('拒绝未知后端、会话、回合及路径穿越', async () => {
    const r = await rig();
    for (const url of ['/api/agents/other/sessions', '/api/agents/pi/sessions/unknown', `${sessionPath}/turns/unknown`, '/api/agents/pi/sessions/1/nope'])
      expect((await r.get(url)).status, url).toBe(404);
    for (const id of ['%2e%2e%2fsecret', 'a%5cb', '%00', '%E0%A4%A']) expect((await r.get(`/api/agents/pi/sessions/${id}`)).status).toBe(400);
    expect((await r.get('/agents/stream?backend=pi&session=2')).status).toBe(409);
    expect((await r.get('/agents/stream?backend=unknown&session=1')).status).toBe(404);
  });

  it.each(['offset=-1&length=1', 'offset=100&length=9999999', 'offset=1.5&length=1', 'offset=100', 'length=1', 'offset=Infinity&length=1'])
  ('正文非法范围返回 400：%s', async query => { const r = await rig(); expect((await r.get(`${sessionPath}/content?${query}`)).status).toBe(400); });

  it.each(['page=-1', 'page=1.5', 'page=1000001', 'status=deleted', 'since=nonsense', 'since=-1'])
  ('列表校验查询参数：%s', async query => { const r = await rig(); expect((await r.get(`/api/agents/pi/sessions?${query}`)).status).toBe(400); });

  it('正文 JSON 限制为 1 MiB，包含控制字符转义膨胀，并返回 truncated', async () => {
    const r = await rig(); r.fake.text = `Bearer credential-private\n` + '\u0000中文'.repeat(200_000);
    const res = await r.get(`${sessionPath}/content?offset=100&length=${r.fake.ref().length}`);
    const bytes = Buffer.from(await res.arrayBuffer()), body = JSON.parse(bytes.toString('utf8'));
    expect(res.status).toBe(200); expect(bytes.length).toBeLessThanOrEqual(RESPONSE_BYTES);
    expect(body.truncated).toBe(true); expect(body.text).not.toContain('credential-private');
    expect(body.text).not.toContain('\ufffd');
  });

  it('普通 JSON 超上限明确返回 413，读取失败返回不泄漏细节的 JSON', async () => {
    const r = await rig(); r.fake.sessions[0]!.label = '长'.repeat(RESPONSE_BYTES);
    const response = await r.get(sessionPath); expect(response.status).toBe(413);
    expect(Buffer.byteLength(await response.text())).toBeLessThan(RESPONSE_BYTES);
    r.fake.listSessions = async () => { throw new Error('C:/private/path secret'); };
    const failed = await r.get(sessionPath); expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('private/path');
  });
});

describe('会话 SSE', () => {
  it('追加 Codex rollout 后发送脱敏 block 帧，连接关闭后取消订阅', async () => {
    let rollout = '';
    const r = await rig(async (dir, store) => {
      const home = path.join(dir, 'codex'), folder = path.join(home, 'sessions', '2026', '10', '18');
      await fs.mkdir(folder, { recursive: true }); rollout = path.join(folder, 'rollout-test.jsonl');
      await fs.writeFile(path.join(dir, 'codex-threads.json'), JSON.stringify({ owner: { thread_id: 'thread-stream', started: Date.now() } }), 'utf8');
      await fs.writeFile(rollout, [
        { timestamp: '2026-10-18T00:00:00Z', type: 'session_meta', payload: { id: 'thread-stream' } },
        { timestamp: '2026-10-18T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] } },
      ].map(line => JSON.stringify(line) + '\n').join(''), 'utf8');
      const codex = new CodexSessionAdapter({ store, codexHome: home, dataDir: dir, pollMs: 30 });
      await codex.refresh(); return { codex };
    });
    const controller = new AbortController();
    const response = await r.get('/agents/stream?backend=codex&session=thread-stream', { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      await fs.appendFile(rollout, JSON.stringify({ timestamp: '2026-10-18T00:00:02Z', type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `新回答 ${SECRET}` }] } }) + '\n', 'utf8');
      let received = '';
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        while (!received.includes('新回答')) {
          const chunk = await reader.read(); if (chunk.done) throw new Error('SSE 提前结束');
          received += new TextDecoder().decode(chunk.value);
        }
      } finally { clearTimeout(timeout); }
      expect(received).toContain('event: block'); expect(received).toContain('[已隐藏]'); expect(received).not.toContain(SECRET);
    } finally { await reader.cancel().catch(() => undefined); controller.abort(); }
  });

  it('Pi 订阅的每帧脱敏，关闭 dashboard 释放订阅', async () => {
    const r = await rig(), controller = new AbortController();
    const response = await r.get('/agents/stream?backend=pi&session=1', { signal: controller.signal });
    expect(r.fake.listeners.size).toBe(1);
    for (const listener of r.fake.listeners) listener({ session: '1', turn: 'turn-1', block: { kind: 'assistant', text: SECRET } });
    const reader = response.body!.getReader(), chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain('[已隐藏]');
    await reader.cancel(); controller.abort();
    await new Promise(resolve => setTimeout(resolve, 30)); expect(r.fake.listeners.size).toBe(0);
  });

  it('等待会话读取时客户端提前断开，不遗留 SSE 订阅', async () => {
    const r = await rig(), controller = new AbortController();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    r.fake.listSessions = async () => { entered(); await waiting; return r.fake.sessions; };
    const request = r.get('/agents/stream?backend=pi&session=1', { signal: controller.signal }).catch(() => undefined);
    await started; controller.abort(); await request;
    await new Promise(resolve => setTimeout(resolve, 30)); release();
    await new Promise(resolve => setTimeout(resolve, 30)); expect(r.fake.listeners.size).toBe(0);
  });
});
