# 观测页重构调研：开源会话查看器 / 上下文分析 / 记忆可视化

调研执行：Codex gpt-6-astra 子代理（2026-10-18），主会话整理。约束：保留服务端 HTML + 原生 JS、无 bundler、仅 MIT/Apache 兼容许可证。
结论先行：没有可直接嵌入、同时准确分析 codex 与 pi 两种后端上下文的现成组件；移植"数据模型与阅读交互"，UI 自写。

## 1. 会话查看器候选排序

活动日期为检索时可见的最近提交，部分页面有缓存。

| 排名 | 项目、输入与界面 | 技术栈／许可证 | 可见活动 | 适合移植的部分 |
|---|---|---|---|---|
| 1 | [CC Switch](https://github.com/farion1231/cc-switch)：Claude/Codex 等会话；应用筛选、会话列表、回合目录、工具步骤与结果 | Rust/Tauri、React/TS/Vite；MIT | 2026-09-11 | 数据类型、回合组织、内容分块及懒加载设计；parser 翻译为 TS，UI 重写 |
| 2 | [TraceViewer](https://github.com/abelperry/TraceViewer)：Claude/Codex JSONL；collection→session 树、事件块、工具详情、实时更新 | TS/Fastify/SQLite、React/Vite；MIT | 2026-08-05 | 独立 adapter、TranscriptAssembler、字节偏移增量读取；adapter 文件未做代码级核验 |
| 3 | [context-viewer](https://github.com/auditt98/context-viewer)：Claude/Cowork/Codex；Block 树、工具卡片、类别 token、压缩时间线 | Python HTTP、tiktoken、原生 JS；MIT | 2026-04-22 | 最接近现有前端；借鉴分类面板和折叠显示，不能照搬其 Codex parser |
| 4 | [claude-code-log](https://github.com/daaain/claude-code-log)：Claude JSONL，另有 Codex beta；项目索引、session HTML、目录、工具折叠、agent/fork | Python、HTML 模板和浏览器脚本；MIT | 2026-08-25 | 静态阅读、搜索自动展开、分支及工具配对样例 |
| 5 | [claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer)：Claude 日志/SDK；项目→session、完整工具日志、实时交互 | Node/TS、Hono/Effect、React/Vite；MIT | 2026-08-18 | TS schema、容错和内容块呈现思路；不直接支持本项目 Codex/Pi |
| 6 | [OpenCode](https://github.com/anomalyco/opencode)：自己的 session/message/part API；会话、turn timeline、工具输入输出 | TS、SolidJS/Vite；MIT | 2026-09-11 | message-part 模型、工具状态机；不是通用 JSONL parser |
| 7 | [Langfuse](https://github.com/langfuse/langfuse)：SDK/OTel；session→trace→span、I/O、耗时与 token | TS/Next.js/React；核心 MIT，EE 另许可 | 2026-09-11 | span 关联与 usage 口径；不宜引入整个平台 |
| 8 | [MCP Inspector](https://github.com/modelcontextprotocol/inspector)：在线 MCP JSON-RPC；schema、参数、调用结果、资源 | TS/Node；Apache-2.0/MIT 过渡 | 2026-09-09 | MCP 结果按内容类型呈现；无 session/turn 历史分析 |
| 9 | [AgentOps](https://github.com/AgentOps-AI/agentops)：SDK 遥测；执行图、工具、耗时与成本 | Python SDK、Next.js/React Flow；MIT | 2026-06-25 | 执行关系与事件关联设计；需要转换或埋点 |
| 10 | [claude-conversation-extractor](https://github.com/ZeroSumQuant/claude-conversation-extractor)：Claude JSONL；CLI/TUI 搜索、Markdown 导出 | Python；MIT | 2025-09-16 | 简单扫描与导出 |
| 排除 | [Phoenix](https://github.com/Arize-ai/phoenix)：OTel/OpenInference traces | Python、React/TS；**ELv2** | 2026-09-11 | 许可证不符，不移植代码 |

许可证边界：Langfuse 排除 `ee/`；MCP Inspector 文档为 CC-BY；Phoenix 不能按 Apache 处理。

## 2. CC Switch 实现（MIT，Rust/Tauri + React/TS/Vite）

- 解析在 Rust 后端：`src-tauri/src/session_manager/providers/codex.rs`、`claude.rs` 把原始 JSONL 转成统一消息；Codex 部分按调用 ID 关联调用、结构化事件和结果；大内容只返回预览和 `ContentRef`，全文按需读取。
- 传输层 `src/lib/api/sessions.ts`：Tauri `invoke`/`Channel`，提供列表、消息流、按需读全文。
- UI：`SessionManagerPage.tsx`（列表）、`sessions/reader/SessionReader.tsx`（回合目录、时间线、工具步骤、搜索、折叠）。
- 数据模型 `src/types.ts`：`SessionMessage`、`SessionBlock`、`TurnIndex`、`TranscriptChunk`；块类型：文本、thinking、工具调用/结果、图片、事件、步骤。
- 可移植性：类型声明可原样取用（保留 MIT 声明）；React/Tauri 组件不能嵌入；Rust parser 翻成 TS，transport 换 HTTP/SSE，UI 用 `<details>` 重写。它只是展示用 parser，不重建上下文。

## 3. Codex 0.163.0 的上下文重建

- rollout 持久化在独立 crate `codex-rs/rollout`；权威重建逻辑在 `codex-rs/core/src/session/rollout_reconstruction.rs`：处理 rollback 后仍存活的回合、有效的 compaction checkpoint 与 `replacement_history`、保留上下文与恢复基线后再重放后续记录。`core/src/context_manager/history.rs` 还做模型输入规范化和模态过滤。只取最后一次 compaction 再拼接后续日志不够。这些 Rust 方法不是稳定 API，需用 TS 重实现。
- rollout JSONL 可还原：消息、函数调用和输出、reasoning（可能加密）、compaction 标记和 `replacement_history`、`token_count`（每次请求 input/output/cache，cached 已含在 input 内）、turn 边界、`turn_context`（模型、强度）。
- 不能还原：精确的 system/instructions 与 tool schema（动态，未必记录）、未记录的注入内容、加密 reasoning。
- `codex debug prompt-input [PROMPT]` 只按当前配置生成初始输入 JSON，无 thread 参数；`codex debug trace-reduce <bundle> --output <file>` 把官方 trace 转成结构化 JSON，需预先启用 trace。
- 官方 trace 由 `CODEX_ROLLOUT_TRACE_ROOT` 启用，保存请求/响应 payload、工具、压缩事件；reducer 输出 threads、turns、items、inference calls、tool calls（`codex-rs/rollout-trace/README.md`）。这是新数据最值得复用的出口，但不能追补旧日志。
- token 来源：`token_count` 实测 usage；内容估算用 `js-tiktoken/lite` + `o200k_base`。
- 现有 `src/agent/codex-context-usage.ts` 只扫文件末尾 2 MiB 取最近 usage，不是会话解析器。

## 4. pi-durable 1.3.0 公开 API（本地包已确认）

- `conv.entries(query, limit, cursor, ctx)`：分页、fork-aware 历史。
- `conv.context(ctx, {at})`：返回 `head / entries / contributions / messages`，支持指定历史条目；已处理压缩、omit/replace、工具结果排序。
- `CompactionEntry` 存摘要与保留边界；`SystemEntry` 存提示变化与 `toolsAdded/toolsRemoved`。
- `pi-ai/utils/transcript`：`getCurrentSystemPrompt()`、`getCurrentTools()`、`getCurrentSystemMessage()`。
- `pi-ai/utils/estimate`：`estimateMessageTokens`、`estimateContextTokens`（字符数÷3.5，图片固定值，加最近 usage 与尾部估算）。估算值，非实测。
- `beforeRequest`/`onPayload` 钩子可采集最终请求；`context()` 反映已提交状态，下一轮 prepare 与 provider 转换仍可能改变请求。
- 不要深度导入未公开的 `deriveContext` 等内部实现。

## 5. 记忆系统可视化候选

建议增加独立的"记忆 → QQ scope → 时间范围/记忆条目"导航，与"agent → session → turn"双向关联。QQ 历史库由两个后端共享，且 owner/shared 线程与 QQ scope 并非一一对应，不能直接把记忆挂在单个 agent 下。

| 排名／候选 | 可参考的视图 | 技术栈、许可证 | 活动／移植判断 |
|---|---|---|---|
| 1. [vis-timeline](https://github.com/visjs/vis-timeline) | 按 scope 分组的原文、日摘要、周摘要区间；缩放、选择、重叠 | 浏览器 JS；MIT 或 Apache-2.0；standalone UMD | 2026-07-02。最适合直接引入预构建 JS/CSS |
| 2. [Mem0 自托管 dashboard](https://github.com/mem0ai/mem0/tree/main/server) | Memories 按用户过滤、Entities 计数、Requests 审计与耗时 | FastAPI＋Next.js/React；Apache-2.0 | 2026-10-14。借鉴"记忆列表＋调用审计"，用现有模板重写 |
| 3. [Cal-Heatmap](https://github.com/wa0x6e/cal-heatmap) | 每日消息量、摘要量、召回量热力图 | TS/D3；MIT | 2024-03-03，维护慢；简单日历自写 CSS grid 更轻 |
| 4. Letta／MemGPT ADE | Core memory blocks、上下文分区与预算、archival/recall memory | runtime Apache-2.0；ADE 网页许可未核实 | 借鉴"已在上下文中／外部可检索"的分区 |
| 5. 旧 OpenMemory UI | 本地记忆管理 dashboard | Python＋Next.js；归档代码 Apache-2.0 | 已停止维护；参考列表与详情布局 |
| 6. Zep／Graphiti | 实体、事实关系、时间有效性 | Python＋图数据库；Apache-2.0 | 借鉴来源与时间字段；不迁图数据库 |
| 7. LangGraph／LangSmith Studio | thread 状态、checkpoint/time travel、长期记忆 namespace | LangGraph MIT；Studio 前端无可复用许可 | 借鉴"某时点状态"与 namespace 浏览 |
| 8. Khoj | 片段检索、过滤、来源 | AGPL-3.0 | 仅借鉴交互，不复制代码 |
| 9. Open WebUI | 按用户管理记忆，分类查看编辑 | Open WebUI License | 不纳入移植范围 |
| 10. SillyTavern | Lorebook 条目、触发关键词、注入位置与预算、滚动摘要 | AGPL-3.0 | 交互适合解释"为什么注入这条记忆"，不复制实现 |

未发现可直接读取 cs_agent SQLite 并完整提供"日→周衰老、摘要血缘、召回→turn、按需图片记忆"的现成 UI。

## 6. 主会话补充：现有数据覆盖度（2026-10-18 自查）

- 观测库 `events`（每票据）：received / admitted / routed / dispatched / backend:* / model_turn 或 model_usage / tool:*（pi 全部工具带 input+output；codex 的 MCP 工具带 input+output，command_execution 与 web_search 只有 200 字命令/查询摘要与 exit_code）/ compaction（pi）/ postprocess / reply_sent / failed。终态事件 detail 超 1 KB 会被截断为失败摘要。
- codex rollout（容器 `/data/codex/sessions/YYYY/MM/DD/*.jsonl`）：`session_meta`、`turn_context`、`response_item{message|reasoning|custom_tool_call|custom_tool_call_output}`、`event_msg{task_started|item_completed|token_count|task_complete}`、`token_usage_record`。
- pi：`conversation.context({at})` 直接给出某时点的模型上下文；`CompactionEntry` 标出摘要与保留边界；`estimateMessageTokens` 按消息估 token。

## 7. 记忆可视化：现有数据能展示什么（调研 Part 2）

依据 `store.ts`、`aging.ts`、`qq-context-server.ts` 与图片工作树 `cs_agent-recall`：

- **时间线与老化状态：已有基础。** `messages` 有 scope、时间、引用和 ticket；`summaries` 有层级、半开时间区间、`msg_count`、创建时间。原文与摘要可能并存，应显示为两条轨道。用 `aging_last_run`、配置小时与容器 TZ 可算出上次与预计下次运行；"正在运行"需暴露调度器状态。空白区间只能标"无现存记录"，不能断言"已清理"。
- **摘要血缘：只能部分推断。** 日摘要先格式化消息再只保留末尾约 12,000 字符；`msg_count` 是整日行数而非实际输入条数；周摘要生成后删除日摘要，已删除来源无法补回。要证明来源，须新增不可变摘要版本、实际输入的消息/摘要 ID、裁剪信息和生成记录。
- **搜索：没有相关性分数。** 当前为 trigram FTS 加 `LIKE`，多关键词需全部命中，按时间排序；无 BM25/向量/rerank。检查器应显示命中字段、关键词高亮、时间顺序，并对照"数据库命中"与经 `format.ts` 裁剪后的工具返回文本。
- **线程归档与 pi compaction 是另一类记忆**，不与 QQ 日/周摘要混放。`codex-threads.json` 存当前 owner/shared 映射，归档 JSONL 最多 200 条，正文仍在 rollout；pi 的 `CompactionEntry` 可经 `entries()` 与 `context({at})` 展示。
- **图库只展示按需入库的图片。** WIP `message_media` 有 `scope/message_id/ordinal/sha256/path/status/reason/created_at`（`ok/skipped`）；无宽高、大小、逐次召回记录；未调用 `qq_image` 的图片只有占位；消息删除会清理关联行，文件另经 GC。`qq_image` 只返回路径，之后文件工具读图才进入上下文，是另一个事件。schema 仍在变动。

### 建议的记忆页面、数据源与工作量（一名熟悉项目的开发者）

| 路由 | 现有数据 | 需要新增 | 人日 |
|---|---|---|---|
| `/memory` | scope 列表、消息/摘要计数、时间范围 | 每 scope SQL 聚合、每日统计快照；区分文本字节估算与整库磁盘占用 | 1–2 |
| `/memory/scopes/:scope` | 原文/日摘要/周摘要时间线、`aging_last_run` | vis-timeline 适配；待摘要区间、保留期边界、预计调度时间 | 2–3 |
| `/memory/summaries/:id` | 摘要正文、区间、计数、尚存原文 | `summary_versions`、来源关联、输入裁剪、model/usage、aging run ID；血缘用展开列表或小型 SVG | 3–5 |
| `/memory/search?scope=&q=` | 复用 `ContextStore.search()` 与同一 formatter | 参数规范化、转义后高亮、命中与实际返回对照；不伪造 score | 1–2 |
| `/memory/recalls` 及 turn 内"记忆调用"页签 | rollout/pi 中完整保留的工具调用与结果 | 结构化 `recall_events`：backend、真实 session、turn、ticket、call_id、查询、来源 ID、返回顺序、裁剪、耗时 | 3–5 |
| `/memory/images?scope=` | WIP `message_media` 加原消息关联 | 带鉴权媒体路由、懒加载缩略图、文件缺失状态；浏览不触发下载召回 | 2–3 |
| `/memory/archives` 及 session 内"压缩摘要"页签 | Codex 归档映射、pi archive doc 与 compaction entries | 链到 session viewer；按 scope、ticket、turn 关联 | 1–2 |

召回使用记录分三个证据阶段：检索命中 → 工具实际返回 → 某次模型请求包含。工具返回不能直接标为"模型采用"（可能被裁剪或压缩掉）；通用观测日志里被截断的文本补不齐这条链。

外部代码复用：vis-timeline 固定版本预构建 JS/CSS；热力图按需选 Cal-Heatmap，简单日历自写 CSS grid；其余用现有 SSR、`<details>`、CSS grid 与 SSE。

范围建议：先做时间线、搜索检查器、统计、已召回图库（约 6–10 人日）；再补摘要血缘与召回关联；全部含分页、权限、验证约 15–25 人日（不含另一会话的图片召回后端）。限制：已删除来源无法补回；旧调用缺少关联记录；图片 schema 变动中；新增仪表记录需独立保留期。

## 8. 总体建议（调研 Part 3）

**方案**：保留 Node 24、服务端 HTML 与原生 JS，不引入 React 或 bundler；借鉴 CC Switch 的数据模型与阅读交互。内容事实源是 rollout 与 pi entries，ObsStore 只补充 QQ ticket、送达回复和耗时（events 每票据约 500 条 / 256 KiB，有脱敏与截断，不能当完整记录）。

**路由与数据源**

| 路由 | 内容 | 数据源 |
|---|---|---|
| `/agents` | codex / pi 入口 | 配置 |
| `/agents/:backend/sessions` | 活动与归档 session，用真实 ID | Codex：活动映射、归档与 rollout 目录；Pi：`pi.sqlite`、线程文档、归档 |
| `/agents/:backend/sessions/:id` | 回合目录、正文、可收起的 context 面板 | Codex rollout adapter；Pi `conv.entries()` |
| `…/turns/:turnId` | 用户输入、assistant 文本、每个工具的参数与结果（`<details>`）、耗时、usage | 同上，再用 ObsStore 补 ticket 与耗时 |
| `…/context?at=&phase=before/after` | 指定时刻的上下文结构 | Codex：重建；Pi：`conv.context({at})` |
| `/api/agents/…`、`/agents/stream` | 游标分页、工具内容懒加载、SSE 增量 | 同上 |
| `/memory/…` | 见第 7 节 | QQ 消息库 |

顶层 turn 是一次用户输入到该轮结束，内部模型请求单独列出；工具按 `callId` 配对；无明确执行时间标"未知"或"估算"。现有 `/context` 浏览的是 QQ 消息库，模型上下文分析用新路由。

**上下文分类与 token**：分类 instructions / tool definitions / 历史消息 / 工具输出 / 压缩摘要 / 其他；每项标注 已记录 / 重建 / 估算 / 不可用，动态 schema、加密 reasoning、未记录注入不能显示成 0。token 两条线：实测 usage（每次请求 input/output/cache；Codex 的 cached 已含在 input，不重复相加；压缩后的旧 usage 标过期）与内容估算（MIT 的 `js-tiktoken/lite` + `o200k_base`，词表本地加载；pi 可用自带估算当基线）。不对整行 JSONL 计数；不把估算与实测差额全算作 system。

**原样移植 vs 重实现**：原样取用 CC Switch 的纯类型声明（保留 MIT 声明）、vis-timeline 预构建 JS/CSS（固定版本）；重实现 Rust parser → TS、Codex adapter 按 0.163.0 重建规则、UI 用 SSR + `<details>`、pi 只调公开 API；参考不复制 TraceViewer、claude-code-log、Mem0 dashboard；排除 Phoenix（ELv2）、Khoj/SillyTavern（AGPL）、Open WebUI；官方 trace 导出作为可选项。

**工作量（人日）**

| 工作项 | 人日 |
|---|---:|
| 统一模型、真实 session 与归档索引 | 1–2 |
| Codex transcript adapter | 2–3 |
| Pi history/context adapter | 1–2 |
| 三级导航、工具懒加载、SSE | 2–3 |
| token 分类与逐消息面板 | 1–2 |
| Codex 历史上下文重建 | 2–4 |
| 大文件、压缩/分支、脱敏、CSP 验证 | 1–2 |
| 官方 trace / 最终请求快照（可选） | +2–4 |
| 记忆部分（第 7 节） | 15–25（核心 6–10） |

Agent/session/turn 查看器完整版约 10–18 人日，分阶段版约 6–10 人日。

**风险**：把完整日志当成当前活动上下文（压缩、rollback、fork 都会改变真实窗口）；把累计用量与窗口存量混为一谈；承诺恢复从未保存的工具结果或请求内容；只取最后一次 compaction 再拼接会漏掉 `replacement_history` 与 rollback；大 rollout 文件的性能、脱敏、CSP；图片 schema 变动、已删摘要来源不可补、新增审计记录需独立保留期；研究页面有缓存，"最近活动"日期非精确；ADE/Zep Explorer/Studio 前端许可证未核实，TraceViewer adapter 未做代码级核验。
