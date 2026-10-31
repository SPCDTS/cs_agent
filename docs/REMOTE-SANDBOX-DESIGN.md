# 远程沙箱设计：Cloudflare 调度本机 WSB

状态：设计稿，尚未实现。日期：2026-11-01。

## 1. 目标与结论

让部署在 Cloudflare 的 agent 使用这台 Windows 设备上的 Windows Sandbox（WSB），完成拉取指定仓库、修改代码、安装依赖、运行测试，再把结果交回云端。会话、权限、记忆和调度继续在 Cloudflare；本机只增加一个轻量连接器和一个沙箱内执行器。

采用“本机主动建立 WSS 连接”的方案，无需给本机开放公网端口，也无需额外的 Cloudflare Tunnel。这是应用自己的远程执行设备注册机制，WSB 不会变成 Cloudflare 原生 Containers 的实例。现有 Cloudflare coding 沙箱保留，与远程沙箱一起进入统一目录。

沙箱向 Worker 注册时声明配置和可执行的任务类别，运行中更新可用状态。extension 向 agent 暴露其授权范围内的沙箱整体情况；agent 根据当前任务主动选择 sandboxId，再由 Worker 校验能力与容量并分配执行租约。管理员配置可用范围和限额，不需要为每个任务提前指定唯一设备。

首期接入一台远程设备、一个 WSB 执行槽，并保留 Cloudflare 目标；目录和工具协议从第一版就支持多个 sandbox。首期不做自动负载均衡、任意宿主命令、迁移运行中任务或通用桌面控制。agent 可在尚未派发的任务上重新选择满足要求的沙箱；已经接纳或结果未知的任务先核对，不能换设备重跑。

## 2. 当前代码与本机依据

| 已核对的事实 | 对设计的影响 |
| --- | --- |
| [SandboxDO](../workers/src/sandbox/do.ts) 直接使用 `ctx.container`，通过端口 3000 调用执行器 | 需要把运行环境生命周期和请求传输抽出适配层 |
| [sandbox client](../workers/src/sandbox/client.ts) 支持注入 `ControlFetch` | 现有文件操作协议可复用，远程鉴权和 Windows 路径要补充 |
| [WorkspaceManager](../workers/src/sandbox/workspace.ts) 用 R2 保存 manifest/blob，用 DO storage 保存 HEAD、epoch 和操作结果 | 继续作为工作区权威状态，不另建一套文件同步数据库 |
| 工作区管理器重新初始化时会重置 runtime；操作主要由内存 Promise 队列串行 | 远程任务可能仍在执行，必须改成持久任务锁与恢复核对 |
| [coding tools](../workers/src/tools/coding.ts) 假定 Debian、`bash`、`/work`，执行上限 120 秒 | Windows 目标需要不同能力描述，长任务需要异步接口 |
| [现有执行服务](../workers/sandbox/server.mjs) 依赖容器内网络，无公网鉴权 | 不能直接把它通过 Tunnel 暴露到公网 |
| 本机 WindowsSandbox 应用版本 0.8.107.0，系统版本 10.0.26200；`wsb` 的 start/list/exec/share/stop 帮助可用 | 具备做可行性探针的条件，但本次没有启动 WSB |
| 查询时 `wsb list --raw` 返回空列表 | 只是当时没有运行实例，不能据此假定以后永远空闲 |
| 清理提交在 Linux Node 24 下的 263 项 Workers 测试、14 项 Node 测试及打包检查通过 | 作为回归基线；不代表 Windows WSB 已通过同样检查 |

Microsoft 文档明确说明 `wsb exec` 暂不回传进程输入输出。因此它只用于启动沙箱内执行器；命令 stdout/stderr 由执行器捕获，另行传回连接器。[Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)

## 3. 组件与数据归属

