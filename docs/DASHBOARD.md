# 观测面板（值守台）

容器内 `127.0.0.1:8787`（Compose 只发布宿主机回环，部署见 [DEPLOY.md](DEPLOY.md)「观测面板」）。服务端渲染 HTML + 原生 JS 模块（`/assets/*.js`），无框架、无外部字体或 CDN；唯一的第三方前端资源是随镜像分发的 vis-timeline（`/assets/vendor/vis-timeline.js` / `.css`，固定两项白名单，见 [THIRD-PARTY.md](THIRD-PARTY.md)）。入口 `src/obs/http.ts`，页面在 `src/obs/ui/`。

## 1. 访问与安全

- **口令**：所有页面与接口都需要访问口令（`OBS_TOKEN`，留空则读 / 生成 `/data/obs-token`）。未登录返回 401 登录页；`?token=` 只用于 GET 登录，校验后 303 到去掉口令的 URL 并设 `obs_token` HttpOnly、SameSite=Strict cookie。口令常数时间比较。
- **Host**：只接受 `localhost` / `127.0.0.1` / `[::1]`（防 DNS rebinding），其余 403；只接受 GET / POST，其余 405。
- **响应头**：`Cache-Control: no-store`、`Referrer-Policy: same-origin`、`X-Content-Type-Options: nosniff`；CSP 为每请求 nonce（`style-src 'self' 'nonce-…'`、`script-src 'nonce-…'`、`img-src 'self'`、`connect-src 'self'`、`frame-ancestors 'none'`、`form-action 'self'`）。页面没有内联 `style=` 属性；宽度类数据用 `data-*` 整数加 `theme.ts` 生成的属性选择器。
- **写操作**（面板表单）：只认 cookie（URL 口令不能写）；有 `Origin` 时必须同源，字面值 `null` 仅在 `Sec-Fetch-Site: same-origin` 时允许，有 `Sec-Fetch-Site` 时只接受 `same-origin` / `none`；表单隐藏字段 `_csrf` = HMAC-SHA256(口令, 固定标签)，常数时间比较；只接受 `application/x-www-form-urlencoded`（≤512 KB），技能上传为 multipart（≤20 MiB）。成功后 303 回原页并带 `?ok=<代码>` 提示。
- **只读 JSON 接口**（`/api/agents/*`、`/api/memory/*`、`/agents/stream`）：只接受 GET（其余 405 并带 `Allow: GET`；记忆条目的遗忘 / 恢复除外，见 §8.4），错误统一为 `{error}`；先整体脱敏（`redactSessionValue` / `redactText`）再裁剪，编码后超过 1 MiB 返回 413，不静默丢数组项。时间一律 Unix 毫秒；字符上限按 UTF-16 计、不拆代理对。
- **渲染**：服务端文本一律先脱敏再转义；客户端只改 `textContent` / `dataset` / `className`。
- **SSE**：`/live/stream`、`/usage/stream`、`/logs/stream`、`/agents/stream` 共用 20 个连接上限（超出 503），15 秒心跳；帧经写队列按序写出，`write()` 返回 false 时等 `drain`，只有待写字节超过 2 MB 或一次 `drain` 等待超过 10 秒才断开该客户端。

## 2. 页面

顶栏：总览 · Agent · 记忆 · 上下文监控 · 回合 · 实时 · 定时任务 · 技能 · 设置（日志、配置从设置页进入；`/context` 归入记忆）。手机宽度（≤720px）导航改为横向滚动的第二行，表格隐藏次要列，375px 下无横向滚动。

| 路径 | 内容 | 写操作 |
|---|---|---|
| `/` 总览 | 依赖信号灯、1h / 24h 回合吞吐（结束 / 失败或中断 / 开轮输入，按 `in:` 键去重）、并发与排队、工作中会话数、全部线程的迷你占用条、当前设置、最近一分钟指标 | — |
| `/live` | 每个会话一行（§3），SSE 推送 | `POST /thread/stop` |
| `/turns` | 聊天视图：左侧有回合的会话（最近活动在前），右侧选中会话的聊天记录（`?thread=`，缺省最近活动的会话）。收到的输入（用户消息、定时任务，定时任务另标）在左，本轮 `send_message` 在右，按回合成组、最新在下；每组的状态、设置、耗时、请求 / 工具 / 发送计数折叠在气泡之间，展开时读 `/turns/:id?part=1`（回合详情正文片段）。每页 50 个回合，顶部"加载更早"取 `?page=n&part=1` 片段插到上方 | — |
| `/turns/<回合 id>` | 回合详情：印章与元数据（会话、种类、发送者、后端、设置快照、耗时、原因）→ 输入 → 发送 → 工具调用 → 子 agent 活动 → 错误 → 分页时间线；最后一个模型回合行按请求列缓存命中（§5）；进行中显示排队数、子 agent 数与停止按钮 | `POST /thread/stop` |
| `/inputs/<入站键>` | 一条输入的流转：收到 → 入队 → 开轮设置 → 送达所在回合（链到回合页）；改造前以入站键本身为键的旧事件也在这里显示 | — |
| `/conversations/<会话键>` | 当前状态（空闲 / 工作中、当前回合、排队输入、在跑子 agent、占用条、停止）与最近回合（分页） | `POST /thread/stop` |
| `/tickets`、`/tickets/<键>` | 旧地址，301：列表 → `/turns`；`turn:<id>` → 回合页，`in:<键>` 与旧版入站键 → 输入页，`thr:<会话键>` → 会话页；`@` 系统键 404 | — |
| `/agents` | 顶部"拓扑"概览：每个会话一张卡，主 agent 一行（会话、后端、状态），未结束的子 agent 是小节点，已结束的合成一个计数（完成 / 失败 / 停止）；空闲且没有子 agent 的会话折成一行。页面可见时每 3 秒取 `/agents/topology` 概览片段刷新（不读会话正文）；展开一张卡时才读 `/agents/topology/:thread`（主 agent 最近动作，以及全部子 agent 的任务、最近动作、结果与"查看过程"链接），已展开的卡在刷新后保持展开；下方 Codex / Pi 两张卡：活动 / 归档会话数、索引进度、每条线程的占用条与"监控"链接 | `POST /{codex,pi}/{reset,compact}`、`POST /thread/stop` |
| `/agents/<后端>/sessions[/…]` | 会话 → 回合浏览与上下文分析（§6、§7）；`/codex`、`/pi` 303 到对应会话列表 | — |
| `/context-usage` | 上下文监控（§5） | — |
| `/memory[/…]` | 记忆：总览、时间线、摘要、检索检查器、召回记录、图片、归档、记忆条目、画像、记忆任务（§8） | `POST /memory/entries/<id>/{forget,restore}`、`POST /memory/profile/<ns>`、`POST /memory/proposals/<id>/{accept,reject}`、`POST /memory/consolidate/run`、`POST /memory/consolidate/<batch_id>/rollback` |
| `/context` | 用 qq_context 工具浏览 / 检索消息库（与模型看到的格式一致） | — |
| `/schedules`、`/schedules/<id>` | 定时任务（§2.3） | `POST /schedules/<id>/{pause,resume,run,delete}` |
| `/skills`、`/skills/<名称>`、`/skills/<名称>.zip` | 技能列表（含诊断）、SKILL.md 与目录文件、zip 下载（[ARCHITECTURE.md](ARCHITECTURE.md) §7） | `POST /skills/upload`、`POST /skills/<名称>/delete` |
| `/settings` | 运行时设置、发送规则与熔断、授权、codex.md、codex 基础指令、agent.md、最近变更（§2.1、§2.2） | 见 §2.1 |
| `/logs` | 最近 1000 行结构化日志 + 实时尾随（`/logs/stream`），按键（日志行 `key` / `thread` / `turn` 字段前缀）或级别过滤 | — |
| `/config` | 启动时生效配置（脱敏）与 agent.md 当前内容 | — |
| `/codex/agents-md` | 当前全局 `$CODEX_HOME/AGENTS.md`（受管规则 + codex.md）的只读脱敏全文 | — |

