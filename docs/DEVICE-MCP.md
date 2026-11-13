# 设备接入：默认命令行，可选桌面

设备客户端将本机命令行通过标准 MCP 提供给 cs-agent，支持 Windows、macOS 和 Linux。默认不安装 agent-desktop；只有配对时勾选桌面能力，才安装桌面组件。命令和桌面继续通过现有 Code Mode、MCP 工具选择和群授权使用。

## 管理员首次配置

在 Cloudflare 托管一个域名，为本实例设置以下 Worker secrets。域名使用该 Zone 的根域，例如 `example.com`；自动创建的设备地址为 `device-<随机 ID>.example.com`，避免多级域名证书问题。

| Secret | 内容 |
|---|---|
| `DEVICE_TUNNEL_ACCOUNT_ID` | Cloudflare Account ID |
| `DEVICE_TUNNEL_ZONE_ID` | 域名的 Zone ID |
| `DEVICE_TUNNEL_DOMAIN` | 该 Zone 的根域名，不包含协议或路径 |
| `DEVICE_TUNNEL_API_TOKEN` | 仅授予对应 Account 的 Cloudflare Tunnel Edit 和对应 Zone 的 DNS Edit |
| `OAUTH_STORE_KEY` | 沿用实例现有的凭据加密密钥，不要重新生成或替换 |

这一步由实例管理员完成一次，接入设备不需要 Cloudflare 账号或管理员 API Token。未配置时，管理页显示配置提示。现有 Hyper-V/WSB MCP 和桌面 MCP 不受影响。

后台采用 Cloudflare 官方的[远程托管 Tunnel API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)，为每台设备建立独立 Tunnel 和 DNS 记录。设备默认只开放 `/mcp`；启用桌面时，同一个 Tunnel 增加 `/desktop/mcp`，其余路径返回 404。两项能力使用不同的 MCP Bearer Token，Tunnel connector Token 不作为 MCP 调用凭据。

## 接入设备

1. 在 cs-agent 管理页进入“模型与接入”，展开“添加设备”。填写名称，桌面选项默认不勾选，点击“生成配对链接”。
2. 在待接入设备安装 Node.js 24 或以上版本，从同一页面下载 `cs-agent-device.cjs`。
3. 在终端执行 `node cs-agent-device.cjs pair`，将配对链接粘贴到程序提示中。链接包含短期配对凭据，不要发到聊天、日志或仓库。
4. 客户端自动准备 cloudflared、当前用户的登录自启动、MCP 服务并验证云端连接。默认目录是用户主目录下的 `AgentWork`，可以在配对时加 `--workdir <目录>`。
5. 显示“设备已接入”后，可让 cs-agent 在该设备执行命令。默认只对主人开放；群会话需要在既有 MCP 群授权中明确选择设备服务和工具。

配对有效期 30 分钟，第一次领取绑定到客户端生成并保存的随机 claim。相同客户端可以重试，另一客户端不能使用已领取的链接。未完成的设备可以在管理页“继续配对”；过期后会更新链接，但保留原 claim 绑定，需在原设备重试。原设备丢失时，撤销旧设备并新增。

cloudflared 从 Cloudflare 官方 GitHub release 获取，校验对应 asset 的 SHA-256 和长度。桌面组件固定安装 `agent-desktop@1.3.0`，位于客户端私有目录，与系统全局安装分开。首次下载需要能访问 GitHub Releases；桌面选项还需要访问 npm。

## 本机使用与恢复

客户端配置、二进制、收据默认在 `~/.cs-agent-device`。其中包含设备凭据，不得分享或提交。Unix 目录使用 0700、凭据文件使用 0600；Windows 去除目录继承并授予当前用户和 SYSTEM。客户端不持有 cs-agent 管理口令或 Cloudflare 管理 Token。

| 命令 | 作用 |
|---|---|
| `node cs-agent-device.cjs status` | 查看本机命令服务、Shell、目录和桌面配置状态 |
| `node cs-agent-device.cjs verify` | 重试云端连接检测与工具启用 |
| `node cs-agent-device.cjs permissions` | 启动可选桌面组件的系统权限引导 |
| `node cs-agent-device.cjs run` | 前台运行，供手动启动或排障 |
| `node cs-agent-device.cjs install-service` | 安装或修复登录自启动，并启动服务 |
| `node cs-agent-device.cjs remove-service` | 停止并移除登录自启动，保留配置、收据和工作区 |

