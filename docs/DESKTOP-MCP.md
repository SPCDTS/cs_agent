# VM 内的独立桌面 MCP

桌面服务安装在 Windows VM 的登录用户会话内，使用官方 MCP SDK 将原生 `agent-desktop mcp` 的 stdio 转为 Streamable HTTP。云端 cs-agent 经 HTTPS Tunnel 直连该服务；桌面请求不经过宿主机 MCP、PowerShell Direct 或命名管道。宿主机的 Windows MCP 单独负责 Hyper-V/WSB 后台任务。

## 安装与启动

VM 内先安装 Node.js 24+ 和 agent-desktop，登录目标用户。准备独立的随机 32 字节十六进制 Token，保存在宿主机私有文件中。构建后运行：

```powershell
npm --prefix runner run build
.\runner\scripts\prepare-desktop.ps1 `
  -VmId '<VM GUID>' `
  -CredentialPath 'D:\windows-mcp-state\vm-credential.xml' `
  -GuestWorkdir 'C:\AgentWork' `
  -DesktopUser 'VMNAME\agent' `
  -NodePath 'C:\Tools\node.exe' `
  -Command 'C:\Tools\agent-desktop-win32-x64.exe' `
  -TokenPath 'D:\windows-mcp-state\desktop-token.txt' `
  -McpArguments @('mcp', '--headed')
```

脚本只在安装时使用 PowerShell Direct，不要求先安装宿主的后台任务助手。安装位置为来宾 `C:\ProgramData\CsAgentDesktop`，包含受 ACL 保护的 `config.json`、程序与桌面身份检查器。`CsAgentDesktopMcp` 计划任务在指定用户登录时以普通权限隐藏启动；更新前等待调用结束并停止该任务，再运行安装脚本。

服务只监听来宾 `127.0.0.1:7792/mcp`，所有请求需要 Bearer Token。将 Cloudflare Tunnel 部署在 VM 内，只将 `/mcp` 转到此地址，并设置 `httpHostHeader: localhost`，其余路径返回 404。不开放 VM 的局域网端口。Tunnel 可作为后台服务运行，但桌面 MCP 必须在交互登录任务里运行。

在 cs-agent 的 MCP 管理页创建独立服务，填入 HTTPS 地址和私有认证头，检测后选择工具，再启用。原生工具保持 `desktop_*` 名称，Code Mode 使用管理端发现的实际别名。与宿主的 `windows` 服务分别授权；不要把旧 `vm_dev_desktop_*` 名称或旧引用带到新服务。

## 行为与边界

- 原生参数 schema、annotations、结构化结果和图片块保留。首次读取 `desktop_skills_get` 的 desktop/platform 指南；Code Mode 使用 `image(block)` 将截图交给模型。
- 同一 VM 的应用、磁盘、焦点和剪贴板共享。调用会话只隔离原生客户端与控件引用，不能隔离桌面副作用；`--headed` 会使用物理键鼠焦点。
- 调用前检查用户 SID、登录会话、默认桌面和显示拓扑；锁屏、安全桌面、断线时拒绝操作。身份或显示变化会重建原生连接。
- 原生调用串行执行，最多 16 个待处理请求、8 个原生客户端，空闲 10 分钟回收。请求上限 512 KiB，结果上限 12 MiB，调用含排队默认 45 秒。
- 调用已开始后超时、断线或结果过大返回 `desktop_mcp_outcome_unknown`，不自动重放。先查询当前状态，避免重复提交或点击。
- 用户注销后桌面服务不可用，下次登录重新启动；宿主后台任务服务不依赖它。服务健康和桌面可操作性是两件事，实际发现工具/调用会检查桌面状态。

## 验证

`npm --prefix runner run typecheck` 和 `npm --prefix runner test` 覆盖官方 SDK HTTP→stdio 调用、图片和 schema、认证、引用隔离、锁屏拒绝、断线与排队取消。真实 VM 还需验证工具发现、UI 树、文本输入、点击和截图，以及公网 HTTPS 链路；fixture 测试不代表全部原生工具均已实测。
