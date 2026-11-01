// 由page.ts拼接到已鉴权管理台；下载仅使用现有前端readToken，不把凭据发给模型或放进URL。
export const WORKSPACE_CSS=String.raw`
#workspace-panel{padding:22px}#workspace-panel h2{margin:0 0 8px;font-size:17px}.workspace-controls{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:18px 0}.workspace-controls label{display:flex;flex-direction:column;gap:5px}#workspace-panel .workspace-version{overflow-wrap:anywhere;font-size:12px;color:#64767B;margin:10px 0}.workspace-files{max-height:380px;overflow:auto;border:1px solid #E7EDF0;border-radius:7px}.workspace-files td:first-child{overflow-wrap:anywhere}.workspace-files .workspace-path{font-family:Consolas,monospace;font-size:12px}.workspace-files button{white-space:nowrap}#workspace-child-files label{display:flex;gap:9px;align-items:center}.workspace-empty{padding:20px;color:#64767B}
`;
export const WORKSPACE_HTML=String.raw`
<section id="workspace-panel" class="card">
<h2>工作区文件</h2><p class="muted small">查看已保存文件，或选择子任务的改动合并到当前工作区。文件总量最多50MiB，单文件最多10MiB。</p>
<div class="workspace-controls"><label>会话<input id="workspace-thread" type="text" value="owner" autocomplete="off"></label><button id="workspace-load" class="btn">加载文件</button><button id="workspace-stop" class="btn">停止容器，保留文件</button></div>
<p id="workspace-current" class="workspace-version">尚未加载工作区。</p><div id="workspace-files" class="workspace-files"><div class="workspace-empty">点击“加载文件”查看。</div></div>
<div class="workspace-controls"><label>子任务ID<input id="workspace-child" type="text" autocomplete="off"></label><button id="workspace-inspect" class="btn">检查子任务文件</button><button id="workspace-merge" class="btn primary" disabled>合并选中文件</button></div>
<p id="workspace-versions" class="workspace-version"></p><div id="workspace-child-files" class="workspace-files" hidden></div><p id="workspace-state" class="small" role="status"></p>
</section>
`;
/** 在管理台现有api/readToken/describe作用域内拼接；不启动定时器或轮询。 */
export const WORKSPACE_APP_JS=String.raw`
(()=>{
  const panel=document.getElementById("workspace-panel");if(!panel)return;
  const get=id=>document.getElementById(id),make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const state={child:null,selected:new Set()};
  const thread=()=>get("workspace-thread").value.trim(),base=t=>"/admin/threads/"+encodeURIComponent(t)+"/workspace";
  const status=(message,bad=false)=>{get("workspace-state").textContent=message;get("workspace-state").style.color=bad?"#8C1D1D":"#13622F";};
  const fail=error=>status(error&&error.status===409?"文件版本已改变，请重新检查后选择合并。":typeof describe==="function"?describe(error):"工作区操作失败。",true);
  async function action(button,work){button.disabled=true;try{await work();}catch(error){fail(error);}finally{button.disabled=false;if(button.id==="workspace-merge")button.disabled=!state.selected.size;}}
  async function download(t,revision,file){
    const query=new URLSearchParams({path:file.path,revision}),response=await fetch(base(t)+"/file?"+query,{headers:{Authorization:"Bearer "+readToken()},cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});
    if(!response.ok)throw new Error("下载失败，请重新登录或加载工作区。");
    const url=URL.createObjectURL(await response.blob()),link=make("a");link.href=url;link.download=file.path.split("/").pop();link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function renderParent(t,manifest){
    get("workspace-current").textContent=t+" · "+manifest.files.length+"个文件 · "+(manifest.totalBytes/1048576).toFixed(2)+"MiB · 版本 "+manifest.revision;
    const box=get("workspace-files");box.replaceChildren();if(!manifest.files.length){const empty=make("div","工作区暂无文件。");empty.className="workspace-empty";box.append(empty);paginateChildren(box);return;}
    const table=make("table"),body=make("tbody");table.append(body);
    for(const file of manifest.files){const row=make("tr"),name=make("td",file.path),size=make("td",(file.bytes/1024).toFixed(1)+"KiB"),cell=make("td"),button=make("button","下载");name.className="workspace-path";button.className="btn compact";button.onclick=()=>action(button,()=>download(t,manifest.revision,file));cell.append(button);row.append(name,size,cell);body.append(row);}box.append(table);paginateChildren(body,{key:"workspace-files:"+t});
  }
  function renderChild(){
    const data=state.child;state.selected.clear();get("workspace-merge").disabled=true;const box=get("workspace-child-files");box.replaceChildren();box.hidden=!data;if(!data)return;
    get("workspace-versions").textContent="父版本 "+data.parent.revision+"；子版本 "+data.source.revision+"。仅合并勾选路径，删除也需明确选择。";
    const parent=new Map(data.parent.files.map(file=>[file.path,file])),source=new Map(data.source.files.map(file=>[file.path,file])),paths=[...new Set([...parent.keys(),...source.keys()])].sort(),table=make("table"),body=make("tbody");let count=0;table.append(body);
    for(const path of paths){const before=parent.get(path),after=source.get(path);if(before&&after&&before.sha256===after.sha256&&before.mode===after.mode)continue;count++;const row=make("tr"),cell=make("td"),label=make("label"),check=make("input"),name=make("span",path),kind=make("td",!after?"删除":!before?"新增":"修改");check.type="checkbox";check.onchange=()=>{if(check.checked)state.selected.add(path);else state.selected.delete(path);get("workspace-merge").disabled=!state.selected.size;};name.className="workspace-path";label.append(check,name);cell.append(label);row.append(cell,kind);body.append(row);}if(count){box.append(table);paginateChildren(body,{key:"workspace-child:"+data.thread+":"+data.childId});}else{const empty=make("div","父子工作区没有文件差异。");empty.className="workspace-empty";box.append(empty);}
  }
  get("workspace-load").onclick=event=>action(event.currentTarget,async()=>{const t=thread(),manifest=await api("GET",base(t));renderParent(t,manifest);status("已加载保存的文件。");});
  get("workspace-stop").onclick=event=>action(event.currentTarget,async()=>{await api("POST",base(thread())+"/reset-runtime",{});status("容器已停止，已保存文件保留。");});
  get("workspace-inspect").onclick=event=>action(event.currentTarget,async()=>{const t=thread(),id=get("workspace-child").value.trim(),data=await api("GET",base(t)+"/children/"+encodeURIComponent(id));state.child={...data,thread:t};renderParent(t,data.parent);renderChild();status("已检查子任务，请选择需要合并的改动。");});
  get("workspace-merge").onclick=event=>action(event.currentTarget,async()=>{const data=state.child;if(!data||data.thread!==thread())throw new Error("请重新检查当前会话的子任务。");const result=await api("POST",base(data.thread)+"/merge",{childId:data.childId,expectedRevision:data.parent.revision,sourceRevision:data.source.revision,paths:[...state.selected]});data.parent=result.manifest;renderParent(data.thread,result.manifest);renderChild();status("选中的文件已合并。");});
  get("workspace-thread").onchange=()=>{state.child=null;renderChild();get("workspace-versions").textContent="";};
})();
`;
