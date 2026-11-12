import { $, input, ApiError, api, el, fail, show, time } from "./app";
import { readApi } from "./api";
import { PersonaSchema, PersonaSavedSchema, GrantsSchema, OpsSchema, OpsSavedSchema, AlertsSchema, DeliveriesSchema, ReconciledSchema, type Persona, type OpsSnapshot, type MaintenanceOverride } from "./integration-contracts";
import { listPager, paginateChildren, renderListPager } from "./pagination";
import { cs } from "./console";
type PageState = { cursor: string | undefined; history: Array<string | undefined>; version: number };
export const accessState: { persona: Persona | null; ops: OpsSnapshot | null; overrides: Record<string, MaintenanceOverride>; alerts: PageState; deliveries: PageState }={persona:null,ops:null,overrides:{},alerts:{cursor:undefined,history:[],version:0},deliveries:{cursor:undefined,history:[],version:0}};
export const accessLimitNames: Array<keyof OpsSnapshot["value"]["sendLimits"]>=["perChatMinute","perChatHour","chatBreakerMinutes","globalMinute","globalBreakerMinutes"];
export const accessRetentionNames: Array<Exclude<keyof MaintenanceOverride,"consolidate">>=["rawDays","rawHardMaxDays","summaryDays","eventsDays"];
export const accessRetentionLabels={rawDays:"原文",rawHardMaxDays:"原文上限",summaryDays:"摘要",eventsDays:"事件"};
export const accessStates: Record<string,string>={queued:"等待发送",sending:"等待回执",sent:"已确认",unknown:"结果不明",failed:"失败",rejected:"已拒绝",panel:"仅面板",pending:"待通知",resolved:"已恢复"};
export const accessErrors: Record<string,string>={delivery_evidence_expired:"查证资料已到期",delivery_source_revoked:"原始输入或权限已失效",session_generation_revoked:"会话已切换",owner_alert_disabled:"owner 告警已关闭",delivery_operation_expired:"操作已过期"};
export const accessWords=(text: string)=>text.split(/[\s,，]+/).map(value=>value.trim()).filter(Boolean);
export const accessCell=(text: string)=>el("td",{text,className:"cell-text"});
export function accessEmpty(id: string,count: number,text="暂无记录"){$(id).replaceChildren(el("tr",{},[el("td",{colspan:count,text:text||"暂无记录",className:"muted"})]));}
export async function accessRun(button: HTMLButtonElement | null,action: ()=>Promise<unknown>){
  if(button)button.disabled=true;
  try{await action();}catch(error){
    if(error instanceof ApiError&&error.status===409)show("数据已有其他修改。请手动刷新，核对后再保存。","error");else fail(error);
  }finally{if(button)button.disabled=false;}
}
export async function loadAccessPersona(){
  const value=await readApi(PersonaSchema,"GET","/admin/persona");accessState.persona=value;
  $("access-persona").value=value.text;$("access-persona-revision").textContent="修订 "+value.revision.slice(0,8);$("access-persona-save").disabled=false;
}
export async function loadAccessGrants(){
  const data=await readApi(GrantsSchema,"GET","/admin/grants"),body=$("access-grants");body.replaceChildren();
  for(const grant of data.grants){
    const revoke=el("button",{type:"button",className:"btn danger compact",text:"撤销"});
    revoke.addEventListener("click",()=>accessRun(revoke,async()=>{await api("POST","/admin/grants/revoke",{user:grant.user});await loadAccessGrants();show("授权已撤销","info");}));
    const targets=grant.targets.length?grant.targets.join("、"):"无主动发送目标",scopes=grant.scopes===undefined?"任意来源":grant.scopes.length?grant.scopes.join("、"):"无允许来源";
    body.append(el("tr",{},[accessCell(grant.user),accessCell(grant.caps.map(cap=>cap==="send"?"主动发送":"定时").join("、")),accessCell(targets+" / "+scopes),accessCell((grant.expired?"已过期 · ":"")+(grant.expires_at?time(grant.expires_at):"长期")),el("td",{},[revoke])]));
  }
  if(!data.grants.length)accessEmpty("access-grants",5);
  paginateChildren($("access-grants"));
}
export function renderAccessOverrides(){
  const body=$("access-overrides");body.replaceChildren();
  for(const [thread,value] of Object.entries(accessState.overrides)){
    const parts=accessRetentionNames.filter(name=>value[name]!==undefined).map(name=>accessRetentionLabels[name]+" "+value[name]+" 天");
    if(value.consolidate!==undefined)parts.push("整理"+(value.consolidate?"开启":"关闭"));
    const remove=el("button",{type:"button",className:"btn compact",text:"移除"});remove.addEventListener("click",()=>{delete accessState.overrides[thread];renderAccessOverrides();});
    body.append(el("tr",{},[accessCell(thread),accessCell(parts.join("，")||"沿用全局"),el("td",{},[remove])]));
  }
  if(!Object.keys(accessState.overrides).length)accessEmpty("access-overrides",3,"全部会话沿用全局默认");
  paginateChildren($("access-overrides"));
}
export async function loadAccessOps(){
  const snapshot=await readApi(OpsSchema,"GET","/admin/ops-settings"),value=snapshot.value;accessState.ops=snapshot;accessState.overrides=structuredClone(value.threads);
  for(const name of accessLimitNames)input("access-limit-"+name).value=String(value.sendLimits[name]);
  for(const name of accessRetentionNames)input("access-default-"+name).value=String(value.defaults[name]);
  $("access-default-consolidate").checked=value.defaults.consolidate;$("access-alert-owner").checked=value.alertOwner;
  $("access-alert-throttle").value=String(value.alertThrottleMinutes);$("access-owner-throttle").value=String(value.ownerAlertThrottleMinutes);
  $("access-ops-revision").textContent="修订 "+snapshot.revision.slice(0,8);$("access-ops-save").disabled=false;renderAccessOverrides();
}
export async function accessPage<T extends {next?:string}>(kind: "alerts"|"deliveries",load: (path:string)=>Promise<T>,render: (data:T)=>void,reset=false){
  const state=accessState[kind],version=++state.version,epoch=cs.epoch;
  for(const button of listPager($("access-"+kind)).querySelectorAll("button"))button.disabled=true;
  if(reset){state.cursor=undefined;state.history=[];}
  const data=await load("/admin/"+kind+(state.cursor?"?cursor="+encodeURIComponent(state.cursor):""));
  if(version!==state.version||epoch!==cs.epoch)return;
  render(data);
  renderListPager($("access-"+kind),state.history.length+1,!!data.next,
    ()=>{state.cursor=state.history.pop();accessPage(kind,load,render).catch(fail);},
    ()=>{state.history.push(state.cursor);state.cursor=data.next;accessPage(kind,load,render).catch(fail);});
}
export async function loadAccessAlerts(reset=false){
  return accessPage("alerts",path=>readApi(AlertsSchema,"GET",path),data=>{
  const body=$("access-alerts");body.replaceChildren();
  for(const alert of data.alerts)body.append(el("tr",{},[accessCell(time(alert.updatedAt)+" / "+alert.scope),accessCell(alert.origin==="web"?"网页（仅面板）":"QQ"),accessCell(alert.message),accessCell((accessStates[alert.status]||alert.status)+(alert.closedAt?" · 已恢复":""))]));
  if(!data.alerts.length)accessEmpty("access-alerts",4);
  },reset);
}
export async function loadAccessDeliveries(reset=false){
  return accessPage("deliveries",path=>readApi(DeliveriesSchema,"GET",path),data=>{
  const body=$("access-deliveries");body.replaceChildren();
  for(const delivery of data.deliveries){
    const actions=el("td");
    if(delivery.state==="unknown"&&delivery.error!=="delivery_evidence_expired"){
      const reconcile=el("button",{type:"button",className:"btn compact",text:"读取历史查证"});
      reconcile.addEventListener("click",()=>accessRun(reconcile,async()=>{
        const result=await readApi(ReconciledSchema,"POST","/admin/deliveries/"+encodeURIComponent(delivery.id)+"/reconcile");await loadAccessDeliveries();
        show(result.state==="sent"?"已通过历史记录确认发送":"尚无可靠证据，继续保留结果不明状态","info");
      }));actions.append(reconcile);
    }
    body.append(el("tr",{},[accessCell(time(delivery.createdAt)+" / "+delivery.id),accessCell(accessStates[delivery.state]||delivery.state),accessCell(delivery.messageId||(delivery.error?(accessErrors[delivery.error]||delivery.error):"")||"-"),actions]));
  }
  if(!data.deliveries.length)accessEmpty("access-deliveries",4);
  },reset);
}
export async function loadAccess(){
  await Promise.all([loadAccessGrants(),loadAccessOps(),loadAccessAlerts(true),loadAccessDeliveries(true)]);
  $("access-loaded").textContent="已刷新 "+time(Date.now());
}

