/**
 * 面板的原生 JS 模块（同源 /assets/*.js，带 CSP nonce 加载）。只用 textContent / DOM API 渲染，
 * 不拼接 HTML；数据来自服务端已脱敏的 SSE。不轮询：/live 与 /logs 都是 EventSource 推送，
 * 页面上唯一的定时器只在本地刷新"已耗时"文字。
 */
import { BACKENDS, ROUTES, STAGES, TICKET_STATUS } from './html.js';

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

const live = `
const inflight=document.getElementById('inflight'), done=document.getElementById('done'), conn=document.getElementById('conn'), count=document.getElementById('live-count');
const cards=new Map(), nodes=new Map();
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
  top.append(h.stamp,h.who,h.route,h.backend,h.elapsed);
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

const forms = `
document.addEventListener('submit',e=>{const m=e.target.dataset.confirm;if(m&&!confirm(m))e.preventDefault();});
for(const t of document.querySelectorAll('textarea[data-count]')){const c=document.getElementById(t.dataset.count);const f=()=>{c.textContent=t.value.length+' 字';};t.addEventListener('input',f);f();}
`;

/** 每个模块自带共享工具函数（避免模块 import 受 CSP nonce 限制）。 */
export const ASSETS: Record<string, string> = { 'live.js': shared + live, 'logs.js': shared + logs, 'forms.js': forms };