### 2.1 设置

- **运行时设置**（`POST /settings`）：`${DATA_DIR}/settings.json`（`{version:1, settings:{…}}`，原子写，zod 严格校验）覆盖 `.env` 默认值：`agentBackend`、`backendOverrides`、`codexModel`、`codexReasoningEffort`、`piModel`、`piThinkingLevel`、`alertOwner`（发送规则 `sendRules` 与记忆抽取开关 `memory` 各有独立表单，见下）。模型下拉来自 magpie 目录，档位含 `auto`。后端、模型与档位在开轮时冻结为本轮设置快照（记在首条输入的 `admitted` 与回合的 `dispatched` 事件，回合页显示）；告警开关现读。旧文件中的 `codexReplyMode` 读取时剥离。
- **记忆抽取与整理**（`POST /settings/memory-extract`）：同一表单两组开关。`memory.consolidate` 为夜间整理开关（缺省开，[MEMORY-DESIGN.md](MEMORY-DESIGN.md) §9）：表单带隐藏字段 `consolidate_field` 时按复选框 `consolidate` 保存，不带时保持原值；`memory` 按字段合并，只改一组开关不会把另一组复位。`memory.extract` 为各命名空间的回合后抽取开关（[MEMORY-DESIGN.md](MEMORY-DESIGN.md) §8.1）。每个出现过的命名空间一行（宿主见过的会话键、已有记忆的命名空间与已保存的键，owner 在首行）；没有键的命名空间只有 `owner` 开启。表单以隐藏字段 `ns` 列出本次的命名空间、勾选的为 `extract:<ns>=on`，保存只改列出的键，其余保留；只存与缺省不同的覆盖项（owner 缺省开、其余缺省关，等于缺省的键删掉，所以提交再多关闭的命名空间也不会撞 500 项上限）；命名空间不合法 400。抽取器每次现读。
- **发送规则**（`POST /settings/send-rules`）：`sendRules` 的五项数值（每会话每分钟 / 每小时、会话熔断分钟、全局每分钟、全局熔断分钟），每次发送前现读；当前熔断可在同一节解除（`POST /settings/send-breakers/reset`，记 `send_breaker_reset`）。
- **授权**（`POST /settings/grants/{add,revoke}`）：显示用户、send / schedule 能力、目标 ref、来源 scopes、授权者及有效 / 已过期。添加替换该用户的整条授权（目标留空 = 不能主动发送，来源留空 = 任何会话，时效留空 = 长期）；撤销删除整条。持有面板口令者代表 owner，未配置 owner 时只展示。变更记 `auth_changed`（`source=panel`）。
- **codex.md**（`POST /settings/codex-prompt`）：经 `CodexPromptStore`（`read()` / `save(custom, revision)` / `subscribe()`）读写；提交前 CRLF / CR 规范为 LF；revision 不符 → 409"已在别处被修改"，存储拒绝（为空、超过 64 KB、含凭据样式内容）→ 409 并显示脱敏后的原因。当前内容含已注册秘密时只读展示脱敏版。受管段只读折叠，完整 AGENTS.md 在 `/codex/agents-md`。`prompt_changed`（`target: "codex"`）只由面板对存储的唯一订阅写入。
- **codex 基础指令**（`POST /settings/codex-base-prompt[/restore]`）：编辑当前 `codexModel` 的 `DATA_DIR/prompts/codex-base/<slug>.md`，显示是否与目录默认不同及自动追加的 QQ 受管规则。校验 CSRF、模型（模型已变 → 409）和文件 revision；下一轮生效（含已有线程）；记 `prompt_changed`（`target: "codex-base"`）。Codex 升级不会更新已播种文件，用"恢复目录默认"。
- **agent.md**（`POST /settings/agent-md`）：固定路径，目录与文件均拒绝软链接，LF 规范化，≤64 KB，临时文件 + rename；隐藏字段 `revision`（mtime + 大小摘要，不存在为 `none`）不符即 409；含已注册秘密时只读展示且拒绝覆盖。记 `prompt_changed`（`target: "pi"`）。
- 所有设置变更写 `settings_changed`（trace 键 `@settings`，含前后值与来源）。

### 2.2 线程重置、压缩与停止

