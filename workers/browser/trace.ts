import { refreshContextMonitor } from "./context-monitor";
import { consoleView, cs, downloadAsset, loadRequests, nf, requestPill, statuses } from "./console";
import { cacheRate, detailCache, openRequest, percent, toolCache, toolPayload } from "./request-detail";
import { $, bjTime, bytes, duration, el, fail, readToken, state, time } from "./app";
import * as C from "./request-contracts";
import { readApi } from "./api";
import { loadTopology, refreshTopologyAfterTurn } from "./topology";
import { loadSubagentChat, resetSubagentChat } from "./subagent-chat";
export function resetChatTrace(){resetSubagentChat();cs.fingerprint="";cs.messages.clear();cs.requests.clear();cs.tools.clear();cs.traceCursor=0;cs.traceTurns="";cs.chatAfter=null;cs.chatActive=false;cs.chatLoading=false;cs.awaitingInput=null;toolCache.clear();}
export function scheduleConsolePoll(){
  clearTimeout(cs.timer);cs.timer=undefined;
  if(document.hidden||!readToken())return;
  if(cs.view==="chat"&&cs.chatActive)cs.timer=setTimeout(()=>loadChat().catch(fail),2500);
  if(cs.view==="usage"&&cs.requestActive&&!cs.before)cs.timer=setTimeout(()=>{cs.until=Date.now();loadRequests().catch(fail);},5000);
}
export async function fetchTrace(thread:string,messages:C.ChatMessage[],version:number,epoch:number){
  const turns=[...new Set(messages.map(m=>m.turnId).filter((id):id is string=>id!==null&&id.length>0))].sort(),key=JSON.stringify(turns);
  if(key!==cs.traceTurns){cs.traceTurns=key;cs.traceCursor=0;cs.requests.clear();cs.tools.clear();}
  if(!turns.length)return;
  let more=true;
  while(more){
    const p=new URLSearchParams({after:String(cs.traceCursor)});turns.forEach(t=>p.append("turn",t));
    const trace=await readApi(C.Trace,"GET","/admin/threads/"+encodeURIComponent(thread)+"/trace?"+p);
    if((cs.chat.kind!=="thread"||thread!==cs.chat.thread)||version!==cs.chatVersion||epoch!==cs.epoch)return;
    const changedTurns=new Set<string>();
    trace.requests.forEach(r=>{cs.requests.set(r.id,r);detailCache.delete(r.id);if(r.binding)changedTurns.add(r.binding.turnId);});
    trace.tools.forEach(t=>{cs.tools.set(t.id,t);toolCache.delete(t.id);changedTurns.add(t.binding.turnId);});
    for(const [id,d]of detailCache){const turn=d.request.binding?.turnId;if(turn&&changedTurns.has(turn))detailCache.delete(id);}
    cs.traceCursor=trace.cursor;more=trace.more;
    if(document.hidden||cs.view!=="chat")break;
  }
}
export function renderToolTrace(tool:C.ToolSummary){
  const content=el("div",{className:"message-block-content"}),box=el("details",{className:"message-block trace-tool","data-tool":tool.id},[el("summary",{},[el("strong",{text:tool.name}),el("small",{text:tool.endedAt?duration(tool.endedAt-tool.startedAt):tool.status==="running"?"执行中":"耗时未记录"}),requestPill(tool.status)]),content]);let loaded=false;
  box.addEventListener("toggle",async()=>{
    if(!box.open||loaded)return;loaded=true;content.replaceChildren(el("p",{className:"muted small",text:"正在读取工具详情…"}));
    const epoch=cs.epoch;
    try{const d=toolCache.get(tool.id)||await readApi(C.ToolDetail,"GET","/admin/tools/"+encodeURIComponent(tool.id));if(epoch!==cs.epoch||!box.isConnected)return;if(d.status!=="running")toolCache.set(tool.id,d);content.replaceChildren(toolPayload(d));}
    catch(error){loaded=false;content.replaceChildren(el("p",{text:"读取失败，折叠后可重试。"}));fail(error);}
  });return box;
}
export function turnTrace(turnId:string){
  const requests=[...cs.requests.values()].filter(r=>r.binding?.turnId===turnId).sort((a,b)=>a.startedAt-b.startedAt),tools=[...cs.tools.values()].filter(t=>t.binding.turnId===turnId).sort((a,b)=>a.startedAt-b.startedAt);
  if(!requests.length&&!tools.length)return el("div",{className:"trace-unknown",text:"本轮暂无执行记录；旧回合可能未采集关联。"});
  type Entry={kind:"request";at:number;value:C.RequestRecord}|{kind:"tool";at:number;value:C.ToolSummary};
  const entries=[...requests.map<Entry>(r=>({kind:"request",at:r.startedAt,value:r})),...tools.map<Entry>(t=>({kind:"tool",at:t.startedAt,value:t}))].sort((a,b)=>a.at-b.at);
  const active=entries.some(e=>e.value.status==="running");
  return el("section",{className:"trace-turn","data-turn":turnId},[
    el("div",{className:"trace-heading"},[el("span",{text:(active?"本轮执行中":"本轮执行记录")+" · "+requests.length+" 次模型请求 · "+tools.length+" 次工具调用"}),el("button",{className:"request-link",type:"button",text:"本轮请求",onclick:()=>showTurnRequests(turnId)})]),
    ...entries.map(entry=>{
      if(entry.kind==="tool")return renderToolTrace(entry.value);
      const r=entry.value;
      return el("button",{className:"trace-request",type:"button",onclick:()=>openRequest(r.id)},[
        el("span",{},[r.model+" · "+(statuses[r.status]||r.status),el("small",{text:"输入 "+nf(r.inputTokens)+" / 输出 "+nf(r.outputTokens)})]),
        el("span",{},["缓存 "+percent(cacheRate(r)),el("small",{text:duration(r.durationMs)})])
      ]);
    })]);
}
export function showTurnRequests(turnId:string){
  const requests=[...cs.requests.values()].filter(r=>r.binding?.turnId===turnId);cs.turn=turnId;cs.until=Date.now();cs.before=undefined;cs.pages=[];
  if(requests.length&&Math.min(...requests.map(r=>r.startedAt))<cs.until-86400000)$("req-range").value="720";
  $("req-thread").value=cs.chat.thread;$("req-model").value="";$("req-status").value="";$("req-purpose").value="";consoleView("usage");
}
export function renderChatMessages(messages:C.ChatMessage[]){
  const list=$("chat-messages"),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<100,first=!list.querySelector(".chat-message"),expanded=new Set([...list.querySelectorAll<HTMLDetailsElement>("details[data-tool][open]")].map(n=>n.dataset.tool)),seen=new Set<string>();
  const content: HTMLElement[]=[];
  for(const m of messages){
    const message=el("article",{className:"chat-message "+m.role},[el("div",{className:"message-meta",text:(m.role==="assistant"?"助手":m.name||"用户")+" · "+(m.source==="web"?"网页":"QQ")+" · "+bjTime(m.at)+(m.status?" · "+(statuses[m.status]||m.status):"")}),el("div",{className:"message-text",text:m.text}),...(m.assets||[]).map(ref=>el("button",{className:"btn",text:ref.name+" · "+bytes(ref.bytes),onclick:()=>downloadAsset(ref)}))]);
    if(m.turnId&&!seen.has(m.turnId)&&m.role==="assistant"){seen.add(m.turnId);content.push(turnTrace(m.turnId));}
    content.push(message);
    if(m.turnId&&!seen.has(m.turnId)&&m.role==="user"){seen.add(m.turnId);content.push(turnTrace(m.turnId));}
  }
  list.replaceChildren(...content);
  if(!messages.length)list.append(el("div",{className:"empty-state"},[el("strong",{text:"从这里继续对话"}),"网页发言会进入当前会话，QQ 里的上下文仍然保留。"]));
  for(const node of list.querySelectorAll<HTMLDetailsElement>("details[data-tool]"))if(expanded.has(node.dataset.tool))node.open=true;
  if(cs.locateTurn){const target=[...list.querySelectorAll<HTMLElement>("section[data-turn]")].find(n=>n.dataset.turn===cs.locateTurn);if(target){target.scrollIntoView({block:"nearest"});cs.locateTurn=null;}}
  else if(nearBottom||first)list.scrollTop=list.scrollHeight;
}
export async function loadChat(){
  if(cs.chat.kind==="subagent")return loadSubagentChat();
  if(cs.chatLoading)return;cs.chatLoading=true;
  loadTopology();
  const thread=cs.chat.thread,version=++cs.chatVersion,epoch=cs.epoch,p=new URLSearchParams();
  if(cs.chatAfter!==null){p.set("after",String(cs.chatAfter));for(const m of cs.messages.values())if(m.status==="queued")p.append("pending",m.id);}
  try{
    const d=await readApi(C.ChatView,"GET","/admin/threads/"+encodeURIComponent(thread)+"/chat"+(p.size?"?"+p:""));
    if((cs.chat.kind!=="thread"||thread!==cs.chat.thread)||version!==cs.chatVersion||epoch!==cs.epoch)return;
    if(!d.delta)cs.messages.clear();d.messages.forEach(m=>cs.messages.set(m.id,m));
    const messages=[...cs.messages.values()].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)).slice(-100);cs.messages=new Map(messages.map(m=>[m.id,m]));
    cs.chatAfter=messages.at(-1)?.at??null;
    await fetchTrace(thread,messages,version,epoch);
    if((cs.chat.kind!=="thread"||thread!==cs.chat.thread)||version!==cs.chatVersion||epoch!==cs.epoch)return;
    if(cs.awaitingInput&&cs.messages.has(cs.awaitingInput)&&cs.messages.get(cs.awaitingInput)?.status!=="queued")cs.awaitingInput=null;
    cs.chatActive=!!cs.awaitingInput||!!d.active||[...cs.requests.values(),...cs.tools.values()].some(r=>r.status==="running");
    $("chat-title").textContent=(state.overview&&state.overview.threads.find(t=>t.key===thread)?.name)||thread;
    $("chat-state").textContent=cs.pending?"上次发送结果未确认，重试沿用原编号。":cs.chatActive?"本轮执行中，正在增量更新…":"回复仅显示网页。空闲时停止自动刷新，点击刷新查看 QQ 新消息。";
    if(d.syncedAt)$("chat-state").textContent+=" · 数据同步于 "+time(d.syncedAt);
    const fingerprint=JSON.stringify([messages,[...cs.requests.values()],[...cs.tools.values()]]);
    if(fingerprint!==cs.fingerprint){if(cs.fingerprint)refreshTopologyAfterTurn();cs.fingerprint=fingerprint;renderChatMessages(messages);if($("request-detail").open&&cs.detailId&&!detailCache.has(cs.detailId))openRequest(cs.detailId);}
    void refreshContextMonitor();
  }finally{if(version===cs.chatVersion){cs.chatLoading=false;scheduleConsolePoll();}}
}

export function initTrace() {
  document.addEventListener("visibilitychange",()=>{clearTimeout(cs.timer);if(!document.hidden){if(cs.view==="chat"&&cs.chatActive)loadChat().catch(fail);else scheduleConsolePoll();}});
}
