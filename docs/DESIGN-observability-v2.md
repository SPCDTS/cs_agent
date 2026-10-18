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