- **重置**（`POST /codex/reset`、`POST /pi/reset`，表单 `key` 为会话键）：排在该线程的回合队列之后，不打断进行中的回合；最多等 1.5 秒，否则提示"已排队"。旧会话归档，下一条消息新建；记 `thread_reset`（`@codex` / `@pi`）。
- **压缩**（`POST /codex/compact`、`POST /pi/compact`）：保留摘要、清理活动上下文中的旧工具输出与图片，会话 ID 不变，磁盘历史不删。codex 在会话空闲时经常驻 app-server 发 `thread/compact/start`（会话忙则失败，最长等 5 分钟）；pi 调 `conv.compact()` 并检查任务终态。最多等 1.5 秒，跳回 `/agents?ok=compacted|compactQueued|unchanged|compactFailed`；成功记 `thread_compacted`。
- **停止**（`POST /thread/stop`）：中止会话当前回合与子 agent，排队的输入随后照常开轮；记 `thr:<会话键>` 的 `thread_stopped`。`return` 只接受 `/live` 或 `/conversations/<该会话键>`，其余回 `/agents`。

### 2.3 定时任务

面板身份即 owner：支持查看全部任务及详情、暂停、恢复、立即运行和删除；创建与修改任务在聊天里让 agent 通过 `schedule_create`、`schedule_update` 完成。未配置 owner 或未接入 ScheduleService 时只显示未启用。表单 POST 与 JSON 接口使用同一套校验，失败时在列表或详情页显示错误提示，任务不存在时回到列表。时间均按北京时间显示，群名来自 `scope_names`。删除用页内展开的确认按钮。

JSON 接口 `/api/schedules`：`GET` 返回 `{schedules, csrf}`；`POST /api/schedules/<id>/{pause,resume,run,delete}` 只接受 `application/json`（≤64 KiB），CSRF 令牌放 `X-CSRF-Token` 头或 `_csrf` 字段。

## 3. 实时视图（`src/obs/live.ts`）

```
ThreadHost / TurnMonitor / Inbox / 两个后端 / send_message
        │ trace.event(key, stage, {status, detail})   key = in:<入站键> | turn:<回合 id> | thr:<会话键> | @系统
        ▼
Trace ──tap──▶ LiveBus（内存：每会话一行，当前回合的阶段栈与事件流，已脱敏）──▶ /live/stream（SSE）──▶ live.js
  │              ▲ 会话宿主只读快照（每 5 秒，仅有订阅者时；页面渲染与 SSE 首帧前各取一次）
  │              │ 排队输入键、子 agent 数、会话后端、重启后仍在进行的回合
  └──append──▶ ObsStore（events.key：回合、输入与会话的时间线、指标）
```

- **会话行**（`LiveConversation`）：`thread`、`label`（群名）、`backend`、`state`（`working` / `idle`）、`turn`（当前回合）、`queued`（排队的入站键）、`subagents`（在跑子 agent 数；后端未知为 null，不显示）、`recent`（最近 5 个完成的回合，不带事件流）。
- **当前回合**（`LiveTurn`）：`id`、`kind`（user / scheduled / wake）、`sender`、`started`、`inputs`（开轮与插话的输入，正文前 500 字）、`sends`（本轮 send_message：目标、正文前 200 字、状态、是否系统消息，最多 20 条）、`tools`、`phase` 与事件流 `items`。结束后 `outcome` 为 completed / failed / lost；被唤醒回合取代的旧回合记 `superseded`。
- **事件归属**：`in:` 的 received / queued / delivered 维护输入正文与排队集合；`turn:` 事件按 `dispatched` / `received` 带出的会话键归属，未知的先暂存（每回合 80 条、最多 100 个回合、半小时过期）；`thr:` 事件（停滞、停止）进当前回合事件流；`@` 键与旧版键不进实时视图。重启前的回合只剩终态、或已结束回合的迟到事件，不重开会话行。
- **子 agent 数**：pi 取会话 `SubagentDoc` 中未停止且有未结束汇报的子 agent；codex 取 app-server `subAgent` 通知维护的在跑子线程数；经 main.ts 的宿主快照汇总。
- **SSE 帧**：`snapshot`（`{now, count}`，页面据此清空）→ 全部占用记录的 `context` → 每会话一帧 `snapconversation`（带当前回合事件流，逐会话脱敏，总数 ≤300）→ `snapshot_end`；随后增量 `conversation`（`{conversation, item?}`）、`remove`（`{thread}`）、`context`（`{usage}`）。服务端先订阅再取快照，期间的增量排在快照后（客户端按回合 id 与事件 `seq` 去重）；每回合只保留最近 80 条事件。
- **淘汰**：空闲、无排队、无在跑子 agent 的会话在最后活动半小时后推 `remove`（每分钟检查）。
- 页面不轮询；唯一的定时器在浏览器本地刷新"已耗时 / 空闲"文字。

```
/live  实时会话                                         ● 实时连接中
   ┆│[工作中] 群 家庭群(200000001) (Pi) (用户消息 · 阿杰)  已耗时 1 分 31 秒│
   ┆│ ▬▬▬▬▬▬▬▬┃▬▬┃░░ 78% 100k / 128k                               │  ← 单行占用条
   ┆│ (本轮输入 2)(已发消息 1)(工具调用 3)(子 agent 1)(排队 1)         │
   ┆│ 阿杰：能不能帮我查查明天上海的天气                               │
   ┆│ ● 当前：工具 fetch_page   1 分 4 秒                           │
   ┆│ +8.0秒  工具 web_search 开始 query 上海 明天 天气              │
   ┆│ → qq:group:200000001 明天上海多云转晴…                          │  ← 本轮已发消息
   ┆│ 回合详情  [停止]      ▸ 最近完成 3 个回合                       │
   ┆└ 左缘虚线：蓝 = 工作中，灰 = 空闲
```

## 4. 上下文占用条

数据由 `src/agent/context-usage.ts` 的 `ContextUsageStore` 维护（每线程一条 `ContextUsage`，持久化在 `data/context-usage.json`），面板只用 `all()` / `get(backend, key)`。组件 `contextBar(backend, key, usage, {mini?})`（`src/obs/ui/context-bar.ts`）与客户端 `ctxApply`（`usage.js` / `live.js`）产生同一结构：标签、`已用 / 窗口 tokens`、百分比、`role=progressbar` 轨道、回合数 / 缓存命中 / 压缩阈值 / 更新时间。

