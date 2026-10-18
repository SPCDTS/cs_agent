/**
 * 会话页 / 回合页 / 上下文分析页的原生 JS（/assets/agents.js）。只用 textContent 与 DOM API，不拼 HTML；
 * 块结构与 turn-view.ts 的服务端渲染一致。功能：
 * - "加载全文"：按 ≤256 KiB 分段读取 /content，按收到正文的 UTF-8 字节数推进偏移（服务端按字符边界裁剪，
 *   不按请求长度推进可避免边界处汉字丢失）；400/409 提示索引已刷新。
 * - 折叠回合展开时懒加载 /turns/:turn；回合头补齐模型与上下文占用（最后一次 model_request 的 input）。
 * - 活动会话订阅 /agents/stream；断线后重取会话与最新回合快照再订阅（接口没有重放）。
 */
export const AGENTS_JS = String.raw`
const CHUNK=256*1024;
const DATA=(()=>{const n=document.getElementById('agents-data');if(!n)return null;try{return JSON.parse(n.textContent);}catch(e){return null;}})()||{};
const stream=document.getElementById('tstream'), dir=document.getElementById('tdir'), conn=document.getElementById('conn');
const enc=encodeURIComponent;
const apiBase=()=>'/api/agents/'+enc(DATA.backend)+'/sessions/'+enc(DATA.session);
function fmtInt(n){return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
function fmtPct(p){return (p>0&&p<1?'<1':String(Math.round(p)))+'%';}
function fmtBytes(n){if(n==null)return '—';if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB';}
function fmtTime(ts){try{return new Date(ts).toLocaleString('zh-CN',{hour12:false});}catch(e){return String(ts);}}
function utf8len(s){return new TextEncoder().encode(s).length;}
function pretty(t){try{const v=JSON.parse(t);return v&&typeof v==='object'?JSON.stringify(v,null,2):t;}catch(e){return t;}}
function up(n,pred){while(n&&n!==document){if(pred(n))return n;n=n.parentNode;}return null;}
function has(n,c){return !!(n&&n.classList&&n.classList.contains(c));}
function attrSel(k,v){return '[data-'+k+'="'+CSS.escape(v)+'"]';}

/* ── 加载全文 ── */
async function loadFull(btn){
  if(btn.disabled)return;btn.disabled=true;
  const row=btn.parentNode, target=row.parentNode.querySelector('.bt'), note=row.querySelector('.load-note');
  const backend=btn.dataset.backend||DATA.backend, session=btn.dataset.session||DATA.session;
  const start=Number(btn.dataset.offset), end=start+Number(btn.dataset.length);
  let pos=start, first=true, text='';
  const fail=(msg)=>{note.textContent=msg;note.className='load-note err';btn.disabled=false;};
  note.className='load-note';note.textContent='读取中…';
  try{
    while(pos<end){
      const len=Math.min(CHUNK,end-pos);
      const r=await fetch('/api/agents/'+enc(backend)+'/sessions/'+enc(session)+'/content?offset='+pos+'&length='+len,{credentials:'same-origin'});
      if(r.status===400||r.status===409){fail('索引已刷新，请重新加载页面后再展开');return;}
      if(!r.ok){fail('读取失败（HTTP '+r.status+'），可重试');return;}
      const j=await r.json();const t=typeof j.text==='string'?j.text:'';const adv=utf8len(t);
      if(!adv)break;
      if(first){target.textContent='';first=false;}
      target.append(document.createTextNode(t));text+=t;pos+=adv;
      note.textContent='已读取 '+fmtBytes(pos-start)+' / '+fmtBytes(end-start)+(j.truncated?'（分段续读）':'');
    }
    if(target.dataset.json)target.textContent=pretty(text);
    target.classList.remove('partial');btn.remove();
    note.textContent='全文 '+fmtBytes(utf8len(text));
  }catch(e){fail('读取失败，可重试');}
}

/* ── 块渲染（与 turn-view.ts 同构） ── */
function stampEl(label,tone){return el('span','stamp s-'+tone,label);}
const TURN={ok:['完成','ok'],failed:['失败','fail'],running:['进行中','run']};
function turnStamp(s){const v=TURN[s]||[s||'未知','idle'];return stampEl(v[0],v[1]);}
function resultStamp(s){return s==='failed'?stampEl('失败','fail'):s==='running'?stampEl('进行中','run'):stampEl('成功','ok');}
function usageOf(m){const u=m&&m.usage;return u&&typeof u.input==='number'?u:null;}
function fmtUsage(u){return '输入 '+fmtInt(u.input)+(u.cached?'（缓存 '+fmtInt(u.cached)+'）':'')+' · 输出 '+fmtInt(u.output||0)+(u.reasoning?'（推理 '+fmtInt(u.reasoning)+'）':'');}
function ctxText(input){const w=DATA.window;return fmtInt(input)+(w?' / '+fmtInt(w)+'（'+fmtPct(input/w*100)+'）':'')+' tokens';}
function textBody(b,pre,json){
  const t=el(pre?'pre':'div',pre?'bt':'bt prose');if(json)t.dataset.json='1';
  if(b.text!=null){t.textContent=json?pretty(b.text):b.text;return [t];}
  if(b.ref){t.classList.add('partial');t.textContent=b.preview||'';
    const row=el('div','load-row'),btn=el('button','quiet load-full','加载全文（'+fmtBytes(b.ref.bytes||b.ref.length)+'）'),note=el('span','load-note');
    btn.type='button';btn.dataset.session=b.ref.session;btn.dataset.offset=String(b.ref.offset);btn.dataset.length=String(b.ref.length);note.setAttribute('role','status');
    row.append(btn,note);return [t,row];}
  t.classList.add('faint');t.textContent='（无正文）';return [t];
}
function det(cls,parts){const d=el('details',cls),s=el('summary');for(const p of parts)s.append(typeof p==='string'?document.createTextNode(p):p);d.append(s);return d;}
function resultNode(b){const d=det('tc-res',['结果 ',resultStamp(b.meta&&b.meta.status)]);d.append(...textBody(b,true));return d;}
function reqNode(b){const m=b.meta||{},u=usageOf(m);const n=el('div','blk req');
  n.append(el('span',null,[m.request?'模型请求 #'+m.request:'模型请求',m.model,m.effort,u?fmtUsage(u):'',m.duration_ms!=null?'耗时 '+fmtMs(m.duration_ms):''].filter(Boolean).join(' · ')));
  if(u)n.dataset.usage='1';return n;}
function toolCard(b){const m=b.meta||{};const n=el('div','blk tc');if(b.callId)n.dataset.call=b.callId;
  const head=el('div','tc-head');head.append(el('b','tc-name',m.name||'未知工具'));const server=m.server||m.namespace;if(server)head.append(el('span','pill',server));
  const st=el('span','tc-status');st.append(resultStamp(m.status));head.append(st,el('span','tc-dur faint',m.duration_ms!=null?fmtMs(m.duration_ms):''));
  const args=det('tc-args',['参数']);args.append(...textBody(b,true,true));n.append(head,args,el('div','tc-slot'));return n;}
function blockNode(b){
  const m=b.meta||{};let n;
  switch(b.kind){
    case 'user':case 'assistant':n=el('div','blk '+b.kind);n.append(el('div','bk',b.kind==='user'?'用户':'助手'),...textBody(b));return n;
    case 'image':n=el('div','blk image');n.append(el('span','img-ph','▣'),el('span',null,b.text||'图片'));if(m.mimeType)n.append(el('span','faint',m.mimeType));if(m.source)n.append(el('span','faint mono',String(m.source).slice(0,120)));return n;
    case 'thinking':if(m.unavailable&&b.text==null&&!b.ref){n=el('div','blk thinking');n.append(el('span','bk','思考'),document.createTextNode(' '),el('span','faint','不可用（加密或已省略）'));return n;}
      n=det('blk thinking',['思考'+(m.unavailable?'（部分不可用）':'')]);n.append(...textBody(b));return n;
    case 'tool_call':return toolCard(b);
    case 'tool_result':n=el('div','blk tc orphan');if(b.callId)n.dataset.call=b.callId;{const h=el('div','tc-head');h.append(el('b','tc-name',m.name||'工具结果'));const s=el('div','tc-slot');s.append(resultNode(b));n.append(h,s);}return n;
    case 'compaction':n=det('blk compaction',['上下文压缩'+(m.reason?' · '+m.reason:'')]);n.append(...textBody(b));return n;
    case 'system_change':n=det('blk sysch',['系统变更'+(m.reset?'（上下文重置）':'')]);n.append(...textBody(b,true));return n;
    case 'event':
      if(m.type==='model_request')return reqNode(b);
      if(m.type==='model_usage')return null;
      if(m.type==='turn_complete'||m.type==='turn_failed'){n=el('div','blk end');n.append(m.type==='turn_complete'?stampEl('回合完成','ok'):stampEl('回合失败','fail'));return n;}
      n=el('div','blk ev'+(m.status==='failed'?' failed':''));if(m.status==='failed')n.append(stampEl('错误','fail'));n.append(el('span',null,b.text||b.preview||m.type||'事件'));return n;
    default:n=el('div','blk ev');n.append(...textBody(b));return n;
  }
}
function sig(b){const m=b.meta||{};return [b.kind,b.ts==null?'':b.ts,b.callId||'',m.type||'',(b.text!=null?b.text:b.preview||'').slice(0,64)].join('|');}

/* ── 回合 ── */
function turnNodes(id){return document.querySelectorAll(attrSel('turn',id));}
function turnSection(id){if(!stream)return null;for(const n of stream.querySelectorAll(attrSel('turn',id)))if(has(n,'turn'))return n;return null;}
function setStatus(id,status){for(const n of turnNodes(id)){const s=n.querySelector('.th-status');if(s)s.replaceChildren(turnStamp(status));}}
function setHeader(d,facts){
  const model=d.querySelector('.tm-model'),ctx=d.querySelector('.tm-ctx');
  if(model&&facts.model)model.textContent=[facts.model,facts.effort].filter(Boolean).join(' · ');
  if(ctx&&facts.context)ctx.textContent='上下文 '+ctxText(facts.context.input);
}
function factsOf(blocks){const reqs=blocks.filter(b=>b.kind==='event'&&b.meta&&b.meta.type==='model_request');
  const wm=reqs.filter(b=>b.meta.model).pop(), we=reqs.filter(b=>b.meta.effort).pop(), wu=reqs.filter(b=>usageOf(b.meta)).pop();
  return {model:wm&&wm.meta.model,effort:we&&we.meta.effort,context:wu?usageOf(wu.meta):null};}
function bodyOf(d){return d.querySelector('.turn-body');}
// 往回合正文追加一个块：工具结果挂到对应调用卡片；model_usage 补到最后一条未带用量的请求行与回合头。
function addBlock(d,b){
  const body=bodyOf(d);if(!body)return;
  d._sigs=d._sigs||new Set();const k=sig(b);if(d._sigs.has(k))return;d._sigs.add(k);
  for(const p of body.querySelectorAll('.placeholder'))p.remove();
  const m=b.meta||{};
  if(b.kind==='tool_result'&&b.callId){
    for(const card of body.querySelectorAll(attrSel('call',b.callId))){if(!has(card,'tc')||has(card,'orphan'))continue;
      const slot=card.querySelector('.tc-slot');slot.replaceChildren(resultNode(b));const st=card.querySelector('.tc-status');if(st)st.replaceChildren(resultStamp(m.status));
      const dur=card.querySelector('.tc-dur');if(dur&&m.duration_ms!=null)dur.textContent=fmtMs(m.duration_ms);return;}
  }
  if(b.kind==='event'&&m.type==='model_usage'){const u=usageOf(m);if(!u)return;
    const reqs=body.querySelectorAll('.req');for(let i=reqs.length-1;i>=0;i--){const r=reqs[i];if(r.dataset.usage)break;r.dataset.usage='1';const s=r.querySelector('span')||r;s.textContent=s.textContent+' · '+fmtUsage(u);break;}
    setHeader(d,{context:u});return;}
  if(b.kind==='event'&&m.type==='model_request')setHeader(d,{model:m.model,effort:m.effort,context:usageOf(m)});
  if(b.kind==='event'&&(m.type==='turn_complete'||m.type==='turn_failed'))setStatus(d.dataset.turn,m.type==='turn_complete'?'ok':'failed');
  if(b.kind==='user'&&b.text){const p=d.querySelector('.th-preview');if(p&&p.dataset.live&&!p.textContent)p.textContent=b.text.slice(0,200);}
  const n=blockNode(b);if(n)body.append(n);
}
function renderTurn(d,blocks){
  const body=bodyOf(d);body.replaceChildren();delete body.dataset.lazy;d._sigs=new Set();
  if(!blocks.length)body.append(el('p','faint placeholder','这个回合还没有正文块。'));
  for(const b of blocks)addBlock(d,b);setHeader(d,factsOf(blocks));
}
async function loadTurn(d){
  const id=d.dataset.turn,body=bodyOf(d);if(!id||!body||d._loading)return;d._loading=true;
  try{const r=await fetch(apiBase()+'/turns/'+enc(id),{credentials:'same-origin'});
    if(!r.ok){body.replaceChildren(el('p','load-note err',r.status===404?'回合不存在或索引已刷新，请重新加载页面':'读取失败（HTTP '+r.status+'）'));return false;}
    const j=await r.json();renderTurn(d,j.blocks||[]);if(j.turn)setStatus(id,j.turn.status);return true;
  }catch(e){body.replaceChildren(el('p','load-note err','读取失败，请稍后重试'));return false;}finally{d._loading=false;}
}
function watch(d){d.addEventListener('toggle',()=>{const b=bodyOf(d);if(d.open&&b&&b.dataset.lazy)loadTurn(d);});}
function link(href,text){const a=el('a',null,text);a.href=href;return a;}
// 新回合（实时帧里出现未知 turn，或重连后会话快照中的新回合）：回合流与目录各插一项，放在最前。
function newTurn(t,open){
  const n=++DATA.base, id=t.turn, turnHref=location.pathname.replace(/\/$/,'')+'/turns/'+enc(id);
  const ctxHref=p=>location.pathname.replace(/\/$/,'')+'/context?at='+enc(id)+'&phase='+p;
  const d=el('details','turn sheet');d.id='t-'+n;d.dataset.turn=id;
  const s=el('summary','turn-head'),st=el('span','th-status'),pv=el('span','th-preview',t.preview||''),tm=el('span','tm');
  st.append(turnStamp(t.status||'running'));pv.dataset.live='1';
  tm.append(el('span','tm-time',fmtTime(t.started||Date.now())),el('span','tm-model'),el('span','tm-ctx'));s.append(st,pv,tm);
  const bar=el('div','turn-bar'),links=el('span','tm-links');links.append(link(ctxHref('before'),'分析此回合前的上下文'),link(ctxHref('after'),'分析此回合后的上下文'));
  bar.append(link(turnHref,'回合详情'),links);
  const body=el('div','turn-body');body.append(el('p','faint placeholder','等待正文…'));
  d.append(s,bar,body);d.open=!!open;watch(d);
  if(stream)stream.prepend(d);
  if(dir){const li=el('li');li.dataset.turn=id;const a=link('#t-'+n,'');a.dataset.open='t-'+n;a.append(el('span','excerpt',t.preview||'（新回合）'));
    const meta=el('div','dir-meta'),ds=el('span','th-status');ds.append(turnStamp(t.status||'running'));meta.append(ds,el('span','faint',fmtTime(t.started||Date.now())));li.append(a,meta);dir.prepend(li);}
  const empty=document.getElementById('no-turns');if(empty)empty.remove();
  return d;
}

/* ── 实时 ── */
let es=null, retry=2000, queue=null;
function setConn(on,text){if(!conn)return;conn.className='conn '+(on?'on':'off');conn.textContent=text;}
function onFrame(f){
  if(!f||!f.turn||!f.block)return;
  if(queue){queue.push(f);return;}
  let d=turnSection(f.turn);
  if(!d)d=newTurn({turn:f.turn,started:f.block.ts,status:'running'},true);
  if(bodyOf(d).dataset.lazy)return; // 折叠且未加载的回合：展开时整体读取
  addBlock(d,f.block);
}
// 重同步：会话快照补回合目录，最新回合整体重读；期间到达的帧排队，完成后按签名去重补上。
async function resync(){
  queue=[];
  try{
    const r=await fetch(apiBase(),{credentials:'same-origin'});
    if(r.ok){const j=await r.json();const turns=(j.turns||[]).slice().sort((a,b)=>a.started-b.started);
      for(const t of turns)if(!turnSection(t.turn))newTurn(t,false);
      for(const t of turns){setStatus(t.turn,t.status);}
      if(j.session&&j.session.status!=='active'){DATA.active=false;}
      const latest=turns[turns.length-1];const d=latest&&turnSection(latest.turn);
      if(d){d.open=true;await loadTurn(d);}
    }
  }catch(e){}
  const q=queue;queue=null;for(const f of q)onFrame(f);
}
function connect(){
  if(!DATA.active||typeof EventSource==='undefined')return;
  es=new EventSource('/agents/stream?backend='+enc(DATA.backend)+'&session='+enc(DATA.session));
  es.onopen=()=>{retry=2000;setConn(true,'实时更新中');};
  es.addEventListener('block',e=>{let f;try{f=JSON.parse(e.data);}catch(x){return;}onFrame(f);});
  es.addEventListener('error',e=>{if(e&&e.data){setConn(false,'正文块过大，正在重新读取…');}});
  es.onerror=()=>{if(es)es.close();es=null;setConn(false,'连接中断，'+Math.round(retry/1000)+' 秒后重取快照并重连');
    const wait=retry;retry=Math.min(retry*2,30000);setTimeout(async()=>{await resync();if(DATA.active)connect();else setConn(false,'会话已归档，停止实时更新');},wait);};
}

/* ── 交互 ── */
document.addEventListener('click',e=>{
  const btn=up(e.target,n=>has(n,'load-full'));if(btn){e.preventDefault();loadFull(btn);return;}
  const cp=up(e.target,n=>has(n,'copy'));
  if(cp){const v=cp.dataset.copy||'';const done=()=>{const old=cp.textContent;cp.textContent='已复制';setTimeout(()=>{cp.textContent=old;},1200);};
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(done,()=>{});return;}
  const op=up(e.target,n=>n.dataset&&n.dataset.open);
  if(op){const d=document.getElementById(op.dataset.open);if(d){d.open=true;const b=bodyOf(d);if(b&&b.dataset.lazy)loadTurn(d);}}
});
if(stream)for(const d of stream.querySelectorAll('.turn')){watch(d);}
if(stream&&location.hash){const d=document.getElementById(location.hash.slice(1));if(d&&has(d,'turn')){d.open=true;const b=bodyOf(d);if(b&&b.dataset.lazy)loadTurn(d);}}
connect();
`;
