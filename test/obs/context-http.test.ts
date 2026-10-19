import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextView } from '@earendil-works/pi-durable';
import { boundedContext, type ContextAnalysis } from '../../src/obs/context/index.js';
import type { PiContextAdapter } from '../../src/obs/context/pi-history.js';
import { createSessionRoutes } from '../../src/obs/sessions/http.js';
import { RESPONSE_BYTES } from '../../src/obs/sessions/content.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } });
async function rig(count = 1) {
  const view: ContextView = { head: undefined, entries: [], contributions: [],
    messages: Array.from({ length: count }, (_, i) => ({ role: 'user', content: `消息 ${i} ` + '\u0000中文'.repeat(70), timestamp: i })) };
  const pi: PiContextAdapter = { listSessions: async () => [{ backend: 'pi', id: '1', label: 'owner', status: 'active', started: 0, updated: 1, turns: 1 }],
    turns: async () => [{ turn: '2', started: 0, preview: '', tools: 0, requests: 0, status: 'ok' }],
    blocks: async () => [], content: async () => '', context: async () => view };
  const handle = createSessionRoutes({ pi }, () => null, { windowTokens: 12000 });
  const server = createServer((req, res) => { void handle(new URL(req.url!, 'http://localhost'), res); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (query = '') => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/agents/pi/sessions/1/context${query}`);
}
describe('上下文路由参数与响应契约', () => {
  it.each(['?phase=invalid', '?phase=', '?at=', '?at=a%2Fb', '?at=%00', '?at=2&at=2', '?phase=before&phase=after'])('400：%s', async query => {
    const get = await rig(); expect((await get(query)).status).toBe(400);
  });
  it('未知回合 404，合法查询保留 key/tokens/tokenizer 等契约字段', async () => {
    const get = await rig(); expect((await get('?at=unknown')).status).toBe(404);
    const response = await get('?at=2&phase=before'), body = await response.json() as ContextAnalysis;
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/json');
    expect(body.at).toEqual({ turn: '2', phase: 'before' }); expect(body.window.tokens).toBe(12000);
    expect(body.estimated.tokenizer).toBe('o200k_base');
    expect(body.categories.find(c => c.key === 'history')?.tokens.estimated).toBe(body.estimated.total);
    expect(body.messages[0].tokens.estimated).toBeGreaterThan(4);
  });
  it('大窗口路由始终在 1 MiB 内，消息先缩 preview 再截断且保留完整统计', async () => {
    const get = await rig(5000), response = await get(), bytes = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200); expect(bytes.length).toBeLessThanOrEqual(RESPONSE_BYTES);
    const body = JSON.parse(bytes.toString('utf8')) as ContextAnalysis;
    expect(body.messages.length).toBeLessThan(5000);
    expect(body.messages.every(m => m.preview.length <= 80)).toBe(true);
    expect(body.categories.find(c => c.key === 'history')?.items).toBe(5000);
    expect(body.notes.join('')).toContain('逐消息表已截断');
  });
  it('短预览足够时保留所有消息，JSON 转义按实际字节计算', () => {
    const analysis: ContextAnalysis = { backend: 'codex', session: 's', at: { turn: 't', phase: 'after' }, generatedAt: 0,
      window: { tokens: 100, source: 'test' }, estimated: { total: 1000, tokenizer: 'test' }, categories: [], notes: [],
      messages: Array.from({ length: 2000 }, (_, index) => ({ index, kind: 'user', category: 'history', provenance: 'recorded',
        tokens: { estimated: 1 }, preview: '\u0000'.repeat(240) })) };
    const bounded = boundedContext(analysis);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(RESPONSE_BYTES);
    expect(bounded.messages.length).toBeLessThanOrEqual(analysis.messages.length);
    expect(analysis.messages[0].preview.length).toBe(240);
  });
  it('正文的嵌套凭据先结构化脱敏，预览裁剪不会漏出凭据前缀', async () => {
    const dispose = registerTemporarySecrets(['fixture-secret']);
    try {
      const get = await rig(); const body = await (await get()).json();
      const result = boundedContext({ ...body, messages: [{ ...body.messages[0], preview: 'fixture-secret' }] });
      expect(result.messages[0].preview).toBe('[已隐藏]');
    } finally { dispose(); }
  });
});