- 分档：<60% 蓝、60–85% 琥珀、>85% 朱红；pi 记录带 `compaction` 时画后台压缩与阻塞压缩两道刻口；`source=estimate` 斜线虚填；超过 24 小时褪色；无记录显示占位，SSE 到达后原地换成完整条。
- codex 优先用有效窗口 `effectiveWindowTokens`（已完成回合 rollout 的 `model_context_window`），提示同时显示名义值；无有效值时用名义窗口。新线程或名义容量变更后丢弃旧有效值。
- 实时：每次更新写观测事件 `context_usage`（detail 即记录）→ `LiveBus` 推 `{type:'context', usage}` → `/live/stream` 与 `/usage/stream` 的 `event: context`。`/usage/stream`（总览、Agent 页、会话页）首帧发全部记录，之后只推增量。
- 排序：总览 codex 在前，同后端按占比降序。脱敏：`key` 只有取值为 `owner` / `shared` / `group:N` / `private:N` 时才不被当作密钥隐藏。

## 5. 上下文监控（`/context-usage`）

按线程展示最近若干次模型请求的输入占用：一根竖条一次请求，同一回合的请求相邻成组（按钮），高度 = 占窗口比例，条内分缓存命中 / 未命中两段；异常的缓存未命中标红并给出原因推断。点一个回合组在下方面板查看该回合的会话、发送者、原文与回复摘要、每次请求的命中，并链到回合页（`/assets/context-usage.js` 只切换 `hidden` / `aria-*`；无脚本时明细表是完整信息）。页面不实时推送，刷新即更新。

- **参数**：`?backend=`、`?key=`（单线程）、`?limit=`（每线程请求数，默认 40，≤200）、`?miss=` / `?partial=`（0–1，仅展示时覆盖阈值）。
- **数据**（`ObsStore.contextSeries`，纯函数 `analyzeContextTurns` 在 `src/obs/context-turns.ts`，类型在 `src/shared/context-turns.ts`）：每次模型请求一条 `model_request` 事件（detail `{backend, key, trace_key, seq, turn, input, cached, output, window, effective_window?, at}`，记在所属回合的 trace 键下）；`context_usage` 中 `source=compact` 的记录作为压缩分隔；没有 `model_request` 的旧数据回退用 `source=turn` 的 `context_usage`（视为单请求回合），`@` 键下的启动回填快照排除；`estimate` 跳过。
- **判定**（对每条请求，基准为同线程上一条请求 `prev`）：`prev.used < 4096` 不判定；上一条是压缩 → `compact`；线程重置后第一个回合的首个请求 → `reset`；无 prev → `first`；否则 `ratio = cached / min(prev.used, 本次输入)`，`< 0.5` → `miss`，`< 0.9` → `partial`。
- **原因**（miss / partial 才给，可多条）：两次请求之间有改 `codexModel` / `piModel` / `agentBackend` 的 `settings_changed` → "切换模型"；`prompt_changed` → "提示词变更"；间隔超过 60 分钟 → "间隔 N 分钟"；窗口不同 → "窗口变化"；都没有 → "未知（可能是服务端缓存过期或驱逐）"。
- 汇总表：每线程当前占用条、最近 24 小时回合数 / 请求数 / miss 数 / 平均命中率。回合页的模型回合行用同一判定（`ObsStore.previousContextTurn` 取该回合之前最近一条请求作基准）。

## 6. Agent → 会话 → 回合

以后端事实源浏览会话：codex 读 rollout JSONL（`/data/codex/sessions/**`），pi 读 pi-durable 公开接口；ObsStore 只补宿主回合关联与送达状态，不作正文来源。适配器在 `src/obs/sessions/`，统一模型 `SessionRef` / `TurnIndex` / `Block` / `ContentRef` / `Usage` 见 `src/obs/sessions/types.ts`。

| 页面 | 内容 |
|---|---|
| `/agents/<后端>/sessions?status=&scope=&since=&page=` | 活动与归档会话（真实 ID），按更新时间倒序 |
| `/agents/<后端>/sessions/<id>?page=` | 左侧回合目录、右侧回合流（最新在上）；活动会话订阅 `/agents/stream` 追加新块 |
| `/agents/<后端>/sessions/<id>/turns/<回合>` | 输入 → 模型请求（可多次，带实测 usage）→ 工具调用（参数 / 结果折叠，按 call_id 配对）→ 助手文本 → 送达；"记忆调用"区（§8.2） |
| `/agents/<后端>/sessions/<id>/context?at=&phase=` | 上下文结构分析（§7） |
| `/agents/<后端>/sessions/<id>/content?offset=&length=&page=` | 大正文全文页，每页 256 KiB；codex 另支持 `?bundle=&payload=&select=` 读官方 trace 正文 |
| `/api/agents/topology` | 拓扑 JSON：会话列表与主 agent 状态取会话宿主；子 agent 由后端给出（pi 读子 agent 登记，codex 记 app-server 的 `subAgentActivity` 与 `spawnAgent` 条目，随进程不持久化）；最近动作取各自会话最后一个回合里最后一个可描述的块；整体按会话正文规则脱敏。`?brief=1` 不读正文、不带任务与结果；`?thread=<会话键>` 只返回该会话（没有时 404） |

子 agent 的会话在会话列表里标为"父会话 › 名称"并跟随父会话的会话域与活动状态（活动父会话的子 agent 可实时订阅）：pi 按子 agent 登记，codex 按 rollout `session_meta.source.subagent.thread_spawn.parent_thread_id`。

回合的上下文占用取回合内最后一次带实测 usage 的模型请求的输入；回合级 `usage` 是全部请求的累加。

**接口**（全部 GET）：

