# 设计 v2：聊天记录衰老与检索、意图层会话感知、联网检索、"先查再画"

> 状态：v2，按用户反馈简化。未实现。
> 相比 v1 的变化：取消 codex 线程分域与轮换；历史记录改为分层衰老而非硬删除；资料查询由意图识别 agent 用 DeepSeek Search/Fetch API 完成，不再借 codex 一次性会话。

## 0. 目标与问题

| 现状 | 问题 |
|---|---|
| codex 每轮只拿到一行来源标注 + 正文 | 看不到任何 QQ 历史，"刚才那条"、"上面说的"无法理解 |
| 意图模型每条消息一个无状态会话 | "把刚才那张图改成蓝色"、"继续"无法路由 |
| `AGENTS.md` 只有安全规则 | 回复格式靠意图层兜底 |
| `web_search` 未配置 | codex 时效性问题答不准 |
| 意图层"恰好一个业务工具" | 生图涉及现实实体/时事时无法先查资料 |

## 1. 原则

1. **拉取优于推送**：历史不随每轮注入；需要时通过工具按需拉取，返回紧凑文本、有硬上限。
2. **衰老优于删除**：原始消息 → 日摘要 → 周摘要，越久远越粗，像上下文压缩一样分层。
3. **单一 codex 线程，依赖其自带压缩**：不分域、不轮换，只留一个极宽松的安全阀。
4. **访问过滤**：存储不分域，但群内查询只见本群；owner 私聊可查全部。
5. **研究在意图层**：DeepSeek 用自家 Search/Fetch API 查资料并组装生图提示词；codex 线程保持干净。

## 2. 聊天记录：本地消息库 + 分层衰老

### 2.1 存储（QQBridge 新增职责）
`/data/qq-messages.sqlite`，`node:sqlite`（容器内 SQLite 3.53，FTS5 可用）：

| 表 | 内容 |
|---|---|
| `messages` | `scope`(group:<id> / private:<qq>)、`message_id`、`time`、`user_id`、`nickname`、`is_self`、`text`、`reply_to_id`。允许范围内**全部**消息入库（含不触发的群消息、机器人自己的回复）。媒体只存 `[image]` 等占位。 |
| `messages_fts` | FTS5 虚表，`tokenize='trigram'`，支持中文子串检索 |
| `summaries` | `scope`、`level`(day / week)、`period_start`、`period_end`、`text`(≤400 字)、`msg_count`、`created_at` |
| `summaries_fts` | 同上 |

### 2.2 衰老调度（agent 侧每日任务，容器内 03:00）
1. **日摘要**：对每个 scope 前一天的消息（≥5 条才做），用 `deepseek-flash` 生成 ≤400 字摘要：参与者、讨论主题与结论、待办/承诺、机器人做过的事。写入 `summaries(level=day)`。
2. **周摘要**：日摘要满 7 天后合并成一条 ≤400 字周摘要，删除对应日摘要。
3. **原始消息**：超过 `HISTORY_RAW_DAYS`（默认 30）删除。
4. **周摘要**：超过 `HISTORY_SUMMARY_DAYS`（默认 180）删除。
5. 撤回事件：删除原始行；已生成的摘要不回溯修改。
摘要生成是唯一的模型开销，每天每 scope 一次，忽略不计。

### 2.3 检索服务 `qq_context`（容器内 stdio MCP，Node）
注册进受管 `config.toml`：
```toml
[mcp_servers.qq_context]
command = "node"
args = ["/app/dist/mcp/qq-context.js"]
startup_timeout_sec = 10
tool_timeout_sec = 15
```
**访问范围按次注入**：每次 `codex exec` 追加 `-c mcp_servers.qq_context.env.QQ_ACCESS="group:200000001"` 或 `"all"`（owner 私聊）。MCP 进程只按该范围过滤，参数里不接受范围。

| 工具 | 参数 | 返回 | 上限 |
|---|---|---|---|
| `qq_recent` | `limit≤30`, `before_message_id?` | `HH:MM 昵称: 文本`，自己发的标 `[我]` | 单条 ≤120 字，总量 ≤2500 字 |
| `qq_search` | `query`, `days≤180`, `limit≤20` | 原始消息与摘要混排，按时间倒序；摘要行标 `[日摘要 10-15]` / `[周摘要 10-06~10-12]` | 同上 |
| `qq_message` | `message_id` | 完整正文 + 引用链（≤3 层） | ≤1500 字 |

