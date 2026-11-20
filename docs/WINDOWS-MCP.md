# Windows MCP：持久 Hyper-V VM、临时 WSB 与独立桌面服务

Cloudflare Container 保留原生 `cs.coding` 工具与 R2 工作区；其他远程环境一律通过标准 MCP 接入，不走 R2 同步。`runner/` 提供：

1. **宿主机 Windows MCP 服务**：基于官方 MCP Streamable HTTP，将已配置的 **Hyper-V Windows VM** 作为持久工作区，将 **Windows Sandbox（WSB）** 作为临时隔离环境；监听 `127.0.0.1:7791`，经 HTTPS Tunnel 接入管理页。
2. **VM 内独立桌面 MCP 服务**：运行在 VM 登录用户交互会话内，将原生 `agent-desktop mcp` 的 stdio 转为 Streamable HTTP（监听来宾 `127.0.0.1:7792/mcp`），经 VM 内独立 HTTPS Tunnel 接入，与宿主机后台任务完全解耦。

## 1. 环境与安全边界

| 环境 | 文件与系统状态 | 生命周期 | 工具 |
| --- | --- | --- | --- |
| Hyper-V VM（宿主机 MCP） | 持久保存在 VM 磁盘（`.git`、`node_modules`、已安装软件长期保留） | 管理员预建并启动；取消任务仅终止任务进程树，不关机/删除/回滚 VM | `env_list` / `env_status` / `env_submit` / `env_job_get` / `env_job_cancel` |
| WSB（宿主机 MCP） | 同一 session 内可复用；`C:\AgentWork` 及来宾目录全部易失 | 首次提交创建，显式关闭、活跃任务取消、空闲或硬期限销毁 | 同上 + `env_close` |
| 独立桌面 MCP（VM 内） | 与同 VM 共享磁盘、应用、焦点与剪贴板 | 随目标用户交互登录启动，注销后不可用 | 原生 `desktop_*` 工具 |

- **隔离约定**：WSB 不映射宿主项目、源码或依赖缓存，仅映射只读执行程序、当前命令输入与窄范围输出。Hyper-V 是受信任开发工作区，同 VM 的 shell 与桌面共享账户域；运行不可信代码必须选择 WSB。
- **调用归属**：模型不能通过参数指定宿主路径、任意 VM GUID 或调用者身份。每条任务幂等键为 `(principal, scope, target, requestId)`，由宿主注入不可伪造的 `params._meta["cs-agent/caller"]`（含 `scope` 与环境授权 `environments`）。

## 2. 宿主机 Windows MCP 安装与运行

需要 Windows、Node.js 24+；WSB 需启用 Windows Sandbox（含 `wsb.exe`），Hyper-V 需启用完整 Hyper-V 并预先准备支持 PowerShell Direct 的 Windows VM。

```powershell
npm run install:workers
npm --prefix runner run build
npm --prefix runner start -- init --state D:\windows-mcp-state
```

`init` 只接受专用新目录（本机 NTFS，WSB 需原子硬链接）并收紧 Windows ACL 至服务账户与 SYSTEM。配置示例（`config.json`）：

```json
{
  "stateDir": "D:\\windows-mcp-state",
  "host": "127.0.0.1",
  "port": 7791,
  "principals": [{ "id": "cs_agent", "tokenEnv": "WINDOWS_MCP_TOKEN" }],
  "targets": [
    {
      "kind": "hyperv",
      "id": "dev",
      "vmId": "00000000-0000-0000-0000-000000000000",
      "credentialPath": "D:\\private\\vm-credential.xml",
      "guestWorkdir": "C:\\AgentWork",
      "instructions": "用于长期开发；已有工具链和仓库位于 C:\\AgentWork。"
    },
    {
      "kind": "wsb",
      "id": "temp",
      "memoryMb": 6144,
      "idleTimeoutMs": 600000,
      "maxLifetimeMs": 3600000,
      "instructions": "用于临时验证和运行未知代码，重要结果需在关闭前导出。"
    }
  ]
}
```

- 每个 Hyper-V target 的 `id` 永久绑定同一 VM，不得改绑到另一台 VM；最多配置一个 WSB 提供方且同时最多一个活动 session。
- Token（≥ 32 字符）从环境变量提供，不要写入聊天或 Git：

```powershell
$env:WINDOWS_MCP_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
npm --prefix runner start -- inspect --config D:\windows-mcp-state\config.json
npm --prefix runner start -- run --config D:\windows-mcp-state\config.json
```

### 一次性准备 Hyper-V 来宾

由运行服务的同一 Windows 身份经 DPAPI 保存来宾凭据，再安装受限 S4U 计划任务与 `ProgramData\CsAgentHyperv` 助手（每条命令以挂起创建 → 加入 Job Object → 恢复执行，确保进程树受控）：