| 组件 | 职责 | 不持有的权限 |
| --- | --- | --- |
| ThreadDO / agent | 查看目录、按任务选择沙箱、发起任务、解释结果 | 不接触设备密钥、宿主路径和任意设备管理 API |
| sandbox extension，新增 | 目录摘要、发现/选择工具、异步任务编排；与 coding extension 共用工作区服务 | 不因沙箱自报描述而扩大调用者权限 |
| SandboxDO，每工作区一个 | 当前租约、任务账本、执行锁、版本校验、R2 提交 | 不执行本机命令 |
| 沙箱目录，云端索引 | 汇总已注册配置、任务类别、动态状态，按调用者权限过滤 | 目录快照不保证设备此刻仍空闲 |
| DeviceDO，每设备一个，新增 | 认证 WSS、沙箱能力版本、连接代次、容量分配、任务消息路由 | 不代替 SandboxDO 判定文件提交成功 |
| 本机连接器，新增 | 保存设备凭据、启动自己拥有的 WSB、任务日志、断线重连 | 不把模型提供的命令放到宿主 PowerShell 执行 |
| WSB 内执行器，新增 | 文件读写、命令进程树、日志、快照差异 | 不持有设备长期凭据和 GitHub 写凭据 |
| 私有 R2，复用 | 已提交源码、受限日志及显式导出的产物 | 不保存整份 node_modules、宿主目录或隐式缓存 |

设备注册信息及其沙箱声明持久化在 DeviceDO；云端目录维护可检索索引，列表展示可最终一致。认证、吊销、当前能力版本和容量分配以对应设备的执行服务为准，Cloudflare 目标由云端 provider 提供同样的目录条目。

区分三个标识：`deviceId` 是连接器设备身份，`sandboxId` 是 agent 可选择的稳定执行目标，`runtimeSessionId` 是一次具体运行环境实例。一个设备未来可以声明多个沙箱配置，但这些配置共享的 CPU、内存和执行槽不能重复计算。首期一台设备只声明一个 WSB 目标，WSB 可以按需启动；目录在线不等于 guest 已经启动。

agent 提交 sandboxId，服务端解析成 `{ kind: "cloudflare", sandboxId }` 或 `{ kind: "remote", sandboxId, deviceId, profile }` 并保存到租约。内部连接地址、设备凭据和宿主目录不进入模型参数。

下面的时序图展示 agent 已选定沙箱后的接纳、执行和提交三个阶段；注册、目录展示与选型见第 4.1、4.2 节。为保持可读性，图中省略短确认回复；“经网关回传”表示连接器通过 DeviceDO 转交 SandboxDO，没有绕过认证通道。

[![远程沙箱任务执行与提交时序](diagrams/remote-sandbox.svg)](diagrams/remote-sandbox.svg)

[可编辑图源](diagrams/remote-sandbox.sequence.json)。详细状态与失败处理见后文。

## 4. 配对、连接与权限

1. owner 在管理页创建一次性配对码，建议有效期 10 分钟。配对码使用高熵随机值，只保存摘要，成功兑换后失效。
2. 本机连接器代表其管理的 sandbox 提交配对码、设备名、配置和任务类别声明。管理页确认设备接入后，签发仅属于此设备的随机凭据；不复用应用的管理员 Token。以后在已授权范围内使用和选型不再逐任务要求管理员确认。
3. 云端保存凭据摘要；本机以 DPAPI 加密并限制文件 ACL。凭据不写入仓库、URL、命令行参数、沙箱映射目录或普通日志。
4. 连接器用认证请求头主动建立 WSS，并上报完整能力声明。Worker 核对设备状态、协议版本、声明格式与凭据，确认 capabilityRevision 后更新目录；新连接替换旧连接时分配新的连接代次。
5. 管理员设置调用者/工作区可使用的 sandbox 范围、任务类别和资源上限。extension 提供经过过滤的目录，agent 按需选择；模型不能自行批准设备、扩大目录可见范围或提高权限。
6. 吊销后关闭云端连接并禁止新任务。离线设备无法立即收到取消，已有任务由本地截止时间和取消机制约束，界面不能提前宣称它已停止。

