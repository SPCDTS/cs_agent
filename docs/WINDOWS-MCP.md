# Windows MCP：持久 VM 与临时 WSB

`runner/` 运行独立的官方 MCP Streamable HTTP 服务。它将已配置的 Hyper-V Windows VM 作为持久工作区，将 Windows Sandbox（WSB）作为临时隔离环境。服务自身只监听 `127.0.0.1`，通过 HTTPS Tunnel 接入 cs-agent 的通用 MCP 管理页。Cloudflare Container 继续走原生 coding 工具。

## 两种环境

| 环境 | 文件与系统状态 | 生命周期 | 工具 |
| --- | --- | --- | --- |
| Hyper-V VM | 保存在 VM 磁盘；`.git`、`node_modules`、安装的软件可长期保留 | 管理员预先创建并启动；取消任务只终止任务进程树，不关机、删除或回滚 VM | PowerShell、任务查询/取消；桌面操作使用 VM 内独立 MCP |
| WSB | 同一 session 中可复用；`C:\AgentWork` 与其他来宾目录全部易失 | 首次提交创建，显式关闭、活跃任务取消、空闲或硬期限销毁 | PowerShell、任务查询/取消、关闭 session |

WSB 不映射宿主项目、源码或依赖缓存。仅映射执行所需的只读 Node/guest 程序、当前命令只读输入及窄范围结果输出。旧连接器的 `dataDir`、`D:\sandbox-data` 等已有用户目录不迁移、不读取、不删除。

Hyper-V 是受信任的开发工作区，同一 VM 的 shell 和桌面不是相互隔离的安全域。Job Object 管理正常子进程树与超时，不能阻止有权限的脚本另建计划任务或主动篡改同账户数据。运行不可信代码应选择 WSB。

## 准备本机服务

需要 Windows、Node.js 24+。WSB 需要启用 Windows Sandbox 并安装包含 `wsb.exe` 的版本；Hyper-V 需要启用完整 Hyper-V、完成系统要求的重启，并预先准备支持 PowerShell Direct 的 Windows VM。以下步骤不会自动创建或重启 VM。

在仓库根目录运行：

```powershell
npm run install:workers
npm --prefix runner run build
npm --prefix runner start -- init --state D:\windows-mcp-state
```

`init` 只接受新的专用目录，写入带版本标记的状态目录及 `config.json`。不要使用旧连接器的状态或项目目录。状态目录必须位于本机 NTFS（不用网络盘或 FAT），因为 WSB 使用原子硬链接发布启动与终结证据。状态包含命令、输出及执行证据，应放在只有服务账户和管理员可访问的位置。init 会收紧新目录的 Windows ACL 至服务账户和 SYSTEM；管理员仍可取得本机管理权限。不要放宽权限或共享给来宾、其他本机用户。

配置示例：

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

将示例 VM ID 换成 `Get-VM | Select-Object Name,VMId` 中选定 VM 的 ID。未准备 VM 时可仅保留 WSB 条目。每个 VM 的 `id` 固定对应同一 VM，不能把旧 ID 改绑到另一台 VM；新增 VM 使用新 ID。最多配置一个 WSB 提供方，当前只允许一个活动 WSB session。配置的 `instructions` 会加入该环境工具说明，供 agent 选择。

MCP Token 从进程环境变量读取，至少 32 字符。可在启动窗口生成，随后通过管理页安全填写；不要放入聊天或 Git：

```powershell
$env:WINDOWS_MCP_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
npm --prefix runner start -- inspect --config D:\windows-mcp-state\config.json
npm --prefix runner start -- run --config D:\windows-mcp-state\config.json
```

重启服务时应提供同一个安全保存的 Token，或在服务和管理页同步轮换。服务账户需要访问 Hyper-V 和自己的凭据文件。MCP HTTP 只接受 Bearer 认证，不接受浏览器 Origin；Token 持有人属于可信客户端，可调用该端点已配置的环境。需要不同信任边界时运行不同配置、端口及 Token 的服务实例。

## 一次性准备 Hyper-V 来宾

先在 VM 中创建工作目录，准备来宾管理员账户。由运行本服务的同一 Windows 身份保存凭据；`Export-Clixml` 在 Windows 使用 DPAPI，文件不能换到其他用户或设备直接使用：

```powershell
$credential = Get-Credential
$credential | Export-Clixml -LiteralPath D:\private\vm-credential.xml -Encoding UTF8
.\runner\scripts\prepare-hyperv.ps1 `
  -VmId 真实VM的GUID `
  -CredentialPath D:\private\vm-credential.xml `
  -GuestWorkdir C:\AgentWork
