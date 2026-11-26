# 管理台：请求统计、网页续聊与运维面板

## 1. 入口与日常视图

打开 `/admin/`，使用 `ADMIN_TOKEN` 登录（口令仅存于当前标签页 `sessionStorage`，通过 `Authorization: Bearer` 发送，401 自动清除）。左侧固定 224px 导航栏分为「用量总览」「执行链路」「会话对话」与管理分区「模型与接入」「会话与记忆」「任务与事件」「权限与运维」「工作区」，底部集成 Worker / QQ / 模型健康状态卡与登出操作。数据列表统一按每页 10 条分页。

- **用量总览**按北京时间和所选会话、模型、用途、状态聚合。点击「查看匹配的执行链路」会携带当前筛选条件。
- **执行链路**集中查询模型请求和工具明细。用量总览、聊天回合、子会话和上下文中的工具结果都能定位到对应执行。请求详情按需读取模型输入、输出和上下文差异。
- **会话对话与拓扑**：
  - 全视口三栏工作台布局：左侧按父会话嵌套展示子 agent（默认最近 24 小时内最多 5 个已结束任务，运行中与当前选中始终可见），中间为主对话舞台与底部输入区。
  - 主会话按回合显示最新的步骤进度，点击「查看本轮执行链路」可打开该回合所属的执行。
  - 右侧可折叠观测抽屉由顶部「拓扑」「上下文」按钮按需展开：支持查看最近 24 小时 Agent 拓扑（全局最多 5 个最近活跃子 agent + 对应父会话与近期活跃主 agent，点击或键盘 Enter/空格切换对话）及按当前 agent 隔离的上下文监控趋势（详见 [架构与运行设计](ARCHITECTURE.md#5-上下文监控与-codemode-执行组)）。
  - 选择已有 QQ 会话继续同一 Harness root，显示最近 100 条 QQ / 网页消息，以及当前会话已入模的 Agent 收件、子任务报告、外部事件、Agent 发件回执和模型回答。未入模的内部收件只显示状态；模型回答不等于 QQ 投递，Agent 入箱不等于已读。仅展示白名单正文，不展开宿主说明、推理和工具原始参数；网页发言使用稳定 UUID（断网重试不重复入队），回复留在网页。点击子 agent 在中间同一对话区只读查看，保留父会话草稿。
- **管理分区**（进入对应视图才按需加载，不增加后台轮询；各分区通过顶部二级 Sub-tabs 切换，低频大表单默认折叠收起）：
  - **模型与接入**：分「模型与账号」「MCP 与设备」「QQ 响应与状态」子标签，涵盖模型切换（CAS）、Codex 原生多账号授权/目录刷新/登出、动态 MCP 服务、反向节点连接状态、Cloudflare 账户授权及 QQ 响应设置。
  - **会话与记忆**：分「长期记忆」「活跃会话」「技能目录」「全局人格」子标签，涵盖长期记忆筛选/编辑/冲突确认/画像复核/整理回滚与主人主线程行为规则管理（详见 [记忆系统](MEMORY-SYSTEM.md)）、会话状态与停止/重置、技能 `SKILL.md` 编辑与全局人格设定。
  - **任务与事件**：分「定时任务」「事件来源」「审计事件」子标签，涵盖定时任务管理、GitHub App 与 Gmail 事件来源配置、审计事件（每页 10 条）。
  - **权限与运维**：分「跨会话授权」「Cua 设备分配」「MCP 群授权与审批」「Skill 群授权与状态」「额度与保留期」「告警与发送账本」子标签，涵盖跨目标发送/定时授权、Cua 设备按会话分配、群 MCP 授权与置顶逐次审批、受控 Skill 动作授权与加密登录态查看/清空、运维设置 CAS、告警与 QQ 发送账本/核对。
  - **工作区**：双栏展示持久文件列表与鉴权下载、停止容器（保留 R2 快照）、检查与选择合并子任务工作区。

聊天与管理只读视图来自执行对象主动推送到 `RequestsDO` 的最终一致展示副本；首次同步前返回 `503 view_pending`，不会因查询唤醒执行 DO。管理写命令仍直接进入业务 DO 并尽力同步展示结果。

## 2. 管理 HTTP 接口

所有数据与写接口均要求 `Authorization: Bearer <ADMIN_TOKEN>`（静态壳 `/admin/`、`/admin/app.js`、下载助手与公开回调页除外）：

| 分组 | 接口 | 用途 |
| --- | --- | --- |
| 总览与健康 | `GET /admin/health`、`GET /admin/overview`、`GET /admin/logs`、`POST /admin/diagnostics/model-egress` | 组件健康（含 MCP 调用健康度、沙箱容器遥测与未关闭告警计数）、全局总览、环形诊断日志、手动出口诊断 |
| 用量与上下文 | `GET /admin/usage`、`GET /admin/requests/:id`、`GET /admin/requests/:id/context[/:part]`、`GET /admin/context-timeline`、`GET /admin/tools/:id`、`GET /admin/agent-topology` | 用量趋势、单次请求与工具详情、上下文分析与拓扑 |
| 执行链路 | `GET /admin/agent-traces`、`GET /admin/agent-traces/{detail,analysis,runtime}` | 按会话、子 agent、回合或请求筛选，查看调用树、分组分析与 Pi 原生阶段 |
| 会话与续聊 | `GET/POST /admin/threads/:key/chat`、`GET /admin/threads/:key/history`、`GET /admin/threads/:key/progress`、`POST /admin/threads/:key/{stop,compact,reset}`、`GET /admin/threads/:key/subagents`、`GET /admin/subagents/:id/history`、`POST /admin/subagents/:id/cancel` | 网页续聊（202 入队）、历史分页、聊天步骤进度与子任务控制 |
| 模型与设置 | `GET/PUT /admin/settings`、`GET/PUT /admin/model`、`POST /admin/model/oauth/codex/{start,select,catalog,logout}`、`POST /admin/send-rules/release` | 运行设置 CAS、主模型与子任务默认模型选择、Codex 多账号管理与解封发送规则 |
| 记忆与规则 | `GET /admin/memory[/list\|/:id\|/candidates\|/jobs\|/proposals]`、`POST /admin/memory/{entries,consolidate,proposals}`、`PUT/DELETE /admin/memory/:id`、`PUT /admin/memory/profile`、`/admin/memory/rules/*` | 记忆增删改查、冲突/画像/整理/回滚与主人主线程行为规则 |
| 技能、权限与运维 | `GET/PUT/DELETE /admin/skills[/:name]`、`POST /admin/skills/:name/{enable,disable,publish}`、`GET /admin/skill-runtime`、`PUT /admin/skill-runtime/:name/grants`、`POST /admin/skill-runtime/:name/state/clear`、`GET/PUT /admin/persona`、`GET/POST /admin/grants[/revoke]`、`GET/PUT /admin/ops-settings`、`GET /admin/alerts`、`GET /admin/deliveries[/:id]`、`POST /admin/deliveries/:id/reconcile` | 技能、受控 Skill 群授权与加密状态管理、人设、授权、运维设置、告警与发送账本核对 |
| 定时与事件 | `GET /admin/schedules`、`POST /admin/schedules/:id/{pause,resume,delete,run-now}`、`GET /admin/event-sources`、`POST /admin/event-sources/:source/{pause,resume}`、`PUT /admin/event-sources/:source/settings`、`/admin/github/*` | 定时任务与 GitHub / Gmail 事件来源管理 |
| MCP 与设备 | `/admin/mcp/servers*`、`POST /admin/mcp/manage`、`POST /admin/mcp/:server/{login-link,logout,refresh}`、`GET/PUT /admin/mcp/access`、`GET /admin/mcp/approvals`、`POST /admin/mcp/approvals/:id/{approve,reject}` | 动态 MCP 服务、节点在线状态、群授权与逐次审批 |
| Cua 设备目录与分配 | `GET /admin/cua/devices`、`GET/PUT /admin/cua/grants` | 查看桥接状态、设备卡片与已有分配。写入时携带 `expectedRevision` 并替换指定会话的设备列表；删除已有分配时可离线操作。 |
| Cloudflare 账户管理 | `GET /admin/cloudflare`、`POST /admin/cloudflare/start`、`POST /admin/cloudflare/complete`、`GET /admin/cloudflare/changes`、`POST /admin/cloudflare/changes/:id/{approve,reject}` | 查看账户授权及审核模型提交的资源变更 |
| 工作区与媒体 | `GET /admin/threads/:thread/workspace[/file\|/children/:childId]`、`POST /admin/threads/:thread/workspace/{reset-runtime,merge}`、`POST /admin/threads/:key/sandbox/reset`、`POST/GET /media/assets/:scope[/:id]` | 持久工作区只读/下载/合并、容器停止与私有媒体 |

## 3. 代码结构与构建

| 模块 | 职责 |
| --- | --- |
| `workers/browser/index.html`、`admin.css` | 静态页面壳与样式（构建时由 esbuild 压缩 CSS 并内联生成 `ADMIN_PAGE_HTML`） |
| `workers/browser/*.ts` | 浏览器交互、状态管理与 TypeBox 响应契约校验（经 `tsconfig.browser.json` 严格检查，由 `scripts/build-admin.mjs` 打包为 `ADMIN_APP_JS`） |
| `workers/src/admin/routes.ts` 及子路由 | 统一 Bearer 鉴权、参数校验与 DO RPC 转发 |
| `workers/src/requests/` | `capture.ts`（模型请求采集）、`snapshot.ts`（白名单投影与脱敏）、`trace.ts`（Harness 回合与工具钩子）、`do.ts`（SQLite 索引、聚合、保留清理与展示副本） |

## 4. 统计口径、保留与轮询边界

- **Token 与性能口径**：输入 token = `input + cacheRead + cacheWrite`；输出已含 reasoning 不重复叠加（同时单独汇总 `reasoningTokens` 与估算 `costUsd`）。请求采集记录首字延迟 `ttftMs` 与 DO alarm 调度等待 `alarmWaitMs`，回合落定记录端到端耗时 `TurnTiming`（排队等待、投递延迟与总耗时）。缓存命中率仅对已上报 `cacheRead` 的请求按输入加权；未上报显示 `—`。字符数仅反映归一化快照文本，不伪造逐段 token。
- **保留与脱敏**：请求元数据与回合耗时保留 30 天 / 最多 20,000 条；环形诊断日志 `ops_logs` 保留最近 1,000 条（最长 30 天），仅记录安全错误类型、分类码与脱敏字段，不保存自由异常正文（Worker `tail()` 终态入口需额外绑定独立 Tail Consumer Worker 方可接收平台级调用终态）；请求快照与工具正文共用 7 天 / 32 MiB 预算（单次输入 ≤ 96,000 字，输出 ≤ 24,000 字，工具参数/结果各 ≤ 12,000 字）。含凭据模式整块脱敏，图片二进制、隐藏推理与认证选项不进入快照。已结束子任务保留 14 天。
- **Agent 自观测与模型自管理（仅主人权限）**：仅在 `owner` 命名空间注册顶层只读工具 `ops_health`、Code Mode `runtime-ops` 命名空间（`tools.ops_usage`、`tools.ops_requests`、`tools.ops_inspect`、`tools.ops_logs`，SQL 层默认过滤当前回合自身请求以避免递归干扰，单次输出限 48 KB，跨会话记录强制仅返回摘要）以及模型管理工具 `model_manage`。在主人会话确证 `owner` 的非 `subagent` 交互消息回合中，主 agent 可通过 `model_manage` 查询可用模型目录（含推理能力标记）、切换自身模型（`target='self'`）或子任务默认模型（`target='subagent'` / `'both'` / `inheritSelf=true` / `subagentId`），也可在 `subagent` 的 `spawn` / `message` / `set_model` 中按实例指定或切换子任务模型（子 agent 自身、子任务汇报回合、群聊对 `model_manage` 的调用、非主人成员与自动事件/定时回合一律隔离或拒绝），变更记入 `model_change` 审计事件。
- **拓扑简介**：父 agent 在 `spawn` 填写 `summary`（建议 15–30 字）；子 agent 在工具调用前写首行 `【进度】...`，最终回答以 `【结果】...` 开头（向父线程汇报时自动剥离前缀），展示限 60 字并脱敏。
- **按需刷新**：对话活跃时每 2.5 秒增量读取，用量页有运行中请求每 5 秒刷新，拓扑有活动时服务端 10 秒缓存刷新，上下文趋势展开后最多每 10 秒随活跃会话刷新；空闲、离页或标签页隐藏时全部停止轮询。
- **网页通道隔离**：网页输入写入 `inbound`（`reply_channel = "web"`、`user_id = "admin:web"`），不进入 QQ `messages`、`outbox` 或自动记忆抽取；同一子任务不允许跨回复入口追加指令。
- **视觉规范**：系统中文无衬线字体、`tabular-nums` 数字、动态内容一律走 `textContent`；桌面 224px 侧栏，窄屏（820px 及以下）顶部横向导航 + 表格横向滚动。

## Agent 执行链路

侧栏「执行链路」按时间、会话、模型、工具、请求 ID 或结果查询。点选执行后，调用树和时间轴共用起点，能看到主 agent、每次派工对应的子回合、报告回合、模型请求和嵌套工具。派工与追问使用宿主实际返回的子任务输入 ID 关联。旧记录保留原回合，历史缺边时可单独查询子回合。

展开「按 agent、模型与首轮 / 续轮分析」可比较调用数、输入输出、耗时、成本和缓存命中率。命中率分母只计有缓存读数的输入，计价与缓存均显示覆盖数。列表摘要按所选窗口汇总，点入执行后可查看整次执行中仍在保留期内的记录。节点支持查看现有的上下文差异、模型输出、工具参数 / 结果与回合耗时。

主、子 Harness 通过 Pi telemetry 记录提交、阶段、恢复、重试、模型调用和事件。节点按需加载运行时数据，已结束的原生 span 每个根会话最多保留 2,048 条、最长 7 天。批量写入失败或超出采集额度时，部分明细可能缺失。原生记录只收白名单元数据。模型计量仍取请求账本，原生 span 不重复计费。

「导出执行链路 · OTLP JSON」会读取整次执行仍在保留期内的所有分页，包含调用树和对应的 Pi 原生阶段。原生 span 保留自己的 trace ID、父子关系、事件与跨 span 链接，通过 span link 关联到执行树中的模型调用或 agent。进行中的节点标记为快照。导出复用 GenAI 的操作、模型、工具与 token 字段，本地回合、首流事件和调度等待等扩展放在 `cs_agent.*` 属性中。消息与工具正文仅在管理台按需读取。[OTLP 规范](https://opentelemetry.io/docs/specs/otlp/)
