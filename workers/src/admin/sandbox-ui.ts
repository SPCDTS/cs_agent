export const SANDBOX_HTML = String.raw`
<section id="sandbox-panel" class="card">
  <div class="section-head"><h2 class="h2">远程沙箱</h2><span id="sandbox-enabled-state" class="pill neutral">加载中</span><div class="grow"></div><button id="sandbox-refresh" class="btn" type="button">刷新</button><button id="sandbox-toggle" class="btn primary" type="button" disabled>启用远程任务</button></div>
  <div class="stack"><p class="muted" style="margin:0">启用后，agent 可按任务需求选择已批准的远程沙箱。设置即时保存，无需重新部署。</p><p class="muted small" style="margin:0">停用后不再接收新任务，已有任务可继续回传结果；仍可取消任务、释放租约和管理设备。</p><div id="sandbox-summary" role="status" class="muted small">正在读取配置…</div></div>
</section>
<section id="sandbox-pairing" class="card">
  <div class="section-head"><h2 class="h2">添加设备</h2><div class="grow"></div><button id="sandbox-pair-create" class="btn" type="button" disabled>生成配对码</button></div>
  <div class="stack"><p class="muted" style="margin:0">生成配对码 → 在设备连接器中输入 → 核对配置与工具后批准 → 启动连接器。</p>
    <div id="sandbox-pair-result" hidden>
      <div class="field"><label for="sandbox-pair-id">配对 ID</label><div class="row"><input id="sandbox-pair-id" class="mono grow" type="text" readonly autocomplete="off"><button id="sandbox-pair-copy-id" class="btn" type="button">复制 ID</button></div></div>
      <div class="field"><label for="sandbox-pair-code">一次性配对码</label><div class="row"><input id="sandbox-pair-code" class="mono grow" type="password" readonly autocomplete="off"><button id="sandbox-pair-copy-code" class="btn" type="button">复制配对码</button></div></div>
      <div class="row"><span id="sandbox-pair-expiry" class="muted small"></span><button id="sandbox-pair-clear" class="btn compact" type="button">清除显示</button></div>
    </div>
    <p class="muted small" style="margin:0">配对码有效期 10 分钟，仅在生成时返回；离开本页或登出会清除显示。管理口令不交给设备连接器。</p>
    <details class="source"><summary>本机 WSB 连接示例</summary><p class="muted small">在项目根目录执行，按提示输入上方配对信息。设备批准后再启动连接器。</p><pre id="sandbox-runner-example" class="profile-text mono"></pre></details>
  </div>
</section>
<section id="sandbox-devices-panel" class="card"><div class="section-head"><h2 class="h2">设备</h2><span id="sandbox-device-count" class="muted small"></span></div><div id="sandbox-devices" class="stack"></div></section>
<section id="sandbox-builtin-panel" class="card"><div class="section-head"><h2 class="h2">内置沙箱</h2><span class="muted small">独立于远程任务开关</span></div><div id="sandbox-builtin" class="stack"></div></section>`;

