import * as C from "./request-contracts";
import { Check } from "typebox/value";
import { readApi } from "./api";
import { input } from "./dom";
import { $, ApiError, api, bjTime, duration, el, fail, pill, readToken, state, time } from "./app";
import { loadTopology, renderTopology, resetTopology, stopTopology } from "./topology";
import { listPages, paginateChildren } from "./pagination";
import { loadChat, resetChatTrace, scheduleConsolePoll } from "./trace";
import { cacheCell, detailCache, openRequest, percent, toolCache } from "./request-detail";
import { loadManagement, managementPages, showManagement } from "./management";
import { sh } from "./sessions";
import { ADMIN_PAGE_SIZE } from "../src/admin/pagination";
export const cs: C.ConsoleState = { view:"usage", until:Date.now(), before:undefined, next:undefined, pages:[], requestVersion:0, detailVersion:0,
  chat:"owner", chatVersion:0, fingerprint:"", timer:undefined, sending:false, epoch:0, pending:null,
  chatActive:false,requestActive:false,chatLoading:false,messages:new Map(),requests:new Map(),tools:new Map(),traceTurns:"",traceCursor:0,chatAfter:null,turn:null,detailId:null };
export const nf = (n: unknown) => typeof n === "number" ? n.toLocaleString("zh-CN") : "—";
export const compact = (n: number) => n>=1e6?(n/1e6).toFixed(1)+"M":n>=1000?(n/1000).toFixed(1)+"k":nf(n);
export const statuses: Record<string, string>={running:"进行中",done:"完成",error:"错误",aborted:"已取消",interrupted:"采集未完成",queued:"排队 / 执行中",failed:"失败"};
export const purposes: Record<string, string>={conversation:"主会话",background:"记忆与维护",subagent:"子任务",compaction:"上下文压缩"};
export const requestPill=(s: string)=>pill(statuses[s]||s,s==="done"?"ok":s==="running"||s==="queued"?"warn":"bad");
export function choices(id: string, values: (string | {key: string; name?: string})[], first: string){
  const node=input(id),selected=node.value;
  node.replaceChildren(el("option",{value:"",text:first}),...values.map(v=>el("option",{value:typeof v === "string" ? v : v.key,text:typeof v === "string" ? v : v.name || v.key})));
  node.value=values.some(v=>(typeof v === "string" ? v : v.key)===selected)?selected:"";
}
export function renderConsoleThreads(){
  const threads=state.overview&&state.overview.threads||[{key:"owner",name:"主人会话"}];
  choices("req-thread",threads.map(t=>({key:t.key,name:t.name||(t.key==="owner"?"主人会话":t.key)})),"全部会话");
  $("chat-thread-list").replaceChildren(...threads.map(t=>el("button",{className:"chat-thread",type:"button","aria-current":String(t.key===cs.chat),
    onclick:()=>chooseChat(t.key)},[el("span",{text:t.name||(t.key==="owner"?"主人会话":t.key)}),el("small",{text:t.key})])));
  renderTopology();
  paginateChildren($("chat-thread-list"));
}
export function chooseChat(key: string){
  cs.chat=key;cs.chatVersion++;cs.fingerprint="";resetChatTrace();
  $("chat-messages").replaceChildren(el("div",{className:"empty-state",text:"正在载入对话…"}));
  $("chat-input").value="";restorePending();renderConsoleThreads();if(cs.view==="chat")loadChat().catch(fail);
}
export function consoleView(view: string){
  if(cs.view!==view){clearTimeout(cs.timer);stopTopology();detailCache.clear();toolCache.clear();cs.requestVersion++;if(cs.view==="chat"){cs.chatVersion++;cs.chatLoading=false;}}
  if(cs.view!=="usage"&&view==="usage"){cs.until=Date.now();cs.before=undefined;cs.pages=[];}
  cs.view=view;
  document.querySelectorAll<HTMLElement>("[data-view]").forEach(b=>{if(b.dataset.view===view)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");});
  $("view-requests").hidden=view!=="usage";$("usage-summary").hidden=view!=="usage";$("view-chat").hidden=view!=="chat";
  showManagement(view);$("requests-heading").textContent="用量总览";
  if(view==="chat"){loadChat().catch(fail);renderTopology();loadTopology(true);}
  if(view==="usage")loadRequests().catch(fail);
  if(managementPages[view])loadManagement(view).catch(fail);
}
export function resetConsole(){
  listPages.clear();resetTopology();
  clearTimeout(cs.timer);cs.timer=undefined;detailCache.clear();toolCache.clear();resetChatTrace();cs.epoch++;cs.requestVersion++;cs.chatVersion++;cs.detailVersion++;
  $("session-history").close();sh.version++;
  $("request-detail").close();$("detail-body").replaceChildren();$("chat-messages").replaceChildren();
}
export function startConsole(){restorePending();renderConsoleThreads();consoleView(cs.view);}
export function requestParams(){
  const p=new URLSearchParams({since:String(cs.until-Number($("req-range").value)*3600000),until:String(cs.until),limit:String(ADMIN_PAGE_SIZE)});
  for(const [key,id] of [["thread","req-thread"],["model","req-model"],["status","req-status"],["purpose","req-purpose"]])if(input(id).value)p.set(key,input(id).value);
  if(cs.turn)p.set("turn",cs.turn);
  return p;
}
export async function loadRequests(){
  const version=++cs.requestVersion,epoch=cs.epoch,p=requestParams(),summaryParams=p.toString();
  if(cs.before)p.set("before",String(cs.before));$("request-state").textContent="正在载入…";
  try{
    const [page,u]=await Promise.all([readApi(C.RequestPage, "GET","/admin/requests?"+p),readApi(C.Usage, "GET","/admin/usage?"+summaryParams)]);
    if(version!==cs.requestVersion||epoch!==cs.epoch)return;
    cs.next=page.next;$("req-prev").disabled=!cs.pages.length;$("req-next").disabled=!page.next;
    $("request-empty").hidden=!!page.requests.length;
    $("request-rows").replaceChildren(...page.requests.map(r=>el("tr",{},[
      el("td",{},[el("button",{className:"request-link",type:"button",text:bjTime(r.startedAt),onclick:()=>openRequest(r.id)}),el("div",{className:"table-sub mono",text:r.id.slice(0,8)})]),
      el("td",{},[el("span",{text:r.model}),el("div",{className:"table-sub",text:r.provider+" / "+(purposes[r.purpose]||r.purpose)})]),
      el("td",{},[el("button",{className:"request-link",type:"button",text:r.thread,onclick:()=>{chooseChat(r.thread);consoleView("chat");}})]),
      el("td",{},[requestPill(r.status)]),el("td",{className:"num",text:nf(r.inputTokens)}),el("td",{className:"num",text:nf(r.outputTokens)}),el("td",{className:"num"},[cacheCell(r)]),el("td",{className:"num",text:duration(r.durationMs)})
    ])));
    const s=u.summary;cs.requestActive=s.running>0;$("request-turn-filter").hidden=!cs.turn;
    $("metric-requests").textContent=nf(s.requests);$("metric-failures").textContent=s.failed+" 条异常 · "+s.running+" 条进行中";
    $("metric-input").textContent=s.measured?nf(s.inputTokens):"—";$("metric-output").textContent=s.measured?nf(s.outputTokens):"—";
    $("metric-cache").textContent=s.cacheInputTokens?percent(s.cacheRead/s.cacheInputTokens):"—";
    $("metric-cache-note").textContent=s.cacheMeasured+" / "+s.requests+" 条已上报缓存 · 按输入量加权";
    $("metric-duration").textContent=duration(s.avgDuration==null?null:Math.round(s.avgDuration));
    $("metric-measured").textContent=s.measured+" / "+s.requests+" 条已返回用量";
    $("req-count").textContent="共 "+nf(s.requests)+" 次调用";$("request-state").textContent="第 "+(cs.pages.length+1)+" 页 · 每页 "+ADMIN_PAGE_SIZE+" 条 · 更新于 "+time(Date.now());
    choices("req-model",u.choices,"全部模型");drawTokens(u,Number(p.get("since")),Number(p.get("until")));
    const total=s.inputTokens+s.outputTokens;
    $("model-breakdown").replaceChildren(...u.models.slice(0,5).map(m=>el("div",{className:"model-item"},[
      el("div",{className:"model-name",text:m.model}),el("div",{className:"model-numbers"},[el("strong",{text:compact(m.inputTokens+m.outputTokens)}),el("small",{className:"muted",text:m.requests+" 次调用"})]),
      el("div",{className:"meter"},[el("span",{style:"width:"+(total?(m.inputTokens+m.outputTokens)/total*100:0)+"%"})])
    ])));
    if(!u.models.length)$("model-breakdown").append(el("p",{className:"muted small",text:"有请求后，这里会显示各模型的用量占比。"}));
    $("request-retention").textContent="元数据最多 30 天 / 20,000 条，上下文详情最多 7 天 / 总计 32 MiB。达到上限会提前清理。"+
      (u.retainedSince?"当前最早记录："+bjTime(u.retainedSince)+"。":"从新版本上线后开始采集。")+"未返回的用量不计入 token 合计。";
  }catch(error){if(version===cs.requestVersion){cs.requestActive=false;$("request-state").textContent="数据载入失败，请刷新重试";}throw error;}finally{if(version===cs.requestVersion)scheduleConsolePoll();}
}
export function refreshConsole(){if(cs.view==="usage"&&cs.requestActive&&!cs.before&&!document.hidden){cs.until=Date.now();loadRequests().catch(fail);}}
export function refreshRequests(){cs.until=Date.now();cs.before=undefined;cs.pages=[];loadRequests().catch(fail);}
export function sv<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number | null | undefined> = {}, text?: string){
  const node=document.createElementNS("http://www.w3.org/2000/svg",name);
  for(const [k,v] of Object.entries(attrs||{}))node.setAttribute(k,String(v));if(text!==undefined)node.textContent=text;return node;
}
export function drawTokens(u: C.Usage, since: number, until: number){
  const svg=$("token-chart");svg.replaceChildren();cs.chart={u,since,until};
  const map=new Map(u.series.map(x=>[x.at,x])),bins=[],step=u.bucket;
  for(let at=Math.floor((since+28800000)/step)*step-28800000;at<=until;at+=step)bins.push(map.get(at)||{at,inputTokens:0,outputTokens:0});
  const max=Math.max(3,...bins.map(x=>x.inputTokens+x.outputTokens)),left=48,top=12,width=Math.max(230,svg.clientWidth-64),height=160;
  svg.setAttribute("viewBox","0 0 "+(width+64)+" 210");
  for(let i=0;i<4;i++){const y=top+height-height*i/3;svg.append(sv("line",{x1:left,x2:left+width,y1:y,y2:y,stroke:"#E7EDF0"}),sv("text",{x:left-9,y:y+4,"text-anchor":"end"},compact(Math.round(max*i/3))));}
  const cell=width/bins.length,bw=Math.max(2,Math.min(23,cell*.65));
  bins.forEach((b,i)=>{
    const x=left+i*cell+(cell-bw)/2,ih=b.inputTokens/max*height,oh=b.outputTokens/max*height,g=sv("g",{});
    g.append(sv("title",{},bjTime(b.at)+" 输入 "+nf(b.inputTokens)+" / 输出 "+nf(b.outputTokens)),sv("rect",{x,y:top+height-ih,width:bw,height:ih,fill:"#A9D7CF",rx:1}),sv("rect",{x,y:top+height-ih-oh,width:bw,height:oh,fill:"#087F73",rx:1}));svg.append(g);
    if(i%Math.max(1,Math.ceil(bins.length/(width<400?3:6)))===0)svg.append(sv("text",{x:x+bw/2,y:199,"text-anchor":"middle"},step===3600000?bjTime(b.at).slice(-5):bjTime(b.at).slice(0,5)));
  });
  if(!u.summary.measured)svg.append(sv("text",{x:left+width/2,y:85,"text-anchor":"middle"},"暂无已返回的 token 用量"));
  $("chart-note").textContent="北京时间 · "+(step===3600000?"每小时":"每天")+"汇总 · "+(u.summary.requests-u.summary.measured)+" 条请求未返回用量";
}
export const pendingKey=()=>"cs-agent:web-pending:"+cs.chat;
export function restorePending(){
  try{const value: unknown=JSON.parse(sessionStorage.getItem(pendingKey())||"null");cs.pending=Check(C.PendingChat,value)?value:null;}catch{cs.pending=null;}
  if(cs.pending&&typeof cs.pending.text==="string")$("chat-input").value=cs.pending.text;else cs.pending=null;
  $("chat-input").readOnly=!!cs.pending;$("chat-send").textContent=cs.pending?"重试发送":"发送消息";
}
export async function downloadAsset(ref: C.Asset){
  try{
    const response=await fetch("/media/assets/"+encodeURIComponent(ref.scope)+"/"+encodeURIComponent(ref.id),{headers:{Authorization:"Bearer "+readToken()},cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});
    if(!response.ok)throw new ApiError(response.status,{});const url=URL.createObjectURL(await response.blob()),a=document.createElement("a");
    a.href=url;a.download=ref.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){fail(error);}
}
export async function sendChat(event: Event){
  event.preventDefault();if(cs.sending)return;
  const thread=cs.chat,text=$("chat-input").value.trim();if(!text)return;
  const pending=cs.pending||{requestId:crypto.randomUUID(),text};cs.pending=pending;
  try{sessionStorage.setItem(pendingKey(),JSON.stringify(pending));}catch{}
  cs.sending=true;$("chat-send").disabled=true;$("chat-input").readOnly=true;$("chat-state").textContent="正在提交…";
  try{
    await api("POST","/admin/threads/"+encodeURIComponent(thread)+"/chat",pending);
    if(cs.chat===thread){cs.awaitingInput="web:"+pending.requestId;cs.chatActive=true;}
    try{sessionStorage.removeItem("cs-agent:web-pending:"+thread);}catch{}
    if(cs.chat===thread){cs.pending=null;$("chat-input").value="";$("chat-input").readOnly=false;$("chat-send").textContent="发送消息";await loadChat();$("chat-input").focus();}
  }catch(error){
    if(cs.chat===thread){
      const rejected=error instanceof ApiError && error.status>=400 && error.status<500 && error.status!==429;
      if(rejected){cs.pending=null;try{sessionStorage.removeItem(pendingKey());}catch{}$("chat-input").readOnly=false;}
      $("chat-state").textContent=rejected?"消息未提交，请检查后重试。":"发送结果未确认。重试会使用相同编号，避免重复提交。";$("chat-send").textContent=rejected?"发送消息":"重试发送";
    }
    fail(error);
  }finally{cs.sending=false;$("chat-send").disabled=false;scheduleConsolePoll();}
}

export function initConsole() {
  window.addEventListener("resize",()=>{clearTimeout(cs.resizeTimer);cs.resizeTimer=setTimeout(()=>{if(cs.chart&&cs.view==="usage")drawTokens(cs.chart.u,cs.chart.since,cs.chart.until);},100);});
  document.querySelectorAll<HTMLElement>("[data-view]").forEach(b=>b.addEventListener("click",()=>{if(b.dataset.view)consoleView(b.dataset.view);}));
  ["req-range","req-thread","req-model","req-purpose","req-status"].forEach(id=>$(id).addEventListener("change",()=>{cs.turn=null;refreshRequests();}));
  $("request-turn-clear").addEventListener("click",()=>{cs.turn=null;refreshRequests();});
  $("req-refresh").addEventListener("click",refreshRequests);
  $("req-prev").addEventListener("click",()=>{cs.before=cs.pages.pop();loadRequests().catch(fail);});
  $("req-next").addEventListener("click",()=>{if(!cs.next)return;cs.pages.push(cs.before);cs.before=cs.next;loadRequests().catch(fail);});
  $("detail-close").addEventListener("click",()=>{$("request-detail").close();cs.detailVersion++;});
  $("chat-form").addEventListener("submit",sendChat);
  $("chat-input").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();$("chat-form").requestSubmit();}});
  $("chat-reload").addEventListener("click",()=>{cs.chatAfter=null;loadChat().catch(fail);});
}
