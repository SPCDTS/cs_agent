import { openExecutions } from "./executions";
import { chatCard } from "./chat-cards";
import { refreshContextMonitor } from "./context-monitor";
import { cs, downloadAsset, loadUsage, statuses } from "./console";
import { $, el, fail, readToken, state, time } from "./app";
import * as C from "./request-contracts";
import { readApi } from "./api";
import { loadTopology, refreshTopologyAfterTurn } from "./topology";
import { loadSubagentChat, resetSubagentChat } from "./subagent-chat";
export function resetChatTrace(){resetSubagentChat();cs.fingerprint="";cs.messages.clear();cs.progress.clear();cs.chatAfter=null;cs.chatRevision=undefined;cs.chatActive=false;cs.chatLoading=false;cs.awaitingInput=null;}
export function scheduleConsolePoll(){
  clearTimeout(cs.timer);cs.timer=undefined;
  if(document.hidden||!readToken())return;
  if(cs.view==="chat"&&cs.chatActive)cs.timer=setTimeout(()=>loadChat().catch(fail),2500);
  if(cs.view==="usage"&&cs.requestActive)cs.timer=setTimeout(()=>{cs.until=Date.now();loadUsage().catch(fail);},5000);
}
async function fetchProgress(thread: string, messages: C.ChatMessage[]) {
  const params = new URLSearchParams();
  for (const turn of new Set(messages.map(m => m.turnId))) if (turn) params.append("turn", turn);
  return params.size ? readApi(C.ChatProgress, "GET", "/admin/threads/" + encodeURIComponent(thread) + "/progress?" + params) : [];
}
export function renderTurnSteps(steps: readonly C.StepItem[], active: boolean): HTMLElement | null {
  if (!steps.length) return null;
  const completed = steps.filter(s => s.status === "done" || s.status === "skipped").length;
  const hasFailed = steps.some(s => s.status === "failed");
  const statusText = hasFailed ? "存在失败步骤" : completed === steps.length ? "已完成" : active ? "执行中" : "等待继续";
  return el("div", { className: "trace-steps", role: "group", "aria-label": "步骤进度 " + completed + "/" + steps.length }, [
    el("div", { className: "trace-steps-head" }, [
      el("span", { className: "trace-steps-count", text: completed + "/" + steps.length + " steps" }),
      el("span", { className: "trace-steps-state", text: statusText }),
    ]),
    el("ul", { className: "trace-steps-list" }, steps.map(step => {
      const paused = step.status === "in_progress" && !active;
      const stateClass = paused ? "paused" : step.status;
      const icon = step.status === "done" ? "✓"
        : step.status === "failed" ? "✕"
        : step.status === "skipped" ? "–"
        : paused ? "‖"
        : step.status === "in_progress" ? "●" : "";
      return el("li", { className: "trace-step is-" + stateClass }, [
        el("span", { className: "trace-step-icon", "aria-hidden": "true", text: icon }),
        el("span", { className: "trace-step-title", text: step.title }),
      ]);
    })),
  ]);
}
function turnActions(turnId: string) {
  const progress = cs.progress.get(turnId);
  return el("section", {className:"trace-turn", "data-turn":turnId}, [
    progress ? renderTurnSteps(progress.steps, progress.active) : null,
    el("button", {className:"request-link",type:"button",text:"查看本轮执行链路",
      onclick:()=>openExecutions({thread:cs.chat.thread,turn:turnId})}),
  ]);
}
const chatStatus: Record<string,string> = {...statuses,accepted:"对端已入箱（非已读）",duplicate:"对端已入箱（重复投递）",unconfirmed:"未确认入箱",waiting:"等待进入模型"};
export function renderChatMessages(messages:C.ChatMessage[]){
  const list=$("chat-messages"),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<100,first=!list.querySelector(".chat-message"),seen=new Set<string>();
  const expanded = new Set([...list.querySelectorAll<HTMLDetailsElement>("details[data-entry][open]")].map(node => node.dataset.entry));
  const focused = document.activeElement?.matches("#chat-messages details[data-entry] > summary")
    ? document.activeElement.parentElement?.dataset.entry : undefined;
  const content: HTMLElement[]=[];
  for(const m of messages){
    const message=chatCard(m, m.status ? chatStatus[m.status] || m.status : "", downloadAsset, expanded.has(m.id));
    if(m.turnId&&!seen.has(m.turnId)&&m.role==="assistant"){seen.add(m.turnId);content.push(turnActions(m.turnId));}
    content.push(message);
    if(m.turnId&&!seen.has(m.turnId)&&m.role==="user"){seen.add(m.turnId);content.push(turnActions(m.turnId));}
  }
  list.replaceChildren(...content);
  if (focused) list.querySelector<HTMLElement>("details[data-entry=" + CSS.escape(focused) + "] > summary")?.focus({ preventScroll: true });
  if(!messages.length)list.append(el("div",{className:"empty-state"},[el("strong",{text:"从这里继续对话"}),"网页发言会进入当前会话，QQ 里的上下文仍然保留。"]));
  if(cs.locateTurn){const target=[...list.querySelectorAll<HTMLElement>("section[data-turn]")].find(n=>n.dataset.turn===cs.locateTurn);if(target){target.scrollIntoView({block:"nearest"});cs.locateTurn=null;}}
  else if(nearBottom||first)list.scrollTop=list.scrollHeight;
}
export async function loadChat(){
  if(cs.chat.kind==="subagent")return loadSubagentChat();
  if(cs.chatLoading)return;cs.chatLoading=true;
  loadTopology();
  const thread=cs.chat.thread,version=++cs.chatVersion,epoch=cs.epoch,p=new URLSearchParams();
  if(cs.chatAfter!==null){p.set("after",String(cs.chatAfter));if(cs.chatRevision!==undefined)p.set("revision",String(cs.chatRevision));for(const m of cs.messages.values())if(m.status==="queued"||m.status==="waiting")p.append("pending",m.id);}
  try{
    const d=await readApi(C.ChatView,"GET","/admin/threads/"+encodeURIComponent(thread)+"/chat"+(p.size?"?"+p:""));
    if((cs.chat.kind!=="thread"||thread!==cs.chat.thread)||version!==cs.chatVersion||epoch!==cs.epoch)return;
    cs.chatRevision=d.revision;
    if(!d.delta)cs.messages.clear();d.messages.forEach(m=>cs.messages.set(m.id,m));
    const messages=[...cs.messages.values()].sort((a,b)=>a.at-b.at||(a.id<b.id?-1:a.id>b.id?1:0)).slice(-100);cs.messages=new Map(messages.map(m=>[m.id,m]));
    cs.chatAfter=messages.at(-1)?.at??null;
    const progress = await fetchProgress(thread,messages).catch(()=>null);
    if((cs.chat.kind!=="thread"||thread!==cs.chat.thread)||version!==cs.chatVersion||epoch!==cs.epoch)return;
    cs.progress=new Map((progress ?? []).map(row=>[row.turnId,row]));
    if(cs.awaitingInput&&cs.messages.has(cs.awaitingInput)&&cs.messages.get(cs.awaitingInput)?.status!=="queued")cs.awaitingInput=null;
    cs.chatActive=!!cs.awaitingInput||!!d.active||[...cs.progress.values()].some(r=>r.active);
    $("chat-title").textContent=(state.overview&&state.overview.threads.find(t=>t.key===thread)?.name)||thread;
    $("chat-state").textContent=cs.pending?"上次发送结果未确认，重试沿用原编号。":cs.chatActive?"本轮执行中，正在增量更新…":"回复仅显示网页。空闲时停止自动刷新，点击刷新查看新消息。";
    if(progress===null)$("chat-state").textContent+=" · 步骤进度暂不可用";
    if(d.syncedAt)$("chat-state").textContent+=" · 数据同步于 "+time(d.syncedAt);
    const fingerprint=JSON.stringify([messages,progress]);
    if(fingerprint!==cs.fingerprint){if(cs.fingerprint)refreshTopologyAfterTurn();cs.fingerprint=fingerprint;renderChatMessages(messages);}
    void refreshContextMonitor();
  }finally{if(version===cs.chatVersion){cs.chatLoading=false;scheduleConsolePoll();}}
}

export function initTrace() {
  document.addEventListener("visibilitychange",()=>{clearTimeout(cs.timer);if(!document.hidden){if(cs.view==="chat"&&cs.chatActive)loadChat().catch(fail);else scheduleConsolePoll();}});
}
