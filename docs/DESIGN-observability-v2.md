# 观测面板 v2 设计：Agent → 会话 → 回合，上下文结构分析，记忆可视化

状态：已确认（2026-10-18，用户拍板 §8 三项决策）。调研依据见 `docs/research/observability-viewer-research.md`。本设计一经确认即为约束性文档；实现分组见 §7，验收记录追加到 §9。

## 0. 目标与非目标

目标
- 像 CC Switch 的"会话"视图那样按 **agent → 会话 → 回合** 三级浏览，每个回合展开用户输入、助手文本、每个工具调用的参数与结果、耗时与 token。
- 对任意选中节点（会话当前态或某一回合之前/之后）给出 **上下文结构分析**：窗口里有什么、各类占多少、每条消息占多少，实测与估算分开标注。
- **记忆系统可视化**：聊天记录库的衰老状态、摘要、检索检查器、召回使用记录、图片记忆，并与会话/回合双向链接。

非目标
- 不引入 React / bundler / 第三方平台（Langfuse、Phoenix 等）；保持服务端 HTML + 原生 JS + SSE。
- 不承诺恢复从未落盘的内容（codex 的动态 system/工具 schema、加密 reasoning、已被清理的摘要来源）。
- 不改变 agent 行为；所有新增都是只读视图加少量结构化埋点。

## 1. 信息架构

顶栏：总览 · **Agent** · **记忆** · 票据 · 实时 · 设置（票据/实时/设置保持现状，总览精简为入口与健康卡）。

```
/agents                               两张卡：Codex、Pi（活动会话数、占用条、最近回合）
/agents/:backend/sessions             会话列表：活动 + 归档，真实 ID，筛选 scope/状态/时间
/agents/:backend/sessions/:id         会话页：左侧回合目录，右侧回合流；顶部占用条与"分析上下文"按钮
/agents/:backend/sessions/:id/turns/:turn
                                      回合详情：输入 → 模型请求(可多次) → 工具调用(参数/结果折叠) → 助手文本 → 送达
/agents/:backend/sessions/:id/context?at=<turn|entry>&phase=before|after
                                      上下文结构分析（§4）
/memory                               scope 列表：消息/摘要计数、时间范围、体量、下次整理
/memory/scopes/:scope                 时间线（原文轨 / 日摘要轨 / 周摘要轨）、保留期边界
/memory/summaries/:id                 摘要正文、区间、尚存原文、血缘（有记录时）
/memory/search?scope=&q=              检索检查器：命中 + 工具实际返回文本对照、关键词高亮
/memory/recalls?scope=&session=       召回使用记录（三级证据，§5.3），链到回合
/memory/images?scope=                 已入库图片画廊（依赖另一会话的图片记忆落地后启用）
/memory/archives                      线程归档与 pi 压缩摘要，链到会话
```

回合（turn）定义：一次用户输入到该轮结束；一个回合内可能有多次模型请求与多次工具调用，分别列出。票据（ticket）与回合一一对应时在回合头部显示 QQ 来源与送达状态。

## 2. 统一数据模型（借鉴 CC Switch `types.ts`，MIT 声明保留在 `docs/THIRD-PARTY.md`）

```ts
type SessionRef   = { backend: "codex"|"pi"; id: string; label: string; scope?: string; status: "active"|"archived"; started: number; updated: number; turns: number }
type TurnIndex    = { turn: string; started: number; ended?: number; ticket?: string; preview: string; tools: number; requests: number; usage?: Usage; status: "ok"|"failed"|"running" }
type Block        = { kind: "user"|"assistant"|"thinking"|"tool_call"|"tool_result"|"image"|"event"|"compaction"|"system_change"; ts?: number; callId?: string; text?: string; preview?: string; ref?: ContentRef; meta?: Record<string,unknown> }
type ContentRef   = { session: string; offset: number; length: number; bytes: number }   // 大内容按需读取
type Usage        = { input: number; output: number; cached?: number; reasoning?: number; measured: boolean }
```

