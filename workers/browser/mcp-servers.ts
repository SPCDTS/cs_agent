import { $, ApiError, api, el, fail, loadOverview, readToken, show } from "./app";
import { Check } from "typebox/value";
import { readApi } from "./api";
import { McpServersSchema, McpManageResultSchema, McpRejectedToolsSchema, type McpServerRecord } from "./integration-contracts";
import { listInputs, paginateChildren } from "./pagination";
import { cs } from "./console";
import { mcpUiLines } from "./mcp";
type ServerAction="put"|"login"|"probe"|"activate"|"disable"|"remove";
export const mcpServers: {rows:McpServerRecord[];selected:string;revision:string;loading:number}={rows:[],selected:"",revision:"absent",loading:0};
export function mcpServerRender(id:string){
  const record=mcpServers.rows.find(row=>row.server.id===id),server=record?.server;
  mcpServers.selected=id;mcpServers.revision=record?.revision||"absent";
  $("mcp-server-select").value=server?id:"";$("mcp-server-id").value=server?.id||"";$("mcp-server-id").disabled=!!server;
  $("mcp-server-url").value=server?.transport.url||"";$("mcp-server-auth").value=server?.credential.kind==="oauth"?"oauth":server&&server.credential.kind!=="none"?"token":"none";
  $("mcp-server-scope").value=server?.credential.scope||"";$("mcp-secret-value").value="";
  $("mcp-server-resources").value=(server?.resourceAllow||[]).join("\n");
  $("mcp-server-credential").hidden=server?.credential.kind!=="managed";
  for(const action of ["login","probe","disable","remove"]){const button=$("mcp-server-"+action);if(button instanceof HTMLButtonElement)button.disabled=!record;}
  $("mcp-server-enable").disabled=!record?.discovered;
  $("mcp-server-state").textContent=server?(server.enabled?"已启用":"尚未启用")+(server.credential.kind==="managed"?(record?.credentialSet?" · 已保存凭据":" · 等待凭据"):""):"填写新服务的地址与认证方式。";
  const list=$("mcp-server-tools");list.replaceChildren();
  if(server)for(const tool of record?.discovered||[]){
    const enabled=el("input",{type:"checkbox","data-tool":tool.name});enabled.checked=server.tools.allow.includes(tool.name);
    const readonly=el("input",{type:"checkbox","data-readonly":tool.name});readonly.checked=(server.tools.readOnly??[]).includes(tool.name);
    list.append(el("div",{className:"source"},[el("div",{className:"row"},[el("label",{className:"row"},[enabled,el("strong",{text:tool.name})]),el("label",{className:"row"},[readonly,el("span",{text:"确认为只读"})])]),
      el("div",{className:"muted small",text:tool.description})]));
  }
  paginateChildren($("mcp-server-tools"),{key:"mcp-server-tools:"+id});
}
export async function loadMcpServers(selected=mcpServers.selected){
  if(!readToken())return;const version=++mcpServers.loading,epoch=cs.epoch;
  const data=await readApi(McpServersSchema,"GET","/admin/mcp/servers");if(version!==mcpServers.loading||epoch!==cs.epoch)return;
  mcpServers.rows=data.servers;const select=$("mcp-server-select");
  select.replaceChildren(el("option",{value:"",text:"新增服务"}),...data.servers.map(row=>el("option",{value:row.server.id,text:row.server.id})));
  mcpServerRender(selected);
}
export async function mcpServerAction(action:ServerAction){
  const id=$("mcp-server-id").value.trim(),expectedRevision=mcpServers.revision;
  const allow=listInputs($("mcp-server-tools"),"input[data-tool]:checked").map(node=>node.dataset.tool).filter(name=>name!==undefined);
  const input=action==="put"?{action,expectedRevision,server:{id,url:$("mcp-server-url").value.trim(),auth:$("mcp-server-auth").value,headers:mcpServers.rows.find(row=>row.server.id===id)?.server.transport.headers||{},...($("mcp-server-scope").value.trim()?{scope:$("mcp-server-scope").value.trim()}:{})}}
    :action==="login"?{action,id}
    :action==="activate"?{action,id,expectedRevision,selection:{allow,readOnly:listInputs($("mcp-server-tools"),"input[data-readonly]:checked").map(node=>node.dataset.readonly).filter(name=>name!==undefined&&allow.includes(name)),resourceAllow:mcpUiLines($("mcp-server-resources").value)}}
    :{action,id,expectedRevision};
  $("mcp-server-state").textContent="处理中…";
  try{
    const result=await readApi(McpManageResultSchema,"POST","/admin/mcp/manage",input);
    if(result.url){$("mcp-link-url").value=result.url;$("mcp-link").hidden=false;}
    await loadMcpServers(action==="remove"?"":id);
    if(result.status==="unavailable"||result.status==="oauth_not_supported")$("mcp-server-state").textContent=result.message||result.code||"";
    else if(action==="probe")$("mcp-server-state").textContent="连接正常，请选择要开放的工具；只读分类需要自行核实。";
    else if(action==="activate")$("mcp-server-state").textContent="已启用，可继续在 owner 会话使用。";
    await loadOverview();
  }catch(error){
    if(error instanceof ApiError&&Check(McpRejectedToolsSchema,error.body)){
      const reasons: Record<string,string>={unknown_keyword:"包含不支持的 schema 字段",ref_external:"引用了外部 schema",ref_unresolved:"schema 引用不存在",cycle:"schema 存在循环引用",schema_limit:"工具定义超过大小或深度限制",schema_invalid:"工具定义无效"};
      const details=error.body.rejectedTools.map(tool=>tool.name+"："+(reasons[tool.reason]||tool.reason)).join("；");
      const message="启用失败，原配置已保留。请调整工具选择后重试。"+details;
      show(message,"error");$("mcp-server-state").textContent=message;
    }else{fail(error);$("mcp-server-state").textContent="操作失败，请刷新后重试。";}
  }
}

export function initMcpServers() {
  $("mcp-secret-save").addEventListener("click",async event=>{
    const id=mcpServers.selected,key=$("mcp-secret-header").value.trim(),value=$("mcp-secret-value").value.trim();if(!id||!key||!value)return;
    const headers={[key]:key.toLowerCase()==="authorization"&&!/^[a-z]+\s/i.test(value)?"Bearer "+value:value};
    $("mcp-secret-value").value="";$("mcp-secret-save").disabled=true;
    try{await api("PUT","/admin/mcp/servers/"+encodeURIComponent(id)+"/credentials",{expectedRevision:mcpServers.revision,headers});await loadMcpServers(id);await mcpServerAction("probe");}
    catch(error){fail(error);}finally{$("mcp-secret-save").disabled=false;}
  });
  $("mcp-server-select").addEventListener("change",()=>mcpServerRender($("mcp-server-select").value));
  $("mcp-server-reload").addEventListener("click",()=>loadMcpServers().catch(fail));
  for(const [button,action]of [["save","put"],["login","login"],["probe","probe"],["enable","activate"],["disable","disable"],["remove","remove"]] satisfies Array<[string,ServerAction]>)$("mcp-server-"+button).addEventListener("click",()=>mcpServerAction(action));
  if(/^#mcp-server=[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(location.hash)){mcpServers.selected=location.hash.slice(12);cs.view="models";$("mcp-server-editor").open=true;}
}