```

准备脚本在选定来宾的 `ProgramData\CsAgentHyperv` 安装固定 helper，并注册按需启动的 shell 计划任务；不创建新账户或常驻服务。PowerShell Direct 只传递结构化数据，模型脚本由来宾解释，不进入宿主 PowerShell 求值。

shell 使用现有来宾账户的 S4U 限权任务：该账户须允许批处理登录；依赖 Windows 用户凭据的网络访问及加密文件不可用。普通 HTTPS 下载可用，Git/包管理器仍需在来宾内配置各自凭据。每条命令由 Job Object 约束，先暂停创建进程、加入任务对象再恢复，避免子进程提前逃离监督。

## 独立桌面服务与迁移

桌面操作由 VM 内的独立 HTTP MCP 提供，安装、认证、Tunnel 和会话边界见 [桌面 MCP](DESKTOP-MCP.md)。宿主服务只提供后台任务，不再发现或转发原生桌面工具，也不再提供 screen/input。

从旧部署迁移时：先安装并验证独立服务，再在管理页新增桌面 MCP、选择原生工具并启用；确认旧桌面调用已结束后，停止并注销来宾的 `CsAgentHypervMcpV1` 和 `CsAgentHypervDesktopV1`，清理旧桌面进程。删除旧目录 `CsAgentHyperv` 中的 `desktop-mcp-*.ps1`、`desktop-mcp-cli.cjs`、`desktop-mcp.json`、`desktop-mcp-node.txt`、`Desktop.cs` 和 `DesktopContext.exe`，保留后台 jobs 和执行收据。

从宿主 config.json 的 Hyper-V target 移除 `desktopMcp`、`desktopUser`，重新运行 `prepare-hyperv.ps1` 更新后台助手，再重启宿主服务并重新检测、启用剩余后台工具。旧字段会被配置校验拒绝；不保留悄悄失效的兼容开关。新旧 MCP 的工具名与控件引用不同，迁移后重新发现工具并获取窗口快照。

## 接入 Cloudflare

配置 Cloudflare Tunnel，将一个专用 HTTPS 域名转发到 `http://127.0.0.1:7791`，并设置转发 Host 为 `localhost:7791`。例如 tunnel ingress：

```yaml
ingress:
  - hostname: windows-mcp.example.com
    service: http://127.0.0.1:7791
    originRequest:
      httpHostHeader: localhost:7791
  - service: http_status:404
```

在 cs-agent 管理页“模型与接入 → MCP 服务”保存 `https://windows-mcp.example.com/mcp`，认证方式选 Token，通过安全输入框填写 `WINDOWS_MCP_TOKEN` 对应值，检测后选择工具并启用。可读工具选择 `*_job_get`；submit、cancel、close 都会改变状态，不能列为只读。不再使用 Sandbox 标签、配对码、设备审批或 `REMOTE_SANDBOX_ENABLED`。

通用 MCP 权限、群授权与逐次审批继续生效。Worker 会在调用元数据中附带可信 `cs-agent/caller.scope`，服务将任务及临时会话绑定到认证 principal 和这个 scope。它不是模型可填写的工具参数。其他标准 MCP 客户端不传此扩展时，使用该 principal 的默认 scope。

## Agent 的调用流程

配置中的 `dev` 生成 `vm_dev_submit/job_get/job_cancel`；`temp` 生成 `wsb_temp_submit/job_get/job_cancel/close`。这些 raw tool 名通过已有 MCP/Code Mode 命名空间暴露，具体调用名以发现的工具目录为准。

1. 生成一个 UUID 作为 `requestId`，提交 `script`，可带来宾 `cwd` 和 `timeoutMs`。默认期限 120 秒，最多 20 分钟，包含排队时间。
2. 立即得到任务收据，再用同一个 `requestId` 查询。任务完成后读取 stdout、stderr、exitCode。
3. 首次 WSB 提交不带 `sessionId`，后续命令使用收据里的 ID，文件在该临时会话内共享。丢失首次响应时先查询原 requestId，可找回原 session。
4. 不需要 WSB 时调用 close，直到确认 `closed`。活跃 WSB 命令取消会关闭整台临时实例；仅取消未派发的排队命令不会影响其他命令。Hyper-V 取消不会关闭 VM。

同一 requestId 搭配相同参数返回原收据；改变参数返回冲突。`unknown` 表示远端可能已执行，应继续查询或取消，不能换 requestId 重跑。HTTP 关闭不会取消任务。服务重启也只检查已有执行证据，不重放未确认命令。WSB 有独立硬期限 guardian，即使 MCP 服务退出仍会销毁到期实例；空闲清理由在线调度器处理。

Hyper-V 的目录共享取决于选中了哪台 VM，与会话/subagent ID 无关。派出子 agent 时，可用通用 `mcpTools: [{"server":"windows","tools":["vm_dev_submit","vm_dev_job_get","vm_dev_job_cancel"]}]` 收窄工具；同一 VM 工具对应同一磁盘，不自动创建、复制或克隆仓库。子 agent 的任务收据作用域独立，结果通过子报告交回。停止子 agent 或停用 MCP 不等于撤回已发送的远端操作；必要时先在该作用域调用取消，远端期限提供最终收尾。

## 运行与验证

```powershell
npm --prefix runner test
npm --prefix runner run test:wsb
npm run check
```

普通测试包含官方 MCP SDK 的真实 HTTP 调用、任务去重/重启/权限隔离和原生后端模拟。`test:wsb` 只操作专用测试状态和自己创建的原生实例，验证多命令、重连、临时文件、取消与销毁；不使用旧持久目录。Hyper-V helper 的语法、编译和模拟测试不能代替真实 VM 验证，部署前应在准备好的 VM 验证持久文件、长命令取消；桌面验证在独立服务进行。

任务主账本是本机 SQLite；来宾只提供有界执行证据。去重回执不自动清除，达到 4096 条或账本文件 128 MiB 后拒绝新提交，以免静默失去幂等语义。维护时先完成/取消全部任务并关闭 WSB，再停服务、归档整个专用状态目录；使用新目录相当于开启新执行历史，旧请求不能再作为自动重试发送。

## 依据

实现沿用 [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 与官方 TypeScript SDK 1.32.1 的普通工具接口，不依赖 MCP Tasks。Windows 原生机制见 [PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)。
