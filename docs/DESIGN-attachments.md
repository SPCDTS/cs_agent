# 执行 agent 的附件发送与生图工具下线（2026-10-19）

用户决定（2026-10-19，含同日澄清）：
1. codex 有内置的生图能力（`.system` 技能 `imagegen`），cs-agent 不干预、不在提示词上做任何处理；因此撤掉 cs-agent 自己给 codex 挂的 `image_gen` MCP 及 AGENTS.md 里关于它的说明。
2. pi 继续持有 `generate_image` 工具，不增加任何额外提示词；`data/prompts/agent.md` 不动。
3. `奶龙:` 前缀分流是用户的测试入口，与 agent 流程无关：不在任何提示词里提及，规则分流代码不动。
4. 给执行 agent 加上"通过 IM 发送图片、文件"的能力（codex 用内置生图产出的文件也经此发送）。

实施排在包结构整理 P1 之后（P1 正在搬动 `agent/image-*`、`qq/image*`、`mcp/image-gen*`），避免冲突；§6 记录验收。

## 0. 已核实的事实

- NapCat 目前是宿主机进程（127.0.0.1:3000/3001），容器经 `host.docker.internal` 连接。用户 2026-10-19 决定把 NapCat 迁进 compose（见 `docs/DESIGN-napcat-container.md`）；迁移前后 NapCat 都看不到 cs-agent 容器的路径，因此附件统一以 `base64://` 传给 NapCat，不依赖共享卷。现有回复图片已经以 `base64://` 内联在 `image` 消息段里发送（`qq/image.ts`：单张 ≤ 10 MiB、合计 ≤ 20 MiB、最多 4 张、PNG/JPEG/WebP/GIF 魔数）。
- NapCat 的 `upload_private_file(user_id, file, name)` / `upload_group_file(group_id, file, name, folder?)` 的 `file` 经 `uriToLocalFile` 解析，支持 `http(s):`、`base64:`、`file:`；返回 `file_id`。文件是独立消息，不能与文字段合并发送。
- 现在"回复附图"只收集 `${DATA_DIR}/images/<票据>/` 下回合内新出现的图片（`collectNewImages`），该目录只有 `image_gen` MCP 进程（沙箱外）能写；codex 的 shell 在 bwrap 沙箱里，只能写 `/workspace/<scope>`（及 owner 的 prompts/workflows），`/data/images` 在禁读名单。因此模型无法把已有文件当附件发出——这正是用户在上下文分析页看到的"QQ 接口没有发送现成图片附件的功能"。
- codex 每个线程键（`owner` / `group:<id>` / `private:<qq>`）的工作区是 `/workspace/<key 冒号换下划线>`，由 `codexWorkspacePolicy` 以命名权限隔离，其他会话目录不可读。pi 后端同样以 `workspaceDir/<key>` 为工作目录（`codingEnvironment`）。
- MCP 服务进程由 codex 直接 spawn，不在 bwrap 沙箱内，可读写 `/data`；`qq_context` MCP 已持有本轮 `QQ_ACCESS` / `QQ_TICKET` / `QQ_BACKEND` / `QQ_SESSION`。

## 1. 撤掉 cs-agent 给 codex 挂的生图工具（codex 用自带能力）

