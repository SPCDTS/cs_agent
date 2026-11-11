export const MEMORY_MANAGER_HTML = `
<div class="row" style="padding:12px 20px;border-top:1px solid var(--line)">
  <label>状态 <select id="mem-status"><option value="active">活跃</option><option value="all">全部</option><option value="superseded">已替代</option><option value="forgotten">已删除</option></select></label>
  <button id="mem-prev" class="btn" type="button">上一页</button><span id="mem-page" class="muted small"></span><button id="mem-next" class="btn" type="button">下一页</button>
  <button id="mem-jobs" class="btn" type="button">整理与画像建议</button>
</div>
<dialog id="memory-detail" class="detail-dialog"><header class="detail-head"><h2 id="memory-detail-title">记忆详情</h2><button id="memory-detail-close" class="btn" type="button">关闭</button></header><div id="memory-detail-body" class="detail-body"></div></dialog>`;
