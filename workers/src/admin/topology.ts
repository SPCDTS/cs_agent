export const TOPOLOGY_HTML = String.raw`
  <section id="agent-topology" class="agent-topology" aria-labelledby="topology-title">
    <div class="topology-head"><div><h2 id="topology-title">Agent 拓扑</h2><p>最近 24 小时 · 箭头由父 agent 指向子 agent</p></div>
      <div class="topology-actions"><span id="topology-count" class="small muted" role="status">进入页面后加载</span><button id="topology-refresh" type="button" class="btn compact">刷新拓扑</button></div></div>
    <div id="topology-graph" class="topology-graph"><p class="topology-empty">正在读取近期活动…</p></div>
    <div class="topology-foot"><div class="topology-legend"><span><i class="active"></i>执行中</span><span><i></i>近期活动</span><span><i class="error"></i>最近异常</span></div>
      <div id="topology-pager" class="row" hidden><button id="topology-prev" class="btn compact" type="button">上一组</button><span id="topology-page" class="small muted"></span><button id="topology-next" class="btn compact" type="button">下一组</button></div></div>
  </section>
`;

export const TOPOLOGY_CSS = String.raw`
.agent-topology{margin-bottom:20px;padding:18px 22px 12px;background:#fff;border:1px solid var(--line);border-radius:10px}
.topology-graph[data-depth="1"]{min-height:120px}.topology-graph[data-depth="1"] svg{height:120px}
.topology-head,.topology-actions,.topology-foot,.topology-legend{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.topology-head h2{font-size:15px;margin:0 0 4px}.topology-head p{font-size:12px;color:var(--muted);margin:0}.topology-graph{min-height:195px}.topology-graph svg{display:block;width:100%;height:195px;overflow:visible}.topology-empty{height:195px;display:grid;place-items:center;color:var(--muted);font-size:13px;margin:0}.topology-foot{min-height:29px}.topology-legend{justify-content:flex-start;font-size:11px;color:var(--muted);gap:16px}.topology-legend span{display:flex;align-items:center;gap:6px}.topology-legend i{width:7px;height:7px;border-radius:50%;background:#72A8A0}.topology-legend .active{background:#087F73}.topology-legend .error{background:#BA6840}.topology-link{fill:none;stroke:#B6D1CC;stroke-width:1.4}.topology-flow{fill:none;stroke:#087F73;stroke-width:2;stroke-dasharray:3 15;animation:topology-flow 1.8s linear infinite}.topology-orb{animation:topology-float 5s ease-in-out infinite;animation-delay:var(--phase,0s)}.topology-halo{fill:none;stroke:#55A99B;stroke-width:1.3;transform-box:fill-box;transform-origin:center;animation:topology-pulse 2.8s ease-out infinite}.topology-label{font:12px "Segoe UI","Microsoft YaHei",sans-serif;fill:#294A4B;text-anchor:middle}.topology-state{font:10px "Segoe UI","Microsoft YaHei",sans-serif;fill:#64767B;text-anchor:middle}.topology-current{fill:none;stroke:#087F73;stroke-width:1.3;stroke-dasharray:2 4}.topology-paused *,.topology-paused .topology-orb,#view-chat[hidden] .agent-topology *{animation-play-state:paused!important}
#view-chat .chat-layout{height:calc(100dvh - 505px);min-height:530px}
@keyframes topology-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}@keyframes topology-flow{to{stroke-dashoffset:-36}}@keyframes topology-pulse{0%{opacity:.65;transform:scale(.94)}80%,100%{opacity:0;transform:scale(1.22)}}
@media(max-width:760px){.agent-topology{padding:15px 12px 10px}.topology-head{gap:10px}.topology-actions{width:100%;justify-content:space-between}.topology-foot{gap:10px}.topology-legend{gap:12px}}
@media(prefers-reduced-motion:reduce){.agent-topology *{animation:none!important}.topology-halo{opacity:.3}.topology-flow{stroke-dasharray:none}}
`;

