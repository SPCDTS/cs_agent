# 远程沙箱设计：Cloudflare 调度本机 WSB

状态：第一版闭环已实现并完成本地验证；实验功能，默认关闭。更新日期：2026-11-01。接入步骤见 [远程沙箱运行说明](REMOTE-SANDBOX-RUNBOOK.md)。

## 1. 已确定的边界

Cloudflare 保留 agent、会话、权限、调度和 R2 源码；Windows 连接器主动建立 WSS，通过 WSB 执行命令。本机不需要公网端口或 Tunnel，也不重新部署旧 Node 主服务。

设备注册时声明配置与任务类别。cs.sandbox extension 向 owner agent 提供资源摘要和查询工具；agent 按需选择 sandboxId，Worker 重新验证能力、版本和槽位后分配租约。管理员批准设备，不为每次任务预先绑定唯一机器。

当前实现限于 owner 本人的消息回合；事件回合、其他用户和子 agent 不继承远程设备权限。每设备一个目标、一个执行槽，最多 32 个设备；保留原 Cloudflare Linux coding 沙箱。权限范围扩展、多配置共享资源和通用桌面控制不属于首版。

## 2. 实现组件与设计收敛

| 组件 | 当前职责 |
| --- | --- |
| ThreadDO / cs.sandbox | 资源摘要、发现、选择、任务工具；使用真实输入来源验证 owner 权限 |
| SandboxDO / RemoteWorkspace | 保存选中租约、派发意图、activeJob、提交结果；串行化同工作区写入 |
| SandboxFleetDO | 设备注册、批准/撤销、能力目录、WSS、原子槽位分配、任务状态与提交重试 |
| WorkspaceManager / SourceFiles | R2 源码、文件读取与编辑、版本 CAS、幂等导入；普通文件操作不启动 WSB 或另一容器 |
| runner 连接器 | DPAPI 凭据、固定 WSB 生命周期操作、本地 journal、HTTP/WSS 重连、npm 缓存管理 |
| guest 执行器 | 在 WSB 内恢复源码、运行 PowerShell 或 npm 测试、捕获输出、生成快照 |
| 私有 R2 | 已提交源码、任务输入/结果清单、内容寻址文件；不保存 node_modules 或 Git 元数据 |

前稿的“目录索引 + 每设备 DeviceDO”在首版合并为一个 owner 范围的 SandboxFleetDO。这样目录版本和槽位分配在同一持久事务内完成，不引入额外的跨 DO 预留协议。SandboxDO 仍独立负责工作区提交，FleetDO 不能自行改写 HEAD。规模扩大后可按 owner 分片，再评估每设备对象。

大清单和 stdout/stderr 结果保存在 R2，DO 单值只保存小型状态、结果摘要和上传计数；上传对象的校验记录拆成独立键。能力目录和任务日志均有大小上限。

下图保留接纳、执行、提交的逻辑角色划分；图中的 DeviceDO 网关角色在首版由 SandboxFleetDO 实现，完成通知部分属于后续阶段。

[![远程任务逻辑时序](diagrams/remote-sandbox.svg)](diagrams/remote-sandbox.svg)

[可编辑图源](diagrams/remote-sandbox.sequence.json)。实际首版流程以下文为准。

## 3. 注册、能力和权限

1. 管理 API 创建 256 位一次性配对码，10 分钟过期；云端仅保存摘要。
2. 本机生成独立设备 Token，先以 Windows DPAPI 加密写入专用目录，再提交 Token 摘要与设备声明。重复兑换仅允许同一摘要和声明，避免响应丢失后重复注册。
3. 注册后设备为 pending；管理员检查设备配置并批准。待批准设备不能连接 WSS、获取任务或访问文件。
4. 连接器用 Authorization 请求头建立 WSS，发送协议版本和完整 descriptor；Worker 返回 capabilityRevision。新连接替换旧连接，旧 socket 的消息被拒绝。
5. 调用者权限由宿主验证，不由设备名称、taskType 或模型参数决定。模型不能调用批准、撤销或管理员封存接口。
6. 撤销立即拒绝后续设备请求并关闭 WSS。连接器断线后请求停止自有实例；云端在没有停止证据时仍保留 unknown 和工作区写锁。

