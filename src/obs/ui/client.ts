/**
 * 面板的原生 JS 模块（同源 /assets/*.js，带 CSP nonce 加载）。只用 textContent / DOM API 渲染，
 * 不拼接 HTML；数据来自服务端已脱敏的 SSE。不轮询：/live 与 /logs 都是 EventSource 推送，
 * 页面上唯一的定时器只在本地刷新"已耗时"文字。
 */
import { BACKENDS, ROUTES, STAGES, TICKET_STATUS } from './html.js';
import { STALE_MS } from './context-bar.js';

const shared = `
const STAGES=${JSON.stringify(STAGES)};
const ROUTES=${JSON.stringify(ROUTES)};
const BACKENDS=${JSON.stringify(BACKENDS)};
const STATUS=${JSON.stringify(TICKET_STATUS)};
function stageLabel(s){if(STAGES[s])return STAGES[s];if(s.startsWith('backend:')){const b=s.slice(8);return b==='codex'?'Codex 回合':b==='pi'?'Pi 回合':'后端 '+b;}if(s.startsWith('tool:'))return '工具 '+s.slice(5);return s;}
function scopeLabel(s){const m=/^(group|private):(\\d+)$/.exec(s||'');return m?(m[1]==='group'?'群 ':'私聊 ')+m[2]:(s||'未知会话');}
function fmtMs(ms){if(ms==null||!isFinite(ms))return '';if(ms<1000)return Math.round(ms)+' 毫秒';if(ms<60000)return (ms/1000).toFixed(ms<10000?1:0)+' 秒';const m=Math.floor(ms/60000),s=Math.round(ms%60000/1000);return m<60?m+' 分 '+s+' 秒':Math.floor(m/60)+' 时 '+(m%60)+' 分';}
function fmtOffset(ms){return ms<60000?'+'+(ms/1000).toFixed(ms<10000?1:0)+'秒':'+'+Math.floor(ms/60000)+'分'+String(Math.round(ms%60000/1000)).padStart(2,'0')+'秒';}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function stamp(status){const [label,tone]=STATUS[status]||[status||'未知','idle'];return el('span','stamp s-'+tone,label);}
`;


