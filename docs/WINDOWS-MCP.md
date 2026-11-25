# Windows Sandbox 宿主机接入

Windows runner 只负责宿主机上的临时 Windows Sandbox（WSB）。同一 session 中的命令可复用临时磁盘，关闭或到期后销毁它。持久 Windows VM 由来宾内的 Cua 设备服务登记。cs-agent 可查询登记后的设备卡片和 Driver 工具说明，工作区仍在 VM 磁盘上。[个人设备接入与切换](DEVICE-MCP.md)

## 从混合环境配置升级

升级前先用原服务结清旧 VM 任务并保存需要的输出。新版从原配置中读取 WSB，保留其环境 ID、凭据和状态目录，忽略原有 Hyper-V 目标。只含 Hyper-V 的实例已无 WSB 可提供，应停用。在混合配置中移除退役条目，保留同一 WSB 账户及原账本。

旧 VM 未派发的任务在账本中标为已取消，已经派发且没有终态证据的任务标为结果未知。检查来宾中的实际进程；切换后的宿主服务不会向它发送取消或重试命令。已绑定旧 VM 的 ID 不能改绑给 WSB。

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

- 每个服务最多配置一个 WSB 提供方，同一时间最多一个活动 session。
- Token（≥ 32 字符）从环境变量提供，不要写入聊天或 Git：

```powershell
$env:WINDOWS_MCP_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
npm --prefix runner start -- inspect --config D:\windows-mcp-state\config.json
npm --prefix runner start -- run --config D:\windows-mcp-state\config.json
```

### Cloudflare Tunnel 与管理页接入

配置 Tunnel 将专用 HTTPS 域名转发到 `http://127.0.0.1:7791`（`httpHostHeader: localhost:7791`），其余路径返回 404。在管理页「模型与接入 → MCP 服务」登记 `https://<域名>/mcp`、选择 Token 认证填写 `WINDOWS_MCP_TOKEN`，检测后勾选全部 6 个 `env_*` 工具并启用（仅 `env_list`、`env_status`、`env_job_get` 标记为只读）。

## Agent 调用流程、群环境授权与账本

宿主机服务提供以下六项工具。

| 工具 | 作用 |
| --- | --- |
| `env_list` | 列出当前调用方已授权环境的 `envId`、类型、工作目录与说明（不启动或探测实例） |
| `env_status` | 独立只读探测环境就绪状态、助手构建 SHA-256、队列与账本容量（不等待排队、不启动/关闭实例） |
| `env_submit` | 指定 `envId`、UUID `requestId`、`script`（可选 `cwd`、`timeoutMs` 默认 120s 上限 20m、`sessionId`），立即返回收据 |
| `env_job_get` | 按 `envId` + `requestId` 查询当前作用域任务与输出 |
| `env_job_cancel` | 取消本作用域任务；取消活跃 WSB 任务会销毁整台临时实例 |
| `env_close` | 关闭临时 WSB session，销毁实例中的临时文件 |

- **幂等与恢复**：同 `requestId` + 同参数返回原收据，异参拒绝；`unknown` 表示远端可能已执行，必须继续查询或取消，绝不换 ID 重跑。HTTP 断开不取消任务；WSB 具备独立硬期限 guardian。
- **子 agent 与群环境授权**：owner 私聊可访问全部已配置环境；群默认禁止所有 `env_*`，需在「权限与运维 → MCP 群授权」显式配置允许的 `envId` 列表、工具与成员，并可单独选择是否对授权范围内的环境写操作免逐次审批。子 agent 派出时通过 `mcpTools` 收窄工具并冻结当前环境范围快照。
- **本机 SQLite 账本**：任务身份、参数指纹、终态与退出摘要长期保留（无硬上限停服）；命令与输出正文存独立 payload 表，完成 7 天后每小时在线清理（已清理返回 `details: "archived"` 并保留 `resultSummary`）。调度器在每次派发前先结算所有已过期排队项，避免前序任务阻塞后续超时回执。

## 验证

`npm --prefix runner test` 覆盖真实回环 MCP 的协议和权限、任务账本及模拟 WSB 原生驱动。在启用了 Windows Sandbox 的宿主机上，运行以下验收命令，核对同一 session 的连续执行、全新实例的文件隔离和销毁确认。

```powershell
npm --prefix runner run test:wsb
```

[Microsoft Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) · [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
