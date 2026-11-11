import { $, ApiError, api, describe, el, readToken } from "./app";
import { readApi } from "./api";
import { ManifestSchema, WorkspaceChildSchema, WorkspaceMergedSchema, type WorkspaceFile, type WorkspaceManifest, type WorkspaceChild } from "./integration-contracts";
import { paginateChildren } from "./pagination";
export const get=$;
export const make=<K extends keyof HTMLElementTagNameMap>(tag: K,text?: string)=>el(tag,text===undefined?{}:{text});
export const state: {child: WorkspaceChild | null;selected: Set<string>}={child:null,selected:new Set()};
export const thread=()=>get("workspace-thread").value.trim(),base=(t:string)=>"/admin/threads/"+encodeURIComponent(t)+"/workspace";
export const status=(message:string,bad=false)=>{get("workspace-state").textContent=message;get("workspace-state").style.color=bad?"#8C1D1D":"#13622F";};
export const fail=(error:unknown)=>status(error instanceof ApiError&&error.status===409?"文件版本已改变，请重新检查后选择合并。":typeof describe==="function"?describe(error):"工作区操作失败。",true);
export async function action(button:HTMLButtonElement,work:()=>Promise<unknown>){button.disabled=true;try{await work();}catch(error){fail(error);}finally{button.disabled=false;if(button.id==="workspace-merge")button.disabled=!state.selected.size;}}
export async function download(t:string,revision:string,file:WorkspaceFile){
  const query=new URLSearchParams({path:file.path,revision}),response=await fetch(base(t)+"/file?"+query,{headers:{Authorization:"Bearer "+readToken()},cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});
  if(!response.ok)throw new Error("下载失败，请重新登录或加载工作区。");
  const url=URL.createObjectURL(await response.blob()),link=make("a");link.href=url;link.download=file.path.split("/").pop()??"download";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function renderParent(t:string,manifest:WorkspaceManifest){
  get("workspace-current").textContent=t+" · "+manifest.files.length+"个文件 · "+(manifest.totalBytes/1048576).toFixed(2)+"MiB · 版本 "+manifest.revision;
  const box=get("workspace-files");box.replaceChildren();if(!manifest.files.length){const empty=make("div","工作区暂无文件。");empty.className="workspace-empty";box.append(empty);paginateChildren(box);return;}
  const table=make("table"),body=make("tbody");table.append(body);
  for(const file of manifest.files){const row=make("tr"),name=make("td",file.path),size=make("td",(file.bytes/1024).toFixed(1)+"KiB"),cell=make("td"),button=make("button","下载");name.className="workspace-path";button.className="btn compact";button.onclick=()=>action(button,()=>download(t,manifest.revision,file));cell.append(button);row.append(name,size,cell);body.append(row);}box.append(table);paginateChildren(body,{key:"workspace-files:"+t});
}
export function renderChild(){
  const data=state.child;state.selected.clear();get("workspace-merge").disabled=true;const box=get("workspace-child-files");box.replaceChildren();box.hidden=!data;if(!data)return;
  get("workspace-versions").textContent="父版本 "+data.parent.revision+"；子版本 "+data.source.revision+"。仅合并勾选路径，删除也需明确选择。";
  const parent=new Map(data.parent.files.map(file=>[file.path,file])),source=new Map(data.source.files.map(file=>[file.path,file])),paths=[...new Set([...parent.keys(),...source.keys()])].sort(),table=make("table"),body=make("tbody");let count=0;table.append(body);
  for(const path of paths){const before=parent.get(path),after=source.get(path);if(before&&after&&before.sha256===after.sha256&&before.mode===after.mode)continue;count++;const row=make("tr"),cell=make("td"),label=make("label"),check=make("input"),name=make("span",path),kind=make("td",!after?"删除":!before?"新增":"修改");check.type="checkbox";check.onchange=()=>{if(check.checked)state.selected.add(path);else state.selected.delete(path);get("workspace-merge").disabled=!state.selected.size;};name.className="workspace-path";label.append(check,name);cell.append(label);row.append(cell,kind);body.append(row);}if(count){box.append(table);paginateChildren(body,{key:"workspace-child:"+data.thread+":"+data.childId});}else{const empty=make("div","父子工作区没有文件差异。");empty.className="workspace-empty";box.append(empty);}
}

export function initWorkspace() {
  get("workspace-load").onclick=()=>action(get("workspace-load"),async()=>{const t=thread(),manifest=await readApi(ManifestSchema,"GET",base(t));renderParent(t,manifest);status("已加载保存的文件。");});
  get("workspace-stop").onclick=()=>action(get("workspace-stop"),async()=>{await api("POST",base(thread())+"/reset-runtime",{});status("容器已停止，已保存文件保留。");});
  get("workspace-inspect").onclick=()=>action(get("workspace-inspect"),async()=>{const t=thread(),id=get("workspace-child").value.trim(),data=await readApi(WorkspaceChildSchema,"GET",base(t)+"/children/"+encodeURIComponent(id));state.child={...data,thread:t};renderParent(t,data.parent);renderChild();status("已检查子任务，请选择需要合并的改动。");});
  get("workspace-merge").onclick=()=>action(get("workspace-merge"),async()=>{const data=state.child;if(!data||data.thread!==thread())throw new Error("请重新检查当前会话的子任务。");const result=await readApi(WorkspaceMergedSchema,"POST",base(data.thread)+"/merge",{childId:data.childId,expectedRevision:data.parent.revision,sourceRevision:data.source.revision,paths:[...state.selected]});data.parent=result.manifest;renderParent(data.thread,result.manifest);renderChild();status("选中的文件已合并。");});
  get("workspace-thread").onchange=()=>{state.child=null;renderChild();get("workspace-versions").textContent="";};
}