/** 上下文占用条（与 context-bar.ts 的服务端结构一致）：只改 textContent / dataset / className。 */
const ctxShared = `
const STALE_MS=${STALE_MS};
function fmtInt(n){return String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');}
function fmtShort(n){const t=s=>s.replace(/\\.0+$|(\\.\\d*[1-9])0+$/,'$1');if(n<1000)return String(Math.round(n));if(n<1e6)return t((n/1000).toFixed(n<10000?1:0))+'k';return t((n/1e6).toFixed(2))+'M';}
function ratio(u,w){return w>0?u/w*100:0;}
function clampPct(p){return Math.max(0,Math.min(100,Math.round(p)));}
function fmtPct(p){return (p>0&&p<1?'<1':String(Math.round(p)))+'%';}
function tier(p){return p>85?'hot':p>=60?'warn':'ok';}
function ctxLabel(b,k){const n=BACKENDS[b]||b;if(b==='codex')return n+' · '+(k==='owner'?'owner 线程':k==='shared'?'共享线程':k);return n+' · '+(k==='owner'?'owner 私聊':scopeLabel(k));}
function tickTitle(kind,at,w){return (kind==='bg'?'后台压缩阈值':'阻塞压缩阈值')+'：'+fmtInt(at)+' tokens（'+fmtPct(ratio(at,w))+'）。'+(kind==='bg'?'越过后在回合结束时于后台压缩上下文，不阻塞回复。':'越过后下一回合开始前必须先压缩，回复会等待压缩完成。');}
function hhmmss(ts){const d=new Date(ts);return [d.getHours(),d.getMinutes(),d.getSeconds()].map(x=>String(x).padStart(2,'0')).join(':');}
// 骨架：mini=单行（实时卡片头部），否则为完整条（标签、数字、轨道、说明）。
function ctxNode(backend,key,mini){
  const n=el('div','ctx ctx-none'+(mini?' ctx-mini':''));n.dataset.ctx=backend+'|'+key;
  const track=el(mini?'span':'div','ctx-track');track.setAttribute('role','progressbar');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');
  track.setAttribute('aria-label',ctxLabel(backend,key)+' 上下文占用');
  const fill=el('i','ctx-fill');fill.dataset.w='0';track.append(fill);
  const pct=el('span','ctx-pct','—'), short=el('span','ctx-short',mini?'暂无占用数据':'');
  let used=null,win=null,meta=null;
  if(mini)n.append(track,pct,short);
  else{const head=el('div','ctx-head'), num=el('span','ctx-num');used=el('b','ctx-used');win=el('span','ctx-win');
    num.append(used,document.createTextNode(' / '),win,document.createTextNode(' tokens'));meta=el('div','ctx-meta','暂无占用数据，下一回合结束后出现。');
    head.append(el('span','ctx-label',ctxLabel(backend,key)),num,short,pct);n.append(head,track,meta);}
  n._ctx={track,fill,pct,short,used,win,meta,ticks:{}};
  return n;
}
// 服务端渲染的节点没有 _ctx 缓存：按类名取一次。
function ctxParts(n){if(n._ctx)return n._ctx;const q=s=>n.querySelector(s);
  n._ctx={track:q('.ctx-track'),fill:q('.ctx-fill'),pct:q('.ctx-pct'),short:q('.ctx-short'),used:q('.ctx-used'),win:q('.ctx-win'),meta:q('.ctx-meta'),ticks:{bg:q('.ctx-bg'),rs:q('.ctx-rs')}};return n._ctx;}
// 返回更新后的节点（服务端"暂无数据"占位的完整条会换成新骨架）。
function ctxApply(n,u,nowTs){
  const mini=n.classList.contains('ctx-mini');
  if(!mini&&!n.querySelector('.ctx-used')){const [b,...k]=(n.dataset.ctx||'').split('|');const m=ctxNode(b,k.join('|'),false);if(n.parentNode)n.parentNode.replaceChild(m,n);n=m;}
  const p=ratio(u.usedTokens,u.windowTokens), w=clampPct(p), x=ctxParts(n), stale=nowTs-u.updatedAt>STALE_MS;
  n.className='ctx ctx-t-'+tier(p)+(u.source==='estimate'?' ctx-est':'')+(stale?' ctx-stale':'')+(mini?' ctx-mini':'');
  x.fill.dataset.w=String(w);x.pct.textContent=fmtPct(p);x.short.textContent=fmtShort(u.usedTokens)+' / '+fmtShort(u.windowTokens);
  x.track.setAttribute('aria-valuenow',String(w));x.track.setAttribute('aria-valuetext',fmtInt(u.usedTokens)+' / '+fmtInt(u.windowTokens)+' tokens，'+fmtPct(p));
  for(const k of ['bg','rs']){
    const at=u.compaction&&u.windowTokens>0?(k==='bg'?u.compaction.background:u.compaction.reserve):null;
    let t=x.ticks[k];
    if(at==null){if(t)t.remove();x.ticks[k]=null;continue;}
    if(!t){t=el('i','ctx-tick ctx-'+k);x.track.append(t);x.ticks[k]=t;}
    t.dataset.at=String(clampPct(ratio(at,u.windowTokens)));t.setAttribute('title',tickTitle(k,at,u.windowTokens));
  }
  const parts=(n.dataset.ctx||'').split('|'), label=ctxLabel(parts[0],parts.slice(1).join('|'));
  if(mini){n.setAttribute('title',label+'：'+fmtInt(u.usedTokens)+' / '+fmtInt(u.windowTokens)+' tokens');return n;}
  x.used.textContent=fmtInt(u.usedTokens);x.win.textContent=fmtInt(u.windowTokens);
  const meta=['第 '+fmtInt(u.turns||0)+' 回合'];
  if(u.cachedTokens)meta.push('缓存命中 '+fmtInt(u.cachedTokens));
  if(u.compaction)meta.push('压缩阈值 '+fmtPct(ratio(u.compaction.background,u.windowTokens))+' / '+fmtPct(ratio(u.compaction.reserve,u.windowTokens)));
  if(u.source==='estimate')meta.push('估算值（尚无真实回合用量）');
  meta.push(stale?'上次更新 '+Math.max(0,Math.floor((nowTs-u.updatedAt)/3600000))+' 小时前':'更新于 '+hhmmss(u.updatedAt));
  x.meta.textContent=meta.join('，');
  return n;
}
`;

