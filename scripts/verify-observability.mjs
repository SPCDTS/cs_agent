/** 离线面板验收：仅生成临时假数据，监听随机 loopback 端口，保存各页 HTML 与字节数。先 npm run build。 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { ObsStore } from '../dist/obs/store.js';
import { Trace } from '../dist/obs/trace.js';
import { ContextStore } from '../dist/context/store.js';
import { createDashboard } from '../dist/obs/http.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'cs-panel-fixture-'));
const out = path.resolve(process.argv[2] ?? '.g4-results/html');
await mkdir(out, { recursive: true });
const config = loadConfig({ DATA_DIR: dir });
const store = new ObsStore(dir), context = new ContextStore(dir), trace = new Trace(store);
trace.event('in:example', 'received', { scope: 'group:7', detail: { text: '查一下天气', sender: '测试用户' } });
trace.event('turn:pi:7:1', 'dispatched', { scope: 'group:7', detail: { backend: 'pi', conversation_key: 'group:7', kind: 'user', inputs: ['example'] } });
trace.event('turn:pi:7:1', 'received', { scope: 'group:7', detail: { text: '查一下天气', sender: '测试用户', thread_key: 'group:7', kind: 'user', inputs: ['example'] } });
trace.event('turn:pi:7:1', 'tool:web_search', { durationMs: 100, detail: { backend: 'pi', input: { query: '天气' } } });
trace.event('turn:pi:7:1', 'send_message', { detail: { target: 'qq:group:7', text: '晴', status: 'sent', message_id: 'reply-example' } });
trace.event('turn:pi:7:1', 'reply_sent', { detail: { terminal: true, status: 'completed', thread_key: 'group:7', kind: 'user' } });
const dashboard = createDashboard({ config, store, context,
  health: () => ({ bridge: { ws_connected: true, disconnect_count: 0 }, codex: { ok: true }, deepseek_key_present: false, aging: '尚未运行（假数据）' }),
  queue: () => ({ active: 0, slots: 2, waiting: 0, scopes: {} }),
  codex: async () => [{ thread_key: 'shared', thread_id: 'fixture-thread', rollout_bytes: 2048, observed_turns: 1 }],
  pi: async () => ({ count: 1, keys: ['group:7'], compaction: [], usage: {} }),
});
const server = createServer(dashboard.handle);
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sizes = {};
  for (const route of ['/', '/turns', '/turns/pi%3A7%3A1', '/inputs/example', '/conversations/group%3A7', '/logs', '/context', '/config']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    if (response.status !== 200) throw new Error(`${route}: HTTP ${response.status}`);
    const html = await response.text();
    sizes[route] = Buffer.byteLength(html);
    await writeFile(path.join(out, route === '/' ? 'index.html' : decodeURIComponent(route.slice(1)).replaceAll(/[/:]/g, '-') + '.html'), html, 'utf8');
    process.stdout.write(`HTML_BYTES ${route} ${sizes[route]}\n`);
  }
  await writeFile(path.join(out, 'sizes.json'), JSON.stringify(sizes, null, 2) + '\n', 'utf8');
} finally {
  dashboard.close();server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store.close();context.close();await rm(dir, { recursive: true, force: true });
}
