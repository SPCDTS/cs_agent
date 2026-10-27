import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboard } from '../../src/obs/http.js';
import { agentMdRevision } from '../../src/obs/dashboard-io.js';
import { csrfToken, sseWriter } from '../../src/obs/http-util.js';
import { ObsStore } from '../../src/obs/store.js';
import { trace } from '../../src/shared/trace.js';
import { log } from '../../src/shared/log.js';
import { LiveBus, type ConversationHead, type LiveConversation } from '../../src/obs/live.js';
import { registerSecrets } from '../../src/shared/redact.js';
import { ContextStore } from '../../src/context/store.js';
import { loadConfig } from '../../src/config.js';
import { SettingsStore, SETTINGS_KEY, type RuntimeSettings, type SettingsValidators } from '../../src/agent/settings.js';
import { DEFAULT_SEND_RULES } from '../../src/channel/send-rules.js';
import type { DashboardOptions } from '../../src/obs/dashboard-types.js';
import { REASONING_EFFORTS } from '../../src/agent/codex/runner.js';
import { CodexBackend } from '../../src/agent/backends/codex.js';
import { CodexScript, codexRunnerRig } from '../agent/codex-fixture.js';
import { ContextUsageStub } from './fixtures/context-usage-stub.js';
import { CodexPromptStub } from './fixtures/codex-prompt-stub.js';
import { dispatchSettingsLine, type ModelCatalogView } from '../../src/obs/ui/dashboard-pages.js';

const clean: (() => unknown)[] = [];
afterEach(async () => { trace.attach(undefined); for (const fn of clean.splice(0).reverse()) await fn(); });
const TOKEN = 'fake-dashboard-token-0123456789';
const defaults: RuntimeSettings = { codexModel: 'codex/gpt-6.1-sol', piModel: 'deepseek-flash', piThinkingLevel: 'low', agentBackend: 'codex', backendOverrides: {}, codexReasoningEffort: 'high', alertOwner: false, sendRules: { ...DEFAULT_SEND_RULES }, memory: { extract: {}, consolidate: true }, history: { rawDays: {} } };

async function rig(extra: { validators?: SettingsValidators; contextUsage?: ContextUsageStub; codexPrompt?: CodexPromptStub | null; env?: NodeJS.ProcessEnv; modelCatalog?: ModelCatalogView; sendBreakers?: DashboardOptions['sendBreakers']; memoryExtract?: DashboardOptions['memoryExtract'] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-dash-'));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  trace.attach(store);
  const live = new LiveBus(trace);
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN, QQ_ALLOW_USERS: '1', ...extra.env });
  registerSecrets([TOKEN]);
  const settings = await SettingsStore.open(dir, defaults, trace, extra.validators);
  const resetCodex = vi.fn(async (key: string): Promise<string | null> => key === 'group:7' ? 'thread-old' : null);
  const resetPi = vi.fn(async () => 42);
  const compactCodex = vi.fn(async (key: string): Promise<'compacted' | 'unchanged'> => key === 'owner' ? 'unchanged' : 'compacted');
  const compactPi = vi.fn(async (_key: string): Promise<'compacted' | 'unchanged'> => 'compacted');
  const stopThread = vi.fn(async (_key: string) => {});
  mkdirSync(path.join(dir, 'codex'), { recursive: true }); writeFileSync(path.join(dir, 'codex', 'AGENTS.md'), '# 受管规则');
  const codexPrompt = extra.codexPrompt === null ? undefined : extra.codexPrompt ?? new CodexPromptStub();
  const dashboard = createDashboard({ config, store, context, settings, live, resetCodex, resetPi, compactCodex, compactPi, stopThread, contextUsage: extra.contextUsage, codexPrompt, modelCatalog: extra.modelCatalog, sendBreakers: extra.sendBreakers, memoryExtract: extra.memoryExtract,
    health: () => ({ bridge: { ws_connected: true, disconnect_count: 2 }, codex: { ok: false }, deepseek_key_present: true }),
    queue: () => ({ active: 1, slots: 2, waiting: 1, scopes: { 'group:7': 1 } }),
    codex: async () => [{ thread_key: 'owner', thread_id: null, rollout_bytes: null, observed_turns: 0 }, { thread_key: 'group:7', thread_id: 'thread-old', rollout_bytes: 2_500_000, observed_turns: 3 }],
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
  return { dir, store, live, settings, base, get, post, resetCodex, resetPi, compactCodex, compactPi, stopThread, codexPrompt, close: () => dashboard.close(), csrf: csrfToken(TOKEN) };
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
const revisionOf = async (r: { get: (url: string) => Promise<Response> }) =>
  /action="\/settings\/agent-md"[^]*?name="revision" value="([^"]+)"/.exec(await (await r.get('/settings')).text())![1]!;
const frames = (text: string, event: string) => text.split('\n\n').filter(f => f.startsWith(`event: ${event}\n`)).map(f => JSON.parse(f.slice(f.indexOf('data: ') + 6)));