事实源与补充源
- **Codex**：rollout JSONL（`/data/codex/sessions/**`）是事实源；`codex-threads.json` 与归档给出 owner/shared 与 scope 对应；ObsStore 补票据、送达、耗时。
- **Pi**：`conv.entries()` 与 `conv.context({at})` 是事实源；`pi-threads.json` 给出 scope 对应；ObsStore 同上。
- ObsStore 永不作为正文来源（有截断与脱敏）。

适配器
- `src/obs/sessions/codex-adapter.ts`：流式扫描 rollout，按字节偏移建索引（`session_index` 表：文件、size、mtime、回合偏移表、usage），增量更新；工具调用按 `call_id` 配对；reasoning 仅显示摘要文本，加密体标"不可用"。
- `src/obs/sessions/pi-adapter.ts`：只用 pi-durable 公开 API；`CompactionEntry` → `compaction` 块，`SystemEntry` → `system_change` 块。
- 两者输出同一 `Block[]`，UI 不区分后端。

## 3. 回合详情页

- 头部：时间、耗时、模型与强度（codex 来自 `turn_context`，pi 来自 `model_turn`）、usage（实测）、QQ 来源与送达状态（有票据时）、"分析此回合前/后的上下文"。
- 正文块：用户输入（含图片占位与引用块）→ 每次模型请求一条分隔（usage、耗时）→ 工具调用卡（名称、服务器、参数 JSON 折叠、结果折叠、耗时、状态；结果超 8 KB 只给预览与"加载全文"）→ 助手文本 → 后处理与送达（relay 前后对照）。
- 所有文本经 `redactText`；JSON 经转义后渲染；图片经现有带鉴权的媒体路由。
- 懒加载：`/api/agents/:backend/sessions/:id/content?offset=&length=`，服务端校验范围并脱敏。
- SSE：活动会话页订阅 `/agents/stream?session=`，新块追加，不整页刷新。

## 4. 上下文结构分析

输出一张"构成表"与一张"逐消息表"，两者都带来源标签。

| 类别 | Codex 来源 | Pi 来源 |
|---|---|---|
| 指令（system / AGENTS.md） | 我们生成的受管段 + codex.md 当前版本（标 **重建**，注明可能与当时不同） | `getCurrentSystemPrompt()`（**已记录**） |
| 工具定义 | 由 MCP 服务器当前工具列表 + 内置工具名估算（**估算**） | `getCurrentTools()`（**已记录**） |
| 历史消息 | rollout 重建后的消息（**已记录**） | `context.messages`（**已记录**） |
| 工具输出 | 同上 | 同上 |
| 压缩摘要 | compaction 记录与 `replacement_history`（**已记录**） | `CompactionEntry`（**已记录**） |
| 其他 / 不可见 | 加密 reasoning、未记录注入（**不可用**，不计 0） | 下一轮 prepare 可能追加（标注） |

token 两条线
- 实测：codex `token_count` 的最近一次 input（cached 已含其中）；pi 最近一次 `usage`。压缩后的旧 usage 标"过期"。
- 估算：`js-tiktoken/lite` + `o200k_base`（MIT，词表随镜像本地加载）对每条消息计数；pi 另给 `estimateMessageTokens` 作对照。差额单独一行"未解释差额"，不摊到任何类别。

Codex 历史重建规则（按 0.163.0 的 `rollout_reconstruction`）：回滚后存活的回合、有效 compaction 检查点与 `replacement_history`、恢复基线之后再重放后续记录；`history.rs` 的规范化与模态过滤按同样顺序实现。实现时以 TS 重写并以真实 rollout 做回归样本（含一次压缩与一次 resume）。可选项：开启 `CODEX_ROLLOUT_TRACE_ROOT` 为新回合保存精确请求负载，分析页优先使用精确负载并标"已记录"。

`phase=before|after`：before = 该回合请求发出前的窗口；after = 该回合结束后的窗口。会话页默认显示"当前态"。

## 5. 记忆可视化