设备凭据不进入 guest、URL、命令行参数或模型上下文。专用目录使用当前用户/SYSTEM ACL；即使是本机 owner，也不要把真实用户目录、项目 checkout 或 SSH/GitHub 凭据映射给 WSB。

| 声明字段 | 首版实现 |
| --- | --- |
| provider / OS / arch | windows-wsb / windows / x64 或 arm64 |
| shells | 当前执行器只声明 powershell；不把 Windows shell 当作 bash |
| tools | 从指定只读工具目录探测 Node、npm；可选 Git |
| memoryMiB | WSB 配置内存，默认 6144 MiB，可配置；不是宿主剩余内存 |
| maxConcurrent / maxTimeoutMs | 1 个槽；执行时限最多 20 分钟 |
| taskTypes | shell.exec；node.test（在 cwd 中执行 npm ci，再 npm run 指定脚本） |
| workspaceProtocol | r2-source-v1 |
| cache | npm=true，git=false；表示缓存功能可用，不保证某个仓库命中 |
| 动态状态 | Worker 根据已完成握手的连接、60 秒心跳时效及租约推导 ready / busy / offline / draining |

硬需求包含 OS、shell、最小内存和工具版本；首版版本匹配为精确字符串，未实现 semver 范围。内存、CPU、GPU 的动态余量不冒充已测能力。未知任务类别会被 schema 拒绝。

允许 shell.exec 就意味着可以在 WSB 权限范围内运行任意代码；node.test 也会执行仓库 npm 脚本。任务类别用于匹配，不构成额外安全隔离。

## 4. Agent 如何选择和使用

| 工具 | 当前行为 |
| --- | --- |
| sandbox_list | 查询完整目录，可附 taskType / requirements，返回不匹配原因 |
| sandbox_inspect | 查看当前工作区选中的租约和 activeJob |
| sandbox_acquire | 提交 sandboxId、capabilityRevision、任务类别和需求；operationId 由宿主生成 |
| sandbox_release | 释放远程租约并回到默认 Cloudflare；运行中或 unknown 时拒绝 |
| exec_start | 异步执行，立即返回 jobId；传输错误时返回 dispatch_pending，保留原 jobId |
| exec_status | 查询阶段、结果、日志尾部与提交状态，并可推进提交 |
| exec_cancel | 请求停止；不能把“请求已发出”当作“已停止” |

每轮仅附最多 8 个目标的简要摘要和当前选择，详细能力按需查询。目录中设备名称作为不可信数据展示。

未选择远程目标时，原 read/write/edit/bash 保持 Cloudflare 行为。选择 WSB 后，read/write/edit/list 直接使用已提交 R2 文件；bash 返回 remote_async_required，指引使用 exec_start。命令执行期间允许读取已提交文件，拒绝修改、切换和释放。

/work 是统一逻辑路径，Windows guest 的真实目录为 C:\AgentWork。operation.cwd 可以使用 /work 或其子目录；PowerShell 命令中的文件路径使用相对于 cwd 的路径，不假定 Windows 存在 Unix /work 目录。

首版没有自动唤醒 agent 的完成事件。FleetDO 会重试将结果提交到 SandboxDO，agent 通过 exec_status 观察结果；长任务启动后应向用户说明 jobId 和当前阶段，不能宣称测试已通过。自动完成通知需使用受限的持久事件，不伪装成 owner 的新消息。

## 5. WSB 执行与本机隔离

采用已经在本机验证的专用 spool 交接，不开 guest HTTP 服务：

