import { contextInspector } from "./context-detail";
import { $, bjTime, duration, el, fail } from "./app";
import * as C from "./request-contracts";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { readApi } from "./api";
import { chooseChat, chooseSubagent, consoleView, cs, nf, purposes, requestPill, statuses } from "./console";
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
export function renderRequest(d:C.RequestDetail){
  const r=d.request,body=$("detail-body");cs.detailId=r.id;$("detail-id").textContent=r.model+" · "+r.id+" · "+bjTime(r.startedAt);
  body.replaceChildren();
  if(d.related?.length>1)body.append(el("nav",{className:"request-round","aria-label":"本轮模型请求"},d.related.map((item,i)=>el("button",{className:"btn",type:"button","aria-current":String(item.id===r.id),onclick:()=>openRequest(item.id)},["请求 #"+(i+1)+" · "+(statuses[item.status]||item.status),el("small",{text:item.model+" · 缓存 "+percent(cacheRate(item))})]))));
  body.append(el("div",{className:"row"},[requestPill(r.status),el("span",{className:"muted small",text:r.thread+" / "+(purposes[r.purpose]||r.purpose)}),el("button",{className:"request-link",type:"button",text:"定位到对话",onclick:()=>{$("request-detail").close();if(r.actor==="thread"){chooseChat(r.thread);consoleView("chat");cs.locateTurn=r.binding?.turnId;}else chooseSubagent(r.thread,r.actor,"");}})]),
    el("div",{className:"detail-stats"},[["输入 token",nf(r.inputTokens)],["输出 token",nf(r.outputTokens)],["缓存命中率",percent(cacheRate(r))],["模型耗时",duration(r.durationMs)]].map(([name,value])=>el("div",{className:"metric-label"},[name,el("strong",{text:value})]))));
  if(r.error)body.append(el("pre",{className:"context-note",text:r.error}));
  body.append(contextInspector(d));
}
export async function openRequest(id:string){
  const version=++cs.detailVersion,epoch=cs.epoch;cs.detailId=id;
  $("detail-id").textContent=id;$("detail-body").replaceChildren(el("p",{className:"muted",text:"正在读取请求详情…"}));
  if(!$("request-detail").open)$("request-detail").showModal();
  try{
    const d=detailCache.get(id)||await readApi(C.RequestDetail,"GET","/admin/requests/"+encodeURIComponent(id)+"?summary=1");
    if(version!==cs.detailVersion||epoch!==cs.epoch)return;
    if(d.request.status!=="running"&&!(d.tools||[]).some(t=>t.status==="running")&&(d.request.toolCalls||[]).every(c=>(d.tools||[]).some(t=>t.callId===c.id)))detailCache.set(id,d);
    renderRequest(d);
  }catch(error){if(version===cs.detailVersion)$("detail-body").replaceChildren(el("p",{text:"详情读取失败，请关闭后重试。"}));fail(error);}
}