| 路由 | 返回 |
|---|---|
| `/api/agents` | `[{backend, sessions_active, sessions_archived, last_turn_at, indexing: {indexing, files, done}}]` |
| `/api/agents/<后端>/sessions?status=active\|archived&scope=&since=&page=` | `SessionRef[]`；每页 50，page 从 0 起（≤1,000,000）；`since` 为毫秒或 ISO 时间 |
| `/api/agents/<后端>/sessions/<id>` | `{session, turns}`；`turns` 为 `ObservedTurn[]`：`TurnIndex` + 关联的宿主回合 `traceKey`（`turn:<id>`）+ `delivery: {status, scope?, duration_ms?}` |
| `/api/agents/<后端>/sessions/<id>/turns/<回合>` | `{turn, blocks}` |
| `/api/agents/<后端>/sessions/<id>/content?offset=&length=` | `{text, truncated}` |
| `/api/agents/codex/sessions/<id>/trace-content?bundle=&payload=&select=` | `{text, truncated}`（官方 trace 载荷正文；三个参数各一次） |
| `/api/agents/<后端>/sessions/<id>/context?at=&phase=` | `ContextAnalysis`（§7） |
| `/agents/stream?backend=&session=` | 活动会话的 SSE，`event: block`，`{session, turn, block}`；归档会话 409，单块超限发 `event: error` 后断开 |

