import { resolveAgentConfig } from '../agent/config.js';
import { SkillsStoreError } from '../agent/skills-store.js';
import { csrfToken, sseWriter, type SseWriter } from './http-util.js';
import { createContextRoutes } from './context/http.js';
import { imageBinary } from './memory/images.js';
import { SessionError } from './sessions/types.js';
import { isThreadKey, REASONING_EFFORTS } from '../agent/codex/runner.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { callQQContextTool } from '../context/qq-context-tool.js';
import { logBuffer, type LogLine } from '../shared/log.js';
import { redact } from '../shared/redact.js';
import { CodexSessionAdapter } from './sessions/codex-adapter.js';
import { PiSessionAdapter } from './sessions/pi-adapter.js';
import { createSessionRoutes, sessionJson, type SessionAdapters } from './sessions/http.js';
import { createMemoryRoutes } from './memory/http.js';
import { loadImage } from '../media/limits.js';
import { trace as defaultTrace } from '../shared/trace.js';
import { summarize, type LiveMessage } from './live.js';
import { formatBackendOverrides, SETTINGS_TICKET } from '../agent/settings.js';
import { ASSETS } from './ui/client.js';
import { VENDOR_CACHE, vendorAsset } from './ui/vendor.js';
import type { ContextUsage } from '../shared/format.js';
import { empty, page } from './ui/html.js';
import type { DashboardOptions } from './dashboard-types.js';
import { equal, imageFile, readText, agentMdRevision, AGENT_MD_MAX_BYTES } from './dashboard-io.js';
import { createDashboardPost } from './dashboard-post.js';
import { createDashboardPages } from './ui/dashboard-pages.js';
import { asContextUsageEvent } from './context-turns.js';
import { ticketContextTurns } from './context-ticket.js';
import { createScheduleRoutes } from './schedules.js';

// 与顶栏的蓝色方框及两条横线保持一致；静态图形不含运行数据。
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="7" y="4" width="18" height="24" rx="2" fill="none" stroke="#2b47b5" stroke-width="3"/><path d="M11 13h10M11 19h10" stroke="#2b47b5" stroke-width="3"/></svg>';
const MAX_SSE = 20;

const FLASH: Record<string, string> = {
  skillsUploaded: '技能上传已处理，下一条消息生效。', skillsDeleted: '技能已删除，下一条消息生效。',
  saved: '设置已保存，之后收到的消息按新设置处理。', prompt: 'agent.md 已保存，pi 下一轮对话即读取新内容。',
  codexBasePrompt: 'codex 基础指令已保存，下一轮生效（含已有线程续聊）。',
  codexPrompt: 'codex.md 已保存，AGENTS.md 已重写，codex 下一条消息即使用新内容。',
  reset: '已重置：旧会话已归档，下一条消息会新建会话。', queued: '已排队：当前回合结束后立即重置，旧会话会归档。', unchanged: '没有可操作的会话。',
  compacted: '会话已压缩：保留摘要，旧工具输出与图片已从活动上下文中清理。', compactQueued: '压缩已排队或正在执行，完成结果请查看日志。',
  compactFailed: '会话压缩失败，详见日志。',
};

