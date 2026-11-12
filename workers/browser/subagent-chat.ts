import { refreshContextMonitor } from "./context-monitor";
import { $, el, fail, bjTime, pill, time } from "./app";
import { cs, renderChatHeader } from "./console";
import { readApi } from "./api";
import { SubagentConversationSchema, type SubagentConversation } from "./history-contracts";
import { scheduleConsolePoll } from "./trace";
import { refreshChatChildren } from "./chat-navigation";

type Entry=SubagentConversation["entries"][number];
const entries=new Map<number,Entry>();
let next:string|undefined;
export function resetSubagentChat(){entries.clear();next=undefined;}
const lifecycle={running:"执行中",done:"已完成",failed:"失败",cancelled:"已取消"};
export async function loadSubagentChat(older=false){
  const target=cs.chat;
  if(target.kind!=="subagent"||cs.chatLoading||older&&!next)return;
  cs.chatLoading=true;$("chat-older").disabled=true;
  const version=++cs.chatVersion,epoch=cs.epoch,newest=Math.max(0,...entries.keys());
  const valid=()=>cs.chat===target&&version===cs.chatVersion&&epoch===cs.epoch;
  const get=async(cursor?:string)=>{
    const query=new URLSearchParams({thread:target.thread});if(cursor)query.set("cursor",cursor);
    return readApi(SubagentConversationSchema,"GET","/admin/subagents/"+encodeURIComponent(target.id)+"/history?"+query);
  };
  try{
    const first=await get(older?next:undefined);if(!valid())return;
    const loaded=[...first.entries];
    let page=first;
    // 运行期间一次产生多页消息时，补齐到已显示的边界，避免刷新跳过中间记录。
    while(!older&&newest&&page.next&&page.entries.length&&page.entries.every(entry=>entry.id>newest)){
      page=await get(page.next);if(!valid())return;loaded.push(...page.entries);
    }
    if(older||!newest)next=first.next;
    for(const entry of loaded)entries.set(entry.id,entry);
    target.summary=first.summary;cs.chatActive=first.status==="running";renderChatHeader();refreshChatChildren();
    $("chat-state").textContent=lifecycle[first.status]+(cs.chatActive?"，正在自动更新…":"")+" · 数据同步于 "+time(first.syncedAt);
    $("chat-older").disabled=!next;
    const fingerprint=JSON.stringify([...entries.values()].sort((a,b)=>a.id-b.id));
    if(fingerprint!==cs.fingerprint){cs.fingerprint=fingerprint;renderSubagentMessages(older);}
    void refreshContextMonitor();
  }catch(error){
    if(!valid())return;
    cs.chatActive=false;$("chat-state").textContent="子会话读取失败，请点击刷新重试。";$("chat-older").disabled=!next;fail(error);
  }finally{if(valid()){cs.chatLoading=false;scheduleConsolePoll();}}
}
function renderSubagentMessages(older:boolean){
  const host=$("chat-messages"),height=host.scrollHeight,top=host.scrollTop,atBottom=height-top-host.clientHeight<100;
  const open=new Set([...host.querySelectorAll<HTMLDetailsElement>("details[data-entry][open]")].map(node=>node.dataset.entry));
  const rows:HTMLElement[]=[];
  const detail=(key:string,title:string,text:string,error=false)=>{
    const node=el("details",{className:"message-block trace-tool","data-entry":key,open:open.has(key)},[
      el("summary",{},[el("strong",{text:title}),error?pill("失败","bad"):null]),
      el("pre",{className:"context-text",text:text||"(无文本内容)"}),
    ]);rows.push(node);
  };
  for(const entry of [...entries.values()].sort((a,b)=>a.id-b.id)){
    if(entry.reset){rows.push(el("div",{className:"trace-unknown",text:"已归档 · "+(entry.archive?.label||"上下文重置")}));continue;}
    entry.messages.forEach((message,index)=>{
      const key=entry.id+":"+index;
      if(message.role==="toolResult"||message.role==="system"){
        detail(key,message.toolName||"会话上下文",message.text,message.isError);return;
      }
      if(message.text){
        rows.push(el("article",{className:"chat-message "+(message.role==="user"?"user":"assistant")},[
          el("div",{className:"message-meta",text:(message.role==="user"?"任务 / 跟进":"子 agent")+(message.at?" · "+bjTime(message.at):"")}),
          el("div",{className:"message-text",text:message.text}),
        ]));
      }
      for(const tool of message.toolCalls??[])detail(key+":"+tool.id,tool.name+" · 调用参数",tool.arguments);
    });
  }
  if(!rows.length)rows.push(el("div",{className:"empty-state",text:"这个子 agent 还没有会话记录"}));
  host.replaceChildren(...rows);
  if(older)host.scrollTop=top+host.scrollHeight-height;
  else if(atBottom||!height)host.scrollTop=host.scrollHeight;
}
