export const SESSION_HTML = `
<dialog id="session-history" class="detail-dialog" aria-labelledby="session-history-title">
  <header class="detail-head"><div><h2 id="session-history-title">会话历史与归档</h2><small id="session-history-scope"></small></div><button id="session-history-close" class="btn" type="button">关闭</button></header>
  <div id="session-history-body" class="detail-body"></div>
  <div class="pager"><span class="muted small">重置前的消息、工具记录仍可查看</span><button id="session-history-older" class="btn" type="button">更早记录</button></div>
</dialog>`;

export const SESSION_APP_JS = String.raw`
  const sh = { thread:"", next:undefined, version:0 };
  async function sessionHistory(older){
    const version=++sh.version, epoch=cs.epoch;
    if(!older){sh.thread=cs.chat;sh.next=undefined;$("session-history-body").replaceChildren();$("session-history").showModal();}
    $("session-history-scope").textContent=sh.thread;
    $("session-history-older").disabled=true;
    const query=older&&sh.next?"?cursor="+encodeURIComponent(sh.next):"";
    try{
      const view=await api("GET","/admin/threads/"+encodeURIComponent(sh.thread)+"/history"+query);
      if(version!==sh.version||epoch!==cs.epoch)return;
      const rows=view.entries.map(entry=>{
        if(entry.reset)return el("section",{className:"context-item"},[el("h3",{text:"已归档 · "+(entry.archive&&entry.archive.label||"上下文重置")}),el("small",{text:entry.archive?time(entry.archive.at):""})]);
        return el("details",{className:"context-item"},[el("summary",{text:"#"+entry.id+" · "+entry.kind+" · "+entry.messages.map(m=>m.toolName||m.role).join(" / ")}),
          ...entry.messages.map(m=>el("pre",{className:"context-text",text:m.text||"(无文本内容)"}))]);
      });
      if(!older&&!rows.length)rows.push(el("div",{className:"empty-state",text:"这个会话还没有模型历史"}));
      $("session-history-body").append(...rows);sh.next=view.next;
      $("session-history-older").disabled=!sh.next;
    }catch(error){if(version===sh.version)fail(error);}
  }
  async function compactChat(){
    $("chat-compact").disabled=true;
    try{await api("POST","/admin/threads/"+encodeURIComponent(cs.chat)+"/compact",{});notice("已开始压缩上下文，原始记录仍保留");}
    catch(error){fail(error);}finally{$("chat-compact").disabled=false;}
  }
  async function resetChat(){
    const thread=cs.chat;
    if(!confirm("归档并重置 "+thread+" 的模型上下文？聊天记录、长期记忆和工作区文件会保留，正在运行的子任务会取消。"))return;
    $("chat-reset").disabled=true;
    try{await api("POST","/admin/threads/"+encodeURIComponent(thread)+"/reset",{requestId:crypto.randomUUID(),label:"手动归档 "+new Date().toLocaleString("zh-CN")});notice("已归档，下一条消息使用新的模型上下文");}
    catch(error){fail(error);}finally{$("chat-reset").disabled=false;}
  }
  $("chat-history").addEventListener("click",()=>sessionHistory(false));
  $("chat-compact").addEventListener("click",compactChat);
  $("chat-reset").addEventListener("click",resetChat);
  $("session-history-close").addEventListener("click",()=>{$("session-history").close();sh.version++;});
  $("session-history-older").addEventListener("click",()=>sessionHistory(true));
`;
