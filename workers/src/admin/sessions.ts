import { ADMIN_PAGE_SIZE } from "./pagination";

export const SESSION_HTML = `
<dialog id="session-history" class="detail-dialog" aria-labelledby="session-history-title">
  <header class="detail-head"><div><h2 id="session-history-title">会话历史与归档</h2><small id="session-history-scope"></small></div><button id="session-history-refresh" class="btn" type="button">刷新</button><button id="session-history-close" class="btn" type="button">关闭</button></header>
  <div id="session-history-body" class="detail-body"></div>
  <div class="pager"><span class="muted small">每次加载 ${ADMIN_PAGE_SIZE} 条，重置前的消息、工具记录仍可查看</span><button id="session-history-older" class="btn" type="button">更早记录</button></div>
</dialog>`;
