# 远程环境的 MCP 边界

Cloudflare Container 保留原生 `cs.coding`；其他远程环境只通过标准 MCP 工具接入。Windows 服务同时提供 Hyper-V 持久工作区与 WSB 临时沙箱，接入步骤见 [Windows MCP](WINDOWS-MCP.md)。

## 调用与职责

| 层 | 职责 |
| --- | --- |
| Agent / Code Mode | 阅读工具说明，选择环境，生成 requestId，提交和查询任务；按需要关闭临时会话 |
| Worker 通用 MCP | 工具发现与选择、现有权限、凭据、子 agent 能力收窄、可信调用作用域、结果转换 |
| Windows MCP 服务 | 固定配置绑定 VM，验证调用归属，持久化任务与 WSB 会话账本；HTTP 与执行生命周期分开 |
| Hyper-V 后端 | PowerShell Direct 桥接、来宾 Job Object 进程树和终结收据、已登录来宾桌面 helper |
| WSB 后端 | 临时实例、多命令会话、独立启动与硬期限守护、原生销毁确认 |

模型不能通过参数填写宿主程序、宿主路径、任意 VM GUID 或调用者身份。配置决定每台 VM 的工具名称，`instructions` 由提供方加入工具说明。命令文本只在所选来宾中求值，Windows PowerShell 与 Cloudflare Linux bash 的差异直接反映在工具名与说明中。文件修改发生在对应环境内，不把本地 Windows 目录路由成 Cloudflare read/write/edit，也不通过 R2 中转远程源码。

## 持久化和共享

Hyper-V VM 磁盘保存项目、`.git`、依赖与操作系统状态。同一 VM 工具对应同一环境；父子 agent 获得相同 VM 的工具时共享磁盘。服务不自动为子任务创建目录、复制文件、克隆仓库、切分支或提交代码。

WSB 的 sessionId 标识一台临时实例。同一调用作用域可连续使用它，关闭后全部来宾文件消失。没有宿主项目或缓存持久映射；硬期限 guardian 独立于 MCP 请求和服务进程。旧连接器已使用的持久目录不参与新服务。

Cloudflare `sandbox_list` 和 `sandbox_create` 收回 `cs.coding`，仅列出或创建 Cloudflare 资源。已有 `sandboxId` 仍对应原物理容器与 R2 快照，子 agent 继续按这个 ID 共享/分配 Cloudflare 工作区。显式来源复制仍由 Cloudflare 提供方实现。

## 授权与恢复

Windows 工具沿用普通 MCP 权限，没有新增 remoteSandbox 权限位或 Windows 专属 owner 模式。可选 `spawn.mcpTools` 只能缩小当前 MCP 能力；父线程在每次子调用时重核当前权限和目录合同。`params._meta["cs-agent/caller"].scope` 来自宿主身份与会话，不能由工具业务参数替换。

每条任务的幂等键是 `(principal, scope, target, requestId)`。首次 WSB 提交与 session 创建在同一 SQLite 事务内；重试先查旧收据，再检查容量。派发意图先落盘，进程恢复后只查询既有证据。执行不确定为 unknown，不能自动重放；取消只有确认原生停止后才为 cancelled。HTTP 关闭不取消任务，停用连接或取消 subagent 也不能撤回已经发送的远端操作。

普通请求/回执使用 MCP `tools/call`，长命令通过 submit/get/cancel 工具处理；无需让一次 HTTP 持续到构建或测试结束，也不依赖目前客户端未实现的 MCP Tasks。输出采用有界 structuredContent；MCP 图片按现有通道交给模型。

## 清理和迁移

删除旧 `cs.sandbox`、Fleet 远程设备注册、WebSocket/HTTP 作业传输、配对与审批、租约 API、专用 Sandbox 管理页以及旧连接器。通用 MCP 内部仍可用 extension 注册工具，这是统一接入层，不再有远程沙箱专用 extension。

旧 Fleet 同时保存 Cloudflare 资源，因此 v11 migration 保留，v12 用 `renamed_classes` 将 `SandboxFleetDO` 重命名为 `CloudflareWorkspaceResourcesDO`。保留 DO 实例名 `owner`、`resource:sbx:*` 键、物理容器寻址和准备中的快照信息，只识别 Cloudflare 记录；旧远程记录不列出、不计资源限额。历史绑定到远程资源的子任务不会静默改用默认 Cloudflare 工作区。

上线前用旧版本完成/取消仍在执行的远程任务，停止旧连接器；升级后重新通过 MCP 登记 Windows 服务。代码迁移不会自动操作旧本机进程或删除数据，也不会自动部署线上 DO 迁移。

## 方案合成

比较过“每台 VM 独立 MCP 端点”与“一个端点按配置生成固定 VM 工具”。选择后者，减少重复接入和凭据配置，同时能用普通 MCP 工具选择收窄子任务能力。需要独立信任域时仍可运行多个服务实例。

保留另一方案的两点：现有 MCP 授权加可信调用上下文；每任务 Job Object 与 InteractiveToken helper。取消候选中的 Windows 专属权限模式、强制常驻来宾服务、多账户前提和每条命令新建 WSB。WSB 改为会话内多命令，以支持安装、修改和测试的连续工作。

验证覆盖真实官方 MCP SDK HTTP、去重与冲突、断线续查、不同调用者、子任务工具收窄、Cloudflare 旧 ID、WSB 多命令与销毁。Hyper-V 真实 VM/桌面、线上 DO rename 需在对应环境执行，模拟或编译通过不能代替实机验收。
