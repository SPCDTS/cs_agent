# cs-agent 架构与运行设计

应用统一运行在 Cloudflare Workers，入口、依赖和构建配置集中在 `workers/`（入口 `workers/src/index.ts`）。`runner/` 提供可选的跨平台设备命令行 MCP、独立桌面 MCP 与 Windows 宿主机上的临时 WSB 服务。持久 Hyper-V VM 直接配对设备客户端。

## 1. 请求入口与消息执行

`workers/src/index.ts` 提供 `/healthz`、`/onebot` NapCat 反向 WebSocket、管理台与管理 API、私有媒体下载、MCP OAuth 与定时任务入口。公开 `/healthz` 仅证明 Worker 存活，不访问 DO；运行详情位于鉴权的 `/admin/health`，管理数据和写操作必须携带 Bearer `ADMIN_TOKEN`。Codex 配对入口先校验票据格式，再按实际流字节读取最多 64 KiB JSON，令牌字段最多 16,384 字符，配对票据由 Registry 校验与消费。

1. 独立 NapCat 经 `/onebot` 连接 `BridgeDO`；Bridge 校验身份、触发条件和作用域，记录消息并路由到 `ThreadDO`。
2. 每个会话的 `ThreadDO` 运行 `pi-durable`，组合人设、记忆、技能与工具；模型调用由 `RegistryDO` 中的账号与模型配置决定。
3. QQ 回复经 Bridge 的发送账本与限速规则投递；管理台网页续聊共享相应会话上下文，网页回复留在网页。
4. 子任务在 `SubagentDO` 中运行，定时任务由 `ScheduleDO` 调度，外部事件由 `EventsDO` 处理。

## 2. 身份与权限边界

每轮执行绑定触发时的身份、会话和入口，工具不能通过模型传入的 QQ 号、namespace 或路径取得额外权限。owner 账号来自 `QQ_OWNER`。跨目标发送、群 MCP 授权和写工具审批分别检查。

子任务保存派出时的身份快照，使用能力时仍检查当前授权；不把后来到达的其他人的消息当作派出者授权。群或其他私聊的上下文读取范围以当前线程为准。

## 3. 组件职责

| 组件 | 责任 |
| --- | --- |
| `BridgeDO` | NapCat 连接、聊天目录、发送规则与投递账本（不运行模型；回执未知保持 `unknown` 不盲目重发） |
| `RegistryDO` | 运行设置、运维设置、模型账号、技能、人设、授权与动态 MCP 服务配置（写操作使用 revision CAS） |
| `ThreadDO` | 会话执行、输入准入、会话代次、聊天记录、记忆、规则与工具状态（`thread.ts` + `thread/runtime.ts` + `memory/admin.ts` + `mcp/admin.ts`） |
| `RequestsDO` | 模型请求明细、用量统计、工具执行追踪、上下文监控、拓扑以及各会话/子任务的只读展示副本 |
| `ScheduleDO` / `EventsDO` | 定时任务、外部事件来源（GitHub App / Gmail）与投递状态；每 5 分钟兜底触发，每日 UTC 19:30 执行维护 |
| `SubagentDO` | 子任务独立执行、心跳与结束 14 天后清理 |
| `SandboxDO` + R2 | 按需编码容器（`workers/sandbox/Dockerfile`，`lite` 规格，空闲 3 分钟停止，uid 1000 降权，`bash` 最长 120 秒）与持久工作区版本快照 |
| `CloudflareWorkspaceResourcesDO` | 显式 Cloudflare 工作区资源登记与分配 |

## 4. 执行恢复、查询隔离与模型出站

### 4.1 按需 alarm 与 ModelAlarm 出站约束

QQ、网页、定时任务和事件输入先持久化入队，在同一事务里安排按需 alarm；只有 alarm 调用 `ThreadDO` 的 pump 接纳输入、恢复 Pi 任务并启动模型，`SubagentDO` 同理。恢复时不能把结果不确定的写操作当作未执行重放。

主 agent 与子 agent 共用 `ModelAlarm`：在每次 OpenAI/Codex HTTP 请求由 SDK 准备完成后，安排原执行 DO 的新 alarm；**`ThreadDO.alarm()` 与 `SubagentDO.alarm()` 第一行必须同步调用 `this.modelAlarm.dispatch()`，前面绝不能插入存储读取、配置读取或 RPC 的 `await`**，以隔离入站请求上下文对出站请求的影响。Codex 的 SSE 请求在进入 `ModelAlarm` 前还原 pi-ai 生成的 Zstd 请求体为原始 JSON，并移除压缩标记与旧 `Content-Length`，保留完整上下文、图片、认证、响应流与取消信号，不额外重试模型或工具。

