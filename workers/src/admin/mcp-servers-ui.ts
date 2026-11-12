export const MCP_SERVERS_HTML = String.raw`
<details id="mcp-server-editor" class="source">
  <summary>接入或管理 MCP 服务</summary>
  <p class="muted small">保存连接 → 填写凭据或登录 → 检测工具 → 启用。修改即时保存，无需部署。</p>
  <div class="row"><select id="mcp-server-select" aria-label="选择 MCP 服务"><option value="">新增服务</option></select><button id="mcp-server-reload" type="button" class="btn">刷新服务</button></div>
  <div class="pair"><div class="field"><label for="mcp-server-id">服务名称</label><input id="mcp-server-id" type="text" placeholder="github" autocomplete="off"></div>
  <div class="field"><label for="mcp-server-url">HTTPS MCP 地址</label><input id="mcp-server-url" type="url" placeholder="https://api.githubcopilot.com/mcp/" autocomplete="off"></div></div>
  <div class="row"><label for="mcp-server-auth">认证</label><select id="mcp-server-auth"><option value="none">无认证</option><option value="token">Token / 认证头</option><option value="oauth">OAuth 登录</option></select>
    <label for="mcp-server-scope">OAuth scope</label><input id="mcp-server-scope" type="text" placeholder="由服务提供方指定，可留空"></div>
  <div class="row"><button id="mcp-server-save" type="button" class="btn">保存连接</button><button id="mcp-server-login" type="button" class="btn">获取登录链接</button></div>
  <p class="muted small">重新保存已有连接会清除其旧凭据和工具选择。仅更新凭据时使用下方按钮。</p>
  <div id="mcp-server-credential" hidden><div class="pair"><div class="field"><label for="mcp-secret-header">认证头名称</label><input id="mcp-secret-header" type="text" value="Authorization" autocomplete="off"></div>
    <div class="field"><label for="mcp-secret-value">Token 或认证头值</label><input id="mcp-secret-value" type="password" autocomplete="new-password" placeholder="Authorization 可直接填写 Token"></div></div>
    <button id="mcp-secret-save" type="button" class="btn">保存凭据并检测</button><p class="muted small">凭据加密保存，不回显、不进入 agent 上下文。</p></div>
  <div class="row"><button id="mcp-server-probe" type="button" class="btn">检测连接与工具</button><button id="mcp-server-enable" type="button" class="btn primary">启用选中工具</button>
    <button id="mcp-server-disable" type="button" class="btn">停用</button><button id="mcp-server-remove" type="button" class="btn danger">移除服务</button></div>
  <p id="mcp-server-state" class="muted small" role="status">进入本页后加载服务。</p>
  <div id="mcp-server-tools" class="stack" style="padding:0"></div>
  <div class="field"><label for="mcp-server-resources">允许读取的资源 URI 前缀，每行一个；留空不开放资源</label><textarea id="mcp-server-resources" rows="2" style="min-height:65px"></textarea></div>
</details>`;