- 会话与回合 ID 逐段 URL 编码（≤256 字符，不含 `/`、`\`、控制符）。非法参数 400，未知资源或尚未索引的会话 404。
- 正文 ≤8 KiB 内联 `text`，否则返回 `preview` + `ref`。`ContentRef.offset/length` 是适配器签发的**脱敏正文虚拟 UTF-8 字节区间**，不是磁盘偏移；请求区间须落在一个已索引正文块内，重建索引后旧 ref 可能失效（409）。正文先整体脱敏再截取，UTF-8 切片不拆汉字。
- 宿主回合关联只用派发时的真实会话 ID（codex `thread_id` / pi `conversation`）与相邻回合时间窗口（±120 秒），歧义时不附加。
- **索引**：codex 在 `observability.sqlite.session_index` 保存文件身份、大小、mtime、首尾指纹、回合 / 行偏移与用量；未变化不重解析，可信追加从上次位置继续，截断 / 替换 / 改写重建；单行最多解析 4 MiB；基础指令作为独立块索引（可懒加载）。pi 走公开 `scanConversations` / `entries` / `context` / `watchEvents`，索引在进程内，重启重建。SSE 无 `Last-Event-ID` 重放：断开后重取快照再订阅。codex reasoning 只公开摘要，加密体标"不可用"。

## 7. 上下文结构分析

入口 `src/obs/context/index.ts` 的 `analyzeContext`，HTTP 为 `GET /api/agents/<后端>/sessions/<id>/context?at=<回合>&phase=before|after`（参数不可重复；省略 `at` 为最后回合之后，`phase` 缺省 `after`）。返回 `ContextAnalysis`（`src/obs/context/types.ts`）：`window {tokens, source, nominalTokens?}`、`measured`（实测输入、缓存、是否 `stale`）、`estimated`（o200k 估算总计）、`unexplained`（实测与估算的差额，可为负）、六类构成 `categories`（指令 / 工具 / 历史 / 工具输出 / 压缩 / 其他）与逐消息 `messages`，每项带来源标签 `recorded` / `reconstructed` / `estimated` / `unavailable`。

- **时点**：`before` = 该回合用户输入及首次模型输出前的窗口；`after` = 该回合结束后、下一回合开始前。
- **codex**：优先官方 trace（`manifest.json` → `trace.jsonl` → `payloads/*.json`，按线程与真实 turn ID 关联，增量请求沿 `previous_response_id` 回溯），给出精确请求与实测用量；未知格式、链不完整、超限或请求后发生压缩 / 回滚时回退到 rollout 重建：选回滚后存活的压缩检查点，以 `replacement_history` 为基线重放后缀，工具配对规范化与模态过滤按上游顺序。当前受管 AGENTS 与自定义提示标 `reconstructed`；rollout 记录的基础指令标 `recorded`；工具定义按名字估算标 `estimated`。实测取阶段边界后最近的 `token_count`，跨压缩 / 回滚标 `stale`。
- **pi**：公开 `context(id, at)` 的 `ContextView`、`getCurrentSystemPrompt` / `getCurrentTools`；实测为最后 assistant usage 的 input + cacheRead + cacheWrite；`estimateMessageTokens` 对照写在 notes。
- **估算**：`js-tiktoken` + `o200k_base`（本地依赖），每条约 4 token 角色开销，单条 ≤2 MiB；词表不可用时明确报告回退。类别只计可见部分，部分不可用时单列 `unavailable_items`，不把未知占用当作零。
- **窗口**：优先 rollout 记录的窗口，其次配置或占用存储，均无时回退 codex 400000 / pi 200000 并标 `source: default`；有同域 codex 名义窗口时另返回 `nominalTokens`。
- **安全与上限**：预览 ≤240 字、先脱敏；不输出密文、媒体二进制或索引文件绝对路径；引用只由适配器签发。超过 1 MiB 时先把预览缩到 80 字再截断消息表并加说明，类别统计保持完整。无效参数 400，未知回合 404。

## 8. 记忆

数据来自消息库（只读连接）与观测库；页面在服务端内部调用同一组 `/api/memory/*` 路由，与浏览器拿到的是同一份脱敏 JSON。接口参数未知、重复或非法为 400，不存在为 404，工具或归档不可用为 503。类型见 `src/obs/memory/types.ts`。

| 页面 | 内容 |
|---|---|
| `/memory` | 各会话域的消息 / 摘要计数、时间范围、体量、待生成日摘要、媒体数；整理状态（上次 / 下次、运行中、需补跑）与保留期；记忆抽取状态（§8.5）；24 小时召回计数、图片总数 |
| `/memory/scopes/<scope>?from=&to=` | vis-timeline 三轨时间线（原文桶 / 日摘要 / 周摘要）、空白区与保留边界，下方消息列表（点桶切换） |
| `/memory/summaries/<id>` | 摘要正文、区间、尚存原文数、血缘版本与被替换的日摘要快照 |
| `/memory/search?scope=&q=&days=&limit=` | 检索检查器：数据库命中与 `qq_search` 工具实际返回文本对照、关键词高亮 |
| `/memory/recalls`、`/memory/recalls/<id>` | 召回记录与三级证据（§8.2） |
| `/memory/images`、`/memory/images/<scope>/<message_id>/<ordinal>` | 图片画廊与详情（§8.3） |
| `/memory/archives` | 重置归档的 Codex / Pi 会话（链到会话页）与 Pi 压缩记录 |
| `/memory/entries?ns=&kind=&status=&q=`、`/memory/entries/<id>` | 记忆条目列表与详情，可遗忘 / 恢复（§8.4） |
| `/memory/profile/<ns>`（`/memory/profile?ns=` 同） | 画像编辑器：当前 `profile.md`、revision、大小与上限，保存走 CAS（§8.6） |
| `/memory/jobs` | 记忆任务：回合后抽取状态、夜间整理报告（上次 / 下次 / 各步计数）与立即运行、待确认画像提议（当前画像与建议并排，采纳 / 拒绝）、最近 10 个整理批次与回退（§8.6） |

### 8.1 消息库接口

- `GET /api/memory` → `{scopes: ScopeSummary[], aging: {last_run, last_report?, next_run, running, catch_up_needed}, retention: {rawDays, summaryDays, hardMaxDays, dailyHour, tz}}`。`label` 规则：`owner` → `owner 私聊`、`group:N` → `群 N`、`private:N` → `私聊 N`。`bytes_estimate` 是 `sum(length(text))`，不是文件大小；`pending_day_summaries` 与整理器口径相同（今天之前、当日 ≥5 条、未被摘要覆盖）。`catch_up_needed` = 从未成功运行或已过 24 小时。
- `GET /api/memory/scopes/<scope>?from=&to=` → `{scope, label, range, retention_edges: {raw_until, day_until, week_until}, tracks: {raw, day, week}, gaps}`。`from` / `to` 接受毫秒、`YYYY-MM-DD`（UTC）或带时区 ISO；区间 `[from, to)`，缺省覆盖全域。区间 ≤3 天按小时桶、≤60 天按日桶、否则按周桶（按 `tzOffsetSec` 对齐，周一起）；只返回非空桶（`count`、不同发送者数、≤80 字摘录）。保留边界是配置推算，不是删除证明；早于所有层保留边界的空白标 `purged`，其余 `no_records`。每类最多 10,000 项，超出 413。
- `GET /api/memory/scopes/<scope>/messages?before=&before_id=&after=&after_id=&limit=` → `{items, next_before?, next_before_id?}`，按 `(time DESC, id DESC)`；`limit` 1–200（默认 50）；正文脱敏后 ≤2000 字（超出带 `truncated: true`）。续页把 `next_before` / `next_before_id`（messages 表主键）原样传回，同秒消息不重不漏；`*_id` 必须与对应时间同时给出。
- `GET /api/memory/summaries/<id>` → `{id, scope, kind, period_start, period_end, created_at, text, surviving_raw, deleted?, lineage}`。`surviving_raw` 是同域同区间当前尚存的原文数。`lineage` 为 `{versions, replaced}`（`summary_versions` 表：每次整理一个 `batch_id`，记模型 / provider / usage、实际输入的消息或日摘要 ID、`input_chars` / `kept_chars`、原文 SHA-256；`replaced_by` 指向替换它的版本 ID）；无版本记录为 null，不代表没有来源。日摘要被周摘要合并删除后，只要版本还在仍返回 200 并带 `deleted: true`。
- `GET /api/memory/search?scope=&q=&days=&limit=` → `{hits, tool_text, tool_text_chars, max_chars, dropped}`。`q` 截前 100 字、不可为空；`days` 1–180（默认 30）；`limit` 1–20（默认 10）；缺省 scope 为管理员全域视角（不代表某次会话的读取范围）。`hits` 来自 `ContextStore.search`（新到旧，无相关性分数）；`tool_text` 是**实际调用** `qq_search` 工具的输出再脱敏，`dropped` 为命中但未进入工具文本的条数。工具先裁剪留下凭据残片时整行替换为 `[已隐藏：原文含跨裁剪边界的凭据]`。
- `GET /api/memory/archives` → `{codex: ArchiveRow[], pi: ArchiveRow[], compactions}`：读 codex 与 pi 的重置归档 JSONL 末尾 200 行（文件缺失为空、损坏 503、每文件 ≤4 MiB）；`compactions` 按 conversation 聚合观测库 `compaction` 事件（`attempts` 是事件数，不等于成功次数）。

### 8.2 召回记录

模型每次调用 `qq_recent` / `qq_search` / `qq_message` 都写一行 `recall_events`（观测库；pi 在主进程内写，codex 由 `qq_context` MCP 用独立 WAL 连接写，写失败只告警）：`backend`、`turn_id`（宿主回合 id）、`session`（codex 线程 ID / pi conversation ID）、原始参数、`access`、`scope_hint`、按实际进入工具文本的顺序记录的命中引用（只存 ID，不存正文）、`returned_count` / `dropped_count`、`chars` / `max_chars`、耗时、是否出错。

- `GET /api/memory/recalls?scope=&session=&turn_id=&backend=&tool=&since=&page=&turn=` → `{items: RecallEvent[], page, has_more}`，每页 50，按 `(ts DESC, id DESC)`。`scope` 匹配 `scope_hint`；`turn` 必须与 `session` 同给，按该会话回合（§6）的时间窗筛选（下界 = max(回合开始 −120 秒, 上一回合开始 +1)，上界 = min(回合结束或开始 +120 秒, 下一回合开始 −1)）。每条带 `turn_href`（链到 `/agents/<后端>/sessions/<id>/turns/<回合>`，定位不到为 null）。
- `GET /api/memory/recalls/<id>` 另带 `evidence` 三级证据：① `hits`：命中引用在当前库里的时间与 ≤240 字预览（已删除只给 `deleted: true`，不能重建当时正文）；② `tool_returned`：调用当时记录的条数、字数与丢弃数；③ `in_request`：在该回合正文里找同名工具（codex 也认 `mcp__qq_context__…`）、参数严格等价、时间差 ≤120 秒且有 callId 的调用，结果为 `confirmed` / `not_found` / `unavailable`。第三级只证明回合里出现了这次调用，**不等于结果进入了后续请求或被模型采用**。
- 回合页"记忆调用"区用 `session` + `turn` 查询；接口出错只降级为一行提示。

### 8.3 图片记忆

画廊只展示模型通过 `qq_image` 召回并入库的图片（`message_media`），浏览不会触发下载或召回。

- `GET /api/memory/images?scope=&status=ok|skipped&since=&page=` → `{items: ImageItem[], page, has_more, totals: {ok, skipped, bytes}}`，每页 50，按消息时间倒序；`totals` 覆盖整个筛选结果（`bytes` 为现存文件之和，按记录重复计）。`mime` / `width` / `height` 恒为 null（库里没有，不解码推测）。`present` 表示登记的文件在 `DATA_DIR/media` 下且不是链接；ok 且 present 时 `href` / `thumb_href` 为 `/media/<sha256>`。
- `GET /api/memory/images/<scope>/<message_id>/<ordinal>` → `{item, message, other_media, timeline_href}`（同消息其它媒体按 ordinal；时间线链接为消息前后各一小时）。
- `GET /media/<sha256>`：只接受 64 位十六进制；路径必须在 `message_media` 登记且位于媒体目录，经媒体读取器校验路径、链接、大小（≤10 MiB）、文件头与哈希；按魔数返回 png / jpeg / gif / webp（其他 415），`Cache-Control: private, max-age=3600`。

### 8.4 记忆条目

数据来自记忆库 `memory.sqlite`（[ARCHITECTURE.md](ARCHITECTURE.md) §9.1），面板是管理员视角：可见全部命名空间与状态，与某次会话的读取范围无关。类型见 `src/obs/memory/types.ts`，接口在 `src/obs/memory/entries.ts`。

- `GET /api/memory/entries?ns=&kind=&status=&q=&page=` → `{items: MemoryEntry[], total, page, has_more, namespaces}`，每页 50，按更新时间倒序。`ns` 为 `owner` / `group:<id>` / `private:<qq>`，`kind` 五种之一，`status` 缺省为全部状态；`q` 截前 100 字，按空白切词、全部命中正文或 subject（与 `mem_search` 同一 FTS）。条目的时间字段为毫秒，`source` 为写入时本轮最后一条输入（会话、显示名、消息 id、回合 id、前后一小时的时间线链接），面板写入或无来源为 null。
- `GET /api/memory/entries/<id>` → `{entry, versions, links}`：`versions` 每次正文或状态变化一行（时间、操作者、前后状态、正文是否改动、原因），不返回快照正文；`links` 为取代链。不存在 404。
- `POST /api/memory/entries/<id>/forget`、`/restore`：只接受 `application/json`（≤4 KiB、不带其它字段），同源检查与 CSRF（`X-CSRF-Token` 头或 `_csrf` 字段）与 `/api/schedules` 相同，返回更新后的详情。遗忘只标 `forgotten`，不删行；恢复回到遗忘前的状态（取最近一次遗忘版本的前状态，查不到为 active），未遗忘的条目恢复为 409。操作者记为 `dashboard`，写 `@memory` 的 `memory_write` 事件。
- 页面：`/memory/entries` 筛选表单（命名空间、种类、状态、关键词）与表格，每行一个"遗忘"或"恢复"按钮；`/memory/entries/<id>` 显示元数据、正文、取代链与版本历史。按钮是表单 POST 到 `/memory/entries/<id>/{forget,restore}`（面板写操作的 cookie、同源与 `_csrf` 约束），成功 303 回详情页并带 `?ok=memoryForgotten` / `memoryRestored`。画像编辑与整理见 §8.6。

### 8.5 记忆抽取

回合后抽取（[ARCHITECTURE.md](ARCHITECTURE.md) §9.1）的运行状态在进程内存里，重启清零；每次结果另记回合的 `memory_extract` 事件（回合页可见，`turn:<id>`）。

- `GET /api/memory/extract` → `{model, available, queue, running, daily_limit, today: {date, counts}, recent}`：`available` 为抽取模型可用；`queue` 为排队条数（不含正在跑的），`running` 为正在处理的回合 id；`today.counts` 为今天（北京时间）各命名空间的模型调用次数，上限 `daily_limit`（200）；`recent` 为最近 10 次结果（最新在前）：`{turn_id, ns, at, status: ok|skipped|failed, reason?, candidates, written, superseded, dropped, ms}`，`reason` 为 `too_short` / `disabled` / `quota` / `queue_full` / `invalid_json` / `timeout` / `no_model` / `model_error` / `closed`（关闭超时后才返回），`dropped` 为按原因计数（`low_confidence` / `duplicate` / `secret` / `invalid_time` / `over_limit` / `supersedes_ignored` / `store_error`）。未接入时 404。
- `/memory` 首页"记忆任务"卡：模型、队列、今日次数与最近 10 次结果（链到回合页），并链到 `/memory/jobs`（§8.6）；开关在设置页（§2.1）。

### 8.6 画像与记忆任务

画像是 `${DATA_DIR}/memory/<ns>/profile.md`，夜间整理见 [ARCHITECTURE.md](ARCHITECTURE.md) §9.1；接口在 `src/obs/memory/jobs.ts`，类型见 `src/obs/memory/types.ts`。写接口与 §8.4 相同：只接受 `application/json`、同源与 CSRF（`X-CSRF-Token` 头或 `_csrf` 字段），多余字段 400。

- `GET /api/memory/profile/<ns>` → `{ns, ns_label, text, revision, updated_at, bytes, max_bytes, oversize, redacted_inside}`：`ns` 为 URL 编码的 `owner` / `group:<id>` / `private:<qq>`，其余 400；不存在为空文本、`revision: "none"`；`oversize` 为超过 4 KiB（不进入提示）；`redacted_inside` 为原文含凭据样式内容（页面只读展示脱敏版）。
- `POST /api/memory/profile/<ns>` `{text, revision}`（≤64 KiB）：整体替换，CAS；revision 不符 409 并带 `current: {text, revision}`；超限或含凭据样式内容 400。作者记为 `dashboard`，写 `@memory` 的 `memory_write`（`tool: dashboard_profile`，只记字节数）。
- `GET /api/memory/jobs` → `{extract, consolidate, proposals, batches}`：`extract` 同 `/api/memory/extract`（未接入为 null）；`consolidate` 为 `{enabled, running, available, model, last_run, next_run, last_report}`，`last_report` 为上次完成运行的报告 `{status, started_at, ms, batches, totals}`（每个批次：`ns`、`batch_id`、`dedup`、`conflicts`（`pairs` / `superseded` / `coexist` / `keep` / `protected` / `skipped?`）、`orphaned`、`retired`、`proposal`、`usage`、`ms`、`errors`），`next_run` 随衰老调度；`proposals` 为待确认的画像提议，带该命名空间的当前画像与 `stale`（画像在提议生成后已改过，采纳会 409）；`batches` 为最近 10 个有变更的整理批次（`changes`、`at`、`rolled_back`）。未接入 404。
- `POST /api/memory/proposals/<id>/accept`：以提议的 `based_on_revision` 做 CAS 写入画像，画像已变 409（先刷新对照）；`/reject`：标拒绝。不存在 404，已处理 409。
- `POST /api/memory/consolidate/run` → 202 `{result: started | running}`，不等结果；整理开关关闭时 409。
- `POST /api/memory/consolidate/<batch_id>/rollback` → `{batch_id, restored, skipped}`：未知批次 404，已回退或仍在运行 409；写 `@memory` 的 `memory_write`（`tool: consolidate_rollback`）。
- 页面：`/memory/profile/<ns>` 是表单 POST 到同一路径（字段 `content`、`revision`，CRLF 规范为 LF），成功 303 回画像页并带 `?ok=profileSaved`；失败时以原状态码（冲突 409、校验 400）重新渲染画像页，上面是当前内容与新 revision，下面保留提交的草稿（脱敏展示）。`/memory/jobs` 的采纳 / 拒绝、立即运行与回退是表单 POST 到 `/memory/proposals/<id>/{accept,reject}`、`/memory/consolidate/run`、`/memory/consolidate/<batch_id>/rollback`，成功 303 回 `/memory/jobs`，失败为带"返回"链接的错误页。

## 9. 观测存储与保留

- **事件**：`observability.sqlite` 的 `events` 表以 trace 键（`key` 列）存事件：`turn:<回合 id>`、`in:<入站键>`、`thr:<会话键>`、`@` 开头的系统键（`@settings`、`@codex`、`@pi`、`@context`、`@aging` 等）。回合聚合（`ObsStore.turns` / `turnBriefs`）只看 `turn:` 键：会话取终态或 received / dispatched 的 `thread_key`（pi 为 `conversation_key`），种类取 `kind`，结果取终态事件（`reply_sent` / `failed`，`terminal: true`）的 `detail.status`。
- **发送观测**：`send_message` 记在所在回合（不属于回合的系统消息记在 `thr:<会话键>`），含目标、正文前 500 字、message_id、图片数、文件状态与 already_sent，只记首次尝试；被发送规则拒绝的记 `send_rejected`；`final_answer` 为仅留存、未发出的最终回答。
- **上限**：每个普通 trace 键最多 `OBS_EVENT_CAP`（默认 500，8–10000；旧名 `OBS_TICKET_EVENT_CAP` 仍可用）条事件、detail 合计 256 KiB，为终态与丢弃摘要预留槽位；事件先脱敏，字符串最多 500 字。
- **保留**（每日清理）：普通事件与指标 `OBS_RETENTION_DAYS`（30）；管理事件（`@` 键与 `settings_changed` / `prompt_changed` / `thread_reset`）`OBS_ADMIN_RETENTION_DAYS`（365，不受单键上限）；`summary_versions` 与 `recall_events` `OBS_MEMORY_RETENTION_DAYS`（90，0 = 不清理；版本独立过期可能让 `replaced_by` 指向已清理版本）；codex 官方 trace `CODEX_TRACE_RETENTION_DAYS`（14，0 = 不开启新 trace）与总量上限 `CODEX_TRACE_MAX_MB`（512）。
- **列名迁移**（打开时一次性、幂等，同一写事务内 `RENAME COLUMN` 并重建索引，失败整体回滚、下次重做）：`events.ticket` → `events.key`（索引 `events_key`）；`recall_events.ticket` → `recall_events.turn_id`（索引 `recall_events_turn`，qq_context MCP 打开同一库时同样执行）；消息库 `messages.ticket` → `messages.outbox_key`（唯一索引 `messages_outbox_key`，只由主进程的读写连接执行）。`qq-bridge.sqlite` 的旧 `tickets` 表原样留在磁盘上，不再读写。
- **降级**：观测库不可用时为无操作存储，总览与 `/healthz` 显示 `degraded: true`，业务照常；召回接口 503，摘要详情仍返回聊天库正文（`lineage: null`）。

## 10. 设计令牌（`src/obs/ui/theme.ts`）

方向是"调度单"：冷灰蓝纸面、靛青墨水正文、复写纸蓝为唯一强调色；状态用描边"印章"；进行中的单据左缘是打孔虚线。

| 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--paper` | `#e8ecf1` | `#0e131b` | 页面底色 |
| `--sheet` / `--sheet-2` | `#fbfcfd` / `#f2f5f8` | `#151c27` / `#1b2431` | 卡片、表格、代码底 |
| `--ink` / `--ink-2` / `--ink-3` | `#17223a` / `#4d596e` / `#6f7a8e` | `#e3e8f0` / `#a3aec0` / `#7f8a9d` | 正文 / 次要 / 弱化 |
| `--rule` / `--rule-strong` | `#cdd4de` / `#a9b3c2` | `#283244` / `#3a4659` | 分隔线、边框 |
| `--carbon` | `#2b47b5` | `#8ea3ff` | 强调：链接、处理中、焦点环 |
| `--ok` `--fail` `--warn` `--queued` | `#1d7549` `#b42f27` `#9c620f` `#5d4fa6` | `#5cc48d` `#f2786e` `#e2a94b` `#b4a7f3` | 已完成 / 失败或中断 / 被唤醒取代 / 排队 |

- 字体：`"PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",…,system-ui`；等宽只用于 ID、代码与日志；数字启用 `tnum`。
- 字号 12.5 / 13.5 / 15（正文，行高 1.65）/ 18 / 23 / 30；间距 4 / 8 / 12 / 16 / 24 / 32 / 48；圆角 3（印章）/ 6（控件、单据）/ 10（面板）。
- `prefers-color-scheme: dark` 自动切换；动效只有处理中的脉冲点与新单据的一次高亮，`prefers-reduced-motion` 下关闭。
