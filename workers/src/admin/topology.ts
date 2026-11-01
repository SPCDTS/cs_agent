export const TOPOLOGY_HTML = String.raw`
  <section id="agent-topology" class="agent-topology" aria-labelledby="topology-title">
    <div class="topology-head"><div><h2 id="topology-title">Agent 拓扑</h2><p>最近 24 小时 · 父 agent → 子 agent</p></div>
      <div class="topology-actions"><span id="topology-count" class="small muted" role="status">进入页面后加载</span><button id="topology-refresh" type="button" class="btn compact">刷新拓扑</button></div></div>
    <div id="topology-graph" class="topology-graph"><p class="topology-empty">正在读取近期活动…</p></div>
    <div class="topology-foot"><span class="small muted">球体下方显示任务简介与最新进度</span>
      <div id="topology-pager" class="row" hidden><button id="topology-prev" class="btn compact" type="button">上一组</button><span id="topology-page" class="small muted"></span><button id="topology-next" class="btn compact" type="button">下一组</button></div></div>
  </section>
`;

export const TOPOLOGY_CSS = String.raw`
.agent-topology{--ease-out:cubic-bezier(.23,1,.32,1);--topology-glass:#bcd8cc;--topology-shadow:#749b90;--topology-light:#f8fffa;margin-bottom:20px;padding:18px 22px 12px;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.topology-head,.topology-actions,.topology-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.topology-head h2{font-size:15px;font-weight:500;margin:0 0 5px}.topology-head p{font-size:12px;color:var(--muted);margin:0}.topology-foot{min-height:29px;margin-top:10px}.topology-graph{min-height:136px}.topology-empty{min-height:136px;display:grid;place-items:center;color:var(--muted);font-size:13px;margin:0}
.topology-scene{position:relative;display:flex;gap:16px;isolation:isolate;margin-top:12px}.topology-family{position:relative;min-width:0;height:282px}.topology-scene[data-depth="1"] .topology-family{height:125px}.topology-parent{display:flex;justify-content:center;padding-top:18px}.topology-children{position:absolute;top:142px;left:0;right:0;display:flex;justify-content:space-around;gap:12px}.topology-node{min-width:0;transition:opacity 200ms var(--ease-out),transform 250ms var(--ease-out);transform-origin:50% 0}.topology-node[data-kind="thread"]{display:flex;align-items:center;gap:12px;max-width:100%}.topology-node[data-kind="subagent"]{width:160px;flex:1;text-align:center;max-width:190px}.topology-node[data-entering="true"]{opacity:0;transform:translateY(-6px) scale(.96)}.topology-scene[data-instant="true"] .topology-node,.topology-scene[data-instant="true"] .topology-description span{transition:none}
.topology-orb{position:relative;width:42px;height:42px;margin:auto;flex-shrink:0}.topology-node[data-kind="thread"] .topology-orb{width:50px;height:50px;margin:0}.topology-glass,.topology-core,.topology-rim{position:absolute;inset:0;border-radius:50%}.topology-glass{background:radial-gradient(ellipse at 32% 23%,var(--topology-light),#e1f0e7 10%,var(--topology-glass) 43%,var(--topology-shadow) 85%,var(--topology-light));box-shadow:inset 0 0 0 1px #f4fffaaa,inset -3px -4px 8px #749b9066,0 5px 14px #627b7121}.topology-core{inset:4px;background:radial-gradient(ellipse at 62% 76%,#f8fffa99,transparent 54%);opacity:.3;transition:opacity 200ms var(--ease-out)}.topology-rim{inset:2px;border:1px solid #f4fffaaa;border-right-color:transparent;border-bottom-color:transparent;transform:rotate(-20deg)}.topology-orbit{position:absolute;inset:-7px;border:1px solid #217d6f1f;border-radius:50%;opacity:0;transition:opacity 200ms var(--ease-out)}.topology-orbit i{position:absolute;inset:-1px;border:1px solid transparent;border-top-color:var(--accent);border-radius:50%;animation:topology-running 2s linear infinite;animation-play-state:paused}.topology-node[data-activity="active"] .topology-orbit{opacity:.8}.topology-node[data-activity="active"] .topology-core{opacity:.8}.topology-node[data-activity="active"] .topology-orbit i{animation-play-state:running}.topology-node[data-current="true"] .topology-glass{outline:1px solid #217d6f33;outline-offset:3px}
.topology-copy{min-width:0}.topology-node[data-kind="thread"] .topology-copy{max-width:125px}.topology-name{font-size:11px;line-height:18px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.topology-node[data-kind="thread"] .topology-name{font-size:13px;line-height:20px;color:var(--ink)}.topology-node[data-kind="subagent"] .topology-copy{margin-top:13px}.topology-description{position:relative;height:40px;margin-top:4px;font-size:13px;line-height:20px;text-wrap:balance}.topology-description span{position:absolute;inset:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;opacity:0;transition:opacity 200ms var(--ease-out)}.topology-description span.visible{opacity:1}.topology-node[data-kind="thread"] .topology-description{display:none}.topology-state{font-size:11px;line-height:18px;color:var(--muted);margin-top:4px;display:flex;align-items:center;justify-content:center;gap:5px}.topology-state:before{content:"";width:4px;height:4px;background:#b4c8bf;border-radius:50%}.topology-node[data-kind="thread"] .topology-state{justify-content:flex-start}.topology-node[data-activity="active"] .topology-state:before{background:var(--accent)}.topology-node[data-activity="error"] .topology-state:before{background:#b76c42}
.topology-connections{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:-1;color:#9bb8ad;overflow:visible}.topology-link{fill:none;stroke:currentColor;stroke-width:1;marker-end:url(#topology-arrow)}.topology-paused .topology-orbit i,#view-chat[hidden] .topology-orbit i{animation-play-state:paused!important}
#view-chat .chat-layout{height:calc(100dvh - 575px);min-height:530px}
@keyframes topology-running{to{transform:rotate(360deg)}}
@media(max-width:760px){.agent-topology{padding:15px 12px 10px}.topology-head{gap:10px}.topology-actions{width:100%;justify-content:space-between}.topology-foot{gap:10px}.topology-scene{gap:12px}}
@media(prefers-reduced-motion:reduce){.agent-topology .topology-orbit i{animation:none!important}.topology-node{transition:opacity 200ms var(--ease-out)}.topology-node[data-entering="true"]{transform:none}}
`;

