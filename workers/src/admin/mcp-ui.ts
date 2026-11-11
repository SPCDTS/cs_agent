/** 插入管理视图；不含授权数据，读取与提交均走现有 Bearer API。 */
export const MCP_ADMIN_HTML = `
<section class="card" id="mcp-access-section">
  <div class="section-head"><h2 class="h2">MCP 群授权与逐次审批</h2><span class="muted small">默认仅 owner 私聊可用；群必须明确授权</span></div>
  <div class="stack">
    <div class="row">
      <label for="mcp-access-thread">线程</label><select id="mcp-access-thread"><option value="owner">owner</option></select>
      <label for="mcp-access-server">服务</label><select id="mcp-access-server"></select>
      <button type="button" class="btn" id="mcp-access-threads">加载线程</button>
      <button type="button" class="btn" id="mcp-access-refresh">刷新授权与审批</button>
    </div>
    <div id="mcp-access-note" class="muted small">选择群线程后加载授权。所有刷新均由按钮触发。</div>
    <div id="mcp-access-editor" hidden>
      <div class="field"><label>明确允许的工具（未勾选即禁止）</label><div id="mcp-access-tools" class="row"></div></div>
      <div class="pair">
        <div class="field" style="flex:1"><label for="mcp-access-actors">允许成员，每行一个 QQ；* 表示全部成员</label><textarea id="mcp-access-actors" rows="3" style="min-height:90px" placeholder="10000003"></textarea></div>
        <div class="field" style="flex:1"><label for="mcp-access-resources">允许资源前缀，每行一个；留空即不开放资源</label><textarea id="mcp-access-resources" rows="3" style="min-height:90px" placeholder="notion://docs/"></textarea></div>
      </div>
      <div class="row">
        <label for="mcp-access-expires">授权到期（留空长期有效）</label><input id="mcp-access-expires" type="datetime-local">
        <span id="mcp-access-revision" class="mono muted small">revision=none</span>
        <button type="button" id="mcp-access-save" class="btn primary">保存明确授权</button>
        <button type="button" id="mcp-access-revoke" class="btn danger">撤销本服务授权</button>
      </div>
      <p class="note">成员对 owner 账号的写操作仍须每次批准。更改授权会使该服务未执行的旧审批失效。</p>
    </div>
    <div class="row"><h3 style="margin:0">调用审批</h3><label><input type="checkbox" id="mcp-approvals-pending" checked>只看待审批</label><span class="muted small">批准仅执行下方固定参数一次；默认在本面板显示结果</span></div>
    <div id="mcp-approvals-list" class="stack" style="padding:0"><div class="muted">点击刷新加载审批。</div></div>
    <div id="mcp-approval-result" class="source" hidden></div>
  </div>
</section>
`;