### 5.1 现有数据即可做
- `/memory`、`/memory/scopes/:scope`（vis-timeline 固定版本、预构建 JS/CSS 随镜像分发，不走 CDN，符合 CSP nonce）、`/memory/search`（复用 `ContextStore.search()` 与同一 formatter，显示命中字段、高亮、时间顺序，以及经裁剪后工具实际会返回的文本；不伪造相关性分数）、`/memory/archives`。
- 时间线三条轨：原文、日摘要、周摘要；空白区间标"无现存记录"；显示上次整理、预计下次整理（`aging_last_run` + 配置小时 + 容器 TZ），调度器运行中状态需暴露一个只读标志。

### 5.2 需要新增埋点
- `summary_versions`：不可变摘要版本，记录实际输入的消息/摘要 ID、裁剪信息（输入字符数与保留字符数）、模型与 usage、整理批次 ID。周摘要删除日摘要前先把日摘要内容快照进版本表。→ 支撑 `/memory/summaries/:id` 的血缘。
- `recall_events`：由 `qq-context-server`（codex）与 pi 的历史工具统一写入：backend、session、turn/ticket、call_id、查询参数、返回的消息/摘要 ID 与顺序、裁剪、耗时。→ 支撑 `/memory/recalls` 与回合内"记忆调用"页签。
- 两张表有独立保留期（默认 90 天），放在 `observability.sqlite`。

### 5.3 召回证据三级
检索命中（数据库返回了什么）→ 工具实际返回（裁剪后给模型的文本）→ 进入某次模型请求（在该回合的上下文分析里确实出现）。页面上三级分别着色，不把"工具返回"直接标成"模型采用"。

### 5.4 图片记忆
`/memory/images` 依赖另一会话（分支 `feat/image-recall`，设计 §2.5）落地的 `message_media` 表；本设计只预留路由与卡片，待其合入后由后续分组接入。浏览画廊不触发召回下载。

## 6. 安全与性能约束
- 所有新路由沿用 token cookie + CSRF + CSP nonce + `Referrer-Policy: same-origin`；只读页面无 POST。
- rollout 大文件：流式扫描 + 字节偏移索引缓存；单次响应内容上限 1 MiB；索引重建后台进行并有进度。
- 全部展示内容经脱敏注册表；工具参数中出现的凭据样式一律遮蔽。
- 第三方：CC Switch 类型声明（MIT）、vis-timeline（MIT/Apache-2.0）、js-tiktoken（MIT）；在 `docs/THIRD-PARTY.md` 记录来源、版本与许可证。

## 7. 分组与分工（实现均由子代理完成，主会话验收）

| 组 | 内容 | 执行 | 估计 |
|---|---|---|---|
| O1 | 统一模型、会话索引、Codex/Pi 适配器、`/api/agents/*` 与 SSE、懒加载内容路由 | Codex gpt-6-astra | 5–7 人日 |
| O2 | 三级导航 UI、回合详情页、上下文分析页的视觉与交互（吃 O1 的 API） | Opus（前端） | 3–4 人日 |
| O3 | 上下文分析引擎：Codex 历史重建（含回归样本）、分类与 token 两条线、pi 对照 | Codex gpt-6-astra | 4–6 人日 |
| O4 | 记忆 5.1 页面 + vis-timeline 接入 + 检索检查器 | 后端 astra / 前端 Opus | 4–6 人日 |
| O5 | 记忆埋点 `summary_versions`、`recall_events` + 血缘与召回页 + 三级证据着色 | 后端 astra / 前端 Opus | 5–7 人日 |
| O6 | 图片画廊接入（待 `feat/image-recall` 合入） | 后端 astra / 前端 Opus | 2–3 人日 |

顺序：O1 → O2 与 O3 并行 → O4 → O5 → O6。每组独立评审（Codex astra 对抗评审）、独立部署、§9 记录。旧的 `/context`（聊天记录浏览）并入 `/memory/scopes/:scope`，旧 `/codex`、`/pi` 页并入 `/agents/*`，迁移完成前保留旧路由跳转。