`ThreadDO` 将新输入、模型出站、Pi 恢复时间、记忆抽取、投影同步重试和子 agent 截止时间合并到单个 alarm，选择最早到期项；无待办时删除闹钟。主动出口诊断 `POST /admin/diagnostics/model-egress` 为管理员鉴权的执行操作，不用于面板轮询。

### 4.2 读写分离与增量投影

本方案复用既有 DO 类与绑定，不新增 Queue，也不按模型请求创建 DO：

| 入口或数据 | 负责对象 | 行为 |
| --- | --- | --- |
| QQ、网页发言、定时与事件命令 | `ThreadDO` / `SubagentDO` | 持久化输入，由原对象 alarm 执行 |
| 请求明细、用量、工具追踪、拓扑 | `RequestsDO` (`main`) | 有界采集（元数据 30 天 / 20,000 条；正文 7 天 / 32 MiB，触发器增量维护） |
| 会话管理展示 | `RequestsDO` (`view:thread:<线程>`) | 仅查询本地展示副本，绝不回调执行 DO |
| 子 agent 对话展示 | `RequestsDO` (`view:sub:<父线程>:<子任务>`) | 仅查询本地展示副本，结束 14 天后清理 |

- 执行对象的 SQLite 触发器将白名单展示表的增删改写入本地变更表（与业务同事务提交），不复制凭据、运行任务表、工具恢复状态或完整请求快照。
- 普通写入合并 150ms 内变化、每批最多 100 行推送；展示对象按源变更序号去重，确认后源端删除对应变更。同步失败保留数据并在 5 秒后经原 alarm 重试。
- 首次同步完成前返回 `503 view_pending`；展示副本最终一致，权限判断、CAS 冲突、状态修改与主人主线程行为规则读取仍直接以业务 DO 为准。工作区只读请求直接访问 `SandboxDO`，并经展示副本核对派出关系。

## 5. 上下文监控与 CodeMode 执行组

管理台「会话对话」提供按当前 agent（父会话或单个子 agent）隔离的上下文趋势与明细分析，全部读取 `RequestsDO`，不新增独立采集 RPC、Queue、DO 或后台轮询：

- **上下文组成与前后变化**：统计归一化快照文本的字符长度（区分系统提示、工具定义、历史摘要、用户消息、助手消息、工具结果），在正文截断前计算分类总量与逐项大小；按指纹和出现次数比较同一会话、同一 actor、同一用途的相邻请求。
- **压缩过程**：基于引擎真实的 `pi.compaction` 条目（主/子 agent 在 `beforeRequest` / `beforeCompact` 记录轻量范围选择，不存额外正文），不靠 token 下降推断。
- **CodeMode 执行组**：将一次 CodeMode 调用聚合为执行组，折叠显示内部工具名称、次数、耗时与异常数，展开按父调用 ID 显示调用树，脚本源码与参数/结果按需加载。**内部工具结果不重复计入模型上下文**；主、子 agent 共用同一套工具追踪。
- **查询接口**（全部要求管理员 Bearer）：
  - `GET /admin/context-timeline?thread=...&actor=...`（每页 10 项趋势）
  - `GET /admin/requests/:id?summary=1`（元数据与详情可用性）
  - `GET /admin/requests/:id/context` 与 `GET /admin/requests/:id/context/:part`（组成、相邻差异与按需正文）
  - `GET /admin/tools/:id/execution` 与 `GET /admin/tools/:id`（执行组与单个工具详情）

## 6. 外部服务与构建边界

- **外部连接**：模型和 Gmail 由 Worker 直接请求；MCP 连接远程 HTTPS 服务；CS2 Workshop 与 NapCat 独立运行。原生 coding 工具使用 Cloudflare 容器（`workers/sandbox/Dockerfile`），其他远程环境通过标准 MCP 接入。持久 VM 与个人电脑使用[设备 MCP](DEVICE-MCP.md)，临时 WSB 使用[宿主机 MCP](WINDOWS-MCP.md)。
- **管理台构建**：浏览器逻辑位于 `workers/browser/`（通过 `tsconfig.browser.json` 严格检查，接口响应经 TypeBox schema 校验），静态页面模板与样式位于 `workers/browser/index.html` 与 `workers/browser/admin.css`。`node workers/scripts/build-admin.mjs` 使用 esbuild 生成 `workers/src/admin/app.generated.ts`（导出 `ADMIN_PAGE_HTML` 与 `ADMIN_APP_JS`）及 `workers/src/devices/client.generated.ts`，生成文件不提交 Git。
- **迁移历史**：`workers/wrangler.jsonc` 的 DO migrations 属于线上 schema 历史，即使旧类已删除也必须完整保留。

相关文档：[云端功能与契约](CLOUD-PARITY.md)、[管理台](ADMIN-CONSOLE.md)、[记忆系统](MEMORY-SYSTEM.md)、[GitHub 事件](GITHUB-EVENTS.md)、[部署与验证](DEPLOY.md)。
