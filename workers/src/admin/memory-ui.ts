export const MEMORY_MANAGER_HTML = `
<div class="row" style="padding:12px 20px;border-top:1px solid var(--line)">
  <label>状态 <select id="mem-status"><option value="active">活跃</option><option value="all">全部</option><option value="superseded">已替代</option><option value="forgotten">已删除</option></select></label>
  <button id="mem-prev" class="btn" type="button">上一页</button><span id="mem-page" class="muted small"></span><button id="mem-next" class="btn" type="button">下一页</button>
  <button id="mem-jobs" class="btn" type="button">整理与画像建议</button>
</div>
<dialog id="memory-detail" class="detail-dialog"><header class="detail-head"><h2 id="memory-detail-title">记忆详情</h2><button id="memory-detail-close" class="btn" type="button">关闭</button></header><div id="memory-detail-body" class="detail-body"></div></dialog>`;
export const MEMORY_MANAGER_JS = String.raw`
  const mm={page:1,ns:"",query:"",total:0,version:0};
  const memoryQuery=()=>"?ns="+encodeURIComponent(state.memoryNs);
  async function memoryDetail(id){
    const ns=state.memoryNs, version=++mm.version;
    try{
      const value=await api("GET","/admin/memory/"+id+"?ns="+encodeURIComponent(ns));
      if(version!==mm.version)return;
      $("memory-detail-title").textContent="记忆 #"+id+" · "+ns;
      const restore=async(versionId)=>{
        if(!confirm("将这条记忆恢复为所选版本？"))return;
        try{await api("POST","/admin/memory/"+id+"/restore?ns="+encodeURIComponent(ns),{expectedVersion:value.revision,...(versionId?{versionId}:{})});notice("记忆已恢复");$("memory-detail").close();loadMemory().catch(fail);}catch(error){fail(error);}
      };
      $("memory-detail-body").replaceChildren(el("p",{text:value.row.text}),el("p",{className:"muted small",text:"状态："+value.row.status+" · 类型："+value.row.kind}),
        el("button",{className:"btn",text:"恢复已遗忘内容",disabled:value.row.status!=="forgotten",onclick:()=>restore()}),
        el("h3",{text:"版本"}),paginatedBlock("memory-versions:"+ns+":"+id,value.versions.map(v=>el("details",{className:"context-part"},[el("summary",{text:"#"+v.id+" · "+time(v.at*1000)+" · "+v.reason}),el("pre",{text:v.after_json}),el("button",{className:"btn",text:"恢复此版本",onclick:()=>restore(v.id)})]))),
        el("h3",{text:"关联"}),el("pre",{className:"context-text",text:JSON.stringify(value.links,null,2)}));
      if(!$("memory-detail").open)$("memory-detail").showModal();
    }catch(error){fail(error);}
  }
  async function memoryJobs(){
    const ns=state.memoryNs,query="?ns="+encodeURIComponent(ns),version=++mm.version;
    try{
      const [jobs,proposals]=await Promise.all([api("GET","/admin/memory/jobs"+query),api("GET","/admin/memory/proposals"+query)]);
      if(version!==mm.version)return;
      $("memory-detail-title").textContent="整理与画像建议 · "+ns;
      const action=async(path,data={})=>{try{const result=await api("POST",path+query,data);notice("操作完成");await loadMemory();await memoryJobs();return result;}catch(error){fail(error);}};
      $("memory-detail-body").replaceChildren(
        el("div",{className:"row"},[el("button",{className:"btn",text:"整理记忆",onclick:()=>action("/admin/memory/consolidate")}),el("button",{className:"btn",text:"生成画像建议",onclick:()=>action("/admin/memory/proposals")})]),
        el("p",{className:"muted small",text:"这两项操作会调用模型；画像建议需确认后才写入。"}),el("h3",{text:"待审画像建议"}),
        paginatedBlock("memory-proposals:"+ns,proposals.proposals.map(p=>{
          const buttons=["accept","reject"].map(decision=>el("button",{className:"btn",text:decision==="accept"?"采纳":"拒绝",
            onclick:()=>action("/admin/memory/proposals/"+p.id+"/"+decision,{expectedRevision:p.based_on_revision})}));
          return el("section",{className:"context-part"},[el("pre",{text:p.text}),el("div",{className:"row"},buttons)]);
        })),
        el("h3",{text:"整理记录"}),paginatedBlock("memory-jobs:"+ns,jobs.jobs.map(j=>el("section",{className:"context-part"},[el("p",{text:time(j.started_at)+" · "+j.status}),el("pre",{text:j.report_json||"暂无报告"}),j.status==="ok"?el("button",{className:"btn",text:"回滚此批次",onclick:()=>{if(confirm("回滚该批次的整理结果？"))action("/admin/memory/jobs/"+j.id+"/rollback");}}):null]))));
      if(!$("memory-detail").open)$("memory-detail").showModal();
    }catch(error){fail(error);}
  }
  $("mem-status").addEventListener("change",()=>{mm.page=1;loadMemory().catch(fail);});
  $("mem-prev").addEventListener("click",()=>{mm.page=Math.max(1,mm.page-1);loadMemory().catch(fail);});
  $("mem-next").addEventListener("click",()=>{mm.page++;loadMemory().catch(fail);});
  $("mem-jobs").addEventListener("click",memoryJobs);
  $("memory-detail-close").addEventListener("click",()=>{$("memory-detail").close();mm.version++;});
`;
