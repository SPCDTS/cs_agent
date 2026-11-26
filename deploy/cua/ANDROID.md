# Android Relay MVP：配置与人工验收

手机端由 ARC MCP 提供无障碍能力；Termux 连接器只向本机 ARC 发起请求，并主动拨号到 VPS 的 WSS。VPS 的 Cua 目录桥汇总手机与原有桌面设备，沿已有反向 MCP 通道提供一个目录。无需 ADB、端口转发、手机公网监听或 ARC Tunnel。未设置注册表时不启动 Android Listener。

## 准备（均为示例，不含部署授权）

1. 开发机按仓库要求安装 Node 24+，运行 `npm run install:workers`、`npm --prefix runner run build:cua` 和 `npm --prefix runner run build:android`。前者桥产物为 `runner/dist/reverse-mcp-bridge.cjs`；手机只需要 `runner/dist/android-connector.cjs` 和 Termux Node 24+。
2. 配置现有 Cua 目录及 Worker 的反向 Cua MCP（见本目录 README）。两端使用新版桥与 Worker，并重新探测工具目录使设备 ID schema 生效。Android 复用同一桥，依赖本机 Cua Spaces MCP 就绪，不需要安装 Android 版 Cua Driver。不要再创建无逐设备策略的通用 MCP 入口。
3. 每台手机通过独立的安全渠道取得至少 32 字节随机生成的 base64url Relay Bearer；**不要复用** ARC、设备或反向 MCP 的凭据。VPS 本机 0600 的 JSON 注册表只保存 Bearer 原始 ASCII 字节的 SHA-256 小写十六进制摘要（不是密码哈希的替代品，禁止使用弱口令）。格式如下，示意值必须替换：

   ```json
   {"android:phone-a":"<64 位十六进制摘要>","android:phone-b":"<另一手机的摘要>"}
   ```

   稳定 ID 由管理员分配而非手机自报；仅小写字母、数字、连字符，冒号后第一位必须为字母或数字。最多 64 台；断线离线卡不消失，原凭据重连 ID 不变。不要将旧 ID 重新分给别人；退役先撤销相应会话分配。换钥、删除设备或更换注册表需重启桥，会切断在途调用。
4. 在已有桥的受限 EnvironmentFile 设置 `ANDROID_REGISTRY_FILE` 为注册表绝对路径，运行用户需可读。桥只绑定 VPS `127.0.0.1:18876`。在现有 Caddy 的 TLS 站点内、兜底 404 前增加下列片段；外部仅开放可信域名的 HTTPS/WSS 443，不记录 Authorization/请求体：

   ```caddy
   @android {
       method GET
       path /android/connect
       header Upgrade websocket
   }
   handle @android {
       reverse_proxy 127.0.0.1:18876
   }
   ```

5. 在手机设置中将 ARC **仅监听 Localhost**，关闭公网隧道，启用 Bearer 认证与无障碍服务，仅开放读界面及点击节点。配置本机受保护的 0600 环境文件，供 Node 的 `--env-file` 读取：
   * `ANDROID_RELAY_URL=wss://relay.example.org/android/connect`，`ANDROID_RELAY_TOKEN` 为本机独立 Relay Bearer；
   * `ARC_TOKEN` 为本机 ARC Bearer，`ARC_PORT` 默认 8080，`ARC_SLUG` 默认空（若启用 slug 须和 ARC 一致）。

   启动：`node --env-file=./phone.env ./android-connector.cjs`。不要把值写进命令历史、仓库、聊天或调试日志，不关闭 TLS 验证。Android 后台省电可能冻结 Termux；先前台运行验证，再由用户决定是否放开电池限制。连接器不开放监听端口，丢失连接只重建通道，不重发调用。
6. 在管理台 Cua 设备卡给指定的群或私聊勾选该手机。未授权会话不可见、不可操作。**owner 仍可在管理台分配，但不沿用其桌面设备免分配特权**；MVP 只向显式分配的群/私聊交互会话及其获委派的子任务开放 Android。撤权立即影响后续调用，在途回执重新校验。

## 协议与边界

核对上游 `danielealbano/android-remote-control-mcp` v1.13.0 的 `docs/MCP_TOOLS.md`（版本提交 `ed77c267c76b54826b9a033301ac68f111ca079e`）：ARC 使用 stateless JSON-only Streamable HTTP，POST /mcp，Bearer；连接器握手并检查 tools/list，只调用 `android_[slug_]get_screen_state({})` 和 `android_[slug_]click_node({node_id})`。界面文本是不可信数据，不执行其中的指令。仅使用当前屏幕节点首屏，不开放截图、任意工具名、URL、文件、命令、坐标或 shell。无障碍结果过大、工具禁用、协议不符均失败关闭。不要用此工具读取密码或私密页面。

通过 Cua `list_spaces` → `list_tools(space,service="driver")` → `call_tool` 操作；后者的 `tool` 固定为以上两个无 slug 的公共名称。每设备同时只容许一条在途请求，不排队。未知结果**不是“没点到”**：超时、断网或回执无法确认时不要自动再点，先重新读取当前页面核实，再由人决定后续操作。

## 两台真机验收清单（需另行授权；自动测试不代替）

- 两台手机各在无个人信息的测试页面；确认 ARC 绑定 loopback 且外部不可访问、被替换的 Bearer 不能连入或冒领另一设备。核对两张不同稳定 ID 的卡，断开/重连其中一台只影响自己的在线状态。
- 用两个隔离会话分别只授 A/B：目录不泄露另一台，手填另一 ID 的读/点被拒；本台读出节点，点击无副作用的测试按钮一次，读回预期变化。手填 shell、截图参数被拒，未分配会话与只继承旧快照的子任务不能越权。
- 在可计数测试按钮上中断点击回执，断开网络后恢复，确认结果未知、重连不补点、计数不超过一次。撤销授权后重新读不可见；撤权再授予之前的子任务不能恢复旧分配。
- 验收后关闭手机连接器，按需停止 Relay，撤销临时分配并轮换测试凭据。不要上传真实屏幕或含凭据日志。