const live = `
const inflight=document.getElementById('inflight'), done=document.getElementById('done'), conn=document.getElementById('conn'), count=document.getElementById('live-count');
const cards=new Map(), nodes=new Map(), ctx=new Map();
const MAX_ITEMS=80;
let skew=0;
const now=()=>Date.now()+skew;
function group(scope){
  let g=inflight.querySelector('[data-scope="'+CSS.escape(scope)+'"]');
  if(!g){g=el('div','scope-group');g.dataset.scope=scope;const h=el('h3');h.append(el('span',null,scopeLabel(scope)),el('span','pill','0'));g.append(h,el('div','slips'));inflight.append(g);}
  return g;
}
function feedItem(it,t0){
  const li=el('li',it.status==='failed'?'failed':it.status==='started'?'started':'');
  li.append(el('span','faint',fmtOffset(Math.max(0,it.ts-t0))));
  const body=el('span','sum');body.append(el('b',null,stageLabel(it.stage)+(it.status==='started'?' 开始':it.status==='failed'?' 失败':'')));
  const extra=[it.duration_ms!=null?fmtMs(it.duration_ms):'',it.summary].filter(Boolean).join('  ');
  if(extra)body.append(document.createTextNode('  '+extra));
  li.append(body);return li;
}
// 单据骨架只建一次；页头（状态、发送者、路由、后端）与原文在每次更新时刷新。
function slip(card){
  const n=el('article','slip');n.dataset.ticket=card.ticket;
  const b=el('div','slip-body'), top=el('div','slip-top');
  const h={top,stamp:stamp(card.state),who:el('span','who'),route:el('span','pill'),backend:el('span','pill'),elapsed:el('span','elapsed'),text:el('p','text')};
  h.elapsed.dataset.prefix='已耗时 ';
  top.append(h.stamp,h.who,h.route,h.backend,h.elapsed);h.ctx=null;
  const phase=el('div','phase');
  const feed=el('ol','feed');feed.setAttribute('aria-live','polite');
  const link=el('a',null,'查看时间线');link.href='/tickets/'+encodeURIComponent(card.ticket);
  const foot=el('div','hint');foot.append(link);
  b.append(top,h.text,phase,feed,foot);n.append(b);
  n._h=h;n._feed=feed;n._phase=phase;n._seq=0;
  return n;
}
function fill(n,card){
  const h=n._h, st=stamp(card.state);h.top.replaceChild(st,h.stamp);h.stamp=st;
  h.who.textContent=card.sender||'—';
  h.route.textContent=card.route?(ROUTES[card.route]||card.route):'';h.route.hidden=!card.route;
  h.backend.textContent=card.backend?(BACKENDS[card.backend]||card.backend):'';h.backend.hidden=!card.backend;
  h.elapsed.dataset.since=card.started;
  // 头部的单行占用条：后端与线程键都已知时才出现；数据来自 context 帧（首帧快照 + 增量）。
  const ck=card.backend&&card.thread?card.backend+'|'+card.thread:'';
  if(h.ctx&&h.ctx.dataset.ctx!==ck){h.ctx.remove();h.ctx=null;}
  if(ck&&!h.ctx){h.ctx=ctxNode(card.backend,card.thread,true);h.top.append(h.ctx);const u=ctx.get(ck);if(u)ctxApply(h.ctx,u,now());}
  h.text.textContent=card.text||'（无原文）';
  n.classList.toggle('queued',card.state==='queued');
  n._phase.replaceChildren();
  if(card.phase){const p=el('span','pulse');p.setAttribute('aria-hidden','true');const since=el('span','faint');since.dataset.since=card.phase_since;
    n._phase.append(p,el('span',null,'当前：'+stageLabel(card.phase)),since);}
  else n._phase.append(el('span','faint',card.state==='queued'?'排队等待同一会话的前一条消息':'阶段之间'));
  // 按事件序号增量追加：服务端事件环形截断后条数不变，但 seq 单调递增。
  const feed=n._feed, stick=feed.scrollTop+feed.clientHeight>=feed.scrollHeight-8;
  for(const it of card.items)if(it.seq>n._seq){feed.append(feedItem(it,card.started));n._seq=it.seq;}
  while(feed.children.length>MAX_ITEMS)feed.firstChild.remove();
  if(stick)feed.scrollTop=feed.scrollHeight;
}
function finished(card){
  const d=el('details');d.dataset.ticket=card.ticket;const s=el('summary');
  s.append(stamp(card.outcome==='reply_sent'?'sent':card.outcome==='fallback'?'fallback':'failed'),el('span','excerpt',card.text||'（无原文）'),el('span','faint',scopeLabel(card.scope)+'  '+fmtMs((card.finished||card.updated)-card.started)));
  const a=el('a',null,'时间线');a.href='/tickets/'+encodeURIComponent(card.ticket);s.append(a);
  const feed=el('ol','feed');for(const it of card.items.slice(-12))feed.append(feedItem(it,card.started));
  d.append(s,feed);return d;
}
// snapshot=true：快照按服务端顺序逐张到达（完成卡片新的在前），追加到末尾且不高亮。
function place(card,fresh,snapshot){
  const old=nodes.get(card.ticket);
  if(card.finished!=null){
    if(old&&old.tagName==='DETAILS')return;
    if(old)old.remove();
    const d=finished(card);
    if(snapshot)done.append(d);else{d.classList.add('flashin');done.prepend(d);}
    nodes.set(card.ticket,d);
    while(done.children.length>30){const last=done.lastElementChild;nodes.delete(last.dataset.ticket);last.remove();}
  }else{
    let n=old;if(!n||n.tagName==='DETAILS'){if(n)n.remove();n=slip(card);if(fresh)n.classList.add('flashin');}
    const slips=group(card.scope||'').querySelector('.slips');if(n.parentNode!==slips)slips.append(n);
    nodes.set(card.ticket,n);fill(n,card);
  }
  tidy();
}
function tidy(){
  for(const g of [...inflight.querySelectorAll('.scope-group')]){const k=g.querySelector('.slips').children.length;if(!k)g.remove();else g.querySelector('.pill').textContent=k+' 条';}
  const k=[...cards.values()].filter(c=>c.finished==null).length;
  count.textContent=k?k+' 条进行中':'没有进行中的消息';
  document.getElementById('inflight-empty').hidden=k>0;
  document.getElementById('done-empty').hidden=done.children.length>0;
}
function tick(){for(const e of document.querySelectorAll('[data-since]'))e.textContent=(e.dataset.prefix||'')+fmtMs(now()-Number(e.dataset.since));}
setInterval(tick,1000);
function connect(){
  const es=new EventSource('/live/stream');
  // 快照分帧：snapshot（清空）→ 每张卡片一帧 snapcard → snapshot_end；随后是 card / remove 增量。
  es.addEventListener('snapshot',e=>{const m=JSON.parse(e.data);skew=m.now-Date.now();cards.clear();for(const n of nodes.values())n.remove();nodes.clear();
    inflight.querySelectorAll('.scope-group').forEach(g=>g.remove());done.replaceChildren();tidy();});
  es.addEventListener('snapcard',e=>{const c=JSON.parse(e.data).card;cards.set(c.ticket,c);place(c,false,true);});
  es.addEventListener('snapshot_end',()=>{conn.className='conn on';conn.textContent='实时连接中';tidy();tick();});
  es.addEventListener('card',e=>{const m=JSON.parse(e.data);const prev=cards.get(m.card.ticket);
    if(prev&&m.item.seq<=prev.seq)return; // 已包含在快照里
    const card={...m.card,items:[...(prev?prev.items:[]),m.item].slice(-MAX_ITEMS)};cards.set(card.ticket,card);place(card,!prev,false);tick();});
  es.addEventListener('context',e=>{const u=JSON.parse(e.data).usage;if(!u||!u.backend||!u.key)return;const k=u.backend+'|'+u.key;ctx.set(k,u);
    for(const n of inflight.querySelectorAll('[data-ctx="'+CSS.escape(k)+'"]'))ctxApply(n,u,now());});
  es.addEventListener('remove',e=>{const m=JSON.parse(e.data);cards.delete(m.ticket);const n=nodes.get(m.ticket);if(n)n.remove();nodes.delete(m.ticket);tidy();});
  es.onerror=()=>{conn.className='conn off';conn.textContent='连接中断，浏览器会自动重连';};
}
connect();
`;

