export const MCP_SERVERS_HTML = String.raw`
<details id="mcp-server-editor" class="source">
  <summary>接入或管理 MCP 服务</summary>
  <p class="muted small">保存连接 → 填写凭据或登录 → 检测工具 → 启用。修改即时保存，无需部署。</p>
  <div class="row"><select id="mcp-server-select" aria-label="选择 MCP 服务"><option value="">新增服务</option></select><button id="mcp-server-reload" type="button" class="btn">刷新服务</button></div>
  <div class="pair"><div class="field"><label for="mcp-server-id">服务名称</label><input id="mcp-server-id" type="text" placeholder="github" autocomplete="off"></div>
  <div class="field"><label for="mcp-server-url">HTTPS MCP 地址</label><input id="mcp-server-url" type="url" placeholder="https://api.githubcopilot.com/mcp/" autocomplete="off"></div></div>
  <div class="row"><label for="mcp-server-auth">认证</label><select id="mcp-server-auth"><option value="none">无认证</option><option value="token">Token / 认证头</option><option value="oauth">OAuth 登录</option></select>
    <label for="mcp-server-scope">OAuth scope</label><input id="mcp-server-scope" type="text" placeholder="由服务提供方指定，可留空"></div>
  <div class="row"><button id="mcp-server-save" type="button" class="btn">保存连接</button><button id="mcp-server-login" type="button" class="btn">获取登录链接</button></div>
  <p class="muted small">重新保存已有连接会清除其旧凭据和工具选择。仅更新凭据时使用下方按钮。</p>
  <div id="mcp-server-credential" hidden><div class="pair"><div class="field"><label for="mcp-secret-header">认证头名称</label><input id="mcp-secret-header" type="text" value="Authorization" autocomplete="off"></div>
    <div class="field"><label for="mcp-secret-value">Token 或认证头值</label><input id="mcp-secret-value" type="password" autocomplete="new-password" placeholder="Authorization 可直接填写 Token"></div></div>
    <button id="mcp-secret-save" type="button" class="btn">保存凭据并检测</button><p class="muted small">凭据加密保存，不回显、不进入 agent 上下文。</p></div>
  <div class="row"><button id="mcp-server-probe" type="button" class="btn">检测连接与工具</button><button id="mcp-server-enable" type="button" class="btn primary">启用选中工具</button>
    <button id="mcp-server-disable" type="button" class="btn">停用</button><button id="mcp-server-remove" type="button" class="btn danger">移除服务</button></div>
  <p id="mcp-server-state" class="muted small" role="status">进入本页后加载服务。</p>
  <div id="mcp-server-tools" class="stack" style="padding:0"></div>
  <div class="field"><label for="mcp-server-resources">允许读取的资源 URI 前缀，每行一个；留空不开放资源</label><textarea id="mcp-server-resources" rows="2" style="min-height:65px"></textarea></div>
</details>`;

