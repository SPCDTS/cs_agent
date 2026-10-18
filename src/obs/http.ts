import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes, createHash, createHmac, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { ContextStore } from '../context/store.js';
import { callQQContextTool } from '../mcp/qq-context-server.js';
import { logBuffer, type LogLine } from '../log.js';
import { redact, redactText } from './redact.js';
import type { ObsEvent, ObsStore } from './store.js';
import { loadImage } from '../qq/image.js';
import { trace as defaultTrace, type Trace } from './trace.js';
import { summarize, type LiveBus, type LiveCard, type LiveMessage } from './live.js';
import type { SettingsStore, RuntimeSettings } from '../agent/settings.js';
import { formatBackendOverrides, SETTINGS_TICKET } from '../agent/settings.js';
import { parseBackendOverrides } from '../agent/backends/select.js';
import { REASONING_EFFORTS } from '../agent/codex-runner.js';
import { ASSETS } from './ui/client.js';
import { contextBar, sortUsage, type ContextUsage, type ContextUsageView } from './ui/context-bar.js';
import { BACKENDS, ROUTES, csrfField, empty, esc, fmtBytes, fmtMs, fmtOffset, fmtTime, json, kv, page, scopeLabel, stageLabel, stamp, statusStamp, time, uri, type Tone } from './ui/html.js';

export { esc };
const queryLink = (q: URLSearchParams) => new URLSearchParams([...q].map(([k,v])=>[redactText(k,100_000),redactText(v,100_000)])).toString();
const MAX_SSE = 20;
/** SSE 写队列：未写出字节（队列 + socket 缓冲）超过上限，或一次 drain 等待超过时限才断开慢客户端。 */
export const SSE_MAX_PENDING = 2 * 1024 * 1024;
export const SSE_DRAIN_TIMEOUT_MS = 10_000;

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
export const AGENT_MD_MAX_BYTES = 64 * 1024;