const asObj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function createDashboard(opts: DashboardOptions) {
  const config = resolveAgentConfig(opts.config);
  const clients = new Set<ServerResponse>();
  let closed = false;
  const adapters: SessionAdapters = opts.sessionAdapters ?? (opts.store.degraded ? {} : {
    codex: new CodexSessionAdapter({ store: opts.store, codexHome: config.codexHome, dataDir: config.DATA_DIR }),
    ...(opts.piSessions ? { pi: new PiSessionAdapter({ store: opts.store, source: opts.piSessions }) } : {}),
  });
  const handleSessions = createSessionRoutes(adapters, sse);
  const handleContext = createContextRoutes(adapters, { codexHome: config.codexHome, dataDir: config.DATA_DIR, contextUsage: opts.contextUsage });
  const sessionRoute = (url: URL, res: ServerResponse) => url.pathname.split('/').length === 7 && url.pathname.endsWith('/context')
    ? handleContext(url, res) : handleSessions(url, res);
  const memoryRoute = createMemoryRoutes({ context: opts.context, store: opts.store, sessionAdapters: adapters, aging: opts.aging, archives: opts.archives,
    maxChars: config.QQ_CONTEXT_MAX_CHARS, retention: { rawDays: config.HISTORY_RAW_DAYS,
      summaryDays: config.HISTORY_SUMMARY_DAYS, hardMaxDays: config.HISTORY_RAW_HARD_MAX_DAYS,
      dailyHour: config.HISTORY_SUMMARY_HOUR, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  const token = config.OBS_TOKEN;
  const csrf = token ? csrfToken(token) : '';
  const tracer = opts.trace ?? defaultTrace;
  const agentMd = path.join(config.DATA_DIR, 'prompts', 'agent.md');
  const agentsMd = path.join(config.codexHome, 'AGENTS.md');
  // codex.md 变更由存储通知，面板只在此处记一次 prompt_changed（处理器本身不记，避免重复）。
  let codexBytes: Promise<number | null> = opts.codexPrompt ? opts.codexPrompt.read().then(s => Buffer.byteLength(s.custom), () => null) : Promise.resolve(null);
  const offCodexPrompt = opts.codexPrompt?.subscribe(change => {
    const c = asObj(change);
    const before = codexBytes;
    codexBytes = (async () => {
      // 存储的通知自带前后字节数时直接用；否则用上次缓存的大小与重新读取的结果。
      const prev = typeof c.bytes_before === 'number' ? c.bytes_before : await before;
      const after = typeof c.bytes_after === 'number' ? c.bytes_after : typeof c.custom === 'string' ? Buffer.byteLength(c.custom) : await opts.codexPrompt!.read().then(s => Buffer.byteLength(s.custom), () => null);
      tracer.event(SETTINGS_TICKET, 'prompt_changed', { detail: { target: 'codex', source: typeof c.source === 'string' ? c.source : 'dashboard', file: 'prompts/codex.md', bytes_before: prev, bytes_after: after } });
      return after;
    })().catch(() => null);
  });

  const offCodexBasePrompt = opts.codexBasePrompt?.subscribe(change => {
    tracer.event(SETTINGS_TICKET, 'prompt_changed', { detail: { ...change, target: 'codex-base', source: 'dashboard' } });
  });

  const { render, usageList } = createDashboardPages({
    opts: { ...opts, store: {
      get degraded() { return opts.store.degraded; },
      throughput: since => opts.store.throughput(since),
      latestMetrics: () => opts.store.db.prepare('SELECT * FROM metrics WHERE ts=(SELECT MAX(ts) FROM metrics) ORDER BY name LIMIT 150').all() as { name: string; labels_json: string; value: number; ts: number }[],
      tickets: filters => opts.store.tickets(filters),
      events: (ticket, options) => opts.store.events(ticket, options),
      systemEvents: (ticket, limit) => opts.store.systemEvents(ticket, limit),
      contextSeries: o => opts.store.contextSeries(o),
      previousContextTurn: (backend, key, beforeTs) => {
        const event = opts.store.previousContextTurn(backend, key, beforeTs);
        return event && asContextUsageEvent(event);
      },
      analyzeTicketTurns: (ticket, events) => ticketContextTurns(opts.store, ticket, events),
    } },
    config, csrf, agentMd, agentsMd, api,
    contextResult: (scope, query) => callQQContextTool({access:scope?{kind:'scope',scope}:{kind:'all'},openStore:()=>opts.context,maxChars:config.QQ_CONTEXT_MAX_CHARS},query?'qq_search':'qq_recent',query?{query,days:180,limit:20}:{limit:30}),
    isThreadKey, summarize, imageFile, readText, agentMdRevision, formatBackendOverrides,
    reasoningEfforts: REASONING_EFFORTS, agentMdMaxBytes: AGENT_MD_MAX_BYTES, settingsTicket: SETTINGS_TICKET,
  });
  const handlePost = createDashboardPost(opts, csrf, agentMd, tracer, render);
  const handleSchedules = createScheduleRoutes(opts.schedules, config.owner, csrf);

  /** 在服务端内部调用会话 JSON 路由：与浏览器拿到的是同一份已脱敏 JSON、同样的校验与错误码。 */
  async function api(pathQuery: string): Promise<{ status: number; body: unknown }> {
    let text = '';
    const res = { statusCode: 200, headersSent: false, destroyed: false, writableEnded: false,
      setHeader() { return res; }, getHeader() { return undefined; }, on() { return res; }, once() { return res; }, off() { return res; },
      writeHead(status: number) { res.statusCode = status; res.headersSent = true; return res; },
      write(chunk: unknown) { text += String(chunk); return true; },
      end(chunk?: unknown) { if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) text += String(chunk); res.headersSent = true; res.writableEnded = true; return res; } };
    const target = new URL(pathQuery, 'http://localhost');
    const route = target.pathname === '/api/memory' || target.pathname.startsWith('/api/memory/') ? memoryRoute : sessionRoute;
    await route(target, res as unknown as ServerResponse);
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
    return { status: res.statusCode, body };
  }
  function sse(res: ServerResponse): SseWriter | null {
    if (closed || res.destroyed || res.writableEnded) return null;
    if (clients.size >= MAX_SSE) { res.writeHead(503).end(); return null; }
    res.writeHead(200, { 'Content-Type':'text/event-stream', Connection:'keep-alive' }); res.flushHeaders();
    clients.add(res);
    const out = sseWriter(res);
    const heartbeat = setInterval(()=>out.send(': keepalive\n\n'),15_000); heartbeat.unref();
    res.on('close',()=>{ clearInterval(heartbeat); clients.delete(res); });
    return out;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closed) { res.writeHead(503).end(); return; }
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { res.writeHead(400).end(); return; }
    // loopback 面板拒绝任意 Host，防止本地浏览器的 DNS rebinding 读取聊天数据。
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }).end(FAVICON); return;
    }
    const post = req.method === 'POST';
    {
      const cookie = /(?:^|;\s*)obs_token=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
      let saved = ''; try { saved = decodeURIComponent(cookie); } catch { /* 无效 cookie */ }
      // 写操作只认 cookie 会话，URL 口令只用于 GET 登录换 cookie。
      const supplied = post ? null : url.searchParams.get('token');
      if (!token || !equal(supplied ?? saved, token)) {
        res.writeHead(401, {'Content-Type':'text/html; charset=utf-8'}).end(page({ title: '需要访问口令', path: '', nonce,
          lead: '口令在容器的 /data/obs-token（或 .env 的 OBS_TOKEN）。输入一次后浏览器会记住。',
          body: '<form class="bar" method="get"><label>访问口令<input name="token" type="password" autocomplete="current-password" required></label><button>进入值守台</button></form>' }));
        return;
      }
      if (supplied !== null) {
        res.setHeader('Set-Cookie', 'obs_token='+encodeURIComponent(token)+'; HttpOnly; SameSite=Strict; Path=/');
        url.searchParams.delete('token');
        res.writeHead(303, { Location: url.pathname + url.search }).end(); return;
      }
    }
    if (url.pathname === '/api/schedules' || url.pathname.startsWith('/api/schedules/')) {
      await handleSchedules(req, res, url, host); return;
    }
    if (url.pathname === '/api/agents' || url.pathname.startsWith('/api/agents/') || url.pathname === '/agents/stream') {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sessionJson(res, 405, { error: '会话接口只支持 GET' }); return; }
      await sessionRoute(url, res); return;
    }
    if (url.pathname === '/api/memory' || url.pathname.startsWith('/api/memory/')) {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sessionJson(res, 405, { error: '记忆接口只支持 GET' }); return; }
      await memoryRoute(url, res); return;
    }
    if (url.pathname.startsWith('/media/')) {
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
      try {
        const { bytes, mime } = await imageBinary(config.DATA_DIR, opts.context, url.pathname.slice('/media/'.length));
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' }).end(bytes);
      } catch (error) {
        res.writeHead(error instanceof SessionError ? error.status : 404).end('图片不可读取');
      }
      return;
    }
    if (post) { await handlePost(req, res, url, nonce, host); return; }
    const skillZip = /^\/skills\/([^/]+)\.zip$/.exec(url.pathname);
    if (skillZip) {
      if (!opts.skills) { res.writeHead(404).end('技能管理未启用'); return; }
      try {
        let name: string;
        try { name = decodeURIComponent(skillZip[1]); } catch { throw new SkillsStoreError(400, '非法技能名称'); }
        const bytes = await opts.skills.exportZip(name);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}.zip"` }).end(Buffer.from(bytes));
      } catch (error) {
        res.writeHead(error instanceof SkillsStoreError ? error.status : 500, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(error instanceof SkillsStoreError ? error.message : '技能下载失败');
      }
      return;
    }
    const q = url.searchParams;
    if (url.pathname.startsWith('/assets/vendor/')) {
      // 固定白名单（vis-timeline 的 JS 与 CSS），启动时读入内存；其它名字一律 404。
      const asset = vendorAsset(url.pathname.slice(15));
      if (!asset) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': VENDOR_CACHE }).end(asset.body); return;
    }
    if (url.pathname.startsWith('/assets/')) {
      const body = Object.hasOwn(ASSETS, url.pathname.slice(8)) ? ASSETS[url.pathname.slice(8)] : undefined;
      if (!body) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(body); return;
    }
    if (url.pathname === '/logs/stream') {
      const out = sse(res); if (!out) return;
      const ticket = q.get('ticket'), level = q.get('level');
      const emit = (line: LogLine) => {
        const id = typeof line.ticket === 'string' ? line.ticket : '';
        if (ticket && (!id || (!id.startsWith(ticket) && !ticket.startsWith(id)))) return;
        if (level && line.level !== level) return;
        out.send('data: '+JSON.stringify(redact(line, 20_000))+'\n\n');
      };
      const off = logBuffer.subscribe(emit);
      logBuffer.recent().forEach(emit);
      res.on('close', off); return;
    }
    if (url.pathname === '/live/stream') {
      if (!opts.live) { res.writeHead(404).end(); return; }
      const out = sse(res); if (!out) return;
      const send = (event: string, data: unknown) => out.send(`event: ${event}\ndata: ${JSON.stringify(redact(data, 2_000))}\n\n`);
      // 快照分帧：snapshot 头（页面据此清空）→ 每张卡片一帧 snapcard → snapshot_end；之后的增量排在其后。
      // 逐卡脱敏，避免 redact 对数组的 100 项截断吞掉多余卡片（总数由 LiveBus 的 maxCards 约束）。
      const cards = opts.live.snapshot();
      send('snapshot', { now: Date.now(), count: cards.length });
      // 占用记录先于卡片到达，卡片头部的小型占用条在首帧即可填充。
      for (const usage of usageList()) send('context', { usage });
      for (const card of cards) send('snapcard', { card });
      send('snapshot_end', { count: cards.length });
      const off = opts.live.subscribe((m: LiveMessage) => m.type === 'event' ? send('card', { card: m.card, item: m.item })
        : m.type === 'context' ? send('context', { usage: m.usage }) : send('remove', { ticket: m.ticket }));
      res.on('close', off); return;
    }
    if (url.pathname === '/usage/stream') {
      // 总览 / Codex / Pi 页的占用条：首帧当前全部记录（重连后补齐），之后只推 context 增量。
      const out = sse(res); if (!out) return;
      const send = (usage: ContextUsage) => out.send(`event: context\ndata: ${JSON.stringify(redact({ usage }, 2_000))}\n\n`);
      for (const usage of usageList()) send(usage);
      const off = opts.live?.subscribe(m => { if (m.type === 'context') send(m.usage); });
      if (off) res.on('close', off); return;
    }
    if (url.pathname.startsWith('/images/')) {
      try {
        const segments = (req.url ?? '').split('?')[0]!.slice('/images/'.length).split('/').map(decodeURIComponent);
        const file = await imageFile(config.imagesDir,segments);
        const bytes = loadImage(file, config.imagesDir);
        const ext=path.extname(file).toLowerCase();
        res.writeHead(200,{'Content-Type':ext==='.jpg'||ext==='.jpeg'?'image/jpeg':'image/'+ext.slice(1)}).end(bytes);
      } catch { res.writeHead(404).end('图片不存在'); } return;
    }
    // 旧 /codex、/pi 页并入 /agents/*（设计 §7）；/codex/agents-md 与重置 POST 保持原路径。
    if (url.pathname === '/codex' || url.pathname === '/pi') { res.writeHead(303, { Location: `/agents${url.pathname}/sessions` }).end(); return; }
    const flashCode = q.get('ok');
    const detail = flashCode === 'skillsUploaded' ? (q.get('detail') ?? '').slice(0, 16_000) : '';
    const flash = flashCode && Object.hasOwn(FLASH, flashCode) ? { text: FLASH[flashCode]!, error: flashCode === 'compactFailed', ...(detail ? { detail } : {}) } : undefined;
    const html = await render(url, nonce, flash);
    if (html === null) {
      const notFound = url.pathname.startsWith('/skills/') ? '没有这个技能。可以从<a href="/skills">技能列表</a>重新查找。' : '地址不对或票据已过保留期。可以从<a href="/tickets">票据列表</a>重新查找。';
      res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'}).end(page({ title: '没有这个页面', path: url.pathname, nonce, body: empty(notFound) })); return;
    }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);
  }

  return { handle: (req: IncomingMessage,res: ServerResponse) => handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('观测页面暂不可用');}),
    close: async () => {closed=true;for(const res of clients)res.end();clients.clear();if(typeof offCodexPrompt==='function')offCodexPrompt();offCodexBasePrompt?.();
      await Promise.all(Object.values(adapters).map(adapter => adapter.close?.()));} };
}
