export const CONSOLE_CSS = String.raw`
:root{--bg:#F6F7F9;--surface:#fff;--ink:#13272B;--muted:#64767B;--accent:#087F73;--line:#E7EDF0}
body{background:var(--bg);color:var(--ink);font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent)}button,input,select,textarea{font:inherit}button:focus-visible,a:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #59B8AA;outline-offset:3px}
.sidebar{position:fixed;inset:0 auto 0 0;width:204px;background:#EDF2F3;border-right:1px solid var(--line);padding:28px 18px;display:flex;flex-direction:column;gap:30px}
.sidebar .wordmark{font-weight:700;font-size:23px;letter-spacing:-1px;padding:0 12px}.wordmark span{color:var(--accent)}
.sidebar nav{display:flex;flex-direction:column;gap:5px}.nav-btn{border:0;background:transparent;text-align:left;padding:12px 14px;border-radius:7px;color:#52666A;cursor:pointer;font-weight:500}
.nav-btn[aria-current=page]{background:#fff;color:#087F73;box-shadow:0 1px 3px #13272B09}.nav-btn:hover{background:#ffffff90}.sidebar-foot{margin-top:auto;padding:0 12px;font-size:12px;color:var(--muted);line-height:1.9}
.topbar{margin-left:204px;background:var(--bg)}.topbar-inner{max-width:none;padding:18px 34px}.brand{font-size:13px;font-weight:500}
main{max-width:1600px;margin-left:204px;padding:30px 34px;width:calc(100% - 204px);gap:24px}
.status-line{margin:12px 34px 0 238px;max-width:none}.btn.primary{background:var(--accent);border-color:var(--accent)}.card{border-color:var(--line);border-radius:9px;box-shadow:none}
.console-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:22px}
.console-head h1{margin:0 0 6px;font-size:28px;letter-spacing:-.6px;font-weight:650}.console-head p{margin:0;color:var(--muted)}
.console-head .row{align-items:flex-end}.filters{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}.filters label{display:flex;flex-direction:column;gap:5px;min-width:135px}.filters select{width:100%;background:#fff}.filters label:first-child{min-width:170px}
.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));padding:23px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:25px;gap:20px}
.metric-label{font-size:12px;color:var(--muted)}.metric-value{font-size:30px;letter-spacing:-.7px;font-weight:600;margin:6px 0;font-variant-numeric:tabular-nums}.metric-note{font-size:12px;color:var(--muted)}
.analytics{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(240px,1fr);gap:22px;margin-bottom:24px}.chart-panel,.model-panel{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:22px;min-width:0}
.panel-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}.panel-title h2{font-size:15px;font-weight:600;margin:0}.legend{font-size:12px;color:var(--muted);display:flex;gap:13px}.legend span:before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;background:#A9D7CF;margin-right:5px}.legend span:last-child:before{background:#087F73}
#token-chart{width:100%;display:block;min-height:160px}#token-chart text{fill:#64767B;font:11px "Segoe UI",sans-serif}
.model-item{padding:10px 0;border-bottom:1px solid var(--line)}.model-item:last-child{border:0}.model-name{font-size:12px;overflow-wrap:anywhere}.model-numbers{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums;margin:6px 0}.meter{height:5px;border-radius:4px;background:#EDF2F3;overflow:hidden}.meter span{height:100%;display:block;background:#65B3A6}
.console-table th{background:#F9FBFB}.console-table td{font-size:13px;padding:13px 15px}.console-table .num{text-align:right;font-variant-numeric:tabular-nums}.request-link{border:0;background:transparent;padding:0;color:var(--accent);cursor:pointer;text-align:left;font-weight:600}.request-link:hover{text-decoration:underline}.table-sub{font-size:11px;color:var(--muted);margin-top:3px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty-state{padding:46px 24px;text-align:center;color:var(--muted);line-height:1.9}.empty-state strong{display:block;color:var(--ink);font-weight:500}.retention-note{font-size:12px;color:var(--muted);margin-top:12px}.table-state{padding:12px 20px;color:var(--muted);font-size:12px}
#view-manage{display:flex;flex-direction:column;gap:24px}
.detail-dialog{border:1px solid var(--line);border-radius:12px;padding:0;width:min(1000px,94vw);max-height:90vh;color:var(--ink);background:var(--surface);box-shadow:0 24px 80px #13272B30}.detail-dialog::backdrop{background:#142D3659}
.detail-head{position:sticky;top:0;background:#fff;z-index:1;padding:20px 24px;border-bottom:1px solid var(--line);display:flex;gap:12px;justify-content:space-between;align-items:center}.detail-head h2{font-size:18px;margin:0}.detail-body{padding:24px}.detail-id{font-size:11px;overflow-wrap:anywhere;color:var(--muted)}.detail-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:18px 0 24px}.detail-stats strong{display:block;font-size:20px;font-weight:550;font-variant-numeric:tabular-nums}.context-note{background:#F0F7F5;color:#365C54;border-radius:7px;padding:12px 15px;font-size:12px;margin:15px 0}
.context-part{border:1px solid var(--line);border-radius:7px;margin:10px 0}.context-part summary{padding:12px 15px;cursor:pointer;font-size:13px}.context-part pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 Consolas,"Microsoft YaHei",monospace;margin:0;padding:16px;border-top:1px solid var(--line);background:#FAFCFC;max-height:480px;overflow:auto}
.detail-section-title{font-size:15px;margin:24px 0 10px}.composition{display:flex;height:9px;overflow:hidden;border-radius:5px;margin:12px 0;background:#E7EDF0}.composition span:nth-child(1){background:#087F73}.composition span:nth-child(2){background:#77B9AD}.composition span:nth-child(3){background:#BFDAD5}
.chat-layout{display:grid;grid-template-columns:230px minmax(0,1fr);border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff;min-height:580px;height:calc(100vh - 230px)}
.chat-threads{background:#FAFCFC;border-right:1px solid var(--line);padding:16px;overflow:auto}.chat-threads h2{margin:0 0 14px;font-size:13px;color:var(--muted);font-weight:500}
.chat-thread{display:block;width:100%;border:0;background:transparent;text-align:left;border-radius:7px;padding:11px;margin-bottom:5px;cursor:pointer;overflow-wrap:anywhere}.chat-thread[aria-current=true]{background:#E4F2EE;color:#08675E}.chat-thread small{display:block;font-size:11px;color:var(--muted);margin-top:4px}
.chat-main{display:flex;flex-direction:column;min-width:0;min-height:0}.chat-top{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;gap:15px;align-items:center;justify-content:space-between}.chat-top strong{font-weight:600}.chat-top small{display:block;margin-top:4px;color:var(--muted)}
.chat-messages{flex:1;overflow:auto;padding:20px 28px;scroll-behavior:auto}.chat-message{max-width:85%;margin-bottom:22px;line-height:1.7}.chat-message.user{margin-left:auto}.message-meta{font-size:11px;color:var(--muted);margin-bottom:5px}.message-text{padding:12px 16px;border-radius:10px;background:#F1F5F5;white-space:pre-wrap;overflow-wrap:anywhere}.chat-message.user .message-text{background:#E5F3EF}.chat-message.assistant .message-text{background:#fff;border-left:3px solid #7EBCAF;border-radius:0;padding-left:16px}
.chat-composer{padding:16px 24px;border-top:1px solid var(--line);background:#fff}.chat-composer textarea{min-height:82px;max-height:180px;resize:vertical;border-color:#C8DAD6}.composer-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px}.composer-footer small{color:var(--muted)}#chat-state{font-size:12px;color:var(--muted);min-height:20px}
@media(min-width:1800px){main{margin-right:auto}.topbar-inner{max-width:1600px;margin-left:0}}
@media(max-width:1100px){.analytics{grid-template-columns:1fr}.model-panel{display:none}.metrics{gap:12px}.metric-value{font-size:24px}.chat-layout{grid-template-columns:185px minmax(0,1fr)}}
@media(max-width:760px){.sidebar{position:static;width:auto;padding:15px;gap:14px;border-right:0}.sidebar .wordmark{font-size:20px;padding:0}.sidebar nav{flex-direction:row;gap:4px;overflow:auto}.nav-btn{white-space:nowrap;font-size:13px;padding:9px 11px}.sidebar-foot{display:none}.topbar{margin-left:0}.topbar-inner{padding:12px 18px}.topbar .brand{display:none}main{margin:0;padding:22px 16px;width:100%}.status-line{margin:10px 16px}.console-head h1{font-size:24px}.metrics{grid-template-columns:repeat(2,1fr);gap:18px}.metrics>div:last-child{grid-column:span 2}.filters{gap:8px}.filters label{flex:1;min-width:120px}.chat-layout{height:calc(100dvh - 300px);min-height:530px;grid-template-columns:1fr}.chat-threads{max-height:110px;border-right:0;border-bottom:1px solid var(--line);padding:10px;display:flex;gap:6px}.chat-threads h2{display:none}#chat-thread-list{display:flex;gap:6px}.chat-thread{min-width:140px;width:auto;margin:0}.chat-top,.chat-composer{padding:12px 15px}.chat-messages{padding:18px 15px}.chat-message{max-width:95%}.detail-stats{grid-template-columns:repeat(2,1fr)}.detail-body{padding:16px}.detail-head{padding:16px}.console-head .row{width:100%}.chart-panel{padding:15px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

export const CONSOLE_NAV = String.raw`<aside class="sidebar">
  <div class="wordmark">cs<span> / </span>agent</div>
  <nav aria-label="管理台导航">
    <button type="button" class="nav-btn" data-view="usage" aria-current="page">用量总览</button>
    <button type="button" class="nav-btn" data-view="requests">请求记录</button>
    <button type="button" class="nav-btn" data-view="chat">会话对话</button>
    <button type="button" class="nav-btn" data-view="manage">配置与管理</button>
  </nav>
  <div class="sidebar-foot">会话、请求与上下文<br>在一个地方查看</div>
