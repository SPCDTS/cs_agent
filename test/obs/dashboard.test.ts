import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboard, csrfToken, sseWriter } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { trace } from '../../src/obs/trace.js';
import { LiveBus, type LiveCard } from '../../src/obs/live.js';
import { registerSecrets } from '../../src/obs/redact.js';
import { ContextStore } from '../../src/context/store.js';
import { loadConfig } from '../../src/config.js';
import { SettingsStore, SETTINGS_TICKET, type RuntimeSettings } from '../../src/agent/settings.js';
import { CodexRunner } from '../../src/agent/codex-runner.js';
import { CodexBackend } from '../../src/agent/backends/codex.js';
import { FIXTURES } from '../agent/helpers.js';

const clean: (() => unknown)[] = [];
afterEach(async () => { trace.attach(undefined); for (const fn of clean.splice(0).reverse()) await fn(); });
const TOKEN = 'fake-dashboard-token-0123456789';
const defaults: RuntimeSettings = { agentBackend: 'codex', backendOverrides: {}, codexReplyMode: 'relay', codexReasoningEffort: 'high', alertOwner: false };

async function rig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-dash-'));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  trace.attach(store);
  const live = new LiveBus(trace);
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN, QQ_ALLOW_USERS: '1' });
  registerSecrets([TOKEN]);
  const settings = await SettingsStore.open(dir, defaults, trace);
  const resetCodex = vi.fn(async (key: string): Promise<string | null> => key === 'shared' ? 'thread-old' : null);
  const resetPi = vi.fn(async () => 42);
  mkdirSync(path.join(dir, 'codex'), { recursive: true }); writeFileSync(path.join(dir, 'codex', 'AGENTS.md'), '# 受管规则');
  const dashboard = createDashboard({ config, store, context, settings, live, resetCodex, resetPi,
    health: () => ({ bridge: { ws_connected: true, disconnect_count: 2 }, comfy: { ok: true }, codex: { ok: false }, deepseek_key_present: true }),
    queue: () => ({ active: 1, slots: 2, waiting: 1, scopes: { 'group:7': 1 } }),
    codex: async () => [{ thread_key: 'owner', thread_id: null, rollout_bytes: null, observed_turns: 0 }, { thread_key: 'shared', thread_id: 'thread-old', rollout_bytes: 2_500_000, observed_turns: 3 }],
    pi: async () => ({ threads: { 'group:7': 42 }, count: 1, keys: ['group:7'], compaction: [] }) });
  const server = createServer(dashboard.handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  clean.push(() => { store.close(); context.close(); rmSync(dir, { recursive: true, force: true }); },
    async () => { live.close(); dashboard.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const cookie = 'obs_token=' + encodeURIComponent(TOKEN);
  const get = (url: string, init: RequestInit = {}) => fetch(base + url, { ...init, headers: { Cookie: cookie, ...init.headers } });
  const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) => fetch(base + url, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
  return { dir, store, live, settings, base, get, post, resetCodex, resetPi, csrf: csrfToken(TOKEN) };
}

/** 读 SSE 直到 predicate 满足（或超时）。 */
async function readUntil(res: Response, done: (text: string) => boolean, ms = 8000): Promise<string> {
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  while (!done(text)) {
    if (Date.now() > deadline) throw new Error('SSE timeout; got: ' + text.slice(-2000));
    pending ??= reader.read();
    const chunk = await Promise.race([pending, new Promise<undefined>(r => setTimeout(() => r(undefined), 200))]);
    if (chunk) { pending = undefined; if (chunk.value) text += dec.decode(chunk.value, { stream: true }); }
  }
  void reader.cancel().catch(() => undefined);
  return text;
}
const frames = (text: string, event: string) => text.split('\n\n').filter(f => f.startsWith(`event: ${event}\n`)).map(f => JSON.parse(f.slice(f.indexOf('data: ') + 6)));

describe('面板二期页面', () => {
  it('所有页面 200，含设计令牌（深浅色）、导航高亮和关键元素；无内联 style 属性与外部资源', async () => {
    const r = await rig();
    trace.event('t-live', 'received', { scope: 'group:7', detail: { text: '在途消息', sender: '小明' } });
    for (const [url, marks] of Object.entries({
      '/': ['运行总览', '依赖状态', 'class="lamps"', '在途消息', '并发槽位'],
      '/live': ['进行中的会话', 'id="inflight"', 'id="done"', 'src="/assets/live.js"', 'data-ticket="t-live"', '群 7'],
      '/tickets': ['票据列表', 'name="status"'],
      '/logs': ['实时日志', 'src="/assets/logs.js"'],
      '/context': ['上下文检索'],
      '/codex': ['Codex 线程', 'thread-old', '2.4 MB', 'action="/codex/reset"', '全局 AGENTS.md'],
      '/pi': ['Pi 会话', 'action="/pi/reset"', '群 7'],
      '/settings': ['设置', 'action="/settings"', 'name="agentBackend"', 'name="_csrf"', 'action="/settings/agent-md"', '受管规则'],
      '/config': ['生效配置'],
    })) {
      const res = await r.get(url); const html = await res.text();
      expect(res.status, url).toBe(200);
      for (const m of marks) expect(html, `${url} 缺少 ${m}`).toContain(m);
      expect(html).toContain('--paper:'); expect(html).toContain('--carbon:');
      expect(html).toMatch(/@media \(prefers-color-scheme:dark\)\{:root\{[^}]*--paper:/);
      expect(html).toContain('"PingFang SC"'); expect(html).toContain('"Microsoft YaHei"');
      expect(html).not.toMatch(/\sstyle="/);
      expect(html).not.toMatch(/(src|href)="https?:/);
      expect(html).not.toContain(TOKEN);
      const nonce = /<style nonce="([^"]+)"/.exec(html)![1]!;
      expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
      for (const m of html.matchAll(/<script[^>]*>/g)) expect(m[0]).toContain(`nonce="${nonce}"`);
      if (url !== '/') expect(html).toContain(`href="${url}" aria-current="page"`);
    }
    for (const asset of ['live.js', 'logs.js', 'forms.js']) {
      const res = await r.get('/assets/' + asset);
      expect(res.status).toBe(200); expect(res.headers.get('content-type')).toContain('text/javascript');
      const js = await res.text(); expect(js).not.toContain('innerHTML'); expect(js).not.toMatch(/setInterval\([^)]*fetch/);
    }
    expect((await r.get('/assets/../http.ts')).status).toBe(404);
    expect((await r.get('/nope')).status).toBe(404);
  });

  it('写操作要求 cookie 会话与 CSRF 令牌；跨站来源、错误令牌与 URL 口令都被拒绝', async () => {
    const r = await rig();
    const ok = { _csrf: r.csrf, agentBackend: 'pi', backendOverrides: '', codexReplyMode: 'relay', codexReasoningEffort: 'high' };
    expect((await r.post('/settings', { ...ok, _csrf: '' })).status).toBe(403);
    expect((await r.post('/settings', { ...ok, _csrf: r.csrf.slice(0, -1) + 'x' })).status).toBe(403);
    expect((await r.post('/settings', ok, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await r.post('/settings', ok, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const noCookie = await fetch(r.base + '/settings?token=' + TOKEN, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(ok).toString() });
    expect(noCookie.status).toBe(401);
    expect((await fetch(r.base + '/settings', { method: 'POST', redirect: 'manual', headers: { Cookie: 'obs_token=' + encodeURIComponent(TOKEN), 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415);
    expect((await r.get('/settings', { method: 'PUT' })).status).toBe(405);
    expect(r.settings.current().agentBackend).toBe('codex');
    expect(r.resetCodex).not.toHaveBeenCalled();
    expect((await r.post('/codex/reset', { key: 'shared' })).status).toBe(403);
    expect(r.resetCodex).not.toHaveBeenCalled();
  });

  it('保存设置立即生效、落盘并记录事件；非法覆盖表返回 400 且不改动', async () => {
    const r = await rig();
    const res = await r.post('/settings', { _csrf: r.csrf, agentBackend: 'pi', backendOverrides: 'group:7=codex\nprivate:5=pi', codexReplyMode: 'direct', codexReasoningEffort: 'low', alertOwner: 'on' },
      { Origin: r.base, 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/settings?ok=saved');
    expect(r.settings.current()).toEqual({ agentBackend: 'pi', backendOverrides: { 'group:7': 'codex', 'private:5': 'pi' }, codexReplyMode: 'direct', codexReasoningEffort: 'low', alertOwner: true });
    expect(JSON.parse(readFileSync(path.join(r.dir, 'settings.json'), 'utf8')).settings.agentBackend).toBe('pi');
    const ev = r.store.events(SETTINGS_TICKET).find(e => e.stage === 'settings_changed')!;
    expect(JSON.parse(ev.detail_json)).toMatchObject({ source: 'dashboard', before: { agentBackend: 'codex' }, after: { agentBackend: 'pi' } });
    const page = await (await r.get('/settings?ok=saved')).text();
    expect(page).toContain('设置已保存'); expect(page).toContain('与 .env 不同'); expect(page).toContain('agentBackend');
    const bad = await r.post('/settings', { _csrf: r.csrf, agentBackend: 'codex', backendOverrides: 'evil=pi<script>', codexReplyMode: 'relay', codexReasoningEffort: 'high' });
    expect(bad.status).toBe(400);
    const html = await bad.text(); expect(html).toContain('覆盖表'); expect(html).not.toContain('<script>');
    const badEnum = await r.post('/settings', { _csrf: r.csrf, agentBackend: 'gpt', backendOverrides: '', codexReplyMode: 'relay', codexReasoningEffort: 'high' });
    expect(badEnum.status).toBe(400);
    expect(r.settings.current().agentBackend).toBe('pi');
  });

  it('agent.md 可在设置页编辑：原子写入、规范换行、大小上限，并记录事件', async () => {
    const r = await rig();
    const res = await r.post('/settings/agent-md', { _csrf: r.csrf, content: '新的系统提示\r\n第二行' });
    expect(res.status).toBe(303);
    expect(readFileSync(path.join(r.dir, 'prompts', 'agent.md'), 'utf8')).toBe('新的系统提示\n第二行');
    expect(r.store.events(SETTINGS_TICKET).some(e => e.stage === 'prompt_changed')).toBe(true);
    expect((await r.post('/settings/agent-md', { _csrf: r.csrf, content: 'x'.repeat(70_000) })).status).toBe(400);
    expect((await r.post('/settings/agent-md', { _csrf: r.csrf, content: '   ' })).status).toBe(400);
    expect(readFileSync(path.join(r.dir, 'prompts', 'agent.md'), 'utf8')).toBe('新的系统提示\n第二行');
    expect(await (await r.get('/settings')).text()).toContain('新的系统提示');
  });

  it('重置线程：校验键、调用后端、记录事件并带结果跳回', async () => {
    const r = await rig();
    const res = await r.post('/codex/reset', { _csrf: r.csrf, key: 'shared' });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/codex?ok=reset');
    expect(r.resetCodex).toHaveBeenCalledWith('shared');
    expect((await r.post('/codex/reset', { _csrf: r.csrf, key: 'owner' })).headers.get('location')).toBe('/codex?ok=unchanged');
    expect((await r.post('/codex/reset', { _csrf: r.csrf, key: 'group:7' })).status).toBe(400);
    const pi = await r.post('/pi/reset', { _csrf: r.csrf, key: 'group:7' });
    expect(pi.headers.get('location')).toBe('/pi?ok=reset'); expect(r.resetPi).toHaveBeenCalledWith('group:7');
    expect((await r.post('/pi/reset', { _csrf: r.csrf, key: '../x' })).status).toBe(400);
    const ev = r.store.events('@codex').find(e => e.stage === 'thread_reset')!;
    expect(JSON.parse(ev.detail_json)).toMatchObject({ source: 'dashboard', thread_key: 'shared', archived: 'thread-old' });
    // 进行中的回合：1.5 秒内未完成则提示已排队
    let release!: () => void;
    r.resetCodex.mockImplementationOnce(() => new Promise(res => { release = () => res('thread-busy'); }));
    const queued = await r.post('/codex/reset', { _csrf: r.csrf, key: 'shared' });
    expect(queued.headers.get('location')).toBe('/codex?ok=queued');
    release();
    expect(await (await r.get('/codex?ok=queued')).text()).toContain('已排队');
  });
});

describe('实时视图', () => {
  it('SSE 推送在途票据：假 codex 的 JSONL 工具事件在回合进行中到达；卡片脱敏；完成后收起', async () => {
    const r = await rig();
    const secret = 'live-card-secret-7788';
    registerSecrets([secret]);
    const sse = await r.get('/live/stream');
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    const dir = r.dir;
    const runner = new CodexRunner({ command: [process.execPath, path.join(FIXTURES, 'fake-codex.mjs')], codexHome: path.join(dir, 'codex'), workspaceDir: path.join(dir, 'ws'),
      threadsFile: path.join(dir, 'codex-threads.json'), sandbox: 'workspace-write', timeoutMs: 20_000,
      env: { FAKE_CODEX_SLEEP_MS: '1500', FAKE_CODEX_TOOL_EVENTS: '1', FAKE_CODEX_THREAD: 'thread-live', FAKE_CODEX_TEXT: '好的' } });
    const backend = new CodexBackend({ runner, imagesDir: path.join(dir, 'images'), ticketsDir: path.join(dir, 'tickets'), reasoningEffort: () => r.settings.current().codexReasoningEffort });
    trace.event('tk-live', 'received', { scope: 'group:7', detail: { text: `帮我查一下 ${secret}`, sender: '小红', message_id: '1' } });
    trace.event('tk-live', 'routed', { detail: { route: 'agent' } });
    trace.event('tk-live', 'dispatched', { detail: { attempts: 1 } });
    const turn = trace.span('tk-live', 'backend:codex', () => backend.handle({ ticket: 'tk-live', scope: 'group:7', access: 'group:7', threadKey: 'shared', text: '帮我查一下',
      source: { type: 'group', user_id: '1', group_id: '7', nickname: '小红' } }, { signal: new AbortController().signal, onEvent: () => {} }), { backend: 'codex' });
    let settled = false; void turn.then(() => { settled = true; });
    const during = await readUntil(sse, t => frames(t, 'card').some(f => f.item.stage === 'tool:command_execution' && f.item.status === 'started') && frames(t, 'card').some(f => f.item.stage === 'tool:qq_recent' && f.item.status === 'started'));
    expect(settled).toBe(false); // 回合仍在进行
    const cards = frames(during, 'card');
    const last = cards.at(-1)!.card as LiveCard;
    expect(last).toMatchObject({ ticket: 'tk-live', scope: 'group:7', route: 'agent', backend: 'codex', state: 'running', sender: '小红' });
    expect(['tool:qq_recent', 'tool:command_execution']).toContain(last.phase);
    expect(cards.find(f => f.item.stage === 'tool:command_execution')!.item.summary).toContain('ls /workspace');
    expect(frames(during, 'snapshot')).toHaveLength(1);
    expect(during).not.toContain(secret); expect(during).toContain('[已隐藏]');
    // 服务端渲染的 /live 同样脱敏，并显示当前阶段
    const html = await (await r.get('/live')).text();
    expect(html).toContain('data-ticket="tk-live"'); expect(html).toContain('当前：'); expect(html).not.toContain(secret);
    await turn;
    trace.event('tk-live', 'reply_sent', { detail: { terminal: true, reply: '好的' } });
    const card = r.live.snapshot().find(c => c.ticket === 'tk-live')!;
    expect(card).toMatchObject({ state: 'done', outcome: 'reply_sent', phase: '' });
    expect(card.finished).not.toBeNull();
    expect(card.items.map(i => i.stage)).toEqual(expect.arrayContaining(['thread_wait', 'model_turn', 'model_usage', 'tool:qq_recent']));
    const after = await (await r.get('/live')).text();
    expect(after).toMatch(/<details data-ticket="tk-live">[\s\S]*href="\/tickets\/tk-live"/);
  }, 20_000);

  it('快照分帧并等待 drain：5 张 × 80 事件的大快照完整送达慢读者；超过 100 张卡片也不丢', async () => {
    const r = await rig();
    for (let c = 0; c < 5; c++) {
      trace.event(`big-${c}`, 'received', { scope: 'group:7', detail: { text: '大卡片' } });
      for (let i = 0; i < 90; i++) trace.event(`big-${c}`, 'tool:command_execution', { detail: { command: `第${i}步 ` + '长命令'.repeat(60) } });
    }
    for (let c = 0; c < 120; c++) trace.event(`small-${c}`, 'received', { scope: 'private:5', detail: { text: `小卡片 ${c}` } });
    const raw = r.live.snapshot();
    expect(raw).toHaveLength(125);
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(200_000);
    // 慢读者：连接后 1.5 秒不读，服务端写缓冲必然返回 false
    const { request } = await import('node:http');
    const text = await new Promise<string>((resolve, reject) => {
      const req = request(r.base + '/live/stream', { headers: { Cookie: 'obs_token=' + encodeURIComponent(TOKEN) } }, res => {
        res.pause(); let body = '';
        setTimeout(() => { res.setEncoding('utf8'); res.on('data', (d: string) => { body += d; if (body.includes('event: snapshot_end\n')) { resolve(body); req.destroy(); } }); res.resume(); }, 1500);
        res.on('error', reject); res.on('close', () => { if (!body.includes('event: snapshot_end\n')) reject(new Error('连接被断开：' + body.length)); });
      });
      req.on('error', reject); req.end();
    });
    expect(frames(text, 'snapshot')[0]).toMatchObject({ count: 125 });
    const cards = frames(text, 'snapcard').map(f => f.card as LiveCard);
    expect(cards).toHaveLength(125);
    expect(new Set(cards.map(c => c.ticket)).size).toBe(125);
    for (const c of cards.filter(c => c.ticket.startsWith('big-'))) {
      expect(c.items).toHaveLength(80);
      expect(c.items.at(-1)!.seq).toBe(91);
    }
    expect(frames(text, 'snapshot_end')[0]).toMatchObject({ count: 125 });
  }, 20_000);

  it('SSE 写队列：读者长期不读时，超过待写上限或 drain 超时才断开', async () => {
    const { request } = await import('node:http');
    const run = (maxPending: number, drainMs: number, total: number) => new Promise<{ closedAfter: number }>(resolve => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
        const out = sseWriter(res, maxPending, drainMs); const t0 = Date.now();
        res.on('close', () => { resolve({ closedAfter: Date.now() - t0 }); server.closeAllConnections(); server.close(); });
        const frame = 'data: ' + 'x'.repeat(16 * 1024) + '\n\n';
        for (let sent = 0; sent < total; sent += frame.length) out.send(frame);
      });
      server.listen(0, '127.0.0.1', () => {
        const req = request(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, res => res.pause());
        req.on('error', () => undefined); req.end();
      });
    });
    // 待写字节超过上限：立即断开
    expect((await run(256 * 1024, 60_000, 8 * 1024 * 1024)).closedAfter).toBeLessThan(1000);
    // 未超上限但读者一直不读：drain 等待超时后断开
    const slow = await run(64 * 1024 * 1024, 300, 8 * 1024 * 1024);
    expect(slow.closedAfter).toBeGreaterThanOrEqual(250);
    expect(slow.closedAfter).toBeLessThan(5000);
  }, 20_000);
});
