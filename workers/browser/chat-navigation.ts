import { $, el, state, SUBAGENT_STATUS } from "./app";
import { cs, chooseChat, chooseSubagent } from "./console";
import { readApi } from "./api";
import { Subagents, type Overview } from "./app-contracts";
import { chatChildren } from "./chat-navigation-layout";

type Children = {kind:"loading"} | {kind:"ready";items:Subagents;at:number} | {kind:"error"};
const children=new Map<string,Children>(),expanded=new Set<string>(),pending=new Set<string>(),showAll=new Set<string>();
export function resetChatNavigation(){children.clear();expanded.clear();pending.clear();showAll.clear();}
export function expandChatThread(thread:string){expanded.add(thread);}
export async function loadChatChildren(thread:string,force=false){
  const current=children.get(thread);
  if(pending.has(thread)||!force&&current?.kind==="ready"&&Date.now()-current.at<10000)return;
  const epoch=cs.epoch;pending.add(thread);
  if(current?.kind!=="ready"){children.set(thread,{kind:"loading"});renderChatNavigation();}
  try{
    const items=await readApi(Subagents,"GET","/admin/threads/"+encodeURIComponent(thread)+"/subagents");
    if(epoch!==cs.epoch)return;
    children.set(thread,{kind:"ready",items,at:Date.now()});
  }catch{if(epoch===cs.epoch)children.set(thread,{kind:"error"});}
  if(epoch===cs.epoch){pending.delete(thread);renderChatNavigation();}
}
export function refreshChatChildren(){
  if(cs.view!=="chat")return;
  for(const thread of expanded)void loadChatChildren(thread);
}
export function renderChatNavigation(threads: Pick<Overview["threads"][number],"key"|"name">[]=state.overview?.threads??[{key:"owner",name:"主人会话"}]){
  const host=$("chat-thread-list"),focused=document.activeElement;
  const focusKey=focused instanceof HTMLElement&&host.contains(focused)?focused.dataset.nav:undefined;
  const list=el("ul",{className:"chat-tree","aria-label":"会话与子 agent"});
  for(const thread of threads){
    const cached=children.get(thread.key),selected=cs.chat.thread===thread.key;
    const parent=el("button",{className:"chat-thread",type:"button","data-nav":"thread:"+thread.key,"aria-current":String(selected&&cs.chat.kind==="thread"),onclick:()=>chooseChat(thread.key)},[
      el("span",{text:thread.name||(thread.key==="owner"?"主人会话":thread.key)}),el("small",{text:thread.key}),
    ]);
    const details=el("details",{className:"chat-children",open:expanded.has(thread.key)}),nested=el("ul");
    const count=cached?.kind==="ready"?"（"+cached.items.length+"）":"";
    details.append(el("summary",{"data-nav":"children:"+thread.key,text:"子 agent"+count}),nested);
    if(cached?.kind==="ready"){
      const preview=chatChildren(cached.items,Date.now(),selected&&cs.chat.kind==="subagent"?cs.chat.id:undefined,showAll.has(thread.key));
      for(const child of preview.items){
        nested.append(el("li",{},[el("button",{className:"chat-thread chat-child",type:"button","data-nav":"subagent:"+child.id,"aria-current":String(selected&&cs.chat.kind==="subagent"&&cs.chat.id===child.id),
          title:child.task,onclick:()=>chooseSubagent(thread.key,child.id,child.summary)},[
          el("span",{text:child.summary||child.task}),el("small",{text:child.id.slice(0,6)+" · "+(SUBAGENT_STATUS[child.status]?.[0]||child.status)}),
        ])]));
      }
      if(!preview.items.length)nested.append(el("li",{className:"chat-tree-note",text:cached.items.length?"暂无近期活动":"暂无子 agent"}));
      if(preview.hidden)nested.append(el("li",{},[el("button",{className:"chat-show-more",type:"button","data-nav":"more:"+thread.key,
        "aria-expanded":String(showAll.has(thread.key)),text:showAll.has(thread.key)?"收起":"展开显示（"+preview.hidden+"）",
        onclick:()=>{if(showAll.has(thread.key))showAll.delete(thread.key);else showAll.add(thread.key);renderChatNavigation();}
      })]));
    }else if(cached?.kind==="error"){
      nested.append(el("li",{},[el("button",{className:"btn compact",type:"button","data-nav":"retry:"+thread.key,text:"重新加载子 agent",onclick:()=>loadChatChildren(thread.key,true)})]));
    }else nested.append(el("li",{className:"chat-tree-note",text:"加载中…"}));
    details.addEventListener("toggle",()=>{
      if(!details.isConnected)return;
      if(details.open){expanded.add(thread.key);if(!children.has(thread.key))void loadChatChildren(thread.key);}
      else expanded.delete(thread.key);
    });
    list.append(el("li",{className:"chat-family"},[parent,details]));
  }
  host.replaceChildren(list);
  if(focusKey)list.querySelector<HTMLElement>('[data-nav="'+CSS.escape(focusKey)+'"]')?.focus({preventScroll:true});
  for(const thread of threads)if(expanded.has(thread.key)&&!children.has(thread.key))void loadChatChildren(thread.key);
}