- 只读映射 Node 安装目录、可选 Git 工具目录、打包后的 guest 执行器和本任务输入。
- 可写映射仅有本任务输出目录及本任务 npm 缓存副本。
- 关闭剪贴板、打印机、摄像头和麦克风重定向；开启 guest 网络以允许安装依赖。
- 宿主执行的命令固定为 WSB CLI、工具版本探测、DPAPI 和 npm cache verify；模型命令只进入 guest 的 PowerShell。
- 创建前生成并持久登记 WSB ID，使用 wsb start --id 启动。停止时只操作登记的 ID，不结束用户的其他 WSB 或宿主 Node 进程。

Microsoft 的 wsb exec 不提供进程 I/O，因此 guest 捕获输出并写入专用结果目录；连接器负责回传。[Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)

**首版每个任务使用独立 WSB，任务结束后先停止实例，再读取、校验 guest 输出和回收缓存。** 这使后台子进程随实例一起终止，也避免读取不可信目录时 guest 仍在改动文件。取消、断线和超时同样停止整个实例；停止结果不确定时不上报已取消。

后续保留 WSB 的热复用必须先完成 guest 进程树管理、文件句柄校验和稳定快照协议，不能仅延长空闲时间就宣称隔离不变。WSB 的网络访问目前不限制目标域名；不向 guest 注入 GitHub 写凭据。

## 6. 任务、恢复和提交

任务输入固定包含 jobId、lease、operation、baseRevision、source manifest、createdAt 和 deadline。源码清单最多 6 MiB JSON，控制帧最多 128 KiB；文件走认证 HTTPS，不塞进 WSS。

1. SandboxDO 持久记录派发意图和 activeJob，再向 FleetDO 提交。相同 operationId 复用同一输入、jobId 和截止时间；参数不同则拒绝。
2. FleetDO 原子检查设备批准、能力版本、任务类别和独占槽位，持久记录后派发。重连只重复投递同一个 jobId。
3. 连接器先写本地 started journal，再启动 WSB。重复消息读取 journal；已执行任务绝不通过新进程重跑。
4. guest 恢复输入、执行、生成受限输出。连接器确认 WSB 已停止后验证路径、普通文件、大小和 SHA-256，再上传。
5. FleetDO 持久接收结果后确认回执，并通过闹钟重试 SandboxDO 的提交。回执说明云端已保存结果，不等于工作区已提交。
6. SandboxDO 用 baseRevision 做 CAS；HEAD 和导入 operationId 的回执在同一事务写入。提交后响应丢失也不会重复导入。
7. 成功、取消或失败处理完成后释放任务写锁；冲突保留任务结果但不覆盖 HEAD。unknown 保留写锁和设备槽位。

执行状态与提交状态分别表达。phase=completed 可以包含非零退出码；persistence.state=committed 才表示源码修改已生效。测试失败仍可提交有效源码，并明确报告失败。

| 异常 | 首版行为 |
| --- | --- |
| 派发前不可用 | 返回 dispatch_pending 和原 jobId；可按原 ID 重试或取消尚未登记的派发 |
| WSS 断线 | 本机请求停止当前 WSB；重连回传 journal，不重跑任务 |
| 连接器崩溃 | 恢复时停止登记实例；有完整结果则回传，只有 started 记录则 unknown |
| 源码版本已变化 | 返回 conflict，保留云端任务快照，不覆盖新文件 |
| R2 或 HTTP 回传失败 | 保留本机 journal 和已经导出的输出，下次连接重传 |
| guest 未留下有效快照、超限或 hash 不符 | unknown；不提交。原 guest 已停止，不能保证取回所有未导出的修改 |
| 取消未得到停止确认 | 维持 cancel_requested，超过截止宽限后 unknown |
| 设备永久丢失或撤销 | 管理员核对外部副作用后可显式 abandon；标记“执行未知”，封存任务并拒绝晚到结果 |

不承诺跨 OS 进程启动和持久记账的 exactly-once。保证的是识别重复消息、未知时不自动重跑，以及晚到结果不能覆盖已封存任务或新工作区修订。

当前任务结果及云端日志保留约 7 天，unknown 不自动清除。已确认接收的本机任务清理输入、输出和 npm 副本，保留小型去重 journal；未确认结果必须保留。文件编辑意图和去重回执的长期压缩属于后续维护工作。

