import { $, ApiError, el, fail, readToken, state } from "./app";
import { cs, sv } from "./console";
import { readApi } from "./api";
import { AgentTopologySchema, type AgentNode, type AgentTopology, type AgentFamily } from "./topology-contracts";
export const topology:{data:AgentTopology|null;timer:ReturnType<typeof setTimeout>|undefined;version:number;pending:boolean;page:number;capacity:number;structure:string;inViewport:boolean}={data:null,timer:undefined,version:0,pending:false,page:0,capacity:1,structure:"",inViewport:true};
export const topologyStatus={active:"执行中",recent:"近期活动",error:"最近异常",context:"父 agent"};
export const topologyLifecycle={running:"执行中",done:"已完成",failed:"失败",cancelled:"已取消"};
export function stopTopology(){clearTimeout(topology.timer);topology.timer=undefined;topology.version++;topology.pending=false;}
export function resetTopology(){stopTopology();topology.data=null;topology.structure="";topology.page=0;$("topology-graph").replaceChildren();$("topology-count").textContent="进入页面后加载";$("topology-pager").hidden=true;}
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
    topology.data=data;renderTopology(instant);
  }catch(error){if(version===topology.version){$("topology-count").textContent="拓扑读取失败，点击刷新重试";if(!topology.data)$("topology-graph").replaceChildren(el("p",{className:"topology-empty",text:"暂时无法读取近期活动"}));}if(error instanceof ApiError&&error.status===401)fail(error);}
  finally{if(version===topology.version){topology.pending=false;scheduleTopology();}}
}
export function topologyName(node:AgentNode){
  if(node.kind==="subagent")return "子 agent "+node.actor.slice(0,6);
  return state.overview?.threads.find(t=>t.key===node.thread)?.name||(node.thread==="owner"?"主人会话":node.thread);
}
export function topologyFamilies(){
  const nodes=topology.data?.nodes??[],groups:AgentFamily[]=[],size=Math.min(3,topology.capacity);
  for(const parent of nodes.filter(n=>n.kind==="thread")){
    const children=nodes.filter(n=>n.parentId===parent.id).sort((a,b)=>a.id.localeCompare(b.id));
    for(let i=0;i<Math.max(1,children.length);i+=size)groups.push({parent,children:children.slice(i,i+size),part:i/size});
  }
  return groups.sort((a,b)=>a.parent.thread.localeCompare(b.parent.thread)||a.part-b.part);
}
export function topologyCard(node:AgentNode){
  const orb=el("div",{className:"topology-orb","aria-hidden":"true"},[el("div",{className:"topology-glass"}),el("div",{className:"topology-core"}),el("div",{className:"topology-rim"}),el("div",{className:"topology-orbit"},[el("i")])]);
  return el("div",{className:"topology-node","data-agent":node.id,"data-kind":node.kind},[orb,el("div",{className:"topology-copy"},[el("div",{className:"topology-name"}),el("div",{className:"topology-description"},[el("span",{className:"visible"}),el("span",{"aria-hidden":"true"})]),el("div",{className:"topology-state"})])]);
}
export function updateTopologyCard(card:HTMLElement,node:AgentNode){
  const name=topologyName(node),status=(node.kind==="subagent"&&node.status?topologyLifecycle[node.status]:undefined)||topologyStatus[node.activity],text=node.kind==="subagent"?(node.description?.text||node.summary||"暂无任务简介"):"";
  card.dataset.activity=node.activity;card.dataset.current=String(node.kind==="thread"&&node.thread===cs.chat);
  card.querySelector<HTMLElement>(".topology-name")!.textContent=name;card.querySelector<HTMLElement>(".topology-name")!.title=name;
  card.querySelector(".topology-state")!.textContent=(node.kind==="thread"&&node.thread===cs.chat?"当前会话 · ":"")+status;
  const description=card.querySelector<HTMLElement>(".topology-description")!,current=description.querySelector(".visible")!,next=[...description.children].find(s=>s!==current)!;
  if(current.textContent!==text){next.textContent=text;next.classList.add("visible");next.removeAttribute("aria-hidden");current.classList.remove("visible");current.setAttribute("aria-hidden","true");}
  description.title=(node.kind==="subagent"&&node.summary&&node.summary!==text?"任务："+node.summary+"\n":"")+text;
  card.setAttribute("aria-label",name+" · "+status+(text?" · "+text:""));
}
export function drawTopologyLinks(){
  const scene=$("topology-graph").querySelector(".topology-scene");if(!scene)return;
  const box=scene.getBoundingClientRect(),svg=scene.querySelector("svg")!;svg.setAttribute("viewBox","0 0 "+box.width+" "+box.height);
  for(const family of scene.querySelectorAll(".topology-family")){
    const parent=family.querySelector(".topology-parent .topology-node")!,a=parent.querySelector(".topology-orb")!.getBoundingClientRect();
    for(const child of family.querySelectorAll<HTMLElement>(".topology-children .topology-node")){
      const b=child.querySelector(".topology-orb")!.getBoundingClientRect(),x1=a.left+a.width/2-box.left,y1=a.bottom-box.top+10,x2=b.left+b.width/2-box.left,y2=b.top-box.top-13;
      const path=[...svg.querySelectorAll<SVGPathElement>(".topology-link")].find(p=>p.dataset.child===child.dataset.agent);
      if(path)path.setAttribute("d","M "+x1+" "+y1+" C "+x1+" "+(y1+24)+" "+x2+" "+(y2-24)+" "+x2+" "+y2);
    }
  }
}
export function renderTopology(instant=false){
  if(!topology.data||cs.view!=="chat")return;
  const host=$("topology-graph"),capacity=Math.max(1,Math.floor(host.clientWidth/170));
  if(capacity!==topology.capacity){topology.capacity=capacity;topology.page=0;instant=true;}
  const sheets:AgentFamily[][]=[];
  for(const group of topologyFamilies()){
    let sheet=sheets.find(items=>items.length<3&&items.reduce((n,g)=>n+Math.max(1,g.children.length),0)+Math.max(1,group.children.length)<=capacity&&!items.some(g=>g.parent.id===group.parent.id));
    if(!sheet){sheet=[];sheets.push(sheet);}sheet.push(group);
  }
  const pages=Math.max(1,sheets.length);topology.page=Math.min(topology.page,pages-1);
  const visible=sheets[topology.page]||[],nodes=topology.data.nodes;
  const active=nodes.filter(n=>n.activity==="active").length,recent=nodes.filter(n=>n.activity!=="context").length;
  $("topology-count").textContent=recent+" 个近期活跃"+(active?" · "+active+" 个执行中":"");
  $("topology-pager").hidden=pages===1;$("topology-page").textContent=(topology.page+1)+" / "+pages;$("topology-prev").disabled=topology.page===0;$("topology-next").disabled=topology.page===pages-1;
  if(!visible.length){topology.structure="";host.replaceChildren(el("p",{className:"topology-empty",text:"最近 24 小时还没有 agent 活动"}));return;}
  const structure=JSON.stringify(visible.map(g=>[g.parent.id,g.children.map(c=>c.id)]));
  if(structure!==topology.structure){
    const previous=new Map([...host.querySelectorAll<HTMLElement>("[data-agent]")].map(n=>[n.dataset.agent,n]));
    const scene=el("div",{className:"topology-scene","data-depth":visible.some(g=>g.children.length)?2:1,"data-instant":String(instant)}),svg=sv("svg",{class:"topology-connections","aria-hidden":"true"}),defs=sv("defs"),marker=sv("marker",{id:"topology-arrow",viewBox:"0 0 10 10",refX:8,refY:5,markerWidth:6,markerHeight:6,orient:"auto"});
    marker.append(sv("path",{d:"M2 2 L8 5 L2 8",fill:"none",stroke:"currentColor","stroke-width":1.3}));defs.append(marker);svg.append(defs);scene.append(svg);
    let entered=0;
    for(const family of visible){
      const group=el("div",{className:"topology-family",style:"flex:"+Math.max(1,family.children.length)}),parent=el("div",{className:"topology-parent"}),children=el("div",{className:"topology-children"});
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
  $("topology-prev").addEventListener("click",()=>{topology.page--;renderTopology(true);});
  $("topology-next").addEventListener("click",()=>{topology.page++;renderTopology(true);});
  new ResizeObserver(()=>renderTopology(true)).observe($("topology-graph"));
  new IntersectionObserver(entries=>{topology.inViewport=entries[0].isIntersecting;$("agent-topology").classList.toggle("topology-paused",!topology.inViewport||document.hidden);if(topology.inViewport)loadTopology();scheduleTopology();}).observe($("agent-topology"));
  document.addEventListener("visibilitychange",()=>{$("agent-topology").classList.toggle("topology-paused",document.hidden||!topology.inViewport);if(document.hidden)stopTopology();else if(cs.view==="chat")loadTopology(true);});
}