const logs = `
const out=document.getElementById('tail'), conn=document.getElementById('conn');
const es=new EventSource('/logs/stream'+location.search);
es.onopen=()=>{conn.className='conn on';conn.textContent='实时连接中';};
es.onerror=()=>{conn.className='conn off';conn.textContent='连接中断，浏览器会自动重连';};
es.onmessage=e=>{
  let line;try{line=JSON.parse(e.data);}catch{return;}
  const {t,level,msg,...rest}=line;const stick=out.scrollTop+out.clientHeight>=out.scrollHeight-8;
  const row=el('div',level);const time=(t||'').slice(11,19);
  row.textContent=time+'  '+(level||'').padEnd(5)+'  '+msg+(Object.keys(rest).length?'  '+JSON.stringify(rest):'');
  out.append(row);while(out.children.length>500)out.firstChild.remove();if(stick)out.scrollTop=out.scrollHeight;
};
`;

const usage = `
// /、/codex、/pi：只订阅 context 帧，原地更新页面上已渲染的占用条；不轮询。
const es=new EventSource('/usage/stream');
es.addEventListener('context',e=>{const u=JSON.parse(e.data).usage;if(!u||!u.backend||!u.key)return;
  for(const n of document.querySelectorAll('[data-ctx="'+CSS.escape(u.backend+'|'+u.key)+'"]'))ctxApply(n,u,Date.now());});
`;

const forms = `
document.addEventListener('submit',e=>{const m=e.target.dataset.confirm;if(m&&!confirm(m))e.preventDefault();});
for(const t of document.querySelectorAll('textarea[data-count]')){const c=document.getElementById(t.dataset.count);const f=()=>{c.textContent=t.value.length+' 字';};t.addEventListener('input',f);f();}
`;

/** 每个模块自带共享工具函数（避免模块 import 受 CSP nonce 限制）。 */
export const ASSETS: Record<string, string> = { 'live.js': shared + ctxShared + live, 'usage.js': shared + ctxShared + usage, 'logs.js': shared + logs, 'forms.js': forms };