</aside>`;

export const CONSOLE_HTML = String.raw`
<section id="view-requests">
  <div class="console-head"><div><h1 id="requests-heading">请求与用量</h1><p id="requests-subtitle">从整体趋势，追踪到每一次模型调用。</p></div>
    <div class="row"><label class="field">时间范围<select id="req-range"><option value="24">最近 24 小时</option><option value="168">最近 7 天</option><option value="720">最近 30 天</option></select></label><button id="req-refresh" class="btn" type="button">刷新数据</button></div>
  </div>
  <div class="filters">
    <label>会话<select id="req-thread"><option value="">全部会话</option></select></label>
    <label>模型<select id="req-model"><option value="">全部模型</option></select></label>
    <label>用途<select id="req-purpose"><option value="">全部用途</option><option value="conversation">主会话</option><option value="subagent">子任务</option><option value="background">记忆与维护</option><option value="compaction">上下文压缩</option></select></label>
    <label>状态<select id="req-status"><option value="">全部状态</option><option value="done">完成</option><option value="running">进行中</option><option value="error">错误</option><option value="aborted">已取消</option><option value="interrupted">采集未完成</option></select></label>
  </div>
  <div id="usage-summary">
    <div class="metrics">
      <div><div class="metric-label">模型请求</div><div id="metric-requests" class="metric-value">—</div><div id="metric-failures" class="metric-note">等待数据</div></div>
      <div><div class="metric-label">输入 token</div><div id="metric-input" class="metric-value">—</div><div class="metric-note">包含缓存读取与写入</div></div>
      <div><div class="metric-label">输出 token</div><div id="metric-output" class="metric-value">—</div><div class="metric-note">包含模型推理用量</div></div>
      <div><div class="metric-label">缓存命中率</div><div id="metric-cache" class="metric-value">—</div><div class="metric-note">缓存读取 / 总输入</div></div>
      <div><div class="metric-label">平均请求耗时</div><div id="metric-duration" class="metric-value">—</div><div id="metric-measured" class="metric-note">仅统计已完成采集</div></div>
    </div>
    <div class="analytics">
      <div class="chart-panel"><div class="panel-title"><h2>Token 用量趋势</h2><div class="legend"><span>输入</span><span>输出</span></div></div><svg id="token-chart" viewBox="0 0 840 210" role="img" aria-label="所选时间内的输入与输出 token 用量"></svg><div id="chart-note" class="small muted">北京时间</div></div>
      <div class="model-panel"><div class="panel-title"><h2>模型用量分布</h2><span class="small muted">输入 + 输出</span></div><div id="model-breakdown"></div></div>
    </div>
  </div>
  <section class="card"><div class="section-head"><h2 class="h2">请求记录</h2><span class="small muted">一次模型调用一条记录，工具续轮分别统计</span><span class="grow"></span><span id="req-count" class="small muted"></span></div>
    <div class="scroll"><table class="wide console-table"><thead><tr><th>时间 / 请求</th><th>模型 / 用途</th><th>会话</th><th>状态</th><th class="num">输入</th><th class="num">输出</th><th class="num">耗时</th></tr></thead><tbody id="request-rows"></tbody></table></div>
    <div id="request-empty" class="empty-state" hidden><strong>所选范围内还没有请求</strong>新版本会从上线后开始记录。可以切换范围，或在会话里发一条消息。</div>
    <div class="pager"><span id="request-state" class="small muted" role="status"></span><div class="row"><button id="req-prev" class="btn" type="button" disabled>上一页</button><button id="req-next" class="btn" type="button" disabled>下一页</button></div></div>
  </section>
  <p id="request-retention" class="retention-note">请求元数据最多保留 30 天，上下文详情最多 7 天；达到容量上限会提前清理。</p>