export const SANDBOX_APP_JS = String.raw`
  const sandboxAdmin={snapshot:null,loading:0,busy:false,pairTimer:null};
  const sandboxLabels={pending:"待批准",approved:"已批准",revoked:"已撤销",active:"使用中",lost:"会话失效",releasing:"正在释放",dispatched:"已派发",accepted:"已接纳",cancel_requested:"正在取消",completed:"已完成",cancelled:"已取消",failed:"失败",unknown:"结果未知"};
  function sandboxClearPair(){clearTimeout(sandboxAdmin.pairTimer);sandboxAdmin.pairTimer=null;$("sandbox-pair-id").value="";$("sandbox-pair-code").value="";$("sandbox-pair-expiry").textContent="";$("sandbox-pair-result").hidden=true;}
  function resetSandboxAdmin(){sandboxAdmin.loading++;sandboxAdmin.snapshot=null;sandboxAdmin.busy=false;sandboxClearPair();$("sandbox-devices").replaceChildren();$("sandbox-builtin").replaceChildren();}
  function sandboxDescription(descriptor,key){
    const details=el("details",{className:"source","data-sandbox-detail":key},[el("summary",{text:"配置、工具与使用说明"})]);
    const config=[descriptor.provider,descriptor.os,descriptor.arch,descriptor.memoryMiB?descriptor.memoryMiB+" MiB":null,descriptor.maxTimeoutMs?"单次最多 "+Math.round(descriptor.maxTimeoutMs/1000)+" 秒":null].filter(Boolean).join(" · ");
    details.append(el("p",{className:"muted small",text:config}),el("p",{className:"mono",text:"工作目录："+(descriptor.workspaceRoot||"由工具决定")}));
    if(descriptor.environment?.length)details.append(el("p",{className:"muted small",text:descriptor.environment.map(item=>item.name+" "+item.version).join(" · ")}));
    details.append(el("strong",{text:"使用说明"}),el("div",{className:"profile-text",text:descriptor.instructions||"此设备尚未提供使用说明，请更新连接器。"}),el("strong",{text:"文件与缓存"}),el("div",{className:"profile-text",text:descriptor.persistence||"尚未提供持久化说明"}));
    if(descriptor.codeModeTools?.length)details.append(el("p",{className:"mono",text:"Code Mode 工具："+descriptor.codeModeTools.join("、")}));
    for(const tool of descriptor.tools||[])details.append(el("details",{className:"source","data-sandbox-detail":key+":"+tool.name},[el("summary",{text:tool.name}),el("p",{className:"profile-text",text:tool.description}),el("pre",{className:"profile-text mono",text:JSON.stringify(tool.inputSchema,null,2)})]));
    return details;
  }
  function sandboxButton(text,action,disabled=false,danger=false){return el("button",{type:"button",className:"btn compact"+(danger?" danger":""),text,disabled:disabled||sandboxAdmin.busy,onclick:action});}
  function renderSandboxAdmin(){
    const data=sandboxAdmin.snapshot;if(!data)return;
    const opened=new Set([...document.querySelectorAll("[data-sandbox-detail][open]")].map(node=>node.dataset.sandboxDetail));
    const enabled=data.settings.enabled,rows=data.devices;
    $("sandbox-enabled-state").textContent=enabled?"已启用":"已停用";$("sandbox-enabled-state").className="pill "+(enabled?"ok":"neutral");
    $("sandbox-toggle").textContent=enabled?"停用远程任务":"启用远程任务";$("sandbox-toggle").disabled=sandboxAdmin.busy;
    $("sandbox-pair-create").disabled=!enabled||sandboxAdmin.busy;$("sandbox-refresh").disabled=sandboxAdmin.busy;
    const online=rows.filter(row=>row.connected&&row.approval==="approved").length,pending=rows.filter(row=>row.approval==="pending").length;
    $("sandbox-summary").textContent=online+" 台在线 · "+pending+" 台待批准"+(data.settings.updatedAt?" · 设置更新于 "+time(data.settings.updatedAt):"");
    $("sandbox-device-count").textContent=rows.length+" 台已登记";
    const list=$("sandbox-devices");list.replaceChildren();
    if(!rows.length)list.append(el("div",{className:"empty-state"},[el("strong",{text:"还没有远程设备"}),el("span",{text:enabled?"生成配对码，在设备连接器中完成注册。":"先启用远程任务，再生成配对码。"})]));
    for(const row of rows){
      const descriptor=row.descriptor,lease=row.lease,id=row.id;
      const actions=el("div",{className:"row"});
      if(row.approval==="pending")actions.append(sandboxButton("批准设备",()=>sandboxDeviceAction(row,"approve"),!row.protocolCompatible));
      if(lease?.jobId&&row.approval!=="revoked")actions.append(sandboxButton("取消任务",()=>sandboxDeviceAction(row,"cancel"),lease.jobPhase==="cancel_requested",true));
      if(lease&&row.approval!=="revoked")actions.append(sandboxButton("释放租约",()=>sandboxDeviceAction(row,"release"),!!lease.jobId||lease.state==="releasing",true));
      if(row.approval!=="revoked")actions.append(sandboxButton("撤销设备",()=>sandboxDeviceAction(row,"revoke"),false,true));
      const card=el("div",{className:"source"},[
        el("div",{className:"row"},[el("strong",{text:descriptor.name}),pill(sandboxLabels[row.approval]||row.approval,row.approval==="pending"?"warn":"neutral"),pill(row.connected?"在线":"离线",row.connected?"ok":"neutral"),el("span",{className:"grow"}),actions]),
        el("div",{className:"muted small mono",text:id}),
        el("div",{className:"muted small",text:(descriptor.os||"未知系统")+" · 工具："+(descriptor.tools||[]).map(tool=>tool.name).join("、")}),
      ]);
      if(!row.protocolCompatible)card.append(el("p",{className:"pill warn",text:"连接器需升级：工具或使用说明不符合当前协议"}));
      if(lease)card.append(el("div",{className:"profile-text small",text:"租约："+(sandboxLabels[lease.state]||lease.state)+" · "+lease.id+(lease.jobId?"\n任务："+(sandboxLabels[lease.jobPhase]||lease.jobPhase)+" · "+lease.jobId:"")}));
      card.append(sandboxDescription(descriptor,id));list.append(card);
    }
    $("sandbox-builtin").replaceChildren(el("div",{className:"row"},[el("strong",{text:data.builtin.name}),pill("按需启动","neutral")]),sandboxDescription(data.builtin,data.builtin.id));
    for(const node of document.querySelectorAll("[data-sandbox-detail]"))if(opened.has(node.dataset.sandboxDetail))node.open=true;
  }
  async function loadSandboxAdmin(){
    if(!readToken())return;const version=++sandboxAdmin.loading,epoch=cs.epoch;
    const data=await api("GET","/admin/sandbox-devices/overview");if(version!==sandboxAdmin.loading||epoch!==cs.epoch)return;
    const changed=JSON.stringify(data)!==JSON.stringify(sandboxAdmin.snapshot);sandboxAdmin.snapshot=data;if(changed)renderSandboxAdmin();
  }
  function sandboxFailure(error){
    const messages={disabled:"远程任务已停用，请先启用。",conflict:"配置已被其他页面修改，已刷新，请重新操作。",job_running:"任务仍在运行或结果未知，请先取消并等待确认。",lease_expired:"租约已变化，已刷新设备状态。",invalid_device_state:"设备状态已变化，请刷新后核对。",device_limit:"设备登记数量已达到上限。"};
    if(error instanceof ApiError&&messages[error.body?.error])show(messages[error.body.error],"error");else fail(error);
  }
  async function sandboxAction(work,onSuccess){
    if(sandboxAdmin.busy||!sandboxAdmin.snapshot)return;
    const epoch=cs.epoch;sandboxAdmin.busy=true;sandboxAdmin.loading++;renderSandboxAdmin();
    try{const result=await work();if(epoch!==cs.epoch)return;if(onSuccess)onSuccess(result);await loadSandboxAdmin();}
    catch(error){if(epoch===cs.epoch){sandboxFailure(error);await loadSandboxAdmin().catch(sandboxFailure);}}
    finally{if(epoch===cs.epoch){sandboxAdmin.busy=false;renderSandboxAdmin();}}
  }
  function sandboxDeviceAction(row,action){
    const confirmations={cancel:"取消当前任务？执行环境的处理方式见设备使用说明。",release:"释放此租约？请先保存需要保留的修改，文件处理方式见持久化说明。",revoke:"撤销此设备？连接会断开，设备凭据失效；重新接入需要重新配对。"};
    if(confirmations[action]&&!confirm(confirmations[action]))return;
    const base="/admin/sandbox-devices/"+encodeURIComponent(row.id);
    sandboxAction(()=>api(action==="revoke"?"DELETE":"POST",base+(action==="revoke"?"":"/"+action),action==="cancel"?{jobId:row.lease.jobId}:action==="release"?{leaseId:row.lease.id}:undefined),()=>notice(action==="approve"?"已批准，请在设备上启动连接器。":action==="revoke"?"设备已撤销。":"请求已发出，等待设备确认。"));
  }
  $("sandbox-toggle").addEventListener("click",()=>{const current=sandboxAdmin.snapshot?.settings;if(current)sandboxAction(()=>api("PUT","/admin/sandbox-devices/settings",{enabled:!current.enabled,expectedRevision:current.revision}),result=>{if(!result.enabled)sandboxClearPair();notice(result.enabled?"远程任务已启用。":"已停用新任务，已有任务仍可回传、取消和释放。");});});
  $("sandbox-refresh").addEventListener("click",()=>loadSandboxAdmin().catch(sandboxFailure));
  $("sandbox-pair-create").addEventListener("click",()=>sandboxAction(()=>api("POST","/admin/sandbox-devices/pairings"),pair=>{
    if(cs.view!=="sandbox")return;sandboxClearPair();$("sandbox-pair-id").value=pair.pairingId;$("sandbox-pair-code").value=pair.code;$("sandbox-pair-expiry").textContent="有效至 "+time(pair.expiresAt);$("sandbox-pair-result").hidden=false;
    sandboxAdmin.pairTimer=setTimeout(sandboxClearPair,Math.max(0,pair.expiresAt-Date.now()));
  }));
  $("sandbox-pair-clear").addEventListener("click",sandboxClearPair);
  for(const field of ["id","code"])$("sandbox-pair-copy-"+field).addEventListener("click",()=>navigator.clipboard.writeText($("sandbox-pair-"+field).value).then(()=>notice("已复制"),()=>show("复制失败，请手动选择对应字段。","error")));
  $("sandbox-runner-example").textContent="npm --prefix runner start -- pair --origin "+location.origin+" --state D:\\sandbox-runner-state\n\n# 设备批准后\nnpm --prefix runner run build\nnpm --prefix runner start -- run --state D:\\sandbox-runner-state";
  setInterval(()=>{if(cs.view==="sandbox"&&readToken()&&!document.hidden&&!sandboxAdmin.busy)loadSandboxAdmin().catch(sandboxFailure);},10000);
`;
