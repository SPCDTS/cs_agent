# 云端功能、契约与资源预算

项目统一运行在 Cloudflare Workers；CS2 Workshop 通过鉴权 Tunnel 接入本机（见 [本机接入说明](WORKSHOP-LOCAL.md)）。主、子 agent 随当前模型使用 DeepSeek 或 OpenAI 的服务端搜索；订阅生图使用已授权的 Codex 账号（见 [Workers 开发与管理](../workers/README.md#联网与外部工具)）。管理台界面与接口见 [管理台](ADMIN-CONSOLE.md)。

## 1. 资源预算与默认限制

| 项目 | 默认限制 |
| --- | --- |
| 容器 | `lite`；按需启动，空闲 3 分钟后停止，不设每日时长、单次寿命或全局并发配额 |
| 持久工作区 | 每工作区 50 MiB，单文件 10 MiB，文件/目录各最多 20,000；保留当前 head 及最近 2 个版本，分批 GC |
| 子任务 | 不设固定并发、默认期限或模型调用次数；显式设置 `timeoutMs` 才按截止时间取消 |
| Worker CPU | 每次调用 30 秒活跃 CPU（网络等待不计入） |
| 发送账本 | 最多 5,000 条（离线 queued 上限 200）；正文保留 30 天（单条 4,000 字、10 附件），紧凑回执 90 天 |
| 通用告警 | 最多 500 条（单条 1,000 字）；列表最多 200，Cron 待通知最多 10 |
| 请求明细 | 7 天 / 32 MiB；请求元数据 30 天 / 最多 20,000 条 |
| 后台任务 | 复用既有 5 分钟与每日 UTC 19:30 维护计划；管理面板按需加载，不增加后台轮询 |

工作区只读操作和未改动文件的命令不重复写 R2；账本、告警、工作区 GC 均按有界批次执行，不扫描整个 R2 桶。价格与规格参考 [Cloudflare Containers](https://developers.cloudflare.com/containers/platform/limits/)、[R2](https://developers.cloudflare.com/r2/pricing/) 与 [Workers](https://developers.cloudflare.com/workers/platform/pricing/)。

## 2. 权限、发送账本与运维契约

BridgeDO 是 QQ 唯一发送事实源，RegistryDO 保存授权、人设、技能 CAS 与运维设置。以下均为内部 RPC，模型只能调用 Thread 安装的工具。

### 2.1 发送账本与恢复

- `Bridge.deliver({ id, operationAt, runId, target, text, atUserId?, attachments?, source })`：
  - `id` 必须稳定（如 `thread/generation/taskId`），同 ID 不同载荷抛 `delivery_payload_conflict`，同 ID 重放直接返回原回执。
  - `operationAt` 为宿主持久记录的操作创建时间（毫秒），重试不得改成当前时间；新操作只接纳最近 30 天且大于 `minimumOperationAt` 拒绝水位的记录。
  - `source = { thread, inputId, generation, scope }`；每次 `queued` 实际发帧前调用 `Thread.validateDeliverySource(source, target)` 核验 QQ 回复入口、当前 generation 与跨目标授权。
  - 状态机：`queued / sending / sent / unknown / failed / rejected`。发帧前同步持久化 `sending`、`echo` 与连接 ID；DO 重建将 `sending` 标为 `unknown`，`unknown` 永不自动重发，迟到回执按 `echo` 结算。
  - 同一 `runId + group` 串行发送，仅首条携带群 `@`（`unknown` 保留占位，明确失败释放占位）。
  - `reconcile(id)` 只读查询历史消息，仅当本人、目标、时间窗口、完整消息段、平台消息 ID 与唯一匹配全部成立时才认定 `sent`（附件与含糊匹配维持 `unknown`）。
  - `cancelQueued({ thread, generation })` 将旧代次 `queued` 置为 `rejected` 并保留墓碑；容量回收前原子推进 `minimumOperationAt` 水位。
- `chats(refresh?)`（5 分钟缓存）、`getMessage`、`getHistory`（最多 100）、`getForward`、`getFileAttachment` / `getImage` / `getRecord` / `getFile` 为只读查询接口；跨目标发送授权**不授予**历史读取权限。

### 2.2 授权、人设、技能与运维配置

- **授权**：Registry 提供 `grantsList`、`grantPut(input, actor)`、`grantRevoke(input, actor)`、`canAccess({ user, cap, scope, target? })`，写授权再次与 `QQ_OWNER` 校验。`caps` 为 `send` / `schedule`；`scopes` 省略表示所有来源，空数组表示无来源；`send` 必须命中 `targets`。撤权立即生效。`createAccessExtension` 仅在 owner 私聊或鉴权 owner 网页开放 `qq_chats` / `auth_*` 工具，子 agent 不继承。
- **定时撤权**：`ScheduleDO` 的列表与管理写入均核验有效 `schedule` grant（普通授权用户只能管理自己创建的同会话任务）；后台触发前复验 `created_by`，失效即暂停并标 `authorization_revoked`。
- **人设与技能 CAS**：`persona` / `setPersona` 与 memory profile 独立；`skillRevision` / `skillPublish(input, expected | "absent")` 原子 CAS，所有变更递增独立修订防 ABA。
- **运维配置与告警**：`opsSettings` / `putOpsSettings` 独立 CAS，管理发送限速（默认每会话 6/分、60/时、全局 30/分、熔断 60/10 分）、告警节流（同类 10 分钟、owner 私聊 30 分钟）及各线程保留期/整理开关。`Thread` 回合结算调用 `recordTurn`；网页来源告警仅在面板展示。5 分钟 Cron 驱动 `Bridge.tick()` 与 `Registry.opsTick()`。

## 3. 私有媒体、持久工作区与 Code Mode 文件环境

所有对象位于私有 R2 绑定 `ASSETS` 的 `cs-agent/v1/` 前缀，作用域完全由宿主授权层决定，模型不能指定任意 R2 key 或 namespace。

### 3.1 私有媒体与 NapCat 附件回传

- `MediaRepository`（`workers/src/media/repository.ts`）固定作用域，单资产上限 10 MiB，`AssetRef = { id, scope, sha256, bytes, mime, name, kind }`（`image | file | audio | video`）。`issueUrl` 签发 5 分钟（最长 600 秒）单对象随机票据 `/media/object?token=...`，不含管理口令或原始 scope；`/admin` 媒体上传下载要求 Bearer 鉴权。
- 图片、音频、视频可与文字同条发送；普通文件走独立 `upload_group_file / upload_private_file` intent（成功 ACK 允许无 `messageId`）。
- 本机 NapCat 启用 `enableLocalFile2Url: true` 后，Bridge 从 `get_file` 和 `get_image` 接收并校验文件字节，普通文件优先使用消息中的 `file_id`。单附件上限为 10 MiB。下载 HTTP(S) 链接时逐跳检查公网地址。
- `qq_attachment` 在可写会话中默认将附件保存为私有 R2 对象 `r2://.tmp/<时间戳>/attachments/<内容哈希>/<文件名>`。传 `/work` 路径或相对路径会显式导入工作区，同名且内容不同会返回 `workspace_conflict`。一条消息有多个附件时用 `ordinal` 选择文件。
- `qq_image` 返回图片内容和会话私有资产引用。仅有媒体读取权限的回合仍可通过 `qq_attachment` 获取私有引用。历史消息中已有的私有资产按原会话读取。
- `createMediaExtension` 注册 `qq_image`、`qq_attachment`、`send_file`，由宿主 `lookupHostMedia` 校验当前 scope 与目标，每次最多解析 5 个附件。

### 3.2 持久工作区与群聊脚本执行

- `SandboxDO` 的 Cloudflare 容器通过原生 `Files` 与 `Container.exec` 操作 `/work`，R2 保存不可变 `WorkspaceManifest` 与按 SHA-256 去重的 blob，DO 保存 `head`、`epoch` 与操作账本。
- 冷容器用 `DirectoryBackup` 恢复已提交目录归档，再按最新清单应用归档后的变更。旧工作区第一次从原有清单恢复后生成归档。新变更逐次提交。工作区有变更且距上次归档满 15 分钟时才更新整包，空闲时不启动容器做备份。归档只收录清单已跟踪的文件。归档不可用时仍可从清单恢复。
- 新产生的 `.git`、`node_modules`、`.wrangler` 留在容器内不计入 R2 源码快照配额（旧 manifest 已追踪的保留兼容）。
- `run({ operationId, operation })` 串行执行 `exec / read / write / edit`，返回 `committed | failed | unknown`；同 ID 异参拒绝，已执行中断的 `bash` 返回 `unknown` 绝不重跑。成功变更必须完成 checkpoint；`epoch` 递增阻止旧容器提交快照。`resetRuntime()` 仅销毁容器，保留持久工作区。
- **分页 GC**：`gc` 默认 dry-run，保留 `head`、1 小时传输租约及最近 2 份历史，每批扫描最多 500 对象，由 `SandboxDO` alarm 每 30 秒续跑一批（失败 5 分钟重试），不阻塞批间读写；维护涵盖默认会话工作区、旧子任务工作区与登记表中的显式 Cloudflare 资源。
- **群聊脚本执行**：主人私聊与群聊的普通消息回合（含所属会话网页续聊）可通过 Code Mode 调用本会话绑定的 Linux 沙箱写脚本、执行、查看 `/work/out/` 产物并用 `send_file` 发出；按会话隔离且不注入 Worker 凭据。事件、定时、其他私聊与未授 coding 的子任务不获此权限。
- **owner 跨群只读**：Code Mode 的 `read` 支持可选 `workspace: "group:群号"`，仅在 owner 原始任务授权有效时直读目标 `SandboxDO.readBlob`（不启动容器、不写快照）。
- **工作区技能发布**：`skill_inspect` 与 `skill_publish` 仅作为 Code Mode 嵌套工具在 owner 私聊/网页开放（子 agent 不继承），先固定一次 `workspaceRevision` 与 Registry `expectedRevision` 再双版本 CAS 发布，不向模型暴露 `ADMIN_TOKEN`。

### 3.3 Code Mode 输出文件环境

主会话及获准使用相应工作区的子 agent 可以通过 Code Mode 访问独立的 R2 文件存储。同一个 Cloudflare 工作区资源使用同一个私有 key 前缀。Linux `/work` 和 R2 对象单独保存。

- `r2_write({key,content})` 保存文本；`r2_write({key,path})` 将已提交的 Linux 文件上传到该 key。
- `r2_read({key})` 直接读取文本或图片；`r2_read({key,path:"/work/in/file.bin"})` 将原始字节复制进 Linux 工作区供 `bash` 打开。两处副本后续独立修改。
- `image(block)` 和超长输出自动写入 `r2://.tmp/<时间戳>/codemode/...`，不唤醒 Linux 容器。系统每小时从 R2 清理一批已超过七天的自动输出和默认 QQ 附件，每批最多 1000 个，资源退出后仍可回收。`r2_write` 写入的自选 key 长期保存；`.tmp/` 为系统保留前缀。要保留自动产物，可用 `r2_read({key,path})` 取入工作区，再用 `r2_write({key:"reports/...",path})` 存为长期对象。
- 主 agent 可以通过 `send_file({path:"r2://..."})` 转发原始文件。子 agent 汇报其资源 ID 和引用，owner 可用 `r2_read({sandboxId,key})` 核对内容再发送。指定 `path` 时，副本写入调用方自己的 `/work`。历史 `/work/.codemode/` 文件仍按原路径保存在工作区。`agent_send` 的 `files` 接受工作区路径，转发 R2 对象前先用 `r2_read({key,path})` 取入。

### 受控 Skill 执行器与加密登录态共享

需要登录态的 Skill 可在附件中声明 `runner.json`，由宿主为每个 Skill 维护独立隔离的执行沙箱（`SandboxDO("skill-state:<skill>")`），在不向半信任群会话暴露原始 Cookie/Token 或任意 `bash` 的前提下，让群聊与群子任务无损复用主人登录态：

- **受控动作清单（`runner.json`）**：随 Skill 一起通过 `skill_publish` 或管理台 CAS 发布。每条 action 声明 `command`（`python3`、`node` 或 Skill 内相对路径，运行期禁用 `shell` 直接 `spawn`）、`description`、可选 `ownerOnly`（仅主人可调）、`timeoutSec`（1–120 秒）和 `argsSchema`（JSON Schema 严格校验后通过 `stdin` 传给脚本）；可选 `deps: { kind: "npm" }` 在容器冷启动时将 `package.json` + `package-lock.json` 安装到只读 `/opt/skill-deps`（不计入状态快照）。
- **容器隔离与零改造承接**：`/opt/skill` 以 `root:root` 只读物化已发布代码；`/work/state`（同时暴露为 `SKILL_STATE_DIR`、`HOME=/work/state/home`、`XDG_CONFIG_HOME=/work/state/.config`、`XDG_DATA_HOME=/work/state/.local/share`）保存 CLI/SDK/脚本落盘的登录态；`/work/out`（`SKILL_OUT_DIR`）作为单次运行产物出口，运行结束后校验无软链接并按最多 5 个文件、总计 8 MiB 写入调用方 `r2://.tmp/...` 后清空。
- **自动加密写回与并发保护**：同一个 Skill 的所有运行请求经串行队列（最多排队 4 个，超限返回 `skill_busy`）执行，避免多群并发刷新一次性 `refresh_token`。进程正常退出即对 `/work/state` 做快照，使用 `TokenVault`（`AES-GCM` + AAD 绑定）串行加密写入 R2（保留最近 3 个历史版本）；超时或容器异常直接回滚并销毁容器，不提交半截状态。
- **主人运维与群/子任务授权**：主人交互回合可在 Code Mode `skills` 命名空间使用 `skill_owner_bash`（在受控状态沙箱交互登录）、`skill_state_import`（从 `/work/...` 或 `r2://...` 直拷文件）、`skill_state_list`、`skill_state_clear` 与 `skill_grant`。群会话与群派出的子任务仅可调用 `skill_actions` 与 `skill_run`（子任务取派出快照与实时授权交集，禁止调用 `ownerOnly` 与管理类工具），执行结束后再次核验授权才交付输出。脚本返回 `authExitCode`（默认 `41`）时自动触发 `credential_login` 主人告警，主人重新登录或导入后自动关闭。

## 4. MCP、子 agent 能力委派与群审批契约

### 4.1 主/子 agent 委派与能力边界

- 主线程复用 `ThreadMcp` 连接、目录缓存与队列；子 agent 只保存派出时的有界目录快照（`catalogJson`），所有 MCP 调用经父线程 `SubagentCapabilityHost`（`workers/src/mcp/delegated.ts`）代理并重核父 scope、当前 `generation`、取消状态与当前授权。目录快照只能缩小权限，不能扩大。
- 派出参数支持可选 `mcpTools: [{ server, tools }]` 收窄原始工具名，可选 `sandboxId`（来自 `sandbox_list` / `sandbox_create`，省略继承父默认工作区；同一 ID 共享 `/work`）。子 agent 没有发送、鉴权、技能发布、记忆写入或继续派出子 agent 的工具。
- 宿主在 `tools/call` 的 `params._meta["cs-agent/caller"]` 注入不可伪造的调用 scope（以及 Windows MCP 的授权环境范围 `environments`），模型工具参数不能覆盖。
- 自托管 Cua 通过 `list_spaces` 和 `list_tools`（`service=driver`）展示获准设备及其 Driver 工具契约。主人通过管理台按会话分配设备，子任务只可查看派出时清单与当前分配的交集。已启用的 `space_bash`、`space_job`（仅限 Linux/macOS；Windows 不支持）、`space_write` 与完整 `call_tool(service=driver)` 按只读/写分类执行：目录与只读工具免批直通，`call_tool` 与 `space_job` 支持管理台可选收紧为只读模式；所有写操作经宿主持久防重放回执保护、无需人工审批弹窗。`call_tool` 返回的合法截图写入调用方私有 R2 并给出 `structuredContent.imageId` / `imageIds`，可用于 `send_message.images`。
- Cloudflare 编码沙箱和独立 Windows Sandbox MCP 依据各自的执行权限运行任务。R2 快照属于会话的 Cloudflare 编码沙箱。停止子任务后仍需对已经提交的 WSB 命令显式取消并等待确认。

### 4.2 资源、图片与统一返回契约

- MCP 资源目录与读取（如 Notion 仅允许 `notion://docs/` 且在远端目录/模板内）复用同一授权与连接队列。图片 blob（PNG/JPEG/WebP/GIF，单张 ≤ 4 MiB、最多 4 张）转原生 image content；其他二进制资源写入当前 scope 私有 R2 并返回 `AssetRef`。
- Code Mode 中的远端工具与 `mcp_resources_*` 统一返回 `{ content, structuredContent?, isError? }`：程序从 `structuredContent` 读字段，文本块用 `text(block.text)`，图片块用 `image(block)`，禁止将含 Base64 的整对象传给 `text()`。文本输出上限 8,000 字。

### 4.3 群 MCP 授权与逐次审批

- 普通 MCP 服务默认仅主人可用。管理员通过 `PUT /admin/mcp/access` 为群配置允许工具（静态 `allow` 子集）、允许资源前缀、允许成员、有效期及（Windows runner 的）环境 ID 列表与环境审批策略。
- 宿主维护静态 `tools.readOnly` 清单（不信任远端声明）；群成员使用 owner 账号调用非只读工具时产生独立审批（绑定 `actor`、`scope`、`generation`、`replyChannel`、工具契约、参数摘要、`operationId` 与 10 分钟有效期）。
- 批准接口只接受请求 ID 与动作，严格执行已保存参数；执行中若 DO 中断，下次 `restore` 经 `recoverInterrupted` 将 `executing` 标为 `outcome_unknown` 绝不重放。事件回合不借群授权调用 MCP；网页来源 `replyChannel` 保持 `web`。