</section>
<section id="view-chat" hidden>
  <div class="console-head"><div><h1>会话对话</h1><p>继续 QQ 会话的上下文，在网页里接着聊。</p></div></div>
  <div class="chat-layout"><aside class="chat-threads"><h2>已有会话</h2><div id="chat-thread-list"></div></aside>
    <section class="chat-main" aria-label="对话">
      <header class="chat-top"><div><strong id="chat-title">选择会话</strong><small>共享上下文 · 网页发言只回复网页</small></div><button id="chat-reload" class="btn compact" type="button">刷新</button></header>
      <div id="chat-messages" class="chat-messages" role="log" aria-live="polite" aria-relevant="additions"></div>
      <form id="chat-form" class="chat-composer"><div id="chat-state" role="status"></div><label for="chat-input" class="small">发给当前会话</label><textarea id="chat-input" maxlength="16000" placeholder="输入消息，继续这段对话…" required></textarea>
        <div class="composer-footer"><small>Ctrl / ⌘ + Enter 发送 · 最近 100 条消息</small><button id="chat-send" class="btn primary" type="submit">发送消息</button></div>
      </form>
    </section>
  </div>
</section>
<dialog id="request-detail" class="detail-dialog" aria-labelledby="detail-title">
  <header class="detail-head"><div><h2 id="detail-title">请求详情</h2><div id="detail-id" class="detail-id"></div></div><button id="detail-close" class="btn" type="button">关闭</button></header><div id="detail-body" class="detail-body"></div>
