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
- 有工作区写权限时，`qq_attachment` 将字节直接写入当前工作区，返回已提交的 `path`、文件名、类型和字节数。模型可以传 `path: "downloads/package.zip"` 或绝对路径 `/work/downloads/package.zip`；一条消息有多个附件时，用 `ordinal` 为其中一个指定路径。省略路径时按内容哈希和文件名保存到 `/work/attachments/`。目标存在相同内容时复用，内容冲突时返回 `workspace_conflict`。工作区统一持久化到 R2。
- `qq_image` 返回图片内容和会话私有资产引用。仅有媒体读取权限的回合仍可通过 `qq_attachment` 获取私有引用。历史消息中已有的私有资产按原会话读取。
- `createMediaExtension` 注册 `qq_image`、`qq_attachment`、`send_file`，由宿主 `lookupHostMedia` 校验当前 scope 与目标，每次最多解析 5 个附件。

### 3.2 持久工作区与群聊脚本执行

- `SandboxDO` 的 Cloudflare 容器通过原生 `Files` 与 `Container.exec` 操作 `/work`，R2 保存不可变 `WorkspaceManifest` 与按 SHA-256 去重的 blob，DO 保存 `head`、`epoch` 与操作账本。
- 新产生的 `.git`、`node_modules`、`.wrangler` 留在容器内不计入 R2 源码快照配额（旧 manifest 已追踪的保留兼容）。
- `run({ operationId, operation })` 串行执行 `exec / read / write / edit`，返回 `committed | failed | unknown`；同 ID 异参拒绝，已执行中断的 `bash` 返回 `unknown` 绝不重跑。成功变更必须完成 checkpoint；`epoch` 递增阻止旧容器提交快照。`resetRuntime()` 仅销毁容器，保留持久工作区。
- **分页 GC**：`gc` 默认 dry-run，保留 `head`、1 小时传输租约及最近 2 份历史，每批扫描最多 500 对象，由 `SandboxDO` alarm 每 30 秒续跑一批（失败 5 分钟重试），不阻塞批间读写；维护涵盖默认会话工作区、旧子任务工作区与登记表中的显式 Cloudflare 资源。
- **群聊脚本执行**：主人私聊与群聊的普通消息回合（含所属会话网页续聊）可通过 Code Mode 调用本会话绑定的 Linux 沙箱写脚本、执行、查看 `/work/out/` 产物并用 `send_file` 发出；按会话隔离且不注入 Worker 凭据。事件、定时、其他私聊与未授 coding 的子任务不获此权限。
- **owner 跨群只读**：Code Mode 的 `read` 支持可选 `workspace: "group:群号"`，仅在 owner 原始任务授权有效时直读目标 `SandboxDO.readBlob`（不启动容器、不写快照）。
- **工作区技能发布**：`skill_inspect` 与 `skill_publish` 仅作为 Code Mode 嵌套工具在 owner 私聊/网页开放（子 agent 不继承），先固定一次 `workspaceRevision` 与 Registry `expectedRevision` 再双版本 CAS 发布，不向模型暴露 `ADMIN_TOKEN`。

### 3.3 Code Mode 输出文件环境

主会话与有编码权限的子 agent 通过 `Harness.open({ env })` 获得基于 `/work` 持久工作区的 `ExecutionEnv`：

1. 远程 MCP 返回图片且脚本调用 `image(block)`，或输出超长文本时，`pi-durable` 将原始字节写入 `/work/.codemode/<时间戳>-<UUID>-pi-codemode-/...`，经容器快照与 R2 提交后返回保存路径（图片同时直接给模型查看）。
2. 主 agent 可直接 `send_file({ path })`；子 agent 汇报 `sandboxId` 与路径，由父 agent 通过 `send_file({ sandboxId, path })` 导出（仅限主人拥有的 Cloudflare 资源）。
3. 受管临时目录在下次创建时最多清理 10 个超过 7 天的目录；长期文件应复制到 `/work/out/`。二进制 RPC 保持 `Uint8Array`；高级句柄与环境 shell 明确返回 `not_supported` / `shell_unavailable`，命令执行仍走 `bash` 工具。

### 主人向群共享登录凭证

主人可以在私聊或 owner 管理页说“把刚才登录生成的 `/work/login/cookies.txt` 用于这个服务的查询，授权给 A 群”。Agent 根据服务取一个简短引用名，使用宿主工具直接导入已保存的文件。主人无需给凭证起名、粘贴内容或上传 Worker Secret。导入完成后，原文件仍位于主人的私有工作区。

