export const REQUEST_DETAIL_CSS = String.raw`
.detail-head>div{min-width:0}.detail-head>.btn{flex-shrink:0;white-space:nowrap}
.detail-dialog{width:min(1120px,96vw)}.request-round{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}.request-round button{flex:1;min-width:145px;text-align:left}.request-round button[aria-current=true]{background:#E4F2EE;border-color:var(--accent)}.request-round small{display:block;color:var(--muted);margin-top:4px}
.detail-explorer{display:grid;grid-template-columns:190px minmax(0,1fr);gap:26px;border-top:1px solid var(--line);padding-top:22px}.detail-map h3{font-size:13px;margin:0 0 10px}.detail-map section+section{margin-top:24px}.context-jump{display:block;width:100%;text-align:left;background:none;border:0;padding:9px 0;cursor:pointer;font-size:12px}.context-jump .row{justify-content:space-between}.context-jump small{display:block;color:var(--muted);margin-top:4px}.context-jump .meter{margin-top:5px}.detail-content{min-width:0}.detail-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}.detail-toolbar h3{font-size:15px;margin:0}.detail-mode{display:flex;gap:3px}.detail-mode button[aria-pressed=true]{background:#E4F2EE;color:var(--accent)}
.message-block{border:1px solid var(--line);border-radius:7px;margin:9px 0;min-width:0}.message-block>summary{padding:10px 13px;cursor:pointer;font-size:13px;overflow-wrap:anywhere}.message-block>summary small{color:var(--muted);font-size:11px;margin-left:8px}.message-block-content{padding:0 13px 13px;line-height:1.7;overflow-wrap:anywhere}.message-block pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 Consolas,"Microsoft YaHei",monospace;background:#F5F8F8;padding:10px;border-radius:5px;margin:7px 0;max-height:480px;overflow:auto}.message-block p{margin:6px 0}.tool-pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.tool-pair>div{min-width:0}.tool-pair>div+div{border-left:1px solid var(--line);padding-left:16px}.tool-pair h4{font-size:12px;color:var(--muted);font-weight:500;margin:4px 0 9px}.tool-output{border-left:3px solid var(--accent)}.result-image{background:#E5F3EF;padding:10px;border-radius:6px;font-size:12px}.json-fields{margin:6px 0}.json-fields>div{display:grid;grid-template-columns:minmax(85px,auto) minmax(0,1fr);gap:14px;padding:6px 0;border-bottom:1px solid var(--line)}.json-fields dt{color:var(--muted);font:12px Consolas,monospace;overflow-wrap:anywhere}.json-fields dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.cache-breakdown{font-size:12px}.cache-breakdown>div{display:flex;justify-content:space-between;gap:8px;margin:8px 0}.cache-hit{display:flex;align-items:center;justify-content:flex-end;gap:8px}.cache-hit .meter{width:42px}.trace-turn{margin:12px 0 22px;padding-left:18px;border-left:1px solid #B9D5D0}.trace-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-bottom:10px;flex-wrap:wrap}.trace-request{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;border:0;background:#F5F8F8;padding:10px 12px;margin:6px 0;border-radius:5px;text-align:left;cursor:pointer;font-size:12px}.trace-request small{display:block;color:var(--muted);margin-top:3px}.trace-tool{background:#fff}.trace-tool>summary{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.trace-tool>summary:before{content:'›';color:var(--muted)}.trace-tool[open]>summary:before{content:'⌄'}.trace-tool>summary .pill{margin-left:auto}.trace-tool>summary{list-style:none}.trace-tool>summary::-webkit-details-marker{display:none}.trace-unknown{font-size:11px;color:var(--muted);margin:8px 0}.detail-link-row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:12px}.request-turn-filter{display:flex;gap:10px;align-items:center;margin:10px 0;font-size:12px}.manage-nav-label{font-size:11px;color:var(--muted);padding:16px 14px 2px}.manage-page{display:flex;flex-direction:column;gap:24px}
@media(max-width:800px){.detail-explorer{grid-template-columns:1fr}.detail-map{display:grid;grid-template-columns:1fr 1fr;gap:18px}.detail-map section+section{margin:0}.detail-map section:last-child{grid-column:1/-1}.tool-pair{grid-template-columns:1fr}.tool-pair>div+div{border-left:0;padding:10px 0 0;border-top:1px solid var(--line)}.manage-nav-label{display:none}.sidebar nav{flex-wrap:wrap}.request-round button{min-width:110px}}
`;