## 8. 已确认的决策（2026-10-18）
1. **开启** codex 官方 trace（`CODEX_ROLLOUT_TRACE_ROOT`），新回合保存精确请求负载，默认保留 14 天；分析页优先使用并标"已记录"。
2. 记忆埋点（`summary_versions`、`recall_events`）保留期默认 **90 天**。
3. O6 图片画廊**等 `feat/image-recall` 合入后再做**（已于 707538a 合入，O6 在 O5 之后接入）。

## 9. 验收记录

### O1：统一会话数据层与只读 API（2026-10-18）

- 已实现统一类型、SQLite `session_index`、Codex 流式增量索引、Pi 公开接口适配、六类只读 JSON/SSE 接口、正文按需读取、票据与送达补充，以及官方 trace 开关和每日保留期清理。接口和调用示例见 [O1 会话观测数据接口](O1-sessions-api.md)，第三方来源见 [许可证记录](THIRD-PARTY.md)。
- Codex/Pi/trace 分工实现后完成只读对抗审查，修复了凭据边界、SSE 首帧与并发消费竞态、关闭竞态、多请求事件顺序、实测用量/终态实时通知、超长票据终态读取与旧正文引用保护。
- 最终完整验证：`npm.cmd run typecheck && npm.cmd test && npm.cmd run build` 全部通过；**55 个测试文件、708 项测试通过，0 失败、0 跳过**，本组新增 77 项测试。包含 50 MiB 流式索引与超 4 MiB 单行回归。
- 验证环境为 Windows、Git Bash、Node **v24.15.0**。原有 entrypoint 临时目录与 Windows 进程树测试需要在沙箱外执行；权限恢复后完整套件通过。未另外验证 Node 22；未改变仓库既有 Node >=24 的 engine 声明。
- 增量检测的边界：使用文件身份与旧首尾 4 KiB 指纹识别追加；同 inode、首尾不变的中段原位改写并增长，在访问受影响正文时由行 SHA256 检出，返回 409 并触发下一轮全量重建。在该访问之前，目录摘要可能仍为旧值。
- 本阶段没有新 UI、上下文分析或记忆分析；未新增运行时依赖，未部署 Docker，未改 `.env`，仓库 `data/` 仅用于只读提取匿名 rollout 样本。`CODEX_ROLLOUT_TRACE_ROOT` 名称依据绑定调研 §3 对 0.163.0 的核验，本地没有 Codex npm 包，未调用真实 Codex 请求验证 trace 产物。

**主会话验收（2026-10-18 13:20Z，镜像 cs-agent:dev 已部署）**：重跑 `npm run typecheck && npm test && npm run build`，55 文件 / 708 项全部通过；容器内 codex 0.163.0 二进制含 `CODEX_ROLLOUT_TRACE_ROOT` 字符串，变量名核实无误，`/data/codex/trace` 已创建。真实数据冒烟：`/api/agents` 报 codex 2 活动 + 1 归档；shared 线程 18 回合、owner 13 回合；最新回合 24 个块，5 次模型请求各带实测 usage（112,890 → 115,947），4 次 exec 工具调用参数与结果按 `call_id` 配对，票据与送达状态（sent / group 范围 / 耗时）正确附加；21,902 字节的 system_change 块按区间懒加载首尾正确，越界 400；未登录 401，POST 405，归档会话订阅 409，SSE 200 且带完整安全头；返回体中无 QQ 号以外的凭据样式。遗留给 O2/O3 的说明：回合级 `usage` 是该回合全部请求的累加，上下文占用应取最后一次 `model_request` 块的 usage。

### O2：Agent → 会话 → 回合页面与上下文分析页（2026-10-18，Opus 实现，主会话验收通过）