## 7. node_modules、npm 与 Git 缓存

R2 仅保存源码事实，不保存执行环境。固定排除任意层级的 .git、node_modules、.wrangler；不允许模型任意新增忽略规则，也不因名字是 dist 就忽略可能被跟踪的源码。

| 数据 | 放在哪里 | 首版复用与失效规则 |
| --- | --- | --- |
| 源码、package.json、lockfile | R2 与任务只读输入 | 按提交修订恢复；删除也属于源码结果 |
| node_modules | WSB 内部磁盘 | 仅单个任务内复用；任务结束销毁，下次 npm ci 重建 |
| npm 下载缓存 | 连接器专用 cache/npm | 按工作区、Windows/架构、Node 版本隔离；每次只给 guest 独立副本 |
| .git 与 checkout 元数据 | WSB 内 | 不进入 R2，当前不跨任务保存 |
| Git 对象缓存 | 后续连接器专用 cache/git | 尚未实现，所以 descriptor 明确报告 git=false |

npm 缓存处理：复制同 scope 的 _cacache 到任务私有目录 → guest 安装依赖 → 停止 WSB → 拒绝 junction/符号链接和超额条目 → 固定的宿主 npm cache verify 校验 → 发布为下次只读种子。缓存里不带宿主 .npmrc、Token、SSH 配置或其他工作区文件。

默认单个 scope 缓存上限 512 MiB，总缓存 2 GiB，按最近使用时间淘汰。验证或配额失败只放弃缓存，不改写源码结果。运行中的可写映射目录不具备 NTFS 硬配额；正式长期使用前应把 state 放在有空间预算的专用磁盘，并补充独立磁盘配额/监控。

npm 下载缓存不是安装结果，不能使 npm ci 跳过 node_modules 重建。npm ci 要求 lockfile 与 package.json 一致，也会移除现有 node_modules。[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)

后续热复用的依赖标识至少包含：scope、OS、架构、Node ABI/版本、包管理器版本、lockfile 摘要、安装选项、workspaces/file: 依赖、安装脚本相关输入。只用 lockfile hash 不足以证明可复用；不确定时重新安装。Node/npm 升级不影响 Git 对象缓存的身份。

Git 缓存下一阶段按批准的 repository identity + 信任范围组织裸对象库：