export interface DashboardOptions {
  config: Config; store: ObsStore; context: ContextStore;
  health: () => unknown | Promise<unknown>; queue: () => unknown;
  codex: () => Promise<unknown>; pi: () => Promise<unknown>;
  /** 运行时设置（/settings 可写）；缺省时设置页只读展示配置 */
  settings?: SettingsStore;
  /** 进行中会话的实时总线（/live） */
  live?: LiveBus;
  resetCodex?: (key: 'owner' | 'shared') => Promise<string | null>;
  resetPi?: (key: string) => Promise<number | null>;
  trace?: Pick<Trace, 'event'>;
  /** 每线程上下文占用（src/agent/context-usage.ts 的 ContextUsageStore；面板只读 all/get） */
  contextUsage?: ContextUsageView;
}
function equal(a: string, b: string): boolean { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
/** 由访问口令派生的 CSRF 令牌：表单隐藏字段 + 服务端比对；不知道口令无法伪造。 */
export function csrfToken(obsToken: string): string { return createHmac('sha256', obsToken).update('cs-agent-dashboard-csrf-v1').digest('base64url'); }

/** URL 每段与 realpath 双重限制，拒绝软链接和跨票据读取；只允许校验过的位图。 */
export async function imageFile(root: string, segments: string[]): Promise<string> {
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
  reset: '已重置：旧会话已归档，下一条消息会新建会话。', queued: '已排队：当前回合结束后立即重置，旧会话会归档。', unchanged: '没有可重置的会话。',
};

const SETTING_LABELS: Record<string, string> = { agentBackend: '默认后端', backendOverrides: '按会话覆盖', codexReplyMode: 'Codex 回复方式', codexReasoningEffort: 'Codex 推理强度', alertOwner: 'owner 告警' };
const showSetting = (v: unknown) => typeof v === 'boolean' ? (v ? '开启' : '关闭') : v && typeof v === 'object' ? (Object.entries(v).map(([k, b]) => `${k}=${String(b)}`).join(', ') || '无') : String(v);
const asObj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const ticketStatus = (events: ObsEvent[]) => {
  const t = events.filter(e => ['reply_sent','failed','fallback'].includes(e.stage) && JSON.parse(e.detail_json).terminal === true).at(-1);
  if (!t) return 'processing';
  if (t.stage === 'failed') return JSON.parse(t.detail_json).failure === 'timeout' ? 'timeout' : 'failed';
  return t.stage === 'fallback' ? 'fallback' : 'sent';
};

export function createDashboard(opts: DashboardOptions) {
  const clients = new Set<ServerResponse>();
  const token = opts.config.OBS_TOKEN;
  const csrf = token ? csrfToken(token) : '';
  const tracer = opts.trace ?? defaultTrace;
  const agentMd = path.join(opts.config.DATA_DIR, 'prompts', 'agent.md');

  function sse(res: ServerResponse): SseWriter | null {
    if (clients.size >= MAX_SSE) { res.writeHead(503).end(); return null; }
    res.writeHead(200, { 'Content-Type':'text/event-stream', Connection:'keep-alive' }); res.flushHeaders();
    clients.add(res);
    const out = sseWriter(res);
    const heartbeat = setInterval(()=>out.send(': keepalive\n\n'),15_000); heartbeat.unref();
    res.on('close',()=>{ clearInterval(heartbeat); clients.delete(res); });
    return out;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { res.writeHead(400).end(); return; }
    // loopback 面板拒绝任意 Host，防止本地浏览器的 DNS rebinding 读取聊天数据。
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405).end(); return; }
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
    if (post) { await handlePost(req, res, url, nonce, host); return; }
    const q = url.searchParams;
    if (url.pathname.startsWith('/assets/')) {
      const body = ASSETS[url.pathname.slice(8)];
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
    const flashCode = q.get('ok');
    const flash = flashCode && FLASH[flashCode] ? { text: FLASH[flashCode]! } : undefined;
    const html = await render(url, nonce, flash);
    if (html === null) { res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'}).end(page({ title: '没有这个页面', path: url.pathname, nonce, body: empty('地址不对或票据已过保留期。可以从<a href="/tickets">票据列表</a>重新查找。') })); return; }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse, url: URL, nonce: string, host: string): Promise<void> {
    // 同源检查：浏览器提供 Origin / Sec-Fetch-Site 时必须同源；再校验表单内 CSRF 令牌。
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) { res.writeHead(403).end('跨站请求被拒绝'); return; }
    const site = req.headers['sec-fetch-site'];
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
        tracer.event(SETTINGS_TICKET, 'prompt_changed', { detail: { source: 'dashboard', file: 'prompts/agent.md', bytes_before: r.before, bytes_after: r.after } });
        back('/settings?ok=prompt#prompt'); return;
      }
      if (url.pathname === '/codex/reset' || url.pathname === '/pi/reset') {
        const codex = url.pathname === '/codex/reset';
        const key = form.get('key') ?? '';
        const reset = codex ? opts.resetCodex : opts.resetPi;
        if (!reset) throw new HttpError(404, '重置不可用');
        if (codex ? key !== 'owner' && key !== 'shared' : key !== 'owner' && !/^(group|private):[1-9]\d{0,19}$/.test(key)) throw new HttpError(400, '非法的线程键');
        const job = (reset as (k: string) => Promise<string | number | null>)(key).then(old => {
          tracer.event(codex ? '@codex' : '@pi', 'thread_reset', { detail: { source: 'dashboard', backend: codex ? 'codex' : 'pi', [codex ? 'thread_key' : 'conversation_key']: key, archived: old } });
          return old;
        });
        // 进行中的回合可能还要几分钟：最多等 1.5 秒，否则告诉用户已排队。
        const outcome = await Promise.race([job.then(old => old === null ? 'unchanged' : 'reset'), new Promise<string>(r => setTimeout(() => r('queued'), 1500).unref())]);
        job.catch(() => undefined);
        back(`${codex ? '/codex' : '/pi'}?ok=${outcome}`); return;
      }
      throw new HttpError(404, '没有这个操作');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : '操作失败，详见日志';
      const html = url.pathname.startsWith('/settings') ? await render(new URL('http://localhost/settings'), nonce, { text: message, error: true }) : null;
      res.writeHead(status, {'Content-Type':'text/html; charset=utf-8'}).end(html ?? page({ title: '操作未完成', path: url.pathname, nonce, flash: { text: message, error: true }, body: `<p><a href="${url.pathname.startsWith('/pi') ? '/pi' : '/codex'}">返回</a></p>` }));
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
    const shell = (title: string, body: string, extra: { lead?: string; actions?: string; scripts?: string[] } = {}) => page({ title, path: p, nonce, body, flash, ...extra });
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
    if (p === '/context') return shell('上下文检索', contextBody(q), { lead: '与 Codex / pi 的 qq_context 工具看到的内容一致。留空关键词查看最近记录。' });
    if (p === '/codex') return shell('Codex 线程', await codexBody(), { lead: 'owner 私聊与其他会话各用一条长期线程。这里的轮次摘要来自观测事件，不读取会话原文。', scripts: ['/assets/forms.js', '/assets/usage.js'] });
    if (p === '/pi') return shell('Pi 会话', await piBody(), { lead: 'pi 后端按 owner 与每个会话域各保持一个长期会话。', scripts: ['/assets/forms.js', '/assets/usage.js'] });
    if (p === '/settings') return shell('设置', await settingsBody(), { lead: '修改立即对之后收到的消息生效，无需重启；.env 中的值只是初始默认。', scripts: ['/assets/forms.js'] });
    if (p === '/config') return shell('生效配置', await configBody(), { lead: '启动时从环境变量解析的配置（已脱敏）。运行中可改的项见<a href="/settings">设置</a>。' });
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
      lamp('聊天记录整理', aging.status === 'ok' ? 'ok' : aging.status === 'failed' ? 'fail' : '', typeof aging.ts === 'number' ? `上次 ${fmtTime(aging.ts)}` : aging.last_run ? `上次 ${String(aging.last_run)}` : '尚未运行'),
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
    body += `<p class="muted">${query ? 'qq_search 结果' : 'qq_recent 最近 30 条'}（${esc(scope ? scopeLabel(scope) : '全部会话')}）</p>` + json(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    return body;
  }

  function turnsTable(turns: ReturnType<ObsStore['threadTurns']>): string {
    if (!turns.length) return empty('观测记录里还没有这条线程的回合。');
    return `<div class="wrap"><table class="list"><thead><tr><th>状态</th><th>时间</th><th>收到</th><th class="hide-sm">回复</th><th class="num">耗时</th><th class="num hide-sm">工具 / tokens</th></tr></thead><tbody>${turns.map(t => `<tr><td>${statusStamp(t.status)}</td><td><a href="/tickets/${uri(t.ticket)}">${time(t.started)}</a></td><td><span class="excerpt">${esc(t.text || '—')}</span></td><td class="hide-sm"><span class="excerpt">${esc(t.reply || '—')}</span></td><td class="num">${esc(fmtMs(t.duration_ms))}</td><td class="num hide-sm">${t.tools} / ${t.input_tokens ? `${t.input_tokens}→${t.output_tokens}` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const resetForm = (action: string, key: string, label: string, enabled: boolean) => enabled
    ? `<form method="post" action="${action}" data-confirm="重置${esc(label)}？当前会话会归档，下一条消息从空白上下文开始。进行中的回合会先跑完。">${csrfField(csrf)}<input type="hidden" name="key" value="${esc(key)}"><button class="danger">重置线程</button></form>` : '';

  async function codexBody(): Promise<string> {
    const status = await opts.codex();
    const threads: Record<string, unknown>[] = Array.isArray(status) ? status.map(asObj) : Object.entries(asObj(status)).map(([thread_key, thread_id]) => ({ thread_key, thread_id }));
    const known = new Set(threads.map(t => String(t.thread_key)));
    for (const k of ['owner', 'shared']) if (!known.has(k)) threads.push({ thread_key: k, thread_id: null });
    let body = '<div class="grid cols-2">';
    for (const t of threads) {
      const key = String(t.thread_key);
      const turns = opts.store.threadTurns('codex', key, 10);
      body += `<section class="sheet pad flush"><h2>${key === 'owner' ? 'owner 线程' : key === 'shared' ? '共享线程' : esc(key)} <small>${key === 'owner' ? 'owner 私聊' : '群聊与其他私聊'}</small></h2><div class="thread-ctx">${contextBar('codex', key, usageOf('codex', key), { label: '上下文占用' })}</div>${kv([
        ['线程 id', t.thread_id ? `<span class="mono">${esc(t.thread_id)}</span>` : '<span class="muted">尚未创建（下一条消息新建）</span>'],
        ['rollout 大小', esc(fmtBytes(typeof t.rollout_bytes === 'number' ? t.rollout_bytes : null))],
        ['已观测回合', esc(t.observed_turns ?? turns.length)], ['最近活动', turns[0] ? time(turns[0].ts) : '—']])}
<div class="mt">${resetForm('/codex/reset', key, key === 'owner' ? ' owner 线程' : '共享线程', !!opts.resetCodex && !!t.thread_id)}</div></section>`;
    }
    body += '</div>';
    for (const t of threads) body += `<section><h2>${String(t.thread_key) === 'owner' ? 'owner 线程' : '共享线程'}最近 10 轮</h2><div class="sheet">${turnsTable(opts.store.threadTurns('codex', String(t.thread_key), 10))}</div></section>`;
    body += `<section><details><summary>全局 AGENTS.md（受管文件，启动时重写，只读）</summary>${json(await readText(path.join(opts.config.codexHome,'AGENTS.md')))}</details></section>`;
    return body;
  }

  async function piBody(): Promise<string> {
    const status = asObj(await opts.pi());
    const map = asObj(status.threads);
    const keys = [...new Set([...Object.keys(map), ...(Array.isArray(status.keys) ? status.keys.map(String) : [])])].sort();
    let body = '';
    const usageKeys = [...new Set([...keys, ...usageList().filter(u => u.backend === 'pi').map(u => u.key)])];
    if (usageKeys.length) {
      // 有记录的按占比降序，没有记录的会话排在后面显示占位条
      const known = sortUsage(usageKeys.map(k => usageOf('pi', k)).filter((u): u is ContextUsage => !!u));
      const bars = [...known.map(u => contextBar('pi', u.key, u)), ...usageKeys.filter(k => !known.some(u => u.key === k)).map(k => contextBar('pi', k, null))];
      body += `<section class="flush"><h2>上下文占用 <small>两道刻口为后台压缩与阻塞压缩阈值</small></h2><div class="sheet pad"><div class="ctx-list">${bars.join('')}</div></div></section><section>`;
    }
    if (!keys.length) body += empty('还没有 pi 会话。把某个会话域的后端切到 Pi（<a href="/settings">设置</a>）后，第一条消息会新建会话。');
    else body += `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>会话键</th><th>会话 id</th><th>最近活动</th><th class="num">已观测</th><th></th></tr></thead><tbody>${keys.map(k => {
      const turns = opts.store.threadTurns('pi', k, 10);
      return `<tr><td>${esc(scopeLabel(k))}</td><td class="mono">${esc(map[k] ?? '—')}</td><td>${turns[0] ? time(turns[0].ts) : '—'}</td><td class="num">${turns.length}${turns.length === 10 ? '+' : ''}</td><td>${resetForm('/pi/reset', k, ' ' + scopeLabel(k) + ' 的会话', !!opts.resetPi)}</td></tr>`;
    }).join('')}</tbody></table></div></div>`;
    if (usageKeys.length) body += '</section>';
    for (const k of keys) body += `<section><h2>${esc(scopeLabel(k))} 最近 10 轮</h2><div class="sheet">${turnsTable(opts.store.threadTurns('pi', k, 10))}</div></section>`;
    const compaction = Array.isArray(status.compaction) ? status.compaction.map(asObj) : [];
    body += `<section><h2>上下文压缩</h2>${compaction.length ? `<div class="sheet"><table class="list"><thead><tr><th>会话 id</th><th class="num">次数</th><th>最近</th></tr></thead><tbody>${compaction.map(c => `<tr><td class="mono">${esc(c.conversation)}</td><td class="num">${esc(c.attempts)}</td><td>${typeof c.last_at === 'number' ? time(c.last_at) : '—'}</td></tr>`).join('')}</tbody></table></div>` : empty('还没有发生过压缩。')}</section>`;
    body += `<section><details><summary>用量与压缩策略（原始数据）</summary>${json({ usage: status.usage, compaction_policy: status.compaction_policy })}</details></section>`;
    return body;
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
    let prompt = '';
    try { const st = await fs.lstat(agentMd); prompt = st.isFile() && !st.isSymbolicLink() && st.size <= 256_000 ? await fs.readFile(agentMd, 'utf8') : ''; } catch { /* 不存在：pi 启动时会播种 */ }
    const promptStat = await fs.lstat(agentMd).catch(() => null);
    const mtime = promptStat?.mtime;
    // 编辑框显示原文以便保存时不破坏内容；但若其中出现已注册的秘密则只读展示脱敏版。
    const secretInside = redactText(prompt, 1_000_000) !== prompt;
    body += `<section id="prompt"><h2>pi 系统提示 agent.md <small>${mtime ? `修改于 ${esc(fmtTime(mtime.getTime()))}` : '尚未创建'}</small></h2>${secretInside
      ? `<div class="flash err">文件中包含凭据样式的内容，面板只读展示脱敏版本；请在容器内直接编辑。</div>${json(prompt)}`
      : `<form method="post" action="/settings/agent-md" class="sheet pad">${csrfField(csrf)}<input type="hidden" name="revision" value="${esc(agentMdRevision(promptStat))}"><label>每轮对话前热加载，保存后 pi 下一轮即使用新内容。<textarea name="content" rows="18" spellcheck="false" data-count="agent-md-count">${esc(prompt)}</textarea></label><div class="hint"><span id="agent-md-count"></span>，上限 ${AGENT_MD_MAX_BYTES / 1024} KB</div><p class="mt"><button>保存 agent.md</button></p></form>`}</section>`;
    body += `<section><h2>线程</h2><div class="sheet pad"><p>重置会归档当前会话并在下一条消息时新建，用于清掉跑偏的长期记忆。</p><p><a href="/codex">Codex 线程（owner / 共享）</a>　<a href="/pi">Pi 会话（按会话域）</a></p></div></section>`;
    const changes = opts.store.systemEvents(SETTINGS_TICKET, 15);
    body += `<section><h2>最近变更</h2>${changes.length ? `<div class="sheet"><div class="wrap"><table class="list"><thead><tr><th>时间</th><th>内容</th><th>来源</th></tr></thead><tbody>${changes.map(e => { const dd = asObj(JSON.parse(e.detail_json));
      const what = e.stage === 'prompt_changed' ? `agent.md ${fmtBytes(Number(dd.bytes_before))} → ${fmtBytes(Number(dd.bytes_after))}` : Object.keys(asObj(dd.after)).map(k => `${SETTING_LABELS[k] ?? k}：${showSetting(asObj(dd.before)[k])} → ${showSetting(asObj(dd.after)[k])}`).join('；');
      return `<tr><td>${time(e.ts)}</td><td>${esc(what)}</td><td>${esc(dd.source === 'dashboard' ? '面板' : dd.source ?? '')}</td></tr>`; }).join('')}</tbody></table></div></div>` : empty('还没有通过面板修改过设置。')}</section>`;
    body += `<section><details><summary>全局 AGENTS.md（受管文件，只读）</summary>${json(await readText(path.join(opts.config.codexHome,'AGENTS.md')))}</details><p class="hint">完整的生效配置见<a href="/config">配置页</a>。</p></section>`;
    return body;
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
    close: () => {for(const res of clients)res.end();clients.clear();} };
}
export type { Tone };
