# cs_agent 架构设计

> 主会话负责本文件与 `src/qq/types.ts` 契约；具体实现由子 agent 完成。实现若需偏离本设计，须在 PR/报告中说明原因。

## 1. 目标

一个基于 **pi-durable** 的最小 agent，Docker 单容器部署，只做一件事：

1. 通过内置 **QQBridge** 工具从 QQ（NapCat OneBot v11）接收消息；
2. **触发消息**（私聊；允许群内真实 @）经 **Inbox** 落盘后按会话键交给 **ThreadHost**：每个会话（`group:<id>`、`private:<qq>`、owner 多账号共用的 `owner`）一个常驻 agent 线程，空闲开一轮、同一发送者插话、其余排队（详见 [常驻 agent 设计](DESIGN-resident-agent.md)）；
3. **执行 agent** 后端可切换（`AGENT_BACKEND=codex|pi`，可按会话覆盖），默认是**同一容器内**常驻的 `codex app-server`；两后端通过 `send_message` 发送文字、图片或文件，默认回复来源会话，有授权时可指定 target；最终回答只留存，模型没发消息不兜底，只在出错时提示。

> v2 的"意图识别模型选工具"（`generate_image` / `ask_codex` / `reply_qq` 三个模型工具与热加载 `system.md`）已在 v3 移除，见 §5.2 与 §10。
> 2026-10：v3 的规则分流与本地 ComfyUI 生图（`IMAGE_PREFIXES` 前缀路由、派发器与 `cs.image` 任务、pi 的 `generate_image`、codex 的 `image_gen` MCP）已移除，所有触发消息（含以 `奶龙:` 开头的）都作为普通输入交给执行 agent；codex 自带的内置生图不受影响。§10 中相关条目仅作历史记录。

## 2. 外部依赖与事实（已核实，2026-10-17）

| 组件 | 版本 / 事实 |
|---|---|
| `@earendil-works/pi-durable` | 1.3.0；依赖 `@earendil-works/pi-ai` 1.3.0、`@earendil-works/chord` 1.3.0；实验性 API |
| `@earendil-works/pi-ai` | 内置 provider `openai-codex`（ChatGPT 订阅 OAuth，baseUrl `https://chatgpt.com/backend-api`）、`openai`、`anthropic` 等；`providers/faux` 可用于测试 |
| `@openai/codex` | 镜像固定 `0.164.0-alpha.8`（子 agent 唤醒 `wake_on_agent_messages` 自此版本起才有）。cs-agent 常驻一个 `codex app-server`（stdio JSON-RPC），`thread/start` / `thread/resume`、`turn/start` / `turn/steer`；`CODEX_HOME` 决定 auth.json/config.toml/sessions 位置。早期每轮一个 `codex exec [resume]` 的用法已废弃，只在 §10 历史记录中出现 |
| NapCat（Compose 服务，2026-10-19 方案） | `mlikiowa/napcat-docker` 按 index digest 固定；HTTP `agent-http` / WS `agent-ws` 在容器内监听 `0.0.0.0:3000/3001`，cs-agent 默认访问 `http://napcat:3000` / `ws://napcat:3001`，同一 Bearer token，`messagePostFormat: array`。3000/3001 不发布，WebUI 只发布 `127.0.0.1:6099`。环境变量仍可指向宿主机 NapCat（`host.docker.internal:3000/3001`），用于回退；真实迁移验收见 `DESIGN-napcat-container.md` §6 |
| codex 模型提供者（2026-10-19） | 默认 `CODEX_PROVIDER=magpie`，容器经 `http://host.docker.internal:3425/v1` 访问宿主机 magpie，使用 Responses 与 `supports_websockets=false`；gateway key 仅经环境变量注入，目录用 `/v1/codex/models`。容器 NAT 被视为回环，key 归集与限定模型，不是这条路径的访问控制 |
| 模型凭据 | codex 仅 `CODEX_PROVIDER=openai` 直连时需要容器内 `auth.json`；pi / 摘要默认 DeepSeek API key，可选 `openai-codex` OAuth 不受该开关影响 |

## 3. 总体结构（常驻 agent）

```
QQ 用户 ──NapCat(OneBot v11)──► QQBridge(ws 收 / http 发)
                                     │ 授权 + @检测 + 去重 + 消息库入库
                                     │ 触发消息：inbound 行(queued) + 附件下载到 /data/incoming/<入站键>/
                                     ▼
                     Inbox：按会话键投递，记录 queued → delivered → done
                                     ▼
                     ThreadHost（每个会话键一份 cs.thread-host 文档，宿主 harness /data/agent.sqlite）
                     空闲 → 开一轮；忙且同一发送者 → 插话；其余（他人消息、定时输入）→ 排队
                     不同会话并行，进行中的回合数 ≤ AGENT_CONCURRENCY
                                     ▼
                     BackendRouter：后端属于会话（AGENT_BACKEND / OVERRIDES，面板可改）
                 ┌───────────────────┴──────────────────────────────┐
        codex：常驻 codex app-server                           pi：进程内 pi-durable（/data/pi.sqlite）
          turn/start · turn/steer；子 agent 完成后唤醒             submit / steer；子 agent follow-up 唤醒
          MCP（线程令牌）：qq_context（只读）、im、browser          工具：历史召回、联网、im、定时、子 agent 等
                 └───────────────────┬──────────────────────────────┘
                                     ▼
                  send_message → SendService → Outbox（sent 重放，uncertain 不重发）→ 发送规则
                                     ▼
                              QQ 原私聊 / 原群(@原发送者)
```

TurnMonitor 处理宿主事件：更新 Inbox 状态、记录观测、回合结束后补传附件；只有回合失败、后端丢失回合或输入无法投递时才发出错提示，
模型正常结束但没发消息不兜底。定时任务到点向来源会话投一条定时输入，线程忙时排队。重启后宿主先恢复回合（pi 续跑；codex 丢失 → 出错提示），
再由 Inbox 按到达顺序重新投递 `queued` 输入。设计细节见 [常驻 agent 设计](DESIGN-resident-agent.md)。

## 4. 目录与模块归属

```
cs_agent/
├─ docs/ARCHITECTURE.md          ← 本文件
├─ docs/DEPLOY.md                ← 部署手册（Agent A 写）
├─ Dockerfile, docker-compose.yml, .env.example
├─ package.json, tsconfig.json   （ESM, TypeScript, Node 24, vitest）
├─ src/
│  ├─ main.ts                    启动：加载配置 → 打开 Harness → resume() → 启动 QQBridge → 事件循环
│  ├─ config.ts                  环境变量与基础值校验（zod），不 import 业务模块
│  ├─ shared/                    横切工具（不依赖业务或观测层）
│  │  ├─ log.ts, log-core.ts     结构化日志门面、级别、缓冲区与订阅出口
│  │  ├─ redact.ts, redact-core.ts  环境秘密注册、生命周期与脱敏核心
│  │  ├─ trace.ts               事件总线、ObsEvent/TraceStore 结构契约
│  │  ├─ usage.ts, errors.ts     token 用量归一化、成本与失败分类
│  │  └─ format.ts              数字格式化与上下文占用计算
│  ├─ media/                     QQ 下层的通用媒体能力，不依赖 qq/context/agent/obs/mcp
│  │  ├─ header.ts              图片容器头、动画与尺寸校验
│  │  ├─ download.ts            安全下载、地址检查与 DownloadHooks
│  │  ├─ attach.ts, attach-paths.ts  附件来源/大小/数量/去重、文件清单与按会话的附件目录校验
│  │  ├─ limits.ts              图片数量/大小限制、魔数、根目录与文件读取校验
│  │  ├─ image-collect.ts       collectNewImages：目录内新增图片收集（不跟随软链接，按魔数校验）
│  │  └─ references.ts          validateReferences：入站参考图的允许列表与 realpath 范围校验
│  ├─ qq/                        ★ Agent B 独占
│  │  ├─ types.ts                ★ 主会话契约（只读）
│  │  ├─ bridge.ts               createQQBridge：WS 收事件、HTTP 发送、重连、心跳、去重
│  │  ├─ policy.ts               授权 / 触发规则（allowUsers、allowGroups、真实 at 段）
│  │  ├─ reply-store.ts          入站输入（inbound）与 Outbox 持久化（node:sqlite）；旧 tickets 表只读保留
│  │  ├─ incoming.ts             触发消息附件下载到 /data/incoming/<入站键>/
│  │  ├─ image.ts                复用 media 校验，组装 OneBot base64:// 图片段
│  │  └─ index.ts                导出 createQQBridge
│  ├─ agent/                     ★ Agent A
│  │  ├─ harness.ts              createModels + openai-codex provider + 注册表 + SQLite storage
│  │  ├─ extension.ts            defineExtension("cs-agent")：只注册定时排程任务（无模型工具）
│  │  ├─ config.ts               组合时解析 owner 与后端覆盖表
│  │  ├─ inbox.ts                Inbox：触发消息与定时输入按会话键投递、恢复、工具绑定与输入呈现
│  │  ├─ host/                   ThreadHost：每会话常驻线程的开轮 / 插话 / 排队、持久文档；identity.ts 求每轮权限（runRights）
│  │  ├─ turns.ts                BackendRouter（会话后端选择）与 TurnMonitor（出错提示、看门狗）
│  │  ├─ backends/               纯请求契约、后端选择、Codex/Pi 实现与 Pi 只读会话源契约
│  │  ├─ codex/                  runner、app-server、prompt、trace、context-usage、model-catalog、workspace、oauth
│  │  │  ├─ app-server/          常驻 codex app-server 的监管器（掉线退避重启）与 JSON-RPC 客户端
│  │  │  ├─ runner.ts            会话线程映射（codex-threads.json）与轮换、线程级配置（命名权限、受管 AGENTS.md、MCP 线程令牌）
│  │  │  └─ oauth.ts             将 Codex auth.json 的 ChatGPT tokens 映射为 pi-ai 凭据
│  │  ├─ send-service.ts         send_message 的目标校验、授权与日额度，写 Outbox
│  │  └─ replies.ts              出错提示文案（failed / lost / undeliverable）
│  ├─ context/                   消息库、访问范围、格式化、衰老与媒体持久化
│  │  ├─ access.ts               访问范围校验、owner 解析与 scopeLabel
│  │  ├─ observer.ts             SummaryObserver/RecallObserver 与 DTO；由 main 注入存储实现
│  │  ├─ media.ts, media-recall-server.ts  媒体库与按需图片召回；codex MCP 的 loopback 服务与线程令牌
│  │  ├─ qq-context-tool.ts      QQ 召回与附件工具门面，媒体归属交给 ContextStore
│  │  └─ recall-results.ts       按实际返回正文计算召回命中
│  ├─ obs/                       观测存储、路由与面板
│  │  ├─ store.ts, schema.ts     观测库与记忆表 DDL；独立进程共用建表逻辑
│  │  ├─ http.ts, http-util.ts   240 行路由组合入口与 SSE/CSRF 工具
│  │  ├─ dashboard-*.ts         面板选项契约、POST 处理与文件/表单边界
│  │  ├─ live.ts                 实时事件摘要与会话卡片
│  │  ├─ sessions/              会话索引、读取、订阅及会话路由
│  │  ├─ context/               上下文分析及独立的 /context 路由
│  │  ├─ memory/                记忆读取、埋点和记忆路由
│  │  └─ ui/                    HTML 与前端资源；dashboard-pages 接收只读数据，计算直引 shared
│  └─ mcp/                       codex 的 stdio MCP：qq-context.ts（聊天记录与图片召回）、im.ts（发送、授权与定时）
│     └─ qq-context-server.ts   工具注册、回调注入与图片调用适配；查询委托 context
├─ test/                         vitest；qq/ 下的测试归 Agent B，其余归 Agent A
└─ scripts/                      init-auth.ps1（把宿主机 ~/.codex/auth.json 复制进 ./data/codex/）
```

