import { isThreadKey, type ThreadKey } from "../agent/codex-runner.js";
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes, createHash, createHmac, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { ContextStore } from '../context/store.js';
import { callQQContextTool } from '../mcp/qq-context-server.js';
import { logBuffer, type LogLine } from '../log.js';
import { redact, redactText } from './redact.js';
import { CodexSessionAdapter } from './sessions/codex-adapter.js';
import { PiSessionAdapter, type PiSessionSource } from './sessions/pi-adapter.js';
import { createSessionRoutes, sessionJson, type SessionAdapters } from './sessions/http.js';
import type { ObsEvent, ObsStore } from './store.js';
import { createMemoryRoutes } from './memory/http.js';
import type { MemoryAging, MemoryArchives } from './memory/types.js';
import { loadImage } from '../qq/image.js';
import { trace as defaultTrace, type Trace } from './trace.js';
import { summarize, type LiveBus, type LiveCard, type LiveMessage } from './live.js';
import type { SettingsStore, RuntimeSettings } from '../agent/settings.js';
import { formatBackendOverrides, SETTINGS_TICKET } from '../agent/settings.js';
import { parseBackendOverrides } from '../agent/backends/select.js';
import { REASONING_EFFORTS } from '../agent/codex-runner.js';
import { ASSETS } from './ui/client.js';
import { VENDOR_CACHE, vendorAsset } from './ui/vendor.js';
import { MESSAGE_PAGE, archivesPageBody, memoryHomeBody, messageWindow, placeholderBody, rangeParams, scopePageBody, searchPageBody, summaryPageBody,
  type ArchivesResult, type MemoryOverview, type MessagePage, type SearchResult, type SummaryDetail } from './ui/memory-pages.js';
import type { ScopeTimeline } from './memory/types.js';
import { contextBar, sortUsage, type ContextUsage, type ContextUsageView } from './ui/context-bar.js';
import { BACKENDS, ROUTES, csrfField, empty, epochMs, esc, fmtBytes, fmtWhen, fmtMs, fmtOffset, fmtTime, json, kv, page, scopeLabel, stageLabel, stamp, statusStamp, time, uri } from './ui/html.js';
import { PRELOAD_TURNS, agentsBody, byNewest, crumbs, dataScript, isBackend, sessionHref, sessionListBody, sessionPageBody, sessionScope, sessionsHref, turnPageBody, type AgentCardInput, type AgentSummary, type ResetTarget } from './ui/agents-pages.js';
import { contextBody as contextAnalysisBody, contextError, contextUnavailable, type ContextAnalysis } from './ui/context-view.js';
import type { Block, ObservedTurn, SessionRef } from './sessions/types.js';

const queryLink = (q: URLSearchParams) => new URLSearchParams([...q].map(([k,v])=>[redactText(k,100_000),redactText(v,100_000)])).toString();
// 与顶栏的蓝色方框及两条横线保持一致；静态图形不含运行数据。
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="7" y="4" width="18" height="24" rx="2" fill="none" stroke="#2b47b5" stroke-width="3"/><path d="M11 13h10M11 19h10" stroke="#2b47b5" stroke-width="3"/></svg>';
const MAX_SSE = 20;
/** SSE 写队列：未写出字节（队列 + socket 缓冲）超过上限，或一次 drain 等待超过时限才断开慢客户端。 */
const SSE_MAX_PENDING = 2 * 1024 * 1024;
const SSE_DRAIN_TIMEOUT_MS = 10_000;

export interface SseWriter { send(frame: string): void }
/** 按序写出 SSE 帧；write 返回 false 是正常背压，等待 drain 而不是断开。 */
export function sseWriter(res: ServerResponse, maxPending = SSE_MAX_PENDING, drainTimeoutMs = SSE_DRAIN_TIMEOUT_MS): SseWriter {
  const queue: string[] = [];
  let queued = 0, flushing = false, closed = false;
  res.on('close', () => { closed = true; queue.length = 0; queued = 0; });
  const drained = () => new Promise<boolean>(resolve => {
    const done = (ok: boolean) => { clearTimeout(timer); res.off('drain', onDrain); res.off('close', onClose); resolve(ok); };
    const onDrain = () => done(true), onClose = () => done(false);
    const timer = setTimeout(() => done(false), drainTimeoutMs);
    res.on('drain', onDrain); res.on('close', onClose);
  });
  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length && !closed) {
        const frame = queue.shift()!; queued -= Buffer.byteLength(frame);
        if (!res.write(frame) && !closed && !await drained()) { if (!closed) res.destroy(); return; }
      }
    } finally { flushing = false; }
  }
  return {
    send(frame) {
      if (closed) return;
      const bytes = Buffer.byteLength(frame);
      if (queued + bytes + res.writableLength > maxPending) { res.destroy(); return; }
      queue.push(frame); queued += bytes; void flush();
    },
  };
}
const MAX_BODY = 512 * 1024;
const AGENT_MD_MAX_BYTES = 64 * 1024;

export interface DashboardOptions {
  config: Config; store: ObsStore; context: ContextStore;
  health: () => unknown | Promise<unknown>; queue: () => unknown;
  codex: () => Promise<unknown>; pi: () => Promise<unknown>;
  /** pi-durable 的只读公开接口；同时为后续历史上下文分析保留 context(at)。 */
  piSessions?: PiSessionSource;
  /** 可注入适配器，便于测试或其它宿主复用相同鉴权与路由。 */
  sessionAdapters?: SessionAdapters;
  aging?: MemoryAging;
  archives?: MemoryArchives;
  /** 运行时设置（/settings 可写）；缺省时设置页只读展示配置 */
  settings?: SettingsStore;
  /** 进行中会话的实时总线（/live） */
  live?: LiveBus;
  resetCodex?: (key: ThreadKey) => Promise<string | null>;
  resetPi?: (key: string) => Promise<number | null>;
  trace?: Pick<Trace, 'event'>;
  /** 每线程上下文占用（src/agent/context-usage.ts 的 ContextUsageStore；面板只读 all/get） */
  contextUsage?: ContextUsageView;
  /** codex 系统提示（src/agent/codex-prompt.ts 的 CodexPromptStore）：受管段只读，自定义段 codex.md 可编辑 */
  codexPrompt?: CodexPromptView;
}

/** CodexPromptStore 的结构类型：面板只依赖这三个方法。 */
export interface CodexPromptSnapshot { managed: string; custom: string; revision: string; file: string; updatedAt: number | null }
export interface CodexPromptView {
  read(): Promise<CodexPromptSnapshot>;
  /** 版本不符抛 name === 'StaleRevisionError'；含秘密 / 超限 / 为空抛带中文说明的普通错误 */
  save(custom: string, expectedRevision: string): Promise<{ revision: string }>;
  subscribe(fn: (change?: unknown) => void): (() => void) | void;
}
function equal(a: string, b: string): boolean { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
/** 由访问口令派生的 CSRF 令牌：表单隐藏字段 + 服务端比对；不知道口令无法伪造。 */
export function csrfToken(obsToken: string): string { return createHmac('sha256', obsToken).update('cs-agent-dashboard-csrf-v1').digest('base64url'); }

/** URL 每段与 realpath 双重限制，拒绝软链接和跨票据读取；只允许校验过的位图。 */
async function imageFile(root: string, segments: string[]): Promise<string> {
  if (segments.length < 2 || segments.length > 5 || !/^[A-Za-z0-9_-]{1,128}$/.test(segments[0]!) ||
      segments.some(s => !s || s === '.' || s === '..' || /[\\/:\0]/.test(s))) throw new Error('非法图片路径');
  if (!/\.(png|jpe?g|webp|gif)$/i.test(segments.at(-1)!)) throw new Error('不支持的图片');
  const realRoot = await fs.realpath(root);
  if (realRoot !== path.resolve(root)) throw new Error('图片根目录不可为链接');
  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('图片不可为链接');
  }
  const real = await fs.realpath(current);
  if (path.relative(realRoot, real) !== path.join(...segments)) throw new Error('图片超出目录');
  return real;
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '只接受表单提交');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, '提交内容过大');
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** 只认普通文件（非链接、≤256 KB）；内容先脱敏。 */
async function readText(file: string): Promise<string> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > 256_000 || await fs.realpath(file) !== path.resolve(file)) return '文件不可读取';
    return redactText(await fs.readFile(file,'utf8'),100_000);
  } catch { return '文件不存在'; }
}

