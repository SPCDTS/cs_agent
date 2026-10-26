/**
 * 面板的原生 JS 模块（同源 /assets/*.js，带 CSP nonce 加载）。只用 textContent / DOM API 渲染，
 * 不拼接 HTML；数据来自服务端已脱敏的 SSE。不轮询：/live 与 /logs 都是 EventSource 推送，
 * 页面上唯一的定时器只在本地刷新"已耗时"文字。
 */
import { BACKENDS, STAGES, STATUS, TURN_KINDS } from './html.js';
import { STALE_MS } from '../../shared/format.js';
import { AGENTS_JS } from './agents-client.js';
import { MEMORY_JS } from './memory-client.js';
import { CONTEXT_USAGE_JS } from './context-usage-client.js';

const shared = `
const STAGES=${JSON.stringify(STAGES)};
const KINDS=${JSON.stringify(TURN_KINDS)};
const BACKENDS=${JSON.stringify(BACKENDS)};
const STATUS=${JSON.stringify(STATUS)};
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
function usageWindow(u){return u.backend==='codex'&&Number.isFinite(u.effectiveWindowTokens)&&u.effectiveWindowTokens>0?u.effectiveWindowTokens:u.windowTokens;}
function clampPct(p){return Math.max(0,Math.min(100,Math.round(p)));}
function fmtPct(p){return (p>0&&p<1?'<1':String(Math.round(p)))+'%';}
function tier(p){return p>85?'hot':p>=60?'warn':'ok';}
function ctxLabel(b,k){const n=BACKENDS[b]||b;if(b==='codex')return n+' · '+(k==='owner'?'owner 线程':scopeLabel(k));return n+' · '+(k==='owner'?'owner 私聊':scopeLabel(k));}
function tickTitle(kind,at,w){return (kind==='bg'?'后台压缩阈值':'阻塞压缩阈值')+'：'+fmtInt(at)+' tokens（'+fmtPct(ratio(at,w))+'）。'+(kind==='bg'?'越过后在回合结束时于后台压缩上下文，不阻塞回复。':'越过后下一回合开始前必须先压缩，回复会等待压缩完成。');}
function hhmmss(ts){const d=new Date(ts);return [d.getHours(),d.getMinutes(),d.getSeconds()].map(x=>String(x).padStart(2,'0')).join(':');}
// 骨架：mini=单行（实时会话行头部），否则为完整条（标签、数字、轨道、说明）。
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
  const window=usageWindow(u), p=ratio(u.usedTokens,window), w=clampPct(p), x=ctxParts(n), stale=nowTs-u.updatedAt>STALE_MS;
  const capacityTitle=u.backend==='codex'&&Number.isFinite(u.effectiveWindowTokens)&&u.effectiveWindowTokens>0?'名义 '+fmtInt(u.windowTokens)+' / 有效 '+fmtInt(window):'';
  n.className='ctx ctx-t-'+tier(p)+(u.source!=='turn'?' ctx-est':'')+(stale?' ctx-stale':'')+(mini?' ctx-mini':'');
  x.fill.dataset.w=String(w);x.pct.textContent=fmtPct(p);x.short.textContent=fmtShort(u.usedTokens)+' / '+fmtShort(window);
  x.track.setAttribute('aria-valuenow',String(w));x.track.setAttribute('aria-valuetext',fmtInt(u.usedTokens)+' / '+fmtInt(window)+' tokens，'+fmtPct(p));
  for(const k of ['bg','rs']){
    const at=u.compaction&&window>0?(k==='bg'?u.compaction.background:u.compaction.reserve):null;
    let t=x.ticks[k];
    if(at==null){if(t)t.remove();x.ticks[k]=null;continue;}
    if(!t){t=el('i','ctx-tick ctx-'+k);x.track.append(t);x.ticks[k]=t;}
    t.dataset.at=String(clampPct(ratio(at,window)));t.setAttribute('title',tickTitle(k,at,window));
  }
  const parts=(n.dataset.ctx||'').split('|'), label=ctxLabel(parts[0],parts.slice(1).join('|'));
  if(mini){n.setAttribute('title',label+'：'+fmtInt(u.usedTokens)+' / '+fmtInt(window)+' tokens'+(capacityTitle?'；'+capacityTitle:''));return n;}
  n.setAttribute('title',capacityTitle);
  x.used.textContent=fmtInt(u.usedTokens);x.win.textContent=fmtInt(window);
  const meta=['第 '+fmtInt(u.turns||0)+' 回合'];
  if(u.cachedTokens)meta.push('缓存命中 '+fmtInt(u.cachedTokens));
  if(u.compaction)meta.push('压缩阈值 '+fmtPct(ratio(u.compaction.background,window))+' / '+fmtPct(ratio(u.compaction.reserve,window)));
  if(u.source==='estimate')meta.push('估算值（尚无真实回合用量）');
  if(u.source==='compact')meta.push('压缩后估算');
  meta.push(stale?'上次更新 '+Math.max(0,Math.floor((nowTs-u.updatedAt)/3600000))+' 小时前':'更新于 '+hhmmss(u.updatedAt));
  x.meta.textContent=meta.join('，');
  return n;
}
`;