同一个库也供意图层读取（§4），不经 MCP，直接进程内访问。

### 2.4 统一上下文（意图层与 codex 共用同一套）
意图层与 codex 的"会话感知"来自**同一个存储、同一个格式化模块**，不再单独维护 interactions 表：
- 机器人自己的回复作为 `is_self=1` 的消息行入库，并附带元数据列 `action`（generate_image / research+generate_image / ask_codex / fallback）、`detail`（生图最终英文提示词 / codex 推理强度）、`ticket`、`status`（处理中 / 已回复 / 失败）。"处理中"行在收到消息时就写入，回复后更新为已回复并补上正文摘要。
- `src/context/store.ts`：唯一的读写入口（入库、撤回、衰老、`recent()`、`search()`、`message()`、访问过滤）。
- `src/context/format.ts`：唯一的紧凑格式化器，输出 `HH:MM 昵称: 文本`，机器人行渲染为 `HH:MM [我] → 生图 prompt="..." → 已发送 1 张图` 或 `[我] → codex(high) → "摘要"`。
- 消费方：
  - 意图层：派发器在每条消息前调用 `recent(scope, window=120min, limit=5)` 注入上下文块；工具 `recent_context` / `search_history` 直接进程内调用同一模块。
  - codex：`qq_context` MCP 服务是同一模块的 stdio 外壳，工具 `qq_recent` / `qq_search` / `qq_message` 一一对应，访问范围由 `QQ_ACCESS` 注入。
- 效果：两层看到的历史内容、裁剪规则、字数上限完全一致；追问"把刚才那张图改成蓝色"时，意图层与 codex 看到的都是同一行 `[我] → 生图 prompt="..."`。

## 3. codex 执行层

### 3.1 两条线程：owner 与 shared（2026-10-18 用户决定）
- 评审指出单一线程会让 owner 私聊内容经 codex 记忆泄露到群聊。改为两条线程：`owner`（owner 私聊）与 `shared`（所有群与其他用户），映射存 `codex-threads.json`，旧 `codex-session.json` 迁移为 `owner`。每条线程一把互斥锁，两条可并行。
- 历史检索仍不按线程分域，访问过滤见 §2.3。
- 依赖 codex 自带的自动上下文压缩。安全阀：rollout 文件 > `CODEX_ROLLOUT_MAX_MB`（默认 50）或线程 > `CODEX_THREAD_MAX_DAYS`（默认 90）时新建线程（无交接摘要，历史靠 §2 的检索找回）。
- 全局一把互斥锁（不变）。

### 3.2 每轮注入（最小化）
```
[来源] 群 200000001 · 昵称(QQ号) · 2026-10-17 22:41
[引用] 昵称: 被引用消息正文（≤200 字，仅当带 reply 段）
<正文>
```
规则一律放 `AGENTS.md`，不随轮注入。

### 3.3 `AGENTS.md`（热编辑，`/workspace`）
回复规则：
- 回答原样显示在 QQ：纯文本，不用 Markdown、代码围栏、表格、标题符号。
- 中文；默认 ≤300 字，用户明确要长文再放开（中继层 4000 字截断）。
- 不复述问题，不解释用了什么工具，不输出"作为 AI"套话。
- 链接最多 1 条；不确定的事实明说"未核实"，不编造。
- 群聊面向群内读者，私聊面向本人。

历史工具纪律：
- 仅当消息指代此前内容（"刚才"、"上面"、"那个"、无先行词代词、明显追问）或用户要求回顾时调用 `qq_recent`。
- 优先 `qq_search` 带具体关键词；一次请求最多调用历史工具 2 次。
- 不复述检索到的原文，只给结论。

安全规则维持现状。

### 3.4 Web 搜索
受管 `config.toml`：
```toml
web_search = "live"            # CODEX_WEB_SEARCH=live|cached|disabled，默认 live
[tools.web_search]
context_size = "low"           # CODEX_WEB_SEARCH_CONTEXT，默认 low，限制搜索结果注入量
```

## 4. 意图层重构：路由器只分类，流程由代码驱动（2026-10-18 用户确认）