| 项 | 改法 |
|---|---|
| 受管 AGENTS.md（`renderManagedAgentsMd`） | 删除"## 生图（image_gen）"整段。其中关于图片召回的两句（`[image]` / `qq_image(message_id)` / `qq_view_image(path)` / `[image:<路径>]`）与生图无关，移到"聊天记录与图片"小节保留，但去掉 `reference_images` 这半句。**不加**任何关于生图或前缀的替代说明。 |
| 播种的自定义提示词 `DEFAULT_CODEX_PROMPT` | 删除"## 生图提示词指引"段。已部署环境的 `data/prompts/codex.md` 是持久化文件，默认值不会覆盖：部署时由主会话手工删除该段并记入 §6。 |
| codex 的 `image_gen` MCP 注册（entrypoint `[mcp_servers.image_gen]`） | 新增 `CODEX_IMAGE_GEN=off|on`（默认 `off`）：off 时不写该段，`codex-runner` 不再注入 `IMAGE_TICKET_DIR` / `IMAGE_REFS` / `mcp_servers.image_gen.env.QQ_ACCESS` 相关 `-c`（保留函数，按开关跳过），`src/mcp/image-gen.ts` 代码保留。on 时行为与现在一致。 |
| codex 内置 `imagegen` 技能 | 不动。它产出的图片落在工作区（cwd）里，由 §2 的 `qq_send_image(path)` 发出。 |
| pi 的 `generate_image` 工具与 `DEFAULT_AGENT_PROMPT` / `data/prompts/agent.md` | 不动。pi 生成的图片仍由 `collectNewImages` 自动随回复发出。 |
| 规则分流的生图路径（`cs.image` 任务、main.ts 的 `imageBackend`） | 不动（用户的测试入口）。 |
| 回合结束的图片收集（`collectNewImages`） | 保留：它同时是 §2 附件图片的发送通道。 |

## 2. 附件发送能力

### 2.1 工具

在 **`qq_context` MCP**（codex）与 **pi-tools**（pi）各加两个工具，签名一致：

- `qq_send_image(path: string)`：把一张已有图片随本次回复发出。
- `qq_send_file(path: string, name?: string)`：把一个文件随本次回复发出（作为 QQ 文件消息，紧随文字回复之后）。

不新建 MCP 进程（每轮每个 MCP 都是一次 node 启动）。`qq_context` 进程新增注入 `QQ_ATTACH_DIR=${DATA_DIR}/images/<票据>`（与原 `IMAGE_TICKET_DIR` 同一校验：`resolveTicketDir`）和 `QQ_FILE_DIR=${DATA_DIR}/files/<票据>`、`QQ_WORKDIR=/workspace/<key>`。

### 2.2 允许的来源（两个工具相同）

1. 本轮工作区 `QQ_WORKDIR` 下的普通文件（realpath 必须仍在该目录内；拒绝软链接、目录、设备文件）。
2. 已召回且属于当前访问范围的媒体：`/data/media/<sha256>`，以 `ContextStore` 的 `message_media` 按 `QQ_ACCESS` 校验归属（与 `/media/:sha` 路由同一规则）。
3. 其余路径一律拒绝，错误文本说明"只能发送工作区内的文件或已召回的图片"。

### 2.3 限制与校验

| | 图片 | 文件 |
|---|---|---|
| 单个大小 | 12 B – 10 MiB（沿用） | 1 B – 20 MiB（`ATTACH_FILE_MAX_MB`，默认 20） |
| 数量 / 回合 | 与生图合计 ≤ 4（沿用 `MAX_IMAGES`） | ≤ 3（`ATTACH_FILES_MAX`，默认 3） |
| 类型 | 魔数 PNG/JPEG/WebP/GIF（沿用 `isSupportedImage`） | 任意；文件名只取 basename，去控制字符，≤ 120 字符；扩展名 `.exe .bat .cmd .ps1 .vbs .js .scr .msi .com .lnk` 拒绝（`ATTACH_FILE_DENY_EXT` 可改） |
| 落盘 | 复制到 `QQ_ATTACH_DIR/attach-<n>/<basename>`，由现有 `collectNewImages` 收集 | 复制到 `QQ_FILE_DIR/<n>-<basename>`，并写 `manifest.json`（原路径、名字、大小、sha256、来源类型） |
| 返回 | "已登记，将随回复发送（第 n/4 张）" | "已登记，将随回复发送（第 n/3 个，x MiB）" |

工具调用在观测面板回合页按现有 `tool:<name>` 事件显示；召回级证据不涉及。

### 2.4 发送（`cs.agent` 任务 `reply` 阶段）