所有命令可加 `--state-dir <目录>`。自启动名称按状态目录区分，多个目录不会覆盖彼此。服务会记录不含命令正文和凭据的运行事件到状态目录的 `service.log`。初始化失败保留配对 claim；重新运行 `pair` 可以继续同一设备，不会另建 Tunnel。

Windows 使用当前交互用户、Limited 权限的计划任务，隐藏启动；macOS 使用用户 LaunchAgent；Linux 使用 systemd 用户服务。默认都是登录后启动，不配置管理员运行、自动登录或系统级服务。Node.js 路径变化后需重新执行 `install-service`。Linux 没有 systemd 用户会话时可前台运行，或由已有进程管理器启动 `run`。

桌面组件需要已登录的交互会话及系统授权；可用 `permissions` 引导授权，再执行 `verify`。命令服务与桌面服务分别注册为 MCP 服务，桌面未就绪时已通过验证的命令能力仍保留。管理页的“已接入”表示配置和验证完成，不等同于设备当前在线；执行前可调用 `device_info` 探测。

管理页“撤销接入”先停用该设备的 MCP 服务和配对票据，再关闭该 Tunnel 的所有入口。关闭入口失败可再次点击重试；已发出的本机命令不会因此撤回，需先用 `shell_cancel` 或在本机停止。Tunnel 与 DNS 身份保留以便审计，后续可由 Cloudflare 管理员删除，不操作其他设备或项目的 Tunnel。

## Agent 可见的命令工具

| 工具 | 行为 |
|---|---|
| `device_info` | 系统、架构、用户名、Shell、默认目录和持久化说明 |
| `shell_exec` | 执行命令；通常等待最多 1 秒，短命令返回结果，长命令返回运行中收据 |
| `shell_status` | 按 `requestId` 查询当前调用会话的状态和有界输出 |
| `shell_cancel` | 请求取消当前调用会话的命令，继续查询确认状态 |

Windows 默认 Windows PowerShell，macOS 默认 zsh，Linux 默认 bash。命令每次启动新 Shell，因此 `cd`、Shell 变量不跨调用保存；工具显式接受 `cwd`。本机环境按当前账户权限执行，默认目录不是文件访问隔离边界。文件、Git 缓存和 `node_modules` 都留在设备，不同步到 R2，不自动复制工作区，不因会话结束而删除文件。

同一设备的不同会话和子 agent 共享本机文件。任务收据按云端注入的调用 scope 隔离；不同 scope 不能查询或取消彼此的命令。最多同时执行 4 条命令，默认超时 120 秒，上限 20 分钟，输出总量上限 256 KiB。stdout、stderr、退出码、截断标记都会返回。

每次操作必须生成 UUID `requestId`，重试保持 ID、命令、目录和超时一致。已受理操作不会自动重放；客户端异常重启后，未确认结果的命令标记 `unknown`，应先检查实际效果。终止命令采用操作系统进程树/进程组机制，不提供 WSB 级隔离，刻意脱离进程树的后台程序应由其自身服务机制管理。HTTP 断开不会取消任务。

完成输出保留 7 天后在后续提交时归档，去重收据和命令指纹继续保留，最多 100,000 条；达到上限拒绝新任务，不通过删除旧去重记录重新执行历史请求。原始命令不写入收据数据库。

## 构建与验证

客户端源码在 `runner/src/device-*.ts`。管理页构建时将其打包为单个 CJS 文件，由 `/admin/device-client.cjs` 提供下载，生成文件不提交 Git。下载内容仅包含程序，不包含实例配置或凭据。

运行 `npm run install:workers` 和 `npm run check`。设备 Shell 测试真实启动本机 Shell 和回环 MCP 服务；配对测试使用 workerd 的真实 Registry SQLite、合成凭据与模拟 Cloudflare/MCP 端点。CI 分别在 Linux、Windows 和 macOS 验证命令执行。真实云端 Tunnel、操作系统自启动和桌面授权需要在对应设备部署后验收。
