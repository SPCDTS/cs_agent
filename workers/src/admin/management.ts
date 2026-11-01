export const MANAGEMENT_JS = String.raw`
  const managementPages={models:["模型与接入","模型、账号、MCP 服务与 QQ 响应设置。"],memory:["会话与记忆","会话状态、人格、长期记忆与技能。"],operations:["任务与事件","定时任务、事件来源与审计记录。"],access:["权限与运维","发送授权、额度、保留期、告警与发送记录。"],workspace:["工作区","按需查看文件与子任务产物。"],sandbox:["Sandbox","连接与管理沙箱，查看设备能力和使用说明。"]};
  function splitManagement(){
    const root=$("view-manage"),header=root.querySelector(".console-head"),assigned=new Map();
    const assign=(id,page)=>{let node=$(id);if(!node)return;while(node.parentElement&&node.parentElement!==root)node=node.parentElement;if(node.parentElement===root)assigned.set(node,page);};
    ["threads","mem-title","mem-status","memory-detail","skills-section","access-persona-form"].forEach(id=>assign(id,"memory"));
    ["events-section","schedules","sources"].forEach(id=>assign(id,"operations"));
    ["access-panel","access-grant-form","access-ops-form","access-alerts","access-deliveries","mcp-access-section"].forEach(id=>assign(id,"access"));
    assign("workspace-panel","workspace");
    ["sandbox-panel","sandbox-pairing","sandbox-devices-panel","sandbox-builtin-panel"].forEach(id=>assign(id,"sandbox"));
    const pages=new Map(Object.keys(managementPages).map(key=>[key,el("section",{className:"manage-page","data-management":key,hidden:true})]));
    for(const node of [...root.children])if(node!==header)pages.get(assigned.get(node)||"models").append(node);
    root.append(...pages.values());
  }
  function showManagement(view){
    const current=managementPages[view];$("view-manage").hidden=!current;
    for(const page of document.querySelectorAll("[data-management]"))page.hidden=page.dataset.management!==view;
    if(current){$("view-manage").querySelector(".console-head h1").textContent=current[0];$("view-manage").querySelector(".console-head p").textContent=current[1];}
  }
  function loadManagement(view){
    if(view==="models")return Promise.all([loadSettings(),loadModel(),loadMcpServers()]);
    if(view==="memory")return Promise.all([loadMemory(),loadSkills(),loadAccessPersona()]);
    if(view==="operations")return Promise.all([loadEvents(),loadSchedules(),loadSources()]);
    if(view==="access")return loadAccess();
    if(view==="sandbox")return loadSandboxAdmin();
    return Promise.resolve();
  }
  splitManagement();
`;