const live = `
const list=document.getElementById('convs'), conn=document.getElementById('conn'), count=document.getElementById('live-count');
const CSRF=list.dataset.csrf||'', STOP=list.dataset.stop==='1';
const convs=new Map(), nodes=new Map(), ctx=new Map();
const MAX_ITEMS=80;
let skew=0;
const now=()=>Date.now()+skew;
function threadLabel(t,name){if(t==='owner')return 'owner 私聊';const m=/^(group|private):(\\d+)$/.exec(t||'');if(!m)return t||'未知会话';return m[1]==='group'?(name?'群 '+name+'('+m[2]+')':'群 '+m[2]):'私聊 '+m[2];}
function turnHref(id){return '/turns/'+encodeURIComponent(id);}
function kindText(t){return t?(KINDS[t.kind]||'回合')+(t.sender?' · '+t.sender:''):'';}
function feedItem(it,t0){
  const li=el('li',it.status==='failed'?'failed':it.status==='started'?'started':'');
  li.append(el('span','faint',fmtOffset(Math.max(0,it.ts-t0))));
  const body=el('span','sum');body.append(el('b',null,stageLabel(it.stage)+(it.status==='started'?' 开始':it.status==='failed'?' 失败':'')));
  const extra=[it.duration_ms!=null?fmtMs(it.duration_ms):'',it.summary].filter(Boolean).join('  ');
  if(extra)body.append(document.createTextNode('  '+extra));
  li.append(body);return li;
}
// 会话行骨架只建一次；页头、本轮输入、已发消息、事件流与最近回合在每次更新时刷新。
function row(c){
  const n=el('article','slip conv');n.dataset.thread=c.thread;
  const b=el('div','slip-body'), top=el('div','slip-top');
  const h={top,stamp:stamp(c.state),who:el('a','who'),backend:el('span','pill'),kind:el('span','pill'),elapsed:el('span','elapsed'),ctx:null};
  h.who.href='/conversations/'+encodeURIComponent(c.thread);
  top.append(h.stamp,h.who,h.backend,h.kind,h.elapsed);
  const facts=el('div','conv-facts'), inputs=el('ol','conv-inputs'), phase=el('div','phase');
  const feed=el('ol','feed');feed.setAttribute('aria-live','polite');
  const sends=el('ol','conv-sends');
  const foot=el('div','hint conv-foot'), link=el('a',null,'回合详情');foot.append(link);
  if(STOP){const f=el('form');f.setAttribute('method','post');f.setAttribute('action','/thread/stop');f.dataset.confirm='停止'+threadLabel(c.thread)+'当前的回合？子 agent 会一起停止，排队的消息随后照常处理。';
    for(const [k,v] of [['_csrf',CSRF],['key',c.thread],['return','/live']]){const i=el('input');i.setAttribute('type','hidden');i.setAttribute('name',k);i.setAttribute('value',v);f.append(i);}
    const btn=el('button','quiet','停止');btn.setAttribute('title','中止当前回合与子 agent');f.append(btn);foot.append(f);h.stop=f;}
  const recent=el('details','conv-recent'), rs=el('summary'), rl=el('ul');recent.append(rs,rl);
  b.append(top,facts,inputs,phase,feed,sends,foot,recent);n.append(b);
  n._h=h;n._facts=facts;n._inputs=inputs;n._phase=phase;n._feed=feed;n._sends=sends;n._link=link;n._foot=foot;n._recent=recent;n._rs=rs;n._rl=rl;n._seq=0;n._turn=null;
  return n;
}
function fill(n,c){
  const h=n._h, t=c.turn, st=stamp(c.state);h.top.replaceChild(st,h.stamp);h.stamp=st;
  h.who.textContent=c.label?threadLabel(c.thread,c.label):threadLabel(c.thread);
  h.backend.textContent=c.backend?(BACKENDS[c.backend]||c.backend):'';h.backend.hidden=!c.backend;
  h.kind.textContent=kindText(t);h.kind.hidden=!t;
  if(t){h.elapsed.dataset.prefix='已耗时 ';h.elapsed.dataset.since=t.started;}else{h.elapsed.dataset.prefix='空闲 ';h.elapsed.dataset.since=c.updated;}
  // 头部的单行占用条：后端已知时出现；数据来自 context 帧（首帧快照 + 增量）。
  const ck=c.backend?c.backend+'|'+c.thread:'';
  if(h.ctx&&h.ctx.dataset.ctx!==ck){h.ctx.remove();h.ctx=null;}
  if(ck&&!h.ctx){h.ctx=ctxNode(c.backend,c.thread,true);h.top.append(h.ctx);const u=ctx.get(ck);if(u)ctxApply(h.ctx,u,now());}
  n.classList.toggle('idle',!t);
  const facts=[];
  if(t)facts.push(['本轮输入',t.inputs.length],['已发消息',t.sends.length],['工具调用',t.tools]);
  if(c.subagents!=null)facts.push(['子 agent',c.subagents]);
  facts.push(['排队',c.queued.length]);
  n._facts.replaceChildren(...facts.map(([k,v])=>el('span','pill'+(k==='排队'&&v?' queued':''),k+' '+v)));
  n._inputs.replaceChildren(...(t?t.inputs:[]).map(i=>{const li=el('li');if(i.sender)li.append(el('b',null,i.sender+'：'));li.append(document.createTextNode(i.text||'（无正文）'));return li;}));
  n._inputs.hidden=!t||!t.inputs.length;
  n._phase.replaceChildren();n._phase.hidden=!t;
  if(t&&t.phase){const p=el('span','pulse');p.setAttribute('aria-hidden','true');const since=el('span','faint');since.dataset.since=t.phase_since;
    n._phase.append(p,el('span',null,'当前：'+stageLabel(t.phase)),since);}
  else if(t)n._phase.append(el('span','faint','阶段之间'));
  // 换了回合就清空事件流；同一回合按事件序号增量追加（服务端事件环形截断后 seq 仍单调递增）。
  const feed=n._feed;
  if(n._turn!==(t?t.id:null)){feed.replaceChildren();n._seq=0;n._turn=t?t.id:null;}
  feed.hidden=!t;
  if(t){const stick=feed.scrollTop+feed.clientHeight>=feed.scrollHeight-8;
    for(const it of t.items||[])if(it.seq>n._seq){feed.append(feedItem(it,t.started));n._seq=it.seq;}
    while(feed.children.length>MAX_ITEMS)feed.firstChild.remove();
    if(stick)feed.scrollTop=feed.scrollHeight;}
  n._sends.replaceChildren(...(t?t.sends:[]).map(s=>{const li=el('li',s.status==='sent'?'':'failed');li.append(el('span','faint',(s.system?'系统 ':'')+(s.target||'')),document.createTextNode(' '+(s.text||'（无正文）')));return li;}));
  n._sends.hidden=!t||!t.sends.length;
  n._link.hidden=!t;if(t)n._link.href=turnHref(t.id);
  if(n._h.stop)n._h.stop.hidden=!t;
  n._foot.hidden=!t;
  n._rs.textContent='最近完成 '+c.recent.length+' 个回合';n._recent.hidden=!c.recent.length;
  n._rl.replaceChildren(...c.recent.map(r=>{const li=el('li');const a=el('a',null,kindText(r)||'回合');a.href=turnHref(r.id);
    li.append(stamp(r.outcome||'processing'),a,el('span','excerpt',(r.inputs[0]&&r.inputs[0].text)||(r.sends[0]&&r.sends[0].text)||''),el('span','faint',fmtMs((r.finished||r.updated)-r.started)));return li;}));
}
// 工作中的会话在前（按回合开始时间），空闲的按最近活动倒序。
function order(){
  const all=[...convs.values()].sort((a,b)=>(b.turn?1:0)-(a.turn?1:0)||(a.turn?a.turn.started-b.turn.started:b.updated-a.updated));
  for(const c of all){const n=nodes.get(c.thread);if(n)list.append(n);}
}
function place(c,fresh){
  let n=nodes.get(c.thread);
  if(!n){n=row(c);nodes.set(c.thread,n);if(fresh)n.classList.add('flashin');}
  fill(n,c);order();tidy();
}
function tidy(){
  const k=[...convs.values()].filter(c=>c.turn).length;
  count.textContent=k?k+' 个会话工作中':convs.size?'所有会话空闲':'没有活动的会话';
  document.getElementById('convs-empty').hidden=convs.size>0;
}
function tick(){for(const e of document.querySelectorAll('[data-since]'))e.textContent=(e.dataset.prefix||'')+fmtMs(now()-Number(e.dataset.since));}
setInterval(tick,1000);
function connect(){
  const es=new EventSource('/live/stream');
  // 快照分帧：snapshot（清空）→ 每个会话一帧 snapconversation（带当前回合事件流）→ snapshot_end；随后是 conversation / remove 增量。
  es.addEventListener('snapshot',e=>{const m=JSON.parse(e.data);skew=m.now-Date.now();convs.clear();for(const n of nodes.values())n.remove();nodes.clear();tidy();});
  es.addEventListener('snapconversation',e=>{const c=JSON.parse(e.data).conversation;convs.set(c.thread,c);place(c,false);});
  es.addEventListener('snapshot_end',()=>{conn.className='conn on';conn.textContent='实时连接中';tidy();tick();});
  es.addEventListener('conversation',e=>{const m=JSON.parse(e.data), c=m.conversation, prev=convs.get(c.thread);
    // 事件流只在增量里带新的一条：同一回合沿用已有事件，换了回合从空开始；已包含在快照里的事件跳过
    let items=prev&&prev.turn&&c.turn&&prev.turn.id===c.turn.id?prev.turn.items||[]:[];
    if(m.item&&c.turn&&!(items.length&&m.item.seq<=items[items.length-1].seq))items=[...items,m.item].slice(-MAX_ITEMS);
    const next={...c,turn:c.turn?{...c.turn,items}:null};convs.set(c.thread,next);place(next,!prev);tick();});
  es.addEventListener('context',e=>{const u=JSON.parse(e.data).usage;if(!u||!u.backend||!u.key)return;const k=u.backend+'|'+u.key;ctx.set(k,u);
    for(const n of list.querySelectorAll('[data-ctx="'+CSS.escape(k)+'"]'))ctxApply(n,u,now());});
  es.addEventListener('remove',e=>{const m=JSON.parse(e.data);convs.delete(m.thread);const n=nodes.get(m.thread);if(n)n.remove();nodes.delete(m.thread);tidy();});
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

// /agents 拓扑区：页面可见时每 3 秒取服务端渲染的概览片段整块替换（片段已转义）；失败保留上次内容。
// 详情在展开时读 /agents/topology/:thread；已展开的会话在替换后保持展开，签名（data-sig）未变时直接用缓存。
const topology = `
const box=document.getElementById('topology');
if(box){
  const opened=new Set(),cache=new Map();
  const more=t=>box.querySelector('details.topo-more[data-thread="'+CSS.escape(t)+'"]');
  const fill=(d,html,sig)=>{const b=d.querySelector('.topo-detail');if(b&&b.dataset.sig!==sig){b.innerHTML=html;b.dataset.sig=sig;}};
  async function load(d){
    const t=d.dataset.thread,sig=d.dataset.sig,c=cache.get(t);
    if(c){fill(d,c.html,c.sig);if(c.sig===sig)return;}
    try{const r=await fetch('/agents/topology/'+encodeURIComponent(t),{credentials:'same-origin',cache:'no-store'});
      const cur=more(t);if(!cur)return;
      if(!r.ok){if(!c)cur.querySelector('.topo-detail').textContent='读取失败（HTTP '+r.status+'），收起后再展开可重试';return;}
      const html=await r.text();cache.set(t,{html,sig});if(cur.open)fill(cur,html,sig);
    }catch(e){if(!c){const cur=more(t);if(cur)cur.querySelector('.topo-detail').textContent='读取失败，收起后再展开可重试';}}
  }
  box.addEventListener('toggle',e=>{const d=e.target;if(!d.matches||!d.matches('details.topo-more'))return;
    if(d.open){opened.add(d.dataset.thread);load(d);}else opened.delete(d.dataset.thread);},true);
  box.addEventListener('click',e=>{const k=e.target.closest&&e.target.closest('[data-open-thread]');if(!k)return;
    const d=more(k.dataset.openThread);if(d){d.open=true;d.scrollIntoView({block:'nearest'});}});
  let busy=false;setInterval(async()=>{if(document.hidden||busy)return;busy=true;
    try{const r=await fetch('/agents/topology',{credentials:'same-origin',cache:'no-store'});
      if(r.ok){box.innerHTML=await r.text();for(const t of opened){const d=more(t);if(!d)continue;const c=cache.get(t);if(c)fill(d,c.html,c.sig);d.open=true;}}
    }catch(e){}finally{busy=false;}},3000);
}
`;

// /turns 聊天视图：首屏滚到最新（或 #turn-<id> 指定的回合）；"加载更早"取 part=1 片段插到顶部并保持视口位置；
// 回合折叠块展开时读 /turns/:id?part=1（服务端渲染并转义的回合详情）。
const chat = `
const log=document.getElementById('chat-log');
if(log){
  let target=null;try{target=location.hash?document.getElementById(decodeURIComponent(location.hash.slice(1))):null;}catch(e){}
  if(target&&log.contains(target)){log.scrollTop+=target.getBoundingClientRect().top-log.getBoundingClientRect().top-40;const m=target.querySelector('details.chat-meta');if(m)m.open=true;}else log.scrollTop=log.scrollHeight;
  const dedupeDays=()=>{let prev='';for(const d of log.querySelectorAll('.chat-day')){if(d.textContent===prev)d.remove();else prev=d.textContent;}};
  log.addEventListener('click',async e=>{const a=e.target.closest&&e.target.closest('a.chat-more');if(!a||a.dataset.busy)return;e.preventDefault();a.dataset.busy='1';const label=a.textContent;a.textContent='读取中…';
    try{const r=await fetch(a.getAttribute('href')+'&part=1',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error(String(r.status));
      const html=await r.text(),h=log.scrollHeight,top=log.scrollTop;a.remove();
      log.insertAdjacentHTML('afterbegin',html||'<p class="chat-start faint">已到最早的回合</p>');dedupeDays();log.scrollTop=top+log.scrollHeight-h;
    }catch(x){a.textContent=label+'（读取失败，点击重试）';delete a.dataset.busy;}});
  log.addEventListener('toggle',async e=>{const d=e.target;if(!d.matches||!d.matches('details.chat-meta')||!d.open||d.dataset.loaded)return;d.dataset.loaded='1';
    const body=d.querySelector('.chat-meta-body');
    try{const r=await fetch(d.dataset.src,{credentials:'same-origin',cache:'no-store'});
      if(!r.ok){body.textContent='读取失败（HTTP '+r.status+'），收起后再展开可重试';delete d.dataset.loaded;return;}body.innerHTML=await r.text();
    }catch(x){body.textContent='读取失败，收起后再展开可重试';delete d.dataset.loaded;}},true);
}
`;

/** 每个模块自带共享工具函数（避免模块 import 受 CSP nonce 限制）。 */
export const ASSETS: Record<string, string> = { 'live.js': shared + ctxShared + live, 'usage.js': shared + ctxShared + usage, 'logs.js': shared + logs, 'forms.js': forms,
  'agents.js': shared + AGENTS_JS, 'memory.js': shared + MEMORY_JS, 'context-usage.js': CONTEXT_USAGE_JS, 'topology.js': topology, 'chat.js': chat };