export const REQUEST_DETAIL_JS = String.raw`
  const detailCache=new Map(), toolCache=new Map();
  const cacheRate=r=>typeof r.cacheRead==="number"&&typeof r.inputTokens==="number"&&r.inputTokens>0?r.cacheRead/r.inputTokens:null;
  const percent=n=>typeof n==="number"?(n*100).toFixed(1)+"%":"—";
  function cacheCell(r){const value=cacheRate(r);return el("div",{className:"cache-hit"},[value===null?null:el("div",{className:"meter"},[el("span",{style:"width:"+Math.min(100,value*100)+"%"})]),el("span",{text:percent(value)})]);}
  function lazyBlock(label,build,open=false,className=""){
    const body=el("div",{className:"message-block-content"}),details=el("details",{className:"message-block "+className},[el("summary",{text:label}),body]);let built=false;
    const fill=()=>{if(details.open&&!built){built=true;body.append(build());}};
    details.addEventListener("toggle",fill);if(open){details.open=true;fill();}return details;
  }
  function textPart(part){return el("div",{},[part?.truncated?el("p",{className:"muted small",text:"内容已截断"}):null,el("pre",{text:part?.text||"（未保留正文）"})]);}
  function jsonValue(value){
    if(value===null||typeof value!=="object")return el("span",{text:value===null?"null":String(value)});
    return el("dl",{className:"json-fields"},Object.entries(value).map(([key,item])=>el("div",{},[el("dt",{text:key}),el("dd",{},[item!==null&&typeof item==="object"?lazyBlock(Array.isArray(item)?item.length+" 项":"展开字段",()=>jsonValue(item)):jsonValue(item)])])));
  }
  function structuredPart(part){
    if(!part)return textPart(part);
    const container=el("div");let data;
    try{data=JSON.parse(part.text);}catch{}
    container.append(data!==undefined?jsonValue(data):el("p",{className:"message-text",text:part.text||"（空）"}));
    if(part.truncated)container.append(el("p",{className:"muted small",text:"内容已截断"}));
    return container;
  }
  function toolPayload(tool){return el("div",{},[
    el("div",{className:"tool-pair"},[el("div",{},[el("h4",{text:"调用参数"}),structuredPart(tool.arguments)]),el("div",{},[el("h4",{text:"返回结果 · "+(statuses[tool.status]||tool.status)}),tool.detailAvailable===false?el("p",{text:"结果正文已清理，执行状态仍可查看。"}):tool.result?structuredPart(tool.result):el("p",{className:"muted small",text:tool.status==="running"?"工具执行中…":"未采集到结果正文"})])]),
    lazyBlock("原始字段",()=>el("pre",{text:JSON.stringify({arguments:tool.arguments,result:tool.result},null,2)})),
    el("p",{className:"muted small",text:"工具执行发生在模型返回之后，不计入本次模型输出 token。"})]);}
  function messageContent(part,paired){
    if(!part.blocks?.length)return structuredPart(part);
    return el("div",{},part.blocks.map(block=>{
      const text=part.text.slice(block.start,block.end);
      if(block.kind==="image")return el("div",{className:"result-image",text:"图片内容已传给模型；快照不保存图片二进制。"});
      if(block.kind==="thinking")return el("p",{className:"muted small",text:"推理内容未保留"});
      if(block.kind!=="toolCall")return el("p",{className:"message-text",text});
      let call;try{call=JSON.parse(text);}catch{}
      const result=paired?.get(block.id);
      return lazyBlock((block.name||"工具调用")+(result?" · 调用与结果":" · 调用参数"),()=>el("div",{},[
        el("div",{className:"tool-pair"},[el("div",{},[el("h4",{text:"assistant / tool call"}),call?jsonValue(call.arguments):textPart({text})]),el("div",{},[el("h4",{text:"tool / result"}),result?messageContent(result):el("p",{className:"muted small",text:"本次输入中尚无配对结果"})])])]),true);
    }));
  }
  function requestMessages(c){
    const paired=new Map(c.messages.filter(m=>m.role==="toolResult"&&m.toolCallId).map(m=>[m.toolCallId,m]));
    const used=new Set(c.messages.flatMap(m=>(m.blocks||[]).filter(b=>b.kind==="toolCall"&&paired.has(b.id)).map(b=>b.id)));
    const items=c.messages.map((m,i)=>({m,index:i+c.omittedMessages+1})).filter(x=>x.m.role!=="toolResult"||!used.has(x.m.toolCallId));
    const render=({m,index},open=false)=>lazyBlock(index+". "+m.role+(m.toolName?" / "+m.toolName:"")+(m.truncated?" · 已截断":""),()=>messageContent(m,paired),open);
    const node=el("div"),older=items.slice(0,-4),recent=items.slice(-4);
    if(older.length)node.append(lazyBlock("较早的消息 · "+older.length+" 组",()=>el("div",{},older.map(item=>render(item)))));
    node.append(...recent.map(item=>render(item,true)));return node;
  }
  function renderRequest(d){
    const r=d.request,body=$("detail-body");cs.detailId=r.id;$("detail-id").textContent=r.model+" · "+r.id+" · "+bjTime(r.startedAt);
    body.replaceChildren();
    if(d.related?.length>1)body.append(el("nav",{className:"request-round","aria-label":"本轮模型请求"},d.related.map((item,i)=>el("button",{className:"btn",type:"button","aria-current":String(item.id===r.id),onclick:()=>openRequest(item.id)},["请求 #"+(i+1)+" · "+(statuses[item.status]||item.status),el("small",{text:item.model+" · 缓存 "+percent(cacheRate(item))})]))));
    body.append(el("div",{className:"row"},[requestPill(r.status),el("span",{className:"muted small",text:r.thread+" / "+(purposes[r.purpose]||r.purpose)}),el("button",{className:"request-link",type:"button",text:"定位到对话",onclick:()=>{$("request-detail").close();chooseChat(r.thread);consoleView("chat");cs.locateTurn=r.binding?.turnId;}})]),
      el("div",{className:"detail-stats"},[["输入 token",nf(r.inputTokens)],["输出 token",nf(r.outputTokens)],["缓存命中率",percent(cacheRate(r))],["模型耗时",duration(r.durationMs)]].map(([name,value])=>el("div",{className:"metric-label"},[name,el("strong",{text:value})]))));
    if(r.error)body.append(el("pre",{className:"context-note",text:r.error}));
    if(!d.detailAvailable){body.append(el("div",{className:"empty-state",text:"详情已过保留期或达到容量上限；请求用量仍可查看。"}));return;}
    const c=d.context,total=c.chars.system+c.chars.messages+c.chars.tools,visual=el("div"),raw=el("div",{hidden:true});let rawBuilt=false;
    const system=lazyBlock("系统提示 · "+nf(c.chars.system)+" 字符",()=>textPart(c.system));
    const tools=lazyBlock("可用工具定义 · "+c.toolCount+" 个",()=>el("div",{},c.tools.map(t=>lazyBlock(t.name,()=>structuredPart(t)))));
    const messages=el("section",{},[el("h3",{className:"detail-section-title",text:"消息 · "+c.messageCount+" 条"}),requestMessages(c)]);
    visual.append(el("p",{className:"context-note",text:c.truncated?"快照已截断；省略最早 "+c.omittedMessages+" 条消息，未保留内容无法展开。":"归一化请求上下文，已隐藏凭据、推理正文和图片二进制。"}),system,tools,messages,el("h3",{className:"detail-section-title",text:"本次模型输出"}));
    if(d.response)visual.append(lazyBlock("assistant · "+(r.stopReason||"输出"),()=>messageContent(d.response),true,"tool-output"));
    else visual.append(el("p",{className:"muted",text:r.status==="running"?"模型生成中…":"未保留模型输出"}));
    if(d.tools?.length){visual.append(el("h3",{className:"detail-section-title",text:"调用后的工具执行"}));d.tools.forEach(t=>visual.append(renderToolTrace(t)));}
    else if(r.toolCalls?.length)visual.append(el("p",{className:"muted small",text:"工具执行结果尚未采集到。"}));
    if(!r.binding)visual.append(el("p",{className:"muted small",text:"这条旧记录没有回合关联，不能准确跳转前后请求或关联工具执行。"}));
    const visualButton=el("button",{className:"btn compact",type:"button",text:"可视化","aria-pressed":"true"}),rawButton=el("button",{className:"btn compact",type:"button",text:"原始快照","aria-pressed":"false"});
    const mode=showRaw=>{visual.hidden=showRaw;raw.hidden=!showRaw;visualButton.setAttribute("aria-pressed",String(!showRaw));rawButton.setAttribute("aria-pressed",String(showRaw));if(showRaw&&!rawBuilt){rawBuilt=true;raw.append(el("pre",{className:"context-note",text:JSON.stringify({context:c,response:d.response,tools:d.tools},null,2)}));}};
    visualButton.addEventListener("click",()=>mode(false));rawButton.addEventListener("click",()=>mode(true));
    const composition=el("section",{},[el("h3",{text:"上下文组成"}),el("div",{className:"muted small",text:"字符占比 · 点击展开"})]);
    [["系统提示",c.chars.system,system],["消息与工具结果",c.chars.messages,messages],["工具定义",c.chars.tools,tools]].forEach(([name,value,target])=>composition.append(el("button",{className:"context-jump",type:"button",onclick:()=>{mode(false);if(target.tagName==="DETAILS")target.open=true;target.scrollIntoView({block:"nearest"});}},[el("div",{className:"row"},[name,el("span",{text:total?percent(value/total):"—"})]),el("div",{className:"meter"},[el("span",{style:"width:"+(total?value/total*100:0)+"%"})]),el("small",{text:nf(value)+" 字符"})])));
    const ratio=cacheRate(r),cache=el("section",{className:"cache-breakdown"},[el("h3",{text:"输入缓存"}),el("div",{className:"meter"},[el("span",{style:"width:"+(ratio===null?0:ratio*100)+"%"})]),...[["缓存读取",r.cacheRead],["未命中输入",ratio===null?null:r.inputTokens-r.cacheRead],["其中缓存写入",r.cacheWrite]].map(([label,value])=>el("div",{},[label,el("span",{text:nf(value)})])),el("p",{className:"muted small",text:"命中率 = 缓存读取 / 总输入。仅有请求级总量，无法确定哪条消息命中了缓存。"})]);
    const windowInfo=el("section",{},[el("h3",{text:"上下文窗口"}),el("p",{className:"small",text:(r.inputTokens!=null&&r.contextWindow?percent(r.inputTokens/r.contextWindow):"—")+" / "+compact(r.contextWindow)+" token"}),el("div",{className:"meter"},[el("span",{style:"width:"+(r.inputTokens&&r.contextWindow?Math.min(100,r.inputTokens/r.contextWindow*100):0)+"%"})]),el("p",{className:"muted small",text:"组成按文本字符统计，图片不参与字符占比。"})]);
    body.append(el("div",{className:"detail-explorer"},[el("aside",{className:"detail-map"},[composition,cache,windowInfo]),el("div",{className:"detail-content"},[el("div",{className:"detail-toolbar"},[el("h3",{text:"请求输入"}),el("div",{className:"detail-mode"},[visualButton,rawButton])]),visual,raw])]));
  }
  async function openRequest(id){
    const version=++cs.detailVersion,epoch=cs.epoch;cs.detailId=id;
    $("detail-id").textContent=id;$("detail-body").replaceChildren(el("p",{className:"muted",text:"正在读取请求详情…"}));
    if(!$("request-detail").open)$("request-detail").showModal();
    try{
      const d=detailCache.get(id)||await api("GET","/admin/requests/"+encodeURIComponent(id));
      if(version!==cs.detailVersion||epoch!==cs.epoch)return;
      if(d.request.status!=="running"&&!(d.tools||[]).some(t=>t.status==="running")&&(d.request.toolCalls||[]).every(c=>(d.tools||[]).some(t=>t.callId===c.id)))detailCache.set(id,d);
      renderRequest(d);
    }catch(error){if(version===cs.detailVersion)$("detail-body").replaceChildren(el("p",{text:"详情读取失败，请关闭后重试。"}));fail(error);}
  }
`;