describe('面板二期页面', () => {
  it.each(['magpie', 'openai'])('设置页只读显示 codex 提供者 %s，不显示 gateway key', async provider => {
    const r = await rig({ env: { CODEX_PROVIDER: provider, CODEX_MAGPIE_URL: 'http://gateway.example:3425/v1', CODEX_MAGPIE_KEY: 'test-dashboard-magpie-key' } });
    const html = await (await r.get('/settings')).text();
    expect(html).toContain(provider === 'magpie' ? 'codex：经 magpie（http://gateway.example:3425/v1）' : 'codex：直连');
    expect(html).not.toContain('test-dashboard-magpie-key');
    expect(html).not.toMatch(/name="CODEX_(PROVIDER|MAGPIE_URL|MAGPIE_KEY)"/);
  });
  it.each(['magpie', 'deepseek'])('设置页只读显示 pi 出站 %s，保留 DeepSeek 密钥灯', async provider => {
    const r = await rig({ env: { AGENT_MODEL_PROVIDER: provider, CODEX_PROVIDER: 'openai',
      CODEX_MAGPIE_URL: 'http://pi-gateway.example:3425/v1', CODEX_MAGPIE_KEY: 'test-pi-dashboard-key' } });
    const response = await r.get('/settings');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(provider === 'magpie' ? 'pi：magpie（http://pi-gateway.example:3425/v1）' : 'pi：直连 ' + provider);
    expect(html).toContain('codex：直连');
    expect(html).not.toContain('test-pi-dashboard-key');
    expect(html).not.toMatch(/name="(AGENT_MODEL_PROVIDER|CODEX_MAGPIE_URL|CODEX_MAGPIE_KEY)"/);
    expect(await (await r.get('/')).text()).toContain('DeepSeek 密钥');
  });
  it('所有页面 200，含设计令牌（深浅色）、导航高亮和关键元素；无内联 style 属性与外部资源', async () => {
    const r = await rig();
    trace.event('turn:pi:7:1', 'received', { scope: 'group:7', detail: { text: '在途消息', sender: '小明', thread_key: 'group:7', kind: 'user' } });
    for (const [url, marks] of Object.entries({
      '/': ['运行总览', '依赖状态', 'class="lamps"', '并发槽位', '工作中 1 个会话 · 排队输入 0 条 · <a href="/live">'],
      '/live': ['实时会话', 'id="convs"', 'src="/assets/live.js"', 'data-thread="group:7"', '群 7', '在途消息', 'action="/thread/stop"', 'name="return" value="/live"'],
      '/turns': ['回合', 'class="chat-layout"', 'href="/turns?thread=group%3A7" aria-current="page"', '在途消息', 'href="/turns/pi%3A7%3A1"', 'src="/assets/chat.js"'],
      '/turns/pi%3A7%3A1': ['回合详情', '在途消息', '小明', 'href="/conversations/group%3A7"', '时间线'],
      '/conversations/group%3A7': ['群 7', '最近回合', 'href="/turns/pi%3A7%3A1"', 'action="/thread/stop"'],
      '/logs': ['实时日志', 'src="/assets/logs.js"'],
      '/context': ['上下文检索', 'href="/memory"'],
      '/context-usage': ['上下文监控', 'name="limit"'],
      '/agents': ['Agent', 'action="/codex/reset"', 'action="/pi/reset"', 'action="/thread/stop"', '群 7', 'href="/codex/agents-md"', 'href="/agents/codex/sessions"', 'href="/agents/pi/sessions"'],
      '/memory': ['记忆', '聊天记录整理', 'href="/memory/search"', 'href="/memory/archives"'],
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
      expect(html).not.toContain('codexReplyMode');
      const nonce = /<style nonce="([^"]+)"/.exec(html)![1]!;
      expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
      for (const m of html.matchAll(/<script[^>]*>/g)) expect(m[0]).toContain(`nonce="${nonce}"`);
      const navOf: Record<string, string> = { '/logs': '/settings', '/config': '/settings', '/context': '/memory', '/turns/pi%3A7%3A1': '/turns', '/conversations/group%3A7': '/live' };
      if (url !== '/') expect(html).toContain(`href="${navOf[url] ?? url}" aria-current="page"`);
      expect(html).toMatch(/<nav class="tabs"[^>]*><a href="\/"[^>]*>总览<\/a><a href="\/agents"[^>]*>Agent<\/a><a href="\/memory"[^>]*>记忆<\/a><a href="\/context-usage"[^>]*>上下文监控<\/a><a href="\/turns"[^>]*>回合<\/a><a href="\/live"[^>]*>(<i[^>]*><\/i>)?实时<\/a><a href="\/schedules"[^>]*>定时任务<\/a><a href="\/skills"[^>]*>技能<\/a><a href="\/mcp\/accounts"[^>]*>外部账号<\/a><a href="\/settings"[^>]*>设置<\/a><\/nav>/);
    }
    // 去重：总览不再列在途卡片（只给计数，详情在实时页）；设置页不再有"线程"区块（重置/压缩在 Agent 页）。
    const home = await (await r.get('/')).text();
    expect(home).not.toContain('在途消息'); expect(home).not.toContain('<h2>现在');
    const settingsHtml = await (await r.get('/settings')).text();
    expect(settingsHtml).not.toContain('<h2>线程</h2>'); expect(settingsHtml).not.toContain('重置会归档当前会话');
    for (const asset of ['live.js', 'logs.js', 'forms.js', 'agents.js']) {
      const res = await r.get('/assets/' + asset);
      expect(res.status).toBe(200); expect(res.headers.get('content-type')).toContain('text/javascript');
      const js = await res.text(); expect(js).not.toContain('innerHTML'); expect(js).not.toMatch(/setInterval\([^)]*fetch/);
    }
    expect((await r.get('/assets/../http.ts')).status).toBe(404);
    expect((await r.get('/nope')).status).toBe(404);
  });

  it('旧票据页：列表与详情 301 到回合 / 输入 / 会话页；旧版键（入站键）的事件在输入页显示，不进回合列表与实时页', async () => {
    const r = await rig();
    trace.event('legacy', 'received', { detail: { text: '旧票据' } });
    trace.event('legacy', 'model_turn', { status: 'ok', durationMs: 20,
      detail: { operation: 'relay', provider: 'deepseek', model: 'legacy-model', input_tokens: 100, output_tokens: 20 } });
    trace.event('legacy', 'reply_sent', { detail: { terminal: true, reply: '原文' } });
    const go = async (url: string) => { const res = await r.get(url, { redirect: 'manual' }); return [res.status, res.headers.get('location')]; };
    expect(await go('/tickets')).toEqual([301, '/turns']);
    expect(await go('/tickets/legacy')).toEqual([301, '/inputs/legacy']);
    expect(await go('/tickets/' + encodeURIComponent('turn:pi:1:2'))).toEqual([301, '/turns/pi%3A1%3A2']);
    expect(await go('/tickets/' + encodeURIComponent('in:abc'))).toEqual([301, '/inputs/abc']);
    expect(await go('/tickets/' + encodeURIComponent('thr:group:7'))).toEqual([301, '/conversations/group%3A7']);
    expect((await r.get('/tickets/%40settings', { redirect: 'manual' })).status).toBe(404);
    const res = await r.get('/tickets/legacy'), html = await res.text();
    expect(res.status).toBe(200); expect(res.url).toContain('/inputs/legacy');
    expect(html).toContain('输入 100 / 输出 20 tokens'); expect(html).toContain('旧票据'); expect(html).toContain('含旧版票据记录');
    expect(r.store.turns()).toEqual([]);
    expect(await (await r.get('/live')).text()).not.toContain('旧票据');
    for (const url of ['/inputs/%40settings', '/inputs/missing', '/turns/missing', '/conversations/bad', '/conversations/group%3Aabc']) expect((await r.get(url)).status, url).toBe(404);
  });

  it('回合页：输入、发送、工具、子 agent、错误与时间线；输入页链回所在回合；进行中的回合可停止', async () => {
    const r = await rig();
    trace.event('in:k1', 'received', { scope: 'group:7', detail: { text: '帮我查天气', sender: '小明' } });
    trace.event('in:k1', 'queued', { scope: 'group:7', detail: { thread_key: 'group:7', kind: 'user', result: 'queued' } });
    trace.event('in:k1', 'admitted', { scope: 'group:7', detail: { thread_key: 'group:7', settings: { backend: 'pi', piModel: 'deepseek-flash', piThinkingLevel: 'low', codexReasoningEffort: 'high', effortSource: 'fixed' } } });
    trace.event('turn:pi:7:9', 'dispatched', { scope: 'group:7', detail: { backend: 'pi', conversation_key: 'group:7', kind: 'user', inputs: ['k1'] } });
    trace.event('in:k1', 'delivered', { detail: { turn: 'pi:7:9' } });
    trace.event('turn:pi:7:9', 'received', { scope: 'group:7', detail: { text: '帮我查天气', sender: '小明', thread_key: 'group:7', kind: 'user', inputs: ['k1'] } });
    trace.event('in:k2', 'received', { scope: 'group:7', detail: { text: '顺便看看明天', sender: '小明' } });
    trace.event('turn:pi:7:9', 'steered', { detail: { inputs: ['k2'], text: '顺便看看明天' } });
    trace.event('turn:pi:7:9', 'tool:web_search', { status: 'started', detail: { backend: 'pi', input: { query: '天气' } } });
    trace.event('turn:pi:7:9', 'tool:web_search', { durationMs: 1200, detail: { backend: 'pi' } });
    trace.event('turn:pi:7:9', 'tool:subagent', { durationMs: 5, detail: { backend: 'pi', input: { action: 'spawn', name: 'researcher' } } });
    trace.event('turn:pi:7:9', 'tool:read', { status: 'failed', durationMs: 3, detail: { backend: 'pi', error: '没有这个文件' } });
    trace.event('turn:pi:7:9', 'send_message', { detail: { target: 'qq:group:7', text: '晴，25 度', status: 'sent', message_id: '501', system: false } });
    const live = r.live.snapshot().find(c => c.thread === 'group:7')!;
    expect(live.turn).toMatchObject({ id: 'pi:7:9', kind: 'user', sender: '小明', tools: 3 });
    expect(live.turn!.inputs.map(i => [i.key, i.text])).toEqual([['k1', '帮我查天气'], ['k2', '顺便看看明天']]);
    let html = await (await r.get('/turns/pi%3A7%3A9')).text();
    expect(html).toContain('进行中'); expect(html).toContain('action="/thread/stop"'); expect(html).toContain('name="return" value="/conversations/group%3A7"');
    expect(html).toContain('<h2>输入 <small>2 条');
    expect(html).toContain('href="/inputs/k1"'); expect(html).toContain('帮我查天气'); expect(html).toContain('顺便看看明天');
    expect(html).toContain('Pi · deepseek-flash · low');
    expect(html).toContain('<h2>发送 <small>1 条'); expect(html).toContain('晴，25 度'); expect(html).toContain('qq:group:7');
    expect(html).toContain('<h2>工具调用 <small>3 次'); expect(html).toContain('web_search');
    expect(html).toContain('<h2>子 agent 活动 <small>1 条'); expect(html).toContain('researcher');
    expect(html).toContain('<h2>错误 <small>1 条'); expect(html).toContain('没有这个文件');
    expect(html).toContain('<h2>时间线');
    trace.event('turn:pi:7:9', 'reply_sent', { detail: { terminal: true, status: 'completed', kind: 'user', thread_key: 'group:7', inputs: ['k1', 'k2'] } });
    html = await (await r.get('/turns/pi%3A7%3A9')).text();
    expect(html).toContain('已完成'); expect(html).not.toContain('action="/thread/stop"');
    const input = await (await r.get('/inputs/k1')).text();
    expect(input).toContain('帮我查天气'); expect(input).toContain('href="/turns/pi%3A7%3A9"'); expect(input).toContain('Pi · deepseek-flash · low');
    const conv = await (await r.get('/conversations/group%3A7')).text();
    expect(conv).toContain('href="/turns/pi%3A7%3A9"'); expect(conv).toContain('已完成'); expect(conv).not.toContain('action="/thread/stop"');
    expect(r.live.snapshot().find(c => c.thread === 'group:7')).toMatchObject({ state: 'idle', turn: null, recent: [expect.objectContaining({ id: 'pi:7:9', outcome: 'completed' })] });
    // 聊天视图：输入（含插话）在左、发送在右，回合详情折叠在两者之间，展开时读 part=1 片段。
    const chat = await (await r.get('/turns?thread=group%3A7')).text();
    const turn = chat.slice(chat.indexOf('id="turn-pi:7:9"'));
    expect(turn).toMatch(/class="bubble in"><div class="b-who"><b>小明<\/b>[^]*帮我查天气/);
    expect(turn.indexOf('帮我查天气')).toBeLessThan(turn.indexOf('顺便看看明天'));
    expect(turn.indexOf('顺便看看明天')).toBeLessThan(turn.indexOf('class="chat-meta"'));
    expect(turn.indexOf('class="chat-meta"')).toBeLessThan(turn.indexOf('class="bubble out"'));
    expect(turn).toMatch(/<details class="chat-meta" data-src="\/turns\/pi%3A7%3A9\?part=1"><summary><span class="stamp s-ok">已完成<\/span>/);
    expect(turn).toContain('Pi · deepseek-flash · low'); expect(turn).toContain('工具 3'); expect(turn).toContain('发送 1');
    expect(turn).not.toContain('<details class="chat-meta" data-src="/turns/pi%3A7%3A9?part=1" open');
    const part = await r.get('/turns/pi%3A7%3A9?part=1');
    expect(part.status).toBe(200);
    const partHtml = await part.text();
    expect(partHtml).not.toContain('<html'); expect(partHtml).toContain('<h2>工具调用 <small>3 次'); expect(partHtml).toContain('<h2>时间线');
  });

  it('回合页是聊天视图：会话按最近活动排列，定时任务标出，更早的回合按页加载；深链接仍是完整页面', async () => {
    const r = await rig();
    const t0 = Date.now() - 3600_000 * 60;
    for (let i = 0; i < 52; i++) {
      const key = `turn:pi:7:${100 + i}`;
      trace.event(key, 'dispatched', { ts: t0 + i * 60_000, scope: 'group:7', detail: { backend: 'pi', conversation_key: 'group:7', kind: 'user', inputs: [] } });
      trace.event(key, 'received', { ts: t0 + i * 60_000 + 1, scope: 'group:7', detail: { text: `第 ${i} 条 <b>`, sender: '小明', thread_key: 'group:7', kind: 'user' } });
      trace.event(key, 'reply_sent', { ts: t0 + i * 60_000 + 2, detail: { terminal: true, status: 'completed', thread_key: 'group:7', kind: 'user' } });
    }
    trace.event('turn:pi:9:1', 'dispatched', { scope: 'owner', detail: { backend: 'pi', conversation_key: 'owner', kind: 'scheduled', inputs: ['run_abc'] } });
    trace.event('turn:pi:9:1', 'received', { scope: 'owner', detail: { text: '[定时任务] 早报', sender: '1', thread_key: 'owner', kind: 'scheduled', inputs: ['run_abc'] } });
    trace.event('turn:pi:9:1', 'send_rejected', { scope: 'owner', detail: { target: 'qq:private:1', error: '超出每分钟限额' } });
    trace.event('turn:pi:9:1', 'reply_sent', { detail: { terminal: true, status: 'completed', thread_key: 'owner', kind: 'scheduled' } });

    const html = await (await r.get('/turns')).text();
    const nav = html.slice(html.indexOf('class="chat-convs'), html.indexOf('</nav>', html.indexOf('class="chat-convs')));
    expect(nav.indexOf('owner 私聊')).toBeLessThan(nav.indexOf('群 7'));
    expect(html).toContain('href="/turns?thread=owner" aria-current="page"');
    expect(html).toMatch(/class="bubble in sched"><div class="b-who"><span class="stamp s-queue">定时任务<\/span>/);
    expect(html).toContain('<span class="pill">定时任务</span>');
    expect(html).toMatch(/class="bubble out failed"><div class="b-who"><span class="stamp s-fail">被规则拒绝<\/span>[^]*超出每分钟限额/);
    expect(html).toContain('已到最早的回合');

    const group = await (await r.get('/turns?thread=group%3A7')).text();
    expect(group).toContain('href="/turns?thread=group%3A7&amp;page=1">加载更早的回合');
    expect(group).toContain('第 51 条 &lt;b&gt;'); expect(group).not.toContain('第 1 条 &lt;b&gt;'); expect(group).not.toContain('<b>第');
    expect(group.indexOf('第 2 条')).toBeLessThan(group.indexOf('第 51 条'));
    const older = await (await r.get('/turns?thread=group%3A7&page=1&part=1')).text();
    expect(older).not.toContain('<html'); expect(older).toContain('第 0 条'); expect(older).toContain('第 1 条'); expect(older).toContain('已到最早的回合');
    expect(await (await r.get('/turns?thread=group%3A7&page=5&part=1')).text()).toBe('');

    for (const url of ['/turns/pi%3A7%3A100', '/turns/pi%3A9%3A1', '/conversations/owner']) {
      const res = await r.get(url);
      expect(res.status, url).toBe(200); expect(await res.text(), url).toContain('<html');
    }
  });

  it('写操作要求 cookie 会话与 CSRF 令牌；跨站来源、错误令牌与 URL 口令都被拒绝', async () => {
    const r = await rig();
    const ok = { _csrf: r.csrf, agentBackend: 'pi', backendOverrides: '', codexReasoningEffort: 'high' };
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
    expect((await r.post('/codex/reset', { key: 'group:7' })).status).toBe(403);
    expect(r.resetCodex).not.toHaveBeenCalled();
  });

  it('设置页使用 same-origin Referrer-Policy，保留浏览器同源表单的 Origin', async () => {
    const r = await rig();
    const res = await r.get('/settings');
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('Origin 为 null 且 Sec-Fetch-Site 为 same-origin 时允许有效 CSRF 表单，仍拒绝无效令牌', async () => {
    const r = await rig();
    const ok = { _csrf: r.csrf, agentBackend: 'pi', backendOverrides: '', codexReasoningEffort: 'high' };
    const headers = { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };
    expect((await r.post('/settings', { ...ok, _csrf: '' }, headers)).status).toBe(403);
    expect(r.settings.current().agentBackend).toBe('codex');
    const res = await r.post('/settings', ok, headers);
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/settings?ok=saved');
    expect(r.settings.current().agentBackend).toBe('pi');
    expect((await r.post('/settings', ok, { ...headers, Origin: 'http://evil.example' })).status).toBe(403);
  });

  it.each([undefined, 'cross-site', 'same-site', 'none'])('Origin 为 null 且 Sec-Fetch-Site 为 %s 时拒绝写入', async site => {
    const r = await rig();
    const ok = { _csrf: r.csrf, agentBackend: 'pi', backendOverrides: '', codexReasoningEffort: 'high' };
    const headers: Record<string, string> = { Origin: 'null' };
    if (site !== undefined) headers['Sec-Fetch-Site'] = site;
    const res = await r.post('/settings', ok, headers);
    expect(res.status).toBe(403); expect(await res.text()).toBe('跨站请求被拒绝');
    expect(r.settings.current().agentBackend).toBe('codex');
  });

  it('发送规则单独保存并校验；熔断列表可逐项解除并记录变更', async () => {
    const breakers = [{ scope: 'group:7', until: Date.UTC(2026, 9, 21, 5), tripped_at: Date.UTC(2026, 9, 21, 4), reason: '每小时超过 60 条' },
      { scope: 'global', until: Date.UTC(2026, 9, 21, 4, 10), tripped_at: Date.UTC(2026, 9, 21, 4), reason: '全局每分钟超过 30 条' }];
    const reset = vi.fn((scope: string) => { const i = breakers.findIndex(b => b.scope === scope); if (i < 0) return false; breakers.splice(i, 1); return true; });
    const r = await rig({ sendBreakers: { list: () => [...breakers], reset } });
    const html = await (await r.get('/settings')).text();
    expect(html).toContain('id="send-rules"'); expect(html).toContain('name="perChatMinute" value="6"');
    expect(html).toContain('action="/settings/send-breakers/reset"'); expect(html).toContain('value="group:7"'); expect(html).toContain('全部会话');
    const fields = { _csrf: r.csrf, perChatMinute: '8', perChatHour: '80', chatBreakerMinutes: '30', globalMinute: '40', globalBreakerMinutes: '5' };
    const res = await r.post('/settings/send-rules', fields);
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/settings?ok=saved#send-rules');
    expect(r.settings.current().sendRules).toEqual({ perChatMinute: 8, perChatHour: 80, chatBreakerMinutes: 30, globalMinute: 40, globalBreakerMinutes: 5 });
    for (const bad of [{ perChatMinute: '0' }, { perChatHour: '' }, { globalMinute: '1.5' }, { globalBreakerMinutes: 'abc' }]) {
      const res400 = await r.post('/settings/send-rules', { ...fields, ...bad });
      expect(res400.status).toBe(400); expect(await res400.text()).toContain('发送规则未保存');
    }
    expect(r.settings.current().sendRules.perChatMinute).toBe(8);
    expect((await r.post('/settings/send-breakers/reset', { scope: 'group:7' })).status).toBe(403);
    expect(reset).not.toHaveBeenCalled();
    const ok = await r.post('/settings/send-breakers/reset', { _csrf: r.csrf, scope: 'group:7' });
    expect(ok.status).toBe(303); expect(ok.headers.get('location')).toBe('/settings?ok=breakerReset#send-rules');
    expect(reset).toHaveBeenCalledWith('group:7'); expect(breakers.map(b => b.scope)).toEqual(['global']);
    expect((await r.post('/settings/send-breakers/reset', { _csrf: r.csrf, scope: 'group:7' })).status).toBe(409);
    expect(JSON.parse(r.store.events(SETTINGS_KEY).find(e => e.stage === 'send_breaker_reset')!.detail_json)).toEqual({ source: 'dashboard', scope: 'group:7' });
    const after = await (await r.get('/settings?ok=breakerReset')).text();
    expect(after).toContain('熔断已解除'); expect(after).toContain('解除发送熔断：'); expect(after).not.toContain('value="group:7"');
  });

  it('记忆抽取开关：每个出现过的命名空间一行，缺省只有 owner 勾选；保存只改表单列出的命名空间并校验口令', async () => {
    const status = { model: 'deepseek/deepseek-flash', available: true, queue: 2, running: 'pi:t9', daily_limit: 200,
      today: { date: '2026-10-26', counts: { owner: 3 } },
      recent: [{ turn_id: 'pi:t8', ns: 'owner', at: Date.now(), status: 'ok' as const, candidates: 2, written: 1, superseded: 0, dropped: { duplicate: 1 }, ms: 1200 },
        { turn_id: 'pi:t7', ns: 'group:7', at: Date.now(), status: 'skipped' as const, reason: 'too_short', candidates: 0, written: 0, superseded: 0, dropped: {} as Record<string, number>, ms: 1 }] };
    const r = await rig({ memoryExtract: { status: () => status, namespaces: () => ['group:7', 'private:5'] } });
    const html = await (await r.get('/settings')).text();
    expect(html).toContain('id="memory-extract"'); expect(html).toContain('action="/settings/memory-extract"');
    expect(html).toMatch(/name="extract:owner" checked/); expect(html).toMatch(/name="extract:group:7">/); expect(html).toMatch(/name="extract:private:5">/);
    expect((await r.post('/settings/memory-extract', { ns: 'group:7', 'extract:group:7': 'on' })).status).toBe(403);
    expect(r.settings.current().memory.extract).toEqual({});
    const res = await r.post('/settings/memory-extract', { _csrf: r.csrf, ns: 'group:7', 'extract:group:7': 'on' });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/settings?ok=saved#memory-extract');
    expect(r.settings.current().memory.extract).toEqual({ 'group:7': true });
    const body = new URLSearchParams([['_csrf', r.csrf], ['ns', 'owner'], ['ns', 'group:7']]).toString();
    const off = await r.get('/settings/memory-extract', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    expect(off.status).toBe(303);
    expect(r.settings.current().memory.extract).toEqual({ owner: false });
    const bad = await r.post('/settings/memory-extract', { _csrf: r.csrf, ns: 'group:abc', 'extract:group:abc': 'on' });
    expect(bad.status).toBe(400); expect(await bad.text()).toContain('抽取开关未保存');
    expect(JSON.parse((await (await r.get('/api/memory/extract')).text()))).toMatchObject({ queue: 2, running: 'pi:t9', today: { counts: { owner: 3 } } });
    const home = await (await r.get('/memory')).text();
    expect(home).toContain('记忆任务'); expect(home).toContain('href="/memory/jobs"'); expect(home).toContain('2 条排队'); expect(home).toContain('owner 私聊 3/200');
    expect(home).toContain('重复 1'); expect(home).toContain('材料过短'); expect(home).toContain('href="/turns/pi%3At8"');
  });

  it('聊天记录保留：每个出现过的会话一行；保存走口令，空为永不清理，与全局缺省相同的天数不保存', async () => {
    const r = await rig({ env: { HISTORY_RAW_DAYS: '30' }, memoryExtract: { status: () => ({}) as never, namespaces: () => ['group:7', 'private:5'] } });
    const html = await (await r.get('/settings')).text();
    expect(html).toContain('id="history-retention"'); expect(html).toMatch(/name="days:group:7" value="30"/);
    const body = new URLSearchParams([['_csrf', r.csrf], ['scope', 'group:7'], ['days:group:7', ''], ['scope', 'private:5'], ['days:private:5', '30']]).toString();
    const res = await r.get('/settings/history-retention', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/settings?ok=saved#history-retention');
    expect(r.settings.current().history.rawDays).toEqual({ 'group:7': 0 });
    expect(JSON.parse(await (await r.get('/api/memory')).text()).retention).toMatchObject({ rawDays: 30, overrides: { 'group:7': 0 } });
  });

  it('保存设置立即生效、落盘并记录事件；非法覆盖表返回 400 且不改动', async () => {
    const r = await rig();
    const res = await r.post('/settings', { _csrf: r.csrf, agentBackend: 'pi', backendOverrides: 'group:7=codex\nprivate:5=pi', codexReasoningEffort: 'low', alertOwner: 'on' },
      { Origin: r.base, 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/settings?ok=saved');
    expect(r.settings.current()).toEqual({ ...defaults, agentBackend: 'pi', backendOverrides: { 'group:7': 'codex', 'private:5': 'pi' }, codexReasoningEffort: 'low', alertOwner: true });
    expect(JSON.parse(readFileSync(path.join(r.dir, 'settings.json'), 'utf8')).settings.agentBackend).toBe('pi');
    const ev = r.store.events(SETTINGS_KEY).find(e => e.stage === 'settings_changed')!;
    expect(JSON.parse(ev.detail_json)).toMatchObject({ source: 'dashboard', before: { agentBackend: 'codex' }, after: { agentBackend: 'pi' } });
    const page = await (await r.get('/settings?ok=saved')).text();
    expect(page).toContain('设置已保存'); expect(page).toContain('与 .env 不同'); expect(page).toContain('agentBackend');
    const bad = await r.post('/settings', { _csrf: r.csrf, agentBackend: 'codex', backendOverrides: 'evil=pi<script>', codexReasoningEffort: 'high' });
    expect(bad.status).toBe(400);
    const html = await bad.text(); expect(html).toContain('覆盖表'); expect(html).not.toContain('<script>');
    const badEnum = await r.post('/settings', { _csrf: r.csrf, agentBackend: 'gpt', backendOverrides: '', codexReasoningEffort: 'high' });
    expect(badEnum.status).toBe(400);
    expect(r.settings.current().agentBackend).toBe('pi');
  });

  it('agent.md 可在设置页编辑：原子写入、规范换行、大小上限，并记录事件', async () => {
    const r = await rig();
    const res = await r.post('/settings/agent-md', { _csrf: r.csrf, revision: await revisionOf(r), content: '新的系统提示\r\n第二行' });
    expect(res.status).toBe(303);
    expect(readFileSync(path.join(r.dir, 'prompts', 'agent.md'), 'utf8')).toBe('新的系统提示\n第二行');
    expect(r.store.events(SETTINGS_KEY).some(e => e.stage === 'prompt_changed')).toBe(true);
    const rev = await revisionOf(r);
    expect((await r.post('/settings/agent-md', { _csrf: r.csrf, revision: rev, content: 'x'.repeat(70_000) })).status).toBe(400);
    expect((await r.post('/settings/agent-md', { _csrf: r.csrf, revision: rev, content: '   ' })).status).toBe(400);
    expect(readFileSync(path.join(r.dir, 'prompts', 'agent.md'), 'utf8')).toBe('新的系统提示\n第二行');
    expect(await (await r.get('/settings')).text()).toContain('新的系统提示');
  });

  it('agent.md 服务端守卫：当前文件含已注册秘密时拒绝覆盖（409）；过期或缺失的 revision 被拒绝', async () => {
    const r = await rig();
    const file = path.join(r.dir, 'prompts', 'agent.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '旧提示');
    const stale = await revisionOf(r);
    // 另一处修改（容器内编辑）：大小变化 → revision 不同
    writeFileSync(file, '容器内改过的提示');
    const conflict = await r.post('/settings/agent-md', { _csrf: r.csrf, revision: stale, content: '覆盖' });
    expect(conflict.status).toBe(409); expect(await conflict.text()).toContain('已在别处被修改');
    expect((await r.post('/settings/agent-md', { _csrf: r.csrf, content: '覆盖' })).status).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe('容器内改过的提示');
    // 文件里混入已注册秘密：页面不给表单，直接 POST（带正确 revision）也被拒
    const secret = 'agent-md-secret-99887766'; registerSecrets([secret]);
    writeFileSync(file, `提示 ${secret}`);
    const html = await (await r.get('/settings')).text();
    expect(html).not.toContain('action="/settings/agent-md"'); expect(html).not.toContain(secret);
    const st = statSync(file);
    const blocked = await r.post('/settings/agent-md', { _csrf: r.csrf, revision: agentMdRevision(st), content: '抹掉' });
    expect(blocked.status).toBe(409);
    const text = await blocked.text(); expect(text).toContain('凭据样式'); expect(text).not.toContain(secret);
    expect(readFileSync(file, 'utf8')).toBe(`提示 ${secret}`);
  });

  it.each(['codex', 'pi'] as const)('%s 压缩校验 cookie、CSRF、同源与线程键，成功跳回并记录事件', async backend => {
    const r = await rig(), route = '/' + backend + '/compact';
    const compact = backend === 'codex' ? r.compactCodex : r.compactPi;
    expect((await r.post(route, { key: 'group:7' })).status).toBe(403);
    const fields = { key: 'group:7', _csrf: r.csrf };
    expect((await r.post(route, fields, { Origin: 'https://other.example' })).status).toBe(403);
    expect((await r.post(route, fields, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await r.post(route + '?token=' + TOKEN, fields, { Cookie: '' })).status).toBe(401);
    for (const key of ['', 'shared', 'group:0', 'private:01', '../owner']) {
      expect((await r.post(route, { ...fields, key })).status).toBe(400);
    }
    expect(compact).not.toHaveBeenCalled();
    const response = await r.post(route, fields);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/agents?ok=compacted');
    expect(compact).toHaveBeenCalledWith('group:7');
    const event = r.store.events('@' + backend).find(e => e.stage === 'thread_compacted')!;
    expect(JSON.parse(event.detail_json)).toMatchObject({ source: 'dashboard', backend,
      [backend === 'codex' ? 'thread_key' : 'conversation_key']: 'group:7' });
    expect(await (await r.get('/agents?ok=compacted')).text()).toContain('会话已压缩');
    compact.mockResolvedValueOnce('unchanged');
    expect((await r.post(route, fields)).headers.get('location')).toBe('/agents?ok=unchanged');
    expect(r.store.events('@' + backend).filter(e => e.stage === 'thread_compacted')).toHaveLength(1);
  });

  it.each(['codex', 'pi'] as const)('%s 压缩快速失败显示错误提示，排队后失败仍记录日志', async backend => {
    const r = await rig(), route = '/' + backend + '/compact';
    const compact = backend === 'codex' ? r.compactCodex : r.compactPi;
    const errorLog = vi.spyOn(log, 'error');
    try {
      compact.mockRejectedValueOnce(new Error('secret-history'));
      const response = await r.post(route, { key: 'group:7', _csrf: r.csrf });
      expect(response.headers.get('location')).toBe('/agents?ok=compactFailed');
      const html = await (await r.get('/agents?ok=compactFailed')).text();
      expect(html).toContain('flash err');
      expect(html).toContain('会话压缩失败');
      expect(html).not.toContain('secret-history');
      let fail!: (error: Error) => void;
      compact.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
      const queued = await r.post(route, { key: 'group:7', _csrf: r.csrf });
      expect(queued.headers.get('location')).toBe('/agents?ok=compactQueued');
      expect(await (await r.get('/agents?ok=compactQueued')).text()).toContain('压缩已排队或正在执行');
      fail(new Error('secret-history'));
      await vi.waitFor(() => expect(errorLog).toHaveBeenCalledTimes(2));
      expect(errorLog).toHaveBeenLastCalledWith('dashboard thread compaction failed', { backend, key: 'group:7' });
      expect(r.store.events('@' + backend).filter(e => e.stage === 'thread_compacted')).toHaveLength(0);
    } finally { errorLog.mockRestore(); }
  });

  it('压缩按钮与重置并列，包含标题、线程键和 CSRF，未创建的线程无按钮', async () => {
    const r = await rig(), html = await (await r.get('/agents')).text();
    for (const backend of ['codex', 'pi']) {
      expect(html.match(new RegExp('action="/' + backend + '/compact"', 'g'))).toHaveLength(1);
      expect(html).toContain('action="/' + backend + '/reset"');
    }
    expect(html).toContain('title="保留摘要，清理旧工具输出与图片；等待当前回合结束"');
    expect(html).toContain('压缩会话</button>');
    expect(html).toContain('name="key" value="group:7"');
    expect(html).toContain('name="_csrf" value="' + r.csrf + '"');
  });

  it('重置线程：校验键、调用后端、记录事件并带结果跳回', async () => {
    const r = await rig();
    const res = await r.post('/codex/reset', { _csrf: r.csrf, key: 'group:7' });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/agents?ok=reset');
    expect(r.resetCodex).toHaveBeenCalledWith('group:7');
    expect((await r.post('/codex/reset', { _csrf: r.csrf, key: 'owner' })).headers.get('location')).toBe('/agents?ok=unchanged');
    expect((await r.post('/codex/reset', { _csrf: r.csrf, key: 'shared' })).status).toBe(400);
    expect((await r.post('/codex/reset', { _csrf: r.csrf, key: 'private:9' })).status).toBe(303);
    expect(r.resetCodex).toHaveBeenCalledWith('private:9');
    for (const key of ['group:0', 'private:01', '../owner']) expect((await r.post('/codex/reset', { _csrf: r.csrf, key })).status).toBe(400);
    const stop = await r.post('/thread/stop', { _csrf: r.csrf, key: 'group:7' });
    expect(stop.status).toBe(303); expect(stop.headers.get('location')).toBe('/agents?ok=stopped');
    expect(r.stopThread).toHaveBeenCalledWith('group:7');
    expect((await r.post('/thread/stop', { key: 'group:7' })).status).toBe(403);
    for (const key of ['shared', '../owner', 'group:0']) expect((await r.post('/thread/stop', { _csrf: r.csrf, key })).status).toBe(400);
    expect(r.stopThread).toHaveBeenCalledTimes(1);
    expect(await (await r.get('/agents?ok=stopped')).text()).toContain('已请求停止');
    // 停止后回到发起页：实时页与该会话页；其它返回地址（含别的会话、站外）一律回 Agent 页
    for (const [ret, location] of [['/live', '/live?ok=stopped'], ['/conversations/group%3A7', '/conversations/group%3A7?ok=stopped'],
      ['/conversations/group%3A8', '/agents?ok=stopped'], ['https://evil.example/', '/agents?ok=stopped']]) {
      expect((await r.post('/thread/stop', { _csrf: r.csrf, key: 'group:7', return: ret! })).headers.get('location')).toBe(location);
    }
    expect(await (await r.get('/live?ok=stopped')).text()).toContain('已请求停止');
    const pi = await r.post('/pi/reset', { _csrf: r.csrf, key: 'group:7' });
    expect(pi.headers.get('location')).toBe('/agents?ok=reset'); expect(r.resetPi).toHaveBeenCalledWith('group:7');
    expect((await r.post('/pi/reset', { _csrf: r.csrf, key: '../x' })).status).toBe(400);
    const ev = r.store.events('@codex').find(e => e.stage === 'thread_reset')!;
    expect(JSON.parse(ev.detail_json)).toMatchObject({ source: 'dashboard', thread_key: 'group:7', archived: 'thread-old' });
    // 进行中的回合：1.5 秒内未完成则提示已排队
    let release!: () => void;
    r.resetCodex.mockImplementationOnce(() => new Promise(res => { release = () => res('thread-busy'); }));
    const queued = await r.post('/codex/reset', { _csrf: r.csrf, key: 'group:7' });
    expect(queued.headers.get('location')).toBe('/agents?ok=queued');
    release();
    expect(await (await r.get('/agents?ok=queued')).text()).toContain('已排队');
    // 旧页面跳转到会话列表；重置表单仍在 /agents 卡片上（群会话已存在，owner 尚未创建不给按钮）
    for (const b of ['codex', 'pi']) { const old = await r.get('/' + b, { redirect: 'manual' }); expect(old.status).toBe(303); expect(old.headers.get('location')).toBe(`/agents/${b}/sessions`); }
    const agents = await (await r.get('/agents')).text();
    expect(agents.match(/action="\/codex\/reset"/g)).toHaveLength(1); expect(agents).toContain('name="key" value="group:7"'); expect(agents).toContain(`name="_csrf" value="${r.csrf}"`);
  });
});

describe('实时视图', () => {
  it('SSE 推送在途回合：常驻 app-server 的工具条目在回合进行中到达；卡片脱敏；完成后收起', async () => {
    const r = await rig();
    const secret = 'live-card-secret-7788';
    registerSecrets([secret]);
    const sse = await r.get('/live/stream');
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    const dir = r.dir;
    const script = new CodexScript();
    script.auto = false;
    script.onTurn = t => {
      t.child.notify('item/started', { threadId: t.threadId, turnId: t.turnId, item: { type: 'commandExecution', id: 'cmd-1', command: 'ls /workspace', status: 'inProgress' } });
      t.child.notify('item/started', { threadId: t.threadId, turnId: t.turnId, item: { type: 'mcpToolCall', id: 'exec-1', server: 'qq_context', tool: 'qq_recent', status: 'inProgress', arguments: { limit: 2 } } });
    };
    const live = await codexRunnerRig({ dir, handlers: script.handlers });
    const runner = live.runner;
    const turns = {
      records: () => [],
      render: async () => ({ text: '帮我查一下', images: [], source: { type: 'group' as const, user_id: '1', group_id: '7', nickname: '小红' } }),
      binding: (threadKey: string) => ({ threadKey, identity: { kind: 'user' as const, sender: '1' }, scope: 'group:7', inputs: [] }),
    };
    const backend = new CodexBackend({ runner, tokens: { issue: () => 'a'.repeat(64), revoke: () => undefined }, imagesDir: path.join(dir, 'images'), turns,
      reasoningEffort: () => r.settings.current().codexReasoningEffort });
    let finish!: () => void;
    const turn = new Promise<void>(resolve => { finish = resolve; });
    backend.attach({ onTurnStarted: () => {}, onActivity: () => {}, onTurnCompleted: () => finish() });
    // 会话行按会话键聚合当前回合（turn:<id>）；回合的输入正文由宿主事件记在同一键下。
    const { turnId } = await backend.startTurn('group:7', [], { kind: 'user', sender: '1' }) as { turnId: string };
    const key = 'turn:' + turnId;
    trace.event(key, 'received', { scope: 'group:7', detail: { text: `帮我查一下 ${secret}`, sender: '小红', thread_key: 'group:7', kind: 'user' } });
    let settled = false; void turn.then(() => { settled = true; });
    const item = (f: { item?: { stage: string; status: string } }, stage: string) => f.item?.stage === stage && f.item.status === 'started';
    const during = await readUntil(sse, t => frames(t, 'conversation').some(f => item(f, 'tool:command_execution')) && frames(t, 'conversation').some(f => item(f, 'tool:qq_recent')));
    expect(settled).toBe(false); // 回合仍在进行
    const convs = frames(during, 'conversation');
    const last = convs.at(-1)!.conversation as ConversationHead;
    expect(last).toMatchObject({ thread: 'group:7', scope: 'group:7', backend: 'codex', state: 'working', turn: { id: turnId, sender: '小红', kind: 'user' } });
    expect(['tool:qq_recent', 'tool:command_execution']).toContain(last.turn!.phase);
    expect(convs.find(f => f.item?.stage === 'tool:command_execution')!.item.summary).toContain('ls /workspace');
    expect(frames(during, 'snapshot')).toHaveLength(1);
    expect(during).not.toContain(secret); expect(during).toContain('[已隐藏]');
    // 服务端渲染的 /live 同样脱敏，并显示当前阶段
    const html = await (await r.get('/live')).text();
    expect(html).toContain('data-thread="group:7"'); expect(html).toContain('当前：'); expect(html).not.toContain(secret);
    expect(html).toContain(`href="/turns/${encodeURIComponent(turnId)}"`);
    script.complete(script.turns[0]!);
    await turn;
    await live.close();
    const working = r.live.snapshot().find(c => c.thread === 'group:7')!;
    expect(working.turn!.items.map(i => i.stage)).toEqual(expect.arrayContaining(['dispatched', 'model_turn', 'tool:qq_recent', 'tool:command_execution']));
    trace.event(key, 'reply_sent', { detail: { terminal: true, status: 'completed', thread_key: 'group:7', kind: 'user' } });
    const conv: LiveConversation = r.live.snapshot().find(c => c.thread === 'group:7')!;
    expect(conv).toMatchObject({ state: 'idle', turn: null });
    expect(conv.recent[0]).toMatchObject({ id: turnId, outcome: 'completed', phase: '' });
    expect(conv.recent[0]!.finished).not.toBeNull();
    const after = await (await r.get('/live')).text();
    expect(after).toContain('最近完成 1 个回合');
    expect(after).toContain(`href="/turns/${encodeURIComponent(turnId)}"`);
  }, 20_000);

  it('快照分帧并等待 drain：5 个会话 × 80 事件的大快照完整送达慢读者；超过 100 个会话也不丢', async () => {
    const r = await rig();
    for (let c = 0; c < 5; c++) {
      trace.event(`turn:big-${c}`, 'received', { scope: `group:${c + 1}`, detail: { text: '大回合', thread_key: `group:${c + 1}` } });
      for (let i = 0; i < 90; i++) trace.event(`turn:big-${c}`, 'tool:command_execution', { detail: { command: `第${i}步 ` + '长命令'.repeat(60) } });
    }
    for (let c = 0; c < 120; c++) trace.event(`turn:small-${c}`, 'received', { scope: `private:${100 + c}`, detail: { text: `小回合 ${c}`, thread_key: `private:${100 + c}` } });
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
    const convs = frames(text, 'snapconversation').map(f => f.conversation as LiveConversation);
    expect(convs).toHaveLength(125);
    expect(new Set(convs.map(c => c.thread)).size).toBe(125);
    for (const c of convs.filter(c => c.turn!.id.startsWith('big-'))) {
      expect(c.turn!.items).toHaveLength(80);
      expect(c.turn!.items.at(-1)!.seq).toBe(91);
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

/** 持续读取 SSE（同一连接多次等待），测试结束时取消。 */
function collect(res: Response) {
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let text = '', closed = false;
  void (async () => { for (;;) { const c = await reader.read().catch(() => ({ done: true, value: undefined })); if (c.done) { closed = true; return; } text += dec.decode(c.value, { stream: true }); } })();
  clean.push(() => reader.cancel().catch(() => undefined));
  return { async until(done: (t: string) => boolean, ms = 8000): Promise<string> {
    const deadline = Date.now() + ms;
    while (!done(text)) { if (closed || Date.now() > deadline) throw new Error('SSE timeout; got: ' + text.slice(-2000)); await new Promise(r => setTimeout(r, 20)); }
    return text;
  } };
}

describe('上下文占用条（§8.5）', () => {
  const now = Date.now();
  const stub = () => new ContextUsageStub([
    { backend: 'pi', key: 'group:7', usedTokens: 115_000, windowTokens: 128_000, compaction: { background: 89_600, reserve: 112_000 }, turns: 9, updatedAt: now, source: 'turn' },
    { backend: 'codex', key: 'group:7', usedTokens: 100_000, windowTokens: 400_000, cachedTokens: 80_000, turns: 3, updatedAt: now, source: 'turn' },
    { backend: 'codex', key: 'owner', usedTokens: 300_000, windowTokens: 400_000, turns: 20, updatedAt: now - 30 * 3600_000, source: 'turn' },
    { backend: 'pi', key: 'owner', usedTokens: 2_000, windowTokens: 128_000, turns: 0, updatedAt: now, source: 'estimate' },
  ]);

  it('总览一行迷你条 + 监控链接，/agents 完整条；codex 在前、各自按占比降序；页面加载 usage.js', async () => {
    const r = await rig({ contextUsage: stub() });
    const home = await (await r.get('/')).text();
    expect(home).toContain('上下文占用'); expect(home).toContain('src="/assets/usage.js"');
    expect(home).toContain('<a href="/context-usage">上下文监控 →</a>');
    expect(home).toContain('<div class="ctx-rows">');
    const order = [...home.matchAll(/data-ctx="([^"]+)"/g)].map(m => m[1]);
    expect(order).toEqual(['codex|owner', 'codex|group:7', 'pi|group:7', 'pi|owner']);
    expect(home).toMatch(/<span class="ctx-row-label" title="Codex · owner 线程">Codex · owner 线程<\/span><div class="ctx ctx-t-warn ctx-stale ctx-mini" data-ctx="codex\|owner"/);
    expect(home).toMatch(/class="ctx ctx-t-hot ctx-mini" data-ctx="pi\|group:7"/);
    expect(home).toMatch(/class="ctx ctx-t-ok ctx-est ctx-mini" data-ctx="pi\|owner"/);
    // 完整条（标签头、说明行）只在 Agent 页。
    expect(home).not.toContain('class="ctx-head"'); expect(home).not.toContain('class="ctx-meta"');
    expect(home).not.toMatch(/\sstyle="/);

    const agents = await r.get('/agents'); const ah = await agents.text();
    expect(agents.status).toBe(200); expect(ah).toContain('src="/assets/usage.js"');
    expect(ah).toContain('100,000'); expect(ah).toContain('缓存命中 80,000');
    expect(ah).toMatch(/class="ctx-tick ctx-bg" data-at="70" title="后台压缩阈值/); expect(ah).toMatch(/class="ctx-tick ctx-rs" data-at="88" title="阻塞压缩阈值/);
    expect(ah.indexOf('data-ctx="pi|group:7"')).toBeLessThan(ah.indexOf('action="/pi/reset"'));
    expect([...ah.matchAll(/data-ctx="([^"]+)"/g)].map(m => m[1])).toEqual(['codex|owner', 'codex|group:7', 'pi|group:7', 'pi|owner']);
    expect((await r.get('/assets/usage.js')).status).toBe(200);
  });

  it('未接入数据源时各页照常 200，codex 线程显示占位条', async () => {
    const r = await rig();
    expect(await (await r.get('/')).text()).toContain('上下文占用数据源未接入');
    expect(await (await r.get('/agents')).text()).toMatch(/class="ctx ctx-none" data-ctx="codex\|owner"/);
  });

  it('/live 会话行头部有该线程的小型占用条；SSE 首帧带全部占用记录，context_usage 事件推送 context 增量', async () => {
    const r = await rig({ contextUsage: stub() });
    trace.event('turn:pi:7:2', 'received', { scope: 'group:7', detail: { text: '在途', sender: '小明', thread_key: 'group:7' } });
    trace.event('turn:pi:7:2', 'dispatched', { detail: { backend: 'pi', conversation_key: 'group:7' } });
    const html = await (await r.get('/live')).text();
    expect(html).toMatch(/<div class="ctx ctx-t-hot ctx-mini" data-ctx="pi\|group:7"/);
    const sse = collect(await r.get('/live/stream'));
    const first = await sse.until(t => t.includes('event: snapshot_end'));
    expect(frames(first, 'context').map(f => `${f.usage.backend}|${f.usage.key}`)).toEqual(['codex|owner', 'codex|group:7', 'pi|group:7', 'pi|owner']);
    expect(first.indexOf('event: context')).toBeLessThan(first.indexOf('event: snapconversation'));
    expect(frames(first, 'snapconversation')[0].conversation).toMatchObject({ thread: 'group:7', backend: 'pi' });
    const usageSse = collect(await r.get('/usage/stream'));
    await usageSse.until(t => frames(t, 'context').length === 4);
    trace.event('@pi', 'context_usage', { detail: { backend: 'pi', key: 'group:7', usedTokens: 20_000, windowTokens: 128_000, turns: 10, updatedAt: Date.now(), source: 'turn' } });
    const live = await sse.until(t => frames(t, 'context').some(f => f.usage.usedTokens === 20_000));
    expect(frames(live, 'context').find(f => f.usage.usedTokens === 20_000).usage).toMatchObject({ backend: 'pi', key: 'group:7', windowTokens: 128_000 });
    const u = await usageSse.until(t => frames(t, 'context').some(f => f.usage.usedTokens === 20_000));
    expect(frames(u, 'context')).toHaveLength(5);
  });
});

describe('codex 系统提示 codex.md', () => {
  const codexRevision = async (r: { get: (url: string) => Promise<Response> }) =>
    /action="\/settings\/codex-prompt"[^]*?name="revision" value="([^"]+)"/.exec(await (await r.get('/settings')).text())![1]!;

  it('设置页在 agent.md 之上渲染 codex.md 编辑框与折叠的受管规则；旧的 AGENTS.md 只读块改为链接', async () => {
    const r = await rig({ codexPrompt: new CodexPromptStub('自定义 <b>规则</b>') });
    const html = await (await r.get('/settings')).text();
    expect(html).toContain('codex 系统提示 codex.md');
    expect(html).toContain('action="/settings/codex-prompt"');
    expect(html).toContain('保存 codex.md'); expect(html).toContain('data-count="codex-md-count"');
    expect(html).toContain('value="rev-1"');
    expect(html).toContain('自定义 &lt;b&gt;规则&lt;/b&gt;');
    expect(html).toMatch(/<details[^>]*><summary>受管规则（程序生成，不可编辑）<\/summary><pre># 受管规则\n- 只写 \/workspace<\/pre>/);
    expect(html.indexOf('id="codex-prompt"')).toBeLessThan(html.indexOf('id="prompt"'));
    expect(html).toContain('href="/codex/agents-md"'); expect(html).toContain('查看完整 AGENTS.md');
    expect(html).not.toContain('全局 AGENTS.md（受管文件，只读）');
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('codex.md 中混入已注册秘密时只读展示脱敏版，不给表单', async () => {
    const secret = 'codex-md-secret-11223344'; registerSecrets([secret]);
    const r = await rig({ codexPrompt: new CodexPromptStub(`规则 ${secret}`) });
    const html = await (await r.get('/settings')).text();
    expect(html).not.toContain('action="/settings/codex-prompt"'); expect(html).not.toContain(secret);
    expect(html).toContain('凭据样式');
  });

  it('没有接入存储时显示提示，POST 返回 404', async () => {
    const r = await rig({ codexPrompt: null });
    const html = await (await r.get('/settings')).text();
    expect(html).toContain('codex 系统提示存储未接入'); expect(html).not.toContain('action="/settings/codex-prompt"');
    expect((await r.post('/settings/codex-prompt', { _csrf: r.csrf, revision: 'none', content: 'x' })).status).toBe(404);
  });

  it('写操作要求 cookie、CSRF 与同源；被拒时不调用 save', async () => {
    const r = await rig(); const stub = r.codexPrompt!;
    const ok = { _csrf: r.csrf, revision: 'rev-1', content: '新规则' };
    expect((await r.post('/settings/codex-prompt', { ...ok, _csrf: '' })).status).toBe(403);
    expect((await r.post('/settings/codex-prompt', { ...ok, _csrf: r.csrf.slice(0, -1) + 'x' })).status).toBe(403);
    expect((await r.post('/settings/codex-prompt', ok, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await r.post('/settings/codex-prompt', ok, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const noCookie = await fetch(r.base + '/settings/codex-prompt?token=' + TOKEN, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(ok).toString() });
    expect(noCookie.status).toBe(401);
    expect(stub.saves).toEqual([]); expect(stub.custom).toBe('自定义规则');
  });

  it('保存成功：CRLF 规范为 LF、带 revision 调用 save、跳回并提示，最近变更出现 codex.md 一条', async () => {
    const r = await rig(); const stub = r.codexPrompt!;
    const res = await r.post('/settings/codex-prompt', { _csrf: r.csrf, revision: await codexRevision(r), content: '第一行\r\n第二行\r第三行' },
      { Origin: r.base, 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/settings?ok=codexPrompt#codex-prompt');
    expect(stub.saves).toEqual([{ custom: '第一行\n第二行\n第三行', expectedRevision: 'rev-1' }]);
    await vi.waitFor(() => expect(r.store.events(SETTINGS_KEY).filter(e => e.stage === 'prompt_changed')).toHaveLength(1));
    const ev = r.store.events(SETTINGS_KEY).find(e => e.stage === 'prompt_changed')!;
    expect(JSON.parse(ev.detail_json)).toMatchObject({ target: 'codex', source: 'dashboard', file: 'prompts/codex.md',
      bytes_before: Buffer.byteLength('自定义规则'), bytes_after: Buffer.byteLength('第一行\n第二行\n第三行') });
    const html = await (await r.get('/settings?ok=codexPrompt')).text();
    expect(html).toContain('codex.md 已保存'); expect(html).toContain('value="rev-2"');
    expect(html).toMatch(/<td>codex\.md \d+ B → \d+ B<\/td>/);
  });

  it('agent.md 保存在最近变更中仍显示为 agent.md；codex 订阅只有一个，关闭面板时退订', async () => {
    const r = await rig(); const stub = r.codexPrompt!;
    expect(stub.listeners).toBe(1);
    expect((await r.post('/settings/agent-md', { _csrf: r.csrf, revision: await revisionOf(r), content: 'pi 提示' })).status).toBe(303);
    expect(await (await r.get('/settings')).text()).toMatch(/<td>agent\.md [^<]*→ \d+ B<\/td>/);
    expect(r.store.events(SETTINGS_KEY).filter(e => e.stage === 'prompt_changed').map(e => JSON.parse(e.detail_json).target)).toEqual(['pi']);
    r.close(); expect(stub.listeners).toBe(0);
  });

  it('存储通知自带 bytes_before / bytes_after 时直接记录', async () => {
    const r = await rig(); const stub = r.codexPrompt!;
    stub.notify({ target: 'codex', file: '/data/prompts/codex.md', revision: 'rev-9', bytes_before: 11, bytes_after: 22 });
    await vi.waitFor(() => expect(r.store.events(SETTINGS_KEY).filter(e => e.stage === 'prompt_changed')).toHaveLength(1));
    expect(JSON.parse(r.store.events(SETTINGS_KEY).find(e => e.stage === 'prompt_changed')!.detail_json)).toMatchObject({ target: 'codex', bytes_before: 11, bytes_after: 22 });
  });

  it('版本过期返回 409 并提示刷新；存储拒绝（空 / 超限 / 秘密）返回 409 带原因', async () => {
    const r = await rig(); const stub = r.codexPrompt!;
    const stale = await r.post('/settings/codex-prompt', { _csrf: r.csrf, revision: 'rev-0', content: '覆盖' });
    expect(stale.status).toBe(409);
    const text = await stale.text();
    expect(text).toContain('codex.md 已在别处被修改，请刷新后再保存'); expect(text).toContain('action="/settings/codex-prompt"');
    expect((await r.post('/settings/codex-prompt', { _csrf: r.csrf, content: '覆盖' })).status).toBe(409);
    const blank = await r.post('/settings/codex-prompt', { _csrf: r.csrf, revision: 'rev-1', content: '  \r\n ' });
    expect(blank.status).toBe(409); expect(await blank.text()).toContain('codex.md 不能为空');
    const big = await r.post('/settings/codex-prompt', { _csrf: r.csrf, revision: 'rev-1', content: 'x'.repeat(70_000) });
    expect(big.status).toBe(409); expect(await big.text()).toContain('64 KB');
    const secret = 'codex-save-secret-55667788'; registerSecrets([secret]); stub.secrets.push(secret);
    const leak = await r.post('/settings/codex-prompt', { _csrf: r.csrf, revision: 'rev-1', content: `规则 ${secret}` });
    expect(leak.status).toBe(409);
    const leakText = await leak.text(); expect(leakText).toContain('凭据样式'); expect(leakText).not.toContain(secret);
    expect(stub.custom).toBe('自定义规则');
    expect(r.store.events(SETTINGS_KEY).some(e => e.stage === 'prompt_changed')).toBe(false);
  });

  it('/codex/agents-md 需要会话，渲染当前 AGENTS.md 的脱敏内容', async () => {
    const r = await rig();
    const secret = 'agents-md-secret-99001122'; registerSecrets([secret]);
    writeFileSync(path.join(r.dir, 'codex', 'AGENTS.md'), `# 受管规则\n令牌 ${secret}\n# 自定义 <i>段</i>`);
    expect((await fetch(r.base + '/codex/agents-md')).status).toBe(401);
    const res = await r.get('/codex/agents-md'); const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('全局 AGENTS.md'); expect(html).toContain('# 受管规则');
    expect(html).toContain('# 自定义 &lt;i&gt;段&lt;/i&gt;');
    expect(html).not.toContain(secret); expect(html).not.toContain(TOKEN);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).toContain('href="/settings#codex-prompt"');
  });
});

describe('运行时模型设置 POST', () => {
  it('接入四个模型字段与 auto；非法值走 flash 且不落盘', async () => {
    const r = await rig({ validators: { codexModel: id => [defaults.codexModel, 'codex/gpt-6-astra'].includes(id),
      piModel: id => [defaults.piModel, 'codex/gpt-6.1-sol'].includes(id) } });
    const form = { _csrf: r.csrf, agentBackend: 'pi', backendOverrides: '', codexModel: 'codex/gpt-6-astra',
      codexReasoningEffort: 'auto', piModel: 'codex/gpt-6.1-sol', piThinkingLevel: 'auto' };
    expect((await r.post('/settings', form)).status).toBe(303);
    expect(r.settings.current()).toMatchObject({ codexModel: form.codexModel, codexReasoningEffort: 'auto', piModel: form.piModel, piThinkingLevel: 'auto' });
    const before = readFileSync(r.settings.file, 'utf8');
    for (const patch of [{ codexModel: 'unknown' }, { codexModel: 'gpt-6-astra' }, { piModel: 'unknown' }, { codexModel: 'bad"slug' }, { piModel: '' }, { piThinkingLevel: 'ultra' }, { codexReasoningEffort: 'nonsense' }]) {
      const response = await r.post('/settings', { ...form, ...patch });
      expect(response.status).toBe(400); expect(await response.text()).toContain('设置未保存');
      expect(readFileSync(r.settings.file, 'utf8')).toBe(before);
    }
  });
});

describe('运行时模型设置页（§5）', () => {
  const catalog: ModelCatalogView = {
    codex: () => [{ slug: 'codex/gpt-6.1-sol', contextWindow: 500_000 }, { slug: 'codex/gpt-6-astra', contextWindow: 272_000 }, { slug: 'bare<x>' }],
    pi: () => [{ id: 'deepseek-flash', contextWindow: 128_000, thinkingLevels: ['off', 'low', 'high', 'max'] },
      { id: 'codex/gpt-6.1-sol', contextWindow: 500_000, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }],
  };
  const magpie = { AGENT_MODEL_PROVIDER: 'magpie', CODEX_MAGPIE_URL: 'http://gateway.example:3425/v1', CODEX_MAGPIE_KEY: 'test-model-ui-key' };
  const select = (html: string, name: string) => new RegExp(`<select name="${name}">([^]*?)</select>`).exec(html)?.[1];
  const options = (inner: string | undefined) => [...(inner ?? '').matchAll(/<option value="([^"]*)"(?: selected)?>([^<]*)<\/option>/g)].map(m => m[1]);
  const selected = (inner: string | undefined) => /<option value="([^"]*)" selected>/.exec(inner ?? '')?.[1];

  it('两组下拉：codex 模型附窗口、档位含 auto；pi 档位按当前模型过滤，当前值 selected', async () => {
    const r = await rig({ env: magpie, modelCatalog: catalog });
    const html = await (await r.get('/settings')).text();
    expect(html).toContain('Codex 模型与推理强度'); expect(html).toContain('Pi 模型与思考档位');
    const codexModel = select(html, 'codexModel');
    expect(options(codexModel)).toEqual(['codex/gpt-6.1-sol', 'codex/gpt-6-astra', 'bare&lt;x&gt;']);
    expect(selected(codexModel)).toBe('codex/gpt-6.1-sol');
    expect(codexModel).toContain('codex/gpt-6.1-sol · 窗口 500k'); expect(codexModel).toContain('codex/gpt-6-astra · 窗口 272k');
    expect(html).not.toContain('bare<x>');
    const codexEffort = select(html, 'codexReasoningEffort');
    expect(options(codexEffort)).toEqual(['auto', ...REASONING_EFFORTS]); expect(selected(codexEffort)).toBe('high');
    expect(html).toContain('开轮时按本轮输入的难度自动选档，结果见回合页');
    const piModel = select(html, 'piModel');
    expect(options(piModel)).toEqual(['deepseek-flash', 'codex/gpt-6.1-sol']); expect(selected(piModel)).toBe('deepseek-flash');
    expect(piModel).toContain('deepseek-flash · 窗口 128k');
    const piLevel = select(html, 'piThinkingLevel');
    expect(options(piLevel)).toEqual(['auto', 'off', 'low', 'high', 'max']); expect(selected(piLevel)).toBe('low');
    expect(html).not.toContain('模型目录不可用');
    expect(html).not.toMatch(/\sstyle="/); expect(html).not.toContain('test-model-ui-key');

    await r.settings.update({ codexModel: 'gpt-6.1-sol', codexReasoningEffort: 'auto', piModel: 'codex/gpt-6.1-sol', piThinkingLevel: 'max' }, 'test');
    const after = await (await r.get('/settings')).text();
    const keptCodex = select(after, 'codexModel');
    expect(options(keptCodex)[0]).toBe('gpt-6.1-sol'); expect(selected(keptCodex)).toBe('gpt-6.1-sol'); expect(keptCodex).toContain('gpt-6.1-sol（不在目录中）');
    expect(selected(select(after, 'codexReasoningEffort'))).toBe('auto');
    expect(selected(select(after, 'piModel'))).toBe('codex/gpt-6.1-sol');
    // codex/gpt-6.1-sol 不支持 max：仍保留当前值作为选项。
    expect(options(select(after, 'piThinkingLevel'))).toEqual(['max', 'auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(selected(select(after, 'piThinkingLevel'))).toBe('max');
    expect(after.match(/与 \.env 不同/g)?.length).toBeGreaterThanOrEqual(4);
    expect(after).toContain('Codex 模型：codex/gpt-6.1-sol → gpt-6.1-sol'); expect(after).toContain('Pi 思考档位：low → max');
    const overview = await (await r.get('/')).text();
    // 总览的设置摘要压成一行，"修改"链到设置页；位于最近一分钟指标之后。
    const line = /<div class="sheet pad settings-line"><span>([^<]*)<\/span><a href="\/settings">修改<\/a><\/div>/.exec(overview);
    expect(line?.[1]).toMatch(/^默认后端 \S+ · 覆盖 0 条 · Codex gpt-6\.1-sol \/ auto · Pi codex\/gpt-6\.1-sol \/ max · owner 告警 [开关]$/);
    expect(overview.indexOf('最近一分钟指标')).toBeGreaterThan(overview.indexOf('<h2>吞吐与队列'));
    expect(overview.indexOf('最近一分钟指标')).toBeLessThan(overview.indexOf('<h2>当前设置'));
    expect(overview).not.toContain('Codex 推理强度'); expect(overview).not.toContain('Pi 思考档位');
  });

  it('codex 目录为空或缺省时退化为文本框并提示', async () => {
    for (const modelCatalog of [undefined, { codex: () => [], pi: catalog.pi }, { codex: () => { throw new Error('boom'); }, pi: catalog.pi }]) {
      const r = await rig({ env: magpie, modelCatalog });
      const html = await (await r.get('/settings')).text();
      expect(select(html, 'codexModel')).toBeUndefined();
      expect(html).toContain('<input name="codexModel" value="codex/gpt-6.1-sol"');
      expect(html).toContain('模型目录不可用');
      expect(options(select(html, 'codexReasoningEffort'))[0]).toBe('auto');
    }
  });

  it('pi 提供者不是 magpie 时模型只读，hidden input 保持原值；档位仍可选', async () => {
    const r = await rig({ env: { AGENT_MODEL_PROVIDER: 'deepseek' }, modelCatalog: { codex: catalog.codex, pi: () => [] } });
    const html = await (await r.get('/settings')).text();
    expect(select(html, 'piModel')).toBeUndefined();
    expect(html).toContain('<input type="hidden" name="piModel" value="deepseek-flash">');
    expect(html).toContain('提供者 deepseek 下只读');
    expect(options(select(html, 'piThinkingLevel'))).toEqual(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const res = await r.post('/settings', { _csrf: r.csrf, agentBackend: 'codex', backendOverrides: '', codexReasoningEffort: 'high', piModel: 'deepseek-flash', piThinkingLevel: 'auto' });
    expect(res.status).toBe(303);
    expect(r.settings.current()).toMatchObject({ piModel: 'deepseek-flash', piThinkingLevel: 'auto' });
  });

  it('回合页设置行显示后端 · 模型 · 档位与 auto 来源（开轮事件的快照，缺省取首条输入的 admitted）；没有快照不显示', async () => {
    const r = await rig();
    const turn = (id: string, settings?: Record<string, unknown>) => {
      trace.event('turn:' + id, 'dispatched', { scope: 'group:7', detail: { backend: 'codex', thread_key: 'group:7', inputs: ['in-' + id], ...(settings ? { settings } : {}) } });
    };
    turn('auto', { backend: 'codex', codexReasoningEffort: 'low', codexModel: 'gpt-6.1-sol', piModel: 'deepseek-flash', piThinkingLevel: 'low', effortSource: 'auto' });
    turn('pi', { backend: 'pi', codexReasoningEffort: 'high', codexModel: 'gpt-6.1-sol', piModel: 'deepseek-flash', piThinkingLevel: 'high', effortSource: 'auto-fallback' });
    turn('fixed');
    trace.event('in:in-fixed', 'admitted', { scope: 'group:7', detail: { settings: { backend: 'codex', codexReasoningEffort: 'xhigh', codexModel: 'gpt-6.1-sol', effortSource: 'fixed' } } });
    turn('old');
    const row = async (t: string) => /<dt>设置<\/dt><dd>([^<]*)<\/dd>/.exec(await (await r.get('/turns/' + t)).text())?.[1];
    expect(await row('auto')).toBe('Codex · gpt-6.1-sol · low（来源 auto）');
    expect(await row('pi')).toBe('Pi · deepseek-flash · high（来源 auto-fallback）');
    expect(await row('fixed')).toBe('Codex · gpt-6.1-sol · xhigh');
    expect(await row('old')).toBeUndefined();
    expect((await r.get('/turns/old')).status).toBe(200);
    // 旧快照缺模型字段时只显示已有部分。
    expect(dispatchSettingsLine({ backend: 'codex', codexReasoningEffort: 'high' })).toBe('Codex · high');
    expect(dispatchSettingsLine({ backend: 'pi', codexReasoningEffort: 'high' })).toBe('Pi');
  });
});
