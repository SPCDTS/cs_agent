// 复用管理台的 card/stack/field/table 样式与 api/el/show/fail/time 辅助函数；进入对应页面或点击刷新时加载。
const limitFields = [
  {name:"perChatMinute",label:"每会话每分钟",max:600}, {name:"perChatHour",label:"每会话每小时",max:36000},
  {name:"chatBreakerMinutes",label:"会话熔断（分钟）",max:1440}, {name:"globalMinute",label:"全局每分钟",max:6000},
  {name:"globalBreakerMinutes",label:"全局熔断（分钟）",max:1440},
];
const retentionFields = [
  {name:"rawDays",label:"聊天原文（天）"}, {name:"rawHardMaxDays",label:"原文最长保留（天）"},
  {name:"summaryDays",label:"摘要（天）"}, {name:"eventsDays",label:"审计事件（天）"},
];
const numbers = (prefix:string,fields:{name:string;label:string;max?:number}[],override=false) => fields.map(field=>
  `<div class="field"><label for="${prefix}-${field.name}">${field.label}</label><input id="${prefix}-${field.name}" type="number" min="${prefix==="access-limit"?1:0}" max="${field.max??3650}" step="1" ${override?'placeholder="沿用默认"':'required'}></div>`).join("");

export const ACCESS_HTML = `
<section id="access-panel" class="card">
  <div class="section-head"><h2 class="h2">权限与运维</h2><span id="access-loaded" class="muted small">按需加载，不自动刷新</span><div class="grow"></div><button id="access-refresh" class="btn" type="button">加载 / 刷新</button></div>
  <div class="stack"><p class="muted small" style="margin:0">沙箱按需启动，空闲 3 分钟自动停止。发送账本最多 5000 条，正文保留 30 天。</p></div>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">人格设定</h2><span class="muted small">下一回合生效</span><div class="grow"></div><span id="access-persona-revision" class="muted small"></span></div>
  <form id="access-persona-form" class="stack">
    <label for="access-persona">全局人格与工作方式</label><textarea id="access-persona" maxlength="65536" placeholder="填写机器人的人格与工作方式"></textarea>
    <div class="row"><button id="access-persona-save" class="btn primary" type="submit" disabled>保存人格</button><span class="muted small">独立于长期记忆画像；保存会检查是否已有其他修改。</span></div>
  </form>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">主动发送与定时授权</h2><span class="muted small">owner 来自服务端配置；此处不能升级 owner。</span></div>
  <div class="scroll"><table class="wide"><thead><tr><th>用户</th><th>能力</th><th>目标 / 来源</th><th>期限</th><th></th></tr></thead><tbody id="access-grants"><tr><td colspan="5" class="muted">尚未加载</td></tr></tbody></table></div>
  <form id="access-grant-form" class="stack">
    <div class="row"><div class="field"><label for="access-grant-user">用户 QQ 号</label><input id="access-grant-user" type="text" placeholder="QQ 号或 qq:QQ号" required></div><label><input id="access-grant-send" type="checkbox" checked> 主动发送</label><label><input id="access-grant-schedule" type="checkbox"> 定时任务</label><div class="field"><label for="access-grant-hours">有效小时数（留空为长期）</label><input id="access-grant-hours" type="number" min="0.01" max="876000" step="any"></div></div>
    <div class="pair"><div class="field grow"><label for="access-grant-targets">可主动发送的目标（每行一个，空表示不允许跨会话发送）</label><textarea id="access-grant-targets" style="min-height:80px" placeholder="qq:group:群号&#10;qq:private:QQ号"></textarea></div><div class="field grow"><label><input id="access-grant-restrict" type="checkbox"> 限制授权来源会话</label><textarea id="access-grant-scopes" style="min-height:80px" placeholder="group:群号&#10;private:QQ号" disabled></textarea><span class="muted small">不勾选时允许任意来源；勾选但留空时不允许任何来源。</span></div></div>
    <div class="row"><button class="btn primary" type="submit">保存该用户授权</button><span class="muted small">保存会替换该用户现有授权；撤销立即生效。</span></div>
  </form>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">发送额度、告警与保留期</h2><span id="access-ops-revision" class="muted small"></span></div>
  <form id="access-ops-form" class="stack">
    <strong>发送额度</strong><div class="row">${numbers("access-limit",limitFields)}</div>
    <strong>owner 告警</strong><div class="row"><label><input id="access-alert-owner" type="checkbox"> 向 owner 私聊通知</label><div class="field"><label for="access-alert-throttle">同类会话间隔（分钟）</label><input id="access-alert-throttle" type="number" min="10" max="1440" required></div><div class="field"><label for="access-owner-throttle">owner 通知间隔（分钟）</label><input id="access-owner-throttle" type="number" min="30" max="1440" required></div></div>
    <div class="muted small">鉴权失败、连续三次失败、QQ 断线超过五分钟产生告警。网页回合的告警只显示在面板。</div>
    <strong>全局默认保留期</strong><div class="row">${numbers("access-default",retentionFields)}<label><input id="access-default-consolidate" type="checkbox"> 定期整理长期记忆</label></div><div class="muted small">天数 0 表示不清理；发送安全账本使用单独的 30 天正文期限。</div>
    <details class="source"><summary>按会话覆盖保留期与整理开关</summary><div class="field"><label for="access-override-thread">会话</label><input id="access-override-thread" type="text" placeholder="owner、group:群号、private:QQ号"></div><div class="row">${numbers("access-override",retentionFields,true)}<div class="field"><label for="access-override-consolidate">长期记忆整理</label><select id="access-override-consolidate"><option value="">沿用默认</option><option value="true">开启</option><option value="false">关闭</option></select></div></div><div class="row"><button id="access-override-add" class="btn" type="button">加入覆盖列表</button><span class="muted small">空白项沿用默认；加入后点击下方保存。</span></div><div class="scroll"><table><thead><tr><th>会话</th><th>覆盖内容</th><th></th></tr></thead><tbody id="access-overrides"></tbody></table></div></details>
    <div class="row"><button id="access-ops-save" class="btn primary" type="submit" disabled>保存运维设置</button></div>
  </form>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">运行告警</h2><div class="grow"></div><button id="access-alerts-refresh" class="btn compact" type="button">刷新告警</button></div>
  <div class="scroll"><table class="wide"><thead><tr><th>时间 / 会话</th><th>来源</th><th>内容</th><th>状态</th></tr></thead><tbody id="access-alerts"><tr><td colspan="4" class="muted">尚未加载</td></tr></tbody></table></div>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">发送记录</h2><span class="muted small">查证只读取 QQ 历史，不会重新发送</span><div class="grow"></div><button id="access-deliveries-refresh" class="btn compact" type="button">刷新发送记录</button></div>
  <div class="scroll"><table class="wide"><thead><tr><th>时间 / 操作 ID</th><th>状态</th><th>消息 ID / 说明</th><th></th></tr></thead><tbody id="access-deliveries"><tr><td colspan="4" class="muted">尚未加载</td></tr></tbody></table></div>
</section>`;

