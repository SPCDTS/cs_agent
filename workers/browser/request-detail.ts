import { $, bjTime, duration, el, fail } from "./app";
import * as C from "./request-contracts";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { readApi } from "./api";
import { chooseChat, compact, consoleView, cs, nf, purposes, requestPill, statuses } from "./console";
import { renderToolTrace } from "./trace";
export const detailCache=new Map<string,C.RequestDetail>(), toolCache=new Map<string,C.ToolDetail>();
const ToolCallArguments=Type.Object({arguments:Type.Unknown()});
export const cacheRate=(r:Pick<C.RequestRecord,"cacheRead"|"inputTokens">)=>typeof r.cacheRead==="number"&&typeof r.inputTokens==="number"&&r.inputTokens>0?r.cacheRead/r.inputTokens:null;
export const percent=(n:number|null|undefined)=>typeof n==="number"?(n*100).toFixed(1)+"%":"—";
export function cacheCell(r:C.RequestRecord){const value=cacheRate(r);return el("div",{className:"cache-hit"},[value===null?null:el("div",{className:"meter"},[el("span",{style:"width:"+Math.min(100,value*100)+"%"})]),el("span",{text:percent(value)})]);}
export function lazyBlock(label:string,build:()=>Node,open=false,className=""){
  const body=el("div",{className:"message-block-content"}),details=el("details",{className:"message-block "+className},[el("summary",{text:label}),body]);let built=false;
  const fill=()=>{if(details.open&&!built){built=true;body.append(build());}};
  details.addEventListener("toggle",fill);if(open){details.open=true;fill();}return details;
}
export function textPart(part:C.TextPart|undefined){return el("div",{},[part?.truncated?el("p",{className:"muted small",text:"内容已截断"}):null,el("pre",{text:part?.text||"（未保留正文）"})]);}
export function jsonValue(value:unknown):HTMLElement{
  if(value===null||typeof value!=="object")return el("span",{text:value===null?"null":String(value)});
  return el("dl",{className:"json-fields"},Object.entries(value).map(([key,item])=>el("div",{},[el("dt",{text:key}),el("dd",{},[item!==null&&typeof item==="object"?lazyBlock(Array.isArray(item)?item.length+" 项":"展开字段",()=>jsonValue(item)):jsonValue(item)])])));
}
export function structuredPart(part:C.TextPart|undefined){
  if(!part)return textPart(part);
  const container=el("div");let data:unknown;
  try{data=JSON.parse(part.text);}catch{}
  container.append(data!==undefined?jsonValue(data):el("p",{className:"message-text",text:part.text||"（空）"}));
  if(part.truncated)container.append(el("p",{className:"muted small",text:"内容已截断"}));
  return container;
}
export function toolPayload(tool:C.ToolDetail){return el("div",{},[
  el("div",{className:"tool-pair"},[el("div",{},[el("h4",{text:"调用参数"}),structuredPart(tool.arguments)]),el("div",{},[el("h4",{text:"返回结果 · "+(statuses[tool.status]||tool.status)}),tool.detailAvailable===false?el("p",{text:"结果正文已清理，执行状态仍可查看。"}):tool.result?structuredPart(tool.result):el("p",{className:"muted small",text:tool.status==="running"?"工具执行中…":"未采集到结果正文"})])]),
  lazyBlock("原始字段",()=>el("pre",{text:JSON.stringify({arguments:tool.arguments,result:tool.result},null,2)})),
  el("p",{className:"muted small",text:"工具执行发生在模型返回之后，不计入本次模型输出 token。"})]);}