```powershell
$credential = Get-Credential
$credential | Export-Clixml -LiteralPath D:\private\vm-credential.xml -Encoding UTF8
.\runner\scripts\prepare-hyperv.ps1 `
  -VmId <VM GUID> `
  -CredentialPath D:\private\vm-credential.xml `
  -GuestWorkdir C:\AgentWork
```

### Cloudflare Tunnel 与管理页接入

配置 Tunnel 将专用 HTTPS 域名转发到 `http://127.0.0.1:7791`（`httpHostHeader: localhost:7791`），其余路径返回 404。在管理页「模型与接入 → MCP 服务」登记 `https://<域名>/mcp`、选择 Token 认证填写 `WINDOWS_MCP_TOKEN`，检测后勾选全部 6 个 `env_*` 工具并启用（仅 `env_list`、`env_status`、`env_job_get` 标记为只读）。

## 3. Agent 调用流程、群环境授权与账本

无论配置多少台 VM，工具固定为 6 项（新增 VM 仅改本机 `config.json` 并重启，无需改工具目录或重部署 Worker）：

| 工具 | 作用 |
| --- | --- |
| `env_list` | 列出当前调用方已授权环境的 `envId`、类型、工作目录与说明（不启动或探测实例） |
| `env_status` | 独立只读探测环境就绪状态、助手构建 SHA-256、队列与账本容量（不等待排队、不启动/关闭实例） |
| `env_submit` | 指定 `envId`、UUID `requestId`、`script`（可选 `cwd`、`timeoutMs` 默认 120s 上限 20m、`sessionId`），立即返回收据 |
| `env_job_get` | 按 `envId` + `requestId` 查询当前作用域任务与输出 |
| `env_job_cancel` | 取消当前作用域任务（活跃 WSB 取消销毁整台实例；Hyper-V 仅终止进程树） |
| `env_close` | 仅关闭临时 WSB session（持久环境拒绝） |

- **幂等与恢复**：同 `requestId` + 同参数返回原收据，异参拒绝；`unknown` 表示远端可能已执行，必须继续查询或取消，绝不换 ID 重跑。HTTP 断开不取消任务；WSB 具备独立硬期限 guardian。
- **子 agent 与群环境授权**：owner 私聊可访问全部已配置环境；群默认禁止所有 `env_*`，需在「权限与运维 → MCP 群授权」显式配置允许的 `envId` 列表、工具与成员，并可单独选择是否对授权范围内的环境写操作免逐次审批。子 agent 派出时通过 `mcpTools` 收窄工具并冻结当前环境范围快照。
- **本机 SQLite 账本**：任务身份、参数指纹、终态与退出摘要长期保留（无硬上限停服）；命令与输出正文存独立 payload 表，完成 7 天后每小时在线清理（已清理返回 `details: "archived"` 并保留 `resultSummary`）。调度器在每次派发前先结算所有已过期排队项，避免前序任务阻塞后续超时回执。

## 4. VM 内独立桌面 MCP

在 VM 内安装 Node.js 24+ 与 `agent-desktop` 并登录目标用户，准备独立 32 字节十六进制 Token 文件，从宿主机安装：

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

- 安装至来宾 `C:\ProgramData\CsAgentDesktop`（受 ACL 保护），注册登录后以普通权限隐藏运行的 `CsAgentDesktopMcp` 任务，仅监听 `127.0.0.1:7792/mcp`（Bearer Token 鉴权）。
- 在 VM 内配置 Cloudflare Tunnel，仅转发 `/mcp`（`httpHostHeader: localhost`），其余返回 404；在管理页作为独立 MCP 服务接入，保留原生 `desktop_*` 工具。
- **运行边界**：每次调用前校验用户 SID、登录会话、默认桌面与显示拓扑（锁屏/安全桌面/断线直接拒绝）；串行执行，最多 16 排队、8 原生客户端（空闲 10 分钟回收），请求上限 512 KiB，结果上限 12 MiB，含排队默认 45 秒超时；已开始后的超时或断线返回 `desktop_mcp_outcome_unknown` 不自动重放。首次读取 `desktop_skills_get`，截图经 `image(block)` 交给模型。

## 5. 验证与参考

```powershell
npm --prefix runner test
npm --prefix runner run test:wsb
npm run check
# Windows 本机可选非交互原生助手测试（不连接真实 VM / WSB / 桌面）：
$env:CS_AGENT_TEST_HYPERV_NATIVE = '1'
node --test --test-name-pattern="Hyper-V 来宾原生助手|独立桌面身份检查器" runner/test/hyperv.test.ts runner/test/desktop-server.test.ts
```

参考：[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)。
