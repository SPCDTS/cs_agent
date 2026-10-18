/**
 * /memory/scopes/:scope 的原生 JS（/assets/memory.js）。只用 textContent 与 DOM API，不拼 HTML；
 * vis-timeline 的条目内容、悬浮提示与分组标题都以元素传入（不走库内 HTML 字符串分支）。功能：
 * - 三条轨（原文桶 / 日摘要 / 周摘要）、空白背景（purged 与 no_records 分色）、保留边界竖线（不可拖动）。
 * - 点击原文桶 → 列出该桶 [start, end) 内的消息；点击摘要 → 打开 /memory/summaries/:id。
 * - 消息列表：newest first，每页 50，"更早"沿 next_before 翻页，接口给出 next_before_id 时
 *   一并带 before_id 作同秒决胜；错误显示提示，可重试。
 * 消息条目结构与 memory-pages.ts 的 messageItem 一致。
 */
import { MESSAGE_ERROR_HINT } from './memory-pages.js';

export const MEMORY_JS = String.raw`
const DATA=(()=>{const n=document.getElementById('memory-data');if(!n)return null;try{return JSON.parse(n.textContent);}catch(e){return null;}})();
const enc=encodeURIComponent;
const ERR_HINT=${JSON.stringify(MESSAGE_ERROR_HINT)};
function fmtTime(ts){try{return new Date(ts).toLocaleString('zh-CN',{hour12:false});}catch(e){return String(ts);}}
function fmtInt(n){return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
function cut(s,n){const a=Array.from(s||'');return a.length>n?a.slice(0,n).join('')+'…':a.join('');}

/* ── 消息列表 ── */
const list=document.getElementById('msgs'), more=document.getElementById('msg-more'), note=document.getElementById('msg-note'),
  none=document.getElementById('msg-empty'), winLabel=document.getElementById('msg-window');
const num=v=>typeof v==='number'&&isFinite(v)?v:null;
const state={win:DATA?DATA.window:null,cursor:DATA?num(DATA.next_before):null,cursorId:DATA?num(DATA.next_before_id):null,busy:false,seq:0};
function windowOf(from,to){return from>=1?{after:from-1,before:to}:{before:to};}
function messagesUrl(win,before,beforeId){
  const q=new URLSearchParams();
  q.set('before',String(before!=null?before:win.before));
  if(before!=null&&beforeId!=null)q.set('before_id',String(beforeId));
  if(win.after!=null)q.set('after',String(win.after));
  q.set('limit',String(DATA.limit||50));
  return '/api/memory/scopes/'+enc(DATA.scope)+'/messages?'+q.toString();
}
function msgNode(m){
  const li=el('li','msg');li.dataset.ts=String(m.ts);
  const head=el('div','msg-head'), t=el('time',null,fmtTime(m.ts));t.setAttribute('datetime',new Date(m.ts).toISOString());
  head.append(t,el('b',null,m.sender_name||m.sender||'—'));
  if(m.sender)head.append(el('span','mono faint',m.sender));
  if(m.bot_status)head.append(el('span','pill',m.bot_status));
  if(m.bot_action)head.append(el('span','pill',m.bot_action));
  if(m.media)head.append(el('span','pill','媒体 '+fmtInt(m.media)));
  if(m.reply_to){const r=el('span','faint','回复 ');r.append(el('span','mono',m.reply_to));head.append(r);}
  head.append(el('span','mono faint msg-id','#'+m.message_id));
  li.append(head,el('div','msg-text',m.text));
  if(m.truncated)li.append(el('div','hint','正文超过 2000 字，已截断。'));
  return li;
}
function setNote(text,err){if(!note)return;note.textContent=text||'';note.className='hint'+(err?' err':'');}
async function loadPage(reset){
  if(!DATA||!list||!state.win)return;
  if(state.busy&&!reset)return;
  const seq=++state.seq;state.busy=true;
  if(more)more.disabled=true;
  setNote('读取中…');
  try{
    const r=await fetch(messagesUrl(state.win,reset?null:state.cursor,reset?null:state.cursorId),{credentials:'same-origin'});
    if(seq!==state.seq)return;
    let j=null;try{j=await r.json();}catch(e){}
    if(reset){list.replaceChildren();}
    if(!r.ok){setNote(ERR_HINT+'（HTTP '+r.status+(j&&j.error?'：'+j.error:'')+'），可重试',true);if(more){more.hidden=false;more.disabled=false;}return;}
    const items=Array.isArray(j&&j.items)?j.items:[];
    for(const m of items)list.append(msgNode(m));
    state.cursor=num(j.next_before);state.cursorId=state.cursor==null?null:num(j.next_before_id);
    if(none)none.hidden=list.children.length>0;
    if(more){more.hidden=state.cursor==null;more.disabled=false;}
    setNote(state.cursor==null&&list.children.length?'已到这个窗口最早的消息。':'');
  }catch(e){if(seq===state.seq){setNote('读取消息失败，可重试',true);if(more){more.hidden=false;more.disabled=false;}}}
  finally{if(seq===state.seq)state.busy=false;}
}
function selectWindow(from,to,label){
  if(!DATA)return;
  const a=Math.max(from,DATA.range.first_ts), b=Math.min(to,DATA.range.last_ts);
  if(!(a<b))return;
  state.win=windowOf(a,b);state.cursor=null;state.cursorId=null;
  if(winLabel)winLabel.textContent=(label?label+'：':'')+fmtTime(a)+' — '+fmtTime(b)+'，最新在上';
  loadPage(true);
  const sec=document.getElementById('messages');if(sec&&sec.scrollIntoView)sec.scrollIntoView({block:'start'});
}
if(more)more.addEventListener('click',()=>loadPage(false));

/* ── 时间线 ── */
const EDGES={};
function tip(lines){const d=el('div','mtl-tip');for(const [i,l] of lines.entries())d.append(el(i?'div':'b',null,l));return d;}
function buildItems(D){
  const items=[], max=Math.max(1,...D.tracks.raw.map(b=>b.count));
  D.tracks.raw.forEach((b,i)=>{
    const level=Math.max(1,Math.min(4,Math.ceil(b.count/max*4)));
    items.push({id:'r'+i,group:'raw',type:'range',start:b.start,end:b.end,className:'m-raw d'+level,content:el('span','mi',fmtInt(b.count)),
      title:tip([fmtTime(b.start)+' — '+fmtTime(b.end),fmtInt(b.count)+' 条 · '+fmtInt(b.senders)+' 人',...(b.preview?['首条：'+b.preview]:[]),'点击列出这些消息'])});
  });
  for(const kind of ['day','week'])for(const s of D.tracks[kind]){
    items.push({id:'s'+s.id,group:kind,type:'range',start:s.period_start,end:s.period_end,className:'m-'+kind,content:el('span','mi',cut(s.preview,40)),
      title:tip([(kind==='day'?'日摘要 #':'周摘要 #')+s.id,fmtTime(s.period_start)+' — '+fmtTime(s.period_end),fmtInt(s.chars)+' 字'+(s.source_messages!=null?' · 生成时 '+fmtInt(s.source_messages)+' 条原文':''),cut(s.preview,120),'点击打开摘要'])});
  }
  D.gaps.forEach((g,i)=>items.push({id:'g'+i,type:'background',start:g.from,end:g.to,className:g.reason==='purged'?'gap-purged':'gap-none',
    content:el('span','gap-label',g.reason==='purged'?'早于保留边界（推算）':'无现存记录')}));
  return items;
}
function buildTimeline(){
  const box=document.getElementById('mtl');
  if(!DATA||!box)return null;
  if(typeof vis==='undefined'||!vis.Timeline){if(!box.querySelector||!box.querySelector('.flash'))box.replaceChildren(el('p','flash err','时间线组件未能加载，下面仍可查看摘要与消息列表。'));return null;}
  const D=DATA, span=Math.max(3600000,D.range.last_ts-D.range.first_ts);
  const groups=[['raw','原文'],['day','日摘要'],['week','周摘要']].map(([id,l],order)=>({id,order,content:el('span','mtl-group',l)}));
  box.replaceChildren();
  const tl=new vis.Timeline(box,new vis.DataSet(buildItems(D)),new vis.DataSet(groups),{
    stack:false,orientation:'top',groupOrder:'order',selectable:true,showCurrentTime:true,zoomMin:60000,
    start:D.range.first_ts,end:D.range.last_ts,min:D.range.first_ts-span,max:D.range.last_ts+span,
    margin:{item:{horizontal:0,vertical:6}},tooltip:{followMouse:true,overflowMethod:'cap',delay:150},
    format:{minorLabels:{millisecond:'SSS',second:'s',minute:'HH:mm',hour:'HH:mm',weekday:'M/D',day:'D',week:'w',month:'M月',year:'YYYY'},
      majorLabels:{millisecond:'HH:mm:ss',second:'M/D HH:mm',minute:'YYYY/M/D',hour:'YYYY/M/D',weekday:'YYYY/M',day:'YYYY/M',week:'YYYY/M',month:'YYYY',year:''}}});
  const e=D.retention_edges;
  EDGES['edge-raw']=e.raw_until;
  tl.addCustomTime(e.raw_until,'edge-raw');tl.setCustomTimeMarker('原文保留边界','edge-raw',false);
  EDGES['edge-sum']=e.day_until;
  tl.addCustomTime(e.day_until,'edge-sum');tl.setCustomTimeMarker(e.week_until===e.day_until?'摘要保留边界':'日摘要保留边界','edge-sum',false);
  if(e.week_until!==e.day_until){EDGES['edge-week']=e.week_until;tl.addCustomTime(e.week_until,'edge-week');tl.setCustomTimeMarker('周摘要保留边界','edge-week',false);}
  // 保留边界是配置推算的固定线：库默认允许拖动，这里拖动后立即复位。
  const pin=p=>{if(p&&EDGES[p.id]!=null)tl.setCustomTime(EDGES[p.id],p.id);};
  tl.on('timechange',pin);tl.on('timechanged',pin);
  tl.on('click',p=>{
    const id=p&&p.item;if(typeof id!=='string')return;
    if(id[0]==='r'){const b=D.tracks.raw[Number(id.slice(1))];if(b)selectWindow(b.start,b.end,'原文桶');}
    else if(id[0]==='s')location.href='/memory/summaries/'+enc(id.slice(1));
  });
  const vis1=document.getElementById('mtl-visible'), reset=document.getElementById('mtl-reset');
  if(vis1){vis1.hidden=false;vis1.addEventListener('click',()=>{const w=tl.getWindow();selectWindow(+w.start,+w.end,'可视范围');});}
  if(reset){reset.hidden=false;reset.addEventListener('click',()=>{tl.setWindow(D.range.first_ts,D.range.last_ts);selectWindow(D.range.first_ts,D.range.last_ts,'');});}
  return tl;
}
try{buildTimeline();}catch(e){const box=document.getElementById('mtl');if(box){box.replaceChildren(el('p','flash err','时间线绘制失败，下面仍可查看摘要与消息列表。'));}}
`;