export function messageContent(part:C.MessagePart,paired?:ReadonlyMap<string,C.MessagePart>):HTMLElement{
  if(!part.blocks?.length)return structuredPart(part);
  return el("div",{},part.blocks.map(block=>{
    const text=part.text.slice(block.start,block.end);
    if(block.kind==="image")return el("div",{className:"result-image",text:"图片内容已传给模型；快照不保存图片二进制。"});
    if(block.kind==="thinking")return el("p",{className:"muted small",text:"推理内容未保留"});
    if(block.kind!=="toolCall")return el("p",{className:"message-text",text});
    let call:unknown;try{call=JSON.parse(text);}catch{}
    const result=block.id?paired?.get(block.id):undefined;
    return lazyBlock((block.name||"工具调用")+(result?" · 调用与结果":" · 调用参数"),()=>el("div",{},[
      el("div",{className:"tool-pair"},[el("div",{},[el("h4",{text:"assistant / tool call"}),Check(ToolCallArguments,call)?jsonValue(call.arguments):textPart({text})]),el("div",{},[el("h4",{text:"tool / result"}),result?messageContent(result):el("p",{className:"muted small",text:"本次输入中尚无配对结果"})])])]),true);
  }));
}
export function requestMessages(c:C.Context){
  const paired=new Map<string,C.ContextMessage>();
  for(const message of c.messages)if(message.role==="toolResult"&&message.toolCallId)paired.set(message.toolCallId,message);
  const used=new Set(c.messages.flatMap(m=>(m.blocks||[]).flatMap(b=>b.kind==="toolCall"&&b.id&&paired.has(b.id)?[b.id]:[])));
  const items=c.messages.map((m,i)=>({m,index:i+c.omittedMessages+1})).filter(x=>x.m.role!=="toolResult"||!(x.m.toolCallId&&used.has(x.m.toolCallId)));
  const render=({m,index}:{m:C.ContextMessage;index:number},open=false)=>lazyBlock(index+". "+m.role+(m.toolName?" / "+m.toolName:"")+(m.truncated?" · 已截断":""),()=>messageContent(m,paired),open);
  const node=el("div"),older=items.slice(0,-4),recent=items.slice(-4);
  if(older.length)node.append(lazyBlock("较早的消息 · "+older.length+" 组",()=>el("div",{},older.map(item=>render(item)))));
  node.append(...recent.map(item=>render(item,true)));return node;
}
export function renderRequest(d:C.RequestDetail){
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
  const response=d.response;
  if(response)visual.append(lazyBlock("assistant · "+(r.stopReason||"输出"),()=>messageContent(response),true,"tool-output"));
  else visual.append(el("p",{className:"muted",text:r.status==="running"?"模型生成中…":"未保留模型输出"}));
  if(d.tools?.length){visual.append(el("h3",{className:"detail-section-title",text:"调用后的工具执行"}));d.tools.forEach(t=>visual.append(renderToolTrace(t)));}
  else if(r.toolCalls?.length)visual.append(el("p",{className:"muted small",text:"工具执行结果尚未采集到。"}));
  if(!r.binding)visual.append(el("p",{className:"muted small",text:"这条旧记录没有回合关联，不能准确跳转前后请求或关联工具执行。"}));
  const visualButton=el("button",{className:"btn compact",type:"button",text:"可视化","aria-pressed":"true"}),rawButton=el("button",{className:"btn compact",type:"button",text:"原始快照","aria-pressed":"false"});
  const mode=(showRaw:boolean)=>{visual.hidden=showRaw;raw.hidden=!showRaw;visualButton.setAttribute("aria-pressed",String(!showRaw));rawButton.setAttribute("aria-pressed",String(showRaw));if(showRaw&&!rawBuilt){rawBuilt=true;raw.append(el("pre",{className:"context-note",text:JSON.stringify({context:c,response:d.response,tools:d.tools},null,2)}));}};
  visualButton.addEventListener("click",()=>mode(false));rawButton.addEventListener("click",()=>mode(true));
  const composition=el("section",{},[el("h3",{text:"上下文组成"}),el("div",{className:"muted small",text:"字符占比 · 点击展开"})]);
  const sections: Array<[string,number,HTMLElement]>=[["系统提示",c.chars.system,system],["消息与工具结果",c.chars.messages,messages],["工具定义",c.chars.tools,tools]];
  sections.forEach(([name,value,target])=>composition.append(el("button",{className:"context-jump",type:"button",onclick:()=>{mode(false);if(target instanceof HTMLDetailsElement)target.open=true;target.scrollIntoView({block:"nearest"});}},[el("div",{className:"row"},[name,el("span",{text:total?percent(value/total):"—"})]),el("div",{className:"meter"},[el("span",{style:"width:"+(total?value/total*100:0)+"%"})]),el("small",{text:nf(value)+" 字符"})])));
  const ratio=cacheRate(r),cacheValues: Array<[string,number|null]>=[["缓存读取",r.cacheRead],["未命中输入",ratio===null||r.inputTokens===null||r.cacheRead===null?null:r.inputTokens-r.cacheRead],["其中缓存写入",r.cacheWrite]];
  const cache=el("section",{className:"cache-breakdown"},[el("h3",{text:"输入缓存"}),el("div",{className:"meter"},[el("span",{style:"width:"+(ratio===null?0:ratio*100)+"%"})]),...cacheValues.map(([label,value])=>el("div",{},[label,el("span",{text:nf(value)})])),el("p",{className:"muted small",text:"命中率 = 缓存读取 / 总输入。仅有请求级总量，无法确定哪条消息命中了缓存。"})]);
  const windowInfo=el("section",{},[el("h3",{text:"上下文窗口"}),el("p",{className:"small",text:(r.inputTokens!=null&&r.contextWindow?percent(r.inputTokens/r.contextWindow):"—")+" / "+compact(r.contextWindow)+" token"}),el("div",{className:"meter"},[el("span",{style:"width:"+(r.inputTokens&&r.contextWindow?Math.min(100,r.inputTokens/r.contextWindow*100):0)+"%"})]),el("p",{className:"muted small",text:"组成按文本字符统计，图片不参与字符占比。"})]);
  body.append(el("div",{className:"detail-explorer"},[el("aside",{className:"detail-map"},[composition,cache,windowInfo]),el("div",{className:"detail-content"},[el("div",{className:"detail-toolbar"},[el("h3",{text:"请求输入"}),el("div",{className:"detail-mode"},[visualButton,rawButton])]),visual,raw])]));
}
export async function openRequest(id:string){
  const version=++cs.detailVersion,epoch=cs.epoch;cs.detailId=id;
  $("detail-id").textContent=id;$("detail-body").replaceChildren(el("p",{className:"muted",text:"正在读取请求详情…"}));
  if(!$("request-detail").open)$("request-detail").showModal();
  try{
    const d=detailCache.get(id)||await readApi(C.RequestDetail,"GET","/admin/requests/"+encodeURIComponent(id));
    if(version!==cs.detailVersion||epoch!==cs.epoch)return;
    if(d.request.status!=="running"&&!(d.tools||[]).some(t=>t.status==="running")&&(d.request.toolCalls||[]).every(c=>(d.tools||[]).some(t=>t.callId===c.id)))detailCache.set(id,d);
    renderRequest(d);
  }catch(error){if(version===cs.detailVersion)$("detail-body").replaceChildren(el("p",{text:"详情读取失败，请关闭后重试。"}));fail(error);}
}
