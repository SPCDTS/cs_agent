export const DEVICES_HTML = String.raw`
<details id="device-editor" class="source">
  <summary>添加设备 · 默认命令行，可选桌面</summary>
  <p class="muted small">设备默认提供本机命令行，代码与依赖保留在设备上。桌面能力按需安装。首次接入仅主人可用，共享请到 MCP 群授权设置。</p>
  <div class="row"><label for="device-name">设备名称</label><input id="device-name" type="text" maxlength="80" placeholder="我的 Mac" autocomplete="off">
    <label class="row"><input id="device-desktop" type="checkbox">安装 agent-desktop，允许操作登录用户的桌面</label></div>
  <div class="row"><button id="device-create" class="btn primary" type="button">生成配对链接</button><button id="device-reload" class="btn" type="button">刷新设备</button></div>
  <p id="device-state" class="muted small" role="status">展开后加载设备。</p>
  <div id="device-pairing" hidden>
    <p>1. 在待接入设备安装 Node.js 24 或以上版本，<a href="/admin/device-client.cjs" download="cs-agent-device.cjs">下载设备客户端</a>。</p>
    <p>2. 在终端运行 <code>node cs-agent-device.cjs pair</code>，按提示粘贴下方链接。</p>
    <label for="device-link">一次性配对链接（30 分钟有效，仅供这台设备使用）</label><input id="device-link" type="password" readonly autocomplete="off">
    <button id="device-copy" type="button" class="btn">复制配对链接</button>
    <p class="muted small">客户端自动安装 Tunnel 并设置当前用户登录自启动；命令按该用户权限执行。默认目录为用户主目录下 AgentWork。无需复制长期 Token，也不需要设备上的 Cloudflare 管理凭据。</p>
  </div>
  <div id="device-list" class="stack" style="padding:0"></div>
</details>`;
