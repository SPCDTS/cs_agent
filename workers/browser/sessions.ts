import { cs } from "./console";
import { $, api, el, fail, notice, time } from "./app";
import { readApi } from "./api";
import { SessionHistorySchema } from "./history-contracts";
type HistoryTarget = {kind:"thread";thread:string} | {kind:"subagent";thread:string;id:string};
export const sh: {target:HistoryTarget;next:string|undefined;version:number} = { target:{kind:"thread",thread:"owner"}, next:undefined, version:0 };
export function openHistory(target: HistoryTarget) {
  sh.target=target;sh.next=undefined;
  $("session-history-title").textContent=target.kind==="subagent"?"子 agent 会话":"会话历史与归档";
  $("session-history-scope").textContent=target.thread+(target.kind==="subagent"?" / "+target.id:"");
  $("session-history").showModal();
  void sessionHistory(false);
}
export async function sessionHistory(older:boolean){
  const version=++sh.version, epoch=cs.epoch, target=sh.target;
  if(!older){sh.next=undefined;$("session-history-body").replaceChildren(el("div",{className:"empty-state",text:"正在载入会话…"}));}
  $("session-history-older").disabled=true;
  const query=new URLSearchParams();
  if(older&&sh.next)query.set("cursor",sh.next);
  if(target.kind==="subagent")query.set("thread",target.thread);
  const path=target.kind==="subagent"?"/admin/subagents/"+encodeURIComponent(target.id):"/admin/threads/"+encodeURIComponent(target.thread);
  try{
    const view=await readApi(SessionHistorySchema,"GET",path+"/history?"+query);
    if(version!==sh.version||epoch!==cs.epoch)return;
    const rows=view.entries.map(entry=>{
      if(entry.reset)return el("section",{className:"context-item"},[el("h3",{text:"已归档 · "+(entry.archive&&entry.archive.label||"上下文重置")}),el("small",{text:entry.archive?time(entry.archive.at):""})]);
      return el("details",{className:"context-item",open:target.kind==="subagent"&&entry.messages.some(m=>m.role==="user"||m.role==="assistant")},[el("summary",{text:"#"+entry.id+" · "+entry.kind+" · "+entry.messages.map(m=>m.toolName||m.role).join(" / ")}),
        ...entry.messages.map(m=>el("pre",{className:"context-text",text:m.text||"(无文本内容)"}))]);
    });
    if(!older&&!rows.length)rows.push(el("div",{className:"empty-state",text:"这个会话还没有模型历史"}));
    if(!older)$("session-history-body").replaceChildren();
    $("session-history-body").append(...rows);sh.next=view.next;
    $("session-history-older").disabled=!sh.next;
  }catch(error){
    if(version!==sh.version||epoch!==cs.epoch)return;
    if(!older)$("session-history-body").replaceChildren(el("div",{className:"empty-state",text:"会话载入失败，请点击刷新重试。"}));
    $("session-history-older").disabled=!sh.next;
    fail(error);
  }
}
export async function compactChat(){
  $("chat-compact").disabled=true;
  try{await api("POST","/admin/threads/"+encodeURIComponent(cs.chat)+"/compact",{});notice("已开始压缩上下文，原始记录仍保留");}
  catch(error){fail(error);}finally{$("chat-compact").disabled=false;}
}
export async function resetChat(){
  const thread=cs.chat;
  if(!confirm("归档并重置 "+thread+" 的模型上下文？聊天记录、长期记忆和工作区文件会保留，正在运行的子任务会取消。"))return;
  $("chat-reset").disabled=true;
  try{await api("POST","/admin/threads/"+encodeURIComponent(thread)+"/reset",{requestId:crypto.randomUUID(),label:"手动归档 "+new Date().toLocaleString("zh-CN")});notice("已归档，下一条消息使用新的模型上下文");}
  catch(error){fail(error);}finally{$("chat-reset").disabled=false;}
}

export function initSessions() {
  $("chat-history").addEventListener("click",()=>openHistory({kind:"thread",thread:cs.chat}));
  $("chat-compact").addEventListener("click",compactChat);
  $("chat-reset").addEventListener("click",resetChat);
  $("session-history-close").addEventListener("click",()=>{$("session-history").close();});
  $("session-history").addEventListener("close",()=>{sh.version++;});
  $("session-history-refresh").addEventListener("click",()=>sessionHistory(false));
  $("session-history-older").addEventListener("click",()=>sessionHistory(true));
}