</dialog>
`;

export const CONSOLE_APP_JS = String.raw`
  const cs = { view:"usage", until:Date.now(), before:undefined, next:undefined, pages:[], requestVersion:0, detailVersion:0,
    chat:"owner", chatVersion:0, fingerprint:"", timer:null, sending:false, epoch:0, pending:null };
  const nf = n => typeof n === "number" ? n.toLocaleString("zh-CN") : "—";
  const compact = n => n>=1e6?(n/1e6).toFixed(1)+"M":n>=1000?(n/1000).toFixed(1)+"k":nf(n);
  const statuses={running:"进行中",done:"完成",error:"错误",aborted:"已取消",interrupted:"采集未完成",queued:"排队 / 执行中",failed:"失败"};
  const purposes={conversation:"主会话",background:"记忆与维护",subagent:"子任务",compaction:"上下文压缩"};
  const requestPill=s=>pill(statuses[s]||s,s==="done"?"ok":s==="running"||s==="queued"?"warn":"bad");
  function choices(id,values,first){
    const node=$(id),selected=node.value;
    node.replaceChildren(el("option",{value:"",text:first}),...values.map(v=>el("option",{value:v.key||v,text:v.name||v.key||v})));
    node.value=values.some(v=>(v.key||v)===selected)?selected:"";
  }
  function renderConsoleThreads(){
    const threads=state.overview&&state.overview.threads||[{key:"owner",name:"主人会话"}];
    choices("req-thread",threads.map(t=>({key:t.key,name:t.name||(t.key==="owner"?"主人会话":t.key)})),"全部会话");
    $("chat-thread-list").replaceChildren(...threads.map(t=>el("button",{className:"chat-thread",type:"button","aria-current":String(t.key===cs.chat),
      onclick:()=>chooseChat(t.key)},[el("span",{text:t.name||(t.key==="owner"?"主人会话":t.key)}),el("small",{text:t.key})])));
  }
  function chooseChat(key){
    cs.chat=key;cs.chatVersion++;cs.fingerprint="";
    $("chat-messages").replaceChildren(el("div",{className:"empty-state",text:"正在载入对话…"}));
    $("chat-input").value="";restorePending();renderConsoleThreads();loadChat().catch(fail);
  }
  function consoleView(view){
    if ((cs.view==="chat"||cs.view==="manage")&&(view==="requests"||view==="usage")) { cs.until=Date.now();cs.before=undefined;cs.pages=[]; }
    cs.view=view;
    window.addEventListener("resize",()=>{clearTimeout(cs.resizeTimer);cs.resizeTimer=setTimeout(()=>{if(cs.chart&&cs.view==="usage")drawTokens(cs.chart.u,cs.chart.since,cs.chart.until);},100);});
  document.querySelectorAll("[data-view]").forEach(b=>{if(b.dataset.view===view)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");});
    $("view-requests").hidden=view!=="usage"&&view!=="requests";$("usage-summary").hidden=view!=="usage";
    $("view-chat").hidden=view!=="chat";$("view-manage").hidden=view!=="manage";
    $("requests-heading").textContent=view==="requests"?"请求记录":"请求与用量";
    $("requests-subtitle").textContent=view==="requests"?"查看每一次调用，展开当时的消息、工具与上下文。":"从整体趋势，追踪到每一次模型调用。";
    if(view==="chat")loadChat().catch(fail);
    if(view==="usage"||view==="requests")loadRequests().catch(fail);
  }
  function resetConsole(){
    clearInterval(cs.timer);cs.timer=null;cs.epoch++;cs.requestVersion++;cs.chatVersion++;cs.detailVersion++;
    $("request-detail").close();$("detail-body").replaceChildren();$("chat-messages").replaceChildren();
  }
  function startConsole(){
    restorePending();renderConsoleThreads();consoleView(cs.view);clearInterval(cs.timer);
    cs.timer=setInterval(()=>{if(cs.view==="chat"&&!document.hidden&&readToken())loadChat().catch(fail);},2500);
  }
  function requestParams(){
    const p=new URLSearchParams({since:String(cs.until-Number($("req-range").value)*3600000),until:String(cs.until),limit:"40"});
    for(const [key,id] of [["thread","req-thread"],["model","req-model"],["status","req-status"],["purpose","req-purpose"]])if($(id).value)p.set(key,$(id).value);
    return p;
  }
  async function loadRequests(){
    const version=++cs.requestVersion,epoch=cs.epoch,p=requestParams(),summaryParams=p.toString();
    if(cs.before)p.set("before",String(cs.before));$("request-state").textContent="正在载入…";
    try{
      const [page,u]=await Promise.all([api("GET","/admin/requests?"+p),api("GET","/admin/usage?"+summaryParams)]);
      if(version!==cs.requestVersion||epoch!==cs.epoch)return;
      cs.next=page.next;$("req-prev").disabled=!cs.pages.length;$("req-next").disabled=!page.next;
      $("request-empty").hidden=!!page.requests.length;
      $("request-rows").replaceChildren(...page.requests.map(r=>el("tr",{},[
        el("td",{},[el("button",{className:"request-link",type:"button",text:bjTime(r.startedAt),onclick:()=>openRequest(r.id)}),el("div",{className:"table-sub mono",text:r.id.slice(0,8)})]),
        el("td",{},[el("span",{text:r.model}),el("div",{className:"table-sub",text:r.provider+" / "+(purposes[r.purpose]||r.purpose)})]),
        el("td",{},[el("button",{className:"request-link",type:"button",text:r.thread,onclick:()=>{chooseChat(r.thread);consoleView("chat");}})]),
        el("td",{},[requestPill(r.status)]),el("td",{className:"num",text:nf(r.inputTokens)}),el("td",{className:"num",text:nf(r.outputTokens)}),el("td",{className:"num",text:duration(r.durationMs)})
      ])));
      const s=u.summary;
      $("metric-requests").textContent=nf(s.requests);$("metric-failures").textContent=s.failed+" 条异常 · "+s.running+" 条进行中";
      $("metric-input").textContent=nf(s.inputTokens);$("metric-output").textContent=nf(s.outputTokens);
      $("metric-cache").textContent=s.inputTokens?(s.cacheRead/s.inputTokens*100).toFixed(1)+"%":"—";
      $("metric-duration").textContent=duration(s.avgDuration==null?null:Math.round(s.avgDuration));
      $("metric-measured").textContent=s.measured+" / "+s.requests+" 条已返回用量";
      $("req-count").textContent="共 "+nf(s.requests)+" 次调用";$("request-state").textContent="第 "+(cs.pages.length+1)+" 页 · 更新于 "+time(Date.now());
      choices("req-model",u.choices,"全部模型");drawTokens(u,Number(p.get("since")),Number(p.get("until")));
      const total=s.inputTokens+s.outputTokens;
      $("model-breakdown").replaceChildren(...u.models.slice(0,5).map(m=>el("div",{className:"model-item"},[
        el("div",{className:"model-name",text:m.model}),el("div",{className:"model-numbers"},[el("strong",{text:compact(m.inputTokens+m.outputTokens)}),el("small",{className:"muted",text:m.requests+" 次调用"})]),
        el("div",{className:"meter"},[el("span",{style:"width:"+(total?(m.inputTokens+m.outputTokens)/total*100:0)+"%"})])
      ])));
      if(!u.models.length)$("model-breakdown").append(el("p",{className:"muted small",text:"有请求后，这里会显示各模型的用量占比。"}));
      $("request-retention").textContent="元数据最多 30 天 / 20,000 条，上下文详情最多 7 天 / 总计 32 MiB。达到上限会提前清理。"+
        (u.retainedSince?"当前最早记录："+bjTime(u.retainedSince)+"。":"从新版本上线后开始采集。")+"未返回的用量不计入 token 合计。";
    }catch(error){if(version===cs.requestVersion)$("request-state").textContent="数据载入失败，请刷新重试";throw error;}
  }
  function refreshConsole(){if((cs.view==="usage"||cs.view==="requests")&&!cs.before&&!document.hidden){cs.until=Date.now();loadRequests().catch(fail);}}
  function refreshRequests(){cs.until=Date.now();cs.before=undefined;cs.pages=[];loadRequests().catch(fail);}
  function sv(name,attrs,text){
    const node=document.createElementNS("http://www.w3.org/2000/svg",name);
    for(const [k,v] of Object.entries(attrs||{}))node.setAttribute(k,String(v));if(text!==undefined)node.textContent=text;return node;
  }
  function drawTokens(u,since,until){
    const svg=$("token-chart");svg.replaceChildren();cs.chart={u,since,until};
    const map=new Map(u.series.map(x=>[x.at,x])),bins=[],step=u.bucket;
    for(let at=Math.floor((since+28800000)/step)*step-28800000;at<=until;at+=step)bins.push(map.get(at)||{at,inputTokens:0,outputTokens:0});
    const max=Math.max(3,...bins.map(x=>x.inputTokens+x.outputTokens)),left=48,top=12,width=Math.max(230,svg.clientWidth-64),height=160;
    svg.setAttribute("viewBox","0 0 "+(width+64)+" 210");
    for(let i=0;i<4;i++){const y=top+height-height*i/3;svg.append(sv("line",{x1:left,x2:left+width,y1:y,y2:y,stroke:"#E7EDF0"}),sv("text",{x:left-9,y:y+4,"text-anchor":"end"},compact(Math.round(max*i/3))));}
    const cell=width/bins.length,bw=Math.max(2,Math.min(23,cell*.65));
    bins.forEach((b,i)=>{
      const x=left+i*cell+(cell-bw)/2,ih=b.inputTokens/max*height,oh=b.outputTokens/max*height,g=sv("g",{});
      g.append(sv("title",{},bjTime(b.at)+" 输入 "+nf(b.inputTokens)+" / 输出 "+nf(b.outputTokens)),sv("rect",{x,y:top+height-ih,width:bw,height:ih,fill:"#A9D7CF",rx:1}),sv("rect",{x,y:top+height-ih-oh,width:bw,height:oh,fill:"#087F73",rx:1}));svg.append(g);
      if(i%Math.max(1,Math.ceil(bins.length/(width<400?3:6)))===0)svg.append(sv("text",{x:x+bw/2,y:199,"text-anchor":"middle"},step===3600000?bjTime(b.at).slice(-5):bjTime(b.at).slice(0,5)));
    });
    if(!u.summary.measured)svg.append(sv("text",{x:left+width/2,y:85,"text-anchor":"middle"},"暂无已返回的 token 用量"));
    $("chart-note").textContent="北京时间 · "+(step===3600000?"每小时":"每天")+"汇总 · "+(u.summary.requests-u.summary.measured)+" 条请求未返回用量";
  }
  function detailPart(title,part,open){
    const p=part||{text:"未保留",chars:0};
    return el("details",{className:"context-part",open:!!open},[el("summary",{text:title+" · "+nf(p.chars)+" 字符"+(p.truncated?" · 已截断":"")}),el("pre",{text:p.text||"（空）"})]);
  }
  async function openRequest(id){
    const version=++cs.detailVersion,epoch=cs.epoch;
    $("detail-id").textContent=id;$("detail-body").replaceChildren(el("p",{className:"muted",text:"正在读取请求详情…"}));
    if(!$("request-detail").open)$("request-detail").showModal();
    try{
      const d=await api("GET","/admin/requests/"+encodeURIComponent(id));if(version!==cs.detailVersion||epoch!==cs.epoch)return;
      const r=d.request,body=$("detail-body");body.replaceChildren(
        el("div",{className:"row"},[el("strong",{text:r.model}),requestPill(r.status),el("span",{className:"muted",text:r.thread+" / "+(purposes[r.purpose]||r.purpose)})]),
        el("div",{className:"detail-stats"},[["输入 token",nf(r.inputTokens)],["输出 token",nf(r.outputTokens)],["缓存读取",nf(r.cacheRead)],["耗时",duration(r.durationMs)]].map(([name,value])=>el("div",{className:"metric-label"},[name,el("strong",{text:value})]))),
        el("p",{className:"muted small",text:"开始："+bjTime(r.startedAt)+"；上下文窗口："+nf(r.contextWindow)+" token"+(r.inputTokens!=null&&r.contextWindow?"，本次输入约占 "+(r.inputTokens/r.contextWindow*100).toFixed(1)+"%":"")+"；缓存写入："+nf(r.cacheWrite)+"；推理："+nf(r.reasoningTokens)+"（已包含在输出）。"})
      );
      if(r.error)body.append(el("pre",{className:"context-note",text:r.error}));
      if(!d.detailAvailable){body.append(el("div",{className:"empty-state",text:"上下文详情已过保留期或达到容量上限；请求用量仍可查看。"}));return;}
      const c=d.context,total=c.chars.system+c.chars.messages+c.chars.tools;
      body.append(el("div",{className:"context-note",text:"以下是本次 pi-ai 请求的归一化上下文。各部分按字符计量，不是精确 token；已隐藏凭据与图片数据。"+(c.truncated?"内容超过保留上限，部分已截断。":"")}),
        el("div",{className:"composition"},Object.values(c.chars).map(x=>el("span",{style:"width:"+(total?x/total*100:0)+"%"}))),
        el("div",{className:"legend",text:"系统 "+nf(c.chars.system)+" 字符 / 消息 "+nf(c.chars.messages)+" 字符 / 工具定义 "+nf(c.chars.tools)+" 字符"}),
        detailPart("系统提示",c.system,false),el("h3",{className:"detail-section-title",text:"请求消息 · "+c.messageCount+" 条"+(c.omittedMessages?"（省略最早 "+c.omittedMessages+" 条）":"")}));
      c.messages.forEach((m,i)=>body.append(detailPart((i+1+c.omittedMessages)+". "+m.role+(m.toolName?" / "+m.toolName:""),m,i===c.messages.length-1)));
      body.append(el("h3",{className:"detail-section-title",text:"可用工具 · "+c.toolCount+" 个"}));c.tools.forEach(t=>body.append(detailPart(t.name,t,false)));
      if(d.response)body.append(el("h3",{className:"detail-section-title",text:"本次模型输出"}),detailPart("响应内容",d.response,true));
      body.append(el("p",{className:"muted small",text:"工具调用参数保留在 assistant 消息与本次输出中；工具执行结果出现在下一次请求的 toolResult 消息里。"}));
    }catch(error){if(version===cs.detailVersion)$("detail-body").replaceChildren(el("p",{text:"详情读取失败，请关闭后重试。"}));fail(error);}
  }
  const pendingKey=()=>"cs-agent:web-pending:"+cs.chat;
  function restorePending(){
    try{cs.pending=JSON.parse(sessionStorage.getItem(pendingKey())||"null");}catch{cs.pending=null;}
    if(cs.pending&&typeof cs.pending.text==="string")$("chat-input").value=cs.pending.text;else cs.pending=null;
    $("chat-input").readOnly=!!cs.pending;$("chat-send").textContent=cs.pending?"重试发送":"发送消息";
  }
  async function loadChat(){
    const thread=cs.chat,version=++cs.chatVersion,epoch=cs.epoch,d=await api("GET","/admin/threads/"+encodeURIComponent(thread)+"/chat");
    if(thread!==cs.chat||version!==cs.chatVersion||epoch!==cs.epoch)return;
    $("chat-title").textContent=(state.overview&&state.overview.threads.find(t=>t.key===thread)?.name)||thread;
    $("chat-state").textContent=cs.pending?"上次发送结果未确认，点击重试会沿用原编号。":d.queued?"有 "+d.queued+" 条网页输入正在排队或执行…":"回复只展示在此网页，不发送到 QQ。";
    const fingerprint=JSON.stringify(d.messages);if(fingerprint===cs.fingerprint)return;cs.fingerprint=fingerprint;
    const list=$("chat-messages"),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<100,first=!list.querySelector(".chat-message");
    list.replaceChildren(...d.messages.map(m=>el("article",{className:"chat-message "+m.role},[
      el("div",{className:"message-meta",text:(m.role==="assistant"?"助手":m.name||"用户")+" · "+(m.source==="web"?"网页":"QQ")+" · "+bjTime(m.at)+(m.status?" · "+(statuses[m.status]||m.status):"")}),el("div",{className:"message-text",text:m.text})])));
    if(!d.messages.length)list.append(el("div",{className:"empty-state"},[el("strong",{text:"从这里继续对话"}),"网页发言会进入当前会话，QQ 里的上下文仍然保留。"]));
    if(nearBottom||first)list.scrollTop=list.scrollHeight;
  }
  async function sendChat(event){
    event.preventDefault();if(cs.sending)return;
    const thread=cs.chat,text=$("chat-input").value.trim();if(!text)return;
    const pending=cs.pending||{requestId:crypto.randomUUID(),text};cs.pending=pending;
    try{sessionStorage.setItem(pendingKey(),JSON.stringify(pending));}catch{}
    cs.sending=true;$("chat-send").disabled=true;$("chat-input").readOnly=true;$("chat-state").textContent="正在提交…";
    try{
      await api("POST","/admin/threads/"+encodeURIComponent(thread)+"/chat",pending);
      try{sessionStorage.removeItem("cs-agent:web-pending:"+thread);}catch{}
      if(cs.chat===thread){cs.pending=null;$("chat-input").value="";$("chat-input").readOnly=false;$("chat-send").textContent="发送消息";await loadChat();$("chat-input").focus();}
    }catch(error){
      if(cs.chat===thread){
        const rejected=error instanceof ApiError && error.status>=400 && error.status<500 && error.status!==429;
        if(rejected){cs.pending=null;try{sessionStorage.removeItem(pendingKey());}catch{}$("chat-input").readOnly=false;}
        $("chat-state").textContent=rejected?"消息未提交，请检查后重试。":"发送结果未确认。重试会使用相同编号，避免重复提交。";$("chat-send").textContent=rejected?"发送消息":"重试发送";
      }
      fail(error);
    }finally{cs.sending=false;$("chat-send").disabled=false;}
  }
  document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>consoleView(b.dataset.view)));
  ["req-range","req-thread","req-model","req-purpose","req-status"].forEach(id=>$(id).addEventListener("change",refreshRequests));
  $("req-refresh").addEventListener("click",refreshRequests);
  $("req-prev").addEventListener("click",()=>{cs.before=cs.pages.pop();loadRequests().catch(fail);});
  $("req-next").addEventListener("click",()=>{if(!cs.next)return;cs.pages.push(cs.before);cs.before=cs.next;loadRequests().catch(fail);});
  $("detail-close").addEventListener("click",()=>{$("request-detail").close();cs.detailVersion++;});
  $("chat-form").addEventListener("submit",sendChat);
  $("chat-input").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();$("chat-form").requestSubmit();}});
  $("chat-reload").addEventListener("click",()=>loadChat().catch(fail));
`;