/** agent.md 原子写：目录与目标都不能是链接，内容规范为 LF，大小有上限。 */
/** 编辑框所见版本：mtime + 大小的摘要；文件不存在为 'none'。 */
export const agentMdRevision = (st: { mtimeMs: number; size: number } | null): string =>
  st ? createHash('sha256').update(`${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16) : 'none';

/**
 * 服务端守卫（不只依赖界面只读）：当前文件含已注册秘密时拒绝覆盖；表单 revision 与当前文件不符
 * （被容器内或另一个标签页改过）时拒绝，避免覆盖他人修改。
 */
async function guardAgentMd(file: string, revision: string): Promise<void> {
  let st: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try { st = await fs.lstat(file); } catch { /* 不存在 */ }
  if (st && st.isFile() && !st.isSymbolicLink() && st.size <= 256_000) {
    const current = await fs.readFile(file, 'utf8');
    if (redactText(current, 1_000_000) !== current) throw new HttpError(409, 'agent.md 中包含凭据样式的内容，面板禁止覆盖；请在容器内直接编辑。');
  }
  if (revision !== agentMdRevision(st)) throw new HttpError(409, 'agent.md 已在别处被修改，请刷新页面查看最新内容后再保存。');
}

async function writeAgentMd(file: string, content: string): Promise<{ before: number; after: number }> {
  const text = content.replace(/\r\n?/g, '\n');
  const bytes = Buffer.byteLength(text);
  if (bytes > AGENT_MD_MAX_BYTES) throw new HttpError(400, `agent.md 超过 ${AGENT_MD_MAX_BYTES / 1024} KB 上限`);
  if (!text.trim()) throw new HttpError(400, 'agent.md 不能为空');
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const dst = await fs.lstat(dir);
  if (!dst.isDirectory() || dst.isSymbolicLink()) throw new HttpError(400, 'prompts 目录不可为链接');
  let before = 0;
  try { const st = await fs.lstat(file); if (!st.isFile() || st.isSymbolicLink()) throw new HttpError(400, 'agent.md 不是普通文件'); before = st.size; }
  catch (e) { if (e instanceof HttpError) throw e; }
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => undefined); }
  return { before, after: bytes };
}

const FLASH: Record<string, string> = {
  saved: '设置已保存，之后收到的消息按新设置处理。', prompt: 'agent.md 已保存，pi 下一轮对话即读取新内容。',
  codexPrompt: 'codex.md 已保存，AGENTS.md 已重写，codex 下一条消息即使用新内容。',
  reset: '已重置：旧会话已归档，下一条消息会新建会话。', queued: '已排队：当前回合结束后立即重置，旧会话会归档。', unchanged: '没有可重置的会话。',
};

const SETTING_LABELS: Record<string, string> = { agentBackend: '默认后端', backendOverrides: '按会话覆盖', codexReplyMode: 'Codex 回复方式', codexReasoningEffort: 'Codex 推理强度', alertOwner: 'owner 告警' };
const showSetting = (v: unknown) => typeof v === 'boolean' ? (v ? '开启' : '关闭') : v && typeof v === 'object' ? (Object.entries(v).map(([k, b]) => `${k}=${String(b)}`).join(', ') || '无') : String(v);
const asObj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** 聊天记录整理灯的说明：观测事件 ts（毫秒）或消息库 meta aging_last_run（秒）统一格式化。 */
export function agingNote(aging: Record<string, unknown>, now = Date.now()): string {
  const raw = aging.ts ?? aging.last_run;
  if (raw === undefined || raw === null || raw === '') return '尚未运行';
  const ms = epochMs(raw);
  return ms === null ? `上次 ${String(raw)}` : `上次 ${fmtWhen(ms, now)}`;
}
const ticketStatus = (events: ObsEvent[]) => {
  const t = events.filter(e => ['reply_sent','failed','fallback'].includes(e.stage) && JSON.parse(e.detail_json).terminal === true).at(-1);
  if (!t) return 'processing';
  if (t.stage === 'failed') return JSON.parse(t.detail_json).failure === 'timeout' ? 'timeout' : 'failed';
  return t.stage === 'fallback' ? 'fallback' : 'sent';
};

export function createDashboard(opts: DashboardOptions) {
  const clients = new Set<ServerResponse>();
  let closed = false;
  const adapters: SessionAdapters = opts.sessionAdapters ?? (opts.store.degraded ? {} : {
    codex: new CodexSessionAdapter({ store: opts.store, codexHome: opts.config.codexHome, dataDir: opts.config.DATA_DIR }),
    ...(opts.piSessions ? { pi: new PiSessionAdapter({ store: opts.store, source: opts.piSessions }) } : {}),
  });
  const sessionRoute = createSessionRoutes(adapters, sse, { codexHome: opts.config.codexHome, dataDir: opts.config.DATA_DIR, contextUsage: opts.contextUsage });
  const memoryRoute = createMemoryRoutes({ context: opts.context, store: opts.store, sessionAdapters: adapters, aging: opts.aging, archives: opts.archives,
    maxChars: opts.config.QQ_CONTEXT_MAX_CHARS, retention: { rawDays: opts.config.HISTORY_RAW_DAYS,
      summaryDays: opts.config.HISTORY_SUMMARY_DAYS, hardMaxDays: opts.config.HISTORY_RAW_HARD_MAX_DAYS,
      dailyHour: opts.config.HISTORY_SUMMARY_HOUR, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  const token = opts.config.OBS_TOKEN;
  const csrf = token ? csrfToken(token) : '';
  const tracer = opts.trace ?? defaultTrace;
  const agentMd = path.join(opts.config.DATA_DIR, 'prompts', 'agent.md');
  const agentsMd = path.join(opts.config.codexHome, 'AGENTS.md');
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
    if (url.pathname === '/api/agents' || url.pathname.startsWith('/api/agents/') || url.pathname === '/agents/stream') {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sessionJson(res, 405, { error: '会话接口只支持 GET' }); return; }
      await sessionRoute(url, res); return;
    }
    if (url.pathname === '/api/memory' || url.pathname.startsWith('/api/memory/')) {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sessionJson(res, 405, { error: '记忆接口只支持 GET' }); return; }
      await memoryRoute(url, res); return;
    }
    if (post) { await handlePost(req, res, url, nonce, host); return; }
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
        const file = await imageFile(opts.config.imagesDir,segments);
        const bytes = loadImage(file, opts.config.imagesDir);
        const ext=path.extname(file).toLowerCase();
        res.writeHead(200,{'Content-Type':ext==='.jpg'||ext==='.jpeg'?'image/jpeg':'image/'+ext.slice(1)}).end(bytes);
      } catch { res.writeHead(404).end('图片不存在'); } return;
    }
    // 旧 /codex、/pi 页并入 /agents/*（设计 §7）；/codex/agents-md 与重置 POST 保持原路径。
    if (url.pathname === '/codex' || url.pathname === '/pi') { res.writeHead(303, { Location: `/agents${url.pathname}/sessions` }).end(); return; }
    const flashCode = q.get('ok');
    const flash = flashCode && FLASH[flashCode] ? { text: FLASH[flashCode]! } : undefined;
    const html = await render(url, nonce, flash);
    if (html === null) { res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'}).end(page({ title: '没有这个页面', path: url.pathname, nonce, body: empty('地址不对或票据已过保留期。可以从<a href="/tickets">票据列表</a>重新查找。') })); return; }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse, url: URL, nonce: string, host: string): Promise<void> {
    // 同源检查：Origin 为 null 时仅信任浏览器提供的 Sec-Fetch-Site: same-origin；其他 Origin 必须匹配，随后仍校验 CSRF 令牌。
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin && origin !== `http://${host}` && !(origin === 'null' && site === 'same-origin')) { res.writeHead(403).end('跨站请求被拒绝'); return; }
    if (site && site !== 'same-origin' && site !== 'none') { res.writeHead(403).end('跨站请求被拒绝'); return; }
    let form: URLSearchParams;
    try { form = await readBody(req); }
    catch (e) { res.writeHead(e instanceof HttpError ? e.status : 400).end(e instanceof Error ? e.message : ''); return; }
    if (!csrf || !equal(form.get('_csrf') ?? '', csrf)) { res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'}).end('CSRF 令牌无效，请刷新页面后重试'); return; }
    const back = (location: string) => res.writeHead(303, { Location: location }).end();
    try {
      if (url.pathname === '/settings') {
        if (!opts.settings) throw new HttpError(404, '运行时设置不可用');
        let overrides: RuntimeSettings['backendOverrides'];
        try { overrides = parseBackendOverrides((form.get('backendOverrides') ?? '').split(/[\r\n,]+/).join(',')); }
        catch (e) { throw new HttpError(400, (e as Error).message.replace('AGENT_BACKEND_OVERRIDES', '覆盖表')); }
        try {
          await opts.settings.update({ agentBackend: form.get('agentBackend') as RuntimeSettings['agentBackend'], backendOverrides: overrides,
            codexReplyMode: form.get('codexReplyMode') as RuntimeSettings['codexReplyMode'], codexReasoningEffort: form.get('codexReasoningEffort') as RuntimeSettings['codexReasoningEffort'],
            alertOwner: form.get('alertOwner') === 'on' }, 'dashboard');
        } catch (e) { throw new HttpError(400, '设置未保存：取值不在允许范围内。' + ((e as { issues?: { path: unknown[] }[] }).issues?.map(i => i.path.join('.')).join('、') ?? '')); }
        back('/settings?ok=saved'); return;
      }
      if (url.pathname === '/settings/agent-md') {
        await guardAgentMd(agentMd, form.get('revision') ?? '');
        const r = await writeAgentMd(agentMd, form.get('content') ?? '');
        tracer.event(SETTINGS_TICKET, 'prompt_changed', { detail: { target: 'pi', source: 'dashboard', file: 'prompts/agent.md', bytes_before: r.before, bytes_after: r.after } });
        back('/settings?ok=prompt#prompt'); return;
      }
      if (url.pathname === '/settings/codex-prompt') {
        if (!opts.codexPrompt) throw new HttpError(404, 'codex 系统提示不可用');
        try { await opts.codexPrompt.save((form.get('content') ?? '').replace(/\r\n?/g, '\n'), form.get('revision') ?? ''); }
        catch (e) {
          if ((e as Error)?.name === 'StaleRevisionError') throw new HttpError(409, 'codex.md 已在别处被修改，请刷新后再保存');
          throw new HttpError(409, redactText(e instanceof Error && e.message ? e.message : 'codex.md 未保存', 2_000));
        }
        back('/settings?ok=codexPrompt#codex-prompt'); return;
      }
      if (url.pathname === '/codex/reset' || url.pathname === '/pi/reset') {
        const codex = url.pathname === '/codex/reset';
        const key = form.get('key') ?? '';
        const reset = codex ? opts.resetCodex : opts.resetPi;
        if (!reset) throw new HttpError(404, '重置不可用');
        if (!isThreadKey(key)) throw new HttpError(400, '非法的线程键');
        const job = (reset as (k: string) => Promise<string | number | null>)(key).then(old => {
          tracer.event(codex ? '@codex' : '@pi', 'thread_reset', { detail: { source: 'dashboard', backend: codex ? 'codex' : 'pi', [codex ? 'thread_key' : 'conversation_key']: key, archived: old } });
          return old;
        });
        // 进行中的回合可能还要几分钟：最多等 1.5 秒，否则告诉用户已排队。
        const outcome = await Promise.race([job.then(old => old === null ? 'unchanged' : 'reset'), new Promise<string>(r => setTimeout(() => r('queued'), 1500).unref())]);
        job.catch(() => undefined);
        back(`/agents?ok=${outcome}`); return;
      }
      throw new HttpError(404, '没有这个操作');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : '操作失败，详见日志';
      const html = url.pathname.startsWith('/settings') ? await render(new URL('http://localhost/settings'), nonce, { text: message, error: true }) : null;
      res.writeHead(status, {'Content-Type':'text/html; charset=utf-8'}).end(html ?? page({ title: '操作未完成', path: url.pathname, nonce, flash: { text: message, error: true }, body: '<p><a href="/agents">返回</a></p>' }));
    }
  }

  function usageList(): ContextUsage[] {
    try { return opts.contextUsage ? sortUsage(opts.contextUsage.all()) : []; } catch { return []; }
  }
  function usageOf(backend: ContextUsage['backend'], key: string): ContextUsage | null {
    try { return opts.contextUsage?.get(backend, key) ?? null; } catch { return null; }
  }

  async function render(url: URL, nonce: string, flash?: { text: string; error?: boolean }): Promise<string | null> {
    const q = url.searchParams, p = url.pathname;
    const shell = (title: string, body: string, extra: { lead?: string; actions?: string; scripts?: string[]; head?: string } = {}) => page({ title, path: p, nonce, body, flash, ...extra });
    if (p === '/') return shell('运行总览', await overview(), { lead: '现在在处理什么、各依赖是否正常、最近的吞吐与失败。', scripts: ['/assets/usage.js'] });
    if (p === '/live') return shell('进行中的会话', liveBody(), { lead: '正在处理与排队中的消息，按会话分组；事件由服务器实时推送。完成后收进下方列表。', scripts: ['/assets/live.js'],
      actions: '<span id="conn" class="conn">正在连接…</span>' });
    if (p === '/tickets') return shell('票据列表', tickets(q), { lead: '每条消息一张票据。点开查看从收到到回复的完整流转。' });
    if (p.startsWith('/tickets/')) {
      let ticket: string; try { ticket = decodeURIComponent(p.slice(9)); } catch { return null; }
      const body = await ticketDetail(ticket, q); if (body === null) return null;
      return shell('票据全链路', body);
    }
    if (p === '/logs') {
      return shell('实时日志', `<form class="bar"><label>票据<input name="ticket" placeholder="票据前缀" value="${esc(q.get('ticket'))}"></label><label>级别<select name="level"><option value="">全部级别</option>${['debug','info','warn','error'].map(l=>`<option ${q.get('level')===l?'selected':''}>${l}</option>`).join('')}</select></label><button>过滤</button></form><div id="tail" class="log" role="log" aria-live="polite"></div>`,
        { lead: '最近 1000 行结构化日志，随后实时追加。可按票据或级别过滤。', scripts: ['/assets/logs.js'], actions: '<span id="conn" class="conn">正在连接…</span>' });
    }
    if (p === '/context') return shell('上下文检索', contextBody(q), { lead: '与 Codex / pi 的 qq_context 工具看到的内容一致。留空关键词查看最近记录。时间线、摘要与检索对照见<a href="/memory">记忆</a>。' });
    if (p === '/agents') return shell('Agent', await agentsPage(), { lead: '两个执行后端的会话、索引进度与每条线程的上下文占用。点进会话查看每个回合的输入、模型请求、工具调用与回复。', scripts: ['/assets/forms.js', '/assets/usage.js'] });
    if (p.startsWith('/agents/')) return agentsRoute(p, q, nonce, shell);
    if (p === '/memory' || p.startsWith('/memory/')) return memoryPage(p, q, nonce, shell);
    if (p === '/settings') return shell('设置', await settingsBody(), { lead: '修改立即对之后收到的消息生效，无需重启；.env 中的值只是初始默认。', scripts: ['/assets/forms.js'] });
    if (p === '/config') return shell('生效配置', await configBody(), { lead: '启动时从环境变量解析的配置（已脱敏）。运行中可改的项见<a href="/settings">设置</a>。' });
    if (p === '/codex/agents-md') {
      const st = await fs.stat(agentsMd).catch(() => null);
      return shell('全局 AGENTS.md', `<section class="flush"><h2>${esc(agentsMd)} <small>${st ? `修改于 ${esc(fmtTime(st.mtime.getTime()))}` : '文件不存在'}</small></h2>${json(await readText(agentsMd))}<p class="hint">受管规则 + codex.md，保存 codex.md 后重写。在<a href="/settings#codex-prompt">设置页</a>编辑自定义段。</p></section>`,
        { lead: 'codex 每次调用读取的全局规则（只读，已脱敏）。' });
    }
    return null;
  }

  /* ───────── 页面 ───────── */

  async function overview(): Promise<string> {
    const health = asObj(await opts.health());
    const queue = asObj(opts.queue());
    let out = opts.store.degraded ? '<div class="flash err">观测存储已降级（degraded: true）：业务照常运行，但事件与指标暂不落库。</div>' : '';
    const live = opts.live?.snapshot().filter(c => c.finished === null) ?? [];
    out += `<section><h2>现在 <small>${live.length ? `${live.length} 条进行中` : ''}</small></h2>`;
    out += live.length ? `<div class="sheet"><div class="wrap"><table class="list"><tbody>${live.slice(0, 12).map(c => `<tr><td>${statusStamp(c.state)}</td><td class="hide-sm">${esc(scopeLabel(c.scope))}</td><td><span class="excerpt">${esc(c.text || '（无原文）')}</span></td><td>${esc(c.phase ? stageLabel(c.phase) : '—')}</td><td class="num">${esc(fmtMs(Date.now() - c.started))}</td></tr>`).join('')}</tbody></table></div></div><p class="hint"><a href="/live">在实时页查看事件流</a></p>`
      : empty('眼下没有在处理的消息。新消息到达后会出现在这里和<a href="/live">实时页</a>。');
    out += '</section>';

    const usage = usageList();
    out += `<section><h2>上下文占用 <small>${usage.length ? `${usage.length} 条线程，codex 在前，按占比排序` : ''}</small></h2>${usage.length
      ? `<div class="sheet pad"><div class="ctx-list">${usage.map(u => contextBar(u.backend, u.key, u)).join('')}</div></div>`
      : empty(opts.contextUsage ? '还没有线程的占用记录。任一线程完成一个回合后，这里会显示它离上下文窗口还有多远。' : '上下文占用数据源未接入。')}</section>`;

    const bridge = asObj(health.bridge), comfy = asObj(health.comfy), codex = asObj(health.codex), aging = asObj(health.aging);
    const lamp = (name: string, tone: 'ok' | 'fail' | 'warn' | '', note: string) => `<div class="lamp"><b><i class="dot ${tone}" aria-hidden="true"></i>${esc(name)}</b><small>${esc(note)}</small></div>`;
    const lamps = [
      lamp('QQ 连接', bridge.ws_connected === true ? 'ok' : bridge.ws_connected === false ? 'fail' : '', bridge.ws_connected === true ? `在线，累计断线 ${Number(bridge.disconnect_count ?? 0)} 次` : bridge.ws_connected === false ? '离线' : '未知'),
      lamp('ComfyUI', comfy.ok === true ? 'ok' : comfy.ok === false ? 'fail' : 'warn', comfy.ok === true ? String(comfy.comfyui_version ?? comfy.backend ?? '可用') : comfy.ok === false ? '自检失败' : '自检中'),
      lamp('Codex 凭据', codex.ok === true ? 'ok' : codex.ok === false ? 'fail' : 'warn', codex.ok === true ? 'auth.json 就绪' : codex.ok === false ? '缺少或无法读取凭据' : '检查中'),
      lamp('DeepSeek 密钥', health.deepseek_key_present === true ? 'ok' : health.deepseek_key_present === false ? 'fail' : '', health.deepseek_key_present === true ? '已配置' : health.deepseek_key_present === false ? '未配置' : '未知'),
      lamp('聊天记录整理', aging.status === 'ok' ? 'ok' : aging.status === 'failed' ? 'fail' : '', agingNote(aging)),
      lamp('观测存储', opts.store.degraded || health.degraded === true ? 'fail' : 'ok', opts.store.degraded ? '已降级' : `丢弃事件 ${Number(health.dropped_events ?? 0)} 条`),
    ];
    out += `<section><h2>依赖状态</h2><div class="lamps">${lamps.join('')}</div></section>`;

    const tp = (h: number) => opts.store.throughput(Date.now() - h * 3600_000);
    const t1 = tp(1), t24 = tp(24);
    const fig = (label: string, t: { total: number; failed: number; error_rate: number }) => `<div class="sheet pad"><div class="muted">${label}</div><div class="figure">${t.total}<small class="muted"> 条完成</small></div><div class="${t.failed ? 's-fail' : 'muted'}">失败或兜底 ${t.failed} 条（${(t.error_rate * 100).toFixed(t.error_rate && t.error_rate < .1 ? 1 : 0)}%）</div></div>`;
    const scopes = Object.entries(asObj(queue.scopes)).filter(([, n]) => Number(n) > 0);
    out += `<section><h2>吞吐与队列</h2><div class="grid cols-3">${fig('近 1 小时', t1)}${fig('近 24 小时', t24)}<div class="sheet pad"><div class="muted">并发槽位</div><div class="figure">${Number(queue.active ?? 0)} / ${Number(queue.slots ?? 0)}</div><div class="muted">${scopes.length ? scopes.map(([s, n]) => `${esc(scopeLabel(s))} 排队 ${Number(n)} 条`).join('，') : `排队 ${Math.max(0, Number(queue.waiting ?? 0))} 条`}</div></div></div></section>`;

    if (opts.settings) {
      const s = opts.settings.current();
      out += `<section><h2>当前设置 <small><a href="/settings">修改</a></small></h2><div class="sheet pad">${kv([
        ['默认后端', esc(BACKENDS[s.agentBackend] ?? s.agentBackend)],
        ['按会话覆盖', Object.keys(s.backendOverrides).length ? Object.entries(s.backendOverrides).map(([k, v]) => `${esc(scopeLabel(k))} → ${esc(BACKENDS[v] ?? v)}`).join('，') : '无'],
        ['Codex 回复', s.codexReplyMode === 'relay' ? '经模型整理格式' : '直接发送（仅清洗）'], ['Codex 推理强度', esc(s.codexReasoningEffort)], ['owner 告警', s.alertOwner ? '开启' : '关闭']])}</div></section>`;
    }
    const rows = opts.store.degraded ? [] : opts.store.db.prepare('SELECT * FROM metrics WHERE ts=(SELECT MAX(ts) FROM metrics) ORDER BY name LIMIT 150').all() as { name: string; labels_json: string; value: number; ts: number }[];
    out += `<section><details><summary>最近一分钟指标（${rows.length} 项，p50 / p95 等）</summary><div class="sheet mt"><div class="wrap"><table class="list"><thead><tr><th>指标</th><th>标签</th><th class="num">值</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(Object.entries(asObj(JSON.parse(r.labels_json))).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${String(v)}`).join(' '))}</td><td class="num">${esc(Number.isInteger(r.value) ? r.value : r.value.toFixed(3))}</td></tr>`).join('')}</tbody></table></div></div></details></section>`;
    return out;
  }

  function slipHtml(c: LiveCard): string {
    const items = c.items.slice(-30).map(it => `<li class="${it.status === 'failed' ? 'failed' : it.status === 'started' ? 'started' : ''}"><span class="faint">${esc(fmtOffset(Math.max(0, it.ts - c.started)))}</span><span class="sum"><b>${esc(stageLabel(it.stage))}${it.status === 'started' ? ' 开始' : it.status === 'failed' ? ' 失败' : ''}</b>  ${esc([fmtMs(it.duration_ms), it.summary].filter(Boolean).join('  '))}</span></li>`).join('');
    return `<article class="slip${c.state === 'queued' ? ' queued' : ''}" data-ticket="${esc(c.ticket)}"><div class="slip-body"><div class="slip-top">${statusStamp(c.state)}<span class="who">${esc(c.sender || '—')}</span>${c.route ? `<span class="pill">${esc(ROUTES[c.route] ?? c.route)}</span>` : ''}${c.backend ? `<span class="pill">${esc(BACKENDS[c.backend] ?? c.backend)}</span>` : ''}<span class="elapsed">已耗时 ${esc(fmtMs(Date.now() - c.started))}</span>${c.backend && c.thread ? contextBar(c.backend, c.thread, usageOf(c.backend as ContextUsage['backend'], c.thread), { mini: true }) : ''}</div>
<p class="text">${esc(c.text || '（无原文）')}</p><div class="phase">${c.phase ? `<span class="pulse" aria-hidden="true"></span><span>当前：${esc(stageLabel(c.phase))}</span>` : `<span class="faint">${c.state === 'queued' ? '排队等待同一会话的前一条消息' : '阶段之间'}</span>`}</div><ol class="feed">${items}</ol><div class="hint"><a href="/tickets/${uri(c.ticket)}">查看时间线</a></div></div></article>`;
  }

  function liveBody(): string {
    if (!opts.live) return empty('实时总线未启用。');
    const cards = opts.live.snapshot();
    const active = cards.filter(c => c.finished === null), done = cards.filter(c => c.finished !== null);
    const groups = new Map<string, LiveCard[]>();
    for (const c of active) groups.set(c.scope, [...(groups.get(c.scope) ?? []), c]);
    const outcome = (c: LiveCard) => c.outcome === 'reply_sent' ? 'sent' : c.outcome === 'fallback' ? 'fallback' : 'failed';
    return `<section class="flush"><h2 id="live-count">${active.length ? `${active.length} 条进行中` : '没有进行中的消息'}</h2>
<div id="inflight">${[...groups].map(([scope, list]) => `<div class="scope-group" data-scope="${esc(scope)}"><h3><span>${esc(scopeLabel(scope))}</span><span class="pill">${list.length} 条</span></h3><div class="slips">${list.map(slipHtml).join('')}</div></div>`).join('')}</div>
<div id="inflight-empty"${active.length ? ' hidden' : ''}>${empty('眼下没有在处理的消息。新消息到达后，这里会立即出现一张单据，并实时显示它走到哪一步。')}</div></section>
<section><h2>刚刚完成 <small>最近 30 条，保留半小时</small></h2><div id="done" class="done-list">${done.map(c => `<details data-ticket="${esc(c.ticket)}"><summary>${statusStamp(outcome(c))}<span class="excerpt">${esc(c.text || '（无原文）')}</span><span class="faint">${esc(scopeLabel(c.scope))}  ${esc(fmtMs((c.finished ?? c.updated) - c.started))}</span><a href="/tickets/${uri(c.ticket)}">时间线</a></summary></details>`).join('')}</div>
<div id="done-empty"${done.length ? ' hidden' : ''}>${empty('还没有完成的消息。')}</div></section>`;
  }

  function tickets(q: URLSearchParams): string {
    const filters = Object.fromEntries(['status','scope','route','backend'].map(k=>[k,q.get(k) ?? ''])) as Record<string, string>;
    const n = Math.max(0,Math.min(100000,Number(q.get('page'))||0));
    const opt = (name: string, choices: [string, string][]) => `<select name="${name}"><option value="">全部</option>${choices.map(([v, l]) => `<option value="${esc(v)}"${filters[name] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    let body = `<form class="bar"><label>状态${opt('status', [['processing','处理中'],['sent','已回复'],['failed','失败'],['timeout','超时'],['fallback','兜底']])}</label>
<label>会话域<input name="scope" placeholder="group:123 或 private:456" value="${esc(filters.scope)}"></label><label>路由${opt('route', Object.entries(ROUTES))}</label><label>后端${opt('backend', Object.entries(BACKENDS))}</label><button>筛选</button>${Object.values(filters).some(Boolean) ? '<a class="btn quiet" href="/tickets">清除</a>' : ''}</form>`;
    const rows = opts.store.tickets({ ...filters, page: n });
    body += rows.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>状态</th><th>收到</th><th>会话 / 发送者</th><th class="hide-sm">路由 / 后端</th><th class="num">耗时</th><th class="hide-sm">票据</th></tr></thead><tbody>${rows.map(r => `<tr><td>${statusStamp(r.status)}</td><td>${time(r.ts)}</td><td>${esc(scopeLabel(r.scope))}<br><small>${esc(r.sender ?? '')}</small></td><td class="hide-sm">${esc(ROUTES[r.route ?? ''] ?? r.route ?? '—')}<br><small>${esc(BACKENDS[r.backend ?? ''] ?? r.backend ?? '')}</small></td><td class="num">${esc(fmtMs(r.duration_ms))}</td><td class="hide-sm"><a class="mono" href="/tickets/${uri(r.ticket)}">${esc(r.ticket.slice(0, 12))}</a></td></tr>`).join('')}</tbody></table></div></div>`
      : empty(n ? '这一页没有更多票据了。' : '没有符合条件的票据。换个筛选条件，或清除筛选查看全部。');
    const link = (page: number) => { q.set('page', String(page)); return `/tickets?${esc(queryLink(q))}`; };
    body += `<p class="hint mt">${n ? `<a href="${link(n - 1)}">上一页</a>　` : ''}第 ${n + 1} 页${rows.length === 50 ? `　<a href="${link(n + 1)}">下一页</a>` : ''}</p>`;
    return body;
  }

  async function ticketDetail(ticket: string, q: URLSearchParams): Promise<string | null> {
    const after = Math.max(0,Number(q.get('after'))||0), limit = Math.max(1,Math.min(200,Number(q.get('limit'))||100));
    const events = opts.store.events(ticket,{after,limit});
    if (!events.length) return null;
    const all = opts.store.events(ticket, { limit: 2000 });
    const detail = (e: ObsEvent) => asObj(JSON.parse(e.detail_json));
    const received = all.find(e => e.stage === 'received' || (e.stage === 'recovered' && detail(e).text !== undefined));
    const route = all.map(e => detail(e).route).find(v => typeof v === 'string') as string | undefined;
    const backend = all.find(e => e.stage.startsWith('backend:'))?.stage.slice(8) ?? (all.map(e => detail(e).backend).find(v => typeof v === 'string') as string | undefined);
    const status = ticketStatus(all);
    const t0 = all[0]!.ts, t1 = all.at(-1)!.ts;
    let body = `<div class="sheet pad"><div class="slip-top">${statusStamp(status, true)}<span class="mono faint">${esc(ticket)}</span></div><div class="mt">${kv([
      ['会话', esc(scopeLabel(all.find(e => e.scope)?.scope ?? ''))], ['发送者', esc(received ? detail(received).sender ?? '—' : '—')],
      ['路由', esc(ROUTES[route ?? ''] ?? route ?? '—')], ['后端', esc(BACKENDS[backend ?? ''] ?? backend ?? '—')],
      ['收到', esc(fmtTime(t0))], ['总耗时', esc(fmtMs(t1 - t0))]], 'meta')}</div></div>`;
    if (received) body += `<section><h2>原文</h2><blockquote class="said">${esc(detail(received).text ?? '')}</blockquote><p class="hint">正文、提示词和回复只保存脱敏后的前 500 字。历史由工具按需获取，没有自动注入近期上下文。</p></section>`;
    body += `<section><h2>流转轨迹 <small>${events.length} 个事件${after ? '（续）' : ''}</small></h2><ol class="trail">${events.map(e => {
      const d = detail(e), terminal = ['reply_sent','failed','fallback'].includes(e.stage) && d.terminal === true;
      const sum = summarize({ stage: e.stage, status: e.status, detail: d });
      return `<li class="${e.status === 'started' ? 'started' : e.status === 'failed' ? 'failed' : 'ok'}${terminal ? ' terminal' : ''}"><div class="row"><span class="t">+${esc(fmtMs(e.ts - t0) || '0 毫秒')}</span><span class="stage">${esc(stageLabel(e.stage))}${e.status === 'started' ? ' 开始' : ''}</span>${e.status === 'failed' ? stamp('失败', 'fail') : ''}${e.duration_ms !== null ? `<span class="muted">${esc(fmtMs(e.duration_ms))}</span>` : ''}<code class="faint">${esc(e.stage)}</code></div>${sum ? `<div class="sum">${esc(sum)}</div>` : ''}<details><summary>详情</summary>${json(d)}</details></li>`;
    }).join('')}</ol>`;
    if (events.length === limit) body += `<p><a href="/tickets/${uri(ticket)}?after=${events.at(-1)!.id}&amp;limit=${limit}">下一页事件</a></p>`;
    body += '</section>';
    if (/^[A-Za-z0-9_-]{1,128}$/.test(ticket)) {
      const root = path.join(opts.config.imagesDir,ticket);
      const names = await fs.readdir(root,{recursive:true}).catch(()=>[] as string[]);
      const thumbs: string[] = [];
      for (const name of names.slice(0,200)) {
        try { const parts = [ticket,...name.split(path.sep)]; await imageFile(opts.config.imagesDir,parts);
          const src = '/images/'+parts.map(uri).join('/'); thumbs.push(`<a href="${src}"><img loading="lazy" src="${src}" alt="生成图 ${esc(name)}"></a>`);
        } catch { /* 只展示允许的位图 */ }
      }
      if (thumbs.length) body += `<section><h2>生成图片 <small>${thumbs.length} 张</small></h2><div class="thumbs">${thumbs.join('')}</div></section>`;
    }
    return body;
  }

  function contextBody(q: URLSearchParams): string {
    const scope = q.get('scope') ?? '';
    const scopes = opts.context.scopes();
    let body = `<form class="bar"><label>会话域<select name="scope"><option value="">全部（owner 视角）</option>${scopes.map(s=>`<option value="${esc(s)}" ${s===scope?'selected':''}>${esc(scopeLabel(s))}</option>`).join('')}</select></label><label>关键词<input name="query" placeholder="留空查看最近记录" value="${esc(q.get('query'))}"></label><button>检索</button></form>`;
    const query = q.get('query');
    const result = callQQContextTool({access:scope?{kind:'scope',scope}:{kind:'all'},openStore:()=>opts.context,maxChars:opts.config.QQ_CONTEXT_MAX_CHARS},query?'qq_search':'qq_recent',query?{query,days:180,limit:20}:{limit:30});
    body += `<p class="muted">${query ? 'qq_search 结果' : 'qq_recent 最近 30 条'}（${esc(scope ? scopeLabel(scope) : '全部会话')}）　${scope ? `<a href="/memory/scopes/${uri(scope)}">在记忆时间线中查看</a>` : '<a href="/memory">记忆总览</a>'}</p>` + json(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    return body;
  }

  /* ───────── Agent → 会话 → 回合（观测 v2，数据取自 /api/agents/* 的同一路由） ───────── */

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
  const apiError = (r: { status: number; body: unknown }) => typeof asObj(r.body).error === 'string' ? String(asObj(r.body).error) : `HTTP ${r.status}`;
  const sessionApi = (backend: string, id: string) => `/api/agents/${encodeURIComponent(backend)}/sessions/${encodeURIComponent(id)}`;

  async function agentsPage(): Promise<string> {
    const sum = await api('/api/agents');
    const summaries = sum.status === 200 && Array.isArray(sum.body) ? sum.body as AgentSummary[] : [];
    const error = sum.status === 200 ? undefined : `会话索引暂不可用：${apiError(sum)}`;
    const codexStatus = await opts.codex().catch(() => null);
    const threads: Record<string, unknown>[] = Array.isArray(codexStatus) ? codexStatus.map(asObj) : Object.entries(asObj(codexStatus)).map(([thread_key, thread_id]) => ({ thread_key, thread_id }));
    const codexTargets: ResetTarget[] = threads.map(t => String(t.thread_key)).filter(isThreadKey).sort((a, b) => Number(b === "owner") - Number(a === "owner") || a.localeCompare(b)).map(key => ({ key, label: key === 'owner' ? 'owner 线程' : scopeLabel(key),
      enabled: !!opts.resetCodex && !!threads.find(t => String(t.thread_key) === key)?.thread_id }));
    const piStatus = asObj(await opts.pi().catch(() => ({})));
    const piKeys = [...new Set([...Object.keys(asObj(piStatus.threads)), ...(Array.isArray(piStatus.keys) ? piStatus.keys.map(String) : [])])].sort();
    // 有占用记录的按占比降序，没有记录的会话排在后面显示占位条（与旧 /pi 页一致）。
    const piUsage = sortUsage(usageList().filter(u => u.backend === 'pi')).map(u => u.key);
    const cards: Record<'codex' | 'pi', AgentCardInput> = {
      codex: { summary: summaries.find(x => x.backend === 'codex'), error, threads: codexTargets, usage: k => usageOf('codex', k) },
      pi: { summary: summaries.find(x => x.backend === 'pi'), error, usage: k => usageOf('pi', k),
        threads: [...piUsage.filter(k => piKeys.includes(k)), ...piKeys.filter(k => !piUsage.includes(k))].map(key => ({ key, label: ` ${scopeLabel(key)} 的会话`, enabled: !!opts.resetPi })),
        extraUsageKeys: piUsage.filter(k => !piKeys.includes(k)) },
    };
    return agentsBody(cards, csrf);
  }

  type Shell = (title: string, body: string, extra?: { lead?: string; actions?: string; scripts?: string[]; head?: string }) => string;

  /** /memory/*（设计 §1、§5）：数据取自 /api/memory/* 的同一路由；未知 scope / 摘要 / 子路由返回 null（404）。 */
  async function memoryPage(p: string, q: URLSearchParams, nonce: string, shell: Shell): Promise<string | null> {
    const now = Date.now();
    const overview = async () => { const r = await api('/api/memory'); return r.status === 200 ? r.body as MemoryOverview : null; };
    if (p === '/memory') {
      const r = await api('/api/memory');
      const body = r.status === 200 ? memoryHomeBody(r.body as MemoryOverview, now) : `<div class="flash err" role="alert">读取记忆总览失败：${esc(apiError(r))}</div>`;
      return shell('记忆', body, { lead: '聊天记录库的会话域、日 / 周摘要、整理与保留期；从这里进入时间线、检索检查器和线程归档。' });
    }
    if (p === '/memory/recalls') return shell('召回记录', placeholderBody('召回记录', 'O5'), { lead: '工具召回了哪些记忆、是否进入模型请求（设计 §5.3 第三级证据）。' });
    if (p === '/memory/images') return shell('图片记忆', placeholderBody('图片记忆', 'O6'), { lead: '已入库图片的画廊（设计 §5.4）。' });
    if (p === '/memory/archives') {
      const r = await api('/api/memory/archives');
      return shell('线程归档', archivesPageBody(r.status === 200 ? r.body as ArchivesResult : { error: apiError(r) }), { lead: '重置线程时归档的 Codex / Pi 会话，以及 Pi 的上下文压缩记录；点会话 ID 进入回合流。' });
    }
    if (p === '/memory/search') {
      const f = { scope: q.get('scope') ?? '', q: (q.get('q') ?? '').trim(), days: (q.get('days') ?? '').trim(), limit: (q.get('limit') ?? '').trim() };
      const scopes = (await overview())?.scopes ?? [];
      let result: SearchResult | { error: string } | undefined;
      if (f.q) {
        const query = new URLSearchParams({ q: f.q });
        if (f.scope) query.set('scope', f.scope);
        if (f.days) query.set('days', f.days);
        if (f.limit) query.set('limit', f.limit);
        const r = await api(`/api/memory/search?${query}`);
        result = r.status === 200 ? r.body as SearchResult : { error: `检索失败：${apiError(r)}` };
      }
      return shell('检索检查器', searchPageBody(f, scopes, result), { lead: '同一次检索的两级证据：数据库命中了什么，qq_search 工具裁剪后实际会返回什么。' });
    }
    const parts = p.split('/');
    if (parts.length !== 4 || (parts[2] !== 'scopes' && parts[2] !== 'summaries')) return null;
    let key: string;
    try { key = decodeURIComponent(parts[3] ?? ''); } catch { return null; }
    // 与接口相同的 scope 规则：非法值（含斜杠、控制字符、. / ..）没有对应页面。
    if (!key || key.length > 256 || key === '.' || key === '..' || /[\\/\x00-\x1f\x7f]/.test(key)) return null;
    if (parts[2] === 'summaries') {
      if (!/^[1-9]\d{0,15}$/.test(key)) return null;
      const r = await api(`/api/memory/summaries/${encodeURIComponent(key)}`);
      if (r.status === 404 || r.status === 400) return null;
      if (r.status !== 200) return shell('摘要', `<div class="flash err" role="alert">读取摘要失败：${esc(apiError(r))}</div>`);
      const s = r.body as SummaryDetail;
      const label = (await overview())?.scopes.find(x => x.scope === s.scope)?.label ?? scopeLabel(s.scope);
      return shell(`${s.kind === 'week' ? '周摘要' : '日摘要'} #${s.id}`, summaryPageBody(s, label), { lead: '摘要正文与覆盖区间；尚存原文为当前仍在库中的消息数。' });
    }
    const base = `/api/memory/scopes/${encodeURIComponent(key)}`;
    const params = rangeParams(q);
    const tr = await api(`${base}${params.size ? '?' + params : ''}`);
    if (tr.status === 404) return null;
    if (tr.status !== 200) {
      return shell(scopeLabel(key), `<div class="flash err" role="alert">读取时间线失败：${esc(apiError(tr))}</div><p class="mt"><a href="/memory/scopes/${uri(key)}">查看全部区间</a>　<a href="/memory">返回记忆</a></p>`,
        { lead: '区间参数接受毫秒时间戳、YYYY-MM-DD（UTC）或带时区的 ISO 时间，且 from 早于 to。' });
    }
    const timeline = tr.body as ScopeTimeline;
    const win = messageWindow(timeline.range.first_ts, timeline.range.last_ts);
    const mq = new URLSearchParams({ before: String(win.before), limit: String(MESSAGE_PAGE) });
    if (win.after !== undefined) mq.set('after', String(win.after));
    const mr = await api(`${base}/messages?${mq}`);
    const messages = mr.status === 200 ? mr.body as MessagePage : { error: apiError(mr), status: mr.status };
    // vis-timeline 固定版本，同源提供（设计 §5.1）；defer 脚本与模块脚本按文档顺序执行，memory.js 运行时 vis 已就绪。
    const vendor = !!vendorAsset('vis-timeline.js') && !!vendorAsset('vis-timeline.css');
    const head = vendor ? `<link rel="stylesheet" href="/assets/vendor/vis-timeline.css"><script nonce="${nonce}" defer src="/assets/vendor/vis-timeline.js"></script>` : '';
    return shell(timeline.label, scopePageBody({ timeline, messages, nonce, now, params, vendor }),
      { lead: '原文 / 日摘要 / 周摘要三条轨、空白区间与保留期边界；下方列出所选窗口内的消息。', scripts: ['/assets/memory.js'], head });
  }
  /** /agents/:backend/sessions[/:id[/turns/:turn | /context]]；未知后端、会话或回合返回 null（404）。 */
  async function agentsRoute(p: string, q: URLSearchParams, nonce: string, shell: Shell): Promise<string | null> {
    const parts = p.split('/');
    const backend = parts[2] ?? '';
    if (!isBackend(backend) || parts[3] !== 'sessions' || parts.length > 7) return null;
    const name = BACKENDS[backend] ?? backend;
    if (parts.length === 4) {
      const f = { status: q.get('status') ?? '', scope: q.get('scope') ?? '', since: q.get('since') ?? '', page: Math.max(0, Math.min(1_000_000, Math.floor(Number(q.get('page')) || 0))) };
      if (f.status !== 'active' && f.status !== 'archived') f.status = '';
      const query = new URLSearchParams();
      if (f.status) query.set('status', f.status);
      if (f.scope) query.set('scope', f.scope);
      if (f.since) query.set('since', f.since);
      query.set('page', String(f.page));
      const r = await api(`/api/agents/${backend}/sessions?${query}`);
      const rows = r.status === 200 && Array.isArray(r.body) ? r.body as SessionRef[] : null;
      return shell(`${name} 会话`, sessionListBody(backend, rows, f, rows ? undefined : `读取会话失败：${apiError(r)}`),
        { lead: '活动与归档会话，按更新时间倒序。ID 为后端真实会话 ID。', scripts: ['/assets/agents.js'] });
    }
    let id: string, turnId = '';
    try { id = decodeURIComponent(parts[4] ?? ''); if (parts[6] !== undefined) turnId = decodeURIComponent(parts[6]); } catch { return null; }
    if (!id || (parts.length === 6 && parts[5] !== 'context') || (parts.length === 7 && (parts[5] !== 'turns' || !turnId))) return null;
    const sr = await api(sessionApi(backend, id));
    if (sr.status === 404 || sr.status === 400) return null;
    if (sr.status !== 200) return shell(`${name} 会话`, `<div class="flash err" role="alert">读取会话失败：${esc(apiError(sr))}</div>`);
    const { session, turns } = sr.body as { session: SessionRef; turns: ObservedTurn[] };
    const window = session.scope ? usageOf(backend, session.scope)?.windowTokens : undefined;
    const ctx = { backend, session: session.id, ...(window ? { window } : {}) };
    const title = session.label && session.label !== session.id ? session.label : sessionScope(backend, session.scope);
    const newest = byNewest(turns);
    const dataTail = dataScript('agents-data', nonce, { backend, session: session.id, active: false, window: window ?? null, base: 0 });
    if (parts.length === 5) {
      const pageNo = Math.max(0, Math.min(100_000, Math.floor(Number(q.get('page')) || 0)));
      const preload = new Map<string, Block[]>();
      await Promise.all(newest.slice(pageNo * 50, pageNo * 50 + PRELOAD_TURNS).map(async t => {
        const r = await api(`${sessionApi(backend, id)}/turns/${encodeURIComponent(t.turn)}`);
        if (r.status === 200) preload.set(t.turn, (asObj(r.body).blocks as Block[] | undefined) ?? []);
      }));
      return shell(`${name} · ${title}`, sessionPageBody({ ctx, session, turns, page: pageNo, preload, usage: session.scope ? usageOf(backend, session.scope) : null, nonce }),
        { lead: '左侧回合目录，右侧回合流（最新在上，默认展开）。上下文占用取每个回合最后一次模型请求的实测输入。', scripts: ['/assets/agents.js', '/assets/usage.js'] });
    }
    if (parts[5] === 'turns') {
      const tr = await api(`${sessionApi(backend, id)}/turns/${encodeURIComponent(turnId)}`);
      if (tr.status === 404 || tr.status === 400) return null;
      if (tr.status !== 200) return shell('回合详情', `<div class="flash err" role="alert">读取回合失败：${esc(apiError(tr))}</div>`);
      const { turn, blocks } = tr.body as { turn: ObservedTurn; blocks: Block[] };
      const k = newest.findIndex(t => t.turn === turn.turn);
      return shell('回合详情', turnPageBody(ctx, session, turn, blocks, { newer: k > 0 ? newest[k - 1]?.turn : undefined, older: k >= 0 ? newest[k + 1]?.turn : undefined }) + dataTail,
        { lead: '输入 → 模型请求（可多次）→ 工具调用（参数与结果折叠）→ 助手文本 → 送达。', scripts: ['/assets/agents.js'] });
    }
    // 上下文结构分析（设计 §4）：分析接口由 O3 提供；缺席（404/501/503）时给出不可用状态。
    const at = q.get('at') || newest[0]?.turn || '';
    const phase = q.get('phase') === 'before' ? 'before' : 'after';
    const head = crumbs([['Agent', '/agents'], [name, sessionsHref(backend)], [title, sessionHref(backend, session.id)], ['上下文分析']]);
    const lead = `回合 <span class="mono">${esc(at ? at.slice(0, 40) : '—')}</span> ${phase === 'before' ? '请求发出前' : '结束后'}的上下文窗口构成。实测与估算分开标注，未解释差额单列。`;
    if (!at) return shell('上下文分析', head + empty('这个会话还没有回合，无法分析。') + dataTail, { lead });
    const ar = await api(`${sessionApi(backend, id)}/context?${new URLSearchParams({ at, phase })}`);
    const body = ar.status === 200 && ar.body && typeof ar.body === 'object' ? contextAnalysisBody(ctx, ar.body as ContextAnalysis)
      : [404, 501, 503].includes(ar.status) ? contextUnavailable(ctx, at, phase, ar.status, typeof asObj(ar.body).error === 'string' ? String(asObj(ar.body).error) : undefined)
        : contextError(ctx, at, phase, ar.status, apiError(ar));
    return shell('上下文分析', head + body + dataTail, { lead, scripts: ['/assets/agents.js'] });
  }

  async function settingsBody(): Promise<string> {
    let body = '';
    if (!opts.settings) body += '<div class="flash err">运行时设置不可用，以下为只读的启动配置。</div>';
    const s = opts.settings?.current();
    const d = opts.settings?.defaults;
    const diff = (k: keyof RuntimeSettings) => s && d && JSON.stringify(s[k]) !== JSON.stringify(d[k]) ? ' <span class="changed">与 .env 不同</span>' : '';
    if (s) {
      const radio = (name: string, value: string, label: string, note: string) => `<label class="choice"><input type="radio" name="${name}" value="${esc(value)}"${(s as unknown as Record<string, unknown>)[name] === value ? ' checked' : ''}><span>${esc(label)}<small>${note}</small></span></label>`;
      body += `<section class="flush"><form method="post" action="/settings" class="sheet pad">${csrfField(csrf)}
<fieldset><legend>执行后端${diff('agentBackend')}</legend><div class="choices">${radio('agentBackend', 'codex', 'Codex', '容器内 codex CLI，owner 与共享两条长期线程，可用浏览器与命令。')}${radio('agentBackend', 'pi', 'Pi', '进程内 pi 会话，每个会话域独立记忆，联网检索走 DeepSeek。')}</div></fieldset>
<fieldset><legend>按会话覆盖${diff('backendOverrides')}</legend><label>每行一项，例如 group:200000001=pi<textarea name="backendOverrides" rows="4" spellcheck="false">${esc(formatBackendOverrides(s.backendOverrides))}</textarea></label><div class="hint">留空表示全部使用上面的默认后端。会话域格式为 group:群号 或 private:QQ号。</div></fieldset>
<fieldset><legend>Codex 回复方式${diff('codexReplyMode')}</legend><div class="choices">${radio('codexReplyMode', 'relay', '整理后发送', '由意图模型把 Codex 的回答整理成适合 QQ 的纯文本，失败时退回清洗。')}${radio('codexReplyMode', 'direct', '直接发送', '只做代码清洗（去掉 Markdown 等）。')}</div></fieldset>
<fieldset><legend>Codex 推理强度${diff('codexReasoningEffort')}</legend><label><select name="codexReasoningEffort">${REASONING_EFFORTS.map(e => `<option${s.codexReasoningEffort === e ? ' selected' : ''}>${e}</option>`).join('')}</select></label><div class="hint">每轮以 -c 参数传给 codex，下一轮即生效。</div></fieldset>
<fieldset><legend>owner 告警${diff('alertOwner')}</legend><label class="choice"><input type="checkbox" name="alertOwner"${s.alertOwner ? ' checked' : ''}><span>向 owner 私聊发送告警<small>QQ 离线超过五分钟、模型鉴权失败、连续三条失败时发送，30 分钟内最多一条。${opts.config.owner ? '' : '（当前没有配置 owner，开关不会生效）'}</small></span></label></fieldset>
<button>保存设置</button></form></section>`;
    }
    body += await codexPromptCard();
    let prompt = '';
    try { const st = await fs.lstat(agentMd); prompt = st.isFile() && !st.isSymbolicLink() && st.size <= 256_000 ? await fs.readFile(agentMd, 'utf8') : ''; } catch { /* 不存在：pi 启动时会播种 */ }
    const promptStat = await fs.lstat(agentMd).catch(() => null);
    const mtime = promptStat?.mtime;
    // 编辑框显示原文以便保存时不破坏内容；但若其中出现已注册的秘密则只读展示脱敏版。
    const secretInside = redactText(prompt, 1_000_000) !== prompt;
    body += `<section id="prompt"><h2>pi 系统提示 agent.md <small>${mtime ? `修改于 ${esc(fmtTime(mtime.getTime()))}` : '尚未创建'}</small></h2>${secretInside
      ? `<div class="flash err">文件中包含凭据样式的内容，面板只读展示脱敏版本；请在容器内直接编辑。</div>${json(prompt)}`
      : `<form method="post" action="/settings/agent-md" class="sheet pad">${csrfField(csrf)}<input type="hidden" name="revision" value="${esc(agentMdRevision(promptStat))}"><label>每轮对话前热加载，保存后 pi 下一轮即使用新内容。<textarea name="content" rows="18" spellcheck="false" data-count="agent-md-count">${esc(prompt)}</textarea></label><div class="hint"><span id="agent-md-count"></span>，上限 ${AGENT_MD_MAX_BYTES / 1024} KB</div><p class="mt"><button>保存 agent.md</button></p></form>`}</section>`;
    body += `<section><h2>线程</h2><div class="sheet pad"><p>重置会归档当前会话并在下一条消息时新建，用于清掉跑偏的长期记忆。</p><p><a href="/agents">Agent 页（Codex owner / 共享线程、Pi 各会话域）</a></p></div></section>`;
    const changes = opts.store.systemEvents(SETTINGS_TICKET, 15);
    body += `<section><h2>最近变更</h2>${changes.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>内容</th><th>来源</th></tr></thead><tbody>${changes.map(e => { const dd = asObj(JSON.parse(e.detail_json));
      const bytes = (v: unknown) => typeof v === 'number' ? fmtBytes(v) : '—';
      const what = e.stage === 'prompt_changed' ? `${dd.target === 'codex' ? 'codex.md' : 'agent.md'} ${bytes(dd.bytes_before)} → ${bytes(dd.bytes_after)}` : Object.keys(asObj(dd.after)).map(k => `${SETTING_LABELS[k] ?? k}：${showSetting(asObj(dd.before)[k])} → ${showSetting(asObj(dd.after)[k])}`).join('；');
      return `<tr><td>${time(e.ts)}</td><td>${esc(what)}</td><td>${esc(dd.source === 'dashboard' ? '面板' : dd.source ?? '')}</td></tr>`; }).join('')}</tbody></table></div></div>` : empty('还没有通过面板修改过设置。')}</section>`;
    body += `<section><p class="hint">完整的生效配置见<a href="/config">配置页</a>；结构化日志见<a href="/logs">实时日志</a>。</p></section>`;
    return body;
  }

  async function codexPromptCard(): Promise<string> {
    const head = (note: string) => `<section id="codex-prompt"><h2>codex 系统提示 codex.md <small>${note}</small></h2>`;
    const link = '<p class="hint"><a href="/codex/agents-md">查看完整 AGENTS.md</a>（受管规则 + codex.md，只读）</p>';
    if (!opts.codexPrompt) return `${head('')}${empty('codex 系统提示存储未接入。')}${link}</section>`;
    let snap: CodexPromptSnapshot;
    try { snap = await opts.codexPrompt.read(); } catch { return `${head('')}<div class="flash err">读取 codex.md 失败，详见日志。</div>${link}</section>`; }
    const secretInside = redactText(snap.custom, 1_000_000) !== snap.custom;
    const editor = secretInside
      ? `<div class="flash err">codex.md 中包含凭据样式的内容，面板只读展示脱敏版本；请在容器内直接编辑。</div>${json(redactText(snap.custom, 1_000_000))}`
      : `<form method="post" action="/settings/codex-prompt" class="sheet pad">${csrfField(csrf)}<input type="hidden" name="revision" value="${esc(snap.revision)}"><label>拼接在受管规则之后写入全局 AGENTS.md，codex 下一条消息即使用新内容。<textarea name="content" rows="18" spellcheck="false" data-count="codex-md-count">${esc(snap.custom)}</textarea></label><div class="hint"><span id="codex-md-count"></span>，上限 ${AGENT_MD_MAX_BYTES / 1024} KB</div><p class="mt"><button>保存 codex.md</button></p></form>`;
    return `${head(snap.updatedAt ? `修改于 ${esc(fmtTime(snap.updatedAt))}` : '尚未修改')}${editor}<details class="mt"><summary>受管规则（程序生成，不可编辑）</summary>${json(redactText(snap.managed, 1_000_000))}</details>${link}</section>`;
  }

  async function configBody(): Promise<string> {
    const cfg = asObj(redact(opts.config, 2_000));
    const rows = Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b));
    let body = `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>项</th><th>值</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('')}</tbody></table></div></div>`;
    const st = await fs.stat(agentMd).catch(() => null);
    body += `<section><h2>agent.md <small>${st ? `修改于 ${esc(fmtTime(st.mtime.getTime()))}` : '文件不存在'}</small></h2>${json(await readText(agentMd))}<p class="hint">在<a href="/settings#prompt">设置页</a>编辑。</p></section>`;
    return body;
  }

  return { handle: (req: IncomingMessage,res: ServerResponse) => handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('观测页面暂不可用');}),
    close: async () => {closed=true;for(const res of clients)res.end();clients.clear();if(typeof offCodexPrompt==='function')offCodexPrompt();
      await Promise.all(Object.values(adapters).map(adapter => adapter.close?.()));} };
}