- 文字 + 图片：不变（一条 `send_*_msg`，图片 base64 段）。
- 文件：文字消息 `markSent` 之后，逐个调用 `upload_private_file` / `upload_group_file`，`file` 为 `base64://<内容>`，`name` 为清洗后的文件名；群聊 `folder` 不传（根目录）。
- 幂等：`TicketDoc.fileUploads[n] = { status: pending|sending|sent|uncertain, file_id? }`；每个文件调用前先提交 `sending`，成功提交 `sent`+`file_id`，异常提交 `uncertain` 且不重试（与文字票据同一口径）。进程重启后只重传仍为 `pending` 的文件。文件上传失败不影响已发出的文字；全部完成后在观测 `reply` 事件里记 `files: [{name, bytes, status}]`。
- 超时：文件上传用 `IMAGE_TIMEOUT_MS` 同一口径的加长超时（按大小线性加成：每 MiB +2 s，上限 120 s）。
- 清理：票据清理时连同 `${DATA_DIR}/files/<票据>` 一起删除（沿用 `cleanupTicketWorkdir`）。

### 2.5 提示词

受管 AGENTS.md 新增小节"发送图片与文件"：
- "要把工作区里的图片或文件发给用户时，调用 qq_send_image(path) / qq_send_file(path)，它们会随本次回复自动发出；每次回复最多 4 张图、3 个文件，单个文件不超过 20 MiB。只能发送你工作区内的文件和已召回（[image:<路径>]）的图片。回复文本里不要写文件路径。"
pi 的 agent.md 也加这一段（这是工具用法说明，不是生图提示）。

### 2.6 观测与文档

- 回合页：`qq_send_image` / `qq_send_file` 的工具调用自然可见；`reply` 事件扩展 `files`。
- `docs/DEPLOY.md`、`.env.example`：`AGENT_IMAGE_TOOL`、`ATTACH_FILE_MAX_MB`、`ATTACH_FILES_MAX`、`ATTACH_FILE_DENY_EXT`。
- `docs/ARCHITECTURE.md` §4/§5：生图路径只剩规则分流；附件工具说明。

## 3. 安全边界

- 来源白名单只有本轮工作区与本访问范围的已召回媒体；不接受 URL、不接受 `/data` 其他路径、不跟随软链接。
- 群聊里 `qq_send_file` 发出的文件对全群可见，与文字一致，不另设 owner 限制；但 `/data/prompts`、`/data/workflows`（owner 可写目录）不在允许来源内，防止把运维文件发到群里。
- 文件名与内容不做任何"清洗"之外的修改；可执行扩展名拒绝。
- 同一文件在一轮内重复登记只算一次（按 sha256 去重）。

## 4. 实施分组

- A（后端，Codex）：§1 的 codex 侧 + §2.1–2.4 的 codex 侧（`qq_context` MCP 工具、`codex-runner` 注入、`tasks.ts` reply 阶段、bridge 的 `uploadFile`、票据清理）+ 测试 + 文档。
- B（pi 侧，Codex）：pi-tools 两个工具、pi 回合收集文件清单；pi 的生图工具与提示词不动。
- 两组可并行（文件不重叠：A 不碰 `agent/pi-tools`、`agent/backends/pi.ts`、`agent/prompt.ts`）。
- 主会话验收：真实容器里用 stdio 方式调用 `qq_send_file` 登记一个工作区文件；再用 QQ 私聊让 bot 发一个文件与一张工作区图片（用户侧）；检查 reply 事件与 NapCat 返回的 `file_id`；确认 AGENTS.md 里已无我们自己的生图段落、`image_gen` MCP 不再在 codex 的 `tools` 列表中（上下文分析页"工具定义"类别）。

## 5. 非目标

- 不支持发送语音、视频、合并转发；不支持从 URL 直接发文件（模型可先下载到工作区再发）。
- 不改规则分流的生图路径与 ComfyUI 实现；不删除 `image_gen` MCP 代码（开关为 on 时仍可用）；不碰 codex 内置 `imagegen` 技能，也不为它写任何提示。

## 6. 验收记录

（待填）