1. 由连接器受控的 fetch 更新，使用明确 ref/base SHA；仓库 URL 不成为任意宿主命令。
2. guest 得到只读对象种子，在自己的 WSB 建立独立 checkout。禁止共享 writable working tree、hooks、Git config 和凭据。
3. guest 新对象只能作为隔离候选导入，校验仓库范围和对象完整性后再发布；不能直接改写全局缓存。
4. 若使用 alternates/reference，需要保证被引用对象寿命，或使用独立复制/--dissociate 避免缓存 GC 破坏 checkout。[git clone](https://git-scm.com/docs/git-clone)
5. 宿主缓存按容量和 LRU 清理，R2 源码与已固定的 base SHA 仍是恢复依据。

缓存命中只作为选型偏好，不能改变权限、任务类别或基线版本。首版仅暴露缓存功能布尔值，仓库级命中率、体积和冷热预估尚未上报。

## 8. GitHub 与 PR

远程沙箱负责改代码、安装依赖和测试；GitHub MCP/API/gh 负责仓库与 PR 操作。当前实现没有新增 GitHub 凭据或自动创建 PR 流程。

后续优先由云端使用 GitHub App 或已配置的 GitHub MCP 发布：固定 repo/base SHA → 导入源码 → 远程修改和测试 → 校验 R2 修订与差异 → 创建分支、提交和 PR。GitHub 写凭据不进入可执行仓库脚本的 WSB。

公开仓库可以在单次任务中 clone；私有仓库优先由云端提供固定版本源码。Windows 验证与 Linux CI 各自报告，WSB 测试不替代 GitHub Actions 的发布门禁。

## 9. 当前 API 与代码落点

| 入口 | 权限和行为 |
| --- | --- |
| POST /admin/sandbox-devices/pairings | ADMIN_TOKEN；创建一次性配对码 |
| POST /sandbox-devices/claim | 配对码；登记待批准设备 |
| GET /admin/sandbox-devices | ADMIN_TOKEN；查看声明、批准与连接状态 |
| POST /admin/sandbox-devices/:id/approve | ADMIN_TOKEN；批准设备 |
| DELETE /admin/sandbox-devices/:id | ADMIN_TOKEN；撤销设备 |
| GET /sandbox-devices/:id/connect | 设备 Token；WSS |
| GET /sandbox-devices/:id/jobs/:job/input | 设备 Token；只可读取分配给自己的输入 |
| GET/PUT /sandbox-devices/:id/jobs/:job/objects/:sha | 设备 Token；限定任务对象与内容 hash |
| POST /sandbox-devices/:id/jobs/:job/result | 设备 Token；提交受限结果 |
| POST /admin/sandbox-devices/jobs/:job/abandon | ADMIN_TOKEN + 显式承认执行未知；封存任务 |

首版为 API/CLI 接入，没有新的管理页。所有入口由 REMOTE_SANDBOX_ENABLED 控制；Wrangler 新增 SandboxFleetDO binding 和 v11 migration，生产默认 false。

共享 schema 位于 runner/src/protocol.ts；云端代码在 workers/src/remote-sandbox/，extension 在 workers/src/tools/remote-sandbox.ts。runner 是独立小包，不恢复已删除的旧 Node 服务。根目录 install/check 与 CI 已加入 runner 依赖、类型检查、Node 测试和 guest 构建。

## 10. 限额、成本与后续验收

| 项目 | 当前默认/限制 |
| --- | --- |
| 源码 | 单文件 10 MiB，总量 50 MiB，最多 20,000 个文件/目录；清单 JSON 6 MiB |
| 输出 | stdout/stderr 各保留末尾 64 KiB；云端阶段日志保留末尾 32 KiB |
| 执行 | 最多 20 分钟；另留最多 6 分钟启动/准备预算及 1 分钟停止确认宽限 |
| WSB 内存 | 默认 6 GiB，可配置；本机 smoke 使用 4 GiB |
| 空闲租约 | 无活动任务 10 分钟后释放；WSB 不跨任务保留 |
| npm 缓存 | 单 scope 512 MiB，总量 2 GiB；普通 npm 缓存，不是 node_modules |
| 本地结果 | 云端确认前保留；确认后删除大文件，只保留去重记录 |

本机成本主要是每任务启动 WSB、npm ci、测试及磁盘缓存；云端新增少量设备/任务状态和按文件上传下载的 R2 请求。大依赖不传回 Cloudflare；缓存命中节省下载，仍有安装/解压成本。DO 心跳使用自动响应，闹钟按截止时间、重试和过期时间安排，避免空闲任务每几秒长期唤醒。

验证分层：

- 自动检查：协议/Windows 路径、缓存隔离与淘汰、HTTP/WSS 重连去重、设备授权与槽位、文件 CAS、未知状态、管理员封存、原功能回归。
- 本机 WSB smoke：DPAPI、独立启动/销毁、npm ci + Node 测试、中文与二进制、跨实例 npm 缓存、取消后确认停止。
- 本地完整链路：真实 Wrangler Worker/DO/R2、认证 WSS、连接器及 WSB，验证注册、选择、恢复、执行、上传、CAS 和释放。
- 尚需部署前验证：实际公网 Worker 到本机的持续连接、真实目标仓库和 Windows 特有工具链、长时间断网/宿主重启、磁盘硬配额及告警。
- 后续阶段：自动完成通知、管理 UI、WSB 热复用、Git 缓存、仓库基线与 PR 发布、授权范围扩展。

功能保持默认关闭。本次实现和本地验证不会注册生产设备，也不会自动部署或推送 main。