> 背景：原设计把分类、选强度、提取提示词、转发整理、追问判断、联网研究全放在一个带工具的"意图识别 agent"里，靠"恰好一次业务工具、恰好一次 reply_qq"的提示约束加代码守卫维持纪律。用户认为它干的事太多。重构为：**路由器**做一次结构化分类，**执行器**按分类走代码定义的固定流程，**研究器**只在需要时启动。

### 4.1 路由器（Router）
- 一次模型调用，无工具、无多轮：输入 = `[近期交互]` 上下文块（§4.4）+ 本条消息（含来源标注），输出固定结构：
```json
{
  "intent": "image" | "codex",
  "codex_effort": "low" | "medium" | "high" | "xhigh" | "max",   // 仅 intent=codex
  "image_prompt": "…",                                            // 仅 intent=image：最终提示词，保留用户原语言；追问改图时已把上一张的提示词合并进来
  "research_question": "…" | null                                 // 仅 intent=image：画面依赖需核实的外部事实时填写，否则 null
}
```
- 实现：pi-durable 会话里模型恰好调用一个工具 `route(...)`，其参数 schema 即上述结构（工具调用即结构化输出，DeepSeek 支持 function calling）；`route` 把决策写入票据文档并 `terminate`。模型若未调用 `route` 或参数不合法 → 代码兜底为 `{intent:"codex", codex_effort:"low"}` 并记日志。
- 系统提示只保留：角色一句话、两类的判定规则、四个字段的填写说明、"不自己回答、不扩写、照抄原文"、不可信内容声明。目标 ≤15 行。仍从 `/data/prompts/system.md` 热加载。
- 不设 `unknown`：拿不准一律 `codex`。不再有"恰好一次工具"的提示约束，纪律由代码保证。

### 4.2 执行器（Executors，pi-durable `defineTask` 分阶段、带检查点）
按 `intent` 由派发器选择，流程写死在代码里，崩溃后从阶段恢复：

| intent | 阶段 | 回复 |
|---|---|---|
| `image` | `[research]`（仅 `research_question` 非空，§4.3）→ `generate`（`image_prompt`，研究结果以"参考事实：…"追加到提示词后）→ `reply` | 成功：固定模板"图片生成好了"+ 图；失败：固定模板按错误类别（服务不可用 / 超时 / 内容被拒） |
| `codex` | `ask`（线程 owner/shared，`codex_effort`）→ `relay` → `reply` | `relay`：`CODEX_REPLY_MODE=relay`（默认）时用一次**独立的小模型调用**做格式整理（提示 ≤5 行：纯文本、中文、不改含义、去 Markdown、≤4000 字）；`direct` 时仅代码清洗。失败：固定模板"处理超时/失败" |

- 票据状态与统一上下文（§2.4）的 `completeReply` 由执行器在 `reply` 阶段写入，`detail` 记最终提示词 / 推理强度。
- 执行器是纯代码 + 工具函数（现有 `generate-image.ts`、`ask-codex.ts`、`reply-qq.ts` 的实现保留，去掉"模型可调用的工具"外壳，改为任务阶段直接调用）。

### 4.3 研究器（Researcher，仅 image 且 `research_question` 非空）
- 一个小型带工具的 pi-durable 会话（或子任务）：工具 `web_search(query, count≤8)`、`fetch_page(url)`（DeepSeek Search/Fetch API，§4.5），模型为意图模型；系统提示：只收集与画面呈现相关的事实（外观、颜色、标志、场景、人物/队伍身份、时间与结果），纯文本 ≤`RESEARCH_MAX_CHARS`（600），不确定标"未核实"；工具调用上限由代码守卫（`web_search ≤2`、`fetch_page ≤2`）。
- 超时 `RESEARCH_TIMEOUT_SEC`（180）或失败 → 返回空，执行器按无研究结果继续生图，回复模板附一句"未能核实外部信息"。
- 研究器不接触长期 codex 线程，也不写聊天记录库。

### 4.4 会话感知（只喂给路由器）
派发器在路由前从统一上下文存储取 `recent(scope, 120min, 5)` 生成上下文块（格式见 §2.4），放在消息之前。上限 `INTENT_CONTEXT_ITEMS=5`、`INTENT_CONTEXT_WINDOW_MIN=120`、`INTENT_CONTEXT_MAX_CHARS=1500`；超窗口不注入。
- 追问改图：路由器直接输出合并后的 `image_prompt`（上一张的提示词 + 本次修改），执行器不需要知道"这是追问"。
- 追问 codex：与新问题同路径，codex 线程自带记忆。
- 上一条仍"处理中"而本条修改它：按本条独立意图处理，回复模板附"上一条仍在处理"。
- **同一会话顺序处理**：派发器按 scope FIFO 串行，不同 scope 并行（受 `AGENT_CONCURRENCY`）。
- 路由器不再有拉取工具（`recent_context` / `search_history` 取消）：需要更多历史的是 codex，它有 `qq_context`。