export const TOPOLOGY_JS = String.raw`
  const topology={data:null,timer:null,version:0,pending:false,page:0,capacity:1,structure:"",inViewport:true};
  const topologyStatus={active:"执行中",recent:"近期活动",error:"最近异常",context:"父 agent"};
  const topologyLifecycle={running:"执行中",done:"已完成",failed:"失败",cancelled:"已取消"};
  function stopTopology(){clearTimeout(topology.timer);topology.timer=null;topology.version++;topology.pending=false;}
  function resetTopology(){stopTopology();topology.data=null;topology.structure="";topology.page=0;$("topology-graph").replaceChildren();$("topology-count").textContent="进入页面后加载";$("topology-pager").hidden=true;}
  function scheduleTopology(){
    clearTimeout(topology.timer);topology.timer=null;
    if(cs.view==="chat"&&!document.hidden&&topology.inViewport&&topology.data?.nodes.some(n=>n.activity==="active"))topology.timer=setTimeout(()=>loadTopology(true),10000);
  }
  function refreshTopologyAfterTurn(){
    if(cs.view!=="chat"||document.hidden||!topology.inViewport)return;
    clearTimeout(topology.timer);topology.timer=setTimeout(()=>loadTopology(true),Math.max(0,10000-(Date.now()-(topology.data?.sampledAt||0))));
  }
  async function loadTopology(force=false,instant=false){
    if(cs.view!=="chat"||document.hidden||!readToken()||topology.pending)return;
    if(!force&&!topology.inViewport&&topology.data)return;
    if(!force&&topology.data&&Date.now()-topology.data.sampledAt<10000)return;
    const version=++topology.version,epoch=cs.epoch;topology.pending=true;
    try{
      const data=await api("GET","/admin/agent-topology");
      if(version!==topology.version||epoch!==cs.epoch||cs.view!=="chat"||document.hidden)return;
      topology.data=data;renderTopology(instant);
    }catch(error){if(version===topology.version){$("topology-count").textContent="拓扑读取失败，点击刷新重试";if(!topology.data)$("topology-graph").replaceChildren(el("p",{className:"topology-empty",text:"暂时无法读取近期活动"}));}if(error instanceof ApiError&&error.status===401)fail(error);}
    finally{if(version===topology.version){topology.pending=false;scheduleTopology();}}
  }
  function topologyName(node){
    if(node.kind==="subagent")return "子 agent "+node.actor.slice(0,6);
    return state.overview?.threads.find(t=>t.key===node.thread)?.name||(node.thread==="owner"?"主人会话":node.thread);
  }
  function topologyFamilies(){
    const nodes=topology.data.nodes,groups=[],size=Math.min(3,topology.capacity);
    for(const parent of nodes.filter(n=>n.kind==="thread")){
      const children=nodes.filter(n=>n.parentId===parent.id).sort((a,b)=>a.id.localeCompare(b.id));
      for(let i=0;i<Math.max(1,children.length);i+=size)groups.push({parent,children:children.slice(i,i+size),part:i/size});
    }
    return groups.sort((a,b)=>a.parent.thread.localeCompare(b.parent.thread)||a.part-b.part);
  }
  function topologyCard(node){
    const orb=el("div",{className:"topology-orb","aria-hidden":"true"},[el("div",{className:"topology-glass"}),el("div",{className:"topology-core"}),el("div",{className:"topology-rim"}),el("div",{className:"topology-orbit"},[el("i")])]);
    return el("div",{className:"topology-node","data-agent":node.id,"data-kind":node.kind},[orb,el("div",{className:"topology-copy"},[el("div",{className:"topology-name"}),el("div",{className:"topology-description"},[el("span",{className:"visible"}),el("span",{"aria-hidden":"true"})]),el("div",{className:"topology-state"})])]);
  }
  function updateTopologyCard(card,node){
    const name=topologyName(node),status=topologyLifecycle[node.status]||topologyStatus[node.activity],text=node.kind==="subagent"?(node.description?.text||node.summary||"暂无任务简介"):"";
    card.dataset.activity=node.activity;card.dataset.current=String(node.kind==="thread"&&node.thread===cs.chat);
    card.querySelector(".topology-name").textContent=name;card.querySelector(".topology-name").title=name;
    card.querySelector(".topology-state").textContent=(node.kind==="thread"&&node.thread===cs.chat?"当前会话 · ":"")+status;
    const description=card.querySelector(".topology-description"),current=description.querySelector(".visible"),next=[...description.children].find(s=>s!==current);
    if(current.textContent!==text){next.textContent=text;next.classList.add("visible");next.removeAttribute("aria-hidden");current.classList.remove("visible");current.setAttribute("aria-hidden","true");}
    description.title=(node.summary&&node.summary!==text?"任务："+node.summary+"\n":"")+text;
    card.setAttribute("aria-label",name+" · "+status+(text?" · "+text:""));
  }
  function drawTopologyLinks(){
    const scene=$("topology-graph").querySelector(".topology-scene");if(!scene)return;
    const box=scene.getBoundingClientRect(),svg=scene.querySelector("svg");svg.setAttribute("viewBox","0 0 "+box.width+" "+box.height);
    for(const family of scene.querySelectorAll(".topology-family")){
      const parent=family.querySelector(".topology-parent .topology-node"),a=parent.querySelector(".topology-orb").getBoundingClientRect();
      for(const child of family.querySelectorAll(".topology-children .topology-node")){
        const b=child.querySelector(".topology-orb").getBoundingClientRect(),x1=a.left+a.width/2-box.left,y1=a.bottom-box.top+10,x2=b.left+b.width/2-box.left,y2=b.top-box.top-13;
        const path=[...svg.querySelectorAll(".topology-link")].find(p=>p.dataset.child===child.dataset.agent);
        if(path)path.setAttribute("d","M "+x1+" "+y1+" C "+x1+" "+(y1+24)+" "+x2+" "+(y2-24)+" "+x2+" "+y2);
      }
    }
  }
  function renderTopology(instant=false){
    if(!topology.data||cs.view!=="chat")return;
    const host=$("topology-graph"),capacity=Math.max(1,Math.floor(host.clientWidth/170));
    if(capacity!==topology.capacity){topology.capacity=capacity;topology.page=0;instant=true;}
    const sheets=[];
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
      const previous=new Map([...host.querySelectorAll("[data-agent]")].map(n=>[n.dataset.agent,n]));
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
      host.querySelector(".topology-scene").dataset.instant=String(instant);
      const cards=new Map([...host.querySelectorAll("[data-agent]")].map(card=>[card.dataset.agent,card]));
      for(const family of visible)for(const node of [family.parent,...family.children])updateTopologyCard(cards.get(node.id),node);
    }
    drawTopologyLinks();
  }
  $("topology-refresh").addEventListener("click",e=>loadTopology(true,e.detail===0));
  $("topology-prev").addEventListener("click",()=>{topology.page--;renderTopology(true);});
  $("topology-next").addEventListener("click",()=>{topology.page++;renderTopology(true);});
  new ResizeObserver(()=>renderTopology(true)).observe($("topology-graph"));
  new IntersectionObserver(entries=>{topology.inViewport=entries[0].isIntersecting;$("agent-topology").classList.toggle("topology-paused",!topology.inViewport||document.hidden);if(topology.inViewport)loadTopology();scheduleTopology();}).observe($("agent-topology"));
  document.addEventListener("visibilitychange",()=>{$("agent-topology").classList.toggle("topology-paused",document.hidden||!topology.inViewport);if(document.hidden)stopTopology();else if(cs.view==="chat")loadTopology(true);});
`;