- 提交 `844a528`（在 O1 与占用条修复之上变基）。新增 `src/obs/ui/{agents-pages,turn-view,context-view,agents-client}.ts`，顶栏改为设计 §1 的六项（日志/配置从设置页进入），`/codex`、`/pi` 303 到 `/agents/*`，重置线程按钮移到 `/agents` 卡片。页面在服务端内部调用 `/api/agents/*` 路由取数，与浏览器拿到的是同一份脱敏 JSON 与错误码。上下文占用取回合内最后一次 `model_request` 的实测输入，回合累计另列。
- 主会话复跑：typecheck 通过，57 文件 / 734 项全部通过，build 通过；镜像重建部署。容器内无头 Chromium 真实数据冒烟：`/agents`、会话列表、会话页（18 回合目录、最新回合展开、4 张工具卡、实时连接指示"实时更新中"）、回合页、懒加载回合展开后 11 个块、21.4 KB 大块"加载全文"分段读取完成且按钮消失、上下文分析页在 O3 未合入时正确显示"分析引擎暂不可用（HTTP 404）"、`/memory` 占位页、`/codex` 303；无脚本错误，唯一的 404 是浏览器自动请求 favicon。
- 验收中发现、转入后续修补（不阻塞 O2）：(1) codex 把 AGENTS.md 指令与 `<environment_context>` 作为 user 消息写入 rollout，O1 适配器把它们当成了独立回合，应归为 system_change 且不开启回合；(2) `utf8Slice` 在分块边界可能丢一个跨界字符，客户端已绕过，服务端应修正；(3) 启动时 `codex debug models` 偶发拿到离线目录（所有模型 272,000），窗口由 500,000 变成 272,000，应在离线签名时优先读取 `models_cache.json`；(4) 官方 trace 清理只按天数，需加总量上限；(5) 补 favicon 路由。

### O2 后续修补五项（2026-10-18，astra 实现，主会话验收通过）

- 提交 `1dcffde` 指令消息不再分轮（索引版本 2，旧索引启动时重建）、`b640c0c` 分块切片跨界字符归前块、`5329e67` 离线目录签名时读取 `models_cache.json`、`19c538e` trace 总量上限 `CODEX_TRACE_MAX_MB`（默认 512）、`1828b40` favicon。
- 主会话复跑：typecheck、58 文件 / 755 项、build 均通过；部署后真实数据：共享线程回合 18 → 15，AGENTS.md / environment_context 块以 `system_change` 进入下一回合 prelude，首个回合预览为真实用户输入；窗口 500,000 来源 `catalog.context_window`；`/favicon.ico` 200 `image/svg+xml`。
- 部署副作用：重启时有一个票据正在 codex 回合中，启动恢复逻辑记为 interrupted 并自动重试（`will_retry: true`）。后续部署尽量选队列为空时进行。

### O3：上下文结构分析引擎（2026-10-18）

- 已实现 `src/obs/context/` 单一分析入口、六类构成统计与逐消息表；支持 Codex 回滚后存活检查点、replacement_history、resume、中止与孤儿工具规范化，以及 Pi 公开 ContextView、系统/工具折叠和 pi-ai 对照估算。接口、来源标签与限制见 [O3 上下文分析接口](O3-context-api.md)。
- 官方 trace v1 只读读取精确请求、响应和实测用量，支持增量请求链；未知布局、缺失载荷与非法路径回退到 rollout。请求后发生压缩或回滚时不复用旧 trace 窗口，旧实测标为 stale。当前态在选择最后回合前刷新索引；组合 Pi 消息不借用单块正文引用。
- 新增只读 `GET /api/agents/:backend/sessions/:id/context`，沿用鉴权与安全头；400/404 边界、1 MiB 响应裁剪和 ContentRef 懒加载已验证。`src/obs/http.ts` 只增加一处依赖参数传递，保持两参数路由工厂兼容。
- 本地运行时依赖 `js-tiktoken@1.0.21` 和 o200k_base，单条估算上限 2 MiB，角色加约 4 token 开销；Dockerfile 的生产 node_modules 复制路径已核对，未部署镜像。
- 最终完整验证：`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build` 全部通过；**59 个测试文件、758 项测试通过，0 失败、0 跳过**，相对 O1 新增 50 项。Windows / Node v24.15.0；原有 entrypoint 与 Windows 进程树测试在沙箱内受限，沙箱外完整套件通过。
- 与设计的偏差及未验证项：真实只读样本未含 compaction，压缩/resume/中止组合使用按官方字段构造的匿名 fixture；trace 使用固定版本上游 schema 构造 fixture，未用本次真实请求产物复核。缺失动态指令、完整工具 schema、媒体或加密正文仍标不可用；估算存在脱敏、分段和 provider 模板误差，无法替代精确请求计费。
- 未部署 Docker、修改 `.env` 或写入运行数据目录；任务书与 `.o3-research` 不进入提交。