### 4.5 联网检索工具（DeepSeek Search/Fetch API，仅研究器使用）
已核实：`POST https://api.deepseek.com/v1/tools/search`（`query` ≤128 字、`count` ≤50、`need_content`、支持 `site:` `lang:` `after:` 操作符）与 `POST /v1/tools/fetch`（`url` → Markdown 正文），同一 API key，5 QPS，$0.75/千次，2026-11-01 前免费。
| 工具 | 参数 | 返回 | 上限 |
|---|---|---|---|
| `web_search` | `query`, `count≤8` | 每条 `标题 / 日期 / 摘要(summary) / url`，按 rerank_score 排序 | 总量 ≤2500 字 |
| `fetch_page` | `url` | 页面正文 | ≤4000 字，超出截断 |
429 时退避重试一次；其他 4xx 不重试。

### 4.6 codex 回答的转发与直通
`CODEX_REPLY_MODE=relay|direct`，默认 `relay`（用户 2026-10-17 决定保持转发）。见 §4.2 的 `relay` 阶段。观测面板的票据时间线同时保存 codex 原文与实际发出的文本。

### 4.7 容器内浏览器（替代 egolite）
已核实：ego (lite) 目前仅有 macOS 桌面版，Windows 为未开放的 closed beta，Linux 在路线图；没有 headless / 独立 CLI / Docker 模式，agent 通过 `ego-browser` 技能驱动桌面应用内的页面 JS 工具，协议未公开。它无法在 Linux 容器内运行，本机也未发现安装。

本期方案：
- **阅读型需求**（绝大多数）：意图层用 DeepSeek `fetch_page`（页面 → Markdown），codex 用 `web_search = "live"`。不需要浏览器。
- **交互型需求**（JS 渲染页、点击、登录态）：给 codex 配 `@playwright/mcp`（headless Chromium，容器内安装，镜像约增 400 MB），注册为 `[mcp_servers.browser]`，`--headless --isolated`，无宿主机登录态。意图层不接浏览器。
- egolite 推出 Linux/headless 版本后，可用同一个 `[mcp_servers.browser]` 槽位替换，AGENTS.md 中的浏览器使用纪律不变。
- 开关：`CODEX_BROWSER=playwright|none`，用户已确认本期默认 `playwright`。
- 可写目录（用户 2026-10-18 决定）：`/workspace`、`/data/prompts`、`/data/workflows`。其中 `/data/prompts` 可写意味着任何能触发 codex 的发送者理论上可经 codex 修改热加载的系统提示；用户知悉并接受，仅以 AGENTS.md 软规则限制为"owner 私聊明确要求时才改"。


## 5. 配置项（新增）

```
HISTORY_RAW_DAYS=30
HISTORY_SUMMARY_DAYS=180
HISTORY_SUMMARY_HOUR=3
QQ_CONTEXT_MAX_CHARS=2500
CODEX_WEB_SEARCH=live
CODEX_WEB_SEARCH_CONTEXT=low
CODEX_ROLLOUT_MAX_MB=50
CODEX_THREAD_MAX_DAYS=90
INTENT_CONTEXT_ITEMS=5
INTENT_CONTEXT_WINDOW_MIN=120
INTENT_CONTEXT_MAX_CHARS=1500
WEB_SEARCH_MAX_PER_MESSAGE=2
FETCH_MAX_PER_MESSAGE=2
CODEX_BROWSER=playwright
CODEX_REPLY_MODE=relay
CODEX_REPLY_SANITIZE=true
```

## 6. 边界与隐私

- 群成员可让 codex 检索**本群** 30 天原始消息与 180 天摘要，与其本来能翻群记录一致；owner 私聊可查全部；私聊内容对群不可见。
- 摘要由模型生成，可能有偏差，只影响"记忆"，不影响权限与路由。
- `./data` 含聊天记录与摘要，按聊天记录保管。

## 8. 观测系统（用户新增需求）