export const ACCESS_APP_JS = String.raw`
  const accessState={persona:null,ops:null,overrides:{},alerts:{cursor:undefined,history:[],version:0},deliveries:{cursor:undefined,history:[],version:0}};
  const accessLimitNames=["perChatMinute","perChatHour","chatBreakerMinutes","globalMinute","globalBreakerMinutes"];
  const accessRetentionNames=["rawDays","rawHardMaxDays","summaryDays","eventsDays"];
  const accessRetentionLabels={rawDays:"原文",rawHardMaxDays:"原文上限",summaryDays:"摘要",eventsDays:"事件"};
  const accessStates={queued:"等待发送",sending:"等待回执",sent:"已确认",unknown:"结果不明",failed:"失败",rejected:"已拒绝",panel:"仅面板",pending:"待通知",resolved:"已恢复"};
  const accessErrors={delivery_evidence_expired:"查证资料已到期",delivery_source_revoked:"原始输入或权限已失效",session_generation_revoked:"会话已切换",owner_alert_disabled:"owner 告警已关闭",delivery_operation_expired:"操作已过期"};
  const accessWords=text=>text.split(/[\s,，]+/).map(value=>value.trim()).filter(Boolean);
  const accessCell=text=>el("td",{text,className:"cell-text"});
  function accessEmpty(id,count,text){$(id).replaceChildren(el("tr",{},[el("td",{colspan:count,text:text||"暂无记录",className:"muted"})]));}
  async function accessRun(button,action){
    if(button)button.disabled=true;
    try{await action();}catch(error){
      if(error instanceof ApiError&&error.status===409)show("数据已有其他修改。请手动刷新，核对后再保存。","error");else fail(error);
    }finally{if(button)button.disabled=false;}
  }
  async function loadAccessPersona(){
    const value=await api("GET","/admin/persona");accessState.persona=value;
    $("access-persona").value=value.text;$("access-persona-revision").textContent="修订 "+value.revision.slice(0,8);$("access-persona-save").disabled=false;
  }
  async function loadAccessGrants(){
    const data=await api("GET","/admin/grants"),body=$("access-grants");body.replaceChildren();
    for(const grant of data.grants){
      const revoke=el("button",{type:"button",className:"btn danger compact",text:"撤销"});
      revoke.addEventListener("click",()=>accessRun(revoke,async()=>{await api("POST","/admin/grants/revoke",{user:grant.user});await loadAccessGrants();show("授权已撤销","info");}));
      const targets=grant.targets.length?grant.targets.join("、"):"无主动发送目标",scopes=grant.scopes===undefined?"任意来源":grant.scopes.length?grant.scopes.join("、"):"无允许来源";
      body.append(el("tr",{},[accessCell(grant.user),accessCell(grant.caps.map(cap=>cap==="send"?"主动发送":"定时").join("、")),accessCell(targets+" / "+scopes),accessCell((grant.expired?"已过期 · ":"")+(grant.expires_at?time(grant.expires_at):"长期")),el("td",{},[revoke])]));
    }
    if(!data.grants.length)accessEmpty("access-grants",5);
    paginateChildren($("access-grants"));
  }
  function renderAccessOverrides(){
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
  async function loadAccessOps(){
    const snapshot=await api("GET","/admin/ops-settings"),value=snapshot.value;accessState.ops=snapshot;accessState.overrides=structuredClone(value.threads);
    for(const name of accessLimitNames)$("access-limit-"+name).value=value.sendLimits[name];
    for(const name of accessRetentionNames)$("access-default-"+name).value=value.defaults[name];
    $("access-default-consolidate").checked=value.defaults.consolidate;$("access-alert-owner").checked=value.alertOwner;
    $("access-alert-throttle").value=value.alertThrottleMinutes;$("access-owner-throttle").value=value.ownerAlertThrottleMinutes;
    $("access-ops-revision").textContent="修订 "+snapshot.revision.slice(0,8);$("access-ops-save").disabled=false;renderAccessOverrides();
  }
  async function accessPage(kind,render,reset=false){
    const state=accessState[kind],version=++state.version,epoch=cs.epoch;
    for(const button of listPager($("access-"+kind)).querySelectorAll("button"))button.disabled=true;
    if(reset){state.cursor=undefined;state.history=[];}
    const data=await api("GET","/admin/"+kind+(state.cursor?"?cursor="+encodeURIComponent(state.cursor):""));
    if(version!==state.version||epoch!==cs.epoch)return;
    render(data);
    renderListPager($("access-"+kind),state.history.length+1,!!data.next,
      ()=>{state.cursor=state.history.pop();accessPage(kind,render).catch(fail);},
      ()=>{state.history.push(state.cursor);state.cursor=data.next;accessPage(kind,render).catch(fail);});
  }
  async function loadAccessAlerts(reset=false){
    return accessPage("alerts",data=>{
    const body=$("access-alerts");body.replaceChildren();
    for(const alert of data.alerts)body.append(el("tr",{},[accessCell(time(alert.updatedAt)+" / "+alert.scope),accessCell(alert.origin==="web"?"网页（仅面板）":"QQ"),accessCell(alert.message),accessCell((accessStates[alert.status]||alert.status)+(alert.closedAt?" · 已恢复":""))]));
    if(!data.alerts.length)accessEmpty("access-alerts",4);
    },reset);
  }
  async function loadAccessDeliveries(reset=false){
    return accessPage("deliveries",data=>{
    const body=$("access-deliveries");body.replaceChildren();
    for(const delivery of data.deliveries){
      const actions=el("td");
      if(delivery.state==="unknown"&&delivery.error!=="delivery_evidence_expired"){
        const reconcile=el("button",{type:"button",className:"btn compact",text:"读取历史查证"});
        reconcile.addEventListener("click",()=>accessRun(reconcile,async()=>{
          const result=await api("POST","/admin/deliveries/"+encodeURIComponent(delivery.id)+"/reconcile");await loadAccessDeliveries();
          show(result.state==="sent"?"已通过历史记录确认发送":"尚无可靠证据，继续保留结果不明状态","info");
        }));actions.append(reconcile);
      }
      body.append(el("tr",{},[accessCell(time(delivery.createdAt)+" / "+delivery.id),accessCell(accessStates[delivery.state]||delivery.state),accessCell(delivery.messageId||(accessErrors[delivery.error]||delivery.error)||"-"),actions]));
    }
    if(!data.deliveries.length)accessEmpty("access-deliveries",4);
    },reset);
  }
  async function loadAccess(){
    await Promise.all([loadAccessGrants(),loadAccessOps(),loadAccessAlerts(true),loadAccessDeliveries(true)]);
    $("access-loaded").textContent="已刷新 "+time(Date.now());
  }
  if($("access-panel")){
    $("access-refresh").addEventListener("click",()=>accessRun($("access-refresh"),loadAccess));
    $("access-alerts-refresh").addEventListener("click",()=>accessRun($("access-alerts-refresh"),()=>loadAccessAlerts(true)));
    $("access-deliveries-refresh").addEventListener("click",()=>accessRun($("access-deliveries-refresh"),()=>loadAccessDeliveries(true)));
    $("access-persona-form").addEventListener("submit",event=>{event.preventDefault();if(!accessState.persona)return;accessRun($("access-persona-save"),async()=>{
      const result=await api("PUT","/admin/persona",{text:$("access-persona").value,expected:accessState.persona.revision});
      accessState.persona=result.value;$("access-persona-revision").textContent="修订 "+result.value.revision.slice(0,8);show("人格已保存，下一回合生效","info");
    });});
    $("access-grant-restrict").addEventListener("change",()=>{$("access-grant-scopes").disabled=!$("access-grant-restrict").checked;});
    $("access-grant-form").addEventListener("submit",event=>{event.preventDefault();const form=event.currentTarget;accessRun(form.querySelector('button[type="submit"]'),async()=>{
      const user=$("access-grant-user").value.trim(),caps=[];if($("access-grant-send").checked)caps.push("send");if($("access-grant-schedule").checked)caps.push("schedule");
      if(!caps.length){show("至少选择一项授权能力","error");return;}
      const input={user:user.startsWith("qq:")?user:"qq:"+user,caps,targets:accessWords($("access-grant-targets").value)};
      if($("access-grant-restrict").checked)input.scopes=accessWords($("access-grant-scopes").value);
      if($("access-grant-hours").value.trim())input.expires_in_hours=Number($("access-grant-hours").value);
      await api("POST","/admin/grants",input);await loadAccessGrants();show("授权已保存","info");
    });});
    $("access-override-add").addEventListener("click",()=>{
      const thread=$("access-override-thread").value.trim();if(!/^(owner|(group|private):[1-9][0-9]{4,15})$/.test(thread)){show("会话必须是 owner、group:群号或 private:QQ号","error");return;}
      const value={};for(const name of accessRetentionNames){const input=$("access-override-"+name);if(input.value.trim()){if(!input.checkValidity()){input.reportValidity();return;}value[name]=Number(input.value);}}
      const consolidate=$("access-override-consolidate").value;if(consolidate)value.consolidate=consolidate==="true";
      accessState.overrides[thread]=value;renderAccessOverrides();
    });
    $("access-ops-form").addEventListener("submit",event=>{event.preventDefault();if(!accessState.ops)return;accessRun($("access-ops-save"),async()=>{
      const value=structuredClone(accessState.ops.value);for(const name of accessLimitNames)value.sendLimits[name]=Number($("access-limit-"+name).value);
      for(const name of accessRetentionNames)value.defaults[name]=Number($("access-default-"+name).value);
      value.defaults.consolidate=$("access-default-consolidate").checked;value.alertOwner=$("access-alert-owner").checked;value.alertThrottleMinutes=Number($("access-alert-throttle").value);value.ownerAlertThrottleMinutes=Number($("access-owner-throttle").value);value.threads=structuredClone(accessState.overrides);
      const result=await api("PUT","/admin/ops-settings",{value,expected:accessState.ops.revision});accessState.ops=result.current;$("access-ops-revision").textContent="修订 "+result.current.revision.slice(0,8);show("运维设置已保存","info");
    });});
  }
`;