**主会话验收 O3（2026-10-18 14:30Z，已部署）**：在 O2 与五项修补之上变基，合流修正 `1651ffb`（适配器与引擎统一按前缀识别 AGENTS.md 注入、prelude 块可签发引用与懒加载、索引版本 3、O2 测试改为桩适配器下的 503）。复跑 typecheck、62 文件 / 805 项、build 通过（一次 `bad port` 为测试服务器端口抖动，单独复跑两次通过）。真实数据冒烟：共享线程最新回合恰好是部署后第一个带官方 trace 的回合，`before` / `after` 均从 trace 读到精确请求：after 实测输入 134,372（缓存 129,920，来源 `codex.trace.token_usage`），o200k 估算 129,285，未解释差额 +5,087（3.8%）；指令 9 条 14,388、工具定义 9,447、工具输出 38 条 97,784 均标"已记录"；168 条消息中 166 条带懒加载引用，页面展开 21.4 KB 全文正常；窗口 475,000 取自 rollout 的 `model_context_window`。省略 `at` 返回最后回合之后；`phase=x` 400，未知回合 404；浏览器无脚本错误。
- 待后续改进：(1) 分类徽标取类别内最低来源，历史消息里只要有一条加密 reasoning 整个类别就显示"不可用"，应改为"部分不可用"并单列条数；(2) 分析页窗口用 codex 有效窗口 475,000，占用条用目录名义值 500,000，两处口径需统一（建议都显示有效窗口并注明名义值）。

### O4（后端）：记忆只读接口（2026-10-18，astra 实现，主会话验收通过）

- 提交 `4613c49`（整理器只读 running 状态）、`3ec6e7a`（`/api/memory`、`/api/memory/scopes/:scope[/messages]`、`/api/memory/summaries/:id`、`/api/memory/search`、`/api/memory/archives`；契约见 `docs/O4-memory-api.md`）、`6c11d8f`（消息分页复合游标 `before_id`/`after_id`，修正原契约"同秒即 400"的缺陷）。
- 主会话复跑：typecheck、63 文件 / 897 项、build 通过；部署后真实库冒烟：2 个 scope、89 条消息、1 条日摘要；时间线按小时桶、保留期边界与空白区标注正确；摘要页给出区间内尚存原文 32 条；`limit=3` 连续翻 17 页拿全 50 条无重复；检索对照路径与模型工具一致（"Codex" 命中 2 条，tool_text 同步给出）；未知 scope 404、空 q 400、POST 405。
- 排查记录：Windows Git Bash 下 curl `--data-urlencode` 传中文会被控制台编码转坏导致"0 命中"，改传百分号编码 URL 即正常；这是测试工具问题，不是接口缺陷。
- 前端页面（Opus）在 `feat/obs-v2-memory` 上进行中，合入后单独记录。

### O4（前端）：记忆可视化页面（2026-10-18，Opus 实现，主会话验收通过）