目标：直观看到整体运行状态，出问题时能顺着一条消息的全链路排查。本地使用，不做多用户权限。

### 8.1 数据
- **事件表** `/data/observability.sqlite` → `events(ticket, scope, ts, stage, status, duration_ms, detail_json)`。`ticket` 是全链路关联 id。阶段：`received → admitted → dispatched → model_turn → tool:<name> → reply_sent | failed | fallback`。工具事件记录输入摘要（提示词、查询词、推理强度）、输出摘要、耗时、错误类别；模型事件记录 provider/model、输入输出 tokens。敏感值（token、key）永不入库。
- **统一埋点 API** `src/obs/trace.ts`：`trace.event(ticket, stage, {...})`，派发器与每个工具调用。日志行同时带 `ticket` 字段，便于 `docker compose logs | grep`。
- **指标**（内存聚合 + 周期落盘到 `metrics` 表）：按工具/模型的调用数、成功率、p50/p95 耗时；队列深度与各 scope 排队数；NapCat WS 状态与断线次数；codex 线程 rollout 大小与轮数；DeepSeek 用量与估算费用；ComfyUI 任务耗时；衰老任务上次运行结果。
- 保留 `OBS_RETENTION_DAYS`（默认 30）。

### 8.2 面板（容器内 HTTP，`127.0.0.1:8787` 发布到宿主机 localhost）
服务端渲染 HTML + 少量原生 JS + SSE，不引入前端框架，不增大镜像。页面：
| 页面 | 内容 |
|---|---|
| `/` 总览 | 健康状态（WS、comfy、codex、DeepSeek key、衰老任务）、最近 1h/24h 吞吐与错误率、队列、当前处理中的票据 |
| `/tickets` | 票据列表（时间、scope、发送者、意图动作、状态、总耗时），筛选失败/超时 |
| `/tickets/<id>` | 单条全链路时间线：原文 → 注入的上下文块 → 模型每轮（tokens）→ 工具调用（提示词/查询/强度、耗时、结果摘要、生成图缩略图）→ 回复正文 → 票据状态流转 |
| `/logs` | SSE 实时日志尾随，按 ticket / level 过滤 |
| `/context` | 按 scope 浏览消息库与摘要，试跑 `recent` / `search` 看 codex 会看到什么 |
| `/codex` | 线程 id、轮数、rollout 大小、最近交接/新建记录、AGENTS.md 当前内容 |
| `/config` | 生效配置（脱敏）、系统提示当前内容与 mtime |
`docker-compose.yml` 增加 `ports: ["127.0.0.1:8787:8787"]`；可选 `OBS_TOKEN` 作为简单访问口令（默认空，仅本机）。

### 8.3 告警（可选）
`ALERT_OWNER=true` 时，WS 断线超 5 分钟、codex/DeepSeek 鉴权失败、连续 3 条票据失败，向 owner 私聊发一条告警（限频 1 次/30 分钟，走 `send()` 而非票据）。默认关闭。

## 7. 实施拆分（各自测试、单独重建部署）

1. **消息库 + 衰老任务 + `qq_context` MCP + AGENTS.md + codex web_search**。测试：假 OneBot 入库/撤回/清理、摘要任务（faux 模型）、FTS 中文检索、MCP 上限与访问过滤、`QQ_ACCESS` 注入。
2. **路由器 + 执行器重构 + 会话感知**（§4.1、4.2、4.4、4.6）：`route` 结构化输出、系统提示精简、`defineTask` 执行器（image / codex）、relay 整理步骤、上下文块注入、按 scope FIFO。测试：faux 模型两类路径与兜底；生图后"改成蓝色"输出合并提示词；codex 追问直通；超窗口不注入；同 scope 串行/跨 scope 并行；任务阶段崩溃恢复不重复生图/不重复发送。
3. **研究器 + 联网检索**（§4.3、4.5）：`web_search` / `fetch_page` 工具、研究器会话与调用上限、`research_question` 接入 image 执行器。测试：faux 路径、上限守卫、搜索失败降级为直接生图、429 退避。
4. **观测系统**（§8）：事件表与埋点、指标、面板、可选告警。测试：埋点覆盖每个阶段、面板页面渲染、SSE、脱敏。

决策（2026-10-17 用户确认）：设计 v2 通过；`CODEX_BROWSER=playwright` 本期开启。

每组完成后由 Codex 做一轮独立评审。