- 每份凭证独立授权。主人指定受信任的 HTTPS 查询地址，可以一次登记多个。默认精确匹配 HTTPS 来源和路径。主人也可以用 `https://api.example.com/*` 明确授权该来源的所有路径，子域名和其他端口需要单独授权。宿主允许查询参数，发送 GET 并拒绝重定向。应选择只提供业务数据的接口，目标服务会收到认证头。
- 文件支持单行 Cookie 请求头、curl/Netscape 格式的 `cookies.txt`、单行 Bearer Token 或 API Key。导入 Cookie 文件时保留适用的域、路径和过期条件，也可只选登录所需的 Cookie 名。源文件上限为 16 KiB，筛选后至多保留 128 条。curl 导出的值可包含逗号。API Key 默认经 `X-API-Key` 发送，也可指定服务要求的 `X-*` 头。Registry 使用已有主密钥加密保存凭证。
- 主人和获授权群的普通消息回合可在 Code Mode 里使用 `credentials` 命名空间。Skill 先调用 `credential_list` 查看本会话可用引用，再调用 `credential_request`。模型和群工作区只接收业务响应。工具限制为 64 KiB 文本，发现凭证值回显会扣留正文。对常见语言、地区和开关 Cookie，检查完整名值对，以免普通计数被误拦。主人显式选择的登录 Cookie 和 API Token 即使很短也检查裸值。HTTP 错误只返回状态或错误码。原生 Bash 可处理宿主工具取回的业务数据。
- 主人重新登录后从新文件轮换凭证，各群继续使用同一引用。服务返回 401 或请求时 Cookie 已无有效条目，系统按现有主人告警设置提醒更新。撤销一个群的权限即移除它对该引用的访问。删除凭证会同时清除所有群授权。
- 凭证管理和查询审计只记录操作、引用、结果和授权目标。新的凭证默认仅主人可用。定时、事件、Agent 来信和子任务不继承用户的交互授权。

例如，群里的 Skill 可以在 Code Mode 查询商品，实际登录信息由宿主在发送时附上。

```javascript
const result = await tools.credential_request({
  ref: "shop",
  url: "https://api.example.com/items?id=42",
});
if (result.status === 200) text(JSON.parse(result.body).items);
```

## 4. MCP、子 agent 能力委派与群审批契约

### 4.1 主/子 agent 委派与能力边界

- 主线程复用 `ThreadMcp` 连接、目录缓存与队列；子 agent 只保存派出时的有界目录快照（`catalogJson`），所有 MCP 调用经父线程 `SubagentCapabilityHost`（`workers/src/mcp/delegated.ts`）代理并重核父 scope、当前 `generation`、取消状态与当前授权。目录快照只能缩小权限，不能扩大。
- 派出参数支持可选 `mcpTools: [{ server, tools }]` 收窄原始工具名，可选 `sandboxId`（来自 `sandbox_list` / `sandbox_create`，省略继承父默认工作区；同一 ID 共享 `/work`）。子 agent 没有发送、鉴权、技能发布、记忆写入或继续派出子 agent 的工具。
- 宿主在 `tools/call` 的 `params._meta["cs-agent/caller"]` 注入不可伪造的调用 scope（以及 Windows MCP 的授权环境范围 `environments`），模型工具参数不能覆盖。
- Cloudflare 之外的环境（Windows Hyper-V/WSB、设备命令行、独立桌面）均通过标准 MCP 接入，不走 R2 同步。停止子任务不撤回已提交远端命令，须在有效期间显式取消并等待确认。

### 4.2 资源、图片与统一返回契约

- MCP 资源目录与读取（如 Notion 仅允许 `notion://docs/` 且在远端目录/模板内）复用同一授权与连接队列。图片 blob（PNG/JPEG/WebP/GIF，单张 ≤ 4 MiB、最多 4 张）转原生 image content；其他二进制资源写入当前 scope 私有 R2 并返回 `AssetRef`。
- Code Mode 中的远端工具与 `mcp_resources_*` 统一返回 `{ content, structuredContent?, isError? }`：程序从 `structuredContent` 读字段，文本块用 `text(block.text)`，图片块用 `image(block)`，禁止将含 Base64 的整对象传给 `text()`。文本输出上限 8,000 字。

### 4.3 群 MCP 授权与逐次审批

- 群默认无任何 MCP 工具。管理员通过 `PUT /admin/mcp/access` 为群配置允许工具（静态 `allow` 子集）、允许资源前缀、允许成员、有效期及（Windows runner 的）环境 ID 列表与环境审批策略。
- 宿主维护静态 `tools.readOnly` 清单（不信任远端声明）；群成员使用 owner 账号调用非只读工具时产生独立审批（绑定 `actor`、`scope`、`generation`、`replyChannel`、工具契约、参数摘要、`operationId` 与 10 分钟有效期）。
- 批准接口只接受请求 ID 与动作，严格执行已保存参数；执行中若 DO 中断，下次 `restore` 经 `recoverInterrupted` 将 `executing` 标为 `outcome_unknown` 绝不重放。事件回合不借群授权调用 MCP；网页来源 `replyChannel` 保持 `web`。
