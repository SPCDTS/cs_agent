import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { ContextStore } from '../context/store.js';
import { callQQContextTool } from '../mcp/qq-context-server.js';
import { logBuffer, type LogLine } from '../log.js';
import { redact, redactText } from './redact.js';
import type { ObsStore } from './store.js';
import { loadImage } from '../qq/image.js';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);
const pre = (v: unknown) => `<pre>${esc(typeof v === 'string' ? v : JSON.stringify(redact(v, 20_000), null, 2))}</pre>`;
const links = [['/', '总览'], ['/tickets', '票据'], ['/logs', '日志'], ['/context', '上下文'], ['/codex', 'Codex'], ['/pi', 'Pi'], ['/config', '配置']];
function page(title: string, body: string, nonce: string, script = '') {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · cs-agent</title>
  <style nonce="${nonce}">:root{color-scheme:dark light;font-family:system-ui,sans-serif}body{max-width:1200px;margin:32px auto;padding:0 20px;background:#10171e;color:#e4ecf2}nav{display:flex;gap:20px;flex-wrap:wrap;border-bottom:1px solid #405463;padding-bottom:20px}a{color:#77d5c5}h1{font-size:28px}h2{font-size:19px;margin-top:32px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1c2934;border:1px solid #405463;padding:16px;border-radius:8px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #405463;overflow-wrap:anywhere}input,select,button{padding:8px;margin:4px;max-width:100%}img{max-width:240px;max-height:200px;margin:8px}small{color:#b3c5d1}article{border-left:3px solid #77d5c5;padding-left:18px}.cards{display:flex;gap:20px;flex-wrap:wrap}</style>
  <nav>${links.map(([url,label])=>`<a href="${url}">${label}</a>`).join('')}</nav><h1>${title}</h1>${body}
  ${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`;
}
export interface DashboardOptions {
  config: Config; store: ObsStore; context: ContextStore;
  health: () => unknown | Promise<unknown>; queue: () => unknown;
  codex: () => Promise<unknown>; pi: () => Promise<unknown>;
}
function equal(a: string, b: string): boolean { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
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
export function createDashboard(opts: DashboardOptions) {
  const clients = new Set<ServerResponse>();
  const token = opts.config.OBS_TOKEN;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { res.writeHead(400).end(); return; }
    // loopback 面板拒绝任意 Host，防止本地浏览器的 DNS rebinding 读取聊天数据。
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host ?? '')) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (token) {
      const cookie = /(?:^|;\s*)obs_token=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
      let saved = ''; try { saved = decodeURIComponent(cookie); } catch { /* 无效 cookie */ }
      const supplied = url.searchParams.get('token');
      if (!equal(supplied ?? saved, token)) { res.writeHead(401, {'Content-Type':'text/html; charset=utf-8'}).end(page('需要访问口令','<form><input name="token" type="password" aria-label="访问口令"><button>进入面板</button></form>',nonce)); return; }
      if (supplied !== null) {
        res.setHeader('Set-Cookie', 'obs_token='+encodeURIComponent(token)+'; HttpOnly; SameSite=Strict; Path=/');
        url.searchParams.delete('token');
        res.writeHead(303, { Location: url.pathname + url.search }).end(); return;
      }
    }
    const q = url.searchParams;
    if (url.pathname === '/logs/stream') {
      if (clients.size >= 20) { res.writeHead(503).end(); return; }
      res.writeHead(200, { 'Content-Type':'text/event-stream', Connection:'keep-alive' }); res.flushHeaders();
      clients.add(res);
      const ticket = q.get('ticket'), level = q.get('level');
      const emit = (line: LogLine) => {
        const id = typeof line.ticket === 'string' ? line.ticket : '';
        if (ticket && (!id || (!id.startsWith(ticket) && !ticket.startsWith(id)))) return;
        if (level && line.level !== level) return;
        if (!res.write('data: '+JSON.stringify(line)+'\n\n')) res.destroy();
      };
      const off = logBuffer.subscribe(emit);
      logBuffer.recent().forEach(emit);
      const heartbeat = setInterval(()=>{ if (!res.write(': keepalive\n\n')) res.destroy(); },15_000); heartbeat.unref();
      res.on('close',()=>{ clearInterval(heartbeat);off();clients.delete(res); }); return;
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
    let title='', body='', script='';
    if (url.pathname === '/') {
      title='运行总览';
      body='<h2>健康状态</h2>'+pre(await opts.health())+'<h2>最近吞吐与错误率</h2><div class="cards">'+[1,24].map(h=>'<section><h3>'+h+' 小时</h3>'+pre(opts.store.throughput(Date.now()-h*3600_000))+'</section>').join('')+'</div><h2>队列与在途票据</h2>'+pre(opts.queue());
      const rows=opts.store.db.prepare('SELECT * FROM metrics WHERE ts=(SELECT MAX(ts) FROM metrics) ORDER BY name LIMIT 150').all();
      body+='<h2>最近一分钟指标（p50 / p95）</h2>'+pre(rows);
    } else if (url.pathname === '/tickets') {
      title='票据列表'; const filters=Object.fromEntries(['status','scope','route','backend'].map(k=>[k,q.get(k) ?? '']));
      const n=Math.max(0,Math.min(100000,Number(q.get('page'))||0));
      body='<form>'+Object.entries(filters).map(([k,v])=>`<label>${esc(({status:'状态',scope:'会话域',route:'路由',backend:'后端'} as Record<string,string>)[k])}<input name="${k}" value="${esc(v)}"></label>`).join('')+'<button>筛选</button></form><small>状态：processing / sent / failed / fallback；路由：image / agent / image_usage</small>';
      body+='<table><tr><th>时间 / 票据</th><th>会话 / 发送者</th><th>路由 / 后端</th><th>状态 / 耗时</th></tr>'+opts.store.tickets({...filters,page:n}).map(r=>`<tr><td>${esc(new Date(r.ts).toLocaleString('zh-CN'))}<br><a href="/tickets/${encodeURIComponent(r.ticket)}">${esc(r.ticket)}</a></td><td>${esc(r.scope)}<br>${esc(r.sender)}</td><td>${esc(r.route)} / ${esc(r.backend)}</td><td>${esc(r.status)} / ${r.duration_ms} ms</td></tr>`).join('')+'</table>';
      q.set('page',String(Math.max(0,n-1))); body+=`<a href="/tickets?${esc(q)}">上一页</a> · 第 ${n+1} 页 · `;
      q.set('page',String(n+1)); body+=`<a href="/tickets?${esc(q)}">下一页</a>`;
    } else if (url.pathname.startsWith('/tickets/')) {
      const ticket=decodeURIComponent(url.pathname.slice(9)); const events=opts.store.events(ticket);
      if (!events.length) {res.writeHead(404).end('票据不存在');return;}
      title='票据全链路'; body=`<p>${esc(ticket)} · 正文、提示词和回复只保存脱敏后前 500 字。历史由工具按需获取，无自动注入近期上下文。</p>`;
      body+=events.map(e=>`<article><h2>${esc(e.stage)} · ${esc(e.status)} ${e.duration_ms===null?'':e.duration_ms+' ms'}</h2><small>${esc(new Date(e.ts).toISOString())} · ${esc(e.scope)}</small>${pre(JSON.parse(e.detail_json))}</article>`).join('');
      const root=path.join(opts.config.imagesDir,ticket);
      if (/^[A-Za-z0-9_-]{1,128}$/.test(ticket)) {
        const names=await fs.readdir(root,{recursive:true}).catch(()=>[] as string[]);
        const thumbs=[];
        for(const name of names.slice(0,200)) {try {const parts=[ticket,...name.split(path.sep)]; await imageFile(opts.config.imagesDir,parts);
          const src='/images/'+parts.map(encodeURIComponent).join('/'); thumbs.push(`<a href="${src}"><img loading="lazy" src="${src}" alt="生成图"></a>`);
        }catch{/* 只展示允许的位图 */}}
        body+='<h2>生成图片</h2>'+thumbs.join('');
      }
    } else if (url.pathname === '/logs') {
      title='实时日志'; body='<form><input name="ticket" placeholder="票据" value="'+esc(q.get('ticket'))+'"><select name="level"><option value="">全部级别</option>'+['debug','info','warn','error'].map(l=>`<option ${q.get('level')===l?'selected':''}>${l}</option>`).join('')+'</select><button>过滤</button></form><pre id="tail"></pre>';
      script=`const out=document.getElementById('tail');const rows=[];const stream=new EventSource('/logs/stream'+location.search);stream.onmessage=e=>{rows.push(e.data);if(rows.length>500)rows.shift();out.textContent=rows.join('\n');};`;
    } else if (url.pathname === '/context') {
      title='上下文检索'; const scope=q.get('scope') ?? '';
      const scopes=opts.context.scopes();
      body='<form><label>会话域<select name="scope"><option value="">全部（owner）</option>'+scopes.map(s=>`<option ${s===scope?'selected':''}>${esc(s)}</option>`).join('')+'</select></label><input name="query" placeholder="关键词；留空查看最近记录" value="'+esc(q.get('query'))+'"><button>检索</button></form>';
      const result=callQQContextTool({access:scope?{kind:'scope',scope}:{kind:'all'},openStore:()=>opts.context,maxChars:opts.config.QQ_CONTEXT_MAX_CHARS},q.get('query')?'qq_search':'qq_recent',q.get('query')?{query:q.get('query'),days:180,limit:20}:{limit:30});
      body+='<p>复用 qq_context 工具和共享格式化器，与 Codex / pi 看到的内容一致。</p>'+pre(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    } else if (url.pathname === '/codex') {
      title='Codex 线程'; body=pre(await opts.codex())+'<h2>AGENTS.md</h2>'+pre(await readText(path.join(opts.config.codexHome,'AGENTS.md')));
    } else if (url.pathname === '/pi') {
      title='Pi 会话'; body=pre(await opts.pi());
    } else if (url.pathname === '/config') {
      title='生效配置'; const file=path.join(opts.config.DATA_DIR,'prompts','agent.md');
      body=pre(opts.config)+'<h2>agent.md</h2>'+pre({mtime:(await fs.stat(file).catch(()=>null))?.mtime.toISOString() ?? '文件不存在'})+pre(await readText(file));
    } else {res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(page(title,body,nonce,script));
  }
  return { handle: (req: IncomingMessage,res: ServerResponse) => handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('观测页面暂不可用');}),
    close: () => {for(const res of clients)res.end();clients.clear();} };
}
async function readText(file: string): Promise<string> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > 256_000 || await fs.realpath(file) !== path.resolve(file)) return '文件不可读取';
    return redactText(await fs.readFile(file,'utf8'),100_000);
  } catch { return '文件不存在'; }
}
