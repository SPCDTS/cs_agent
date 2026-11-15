import { $, el, fail, notice, state, time } from "./app";
import { input, pill } from "./dom";
import { api, ApiError, readApi } from "./api";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import * as C from "./app-contracts";
import { MemoryDetailSchema, MemoryJobsSchema, MemoryProposalsSchema, MemoryCandidatesSchema } from "./history-contracts";
import { MemoryEditorSchema, CandidateInputSchema } from "../src/memory/editor";
import { parseMemoryTime, formatBeijingTime } from "../src/memory/time";
import { ADMIN_PAGE_SIZE } from "../src/admin/pagination";
import { paginatedBlock } from "./pagination";

type Row = Static<typeof C.MemoryRow>;
type Detail = Static<typeof MemoryDetailSchema>;
const kinds: Record<string,string> = {fact:"事实",preference:"偏好",rule:"要求",commitment:"承诺 / 待办",episode:"经历"};
const authors:Record<string,string>={dashboard:"管理台",admin:"管理台",extractor:"自动抽取",import:"导入"};
const authorName = (author:string) => (authors[author]??(author.startsWith("qq:")?"会话显式记录 · "+author:author));
const statuses: Record<string,string> = {active:"活跃",superseded:"已替代",retired:"已归档",orphaned:"来源已撤回",forgotten:"已遗忘"};
export const mm = {page:1,key:"",total:0,version:0,loadVersion:0,loadedNs:""};
const drafts = new Map<string,{text:string;revision:string}>();
let sessionVersion=0;
let editing: {ns:string;revision:string} | null = null;
const query = (ns:string) => "?ns="+encodeURIComponent(ns);
const humanScope = (ns:string) => state.overview?.threads.find(t=>t.key===ns)?.name || (ns==="owner"?"主人会话":ns);
const dateText = (value:number|null|undefined) => value==null?"未设置":time(value*1000);
function validity(row:Row) {
  if(row.status!=="active")return statuses[row.status]||row.status;
  if(row.kind==="commitment" && row.done_at!=null)return "已完成";
  const now=Date.now()/1000;
  if(row.kind!=="episode"&&row.until!=null&&row.until<=now)return "已过期";
  if(row.since!=null&&row.since>now)return "尚未生效";
  if(row.kind==="commitment"&&row.due_at!=null&&row.due_at<now)return "承诺已逾期";
  return "当前有效";
}
function keepDraft() {if(editing)drafts.set(editing.ns,{text:$("profile-edit").value,revision:editing.revision});}
function profileEdit(enabled:boolean) {
  if(!enabled)keepDraft();
  editing=enabled&&state.profile?{ns:state.memoryNs,revision:drafts.get(state.memoryNs)?.revision??state.profile.revision}:null;
  $("profile-edit").hidden=!editing;$("profile-save").hidden=!editing;$("profile-text").hidden=!!editing;
  $("profile-toggle").textContent=editing?"收起草稿":"编辑画像";
  if(editing)$("profile-edit").value=drafts.get(editing.ns)?.text??state.profile?.text??"";
}
export function resetMemory() {
  sessionVersion++;profileEdit(false);mm.loadVersion++;mm.version++;mm.loadedNs="";mm.key="";drafts.clear();
  $("profile-edit").value="";$("profile-text").textContent="";$("profile-review").hidden=true;$("profile-sources").replaceChildren();
  $("memory-detail").close();state.memoryView=null;state.profile=null;
}
export async function loadMemory() {
  const ns=state.memoryNs,p=new URLSearchParams({ns,q:state.memoryQuery,status:$("mem-status").value});
  for(const key of ["kind","validity","source"])if(input("mem-"+key).value)p.set(key,input("mem-"+key).value);
  const key=p.toString();if(key!==mm.key){mm.page=1;mm.key=key;}
  const page=mm.page,version=++mm.loadVersion;
  p.set("page",String(page));p.set("limit",String(ADMIN_PAGE_SIZE));
  mm.loadedNs="";$("mem-title").textContent="记忆 · "+humanScope(ns);
  $("mem-meta").textContent="正在载入…";$("memories").replaceChildren();
  $("mem-prev").disabled=true;$("mem-next").disabled=true;$("profile-toggle").disabled=true;
  try {
    const [base,list]=await Promise.all([readApi(C.MemoryView,"GET","/admin/memory"+query(ns)),readApi(C.MemoryList,"GET","/admin/memory/list?"+p)]);
    if(version!==mm.loadVersion||ns!==state.memoryNs)return;
    mm.loadedNs=ns;mm.total=list.total;state.memoryView={...base,memories:list.items};state.profile=base.profile;
    $("mem-meta").textContent="共 "+list.total+" 条";
    $("mem-page").textContent="第 "+page+" 页 · 共 "+list.total+" 条";
    $("mem-prev").disabled=page<=1;$("mem-next").disabled=page*ADMIN_PAGE_SIZE>=list.total;
    $("profile-toggle").disabled=false;
    $("profile-meta").textContent=base.profile.review?"待复核 · 暂停使用":base.profile.text?"每轮使用 · "+new TextEncoder().encode(base.profile.text).byteLength+" / 4096 字节":"未创建";
    $("profile-review").hidden=!base.profile.review;$("profile-review").textContent=base.profile.review??"";
    $("profile-text").textContent=base.profile.text||"保存长期偏好与要求，或在“待确认与整理”中生成画像建议。";
    $("profile-sources").replaceChildren(...(base.profile.sources??[]).slice(0,12).map(id=>el("button",{className:"btn compact",text:"依据 #"+id,onclick:()=>memoryDetail(id,ns)})));
    if((base.profile.sources?.length??0)>12)$("profile-sources").append(el("span",{text:"共 "+base.profile.sources!.length+" 条依据"}));
    if(!list.items.length){$("memories").append(el("tr",{},[el("td",{colspan:5,text:"没有匹配的记忆。可调整筛选，或新增一条记忆。",className:"muted"})]));return;}
    $("memories").replaceChildren(...list.items.map(row=>el("tr",{},[
      el("td",{text:"#"+row.id}),el("td",{},[pill(kinds[row.kind]||row.kind,"neutral")]),
      el("td",{className:"cell-text"},[el("div",{text:row.text}),el("div",{className:"muted small",text:row.subject?"对象："+row.subject:"未指定对象"})]),
      el("td",{},[el("div",{text:row.author==="extractor"?"自动抽取":"显式记录"}),el("div",{className:"small muted",text:validity(row)}),el("div",{className:"small muted",text:dateText(row.updated_at)})]),
      el("td",{},[el("button",{className:"btn compact",text:"查看 / 编辑",onclick:()=>memoryDetail(row.id,ns)})])
    ])));
  } catch(error) {if(version===mm.loadVersion){$("mem-meta").textContent="载入失败，请刷新重试";fail(error);}}
}
function facts(items:readonly (readonly [string,string])[]) {
  return el("dl",{className:"memory-facts"},items.flatMap(([name,value])=>[el("dt",{text:name}),el("dd",{text:value})]));
}
function parsed(raw:string):unknown {try{return JSON.parse(raw);}catch{return null;}}
function snapshot(raw:string|null) {const value=raw?parsed(raw):null;return Check(C.MemoryRow,value)?value:null;}
function diff(before:Row|null,after:Row) {
  const fields = ["text","kind","subject","status","since","until","due_at","done_at"] as const;
  const labels={text:"内容",kind:"类型",subject:"对象",status:"状态",since:"生效 / 发生时间",until:"失效时间",due_at:"截止时间",done_at:"完成时间"};
  const lines=fields.filter(key=>before?.[key]!==after[key]);
  const format=(row:Row|null,key:typeof fields[number])=>row===null?"未创建":key.endsWith("_at")||key==="since"||key==="until"?dateText(typeof row[key]==="number"?row[key]:null):key==="kind"?(kinds[row.kind]??row.kind):key==="status"?(statuses[row.status]??row.status):String(row[key]??"未设置");
  return el("div",{className:"memory-diff"},[el("div",{},[el("strong",{text:"变更前"}),el("pre",{text:lines.map(k=>labels[k]+"："+format(before,k)).join("\n")})]),el("div",{},[el("strong",{text:"变更后"}),el("pre",{text:lines.map(k=>labels[k]+"："+format(after,k)).join("\n")})])]);
}
async function mutate(ns:string,method:string,path:string,data:unknown,done:string,version:number) {
  const buttons=[...$("memory-detail-body").querySelectorAll("button")];buttons.forEach(b=>b.disabled=true);
  try {await api(method,path+query(ns),data);notice(done);if(version===mm.version)$("memory-detail").close();if(ns===state.memoryNs)await loadMemory();}
  catch(error){buttons.forEach(b=>b.disabled=false);if(error instanceof ApiError&&error.status===409)notice("内容已变化，请关闭详情并重新打开。当前编辑内容已保留。");else fail(error);}
}
export async function memoryDetail(id:number,ns=state.memoryNs) {
  const version=++mm.version;
  try {
    const value=await readApi(MemoryDetailSchema,"GET","/admin/memory/"+id+query(ns));
    if(version!==mm.version||ns!==state.memoryNs)return;
    const row=value.row;
    $("memory-detail-title").textContent="记忆 #"+id+" · "+humanScope(ns);
    const actions=el("div",{className:"row"});
    if(row.status==="active") {
      actions.append(el("button",{className:"btn primary",text:"编辑记忆",onclick:()=>memoryEditor(ns,value)}),el("button",{className:"btn danger",text:"遗忘（可恢复）",onclick:()=>{
        if(confirm("遗忘这条记忆？相关画像可能需要复核，历史版本仍保留。"))void mutate(ns,"DELETE","/admin/memory/"+id,{expectedVersion:value.revision},"已遗忘记忆 #"+id,version);
      }}));
      if(row.kind==="commitment"&&row.done_at==null)actions.append(el("button",{className:"btn",text:"标记完成",onclick:()=>mutate(ns,"PUT","/admin/memory/"+id,{expectedVersion:value.revision,entry:{text:row.text,kind:row.kind,done_at:Math.floor(Date.now()/1000)}},"承诺已完成",version)}));
    }
    if(row.status==="forgotten")actions.append(el("button",{className:"btn",text:"恢复记忆",onclick:()=>mutate(ns,"POST","/admin/memory/"+id+"/restore",{expectedVersion:value.revision},"记忆已恢复",version)}));
    const source=el("section",{},[el("h3",{text:"来源依据"})]);
    if(value.evidence?.length)for(const e of value.evidence)source.append(el("p",{className:"muted small",text:e.scope+" · 消息 #"+e.message_id+" · 发言人 "+e.speaker}),el("blockquote",{className:"memory-evidence",text:e.quote}));
    else source.append(el("p",{text:row.source_scope?row.source_scope+" · 消息 #"+(row.source_message_id||"未知")+"（未保存证据片段）":"手动录入或历史导入，未保存原始消息。"}));
    const versions=value.versions.map(v=>{const after=snapshot(v.after_json);return el("details",{className:"context-part"},[
      el("summary",{text:dateText(v.at)+" · "+authorName(v.by)+" · "+(v.reason||"修改")}),after?diff(snapshot(v.before_json),after):el("p",{text:"旧版本格式暂不能显示差异"}),
      el("button",{className:"btn",text:"恢复此版本",onclick:()=>{if(confirm("恢复为这个版本？"))void mutate(ns,"POST","/admin/memory/"+id+"/restore",{expectedVersion:value.revision,versionId:v.id},"已恢复历史版本",version);}}),
      el("details",{},[el("summary",{text:"原始记录"}),el("pre",{text:v.after_json})])]);});
    $("memory-detail-body").replaceChildren(el("p",{className:"profile-text",text:row.text}),actions,facts([
      ["类型 / 状态",(kinds[row.kind]||row.kind)+" / "+validity(row)],["对象",row.subject||"未指定"],["写入方式",authorName(row.author)],
      ["画像依据",value.inProfile?"已关联；条目变化后需复核画像":"未关联"],["生效 / 发生",dateText(row.since)],["失效",dateText(row.until)],
      ["截止",dateText(row.due_at)],["完成",dateText(row.done_at)],["召回次数",String(row.recall_count??0)]
    ]),source,el("h3",{text:"关联记忆"}),el("div",{className:"row"},value.links.length?value.links.map(link=>el("button",{className:"btn",text:(link.rel==="supersedes"?(link.from_id===id?"替代了 ":"被替代于 "):"相关 ")+"#"+(link.from_id===id?link.to_id:link.from_id),onclick:()=>memoryDetail(link.from_id===id?link.to_id:link.from_id,ns)})):[el("span",{className:"muted",text:"暂无关联"})]),el("h3",{text:"版本差异"}),paginatedBlock("memory-versions:"+ns+":"+id,versions));
    if(!$("memory-detail").open)$("memory-detail").showModal();
  }catch(error){if(version===mm.version)fail(error);}
}
export function memoryEditor(ns:string,value?:Detail) {
  const version=++mm.version,row=value?.row,form=el("form",{className:"memory-edit-grid"}),fields=new Map<string,HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>();
  const field=(name:string,label:string,node:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,full=false)=>{fields.set(name,node);node.setAttribute("aria-label",label);form.append(el("label",{className:"field"+(full?" full":"")},[el("span",{text:label}),node]));};
  const text=el("textarea",{maxlength:500,required:true});text.value=row?.text??"";field("text","记忆内容",text,true);
  const kind=el("select",{},Object.entries(kinds).map(([key,label])=>el("option",{value:key,text:label})));kind.value=row?.kind??"fact";field("kind","类型",kind);
  const subject=el("input",{type:"text",maxlength:40,value:row?.subject??"",placeholder:"self、qq:账号或对象名称"});field("subject","对象",subject);
  for(const [name,label] of [["since","生效 / 发生时间"],["until","失效时间"],["due_at","承诺截止时间"],["done_at","承诺完成时间"]] as const){
    const date=el("input",{type:"text",placeholder:"YYYY-MM-DD HH:mm（北京时间）",value:row?.[name]==null?"":formatBeijingTime(row[name]*1000)});field(name,label,date);
  }
  const updateDates=()=>{for(const name of ["due_at","done_at"])fields.get(name)!.disabled=kind.value!=="commitment";};kind.addEventListener("change",updateDates);updateDates();
  const result=el("p",{className:"full muted small",role:"status",text:"记录承诺不会自动创建定时提醒。所有时间均为北京时间。"});
  const save=el("button",{type:"submit",className:"btn primary",text:"保存记忆"});form.append(result,save);
  form.addEventListener("submit",async event=>{
    event.preventDefault();if(save.disabled)return;
    try{
      const entry:Record<string,unknown>={text:text.value.trim(),kind:kind.value,subject:subject.value.trim()||null};
      for(const name of ["since","until","due_at","done_at"]){const f=fields.get(name)!;entry[name]=f.disabled||!f.value.trim()?null:parseMemoryTime(f.value.trim());}
      if(!Check(MemoryEditorSchema,entry))throw new Error("请检查记忆内容、类型和日期。");
      save.disabled=true;
      await api(value?"PUT":"POST",(value?"/admin/memory/"+value.row.id:"/admin/memory/entries")+query(ns),value?{entry,expectedVersion:value.revision}:entry);
      notice("记忆已保存");if(version===mm.version)$("memory-detail").close();if(ns===state.memoryNs)await loadMemory();
    }catch(error){result.textContent=error instanceof ApiError&&error.status===409?"记忆已被修改。草稿已保留，请核对最新内容后再编辑。":error instanceof Error&&! (error instanceof ApiError)?error.message:"保存失败，请检查输入后重试。";save.disabled=false;}
  });
  $("memory-detail-title").textContent=(value?"编辑记忆 #"+value.row.id:"新增记忆")+" · "+humanScope(ns);$("memory-detail-body").replaceChildren(form);
  if(!$("memory-detail").open)$("memory-detail").showModal();
}
const OperationResult=Type.Object({result:Type.Optional(Type.String()),status:Type.Optional(Type.String()),restored:Type.Optional(Type.Number()),skipped:Type.Optional(Type.Number())});
const outcomeNames:Record<string,string>={created:"已生成画像建议，请比较后采纳",below_threshold:"有效条目不足，未生成画像建议",unchanged:"依据未变化，已有建议仍可使用",timeout:"模型超时，请稍后重试",model_error:"模型调用失败，请稍后重试",invalid_json:"模型返回格式无效，未应用修改",oversize:"画像超过长度限制，未应用修改",secret:"内容未通过凭据检查，未应用修改",changed:"生成期间依据发生变化，请重新生成",accepted:"已采纳",rejected:"已拒绝",ok:"整理已完成",failed:"整理部分失败，请查看报告",skipped:"没有需要整理的记忆"};
function outcome(value:unknown) {if(!Check(OperationResult,value))return "请求已完成";if(value.restored!==undefined)return "已回滚 "+value.restored+" 条，跳过 "+(value.skipped??0)+" 条后续已修改的记忆";return outcomeNames[value.result??value.status??""]??"请求已完成";}
const Report=Type.Object({dedup:Type.Optional(Type.Number()),orphaned:Type.Optional(Type.Number()),retired:Type.Optional(Type.Number()),failed:Type.Optional(Type.Array(Type.String())),conflicts:Type.Optional(Type.Object({superseded:Type.Number(),protected:Type.Number(),skipped:Type.Optional(Type.String())}))});
export async function memoryJobs(ns=state.memoryNs) {
  const version=++mm.version;
  try {
    const [jobs,proposals,candidates,base]=await Promise.all([readApi(MemoryJobsSchema,"GET","/admin/memory/jobs"+query(ns)),readApi(MemoryProposalsSchema,"GET","/admin/memory/proposals"+query(ns)),readApi(MemoryCandidatesSchema,"GET","/admin/memory/candidates"+query(ns)),readApi(C.MemoryView,"GET","/admin/memory"+query(ns))]);
    if(version!==mm.version||ns!==state.memoryNs)return;
    const progress=el("p",{className:"muted small",role:"status",text:"整理与生成建议会调用模型；冲突和画像均需确认后应用。"});
    const action=async(path:string,data:unknown={})=>{
      const buttons=[...$("memory-detail-body").querySelectorAll("button")];buttons.forEach(b=>b.disabled=true);progress.textContent="正在处理，请稍候…";
      try{const result=await api("POST",path+query(ns),data);notice(outcome(result));if(ns===state.memoryNs)await loadMemory();if(version===mm.version)await memoryJobs(ns);}
      catch(error){buttons.forEach(b=>b.disabled=false);progress.textContent=error instanceof ApiError&&error.status===409?"依据已变化，本次没有应用修改。请刷新并重新确认。":"操作失败，请稍后重试。";}
    };
    const pending=candidates.candidates.map(c=>{
      const data=parsed(c.input_json);if(!Check(CandidateInputSchema,data))return el("p",{text:"候选 #"+c.id+" 格式不受支持"});
      return el("section",{className:"context-part"},[el("p",{text:data.text}),el("p",{className:"muted small",text:"自动抽取建议替代显式记忆 #"+c.target_id+" · "+dateText(c.created_at)}),el("div",{className:"row"},[
        el("button",{className:"btn",text:"查看原记忆 #"+c.target_id,onclick:()=>memoryDetail(c.target_id,ns)}),
        el("button",{className:"btn",text:"确认更正",onclick:()=>action("/admin/memory/candidates/"+c.id+"/accept")}),el("button",{className:"btn",text:"保留原记忆",onclick:()=>action("/admin/memory/candidates/"+c.id+"/reject")})])]);
    });
    const suggestions=proposals.proposals.map(p=>el("section",{className:"context-part"},[
      el("div",{className:"memory-diff"},[el("div",{},[el("strong",{text:"当前画像"}),el("pre",{text:base.profile.text||"尚未创建"})]),el("div",{},[el("strong",{text:"建议画像"}),el("pre",{text:p.text})])]),
      el("div",{className:"row"},[el("button",{className:"btn",text:"采纳画像",disabled:p.based_on_revision!==base.profile.revision,onclick:()=>action("/admin/memory/proposals/"+p.id+"/accept",{expectedRevision:p.based_on_revision})}),el("button",{className:"btn",text:"拒绝建议",onclick:()=>action("/admin/memory/proposals/"+p.id+"/reject",{expectedRevision:base.profile.revision})})])
    ]));
    const history=jobs.jobs.map(j=>{const report=parsed(j.report_json??"null");return el("section",{className:"context-part"},[
      el("p",{text:time(j.started_at)+" · "+({running:"正在整理",ok:"完成",failed:"部分失败",interrupted:"已中断"}[j.status]??j.status)}),
      Check(Report,report)?el("p",{text:"去重 "+(report.dedup??0)+" 条；替代 "+(report.conflicts?.superseded??0)+" 条；归档 "+(report.retired??0)+" 条；来源失效 "+(report.orphaned??0)+" 条。"+(report.failed?.length?"失败步骤："+report.failed.join("、"):"")+(report.conflicts?.skipped?"冲突检查："+(outcomeNames[report.conflicts.skipped]??report.conflicts.skipped):"")}):el("p",{text:"暂无整理报告"}),
      j.status!=="running"?el("button",{className:"btn",text:"回滚此批次",onclick:()=>{if(confirm("回滚本批次尚未被后续修改的条目？"))void action("/admin/memory/jobs/"+j.id+"/rollback");}}):null,
      el("details",{},[el("summary",{text:"原始报告"}),el("pre",{text:j.report_json??"暂无报告"})])]);});
    $("memory-detail-title").textContent="待确认与整理 · "+humanScope(ns);
    $("memory-detail-body").replaceChildren(el("div",{className:"row"},[el("button",{className:"btn",text:"整理记忆",onclick:()=>action("/admin/memory/consolidate")}),el("button",{className:"btn",text:"生成画像建议",onclick:()=>action("/admin/memory/proposals")})]),progress,
      el("h3",{text:"待确认冲突（"+pending.length+"）"}),pending.length?paginatedBlock("memory-candidates:"+ns,pending):el("p",{className:"muted",text:"没有待确认冲突"}),
      el("h3",{text:"画像建议"}),suggestions.length?paginatedBlock("memory-proposals:"+ns,suggestions):el("p",{className:"muted",text:"暂无建议，可以手动生成"}),
      el("h3",{text:"整理历史"}),history.length?paginatedBlock("memory-jobs:"+ns,history):el("p",{className:"muted",text:"尚未执行整理"}));
    if(!$("memory-detail").open)$("memory-detail").showModal();
  }catch(error){if(version===mm.version)fail(error);}
}
async function saveProfile() {
  if(!editing)return;const session=sessionVersion;const draft={...editing,text:$("profile-edit").value};keepDraft();$("profile-save").disabled=true;
  try {
    await api("PUT","/admin/memory/profile",{ns:draft.ns,text:draft.text,expected:draft.revision});
    if(session!==sessionVersion)return;
    drafts.delete(draft.ns);if(editing?.ns===draft.ns){editing=null;profileEdit(false);}notice("画像已保存");if(draft.ns===state.memoryNs)await loadMemory();
  }catch(error){
    if(session!==sessionVersion)return;
    if(error instanceof ApiError&&error.status===409&&Check(C.Profile,error.body?.current)){
      const current=error.body.current;drafts.set(draft.ns,{text:draft.text,revision:current.revision});
      if(draft.ns!==state.memoryNs)return;
      state.profile=current;
      $("profile-text").hidden=false;$("profile-text").textContent="当前已保存版本：\n"+current.text;
      if(editing?.ns===draft.ns){editing.revision=current.revision;drafts.set(draft.ns,{text:draft.text,revision:current.revision});}
      notice("画像已被修改。草稿已保留，请比较当前版本，合并后再保存。");
    }else fail(error);
  }finally{$("profile-save").disabled=false;}
}
export function initMemory() {
  for(const id of ["mem-status","mem-kind","mem-validity","mem-source"])$(id).addEventListener("change",()=>{mm.page=1;void loadMemory();});
  $("mem-prev").addEventListener("click",()=>{mm.page=Math.max(1,mm.page-1);void loadMemory();});
  $("mem-next").addEventListener("click",()=>{mm.page++;void loadMemory();});
  $("mem-jobs").addEventListener("click",()=>void memoryJobs());
  $("mem-refresh").addEventListener("click",()=>void loadMemory());
  $("mem-add").addEventListener("click",()=>memoryEditor(state.memoryNs));
  $("memory-detail-close").addEventListener("click",()=>{$("memory-detail").close();mm.version++;});
  $("memory-detail").addEventListener("cancel",()=>{mm.version++;});
  $("mem-ns").addEventListener("change",()=>{profileEdit(false);mm.version++;$("memory-detail").close();state.memoryNs=$("mem-ns").value;state.profile=null;$("profile-text").textContent="";$("profile-review").hidden=true;$("profile-sources").replaceChildren();void loadMemory();});
  const search=()=>{state.memoryQuery=$("mem-q").value.trim();void loadMemory();};
  $("mem-q").addEventListener("keydown",event=>{if(event.key==="Enter")search();});$("mem-q").addEventListener("search",search);
  $("profile-toggle").addEventListener("click",()=>profileEdit(!editing));$("profile-save").addEventListener("click",()=>void saveProfile());
  $("profile-edit").addEventListener("input",keepDraft);
}
