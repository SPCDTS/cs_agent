# Windows 接入：持久 VM 直接配对，临时 WSB 由宿主机管理

| 环境 | 安装位置 | cs-agent 使用的工具 | 文件与运行条件 |
| --- | --- | --- | --- |
| 持久 Windows VM | 在来宾里登录开发账户，运行设备客户端配对 | `device_info`、`shell_*`，可选独立的 `desktop_*` 服务 | 仓库和软件留在 VM 磁盘；客户端随用户登录启动 |
| 临时 Windows Sandbox（WSB） | 在 Windows 宿主机运行 WSB 服务 | `env_*` | 同一 session 可复用，关闭、超时或取消活跃任务会销毁临时实例 |
| 旧宿主机 Hyper-V target | 已有的宿主机服务和来宾助手 | 既有 `env_*` 收据按原 envId 查询和取消 | 可逐台迁移，保留来宾磁盘和宿主机任务账本 |

持久 VM 是受信任的开发环境。运行来源不明的代码时使用 WSB。WSB 只映射执行程序和本次任务的输入输出，宿主项目与依赖缓存留在宿主机。

## 持久 VM 接入

在管理台的「模型与接入 → MCP 与设备」生成设备配对链接。在 VM 内下载客户端，用开发账户的 PowerShell 执行配对，`--workdir` 指向已有项目目录。配对时可单独勾选桌面能力。账号、路径和工具的验收步骤见[设备配对说明](DEVICE-MCP.md#持久-windows-vm)。

### 迁移已有宿主机 VM 环境

1. 先在来宾内配对。用新设备的 `device_info` 核对主机名、用户和工作目录，再通过 `shell_exec` 执行 `Get-Location`。迁移前已发出的命令继续由原服务管理，包括执行结果尚未确认的命令；跨服务重复提交会被当作另一项任务。
2. 在宿主机原 `config.json` 中，仅给这台 VM 的 `hyperv` target 加上 `"drainOnly": true`，将原 envId、来宾凭据、工作目录和 `stateDir` 保持原值，重启更新后的 runner。`env_list` 将标记该环境只处理旧任务，新的 `env_submit` 返回 `hyperv_target_draining`。已受理的任务继续运行，原参数重试仍返回原收据，可用 `env_job_get` 查询、用 `env_job_cancel` 取消。
3. 新设备默认仅主人可用。需要共享时，在管理台为该设备重新选择群、成员和具体工具。旧的环境授权与审批设置只作用于原宿主机服务。
4. 保留旧 target 和账本，直到各调用会话确认排队、运行中及结果未知的任务都已结清，并取回所需输出。仍需通过 MCP 查询历史收据时继续保留该配置。可以退役时，从有其他目标的配置中移除这台 VM；若它是唯一目标，可停用旧服务。共用宿主机的 WSB 继续使用原配置和授权。

## 临时 WSB 的宿主机配置

在宿主机安装 Node.js 24+ 并启用 Windows Sandbox（含 `wsb.exe`）。

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

### Cloudflare Tunnel 与管理页接入

配置 Tunnel 将专用 HTTPS 域名转发到 `http://127.0.0.1:7791`（`httpHostHeader: localhost:7791`），其余路径返回 404。在管理页「模型与接入 → MCP 服务」登记 `https://<域名>/mcp`、选择 Token 认证填写 `WINDOWS_MCP_TOKEN`，检测后勾选全部 6 个 `env_*` 工具并启用（仅 `env_list`、`env_status`、`env_job_get` 标记为只读）。

## Agent 调用流程、群环境授权与账本

宿主机服务提供以下 6 项工具。直接配对的 VM 出现在管理台的设备服务中。

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

## 维护旧版 VM 独立桌面 MCP

已单独部署桌面服务的 VM 可继续沿用其登录会话检查与原有桌面授权。以下为旧服务的维护步骤。新设备可在配对时勾选桌面能力。

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

## 验证与参考

```powershell
npm --prefix runner test
npm --prefix runner run test:wsb
npm run check
# Windows 本机可选非交互原生助手测试（不连接真实 VM / WSB / 桌面）：
$env:CS_AGENT_TEST_HYPERV_NATIVE = '1'
node --test --test-name-pattern="Hyper-V 来宾原生助手|独立桌面身份检查器" runner/test/hyperv.test.ts runner/test/desktop-server.test.ts
```

参考：[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)。
