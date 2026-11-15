export const MEMORY_FILTER_HTML = `
<div class="memory-toolbar" aria-label="记忆筛选">
  <label>状态 <select id="mem-status"><option value="active">活跃</option><option value="all">全部状态</option><option value="superseded">已替代</option><option value="retired">已归档</option><option value="orphaned">来源已撤回</option><option value="forgotten">已遗忘</option></select></label>
  <label>类型 <select id="mem-kind"><option value="">全部类型</option><option value="fact">事实</option><option value="preference">偏好</option><option value="rule">要求</option><option value="commitment">承诺 / 待办</option><option value="episode">经历</option></select></label>
  <label>有效状态 <select id="mem-validity"><option value="">全部时间</option><option value="current">当前有效</option><option value="expired">已过期</option><option value="future">尚未生效</option><option value="open">未完成承诺</option><option value="done">已完成承诺</option></select></label>
  <label>来源 <select id="mem-source"><option value="">全部来源</option><option value="explicit">显式记录</option><option value="extractor">自动抽取</option></select></label>
  <button id="mem-add" class="btn" type="button">新增记忆</button>
  <button id="mem-jobs" class="btn" type="button">待确认与整理</button>
  <button id="mem-refresh" class="btn" type="button">刷新</button>
</div>`;
export const MEMORY_MANAGER_HTML = `
  <div class="memory-pagination"><button id="mem-prev" class="btn" type="button">上一页</button><span id="mem-page" class="muted small" aria-live="polite"></span><button id="mem-next" class="btn" type="button">下一页</button></div>
<dialog id="memory-detail" class="detail-dialog memory-dialog"><header class="detail-head"><h2 id="memory-detail-title">记忆详情</h2><button id="memory-detail-close" class="btn" type="button">关闭</button></header><div id="memory-detail-body" class="detail-body"></div></dialog>`;
