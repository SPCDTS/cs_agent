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
      <div id="mcp-access-environment-fields" hidden>
        <div class="field"><label for="mcp-access-environments">允许的环境 ID，每行一个；留空禁止环境工具</label><textarea id="mcp-access-environments" rows="3" style="min-height:90px" placeholder="group852"></textarea></div>
        <label for="mcp-access-environment-approval">成员执行环境操作</label><select id="mcp-access-environment-approval"><option value="required">每次审批（默认）</option><option value="none">授权范围内直接执行</option></select>
        <p class="note">环境 ID 由 runner 配置；只开放上方勾选的操作。直接执行仅适用于所列环境，其他 MCP 写操作仍需审批。</p>
      </div>
      <div class="row">
        <label for="mcp-access-expires">授权到期（留空长期有效）</label><input id="mcp-access-expires" type="datetime-local">
        <span id="mcp-access-revision" class="mono muted small">revision=none</span>
        <button type="button" id="mcp-access-save" class="btn primary">保存明确授权</button>
        <button type="button" id="mcp-access-revoke" class="btn danger">撤销本服务授权</button>
      </div>
      <p class="note">普通 MCP 写操作仍须每次批准；环境操作遵循上方独立审批设置。更改授权会使该服务未执行的旧审批失效。</p>
    </div>
    <div class="row"><h3 style="margin:0">调用审批</h3><label><input type="checkbox" id="mcp-approvals-pending" checked>只看待审批</label><span class="muted small">批准仅执行下方固定参数一次；默认在本面板显示结果</span></div>
    <div id="mcp-approvals-list" class="stack" style="padding:0"><div class="muted">点击刷新加载审批。</div></div>
    <div id="mcp-approval-result" class="source" hidden></div>
  </div>
</section>
`;