DeviceDO 使用 WebSocket Hibernation API；空闲心跳采用自动响应，任务状态变化才唤醒 DO。连接器指数退避重连，并携带最后确认的消息序号。DO 内存可能被回收，连接附件、设备注册和任务槽状态必须可恢复。[Cloudflare WebSocket 最佳实践](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

控制帧包含 `protocolVersion`、`deviceId`、`connectionGeneration`、`messageId`；任务帧另带 `jobId`、`leaseId`、`runtimeSessionId`。连接代次只用于拒绝旧连接消息，不能在正常重连时自动作废仍在执行的任务租约。平台发布和网络变化都可能中断 WebSocket，重连是正常路径。[Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)

### 4.1 注册声明与动态状态

设备初次连接和重连时发送完整声明，运行时通过 `capabilities_changed` 更新配置，通过 `status_changed` 更新健康与占用；Worker 返回接收确认及当前版本。下面是拟议字段，不代表本机已经验证这些能力：

| 字段组 | 内容 | 使用方式 |
| --- | --- | --- |
| 身份与版本 | sandboxId、deviceId、displayName、provider、protocolVersion、capabilityRevision | sandboxId 由云端分配并绑定设备；设备只能更新自己拥有的条目 |
| 系统与软件 | OS、架构、shell、工具及版本，如 PowerShell、Node、Git | 匹配命令和依赖；区分声明、探测结果及探测时间，不能把自报内容视为兼容性认证 |
| 可分配资源 | guest 内存、CPU 配置、GPU 能力、并发槽、时限和磁盘限制 | 区分硬限制、软阈值和未知值；不能把宿主总内存当作沙箱可用内存 |
| 可执行任务类别 | taskType、contractVersion、输入/输出契约、依赖能力 | 例如 `shell.exec@1`、`test.node@1`；明确由哪个已部署 handler 承接 |
| 文件与网络能力 | 工作区协议、快照/产物能力、允许的网络范围 | 代码任务要求支持项目的 R2 源码契约；其他类别声明自己的产物契约 |
| 动态可用性 | ready / busy / offline / draining / unhealthy、可用槽、已分配任务数、冷/热状态 | ready 可表示可按需启动；Worker 结合连接状态和上报时效判断，不能只信自报 ready |
| 资源观测与时效 | availableMemory、diskFree、observedAt、lastSeenAt、statusRevision | 用于选型提示，分配时再次检查；未上报的值为 unknown |

有效能力是“设备声明 ∩ Worker 支持的契约 ∩ 调用者授权范围”。Worker 校验 schema、版本、条目数量和字段大小；未知类别可标为 unsupported，但不能让 agent 对未知协议直接执行。新任务类别通过受版本管理的契约和执行 handler 接入，不从设备描述下载并执行 extension 代码。

任务类别主要用于能力匹配。允许通用 shell 本身就允许其权限范围内的任意命令，不能靠把任务标为 `test.node` 就声称限制了其他行为；实际隔离、网络和凭据权限仍由执行环境落实。描述文字作为数据展示，不作为系统提示或权限依据。

能力版本变化后，新申请按新版本匹配；已有租约固定其接纳时的配置和契约。设备无法继续满足已有租约时先进入 draining 或报告故障，按取消/未知状态协议处理，不静默替换运行环境。连接断开和状态过期会更新目录的可用性；它们不证明旧任务已停止。

### 4.2 extension 暴露目录，agent 按需选择

新增 `cs.sandbox` extension，注册目录/租约工具、环境摘要和持久任务；现有 `cs.coding` 继续提供代码读写与执行工具，两者注入同一工作区服务。复用框架的 `tools / sections / tasks`，不修改 pi-durable 核心，也不另造通用任务调度器。设备租约和源码提交仍分别由 DeviceDO、SandboxDO 负责。

每轮提示只提供紧凑摘要，例如可见沙箱数、在线/忙碌/离线数量、主要任务类别和当前租约，并标明观测时刻；详细配置通过工具按需查询，避免每轮塞入全部机器信息。摘要和工具结果均按当前调用者过滤，不泄漏其他用户的设备或任务内容。

| 工具 | agent 获得或表达的信息 |
| --- | --- |
| `sandbox_list(taskType?, requirements?, cursor?)` | 分页列出可见目标、配置摘要、任务类别、可用状态及不匹配原因；带目录版本和观测时刻 |
| `sandbox_inspect(sandboxId)` | 获取完整配置、能力契约、当前状态和限制；只显示该调用者有权查看的任务详情 |
| `sandbox_acquire(sandboxId, workspaceId, taskType, requirements, capabilityRevision, expectedRevision)` | agent 明确选择目标；Worker 复核授权、工作区版本、能力和容量，原子预留槽位并返回 leaseId |
| `sandbox_release(leaseId)` | 释放执行会话；运行中或修改未保存时拒绝直接释放，先完成或取消并核对结果 |

`requirements` 表达任务硬需求，例如 OS、工具版本、最小内存和工作区协议；偏好单独表达，不把“优先使用已有依赖缓存”误当硬约束。agent 在满足硬需求的候选中综合环境、可用性、冷启动和数据准备成本自行决定。初版不引入无法解释的固定评分器，也不要求用户逐次选机器。

列表查询不会占用设备，`sandbox_acquire` 才竞争真实槽位，所有申请使用稳定 operationId 去重。目录过期、能力版本改变或设备忙时返回 `capability_changed / busy / unavailable` 及新状态；agent 可刷新后选其他满足原需求的目标。若 dispatch 已发生，则先查原 lease/job，不能因为换了目标就绕过去重。

取得租约后，`exec_start` 和文件操作引用同一 leaseId；兼容旧工具时，宿主在一次调用开始时冻结并注入租约，不能在调用中途读取一个已经换过的全局目标。租约校验同时绑定调用者、工作区和任务类别，知道 leaseId 本身不授予权限。

工作区可以在任务之间更换沙箱：先结束原任务并提交源码、释放旧租约，再为新目标分配租约，从 R2 恢复指定修订。更换实际运行环境增加 workspaceEpoch，旧实例结果不得提交；普通 WSS 重连不增加 epoch。`send_file`、技能发布和子 agent 仍引用同一个工作区服务，避免文件视图分裂。并行执行需要独立工作区/分支，再显式合并；同一工作区不同时允许两个写入目标。

一次典型使用过程是：沙箱注册声明 → extension 展示目录摘要 → agent 查询候选并选中 sandboxId → Worker 分配租约 → 执行任务并回传结果 → 保存产物/源码并释放租约。首期即使只有一个远程 WSB，也完整保留发现与选择过程。

## 5. 本机 WSB 如何执行

连接器以普通用户运行，使用固定、经校验的参数调用 `wsb`。首期按单实例容量设计，只管理自己创建并登记的 sandbox ID；如果用户自己的 WSB 占用资源，就报告 busy，不接管或停止它。

启动时生成专用配置：设置内存、网络和固定启动命令；关闭不必要的剪贴板、打印机、摄像头、麦克风等重定向。只读映射预装工具包，包括固定版本 Node 24、Portable Git 和执行器。不要映射真实项目目录、用户主目录、SSH 密钥或浏览器资料。WSB 关闭后内部文件会丢失，必须先完成源码提交。[WSB 配置文档](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

宿主到 guest 的传输优先采用专用、带会话 nonce 的 guest HTTP 服务。P0 验证 `wsb ip`、防火墙与可达性；若不成立，再验证仅供本任务使用的 spool 目录方案。spool 属于不可信输入，解析时拒绝路径跳转、重解析点和超额内容，禁止从中加载或执行宿主脚本。不能通过扩大宿主共享目录来绕过连通性问题。

实际命令始终在 WSB 内运行。默认 shell 明确标为 PowerShell；需要 Bash 时由能力协商决定是否可用。Windows 的命令取消使用 Job Object 管理整个进程树，失控时停止该连接器拥有的 WSB。Job Object 用于资源和进程管理，隔离边界仍是 WSB。[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

同一工作区可短期复用同一个 WSB；切换工作区时销毁重建，避免缓存和后台进程串入另一个任务。初始化脚本、下载工具和更新包必须有版本与摘要，任务内容不能替换连接器或启动包。

## 6. 长任务与提交协议

增加中性的 `exec_start`、`exec_status`、`exec_logs`、`exec_cancel`，文件工具继续采用统一接口；执行和文件操作使用第 4.2 节取得的 leaseId，任务还携带 taskType 与 contractVersion。`exec_start` 立即返回 `jobId`，可短等几秒收取快速结果，但不让 HTTP 请求挂着等 20 分钟。现有 Cloudflare `bash` 兼容保留，远程能力在工具提示中明确说明系统、shell、工作目录和时限。

任务至少保存以下信息：

| 信息 | 用途 |
| --- | --- |
| jobId、operationId、fingerprint | 请求去重，重复提交查询原任务；不同参数复用同一 ID 时拒绝 |
| workspaceId、baseRevision、workspaceEpoch | 防止旧快照覆盖新文件 |
| sandboxId、deviceId、runtimeSessionId、leaseId | 锁定 agent 选择的目标、执行设备、具体实例和租约 |
| taskType、contractVersion、capabilityRevision、requirements | 保存任务契约、接纳时能力版本和硬需求，恢复时不重新猜测目标 |
| deadline、executionState、persistenceState | 区分执行超时、进程结果与文件保存状态 |
| logCursor、exitCode、snapshotManifest | 断线补日志和提交验证 |
| originatingTask、threadId、replyChannel | 将完成事件送回原会话，不扩大调用者权限 |

状态采用可判别联合类型，避免大量可选字段形成非法组合。设备连接状态、进程状态、文件提交状态分别记录：例如设备 disconnected 时，进程仍可能 running；进程 exited 时，文件仍可能 pending。

正常流程：

1. agent 通过目录选择 sandboxId；`sandbox_acquire` 在 SandboxDO 持久登记选择意图、基线版本和 operationId，再向对应 DeviceDO 幂等预留槽位。拿到 reservation 后保存 leaseId，确认租约并返回；确认失败或结果不明时查询原申请，不盲目释放再申请。两个 DO 不依赖跨对象事务。
2. agent 使用 leaseId 提交任务。SandboxDO 重新核验租约、授权和所选任务契约，持久登记 activeJob，锁住工作区写入及其他执行，再确认 dispatch。未启动任务的空闲租约可超时回收；一旦派发就走第 7 节的对账规则。读取默认返回已提交版本，并标明有任务运行中。
3. 连接器先持久记录 accepted，再请求 guest 启动。下发和确认丢失时沿用原 jobId 查询，禁止创建第二次执行。
4. guest 捕获 stdout/stderr、序号和退出码。日志分块、合并发送，云端按游标确认；不逐字唤醒 DO。
5. 进程树结束后，guest 计算源码快照差异。连接器先保存结果元数据，再传回退出证据、文件摘要与对象内容。
6. 云端核对设备、任务租约、runtimeSessionId、epoch 和 baseRevision，验证文件路径、大小及 hash，再写 R2 blob/manifest。
7. 在 SandboxDO 的持久事务中 CAS 更新 HEAD、记录操作结果、解除 activeJob；CAS 失败时保留冲突证据，不覆盖新修订。
8. 通过持久 outbox 唤醒原 ThreadDO；使用稳定事件 ID 去重。完成事件沿用原回复通道与授权范围，不伪装成 owner 亲自发出的新命令。

exitCode 非零也可以提交有效源码，然后明确报告测试失败。只有源码提交成功，才可把结果标为完整完成；保存失败必须报告“执行已结束，但修改未保存”。

## 7. 断线、取消与未知状态

| 情况 | 必须采取的行为 |
| --- | --- |
| 设备在 dispatch 前离线 | 未确认的 reservation 可过期释放；任务返回 unavailable 或等待，不执行宿主兜底 |
| dispatch 发出后确认丢失 | 视为可能已经执行，按 jobId 对账，不能自动重派 |
| WSS 断线、DO 休眠后唤醒 | 恢复持久 activeJob，查询原 runtimeSessionId，不直接销毁 WSB |
| 连接器崩溃发生在记账和启动之间 | 查询 guest journal / 进程状态；无法判定时标 unknown，保持工作区写锁 |
| 同一任务重复到达 | 参数相同返回原任务状态；参数不同拒绝；不能把消息重试当命令重试 |
| 发起取消 | 先记录 cancel_requested；确认整个进程树停止后才标 cancelled |
| 超时且控制失灵 | 由本机 watchdog 停止自有 WSB；未获停止证据前仍是 unknown |
| 正常更换执行目标 | agent 在任务结束、修改提交及旧租约释放后重新选择；新环境增加 workspaceEpoch，拒绝旧结果提交 |
| 原任务未知时强制恢复 | 显式管理操作增加 workspaceEpoch 并保留 unknown 记录；不能撤销已经发生的外部副作用 |
| R2 不可用、快照超限、hash 错误 | 保留隔离的本机待取回结果，报告 persistence_failed，不谎报完成或立即销毁唯一修改副本 |
| 任务执行完但通知丢失 | 持久 outbox 重试同一完成事件，不重跑任务 |

连接器写 journal 与 OS 启动进程无法组成原子事务，因此不承诺任意故障下的 exactly-once。目标是重复投递可识别、结果可核对、未知时停止自动推进。工作区 epoch 能阻止晚到的文件覆盖，不能撤销 GitHub 提交或其他联网副作用。

首次实现必须修改现有 `ensureRuntime` 和 unknown-operation 的恢复策略：Cloudflare provider 可保留原有重建行为，remote provider 在启动恢复时先 inspect/reconcile。持久 activeJob 取代单靠内存 Promise 队列维持长任务锁。

## 8. 文件、依赖与 Git 仓库

R2 是已提交源码的权威副本，WSB 是执行视图。本地缓存不能反过来覆盖云端 HEAD。首期保留现有单文件 10 MiB、工作区源码总量 50 MiB 等限制，超限必须有明确错误和取回路径。

`node_modules`、`.git`、npm 缓存、`.wrangler` 及声明的构建产物属于临时数据，不进入源码快照。这需要给现有 snapshot/restore 增加受控的临时目录规则；不能让模型随意添加忽略路径并隐藏源码改动。只将确定为生成目录的路径列入规则，不能仅因目录名叫 `dist` 就忽略仓库真实跟踪的文件。

源码协议统一使用工作区相对路径及 `/`；Windows runner 将其映射到固定工作区目录。拒绝盘符、UNC、ADS、保留设备名、大小写碰撞、路径越界以及 symlink/junction/reparse point 绕过。所有文件 API 和快照必须应用同一套校验，不能只检查传入字符串。

仓库来源 URL 和 base commit SHA 由云端批准的元数据确定。初始化从固定 commit 建立 checkout，再恢复当前工作区源码修订，包括已记录的删除；Git 元数据不作为 R2 文件同步。缓存按 OS、CPU 架构、Node 版本和 lockfile hash 区分，只在同一信任范围内复用，不复用其他工作区的 dirty checkout。

大文件通过短时、限定 job/object/hash/size 的上传下载凭证传输，避免全部塞入 WSS。凭证只能读写该任务对象；上传后仍由云端验证摘要和 manifest。日志与任务产物同样限定工作区权限。

## 9. GitHub MCP、gh 与 PR

远程沙箱与 GitHub 接入解决不同问题：沙箱提供完整文件系统和命令执行，GitHub MCP / API / gh 提供仓库与 PR 操作。即使接通 GitHub MCP，安装依赖和运行测试仍需要执行环境。

推荐把发布留在云端：WSB 产出经过校验的文件差异及测试结果；云端发布组件使用 GitHub App 或已有 GitHub MCP，创建分支、提交和 PR。发布前重新核对仓库、base SHA、允许的路径和工作区修订。GitHub 写凭据不进入可运行任意仓库脚本的 WSB。

公开仓库可以直接 clone。私有仓库优先由云端生成固定版本源码包；确需 guest clone 时使用仅限指定仓库读取的短期凭据，并承认仓库脚本可能读取该凭据，不能将其权限扩大到组织或写入操作。

`gh` 可以安装在具备相应授权的执行环境中，但不是此次设备注册的前提。最终 PR 继续由 GitHub Actions 运行 Linux 检查；本机 WSB 测试提供快速反馈和 Windows 验证，不替代尚未验证兼容性的 Linux 发布门禁。

## 10. 建议接口与代码落点

以下是拟议接口，不是当前可调用的 API：

| 入口 | 调用者 | 行为 |
| --- | --- | --- |
| `POST /admin/devices/pairings` | 管理端 | 创建配对码 |
| `POST /devices/pairings/exchange` | 本机连接器 | 兑换配对并建立待确认设备 |
| `POST /admin/devices/:id/approve` | 管理端 | 确认设备并允许完成凭据签发 |
| `GET /admin/devices` | 管理端 | 查看设备及其 sandbox 声明、连接状态、任务与错误 |
| `GET /sandboxes`、`GET /sandboxes/:id` | extension 的宿主服务 | 根据真实调用者权限读取目录与详情 |
| `DELETE /admin/devices/:id` | 管理端 | 吊销设备，禁止新任务 |
| `PUT /admin/workspaces/:id/sandbox-policy` | 管理端 | 配置允许的目标、任务类别与限额；agent 在此范围内自行选择 |
| `GET /devices/:id/connect` | 本机连接器 | 认证后升级 WSS；接收能力声明、版本更新和动态状态 |
| acquire / release / submit / inspect / logs / cancel RPC | extension 宿主、SandboxDO 与 DeviceDO | 按 sandboxId 选择并校验租约；不暴露管理员能力给模型 |

配对兑换先签发短期 pairing-session，仅允许该设备等待管理员确认并取回自己的设备凭据；它不能执行任务或查询其他设备。批准、领取和失效状态均持久化，避免批准后网络中断导致凭据泄漏或重复签发。

拟增加 `RuntimeAdapter`，提供 `describe / prepare / submit / inspect / cancel / read / write / edit / snapshot / release`；describe 归一化配置与任务能力，目录采用同一契约。Cloudflare adapter 先包装现有逻辑；remote adapter 通过 DeviceDO 执行。传输重试只作用于有 ID 的协议消息，不隐式重跑 shell 命令。

| 路径 | 变更范围 |
| --- | --- |
| `workers/src/sandbox/runtime.ts`、`remote.ts` | 新增运行时契约及远程实现 |
| `workers/src/sandbox/do.ts`、`workspace.ts` | agent 所选目标的租约、持久任务锁、恢复核对与提交 |
| `workers/src/remote-sandbox/` | 新增 DeviceDO、能力声明、目录索引、设备认证和租约状态 |
| `workers/src/admin/` | 增加设备管理及工作区沙箱授权范围入口 |
| `workers/src/tools/sandbox.ts`，新增 | cs.sandbox extension：摘要、发现、选型、租约工具与持久任务 |
| `workers/src/tools/coding.ts` | 与 sandbox extension 共用工作区服务，按租约提供执行和文件工具 |
| `runner/`，新增独立小包 | 本机连接器、WSB bootstrap、guest runner；不恢复旧 Node 主服务 |

协议只维护一份带版本的 schema，云端和连接器共用校验规则。新增 DeviceDO 需要 Wrangler binding / migration，宿主安装 cs.sandbox extension 并注入目录和工作区服务；新功能默认关闭，先接一台测试设备。agent 显式选择目录中的远程目标后走新路径，Cloudflare 目标继续保留。

## 11. 初始限额与成本

下列数值是建议默认值，尚未通过 WSB 实测调优：

| 项目 | 首期建议 |
| --- | --- |
| 并发 | 每设备 1 个任务；每工作区 1 个写入/执行任务 |
| 远程任务时长 | 默认 20 分钟硬截止；现有 Cloudflare 120 秒上限先保持不变 |
| WSB 内存 | 先用 6 GiB 配置做探针，启动前检查宿主余量；不把 Linux 测试进程峰值当作整台 Windows guest 的需求 |
| 空闲回收 | 同一工作区空闲 10 分钟后关闭 WSB；有未保存结果时单独处理 |
| 日志 | 单次工具展示最多 64 KiB，持久保存每任务最多 1 MiB，建议保留 7 天；截断要显式标记 |
| 源码 | 继续单文件 10 MiB、总量 50 MiB；依赖和产物不计入源码快照 |
| 临时磁盘 | 先以 2 GiB 工作目录告警阈值观测，根据实际依赖调优；不是 WSB 原生硬配额 |

CPU、内存和依赖磁盘消耗转移到本机；云端增加设备连接、任务元数据、R2 文件及日志请求，模型调用费用基本不因执行地点改变。Hibernation 可减少空闲 DO 活跃时间，但频繁日志和应用层心跳仍有请求及运行成本。

云端增量可按“任务元数据读写 + 日志批次数 + 变更文件传输/存储”估算；本机增量按“WSB 启动时间 + 测试运行时间 + 待机复用时间”测量。依赖缓存命中时无需重复下载整个 node_modules，也无需每次上传它。没有本机实测和任务频率前，不给出伪精确的月费数字。

主要代价是电脑必须在线、Windows 与 Linux 行为差异、连接器维护及故障恢复复杂度。相比纯 GitHub Actions，远程沙箱适合交互式反复修改和快速重跑；GitHub Actions 继续提供独立、可复现的发布验证。

## 12. 实施顺序与验收

| 阶段 | 交付物 | 通过条件 |
| --- | --- | --- |
| P0：本机可行性 | 独立 WSB 探针和测量记录 | 成功启动自有实例；Node 24 / Git 可用；中文 stdout/stderr 无损；host↔guest 可通信；可终止进程树；记录启动、内存和磁盘；验证本项目 Windows 测试兼容性 |
| P1：最小闭环 | 设备配对、声明与更新、extension 目录、agent 选型、单任务执行 | agent 能区分 WSB 与 Cloudflare 的配置/任务类别并申请匹配目标；WSB 完成无副作用探针任务，断线后可查询原任务；不能执行宿主命令 |
| P2：工作区可靠性 | 源码恢复与提交、异步完成通知、取消与对账 | 安装依赖、修改和测试后只提交源码；故障场景不重复执行、不覆盖新版本、不误报已保存 |
| P3：代码协作 | 固定版本 checkout → 修改测试 → 云端提交 PR | PR 差异和工作区修订一致；GitHub Actions 检查通过；发布凭据未进入 guest |

P0 若证实 Windows 的 workerd/测试池不兼容，就把该目标能力标为 Windows 通用执行，Linux 检查继续走现有 Cloudflare / GitHub Actions。后续可增加本机 WSL2 内的隔离容器或独立 Linux VM adapter；裸 WSL 发行版通常能访问宿主盘，不能直接当作不可信代码沙箱，也不要求在 WSB 内嵌套 WSL。

P2 至少覆盖：接纳前后断网、执行后提交前断网、连接器重启、DO 回收、重复消息、过期 epoch、取消后残留子进程、R2 失败、超额文件、hash 错误、Windows 大小写冲突和 junction 越界、设备离线时吊销。目录与选型另需覆盖：配置更新、未知任务契约、未授权目标不可见、陈旧目录、并发抢槽、同设备多配置共享容量、lease 跨工作区误用、未派发可重选与已派发禁止自动换机。已有 Cloudflare provider 行为和测试保持通过。

本设计的下一步是 P0 探针。本文及图源不启用设备、不开放端口、不启动 WSB，也不改变线上执行路径。
