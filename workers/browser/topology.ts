import { $, ApiError, el, fail, readToken, state } from "./app";
import { cs, sv, chooseChat, chooseSubagent } from "./console";
import { readApi } from "./api";
import { AgentTopologySchema, type AgentNode, type AgentTopology } from "./topology-contracts";
import { topologyFamilies } from "./topology-layout";
import { refreshChatChildren } from "./chat-navigation";
export const topology:{data:AgentTopology|null;timer:ReturnType<typeof setTimeout>|undefined;version:number;pending:boolean;structure:string;inViewport:boolean}={data:null,timer:undefined,version:0,pending:false,structure:"",inViewport:true};
export const topologyStatus={active:"执行中",recent:"近期活动",error:"最近异常",context:"父 agent"};
export const topologyLifecycle={running:"执行中",done:"已完成",failed:"失败",cancelled:"已取消"};
export function stopTopology(){clearTimeout(topology.timer);topology.timer=undefined;topology.version++;topology.pending=false;}
export function resetTopology(){stopTopology();topology.data=null;topology.structure="";$("topology-graph").replaceChildren();$("topology-count").textContent="进入页面后加载";}
export function scheduleTopology(){
  clearTimeout(topology.timer);topology.timer=undefined;
  if(cs.view==="chat"&&!document.hidden&&topology.inViewport&&topology.data?.nodes.some(n=>n.activity==="active"))topology.timer=setTimeout(()=>loadTopology(true),10000);
}
export function refreshTopologyAfterTurn(){
  if(cs.view!=="chat"||document.hidden||!topology.inViewport)return;
  clearTimeout(topology.timer);topology.timer=setTimeout(()=>loadTopology(true),Math.max(0,10000-(Date.now()-(topology.data?.sampledAt||0))));
}
export async function loadTopology(force=false,instant=false){
  if(cs.view!=="chat"||document.hidden||!readToken()||topology.pending)return;
  if(!force&&!topology.inViewport&&topology.data)return;
  if(!force&&topology.data&&Date.now()-topology.data.sampledAt<10000)return;
  const version=++topology.version,epoch=cs.epoch;topology.pending=true;
  try{
    const data=await readApi(AgentTopologySchema,"GET","/admin/agent-topology");
    if(version!==topology.version||epoch!==cs.epoch||cs.view!=="chat"||document.hidden)return;
    topology.data=data;renderTopology(instant);refreshChatChildren();
  }catch(error){if(version===topology.version){$("topology-count").textContent="拓扑读取失败，点击刷新重试";if(!topology.data)$("topology-graph").replaceChildren(el("p",{className:"topology-empty",text:"暂时无法读取近期活动"}));}if(error instanceof ApiError&&error.status===401)fail(error);}
  finally{if(version===topology.version){topology.pending=false;scheduleTopology();}}
}
export function topologyName(node:AgentNode){
  if(node.kind==="subagent")return "子 agent "+node.actor.slice(0,6);
  return state.overview?.threads.find(t=>t.key===node.thread)?.name||(node.thread==="owner"?"主人会话":node.thread);
}
export function topologyCard(node:AgentNode){
  const orb=el("div",{className:"topology-orb","aria-hidden":"true"},[el("div",{className:"topology-glass"}),el("div",{className:"topology-core"}),el("div",{className:"topology-rim"}),el("div",{className:"topology-orbit"},[el("i")])]);
  return el("button",{className:"topology-node","data-agent":node.id,"data-kind":node.kind,type:"button",title:"查看对应会话",onclick:()=>{
    if(node.kind==="subagent")chooseSubagent(node.thread,node.actor,node.summary||"");
    else {chooseChat(node.thread);$("chat-title").scrollIntoView({block:"nearest"});}
  }},[orb,el("div",{className:"topology-copy"},[el("div",{className:"topology-name"}),el("div",{className:"topology-description"},[el("span",{className:"visible"}),el("span",{"aria-hidden":"true"})]),el("div",{className:"topology-state"})])]);
}
export function updateTopologyCard(card:HTMLElement,node:AgentNode){
  const name=topologyName(node),status=(node.kind==="subagent"&&node.status?topologyLifecycle[node.status]:undefined)||topologyStatus[node.activity],text=node.kind==="subagent"?(node.description?.text||node.summary||"暂无任务简介"):"";
  const selected=node.thread===cs.chat.thread&&(node.kind==="thread"?cs.chat.kind==="thread":cs.chat.kind==="subagent"&&node.actor===cs.chat.id);
  card.dataset.activity=node.activity;card.dataset.current=String(selected);
  card.querySelector<HTMLElement>(".topology-name")!.textContent=name;card.querySelector<HTMLElement>(".topology-name")!.title=name;
  card.querySelector(".topology-state")!.textContent=(selected?"当前会话 · ":"")+status;
  const description=card.querySelector<HTMLElement>(".topology-description")!,current=description.querySelector(".visible")!,next=[...description.children].find(s=>s!==current)!;
  if(current.textContent!==text){next.textContent=text;next.classList.add("visible");next.removeAttribute("aria-hidden");current.classList.remove("visible");current.setAttribute("aria-hidden","true");}
  description.title=(node.kind==="subagent"&&node.summary&&node.summary!==text?"任务："+node.summary+"\n":"")+text;
  card.setAttribute("aria-label",name+" · "+status+(text?" · "+text:"")+" · 查看会话");
}
export function drawTopologyLinks(){
  const scene=$("topology-graph").querySelector(".topology-scene");if(!scene)return;
  const box=scene.getBoundingClientRect(),svg=scene.querySelector("svg")!;svg.setAttribute("viewBox","0 0 "+box.width+" "+box.height);
  for(const family of scene.querySelectorAll(".topology-family")){
    const parent=family.querySelector(".topology-parent .topology-node")!,a=parent.querySelector(".topology-orb")!.getBoundingClientRect();
    for(const child of family.querySelectorAll<HTMLElement>(".topology-children .topology-node")){
      const b=child.querySelector(".topology-orb")!.getBoundingClientRect(),x1=a.left+a.width/2-box.left,y1=a.bottom-box.top+8,x2=b.left+b.width/2-box.left,y2=b.top-box.top-8;
      const path=[...svg.querySelectorAll<SVGPathElement>(".topology-link")].find(p=>p.dataset.child===child.dataset.agent);
      if(path)path.setAttribute("d","M "+x1+" "+y1+" V "+(y2-10)+" H "+x2+" V "+y2);
    }
  }
}
export function renderTopology(instant=false){
  if(!topology.data||cs.view!=="chat")return;
  const host=$("topology-graph"),nodes=topology.data.nodes,visible=topologyFamilies(nodes);
  const active=nodes.filter(n=>n.activity==="active").length,recent=nodes.filter(n=>n.activity!=="context").length;
  $("topology-count").textContent=recent+" 个近期活跃"+(active?" · "+active+" 个执行中":"");
  if(!visible.length){topology.structure="";host.replaceChildren(el("p",{className:"topology-empty",text:"最近 24 小时还没有 agent 活动"}));return;}
  const structure=JSON.stringify(visible.map(g=>[g.parent.id,g.children.map(c=>c.id)]));
  if(structure!==topology.structure){
    const previous=new Map([...host.querySelectorAll<HTMLElement>("[data-agent]")].map(n=>[n.dataset.agent,n]));
    const scene=el("div",{className:"topology-scene","data-instant":String(instant)}),svg=sv("svg",{class:"topology-connections","aria-hidden":"true"}),defs=sv("defs"),marker=sv("marker",{id:"topology-arrow",viewBox:"0 0 10 10",refX:8,refY:5,markerWidth:6,markerHeight:6,orient:"auto"});
    marker.append(sv("path",{d:"M2 2 L8 5 L2 8",fill:"none",stroke:"currentColor","stroke-width":1.3}));defs.append(marker);svg.append(defs);scene.append(svg);
    let entered=0;
    for(const family of visible){
      const group=el("div",{className:"topology-family"}),parent=el("div",{className:"topology-parent"}),children=el("div",{className:"topology-children"});
      for(const node of [family.parent,...family.children]){
        const card=previous.get(node.id)||topologyCard(node);updateTopologyCard(card,node);
        if(!previous.has(node.id)&&previous.size&&node.kind==="subagent"&&!instant){card.dataset.entering="true";card.style.transitionDelay=Math.min(entered++,2)*50+"ms";requestAnimationFrame(()=>requestAnimationFrame(()=>{card.dataset.entering="false";setTimeout(drawTopologyLinks,350);}));}
        (node.kind==="thread"?parent:children).append(card);
        if(node.kind==="subagent")svg.append(sv("path",{class:"topology-link","data-parent":node.parentId,"data-child":node.id,"marker-end":"url(#topology-arrow)"}));
      }
      group.append(parent,children);scene.append(group);
    }
    host.replaceChildren(scene);topology.structure=structure;
  }else{
    host.querySelector<HTMLElement>(".topology-scene")!.dataset.instant=String(instant);
    const cards=new Map([...host.querySelectorAll<HTMLElement>("[data-agent]")].map(card=>[card.dataset.agent,card]));
    for(const family of visible)for(const node of [family.parent,...family.children])updateTopologyCard(cards.get(node.id)!,node);
  }
  drawTopologyLinks();
}

export function initTopology() {
  $("topology-refresh").addEventListener("click",e=>loadTopology(true,e.detail===0));
  new ResizeObserver(()=>renderTopology(true)).observe($("topology-graph"));
  new IntersectionObserver(entries=>{topology.inViewport=entries[0].isIntersecting;$("agent-topology").classList.toggle("topology-paused",!topology.inViewport||document.hidden);if(topology.inViewport)loadTopology();scheduleTopology();}).observe($("agent-topology"));
  document.addEventListener("visibilitychange",()=>{$("agent-topology").classList.toggle("topology-paused",document.hidden||!topology.inViewport);if(document.hidden)stopTopology();else if(cs.view==="chat")loadTopology(true);});
}