export const MCP_SERVERS_JS = String.raw`
  const mcpServers={rows:[],selected:"",revision:"absent",loading:0};
  function mcpServerRender(id){
    const record=mcpServers.rows.find(row=>row.server.id===id),server=record?.server;
    mcpServers.selected=id;mcpServers.revision=record?.revision||"absent";
    $("mcp-server-select").value=server?id:"";$("mcp-server-id").value=server?.id||"";$("mcp-server-id").disabled=!!server;
    $("mcp-server-url").value=server?.transport.url||"";$("mcp-server-auth").value=server?.credential.kind==="oauth"?"oauth":server&&server.credential.kind!=="none"?"token":"none";
    $("mcp-server-scope").value=server?.credential.scope||"";$("mcp-secret-value").value="";
    $("mcp-server-resources").value=(server?.resourceAllow||[]).join("\n");
    $("mcp-server-credential").hidden=server?.credential.kind!=="managed";
    for(const action of ["login","probe","disable","remove"])$("mcp-server-"+action).disabled=!record;
    $("mcp-server-enable").disabled=!record?.discovered;
    $("mcp-server-state").textContent=server?(server.enabled?"已启用":"尚未启用")+(server.credential.kind==="managed"?(record.credentialSet?" · 已保存凭据":" · 等待凭据"):""):"填写新服务的地址与认证方式。";
    const list=$("mcp-server-tools");list.replaceChildren();
    for(const tool of record?.discovered||[]){
      const enabled=el("input",{type:"checkbox","data-tool":tool.name});enabled.checked=server.tools.allow.includes(tool.name);
      const readonly=el("input",{type:"checkbox","data-readonly":tool.name});readonly.checked=server.tools.readOnly.includes(tool.name);
      list.append(el("div",{className:"source"},[el("div",{className:"row"},[el("label",{className:"row"},[enabled,el("strong",{text:tool.name})]),el("label",{className:"row"},[readonly,el("span",{text:"确认为只读"})])]),
        el("div",{className:"muted small",text:tool.description})]));
    }
  }
  async function loadMcpServers(selected=mcpServers.selected){
    if(!readToken())return;const version=++mcpServers.loading,epoch=cs.epoch;
    const data=await api("GET","/admin/mcp/servers");if(version!==mcpServers.loading||epoch!==cs.epoch)return;
    mcpServers.rows=data.servers;const select=$("mcp-server-select");
    select.replaceChildren(el("option",{value:"",text:"新增服务"}),...data.servers.map(row=>el("option",{value:row.server.id,text:row.server.id})));
    mcpServerRender(selected);
  }
  async function mcpServerAction(action){
    const id=$("mcp-server-id").value.trim(),expectedRevision=mcpServers.revision;let input={action,id,expectedRevision};
    if(action==="put")input={action,expectedRevision,server:{id,url:$("mcp-server-url").value.trim(),auth:$("mcp-server-auth").value,headers:mcpServers.rows.find(row=>row.server.id===id)?.server.transport.headers||{},...($("mcp-server-scope").value.trim()?{scope:$("mcp-server-scope").value.trim()}:{})}};
    if(action==="login")input={action,id};
    if(action==="activate"){
      const allow=[...$("mcp-server-tools").querySelectorAll("input[data-tool]:checked")].map(node=>node.dataset.tool);
      input.selection={allow,readOnly:[...$("mcp-server-tools").querySelectorAll("input[data-readonly]:checked")].map(node=>node.dataset.readonly).filter(name=>allow.includes(name)),resourceAllow:mcpUiLines($("mcp-server-resources").value)};
    }
    $("mcp-server-state").textContent="处理中…";
    try{
      const result=await api("POST","/admin/mcp/manage",input);
      if(result.url){$("mcp-link-url").value=result.url;$("mcp-link").hidden=false;}
      await loadMcpServers(action==="remove"?"":id);
      if(result.status==="unavailable"||result.status==="oauth_not_supported")$("mcp-server-state").textContent=result.message||result.code;
      else if(action==="probe")$("mcp-server-state").textContent="连接正常，请选择要开放的工具；只读分类需要自行核实。";
      else if(action==="activate")$("mcp-server-state").textContent="已启用，可继续在 owner 会话使用。";
      await loadOverview();
    }catch(error){
      if(error instanceof ApiError&&error.body?.error==="tools_rejected"){
        const reasons={unknown_keyword:"包含不支持的 schema 字段",ref_external:"引用了外部 schema",ref_unresolved:"schema 引用不存在",cycle:"schema 存在循环引用",schema_limit:"工具定义超过大小或深度限制",schema_invalid:"工具定义无效"};
        const details=error.body.rejectedTools.map(tool=>tool.name+"："+(reasons[tool.reason]||tool.reason)).join("；");
        const message="启用失败，原配置已保留。请调整工具选择后重试。"+details;
        show(message,"error");$("mcp-server-state").textContent=message;
      }else{fail(error);$("mcp-server-state").textContent="操作失败，请刷新后重试。";}
    }
  }
  $("mcp-secret-save").addEventListener("click",async event=>{
    const id=mcpServers.selected,key=$("mcp-secret-header").value.trim(),value=$("mcp-secret-value").value.trim();if(!id||!key||!value)return;
    const headers={[key]:key.toLowerCase()==="authorization"&&!/^[a-z]+\s/i.test(value)?"Bearer "+value:value};
    $("mcp-secret-value").value="";event.currentTarget.disabled=true;
    try{await api("PUT","/admin/mcp/servers/"+encodeURIComponent(id)+"/credentials",{expectedRevision:mcpServers.revision,headers});await loadMcpServers(id);await mcpServerAction("probe");}
    catch(error){fail(error);}finally{$("mcp-secret-save").disabled=false;}
  });
  $("mcp-server-select").addEventListener("change",event=>mcpServerRender(event.target.value));
  $("mcp-server-reload").addEventListener("click",()=>loadMcpServers().catch(fail));
  for(const [button,action]of [["save","put"],["login","login"],["probe","probe"],["enable","activate"],["disable","disable"],["remove","remove"]])$("mcp-server-"+button).addEventListener("click",()=>mcpServerAction(action));
  if(/^#mcp-server=[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(location.hash)){mcpServers.selected=location.hash.slice(12);cs.view="models";$("mcp-server-editor").open=true;}
`;