export const TOPOLOGY_JS = String.raw`
  const topology={data:null,timer:null,version:0,pending:false,page:0,columns:1,fingerprint:"",inViewport:true};
  const topologyStatus={active:"执行中",recent:"近期活动",error:"最近异常",context:"父 agent"};
  function stopTopology(){clearTimeout(topology.timer);topology.timer=null;topology.version++;topology.pending=false;}
  function resetTopology(){stopTopology();topology.data=null;topology.fingerprint="";topology.page=0;$("topology-graph").replaceChildren();$("topology-count").textContent="进入页面后加载";$("topology-pager").hidden=true;}
  function scheduleTopology(){
    clearTimeout(topology.timer);topology.timer=null;
    if(cs.view==="chat"&&!document.hidden&&topology.inViewport&&topology.data?.nodes.some(n=>n.activity==="active"))topology.timer=setTimeout(()=>loadTopology(true),10000);
  }
  function refreshTopologyAfterTurn(){
    if(cs.view!=="chat"||document.hidden||!topology.inViewport)return;
    clearTimeout(topology.timer);
    topology.timer=setTimeout(()=>loadTopology(true),Math.max(0,10000-(Date.now()-(topology.data?.sampledAt||0))));
  }
  async function loadTopology(force=false){
    if(cs.view!=="chat"||document.hidden||!readToken()||topology.pending)return;
    if(!force&&!topology.inViewport&&topology.data)return;
    if(!force&&topology.data&&Date.now()-topology.data.sampledAt<10000)return;
    const version=++topology.version,epoch=cs.epoch;topology.pending=true;
    try{
      const data=await api("GET","/admin/agent-topology");
      if(version!==topology.version||epoch!==cs.epoch||cs.view!=="chat"||document.hidden)return;
      topology.data=data;renderTopology();
    }catch(error){if(version===topology.version){$("topology-count").textContent="拓扑读取失败，点击刷新重试";if(!topology.data)$("topology-graph").replaceChildren(el("p",{className:"topology-empty",text:"暂时无法读取近期活动"}));}if(error instanceof ApiError&&error.status===401)fail(error);}
    finally{if(version===topology.version){topology.pending=false;scheduleTopology();}}
  }
  function topologyName(node){
    if(node.kind==="subagent")return "子 agent "+node.actor.slice(0,6);
    return state.overview?.threads.find(t=>t.key===node.thread)?.name||(node.thread==="owner"?"主人会话":node.thread);
  }
  function topologyFamilies(){
    const nodes=topology.data.nodes,groups=[];
    for(const parent of nodes.filter(n=>n.kind==="thread")){
      const children=nodes.filter(n=>n.parentId===parent.id).sort((a,b)=>a.id.localeCompare(b.id));
      for(let i=0;i<Math.max(1,children.length);i+=3)groups.push({parent,children:children.slice(i,i+3),part:i/3});
    }
    return groups.sort((a,b)=>a.parent.thread.localeCompare(b.parent.thread)||a.part-b.part);
  }
  function renderTopology(){
    if(!topology.data||cs.view!=="chat")return;
    const host=$("topology-graph"),columns=Math.max(1,Math.min(3,Math.floor(host.clientWidth/280))),groups=topologyFamilies();
    if(columns!==topology.columns){topology.columns=columns;topology.page=0;}
    const sheets=[];
    for(const group of groups){let sheet=sheets.find(items=>items.length<columns&&!items.some(item=>item.parent.id===group.parent.id));if(!sheet){sheet=[];sheets.push(sheet);}sheet.push(group);}
    const pages=Math.max(1,sheets.length);topology.page=Math.min(topology.page,pages-1);
    const visible=sheets[topology.page]||[],nodes=topology.data.nodes;
    const fingerprint=JSON.stringify([visible,cs.chat,columns,visible.map(g=>topologyName(g.parent))]);
    const active=nodes.filter(n=>n.activity==="active").length,recent=nodes.filter(n=>n.activity!=="context").length;
    $("topology-count").textContent=recent+" 个近期活跃"+(active?" · "+active+" 个执行中":"");
    $("topology-pager").hidden=pages===1;$("topology-page").textContent=(topology.page+1)+" / "+pages;
    $("topology-prev").disabled=topology.page===0;$("topology-next").disabled=topology.page===pages-1;
    if(fingerprint===topology.fingerprint)return;topology.fingerprint=fingerprint;
    if(!visible.length){host.replaceChildren(el("p",{className:"topology-empty",text:"最近 24 小时还没有 agent 活动"}));return;}
    const depth=visible.some(g=>g.children.length)?2:1;host.dataset.depth=String(depth);
    const width=visible.length*300,svg=sv("svg",{viewBox:"0 0 "+width+" "+(depth===2?210:120),role:"img","aria-label":visible.map(g=>topologyName(g.parent)+(g.children.length?" 派出 "+g.children.map(topologyName).join("、"):"，无近期子 agent")).join("；")}),defs=sv("defs");
    for(const [name,light,dark]of [["active","#9DE7D3","#087F73"],["recent","#E1F4EC","#649B91"],["error","#FBE2BC","#B76C42"],["context","#EFF4F3","#A8BDB9"]]){
      const gradient=sv("radialGradient",{id:"topology-sphere-"+name,cx:"30%",cy:"24%",r:"78%"});
      gradient.append(sv("stop",{offset:"0%","stop-color":"#FFFFFF"}),sv("stop",{offset:"22%","stop-color":light}),sv("stop",{offset:"100%","stop-color":dark}));defs.append(gradient);
    }
    const marker=sv("marker",{id:"topology-arrow",viewBox:"0 0 8 8",refX:7,refY:4,markerWidth:6,markerHeight:6,orient:"auto"});marker.append(sv("path",{d:"M1 1 L7 4 L1 7",fill:"none",stroke:"#659D92","stroke-width":1.4}));defs.append(marker);svg.append(defs);
    const orb=(node,x,y,r,index,side=false)=>{
      const group=sv("g",{"data-agent":node.id}),name=topologyName(node);
      group.append(sv("title",{},name+" · "+topologyStatus[node.activity]),sv("ellipse",{cx:x,cy:y+r+5,rx:r*.72,ry:3,fill:"#CFDFDB",opacity:.55}));
      if(node.kind==="thread"&&node.thread===cs.chat)group.append(sv("circle",{cx:x,cy:y,r:r+7,class:"topology-current"}));
      if(node.activity==="active")group.append(sv("circle",{cx:x,cy:y,r:r+5,class:"topology-halo"}));
      const sphere=sv("g",{class:"topology-orb",style:"--phase:"+(-index*.7)+"s"});sphere.append(sv("circle",{cx:x,cy:y,r,fill:"url(#topology-sphere-"+node.activity+")"}),sv("ellipse",{cx:x-r*.27,cy:y-r*.35,rx:r*.27,ry:r*.13,fill:"#fff",opacity:.45}));group.append(sphere);
      const label=Array.from(name),limit=side?9:14,labelX=side?x+r+15:x,align=side?"text-anchor:start":"";
      group.append(sv("text",{x:labelX,y:side?y:y+r+22,class:"topology-label",style:align},label.length>limit?label.slice(0,limit-1).join("")+"…":name),sv("text",{x:labelX,y:side?y+16:y+r+36,class:"topology-state",style:align},topologyStatus[node.activity]));return group;
    };
    visible.forEach((family,index)=>{
      const center=index*300+150,rootY=depth===2?38:55;
      family.children.forEach((child,i)=>{
        const x=center+(i-(family.children.length-1)/2)*98,path="M "+center+" 69 C "+center+" 108 "+x+" 94 "+x+" 116";
        svg.append(sv("path",{d:path,class:"topology-link","marker-end":"url(#topology-arrow)","data-parent":family.parent.id,"data-child":child.id}));
        if(child.activity==="active")svg.append(sv("path",{d:path,class:"topology-flow"}));
        svg.append(orb(child,x,140,19,index*4+i+1));
      });
      svg.append(orb(family.parent,center,rootY,25,index*4,true));
    });host.replaceChildren(svg);
  }
  $("topology-refresh").addEventListener("click",()=>loadTopology(true));
  $("topology-prev").addEventListener("click",()=>{topology.page--;renderTopology();});
  $("topology-next").addEventListener("click",()=>{topology.page++;renderTopology();});
  new ResizeObserver(()=>renderTopology()).observe($("topology-graph"));
  new IntersectionObserver(entries=>{topology.inViewport=entries[0].isIntersecting;$("agent-topology").classList.toggle("topology-paused",!topology.inViewport||document.hidden);if(topology.inViewport)loadTopology();scheduleTopology();}).observe($("agent-topology"));
  document.addEventListener("visibilitychange",()=>{$("agent-topology").classList.toggle("topology-paused",document.hidden||!topology.inViewport);if(document.hidden)stopTopology();else if(cs.view==="chat")loadTopology(true);});
`;
