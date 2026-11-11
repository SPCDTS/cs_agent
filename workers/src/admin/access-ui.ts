// 复用管理台的 card/stack/field/table 样式与 api/el/show/fail/time 辅助函数；进入对应页面或点击刷新时加载。
const limitFields = [
  {name:"perChatMinute",label:"每会话每分钟",max:600}, {name:"perChatHour",label:"每会话每小时",max:36000},
  {name:"chatBreakerMinutes",label:"会话熔断（分钟）",max:1440}, {name:"globalMinute",label:"全局每分钟",max:6000},
  {name:"globalBreakerMinutes",label:"全局熔断（分钟）",max:1440},
];
const retentionFields = [
  {name:"rawDays",label:"聊天原文（天）"}, {name:"rawHardMaxDays",label:"原文最长保留（天）"},
  {name:"summaryDays",label:"摘要（天）"}, {name:"eventsDays",label:"审计事件（天）"},
];
const numbers = (prefix:string,fields:{name:string;label:string;max?:number}[],override=false) => fields.map(field=>
  `<div class="field"><label for="${prefix}-${field.name}">${field.label}</label><input id="${prefix}-${field.name}" type="number" min="${prefix==="access-limit"?1:0}" max="${field.max??3650}" step="1" ${override?'placeholder="沿用默认"':'required'}></div>`).join("");

export const ACCESS_HTML = `
<section id="access-panel" class="card">
  <div class="section-head"><h2 class="h2">权限与运维</h2><span id="access-loaded" class="muted small">按需加载，不自动刷新</span><div class="grow"></div><button id="access-refresh" class="btn" type="button">加载 / 刷新</button></div>
  <div class="stack"><p class="muted small" style="margin:0">沙箱按需启动，空闲 3 分钟自动停止。发送账本最多 5000 条，正文保留 30 天。</p></div>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">人格设定</h2><span class="muted small">下一回合生效</span><div class="grow"></div><span id="access-persona-revision" class="muted small"></span></div>
  <form id="access-persona-form" class="stack">
    <label for="access-persona">全局人格与工作方式</label><textarea id="access-persona" maxlength="65536" placeholder="填写机器人的人格与工作方式"></textarea>
    <div class="row"><button id="access-persona-save" class="btn primary" type="submit" disabled>保存人格</button><span class="muted small">独立于长期记忆画像；保存会检查是否已有其他修改。</span></div>
  </form>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">主动发送与定时授权</h2><span class="muted small">owner 来自服务端配置；此处不能升级 owner。</span></div>
  <div class="scroll"><table class="wide"><thead><tr><th>用户</th><th>能力</th><th>目标 / 来源</th><th>期限</th><th></th></tr></thead><tbody id="access-grants"><tr><td colspan="5" class="muted">尚未加载</td></tr></tbody></table></div>
  <form id="access-grant-form" class="stack">
    <div class="row"><div class="field"><label for="access-grant-user">用户 QQ 号</label><input id="access-grant-user" type="text" placeholder="QQ 号或 qq:QQ号" required></div><label><input id="access-grant-send" type="checkbox" checked> 主动发送</label><label><input id="access-grant-schedule" type="checkbox"> 定时任务</label><div class="field"><label for="access-grant-hours">有效小时数（留空为长期）</label><input id="access-grant-hours" type="number" min="0.01" max="876000" step="any"></div></div>
    <div class="pair"><div class="field grow"><label for="access-grant-targets">可主动发送的目标（每行一个，空表示不允许跨会话发送）</label><textarea id="access-grant-targets" style="min-height:80px" placeholder="qq:group:群号&#10;qq:private:QQ号"></textarea></div><div class="field grow"><label><input id="access-grant-restrict" type="checkbox"> 限制授权来源会话</label><textarea id="access-grant-scopes" style="min-height:80px" placeholder="group:群号&#10;private:QQ号" disabled></textarea><span class="muted small">不勾选时允许任意来源；勾选但留空时不允许任何来源。</span></div></div>
    <div class="row"><button class="btn primary" type="submit">保存该用户授权</button><span class="muted small">保存会替换该用户现有授权；撤销立即生效。</span></div>
  </form>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">发送额度、告警与保留期</h2><span id="access-ops-revision" class="muted small"></span></div>
  <form id="access-ops-form" class="stack">
    <strong>发送额度</strong><div class="row">${numbers("access-limit",limitFields)}</div>
    <strong>owner 告警</strong><div class="row"><label><input id="access-alert-owner" type="checkbox"> 向 owner 私聊通知</label><div class="field"><label for="access-alert-throttle">同类会话间隔（分钟）</label><input id="access-alert-throttle" type="number" min="10" max="1440" required></div><div class="field"><label for="access-owner-throttle">owner 通知间隔（分钟）</label><input id="access-owner-throttle" type="number" min="30" max="1440" required></div></div>
    <div class="muted small">鉴权失败、连续三次失败、QQ 断线超过五分钟产生告警。网页回合的告警只显示在面板。</div>
    <strong>全局默认保留期</strong><div class="row">${numbers("access-default",retentionFields)}<label><input id="access-default-consolidate" type="checkbox"> 定期整理长期记忆</label></div><div class="muted small">天数 0 表示不清理；发送安全账本使用单独的 30 天正文期限。</div>
    <details class="source"><summary>按会话覆盖保留期与整理开关</summary><div class="field"><label for="access-override-thread">会话</label><input id="access-override-thread" type="text" placeholder="owner、group:群号、private:QQ号"></div><div class="row">${numbers("access-override",retentionFields,true)}<div class="field"><label for="access-override-consolidate">长期记忆整理</label><select id="access-override-consolidate"><option value="">沿用默认</option><option value="true">开启</option><option value="false">关闭</option></select></div></div><div class="row"><button id="access-override-add" class="btn" type="button">加入覆盖列表</button><span class="muted small">空白项沿用默认；加入后点击下方保存。</span></div><div class="scroll"><table><thead><tr><th>会话</th><th>覆盖内容</th><th></th></tr></thead><tbody id="access-overrides"></tbody></table></div></details>
    <div class="row"><button id="access-ops-save" class="btn primary" type="submit" disabled>保存运维设置</button></div>
  </form>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">运行告警</h2><div class="grow"></div><button id="access-alerts-refresh" class="btn compact" type="button">刷新告警</button></div>
  <div class="scroll"><table class="wide"><thead><tr><th>时间 / 会话</th><th>来源</th><th>内容</th><th>状态</th></tr></thead><tbody id="access-alerts"><tr><td colspan="4" class="muted">尚未加载</td></tr></tbody></table></div>
</section>
<section class="card">
  <div class="section-head"><h2 class="h2">发送记录</h2><span class="muted small">查证只读取 QQ 历史，不会重新发送</span><div class="grow"></div><button id="access-deliveries-refresh" class="btn compact" type="button">刷新发送记录</button></div>
  <div class="scroll"><table class="wide"><thead><tr><th>时间 / 操作 ID</th><th>状态</th><th>消息 ID / 说明</th><th></th></tr></thead><tbody id="access-deliveries"><tr><td colspan="4" class="muted">尚未加载</td></tr></tbody></table></div>
</section>`;