- 提交 `5edbbfd`（vis-timeline 8.5.4 随镜像本地分发：`/assets/vendor/` 固定两项白名单，启动读入内存；CSP `style-src` 加 `'self'` 以允许同源样式表；standalone 包内无 nonce 的 styleInject 被精确停用）、`d6e75f7`（`/memory` 总览与整理卡、`/memory/scopes/:scope` 三轨时间线 + 空白背景 + 保留边界 + 范围控件 + 消息列表、`/memory/summaries/:id`、`/memory/search` 命中与工具实际返回对照、`/memory/archives`；`/memory/recalls`、`/memory/images` 为 O5/O6 占位）、`67865dd`（翻页带 `before_id` 决胜游标）、`9254c36`（测试）、主会话 `c4e9d10`（去掉我误导加入的"少于 3 字不命中"提示：`ContextStore.search` 走 LIKE，两字词可命中，真实库"苹果"命中 5 条）。
- 主会话复跑：typecheck、66 文件 / 917 项、build 通过；部署后容器内无头 Chromium 真实数据冒烟：总览 2 个 scope 与整理状态（上次 02:59、下次 03:00、补跑正常、保留 30/90/180 天）；私聊时间线 6 个条目、3 条轨、2 段空白背景，点击原文桶后消息列表切到该桶 32 条并提示已到最早；日摘要页正常；检索"苹果图"3 条命中、6 处高亮、右侧工具实际返回逐字对照；归档页、旧 `/context` 页顶栏"记忆"高亮；vendor JS/CSS 200，路径穿越 404；浏览器零错误。
- 已知口径：`purged` 空白是按保留策略推算，不是删除证明；`lineage` 待 O5。

### O5（后端）：记忆埋点、摘要血缘与召回事件（2026-10-19，astra 实现，主会话验收通过）

- 提交 `32fb8e8`→变基后 4 个提交（表与容错写入器、aging 血缘、pi / Codex MCP 召回埋点、只读 API 与三级证据契约，契约见 `docs/O5-recall-api.md`）。`summary_versions`、`recall_events` 建在 `observability.sqlite`，`OBS_MEMORY_RETENTION_DAYS` 默认 90，接入每日 purge。codex 每轮注入 `QQ_TICKET / QQ_BACKEND / QQ_SESSION`，MCP 子进程用独立 WAL 连接写入，写失败只告警不影响工具返回。
- 主会话复跑：typecheck、70 文件 / 972 项、build 通过；主分支期间被另一会话推进（`d3d84b4` 仅文档），O5 变基后 ff 合并、部署。真实验证：容器内以 stdio 启动 `dist/mcp/qq-context.js`（env 带 ticket/session）调用 qq_search，`/api/memory/recalls` 立即出现该事件（返回 3 条、dropped 0、117 字），`/api/memory/recalls/:id` 给出命中预览与三级证据（此冒烟事件无对应回合，第三级为 unavailable，判定正确）；冒烟行随后删除。`summary_versions` 待下次整理（每日 03:00 UTC）后产生，`/api/memory/summaries/1` 当前 `lineage: null`。
- 页面（召回记录页、摘要血缘区、回合页"记忆调用"、检索页第三级）由 Opus 在 `feat/obs-v2-recall-ui` 实现，合入后单独记录。

### 事故记录：主树半合并代码被构建部署（2026-10-19 00:21–00:30 本地，主会话）

- 经过：主会话按惯例在 `D:projectcs_agent` 主树执行 `docker compose build && up -d` 部署 O5 页面；此时另一会话正在主树上合并 `feat/codex-scope-threads`（§10.1，`codex-runner.ts` 有未解决冲突，28 个文件已暂存未提交）。ff 合并被拒，但构建已用主树工作目录完成，镜像包含了该未评审代码并运行约 3 分钟。其启动迁移把共享线程 `01a14d32…` 归档（reason `scope-split`）并从 `codex-threads.json` 删除。
- 处置：用 `git worktree add --detach D:/project/cs_agent-rollback a82f998` 从已提交 main 干净构建镜像；停容器，按归档行把 `shared` 原样写回 `codex-threads.json` 并删除该归档行；启动后 `/api/agents` 显示 shared/owner 均活动（16 / 8 回合），容器镜像 sha 9120c3…。未触碰另一会话的合并状态与工作树，已通过跨会话消息告知。
- 规则（此后强制）：**构建镜像一律从某个提交的干净 worktree 进行（`git worktree add --detach <path> <commit>` + `docker build -t cs-agent:dev <path>`），再在主目录 `docker compose up -d`；绝不以主树工作目录作为构建上下文**。部署前除确认队列为空外，还要确认 `git status` 无暂存/未合并内容。
- 待办：O5 页面分支 `feat/obs-v2-recall-ui`（72 文件 / 986 项已通过）等另一会话的合并落地后变基、合并、从干净 worktree 构建部署。