export function initAccess() {
  if($("access-panel")){
    $("access-refresh").addEventListener("click",()=>accessRun($("access-refresh"),loadAccess));
    $("access-alerts-refresh").addEventListener("click",()=>accessRun($("access-alerts-refresh"),()=>loadAccessAlerts(true)));
    $("access-deliveries-refresh").addEventListener("click",()=>accessRun($("access-deliveries-refresh"),()=>loadAccessDeliveries(true)));
    $("access-persona-form").addEventListener("submit",event=>{event.preventDefault();const persona=accessState.persona;if(!persona)return;accessRun($("access-persona-save"),async()=>{
      const result=await readApi(PersonaSavedSchema,"PUT","/admin/persona",{text:$("access-persona").value,expected:persona.revision});
      accessState.persona=result.value;$("access-persona-revision").textContent="修订 "+result.value.revision.slice(0,8);show("人格已保存，下一回合生效","info");
    });});
    $("access-grant-restrict").addEventListener("change",()=>{$("access-grant-scopes").disabled=!$("access-grant-restrict").checked;});
    $("access-grant-form").addEventListener("submit",event=>{event.preventDefault();const form=$("access-grant-form");accessRun(form.querySelector('button[type="submit"]'),async()=>{
      const user=$("access-grant-user").value.trim(),caps=[];if($("access-grant-send").checked)caps.push("send");if($("access-grant-schedule").checked)caps.push("schedule");
      if(!caps.length){show("至少选择一项授权能力","error");return;}
      const input: {user:string;caps:string[];targets:string[];scopes?:string[];expires_in_hours?:number}={user:user.startsWith("qq:")?user:"qq:"+user,caps,targets:accessWords($("access-grant-targets").value)};
      if($("access-grant-restrict").checked)input.scopes=accessWords($("access-grant-scopes").value);
      if($("access-grant-hours").value.trim())input.expires_in_hours=Number($("access-grant-hours").value);
      await api("POST","/admin/grants",input);await loadAccessGrants();show("授权已保存","info");
    });});
    $("access-override-add").addEventListener("click",()=>{
      const thread=$("access-override-thread").value.trim();if(!/^(owner|(group|private):[1-9][0-9]{4,15})$/.test(thread)){show("会话必须是 owner、group:群号或 private:QQ号","error");return;}
      const value: MaintenanceOverride={};for(const name of accessRetentionNames){const field=input("access-override-"+name);if(field.value.trim()){if(!field.checkValidity()){field.reportValidity();return;}value[name]=Number(field.value);}}
      const consolidate=$("access-override-consolidate").value;if(consolidate)value.consolidate=consolidate==="true";
      accessState.overrides[thread]=value;renderAccessOverrides();
    });
    $("access-ops-form").addEventListener("submit",event=>{event.preventDefault();const ops=accessState.ops;if(!ops)return;accessRun($("access-ops-save"),async()=>{
      const value=structuredClone(ops.value);for(const name of accessLimitNames)value.sendLimits[name]=Number(input("access-limit-"+name).value);
      for(const name of accessRetentionNames)value.defaults[name]=Number(input("access-default-"+name).value);
      value.defaults.consolidate=$("access-default-consolidate").checked;value.alertOwner=$("access-alert-owner").checked;value.alertThrottleMinutes=Number($("access-alert-throttle").value);value.ownerAlertThrottleMinutes=Number($("access-owner-throttle").value);value.threads=structuredClone(accessState.overrides);
      const result=await readApi(OpsSavedSchema,"PUT","/admin/ops-settings",{value,expected:ops.revision});accessState.ops=result.current;$("access-ops-revision").textContent="修订 "+result.current.revision.slice(0,8);show("运维设置已保存","info");
    });});
  }
}