P0/P1/P2 搬迁对照与分层澄清见 [包结构设计 §6.1](DESIGN-package-layout.md#61-p0-实际搬迁对照)、[§6.2](DESIGN-package-layout.md#62-p1-实际搬迁对照)、[§6.3](DESIGN-package-layout.md#63-p2-实际搬迁对照)。依赖守卫位于 `test/architecture/deps.test.ts`；media 位于 qq 下层，P2 后例外清单为空，逻辑分层跨包无环。P0/P1 兼容转导出已清理；物理目录口径仍有 7 对双向边，原因与完整清单见 §6.3。

## 5. 关键设计决策

### 5.1 每个会话一个常驻线程
- 不用单一 root 累积所有 QQ 消息（上下文无限增长、串话）；也不再每条消息一个 durable 会话（v3 的 TicketDoc / DispatchDoc 与派发器已移除）。
- 会话键：owner 私聊为 `owner`，群为 `group:<id>`，其他私聊为 `private:<qq>`。每个键一份 `cs.thread-host` 文档，记录空闲/忙、当前回合、本轮输入与排队输入；每条输入以入站键幂等。
- 发送者身份与默认发送地址由宿主当前回合求出（`Inbox.binding`），**模型无法冒充发送者**；跨会话目标需授权（§5.6）。
- 重启后宿主恢复回合（pi 续跑；codex 丢失 → 出错提示，不自动重放有副作用的操作），Inbox 重新投递 `queued` 输入，Outbox 中 sending/uncertain 的消息不重发。

### 5.2 触发与后端选择（v3 规则分流已移除）
- 不经任何模型分流：bridge 判定触发（私聊；允许群内真实 @）后，整条原文作为输入交给 ThreadHost。v3 的 `router.ts` 前缀分流（`IMAGE_PREFIXES`，默认 `奶龙:`）已于 2026-10 随本地生图移除，以 `奶龙:` 开头的消息不再特殊处理。
- 没有意图层系统提示；v2 的 `${DATA_DIR}/prompts/system.md` 不再读取，存在时启动记一行弃用 warn（文件保留）。
- 执行 agent 的后端选择：`AGENT_BACKEND`（默认 codex）+ `AGENT_BACKEND_OVERRIDES`（`scope=backend`，非法项启动失败）；后端属于会话，配置变更在会话空闲且旧后端没有后台工作后生效。

### 5.3 codex 后端：常驻 app-server
- `CODEX_HOME=/data/codex`（容器卷），每个会话的工作目录 `/workspace/<会话键>`（冒号换成下划线）。
- cs-agent 启动并监管**一个**常驻 `codex app-server`（stdio JSON-RPC，`@openai/codex@0.164.0-alpha.8`），承载所有会话线程（`src/agent/codex/app-server/supervisor.ts`）。进程退出、管道错误或握手失败即视为掉线：按 1 s→60 s 退避重启，线程在下次使用时重新 `thread/resume`；掉线时进行中的回合与子 agent 丢失，向会话发"处理中断了"，不自动重放。
- 线程映射：`owner`、`group:<id>`、`private:<qq>` 各一条线程，记录在 `/data/codex-threads.json`；首次 `thread/start` 后立即原子落盘，之后 `thread/resume`，只有确认线程不存在才归档并新建。线程空闲时检查安全阀（rollout 超过 `CODEX_ROLLOUT_MAX_MB` 或线程超过 `CODEX_THREAD_MAX_DAYS` 天）并轮换。
- 线程级配置在 `thread/start` / `thread/resume` 的 `config` 里按点号键注入：命名权限（`src/agent/codex/workspace.ts`）、受管 AGENTS.md、`model_instructions_file`，以及 `im` / `qq_context` 两个 MCP 的线程令牌（`mcp_servers.<名>.env.IM_TOKEN` / `QQ_RECALL_TOKEN`）。app-server 为每个线程单独起 MCP 进程；令牌只证明"来自哪个线程"，身份与范围由主进程按会话当前回合求出（§5.6）。线程重新加载或进程重启时令牌作废重发。
- 回合：开一轮 `turn/start`（`effort`、`model` 为本轮快照，`clientUserMessageId` = 入站键）；同一发送者插话 `turn/steer`（带 `expectedTurnId`）；面板"停止"用 `turn/interrupt`。子 agent 由受管配置的 `features.multi_agent` 与 `features.wake_on_agent_messages` 开启，子 agent 完成后 app-server 自行开一轮唤醒主 agent，该回合继承派出者的身份。
- 不设单轮时限：回合连续 30 分钟没有任何事件由宿主看门狗中止并提示出错（`STALL_MS`，`src/agent/host/thread-host.ts`）。
- 容器内 `config.toml` 为受管文件，入口脚本每次启动按环境变量重写（`model`、`model_reasoning_effort` 默认 `codex/gpt-6.1-sol` / `high`，后者只是缺省值，每轮被 `turn/start` 的 `effort` 覆盖），**不**继承宿主机的 Windows 路径配置。
- codex 与 pi 共用的来源头部在群名已知时显示 `群 家庭群(123456)`，否则沿用群号；群名与昵称统一折成单行、中和来源/引用标签并限制 40 字，不赋予授权语义。QQBridge 的群名缓存来自 `get_group_info`（6 小时 TTL，硬超时 1500ms，失败退避 60 秒），随入站消息传递。
- 上下文库以幂等迁移建立 `scope_names(scope PRIMARY KEY, name, updated_at)`，记录带群名的消息时 upsert；跨会话历史的消息、引用链与摘要标签附上清洗后的群名。
- 只读工具 `qq_chats()` 列出群名/群号及好友备注，每类最多 200 条，仅限主人私聊（`access=all`）。pi 直接调用 Channel，codex 的 qq_context MCP 通过 `POST /chats` 回到 loopback 服务；主进程凭线程令牌与调用所属回合重新求出本轮权限，令牌作废即拒绝。Channel 的 `listChats` 使用 `get_group_list/get_friend_list` 并刷新群名缓存，context 仅依赖通道契约。

### 5.4 图片：只收发，不再本地生图
- 入站：触发消息的图片下载到 `/data/incoming/<入站键>/`，经 `media/references.ts` 按允许列表与 realpath 校验后，以 `[本轮参考图]` 列给模型（每条输入 ≤3 张）；媒体库、`qq_image` 召回与 `qq_view_image` 照旧。
- 出站：`send_message` 的 `images`。codex 自带的内置生图（imagegen）输出在 `/data/codex/generated_images/`，把工具返回的路径传给 `send_message` 即可发出；该目录按 `CODEX_GENERATED_IMAGES_RETENTION_DAYS` / `CODEX_GENERATED_IMAGES_MAX_MB` 清理。
- 本地 ComfyUI 生图（`comfy-mcp` / HTTP 后端、Qwen 工作流、loopback 转发、`cs.image` 任务、pi 的 `generate_image`、codex 的 `image_gen` MCP、迟到图片 #late 收取）已于 2026-10 移除。

### 5.5 QQBridge（相对 D:\Tools\QQBridge 的取舍）
保留：真实 `at` 段检测、自回声过滤、`self_id:type:group_id:user_id:message_id` 去重、授权模型（`allowUsers` 任意处可触发；`allowGroups` 内成员需真实 @）、入站决定性 ID（入站键）与 Outbox 的 `pending→sending→sent|uncertain` 幂等机制、群回复 `[at][text "\n"+正文]`、图片 `base64://` 发送与魔数校验、"结果不确定不自动重试"。
去掉：Codex 桌面管道、member-workspaces、group-context、MCP server 外壳、计划任务守护、loopback 限制（改为显式 URL + token 配置）。
改进：入站、Outbox 与去重状态改用 `node:sqlite` 单文件；端点由环境变量直接给出；暴露为进程内模块而非 MCP。

### 5.6 附件发送与 codex 工具注册

- codex 的模型提供者默认改为宿主机 magpie，受管配置使用 `env_key="CODEX_MAGPIE_KEY"`、`wire_api="responses"`、`supports_websockets=false` 与 `/codex/models` 目录。MCP 注册、附件路径与受管 AGENTS.md 不受提供者开关影响；MCP 不新增 key 透传，基础配置允许空 key，只有 CodexRunner 启动时检查 magpie key。设置页展示只读提供者与 URL。

- cs-agent 不再提供生图工具（pi 的 `generate_image`、codex 的 `image_gen` MCP 与 `CODEX_IMAGE_GEN` 已于 2026-10 移除）；受管 AGENTS.md 与 codex 提示词只保留聊天图片召回、附件用法与 codex 内置生图输出的发送说明。
- 统一工具 `send_message({ text, images?, files?, target? })` 默认发回本回合会话，文件项为 `{ path, name? }`。跨会话目标仅支持 `qq:group:<id>` / `qq:private:<QQ号>`，由 SendService 校验格式、owner 或有效授权（含 scopes / 到期时间）、群成员或好友关系（缓存 5 分钟）及 Asia/Shanghai 每 ref 每天 100 条额度。日额度按该 ref 的全部模型 Outbox 行计，系统行排除，SQLite 预留行时原子复核；被发送规则拒绝的行不计入。主动发送不 @，机器人历史及附件写向目标会话，跨会话正文去重包含目标。
- pi 在进程内调用 SendService；codex 的独立 `im` MCP 通过 loopback `/send`、`/im-info`、`/auth_grant`、`/auth_revoke`、`/auth_list` 调用主进程。每次调用由主进程确认属于会话当前回合（codex 按 MCP 请求的 `_meta.callId` 找到所在回合，子 agent 线程与过期回合一律拒绝），再按本轮绑定的人求出权限（`runRights`，`src/agent/host/identity.ts`）：会话基础权限只读本会话、只发本会话；确证的人才叠加 target、定时、授权等能力，无法确证一律回落基础权限。身份只取 Channel 的真实发送者，不读消息正文。pi 按回合选择工具配置；im 子进程启动时查询 `/im-info`，仅有权回合列出 `target`，仅 owner 交互回合列出 `auth_*`，服务端逐次复核。
- `GrantsDoc` 是宿主 harness（agent.sqlite）的 Session 文档，以 user 为键；`auth_grant` 替换该用户的授权，`auth_revoke` 可撤销部分能力或整条，过期授权只读展示但不生效。面板沿用 owner 运维令牌与同源 / CSRF 保护。`schedule` 授权由 ScheduleService 和模型工具共同复核，来源 scopes 与到期时间实时生效。`auth_changed` 记录 panel / tool、操作者及前后差异，`send_message` trace 带实际 target。
- `agent/schedule/tools.ts` 是 pi 与 codex 共用的定时工具入口，复用 ScheduleService 管理定义；`shared/schedule-tools.ts` 仅存工具名与权限契约，context 回环层不依赖 agent。管理工具仅开放给有 schedule 权限的交互回合，来源与 created_by 取本轮会话与确证的人，非 owner 只能管理自己的定义。pi 按轮配置独立扩展；im 启动时查询 `/im-info` 并调用 `/schedule_*`，HTTP 和工具服务逐次复核授权。
- 定时运行只开放 `schedule_control`，通过持久 admission / ScheduledRunDoc 将定时输入绑定到自身定义；pause / complete 停止后续触发，不中断当前回合。模型不能传入目标 id、actor 或来源。规则输入使用北京时间 `YYYY-MM-DD HH:mm`，工具说明要求将通知目的地解析为具体 ref 写入 prompt；`schedule_tool` trace 记录 action、id、actor 和控制原因。
- 读取范围按线程：owner 只在 owner 私聊线程读取 `all`，在群里也只读本群（群线程历史对群里所有人可见，读进来的别处记录会被后来的人间接看到）；其他人读本会话。线程键按来源决定：owner 的所有账号私聊为 `owner`，群为 `group:<id>`，其他私聊为 `private:<qq>`；Codex 与 pi 一致。
- ReplyStore 的 Outbox 行键为 `<threadKey>:<callKey>`，持久化正文、图片及文件状态：pi 用稳定的 `toolCallId`，codex 用 MCP 请求的 `_meta.callId`，崩溃重放取回同一行。不限每回合条数，所有出站消息（含出错提示等系统消息，不含 owner 告警）在 bridge 统一过发送规则（`src/qq/send-rules.ts`：每会话每分钟 6 条拒绝、每会话每小时 60 条熔断该会话 60 分钟、全局每分钟 30 条熔断全部 10 分钟，数值在面板设置页可改；计数与熔断存于 qq-bridge.sqlite 的 send_log / send_breakers，熔断时私聊通知 owner 一次）；系统消息（键 `<threadKey>:sys:<uuid>`）被拒只记告警；同目标的相同正文哈希复用已发或不确定行，不确定结果不向模型报工具错误；群里用户回合第一条发往本群的消息 @ 本轮发送者，定时与唤醒回合不 @。图片、文件沿用 media/attach.ts 的来源与大小校验，副本保存在 `images/<会话键>/outbox/<uuid>/`，回合结束时清理一小时前且已发完的副本。
- 正文 sent 后逐个上传文件，分别持久化 `pending → sending → sent|uncertain`；sending/uncertain 永不重发。每条成功消息立即写一条上下文机器人行，可按 message_id 引用。
- 回合结束不结算、不兜底：最终回答只记录 final_answer 留存；出错提示（failed / lost / undeliverable，同一会话 10 分钟内最多一条）由 TurnMonitor 作为系统消息发出，回合结束后补传未完成的附件。v3 票据时代的 handle → lateImages → settle 检查点、#late 迟到图片与 #fallback 兜底已随派发器与本地生图移除；迁移来的旧 Outbox 行保留系统消息标记。

### 5.7 模型凭据
- `CODEX_PROVIDER=magpie|openai` 默认 magpie；`CODEX_MAGPIE_URL` 默认 `http://host.docker.internal:3425/v1`。runner 对目录查询及 app-server 进程注入 `CODEX_MAGPIE_KEY`，主进程注册脱敏，key 不落盘；magpie 不依赖容器 ChatGPT 凭据，直连仍保留原有 OAuth 行为。默认模型为 `codex/gpt-6.1-sol`，上下文、设置校验与面板均按完整目录 slug 精确匹配，离线缓存也不跨前缀匹配。Codex 0.163 的短名会落到默认模型元数据，丢失目录窗口与能力。无效 `codexModel` 保留原值并告警，新回合使用有效的 `CODEX_MODEL`，环境默认也无效则用内置默认；目录不可用时保留配置值。
- pi 与摘要模型默认 provider `deepseek`、model `deepseek-flash`（pi-ai 内置 deepseek provider，OpenAI-completions 兼容接口 `https://api.deepseek.com`，支持工具调用）。密钥读环境变量 `DEEPSEEK_API_KEY`；`.env` 中写作 `DEEPSEEK_APIKEY` 也可，启动时映射为标准名，缺少密钥则启动失败。deepseek-flash 支持的思考档位为 off/low/high/max，`AGENT_THINKING_LEVEL` 不受支持时就近调整（如 medium → high）并记一条 warn 日志。
- `openai-codex` provider 仍可选（`AGENT_MODEL_PROVIDER=openai-codex`），凭据来自 `/data/codex/auth.json`（仅在 codex 也直连时共用同一份，由 `scripts/init-auth.ps1` 从宿主机复制一次）。实现方须查明 pi-ai `auth/oauth/openai-codex` 期望的 credential 字段（access/refresh/account_id/expires）并做映射；pi-ai 自行刷新时**写回**同一文件以保持与 codex 一致，若两者刷新策略冲突须在报告中指出。
- 可通过 `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID` / 对应 API Key 环境变量切换到 `openai` / `anthropic` 等 API-Key provider。
- 日/周摘要等辅助任务用小/便宜模型即可。

### 5.8 pi 项目指引与 system 消息

pi 的提示词按顺序由三部分组成：`DATA_DIR/prompts/agent.md`（默认 `/data/prompts/agent.md`）、`WORKSPACE_DIR/AGENTS.md`（默认 `/workspace/AGENTS.md`）、`DATA_DIR/pi-work/<key>/AGENTS.md`（默认 `/data/pi-work/<key>/AGENTS.md`，key 中冒号换成下划线）。`agent.md` 保持独立的 `cs-pi` section；后两者以 `project-context` section 排在其后，两段均为 `tag: false`，由 pi-durable 合成为最前面的一条 system 消息。codex 的 AGENTS.md 则以 user 角色注入。

`ProjectContextLoader` 只显式检查运维目录和当前 `input.env.cwd`，不向上遍历，不读取 `DATA_DIR/AGENTS.md` 或 `pi-work/AGENTS.md`。cwd 必须是 `DATA_DIR/pi-work` 的直接子目录；缺失时只读取运维层，非法值忽略并只告警一次。同一目录按 `AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD` 选择第一个普通文件，重复目录只处理一次。

主进程通过 Node fs 读取，不经 `PiExecutionEnv`。符号链接及目录不作为文件读取；超过 128 KiB、不可读或非法 UTF-8 的文件跳过并按文件变化去重告警；UTF-8 BOM 去除，空白正文省略。每次渲染检查 `mtimeMs:size`，戳未变时复用文件与渲染字符串；戳变化但渲染文本相同时也保留缓存字符串，避免重复生成 `pi.system` 条目。没有有效文件时 section 返回 `undefined`。

## 6. 环境变量（`.env.example`）

```
NAPCAT_HTTP_URL=http://napcat:3000          # 默认 Compose 内 NapCat；回退宿主机时改 host.docker.internal
NAPCAT_WS_URL=ws://napcat:3001
NAPCAT_TOKEN=
QQ_ALLOW_USERS=10000001          # 逗号分隔或 *
QQ_ALLOW_GROUPS=200000001          # 逗号分隔
QQ_GROUP_MENTIONS=true
CODEX_PROVIDER=magpie
CODEX_MAGPIE_URL=http://host.docker.internal:3425/v1
CODEX_MAGPIE_KEY=
CODEX_MODEL=codex/gpt-6.1-sol
CODEX_REASONING_EFFORT=high        # 缺省值；面板可改（含 auto），每轮快照经 turn/start 的 effort 传入
AGENT_MODEL_PROVIDER=deepseek
AGENT_MODEL_ID=deepseek-flash
DEEPSEEK_API_KEY=                  # 也可写作 DEEPSEEK_APIKEY
DATA_DIR=/data
WORKSPACE_DIR=/workspace
LOG_LEVEL=info
```

## 7. Docker

- 基础镜像 `node:24-bookworm-slim`；Dockerfile 以 `# syntax=docker/dockerfile:1` 开头，需要 BuildKit（apt 层挂缓存 `--mount=type=cache`）。
- 多阶段：builder 编译 TS → runtime 仅带 `dist/` 与生产依赖。runtime 层按变动频率从低到高：apt 基础包（`python3 ca-certificates git tini bubblewrap`）→ `@playwright/mcp` 与 Chromium 系统依赖（失败重试）→ 固定版本 `@openai/codex@0.164.0-alpha.8`（装完以 `codex --version` 校验，最多重试 5 次）→ 应用文件。
- `docker-compose.yml`：两个服务 `cs-agent` 与 `napcat`，均 `restart: unless-stopped`。cs-agent 保留 `extra_hosts: ["host.docker.internal:host-gateway"]` 访问宿主机 magpie（及回退时的宿主机 NapCat），卷 `./data:/data`、`./workspace:/workspace`，`env_file: .env`，非 root 用户运行；用普通 `depends_on: [napcat]` 控制顺序，不等待 `service_healthy`，登录前通过现有 WS 重连等待。
- NapCat 固定镜像 `mlikiowa/napcat-docker@sha256:f611790ecffa23c3c182017d5cf68179dc24612403608cd835ad13d79642f1bd`（2026-10-19 index digest），`NAPCAT_UID/GID=1000`、固定 MAC `02:42:ac:11:00:02`，仅发布 `127.0.0.1:6099:6099`。`NAPCAT_WEBUI_TOKEN` 初始化 WebUI 口令，`QQ_BOT_ACCOUNT` 可选传给 `ACCOUNT`；不设 `MODE`。
- NapCat 卷 `./napcat/config:/app/napcat/config` 与 `./napcat/qq:/app/.config/QQ` 持久化配置和登录态，整个目录忽略入库。宿主机脚本 `scripts/napcat-config.ps1` 从 `.env` 幂等播种通用及可选账号配置；token 相同不动，变化时先备份再仅改受管 token。OneBot 逻辑、图片 CDN 下载和附件 base64 传输不变，无需共享媒体卷。
- 健康检查：cs-agent 的 `GET /healthz` 返回 WS 连接状态与 codex 自检结果（Compose 内监听 `0.0.0.0:8787`，仅发布宿主机 `127.0.0.1:8787`；本地直接运行仍默认回环）。NapCat 每 30 秒用 curl 检查 `http://127.0.0.1:6099/`，超时 5 秒、重试 5 次、启动宽限 60 秒，只代表 WebUI HTTP 就绪，不代表 QQ 已登录。

## 8. 宿主机前置条件（写入 docs/DEPLOY.md）

1. NapCat 默认作为 Compose 服务运行（`napcat:3000/3001` + token，首次按 DEPLOY「NapCat 容器」播种配置并扫码）；也可回退到宿主机 NapCat（`host.docker.internal:3000/3001`）。迁移时 `NAPCAT_TOKEN` 沿用宿主机 `onebot11_<QQ号>.json` 中 `agent-http` 条目的 token。
2. 默认先配置宿主机 magpie 的局域网共享、cs-agent gateway key 和模型范围（见 DEPLOY「codex 经 magpie」）；仅 `CODEX_PROVIDER=openai` 时运行 `scripts/init-auth.ps1` 把 `~/.codex/auth.json` 复制到 `./data/codex/auth.json`；或在容器内执行 `codex login --device-auth`。
3. `docker compose up -d --build`；查看 `docker compose logs -f`。

## 9. 测试要求

- **qq/**：用本地假 OneBot 服务器（`ws` + `node:http`）测试：授权规则、@ 检测、去重、重连、Outbox 幂等（sent / uncertain / 并发锁）、发送规则与熔断、群回复段格式、图片校验。
- **agent/**：Inbox 投递与恢复（含以 `奶龙:` 开头的消息照常投递）；ThreadHost 开轮 / 插话 / 排队、跨会话并行与并发上限、重启恢复；codex 后端经假 app-server、pi 后端经 faux provider；send_message 绑定、Outbox 幂等与出错提示；后端选择与会话后端切换。
- `docker build` 必须成功；`docker compose config` 校验通过。
- 不向真实群发测试消息。

## 10. 实现阶段确认的偏离与补充（2026-10-18）

> 本节及 10.1–10.4 是各阶段的实现记录。已被[常驻 agent 设计](DESIGN-resident-agent.md)取代或已删除的部分只作历史：每轮一个 `codex exec [resume]`（`-c` 覆盖、`codex-last.txt`、单轮超时）、owner / shared 双线程、派发器 / TicketDoc / `cs.agent` 检查点与 FIFO 重试、兜底回复与 `#fallback`、`cs.pi.request` 与 pi 每回合工具配额、生图前缀路由、ComfyUI（comfy-mcp、loopback 转发、Qwen 工作流、`/data/workflows`）、`image_gen` MCP、迟到图片 `lateImages` / `#late` 与 `obs-events.jsonl`。当前结构见 §3 与 §5。

上下文启动回填在面板服务前完成：codex 与轮换安全阀共用 rollout 发现逻辑，倒读末尾至多 2 MiB，以 `task_complete` 计回合、取此前最近 `token_count.info.last_token_usage` 和该记录时间；尾部截断只恢复可见回合数并保留既有更大计数；pi 按监听快照边界分页读取 harness 历史，恢复 assistant 输入及缓存、回合数与压缩消息时间，监听接续新提交；异常保留原记录，按后端记录汇总，重置后复查映射而不恢复归档。

agent 延迟收图：image_gen 在提交前原子写入 pending-jobs.json 意图，收到 prompt_id 立即更新，完整收取后标 done；lateImages 接管所有非 done 条目，按原前缀对账，绝不重新 submit。每个 call 目录的 image-files.json 保存预期文件名和 downloaded 状态；HTTP 逐张临时写入后 rename，恢复只下载缺失文件；MCP fetch_outputs 写入按 prompt_id 隔离的隐藏暂存目录，完整返回后才逐张原子发布。只有所有预期文件验证通过才完成任务。清单使用 lstat、64 KiB/8 任务上限和严格字段校验，坏清单重命名为 .bad-<时间戳>，正文保留并附上附件失败说明。未确认远端终态的参考图保留，不因票据回复或收取超时而提前覆盖。

`cs.agent` 新增 `handle → lateImages → settle` 检查点；逐任务按保存的参数复用 collect/reconcile，unknown 按前缀对账、不重新提交，超时用与 cs.image 相同的延期策略（IMAGE_COLLECT_EXTENSIONS 默认 2）。TicketDoc 保存期限、延期次数、对账步骤和最终结果；结果先落盘、清单后删除，恢复不重复收取已完成任务。晚到图片由 #late 单独发送，收取失败提示也放入这条消息，参考图保留到最终收取结束。

生图 v2 审查后的执行边界：

| 阶段 | 持久化与约束 |
|---|---|
| 入站接纳 | 同步 SQLite 事务保存去重、pending 票据与附件 URL/file id；下载不阻塞接纳 |
| 附件准备 | 每 scope 单 worker，全局默认 2；发送者在途上限 2，票据默认 60 秒（含排队）；终态 ok/skipped/failed 后才派发，同 scope 保序 |
| 下载网络 | HTTP(S)、全部 DNS 地址校验、固定 IP 连接；手动最多 3 次重定向，每跳及 get_image 刷新地址重验 |
| 图片与目录 | 10 MiB 流上限；不解码解析尺寸，4096 边长/20 MP，拒绝动画 GIF/WebP；mkdir 前后校验 realpath，恢复前 lstat |
| 启动恢复 | Dispatcher 排队时等待 bridge.prepareIncoming，用持久化元数据补齐 pending 附件，跨 scope 独立准备 |
| 生图等待 | 1mp/2mp/2k 基础 120/240/600 秒乘数量，受 COMFY_TIMEOUT_SEC 截断；超时保存 running/deadline/extensions，durable sleep 后最多额外收取 2 次 |
| 远端参考图 | 上传前写 TicketDoc 清单；独立 MCP 使用 remote-uploads.json；最终收取后同名透明 PNG 覆盖，失败保留清单供恢复重做，history/queue 文件名残留 |
| 参数与测试 | 别名只查对象自身键；两个 stdio 测试共用每次构建的 globalSetup |

以上约束优先于本节早期实现记录；完整下载策略、环境变量及残留说明见 [DEPLOY.md](DEPLOY.md)。

| 项 | 实际做法 | 原因 |
|---|---|---|
| codex 可编辑系统提示（§8.6、§8.12） | `agent/codex/prompt.ts` 的 `CodexPromptStore` 现读 `${DATA_DIR}/prompts/codex.md`；缺失时只播种一次。全局 AGENTS.md = 通用保密／会话隔离说明 + 两个换行 + 自定义行为指引；启动、保存与每轮 preparePrompt 均原子生成。保存串行化，使用 mtimeMs:size 的 SHA-256 摘要校验 revision，限制 64 KB、拒绝空白，并通过注入的 obs 脱敏判定拒绝覆盖含秘密的文件。subscribe 提供 target=codex、revision 和字节数，main 把 store 传给面板 | 行为指引可编辑；按会话权限生成的受管规则另写入会话域 AGENTS.md。runner 每轮新建 exec/resume 子进程，面板保存或磁盘编辑 codex.md 从下一次调用生效，无需重启；保存保留 UTF-8 BOM 与换行风格 |
| 上下文占用（§8.5） | `agent/context-usage.ts` 导出设计契约 `ContextUsage` 与 `ContextUsageStore`；按 `backend:key` 原子持久化、250 ms 防抖、启动重载，提供 all/get/subscribe/reset。codex 从 JSONL 输入用量采集，启动仅一次目录查询，按 `models[].slug` 匹配并取 `context_window`（gpt-6.1-sol=500000），失败回退 `CODEX_CONTEXT_WINDOW`（默认 400000）并记录 source。pi 从 `watchEvents` 的已提交 assistant 条目取 input + cacheRead + cacheWrite，窗口取 pi-ai 模型定义；已提交 `CompactionEntry` 更新成功压缩的观测时间，重置/轮换归零。main 将存储交给面板，逐更新发 `context_usage` trace，healthz 暴露数组 | pi-durable 1.3.0 `README.md` 的 Compaction 段、`dist/harness/types.d.ts` 的 `CompactionPolicy` 明确：`reserve = contextWindow - reserveTokens`；`background = contextWindow - reserveTokens - backgroundTokens`（后台提前量相对于阻塞位置，0 禁用后台）。deepseek-flash 窗口 1000000，默认阈值 950848 / 983616；`dist/harness/generation.js` 以 `tokens > threshold` 判定。按用户确认采用实际公式；输入占用不累计输出或压缩摘要花费 |
| ComfyUI 访问 | 容器内 `loopback-proxy.ts` 把 `127.0.0.1:8188` 转发到 `COMFYUI_URL`，comfy-mcp 指向 loopback | comfy-cli 1.22 拒绝从非 loopback 主机读取 `/object_info`（SSRF 防护） |
| 生图工作流 | 默认 `COMFY_WORKFLOW_FILE=/app/workflows/qwen-image-2.1-turbo-api.json` + `COMFY_PROMPT_NODE=4`，mcp 走 `run_workflow`，http 直接 `POST /prompt`；程序写入提示词并随机化 seed | 宿主机 ComfyUI 没有 SD1.5 checkpoint，只有 Qwen Image 2.1 Turbo，comfy-mcp 默认 `generate_image` 模板校验失败 |
| codex resume | `codex exec resume` 无 `-C/-s`；cwd 由 spawn 决定，沙箱用 `-c sandbox_mode=…` | CLI 0.160/0.163 的参数限制 |
| 每会话工具纪律 | 代码层 `claimBusinessCall` 守卫：第二次业务工具调用直接报错并提示调用 `reply_qq`；`reply_qq` 失败返回带 terminate 的错误；会话结束而票据仍 pending 时派发器补发一条兜底回复 | 不依赖模型完全遵守系统提示 |
| 会话 | `harness.createConversation({ownership:{kind:"ownerless"}, init})`，`init` 同一提交内写入 `cs.ticket` 文档与 `cs.dispatch` 索引；启动时 `Dispatcher.recover()` 按索引重提交（requestId=ticket 去重）；自动 compaction 关闭 | 单消息会话无需压缩 |
| 凭据 | pi-ai openai-codex 凭据 `{type:"oauth", access, refresh, expires, accountId}` ← Codex `auth.json` 的 `tokens.*`；刷新后按 Codex 格式写回同一文件 | 仅 codex 直连且 agent 选择 openai-codex 时共用一份 |
| 默认意图模型 | `deepseek/deepseek-flash`（DEEPSEEK_API_KEY 或别名 DEEPSEEK_APIKEY）；`openai-codex/gpt-6-luna` 仍可选 | 意图识别任务简单，改用 DeepSeek API key，不占 ChatGPT 额度 |
| codex 模型与推理强度 | 默认 `codex/gpt-6.1-sol`；`ask_codex.reasoning_effort` 由意图模型按请求选 `low…max`，以 `-c model_reasoning_effort=…` 逐轮覆盖 | 简单问题不必用高推理强度，复杂任务按需提高 |
| 统一上下文消息库（设计 v2 §2.1/§2.4） | `src/context/store.ts`：`/data/qq-messages.sqlite`（WAL），`messages` / `summaries` + trigram FTS5（触发器同步）；2 字中文词用 `LIKE` 回退全表扫描，≥3 字走 trigram 索引；所有读取带 `Access` 过滤；`format.ts` 为意图层与 MCP 共用的唯一格式化器（非今天的行加 `MM-DD`，MCP 输出加 `#message_id`） | 设计稿 §2；trigram 对 <3 字的 MATCH 无结果 |
| QQBridge 入库事件 | `types.ts` 新增 `raw`（允许群全部消息 + 允许用户私聊，先于 `message`）与 `recall`（`group_recall` / `friend_recall`）事件；监听器异常转为 `error` 事件不影响触发 | 消息库需要不触发的群消息 |
| 机器人回复行 | 派发器 admit 时 `recordPending`（`处理中`），终态后按 `TicketDoc.imagePrompt` / `codexEffort` / `replyText` / `replyImages` 调 `completeReply`；兜底、uncertain 或业务工具失败记 `失败`；QQ 回复的 message_id 替换占位 id | 意图层与 codex 看到同一行 `[我] → …` |
| 衰老任务 | `src/context/aging.ts`：每日本地 `HISTORY_SUMMARY_HOUR` 点；`models.completeSimple` 直调意图模型生成日摘要；已结束自然周折叠为周摘要（仅 1 天时直接复用）；`meta.aging_last_run` 早于 24h 时启动补跑；原始消息只在所在时段被日/周摘要覆盖后才按 `HISTORY_RAW_DAYS` 清理，未覆盖的兜底保留 `HISTORY_RAW_HARD_MAX_DAYS`（90）天 | 设计稿 §2.2；"满 7 天"实现为"自然周结束" |
| qq_context MCP | `src/mcp/qq-context.ts`（低层 `Server` + stdio），只读连接；范围只来自 `QQ_ACCESS`，缺失/非法时所有工具返回错误文本 | 设计稿 §2.3 |
| ask_codex 注入 | 每轮 `-c mcp_servers.qq_context.env.QQ_ACCESS="…"`（owner（含群聊）→`all`、其他群→本群、其他私聊→本人）；头部改为 §3.2 的 `[来源]` / `[引用]` 两行；`TZ` 加入 codex 子进程环境白名单 | 设计稿 §3.2 |
| codex 双线程 | `owner`（owner 私聊，即访问范围 all）与 `shared`（所有群与其他私聊）两条线程，记录在 `/data/codex-threads.json`（原子写，读-改-写串行化）；每键一条互斥队列，两键可并行；旧 `codex-session.json` 在新文件缺失时迁移到 `owner` 并改名 `.migrated`；healthz `codex.threads: {owner, shared}` | 用户 2026-10-18 决定（评审 R1）：owner 的长任务不阻塞群聊，群聊上下文不进入 owner 线程 |
| codex 线程安全阀 | 每条线程 resume 前检查 rollout 文件大小与线程年龄（记录含 `created_at`，旧记录用 `updated_at`），超限新建该线程并记 `codex thread rotated`（带 `key`） | 设计稿 §3.1 |
| 受管 config.toml | entrypoint 写入 `web_search`、`[tools.web_search]`、`[mcp_servers.qq_context]`（env `DATA_DIR`、`QQ_CONTEXT_MAX_CHARS`）与可选 `[mcp_servers.browser]`；枚举/路径值经 `toml_enum` / `toml_path` 校验 | 设计稿 §3.4、§4.4 |
| 容器内浏览器 | 镜像全局安装 `@playwright/mcp@0.0.83` + Chromium（`/opt/pw-browsers`，`--with-deps`）；codex 以 `--headless --isolated --browser chromium --blocked-origins <宿主机/内网阻止列表>` 启动，显式 `--sandbox` 开启 Chromium 沙箱（需 compose 的 seccomp-codex.json profile；`PLAYWRIGHT_NO_SANDBOX=1` 关闭）；`enabled_tools` 白名单 22 个工具，排除 `browser_run_code_unsafe`（vm 逃逸可读 auth.json、可 goto file:）、`browser_file_upload`、`browser_drop`；`file:` 靠 playwright-mcp 自带拦截 + Chromium（`--blocked-origins` 表达不了 file:） | egolite 不可容器化（设计稿 §4.4）；浏览器 MCP 不受 codex 沙箱约束，阻止列表不拦重定向/DNS 指向内网（DEPLOY 残余风险） |
| codex 命令沙箱 | 受管 config.toml 写 `[sandbox_workspace_write] network_access`（`CODEX_SANDBOX_NETWORK`，默认 true）与 `writable_roots`（`CODEX_WRITABLE_ROOTS`，默认 `/workspace,/data/prompts`，逐项规范化 `//`、`/.`、末尾 `/` 后再比较，拒绝 `/`、`/data` 及其上级、`/data/codex*`、`/data/images*`、`/data/tickets*`、`*.sqlite`、含 `..`）；业务回合的命名权限 `filesystem` 与 `writable_roots` 按会话同步覆盖，owner 仅 `/workspace/owner` 与 `/data/prompts`，非 owner 仅本会话目录，read-only 没有可写根；`/data/workflows` 不再默认可写，受管 AGENTS.md 不再介绍它（2026-10 起 entrypoint 也不再播种 `/data/workflows`，本地生图已移除） | 用户 2026-10-18 决定：命令需联网；2026-10-19 起收窄 codex 写权限；compose 自定义 seccomp profile（docker/seccomp-codex.json）才能运行 bwrap |
| codex 命令禁读 | 入口脚本每次启动重写 `/etc/codex/requirements.toml` 的 `[permissions.filesystem] deny_read`（`/data/codex/auth.json`、`sessions`、`history.jsonl`、`log`、`shell_snapshots`、`memories`、`/data/codex/*.sqlite*`、`/data/*.sqlite*`、`/data/images`、`/data/tickets`、`/data/codex-session.json*`、`/data/codex-threads.json`）；镜像内 `/etc/codex` 归 node；写入失败则拒绝启动 | 评审 R2：沙箱原本可读凭据与数据库。codex 0.163 只认系统级 requirements（`$CODEX_HOME/requirements.toml` 无效，`default_permissions` 与 `sandbox_mode` 互斥）；不能禁读整个 CODEX_HOME（arg0 辅助程序在 `tmp/`）。实测见 DEPLOY §7 |
| AGENTS.md 位置与版本 | `$CODEX_HOME/AGENTS.md` 承载可编辑的全局行为指引；`/workspace/<key>/AGENTS.md` 是受管文件，首行 `<!-- cs-agent-managed-workspace-agents v1 -->`，随后声明“由 cs-agent 每轮生成，改动会被覆盖。”。runner 每轮按实际会话权限渲染规则，拼入父工作区运维指引；文件缺失或全文不同时原子写入，相同不触碰 mtime。父目录 `/workspace/AGENTS.md` 保留给运维维护，不再生成占位说明；旧占位/V1/V2 识别逻辑已删除 | codex 0.163 实验表明 resume 不重新注入修改后的 developer_instructions，却会重新注入变化的 AGENTS.md；现已移除 developer_instructions 参数，全局与会话域文件均以 user 角色进入上下文。模型改写会话域文件后，下一轮恢复受管内容；访问控制仍由沙箱执行。详见 [设计稿 §8.12](DESIGN-codex-context.md#812-受管规则下发路径) |
| 新增环境变量 | `COMFY_MODE`、`COMFY_MCP_BIN`、`COMFY_BIN`、`COMFY_CHECKPOINT`、`COMFY_WORKFLOW_FILE`、`COMFY_PROMPT_NODE`、`COMFY_LOOPBACK_PORT`（`COMFY_*` 已于 2026-10 移除）、`CODEX_BIN`、`CODEX_SANDBOX`、`AGENT_THINKING_LEVEL`、`AGENT_CONCURRENCY`、`HEALTH_PORT`、`HEALTH_HOST`；设计 v2 第 1 组：`QQ_OWNER`、`HISTORY_RAW_DAYS`、`HISTORY_RAW_HARD_MAX_DAYS`、`HISTORY_SUMMARY_DAYS`、`HISTORY_SUMMARY_HOUR`、`QQ_CONTEXT_MAX_CHARS`、`CODEX_WEB_SEARCH`、`CODEX_WEB_SEARCH_CONTEXT`、`CODEX_ROLLOUT_MAX_MB`、`CODEX_THREAD_MAX_DAYS`、`CODEX_BROWSER` | 见 `.env.example` |

### 10.1 v3（设计稿 §4.1–4.4、§4.7，第 2 组）

| 项 | 实际做法 | 原因 |
|---|---|---|
| 分流 | `router.ts` 规则分流，取代意图模型；输入是 bridge 计算的 `InboundMessage.route_text`（`policy.ts` 跳过开头真实的 at / reply 段后渲染；`text` 不变，供历史使用），路由器只去首尾空白再逐字匹配前缀，用户亲手输入的 `[at]` 字样不做特殊处理。票据表 `source_route_text` 列保存它供崩溃对账；旧行 / v2 票据文档没有时才按旧规则去掉渲染出的占位（`legacyRouteText`） | 设计稿 §4.1；评审 R10：文本占位与用户输入无法区分 |
| durable 任务 | `tasks.ts`：`defineTask` 定义 `cs.image`（submit → collect → reply；旧任务停在 `generate` 时按 submit 处理）与 `cs.agent`（handle → lateImages → settle），经扩展的 `tasks` 注册；派发器轮到某票据时 `tx.createTask(…, {ownership:{kind:"conversation"}, conversationId})`，任务 id 记入 DispatchDoc，`harness.waitForTask` 等待 | 设计稿 §4.2 / §4.3 |
| 检查点 | 每阶段把结果（`imageJob` / `imageResult` / `codexTurn` / `agentResult` / `replyDraft` / `replyText`）写进 TicketDoc，并在同一 `runtime.commit` 里返回下一阶段的检查点；新任务（上一个任务失败后重跑）也先读 TicketDoc 跳过已完成阶段；进程关闭时阶段抛出而不提交 | 崩溃不重复生图 / 不重复发送 |
| 生图提交与收取 | 提交前保存 `submitIntent={attempt,filenamePrefix}`，SaveImage 使用 `cs-<ticket前12位hex>-<attempt>`；HTTP 与 MCP 的自定义 `run_workflow` 均修改图，默认 `generate_image` 不支持前缀时改走可控图。提交后保存 `imageJob` 并进入 collect。缺失 prompt_id 或 unknown 时统一经 HTTP 查 `/history`、`/queue` 认领任务，否则按前缀探测 `/view` 的 `_00001_.png` 至 count（默认 1、最多 4）；`imageReconciliation` 记录每步，明确无输出才以新 attempt 重交，总上限 2 次。查询失败不重交；有效本地图片仍可复用 | 评审 F1 / F2：覆盖提交响应丢失与历史被清理的窗口 |
| codex 回合幂等 | `-o` 固定写 `${DATA_DIR}/tickets/<ticket>/codex-last.txt`；取得线程锁、复查 signal 后，通过 `onAcquired` 在 spawn 前持久化 `codexTurn={outFile,attempts}`，排队不计次数。已有输出直接复用；有标记无输出最多再问一次。reply 与派发终态对账共用幂等 `cleanupTicketWorkdir`，覆盖 sent / sending / uncertain / failed / given-up，图片目录不动 | 评审 R1、F5 / F6：避免排队耗尽次数与崩溃遗留目录 |
| reply 阶段 | 发送前就失败（票据仍 pending）时任务内退避重试（≤3 次，次数在检查点）；sending/uncertain 一律不重发，任务以 failed 结束；任务失败且票据仍 pending → 派发器发兜底回复 | 沿用票据幂等 |
| 副作用前检查 | `blockedReason()` 首先检查 runtime.signal，再检查派发条目与票据；任务将 signal 传入 QQBridge.reply。bridge 在 `get_login_info` 前及 `markSending` 前检查取消，此前取消保留 pending；标记 sending 成功后不再取消实际发送，失败仍记 uncertain | 评审 R3、F4：避免已取消任务开始副作用 |
| 顺序 | 派发器每个 scope 一条 promise 链（FIFO），轮到时再占全局并发槽位（`AGENT_CONCURRENCY`）。票据占据 scope 队首直到终态 `sent` / `uncertain` / `failed`：任务失败且兜底在发送前失败时退避（`retryDelayMs`，默认 5 s × 次数）后在队首重试，attempts 每次落盘；超过 `MAX_ATTEMPTS`（3）→ giveUp（同一队列与槽位）：标记 `givenUp` → `harness.abortTask` 并等待终态 → 兜底；兜底仍发不出 → 条目标记 `state: "failed"` 保留在索引（重启跳过、对账不当孤儿），记 `ticket failed: fallback could not be sent`，继续下一条 | 设计稿 §4.7；评审 R3 / R4 / R5 |
| 恢复排序 | 唯一排序键是 bridge admit 时的票据 `seq`（票据表 rowid，与 `created_at` 同事务分配，`ReplyTicketRecord.seq`）；DispatchDoc 条目记 `ticketSeq`（旧条目从票据表补取）；`recover()` 把索引条目与孤儿票据（`listPendingTickets(limit, afterSeq)` 分页取尽）按 seq 合并排序后依次入队；pi-durable 一开启调度就会继续上次的活任务（绕过 FIFO），所以 recover 先给它们打中止标记，轮到该票据时等其以 aborted 结束再新建任务。启动时先 `recover()` 再 `harness.resume()` | 评审 R6 / R7 |
| 空原文孤儿票据 | 持久化 `fallbackOnly` 派发条目，跳过模型任务但沿用 scope FIFO、退避、次数上限与终态清理；兜底在 bridge 恢复前保持队首，failed 条目重启不再运行 | 评审 F3：兜底同样遵守终态 FIFO |
| v2 遗留 | 无 `taskId` 的旧索引条目：先 `conversation.abort()` 中止旧模型会话，再按原文重新分流建任务 | 升级时在途消息 |
| 后端 | `backends/types.ts`（`AgentBackend`，结果可带 `images`）、`select.ts`（`AGENT_BACKEND` / `AGENT_BACKEND_OVERRIDES`，`PiBackendStub` 抛 `pi backend not implemented yet (group 3)`）、`codex.ts`（适配 `CodexRunner`） | 设计稿 §4.3 / §4.4 |
| codex 适配 | `-c model_reasoning_effort`（`CODEX_REASONING_EFFORT`）、`-c mcp_servers.qq_context.env.QQ_ACCESS`、`-c mcp_servers.image_gen.env.IMAGE_TICKET_DIR="<DATA_DIR>/images/<ticket>"`（路径只允许 `[A-Za-z0-9._/-]`、不含 `..`）；回合前记下票据目录已有文件，回合后取新增的普通文件（不跟随软链接），按 QQBridge 口径校验大小与魔数，按 mtime 取前 4 张 | 设计稿 §4.4 |
| image_gen MCP | `src/mcp/image-gen.ts`（stdio，低层 `Server`）：工具 `generate_image(prompt)`，非只读注解；输出目录只来自 `IMAGE_TICKET_DIR`，必须是 `${DATA_DIR}/images/` 的直接子目录（realpath 复核），否则拒绝；每进程（每回合）≤4 次；每次调用输出到新的子目录 `call-<n>/`（n = 已有 call 目录数 + 1，同名输出不会互相覆盖），返回可传给 send_message 的图片绝对路径；后端配置用 `loadConfig` 解析透传的 `COMFY_*`，mcp 模式下非 loopback 的 `COMFYUI_URL` 改走 `http://127.0.0.1:COMFY_LOOPBACK_PORT`（agent 主进程的 loopback 转发；codex 及其 MCP 子进程与主进程同一网络命名空间） | 复用同一生图实现 |
| 受管 config.toml | 新增 `[mcp_servers.image_gen]`（`tool_timeout_sec = COMFY_TIMEOUT_SEC + 30`，审批模式同 `CODEX_MCP_APPROVAL_MODE`）与 `[mcp_servers.image_gen.env]`（`DATA_DIR` + 已设置的 `COMFY_MODE`/`COMFYUI_URL`/`COMFY_MCP_BIN`/`COMFY_BIN`/`COMFY_CHECKPOINT`/`COMFY_WORKFLOW_FILE`/`COMFY_PROMPT_NODE`/`COMFY_TIMEOUT_SEC`/`COMFY_LOOPBACK_PORT`/`LOG_LEVEL`；含引号、反斜杠或非可打印字符的值告警跳过） | codex 给 MCP 子进程的环境只有少量默认变量 + env 表 |
| AGENTS.md | 受管规则要求 send_message；普通最终输出不送达；用户可编辑提示词不承担这条规则 | 设计稿 §4.4 |
| 结算 | `tasks.ts` 的 settle 保留 agentResult，记录 final_answer；零发送时按结果兜底，文本超限由 send_message 返回错误，不截断 | 定时任务设计 §3.4 |
| 模型工具退场 | 删除 `generate_image` / `ask_codex` / `reply_qq` 工具、`claimBusinessCall` 与意图系统提示；`CodexRunner` 移至 `src/agent/codex-runner.ts`，生图实现移至 `src/agent/image-gen.ts` | 设计稿 §7 第 2 组 |
| 消息库机器人行 | 生图保留 `recordPending/completeReply`；agent 每条 sent Outbox 消息独立写入真实 message_id 与正文，包含 #late / #fallback | 统一发送设计 §3.6 |
| 新增环境变量 | `IMAGE_PREFIXES`（2026-10 已移除）、`AGENT_BACKEND`、`AGENT_BACKEND_OVERRIDES` | 见 `.env.example` |

已实测：容器内 `codex exec`（OAuth + workspace-write 沙箱）正常；容器内经 mcp 与 http 两条路径均生成真实 PNG（约 10–17 s）。

### 10.2 生图工具 v2（2026-10-18，设计 §4.9；2026-10 已移除）

本节覆盖前文旧版静态工作流与 generate_image(prompt) 的说明。统一契约位于 `image-options.ts`；前缀路径与 image_gen MCP 共用校验、尺寸表及 `qwen-workflow.ts` 生成器。pi 后端的执行与恢复机制见 10.3；两条工具路径共用参数契约及图片恢复逻辑。

| 环节 | 实现 |
|---|---|
| 参数 | prompt、negative_prompt、aspect（7 种）、size（1mp/2mp/2k）、count（1–4）、seed、reference_images（≤3）、transparent；2mp 为 1mp 每边乘 √2 后取最近的 32 倍数 |
| 分流 | 提示词之前空格分隔的比例、横/竖/方、2k/2mp、x2–x4、透明，任意顺序；未知词起的后续文本保留，重复选项后者覆盖；附件自动作参考图 |
| 生成 | UNETLoader → 可选 QwenImage21Cache → KSampler；CLIPLoader → TextEncodeQwenImage21 正/负 conditioning → KSampler；t2i 使用 EmptyLatentImage；固定 8 步、CFG 1、euler/simple |
| 编辑 | LoadImage.IMAGE → 编码器 images.image_N；VAELoader → 编码器 vae；编码器 LATENT（slot 2）→ KSampler.latent_image；count>1 经 RepeatLatentBatch；保持首图比例，resolution 为目标面积平方根取 32 倍数 |
| 透明（偏离原 §4.9） | 使用 2.1 原生 RGBA；KSampler → VAEDecode（2.1 VAE）→ SaveImageAdvanced(png/8-bit/sRGB)，不使用 EmptyQwenImageLayeredLatentImage。layered latent 为 5D/16 通道，2.1 是 4D/64 通道，不能混用。依用户后续决定实施，本机无需额外模型 |
| 自检 | 启动及透明提交检查 VAELoader 模型列表；缺失时明确返回“透明输出未启用：缺少 <文件名>”，不下载依赖 |
| 后端 | submit(ImageOptions, submission)、collect、reconcile；mcp 总是 run_workflow(临时 API JSON)，http POST /prompt；自定义 COMFY_WORKFLOW_FILE 优先，仅 patch prompt/seed 与对账前缀；默认改为空 |
| 超时与恢复 | 1mp/2mp/2k 分别为 120/240/600 秒 × count，受 COMFY_TIMEOUT_SEC 上限约束，默认额外收取 2 次；submitIntent 保存 options/count/参考图子目录，恢复依次查 history、queue、预计文件名（含透明 SaveImageAdvanced 命名） |
| 参考图入站 | QQBridge 授权、触发后同步 admit 去重与 pending 附件元数据，再分 scope 有界下载；url 优先、get_image 刷新，同一 SSRF 策略；≤3×10 MiB、头部尺寸与动画检查；终态后才派发，重启恢复 pending 下载 |
| 参考图访问 | codex 每轮以 -c 注入 IMAGE_REFS（没图时清空），MCP 仅允许清单中且 realpath 位于本票据 incoming 的文件；incoming 对命令沙箱 deny_read，禁止加入 writable_roots |
| 上传 | HTTP /upload/image 使用每票据 subfolder；comfy-mcp upload_file 需同时支持 paths 与 subfolder，否则回退同 URL 的 HTTP。本机版本只有 paths/overwrite，故走回退；不把本机绝对路径直接传 LoadImage |
| 清理与提示词 | 每日衰老任务清理超过 7 天的 incoming 票据目录；AGENTS.md 模板 v5、agent.md：文字加引号和位置字体、编辑说明改什么保留什么、不用 SD 咒语、参数范围 |

官方接线依据（本机 `comfyui_workflow_templates_json/templates/`）：

- `image_qwen_image_2_1_turbo_image_edit.json`：编码器节点 474（行 1251），ComfySwitchNode 468（行 1130）默认 false；link 724（行 2227）把 474 slot 2 接 false，link 913（行 2339）把开关输出接采样 latent；link 710（行 2443）输入参考图，link 720（行 2451）输入 VAE。因此生成器直接使用编码器 LATENT，不能在编辑时换回 EmptyLatentImage。官方最新模板的高级采样器等价连接在此按用户要求落实为固定 KSampler 参数。
- `image_qwen_image_2_1_background_removal.json`：VAEDecode 457（行 1011），SaveImageAdvanced 461（行 197）；link 651（行 1539）采样输出接 decode，649（行 1523）接 VAE，650（行 1531）接子图输出，顶层 672（行 390）接保存。使用同一 2.1 VAE，无单独 RGBA VAE。
- `image_qwen_image_layered.json` 的 EmptyQwenImageLayeredLatentImage 128（行 2731）搭配另一 UNET/VAE 及 LatentCut/LatentCutToBatch；本实现不混用它。

真实冒烟共 5 次，未访问真实 Codex、模型代理或 QQ；未改运行容器。透明 PNG 的 alpha 实测有 0–255。2K 冷启动超过一次 240 秒收取预算，重跑收取同一 prompt_id 成功，未重新提交；16 GiB 显存下不能承诺 2K 总在预算内完成。验收记录 `IMAGE-GEN-V2-ACCEPTANCE.md` 已随本地生图一并删除。

### 10.3 pi-durable 执行后端（第 3 组）

`backends/pi.ts` 实现 AgentBackend；main 注册真实 pi 后端，select 保留 scope 覆盖选择。旧 PiBackendStub 导出只供旧测试兼容，不参与生产选择。dispatch 和票据任务沿用既有分流、FIFO、后处理与回复路径。

| 机制 | 实现 |
|---|---|
| 长期会话 | 独立 Harness.open + SQLite `pi.sqlite`，createConversation(ownerless) 按 owner 私聊的 `owner` 或其他会话的 `scope` 创建独立会话，conversation(id) 复用；模型与 thinkingLevel 由主进程配置。独立 harness 因 pi-durable 1.3.0 的 compaction 为 harness 级设置，票据 harness 原配置关闭压缩 |
| 映射 | 会话 init 事务写 session 文档 cs.pi.threads；`pi-threads.json` 以临时文件 rename 原子更新，启动从 SQLite 重建。创建/映射短锁，回合按键各自互斥，不同键并行且受派发器 AGENT_CONCURRENCY 限制；旧 owner 保留，旧 shared 永久停用并仅记录一次日志；healthz 仅返回 count/keys |
| 请求 | 复用 buildCodexPrompt 的来源、引用清洗；submit 前写 cs.pi.request（ticket/access/参考图/content/deadline/calls），工具经 api.snapshot 读取，参数无访问范围入口 |
| 幂等与恢复 | submit({requestId: ticket, whenBusy: reject})，Submission.wait 与 AssistantEntry 读取对应最终回答；旧票据重投不返回别的回合答案。重启先为恢复回合设置锁和原期限，避免新请求覆盖身份 |
| 超时 | 默认 300 秒，用户取消/超时调用 Conversation.abort(background:true)；进程关闭先标记 pi 停止接收，再关票据 harness（只停止等待），最后关闭 pi harness 保留可恢复任务。恢复遇到既有 unanswered/aborted 回执时，先将 `<ticket>#r1` 写入 TicketDoc，再用原输入补提一次；同线程排队取消不提交请求 |
| 扩展 | defineExtension(`cs-pi`) 注册六种工具、section 与 ToolTask.beforeTool hook；hook 在同事务内按 taskId 去重计数，搜索/抓页各 4、历史合计 4、生图 2 |
| 历史工具 | 直接复用 callQQContextTool → ContextStore + format，绑定 access；qq_recent/qq_search 总量≤2500 字，qq_message≤1500 字 |
| 联网工具 | DeepSeek Search/Fetch 固定 API 地址；仅 429 一次退避，响应体有上限，错误不回显服务端正文；公开 URL 校验复用 forbiddenAddress，DNS 全量地址检查。服务端重定向与 DNS 固定不在本机控制范围 |
| 图片 | 共用 ImageOptions、ImageBackend.submit/collect、参考图验证与图片收集，目录限于 ticket/call-n；提交前在 cs.pi.request.imageJobs 保存 ordinal/filenamePrefix/options，并写 pending-jobs.json 镜像；提交后立即保存 prompt_id。unsafe 工具中断后模型重试优先收取/对账未完成任务，不另占次数、不重复 submit；仅远端终态后覆盖参考图 |
| 压缩 | enabled=true；reserve/background 使用库默认 16384/32768 或 PI_COMPACTION_*；keepRecentTokens 保持默认 20000，无轮换 |
| 提示词 | 新文件缺失播种；agent.md 按 mtime/size 缓存读取，section 每次模型请求重建；既有文件不覆盖 |
| 健康与验证 | healthz 增加 pi.threads；faux provider 覆盖工具链、权限、上限、图片回复、隔离/串行、SQLite 恢复与重复提交、热加载、超时和自动压缩；不调用真实模型、QQ、ComfyUI 或 DeepSeek |

### 10.4 观测系统（第 4 组）

观测路径不参与业务事务和检查点决策。trace.event / trace.span 写入独立 WAL 数据库 observability.sqlite；写入或订阅者失败只增加 dropped_events，不重试业务操作。主进程独占观测库写入（曾有的 image_gen MCP 旁路事件文件 obs-events.jsonl 已随本地生图移除）。事件按 ticket 关联，scope 从接收事件继承；所有 detail 经共享脱敏器后才进入 SQLite 或日志环形缓冲。

| 层 | 实际事件与职责 |
|---|---|
| dispatcher | received、admitted、routed、dispatched、recovered；按业务结果和 bridge 票据终态发 reply_sent / failed / fallback，terminal=true 标记终态；错误回复成功发出仍按业务失败统计 |
| durable tasks | phase:submit / generate / collect / handle / reply，late_images、phase:settle；每次执行或恢复记录开始与结束，checkpoint 含尝试次数 |
| backend | backend:codex / pi 包围整个 handle；Codex model_turn 含线程键、effort、回复摘要与 model_ms，onAcquired 前等待另记 thread_wait_ms；backend span 保留总耗时。mcp_tool_call 映射 tool:&lt;name&gt;；内置 command_execution / web_search 每轮合计≤100 条，只提取命令/查询前 200 字、退出码、耗时，不存原始 JSONL |
| pi hook | GenerationTask 的每次请求与响应记录 model_turn 和 usage；ToolTask 的 before/after 记录 tool:&lt;name&gt;；CompactionTask 记录 compaction 尝试 |
| 图片 | 公共接口包装记录 image:submit / image:collect；对账归 image:collect(operation=reconcile)，查询步骤发 recovered，包含 prompt_id；三条生图入口共用（2026-10 随本地生图移除） |
| 回复 | send_message 含序号、message_id、图片数、文件状态与 already_sent；final_answer 留存最终回答，no_send_fallback 标记成功但零发送的回合 |

Metrics 每 60 秒从持久化游标读取新事件，内存聚合调用数、成功率、p50/p95 后写 metrics 表；同步采样会话宿主队列和全局槽位、bridge.status()、Codex rollout、pi 会话数、衰老结果。每日按 OBS_RETENTION_DAYS 清理普通事件与指标；管理事件仅按 OBS_ADMIN_RETENTION_DAYS（默认 365 天）清理。DeepSeek 用量由 pi、衰老共用 usageFields / usageCost 转换，包含 cacheRead 与 cacheWrite；只使用真实 usage，不发额外模型请求。

HTTP 面板由原健康服务器承载：/healthz 分支无需认证，仅返回白名单健康 JSON（连接状态、degraded、检查布尔值和线程信息），其余路由交给 obs/http.ts。SSR 中文 HTML + 内联 CSS / JS、SSE，无 CDN、框架或新增依赖；上下文直接调用共享工具格式化逻辑。图片经过段校验、真实路径约束、链接拒绝与位图魔数检查；所有渲染字符串先 redactText 再 HTML 转义并设置 CSP。强制口令覆盖所有面板出口，Compose 只向宿主机 loopback 发布端口。

存储或 schema / Metrics 初始化失败时切换无操作模式，/healthz 与总览显示 degraded: true，观测故障不影响业务。普通票据默认 500 条（OBS_TICKET_EVENT_CAP，8–10000）、256 KiB detail；为三种终态和丢弃摘要预留槽位及字节，重复进度保留首末及计数，事件按 after=id&limit 游标读取。口令从 OBS_TOKEN 或 DATA_DIR/obs-token 获取，缺失时原子生成 32 字节随机 base64url、0600 文件；口令文件加入 Codex deny_read，子进程环境不传 OBS_TOKEN。口令获取失败则关闭面板访问。

告警默认关闭；pi 工具执行边界及 Codex observer 从异常和 pi-durable diagnostics[].message 提取 {kind, provider, status}，kind 为 auth / network / rate_limit / other。鉴权告警只匹配结构化 auth，开启时通过 bridge 的公共 send 接口私聊 owner，所有原因共用 30 分钟限频。未改动 QQBridge 内部实现。观测保留期不删除业务 failed 索引，避免重新认领尚为 pending 的旧票据。部署、指标语义及限制见 DEPLOY.md 的“观测面板”。

## 11. 非目标（本期不做）

成员独立工作区、通用主动推送、可写的 Web 管理界面和多用户面板权限。只读观测面板、可选运维告警、上下文摘要与隔离会话已在前述分组实现。


## 12. 运行时设置的每轮快照

面板设置（后端、Codex 模型与推理强度、pi 模型与思考档位）在**每轮开始时**冻结一次（`src/agent/turn-settings.ts`）：在第一个 await 之前单次读取 `SettingsStore.current()`；档位为 `auto` 时按本轮输入文本路由（定时与唤醒回合同样适用）。codex 经 `turn/start` 的 `model` / `effort` 生效，pi 按快照选择模型与思考档位；排队期间改设置不影响已开的回合。会话仍由旧后端服务（切换被推迟）时，本轮强制沿用旧后端。

## 13. 管理审计预算

`ObsStore` 按阶段（settings_changed、prompt_changed、thread_reset）或以 `@` 开头的事件键识别管理事件：直接追加脱敏后的行，跳过普通事件数量、累计字节预算及进度合并。普通预算聚合也排除管理行。`purge(days, now)` 接口保持不变，内部以构造时传入的管理保留天数分别清理；默认 365 天，普通事件与指标默认 30 天。主进程将已校验的 OBS_ADMIN_RETENTION_DAYS 传入，不改变面板查询契约。


## 14. 重置事务与归档镜像

pi 的 session 文档 `cs.pi.threads.archive` 保存最新 200 条归档和旧 JSONL 导入标记；`resetThread` 持有会话键锁与映射锁，在一次 `harness.commit` 内清空映射并追加归档。数据库提交后逐个原子重写 JSON/JSONL 镜像；镜像失败记录告警，下次启动或映射操作恢复。启动只在未迁移时读取旧 JSONL，迁移后始终从数据库重建。

Codex 归档与映射文件的读改写共用文件串行队列；归档原子替换仅保留最新 200 条，再清空线程键。pi 与 Codex 共用 `thread-archive.ts` 的 JSONL 原子写出与轮换逻辑。Codex 两个文件仍不是跨文件事务；本次原子事务保证针对 pi SQLite。

pi-durable 1.3.0 缺少公开删除会话 API（Harness / Storage / StorageWrite），故每日衰老尚不删除退休会话；PI_ARCHIVE_RETENTION_DAYS 默认 90 为目标保留天数，当前仅校验配置。归档行上限不等于底层会话存储上限，详见 DEPLOY.md。