### O5（前端）：召回记录、三级证据与摘要血缘页面（2026-10-19，Opus 实现，主会话验收通过）

- 提交 `65ddda7`（摘要页血缘版本与被替换日摘要快照）、`b1c019e`（`/memory/recalls` 列表与过滤、`/memory/recalls/:id` 三级证据详情、回合页"记忆调用"、记忆首页 24 小时召回计数、检索页第三级链接；会话页每个回合提供"记忆调用"过滤链接而非逐回合请求）。
- 主会话复跑（变基到另一会话的 §10.1 合并 949a19c 之上）：typecheck、74 文件 / 1036 项通过（另有 1 文件 / 2 项为对方分支的跳过项）、build 通过。按新规则从干净分离 worktree `D:projectcs_agent-build`（d125c84）构建，与另一会话协调后在队列空闲时部署。
- 真实数据冒烟：以 MCP 子进程制造一条 qq_search 事件后，列表 1 行；详情页 6 个证据面板、注明"③ 证明的是该回合里出现了匹配的工具调用，不等于模型采用了内容"，第三级为 unavailable（无对应回合，判定正确）；摘要页显示"暂无血缘记录（埋点启用前生成，或已超过保留期）"；回合页"记忆调用"区显示"无记忆调用"且回合正文照常；首页卡片"最近 24 小时 1 次工具召回"；检索页第三级链接到召回记录；非数字 id 404；浏览器零错误。冒烟事件随后删除。
- 至此 O1–O5 全部上线。剩余：O6 图片画廊；两处口径修整（类别徽标"部分不可用"、分析页 475k 与占用条 500k 统一）；§10.1 上线后 codex 线程已按会话域拆分，会话列表与召回归属随之变化，需观察真实回合后的第三级证据命中情况。

### O6：图片记忆画廊 + 两处口径修整（2026-10-19，astra 实现，主会话验收通过）

- 提交 `86cfa40`（`/api/memory/images[...]`、`/media/:sha256` 受控媒体路由：仅 64 位十六进制、须在 `message_media` 登记且位于 `/data/media`、按魔数判类型、绝不触发召回下载；`/memory/images` 画廊与详情页，契约 `docs/O6-images-api.md`）、`0e499f0`（上下文分析类别徽标按可见主来源显示并单列 `unavailable_items`，估算只覆盖可见部分）、`901e9e0`（codex 有效窗口 `effectiveWindowTokens` 从 rollout `model_context_window` 采集、持久化到 context-usage，占用条与分析页统一以有效窗口为分母并提示名义值）。
- 主会话复跑：typecheck、75 文件 / 1064 项通过（1 文件 / 2 项为既有跳过）、build 通过；从干净分离 worktree 构建，队列空闲时部署，容器健康无告警。
- 真实数据冒烟：画廊 2 张（总 2.66 MB），缩略图经 `/media/<sha>` 返回 `image/png` 1,031,768 B，`Cache-Control: private, max-age=3600`；详情页大图正常；非法 sha 400、未登记 sha 404、未登录 401；Agent 页占用条显示"53,864 / 475,000（11%）"并带"名义 500,000 / 有效 475,000"提示；分析页头部同时显示名义与有效窗口，历史类别徽标"已记录"且单列"部分不可用 4 条"；记忆首页图片卡"共 2 张"；浏览器零错误。
- **观测面板 v2（O1–O6）至此全部上线。** 后续观察项：§10.1 按会话域分线程后，Agent 页会话列表与召回归属随真实回合逐步出现；官方 trace 目录体量按 `CODEX_TRACE_MAX_MB=512` 封顶；`summary_versions` 自下次整理起产生血缘。
