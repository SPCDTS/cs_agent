import { REQUEST_DETAIL_CSS } from "./request-detail";


import { TOPOLOGY_CSS, TOPOLOGY_HTML } from "./topology";

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
.chat-tree,.chat-tree ul{list-style:none;margin:0;padding:0}.chat-family+.chat-family{margin-top:14px}.chat-children{margin:0 0 8px 10px}.chat-children>summary{padding:5px 4px;font-size:12px;color:var(--muted);cursor:pointer}.chat-children>ul{border-left:1px solid #C8DAD6;padding-left:9px;margin-top:5px}.chat-child{padding:9px;font-size:12px}.chat-child>span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.chat-show-more{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;text-align:left;padding:7px 9px;cursor:pointer;border-radius:5px}.chat-show-more:hover{background:#E4F2EE;color:#08675E}.chat-tree-note{font-size:12px;color:var(--muted);padding:8px}.chat-thread:hover{background:#EEF5F3}.chat-thread:focus-visible,.chat-children>summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.chat-main{display:flex;flex-direction:column;min-width:0;min-height:0}.chat-top{padding:16px 24px;flex-wrap:wrap;border-bottom:1px solid var(--line);display:flex;gap:15px;align-items:center;justify-content:space-between}.chat-top>div:first-child{flex:1;min-width:160px;overflow-wrap:anywhere}.chat-top strong{font-weight:600}.chat-top .row{flex-wrap:wrap}.chat-top small{display:block;margin-top:4px;color:var(--muted)}
.chat-messages{flex:1;overflow:auto;padding:20px 28px;scroll-behavior:auto}.chat-message{max-width:85%;margin-bottom:22px;line-height:1.7}.chat-message.user{margin-left:auto}.message-meta{font-size:11px;color:var(--muted);margin-bottom:5px}.message-text{padding:12px 16px;border-radius:10px;background:#F1F5F5;white-space:pre-wrap;overflow-wrap:anywhere}.chat-message.user .message-text{background:#E5F3EF}.chat-message.assistant .message-text{background:#fff;border-left:3px solid #7EBCAF;border-radius:0;padding-left:16px}
.chat-composer{padding:0 24px 16px;background:#fff}.chat-composer textarea{min-height:82px;max-height:180px;resize:vertical;border-color:#C8DAD6}.composer-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px}.composer-footer small{color:var(--muted)}#chat-state{padding:12px 24px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);min-height:20px}
@media(min-width:1800px){main{margin-right:auto}.topbar-inner{max-width:1600px;margin-left:0}}
@media(max-width:1100px){.analytics{grid-template-columns:1fr}.model-panel{display:none}.metrics{gap:12px}.metric-value{font-size:24px}.chat-layout{grid-template-columns:185px minmax(0,1fr)}}
@media(max-width:760px){.sidebar{position:static;width:auto;padding:15px;gap:14px;border-right:0}.sidebar .wordmark{font-size:20px;padding:0}.sidebar nav{flex-direction:row;gap:4px;overflow:auto}.nav-btn{white-space:nowrap;font-size:13px;padding:9px 11px}.sidebar-foot{display:none}.topbar{margin-left:0}.topbar-inner{padding:12px 18px}.topbar .brand{display:none}main{margin:0;padding:22px 16px;width:100%}.status-line{margin:10px 16px}.console-head h1{font-size:24px}.metrics{grid-template-columns:repeat(2,1fr);gap:18px}.metrics>div:last-child{grid-column:span 2}.filters{gap:8px}.filters label{flex:1;min-width:120px}.chat-layout{height:auto;min-height:530px;display:flex;flex-direction:column}.chat-threads{flex:none;max-height:200px;border-right:0;border-bottom:1px solid var(--line);padding:10px}.chat-threads h2{display:none}.chat-main{flex:none;height:600px;max-height:90dvh}.chat-thread{width:100%;margin:0}#chat-state{padding:10px 15px}.chat-top,.chat-composer{padding:12px 15px}.chat-messages{padding:18px 15px}.chat-message{max-width:95%}.detail-stats{grid-template-columns:repeat(2,1fr)}.detail-body{padding:16px}.detail-head{padding:16px}.console-head .row{width:100%}.chart-panel{padding:15px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
${REQUEST_DETAIL_CSS}
${TOPOLOGY_CSS}
`;

export const CONSOLE_NAV = String.raw`<aside class="sidebar">
  <div class="wordmark">cs<span> / </span>agent</div>
  <nav aria-label="管理台导航">
    <button type="button" class="nav-btn" data-view="usage" aria-current="page">用量总览</button>
    <button type="button" class="nav-btn" data-view="chat">会话对话</button>
    <div class="manage-nav-label">管理</div>
    <button type="button" class="nav-btn" data-view="models">模型与接入</button>
    <button type="button" class="nav-btn" data-view="memory">会话与记忆</button>
    <button type="button" class="nav-btn" data-view="operations">任务与事件</button>
    <button type="button" class="nav-btn" data-view="access">权限与运维</button>
    <button type="button" class="nav-btn" data-view="workspace">工作区</button>
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
  <div id="request-turn-filter" class="request-turn-filter" hidden><span>只看从对话选中的这一轮请求</span><button id="request-turn-clear" class="btn compact" type="button">查看全部</button></div>
  <div id="usage-summary">
    <div class="metrics">
      <div><div class="metric-label">模型请求</div><div id="metric-requests" class="metric-value">—</div><div id="metric-failures" class="metric-note">等待数据</div></div>
      <div><div class="metric-label">输入 token</div><div id="metric-input" class="metric-value">—</div><div class="metric-note">包含缓存读取与写入</div></div>
      <div><div class="metric-label">输出 token</div><div id="metric-output" class="metric-value">—</div><div class="metric-note">包含模型推理用量</div></div>
      <div><div class="metric-label">缓存命中率</div><div id="metric-cache" class="metric-value">—</div><div id="metric-cache-note" class="metric-note">缓存读取 / 总输入</div></div>
      <div><div class="metric-label">平均请求耗时</div><div id="metric-duration" class="metric-value">—</div><div id="metric-measured" class="metric-note">仅统计已完成采集</div></div>
    </div>
    <div class="analytics">
      <div class="chart-panel"><div class="panel-title"><h2>Token 用量趋势</h2><div class="legend"><span>输入</span><span>输出</span></div></div><svg id="token-chart" viewBox="0 0 840 210" role="img" aria-label="所选时间内的输入与输出 token 用量"></svg><div id="chart-note" class="small muted">北京时间</div></div>
      <div class="model-panel"><div class="panel-title"><h2>模型用量分布</h2><span class="small muted">输入 + 输出</span></div><div id="model-breakdown"></div></div>
    </div>
  </div>
  <section class="card"><div class="section-head"><h2 class="h2">请求记录</h2><span class="small muted">一次模型调用一条记录，工具续轮分别统计</span><span class="grow"></span><span id="req-count" class="small muted"></span></div>
    <div class="scroll"><table class="wide console-table"><thead><tr><th>时间 / 请求</th><th>模型 / 用途</th><th>会话</th><th>状态</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存命中率</th><th class="num">耗时</th></tr></thead><tbody id="request-rows"></tbody></table></div>
    <div id="request-empty" class="empty-state" hidden><strong>所选范围内还没有请求</strong>新版本会从上线后开始记录。可以切换范围，或在会话里发一条消息。</div>
    <div class="pager"><span id="request-state" class="small muted" role="status"></span><div class="row"><button id="req-prev" class="btn" type="button" disabled>上一页</button><button id="req-next" class="btn" type="button" disabled>下一页</button></div></div>
  </section>
  <p id="request-retention" class="retention-note">请求元数据最多保留 30 天，上下文详情最多 7 天；达到容量上限会提前清理。</p>
</section>
<section id="view-chat" hidden>
  <div class="console-head"><div><h1>会话对话</h1><p>继续 QQ 会话的上下文，在网页里接着聊。</p></div></div>
  ${TOPOLOGY_HTML}
  <div class="chat-layout"><aside class="chat-threads"><h2>已有会话</h2><div id="chat-thread-list"></div></aside>
    <section class="chat-main" aria-label="对话">
      <header class="chat-top"><div><strong id="chat-title">选择会话</strong><small id="chat-subtitle">共享上下文 · 网页发言只回复网页</small></div><div class="row"><button id="chat-history" class="btn compact" type="button">历史</button><button id="chat-compact" class="btn compact" type="button">压缩</button><button id="chat-reset" class="btn compact" type="button">归档重置</button><button id="chat-older" class="btn compact" type="button" hidden>更早记录</button><button id="chat-parent" class="btn compact" type="button" hidden>返回父会话</button><button id="chat-reload" class="btn compact" type="button">刷新</button></div></header>
      <div id="chat-messages" class="chat-messages" role="log" aria-live="polite" aria-relevant="additions"></div>
      <div id="chat-state" role="status"></div>
      <form id="chat-form" class="chat-composer"><label for="chat-input" class="small">发给当前会话</label><textarea id="chat-input" maxlength="16000" placeholder="输入消息，继续这段对话…" required></textarea>
        <div class="composer-footer"><small>Ctrl / ⌘ + Enter 发送 · 最近 100 条消息</small><button id="chat-send" class="btn primary" type="submit">发送消息</button></div>
      </form>
    </section>
  </div>
</section>
<dialog id="request-detail" class="detail-dialog" aria-labelledby="detail-title">
  <header class="detail-head"><div><h2 id="detail-title">请求详情</h2><div id="detail-id" class="detail-id"></div></div><button id="detail-close" class="btn" type="button">关闭</button></header><div id="detail-body" class="detail-body"></div>
</dialog>
`;
