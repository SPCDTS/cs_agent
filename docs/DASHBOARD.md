# 值守台（观测面板二期）

容器内 `127.0.0.1:8787`，服务端渲染 HTML + 原生 JS 模块（`/assets/live.js`、`logs.js`、`forms.js`、`usage.js` 等），无框架、无外部字体或 CDN。所有页面需要访问口令（`/data/obs-token` 或 `OBS_TOKEN`），首次以 `?token=` 登录后换成 HttpOnly cookie。

## 页面

| 路径 | 用途 | 写操作 |
|---|---|---|
| `/` 总览 | 工作中的会话数与排队输入数、上下文占用（全部线程）、依赖信号灯、1h/24h 回合吞吐（结束 / 失败或中断 / 开轮输入）、并发与排队、当前设置、最近一分钟指标 | — |
| `/live` 实时 | 每个会话一行（见下文"实时视图"），SSE 推送；工作中的会话可停止 | `POST /thread/stop`（`return=/live`） |
| `/turns` 回合 | 回合列表（trace 键 `turn:<id>` 的聚合），按状态（进行中 / 已完成 / 失败 / 中断）、会话键、种类（用户消息 / 定时任务 / 唤醒）、后端筛选，每页 50 | — |
| `/turns/<回合 id>` | 回合详情：印章与元数据（会话、种类、发送者、后端、设置快照、耗时、原因）→ 输入 → 发送 → 工具调用 → 子 agent 活动 → 错误 → 分页时间线（含缓存命中标注）；进行中的回合显示排队数、子 agent 数与停止按钮 | `POST /thread/stop`（`return=/conversations/<会话键>`） |
| `/inputs/<入站键>` | 一条输入的流转：收到 → 入队 → 开轮设置 → 送达所在回合（链到回合页）；同时读取旧版票据记在入站键本身下的事件 | — |
| `/conversations/<会话键>` | 会话页：当前状态（空闲 / 工作中、当前回合、排队输入、在跑子 agent、占用条、停止）与最近回合（分页） | `POST /thread/stop` |
| `/tickets`、`/tickets/<键>` | 旧票据地址，301 跳转：列表 → `/turns`；`turn:<id>` → 回合页，`in:<键>` 与旧版入站键 → 输入页，`thr:<会话键>` → 会话页；`@` 系统键 404 | — |
| `/logs` | 结构化日志实时尾随（SSE），按键（日志行的 `key` / `thread` / `turn` 字段前缀）或级别过滤 | — |
| `/context` | 用 qq_context 工具浏览/检索消息库 | — |
| `/codex` | owner / 共享线程：上下文占用条、id、rollout 大小、已观测回合、最近 10 轮摘要、全局 AGENTS.md | `POST /codex/reset` |
| `/pi` | 每个会话键的上下文占用条（含两道压缩阈值）、会话 id、最近活动、最近 10 轮摘要、压缩记录 | `POST /pi/reset` |
| `/codex/agents-md` | 当前全局 `$CODEX_HOME/AGENTS.md`（受管规则 + codex.md）的只读脱敏全文 | — |
| `/settings` | 运行时设置、授权列表与增删、编辑 codex.md、当前模型基础指令（含只读受管规则）与 agent.md、线程入口、最近变更 | `POST /settings`、`POST /settings/codex-prompt`、`POST /settings/codex-base-prompt`、`POST /settings/codex-base-prompt/restore`、`POST /settings/agent-md`、`POST /settings/grants/add`、`POST /settings/grants/revoke` |
| `/config` | 启动时生效配置（脱敏）与 agent.md 当前内容 | — |
| `/schedules` 定时任务 | 运行中 / 已暂停 / 已结束计数；任务表（名称、会话含群名、人话规则、下次触发、状态与暂停原因、最近运行、连续失败、操作）；新建表单 | `POST /schedules`、`POST /schedules/<id>/{update,pause,resume,run,delete}` |
| `/schedules/<id>` | 单个任务：完整提示词、规则与 RRULE 原文、超时、创建者、运行记录（新的在上）与编辑表单 | 同上 |

### 授权管理

设置页的“授权”一节显示用户、send / schedule 能力、目标 ref、来源 scopes、授权者及有效 / 已过期状态。添加会替换该用户的整条授权；目标留空表示不能主动发送，来源留空表示任何会话，时效留空表示长期。撤销删除整条授权；owner 回合的 auth_revoke 工具另支持按能力撤销。schedule 允许创建并管理自己的定时任务。

持有面板 OBS_TOKEN 的运维者代表配置的 owner；增删仍要求登录、同源和 CSRF 令牌，没有配置 owner 时仅展示列表。变更记入 auth_changed（source=panel，含前后差异）；工具变更为 source=tool。send_message 轨迹显示实际 target，便于核对跨会话投递。

### 定时任务

面板身份即 owner：列表显示全部任务，新建任务的创建者为 `qq:<owner>`；未配置 owner 或未接入 ScheduleService 时页面只显示未启用。表单 POST 与其他面板表单一样要求登录、同源与 CSRF，直接调用 ScheduleService（与 `/api/schedules` JSON 接口同一套校验）；校验失败时以错误提示重绘原页面并保留输入。

触发方式按北京时间填写：一次性（日期 + 时刻）；每天 / 每周（时刻 + 星期多选，不选为每天，换算为 `FREQ=DAILY` 或 `FREQ=WEEKLY;BYDAY=…;BYHOUR;BYMINUTE`，起点取当前整分钟）；自定义 RRULE 正文。编辑时规则未改动则不提交 rule，保留原起点；会话创建后不可改。会话下拉为 owner 私聊加消息库里已有的群 / 私聊，群名来自 `scope_names`。删除用页内展开的确认按钮（不弹 `window.confirm`）。

### 布局草图

```
┌─────────────────────────────────────────────────────────────────────┐
│ ▤ cs-agent 值守台   总览 Agent 记忆 上下文监控 回合 ●实时 定时任务 技能 设置 │  ← 页头；当前页下划线
├─────────────────────────────────────────────────────────────────────┤
/  运行总览
   依赖状态
   │● QQ 连接 │● Codex 凭据 │● DeepSeek │● 聊天记录整理 │● 观测存储│
   吞吐与队列
   ┌ 近 1 小时   ┐ ┌ 近 24 小时  ┐ ┌ 并发槽位 ┐
   │ 3 个回合结束 │ │ 4 个回合结束 │ │ 2 / 2    │
   │ 失败或中断 1 │ │ 失败或中断 1 │ │ 群… 排队1 │
   工作中 2 个会话 · 排队输入 1 条 · 实时页查看各会话
   上下文占用  4 条线程，codex 在前，按占比排序
   ┌───────────────────────────────────────────────────────────────┐
   │ Codex · owner 线程  300,000 / 400,000 tokens  300k / 400k  75% │
   │ ███████████████████████████████████████████░░░░░░░░░░░░░░░░░  │  ← 刻度尺：每 10% 一道细线
   │ 第 20 回合，缓存命中 80,000，更新于 14:02:11                     │
   │ Pi · 群 200000001   115,000 / 128,000 tokens  115k / 128k  90% │
   │ ██████████████████████████████████████████┃██████████┃████░░  │  ← ┃ 后台压缩 / 阻塞压缩阈值（悬停说明）
   └───────────────────────────────────────────────────────────────┘
   当前设置（键值）   ▸ 最近一分钟指标（折叠）

/live  实时会话                                        ● 实时连接中
   2 个会话工作中
   ┆┌──────────────────────────────────────────────────────────────┐
   ┆│[工作中] 群 家庭群(200000001) (Pi) (用户消息 · 阿杰)  已耗时 1 分 31 秒│
   ┆│ ▬▬▬▬▬▬▬▬┃▬▬┃░░ 78% 100k / 128k                               │  ← 该线程的单行占用条
   ┆│ (本轮输入 2)(已发消息 1)(工具调用 3)(子 agent 1)(排队 1)         │
   ┆│ 阿杰：能不能帮我查查明天上海的天气                               │  ← 本轮输入（开轮 + 插话）
   ┆│ 阿杰：顺便整理成出行建议                                        │
   ┆│ ● 当前：工具 fetch_page   1 分 4 秒                           │
   ┆│ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -│
   ┆│ +8.0秒  工具 web_search 开始 query 上海 明天 天气              │
   ┆│ +27秒   工具 fetch_page 开始 url https://weather.example/…      │
   ┆│ → qq:group:200000001 明天上海多云转晴…                          │  ← 本轮已发消息
   ┆│ 回合详情  [停止]                                               │
   ┆│ ▸ 最近完成 3 个回合                                            │  ← 展开：印章 · 种类与发送者 · 摘要 · 耗时
   ┆└──────────────────────────────────────────────────────────────┘   ← 左缘虚线：蓝=工作中，灰=空闲
   ┆┌──────────────────────────────────────────────────────────────┐
   ┆│[空闲] owner 私聊 (Codex)                         空闲 4 分 2 秒 │
   ┆│ (排队 0)   ▸ 最近完成 1 个回合                                 │
   ┆└──────────────────────────────────────────────────────────────┘

/turns/<id>  回合详情
   ┌───────────────────────────────────────────────┐
   │ ╔已完成╗ pi:42:1187                              │  ← 大印章（双框、微倾）
   │ 会话 群 200000001   种类 用户消息   发送者 阿杰   │
   │ 后端 Pi   设置 Pi · deepseek-flash · low   开始 …  总耗时 5.6 秒 │
   └───────────────────────────────────────────────┘
   输入 2 条   [用户消息] 阿杰 9f2c…  ▌这周末谁有空一起打 CS2？
   发送 1 条   时间 | 目标 | 状态 | 正文
   工具调用 3 次   时间 | 工具 | 结果 | 耗时 | 摘要
   子 agent 活动 / 错误（有才显示）
   时间线
   ●  +0 毫秒   开始处理  dispatched
   ●  +12 毫秒  收到  received        这周末谁有空… 来自 阿杰   ▸ 详情（脱敏 JSON）
   ○  +1.6 秒   模型回合 开始  model_turn         ← 空心=开始事件
   ●  +4.4 秒   发送消息  send_message
   ◉  +5.6 秒   回合结束  reply_sent             ← 大圆点=终态

/settings  设置
   ┌ 执行后端 ─────────────────────────────────────┐
   │ (●) Codex  容器内 codex CLI…  ( ) Pi  进程内…  │
   │ 按会话覆盖  与 .env 不同                      │
   │ [ group:200000001=pi                        ] │
   │ Codex 推理强度 [high ▾]   owner 告警 [ ] 开启   │
   │ [保存设置]                                     │
   └───────────────────────────────────────────────┘
   codex 系统提示 codex.md  修改于 …
   [ 多行编辑框                                  ]  12 字，上限 64 KB  [保存 codex.md]
   ▸ 受管规则（程序生成，不可编辑）    查看完整 AGENTS.md（→ /codex/agents-md）
   pi 系统提示 agent.md  修改于 …
   [ 多行编辑框                                  ]  27 字，上限 64 KB  [保存 agent.md]
   线程（→ /codex、/pi）   最近变更（表格，含 codex.md / agent.md 字节变化）

/codex  Codex 线程
   ┌ owner 线程 ───────────┐ ┌ 共享线程 ─────────────┐
   │ 上下文占用 ▬▬▬░░ 31%  │ │ 上下文占用 ▬░░░░ 8%    │
   │ 线程 id  019a-…       │ │ 线程 id 019a-…        │
   │ rollout 17.5 MB       │ │ rollout 3.0 MB        │
   │ 已观测 41  最近 …     │ │ 已观测 12  最近 …      │
   │ [重置线程]            │ │ [重置线程]             │
   └───────────────────────┘ └───────────────────────┘
   owner 线程最近 10 轮：状态 | 时间 | 收到 | 回复 | 耗时 | 工具/tokens
   共享线程最近 10 轮：…        ▸ 全局 AGENTS.md

/pi  Pi 会话
   上下文占用：每个会话键一条（有记录的按占比降序，其余为"暂无数据"占位）
   会话键 | 会话 id | 最近活动 | 已观测 | [重置线程]
   每个会话键最近 10 轮（同上表）   上下文压缩表   ▸ 用量（原始数据）

/turns     [状态▾][会话][种类▾][后端▾][筛选]  表格：状态印章 | 开始 | 会话/发送者 | 种类/后端 | 耗时 | 回合
/logs      [键][级别▾][过滤]   等宽日志流，warn/error 左侧色条
```

手机宽度（≤720px）：导航改为横向滚动的第二行，表格隐藏次要列，单据与时间线单列排布；375px 下各页面无横向滚动。

## 设计令牌（`src/obs/ui/theme.ts`）

方向是"调度单"：每个会话是一张在分拣台上流转的单据。冷灰蓝纸面、靛青墨水正文、复写纸蓝为唯一强调色；状态用描边"印章"；进行中的单据左缘是打孔虚线。

| 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--paper` | `#e8ecf1` | `#0e131b` | 页面底色 |
| `--sheet` / `--sheet-2` | `#fbfcfd` / `#f2f5f8` | `#151c27` / `#1b2431` | 卡片、表格、代码底 |
| `--ink` / `--ink-2` / `--ink-3` | `#17223a` / `#4d596e` / `#6f7a8e` | `#e3e8f0` / `#a3aec0` / `#7f8a9d` | 正文 / 次要 / 弱化 |
| `--rule` / `--rule-strong` | `#cdd4de` / `#a9b3c2` | `#283244` / `#3a4659` | 分隔线、边框 |
| `--carbon` | `#2b47b5` | `#8ea3ff` | 强调：链接、处理中、焦点环 |
| `--ok` `--fail` `--warn` `--queued` | `#1d7549` `#b42f27` `#9c620f` `#5d4fa6` | `#5cc48d` `#f2786e` `#e2a94b` `#b4a7f3` | 已完成 / 失败或中断 / 被唤醒取代 / 排队 |

- 字体：`"PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",…,system-ui`；等宽只用于回合 id、入站键、代码与日志。数字启用 `tnum`。
- 字号：12.5 / 13.5 / 15（正文，行高 1.65）/ 18 / 23 / 30。
- 间距：4 / 8 / 12 / 16 / 24 / 32 / 48；圆角 3（印章）/ 6（控件、单据）/ 10（面板）。
- 深浅色：`@media (prefers-color-scheme: dark)` 自动切换；动效只有处理中阶段的脉冲点与新单据的一次高亮，`prefers-reduced-motion` 下全部关闭。

## 上下文占用条（设计 §8.5）

数据由 `src/agent/context-usage.ts` 的 `ContextUsageStore` 维护（每线程一条 `ContextUsage`），通过 `createDashboard({ contextUsage })` 接入；面板只用 `all()` / `get(backend, key)`，类型在 `src/obs/ui/context-bar.ts` 以同构结构声明。未接入时总览显示"数据源未接入"，各页照常。

- 组件 `contextBar(backend, key, usage, {mini?})`（服务端）与 `usage.js` / `live.js` 内的 `ctxApply`（客户端）产生同一结构：`.ctx[data-ctx="backend|key"]` → `.ctx-head`（标签、`已用 / 窗口 tokens` 千分位、`k`/`M` 简写、百分比）→ `.ctx-track`（`role=progressbar`）→ `.ctx-meta`（回合数、缓存命中、压缩阈值、估算/更新时间）。`mini` 为单行（轨道 + 百分比 + 简写），用在实时页会话行与会话页的页头。
- 宽度与刻口位置：`.ctx-fill[data-w]`、`.ctx-tick[data-at]` 取 0–100 的整数，theme.ts 生成对应的 101 条属性选择器规则——不写内联 `style`，CSP 不变，无脚本时首屏也正确；超过 100% 时条满格、百分比如实显示。
- 分档：占比 <60% 复写纸蓝（`ctx-t-ok`）、60–85% 琥珀（`ctx-t-warn`）、>85% 朱红（`ctx-t-hot`）。pi 记录带 `compaction` 时画两道刻口：`ctx-bg` 后台压缩阈值、`ctx-rs` 阻塞压缩阈值，`title` 为中文说明。`source=estimate` 斜线虚填（`ctx-est`）；`updatedAt` 超过 24 小时褪色（`ctx-stale`）并显示"上次更新 x 小时前"；无记录显示"暂无占用数据"占位（`ctx-none`），SSE 到达后原地换成完整条。
- 排序：总览 codex 在前、pi 在后，同后端按占比降序；`/pi` 有记录的按占比降序，其余占位在后。

数据路径：

- 首屏：服务端渲染时调用 `contextUsage.all()` / `get()`。
- 实时：`ContextUsageStore` 每次更新写观测事件 `context_usage`（detail 即记录）→ `Trace.tap` → `LiveBus` 取白名单字段推送 `{type:'context', usage}` → `/live/stream` 与 `/usage/stream` 的 SSE `event: context`（`data: {usage}`）。`/live/stream` 在快照头之后、会话之前先发全部记录；`/usage/stream`（总览、/codex、/pi 加载的 `usage.js`）首帧也发全部记录（重连补齐），之后只推增量。客户端只改 `textContent` / `dataset` / `className`。
- 会话行就是会话键本身；后端（`dispatched` 事件或会话宿主快照）已知后页头才出现占用条。
- 脱敏：记录字段 `key` 与 `thread_key` 一样，只有取值为 `owner` / `shared` / `group:N` / `private:N` 时才不被当作密钥隐藏。

## 实时视图数据流

```
ThreadHost / TurnMonitor / Inbox / 两个后端 / send_message
        │ trace.event(key, stage, {status, detail})   key = in:<入站键> | turn:<回合 id> | thr:<会话键> | @系统
        ▼
Trace ──tap──▶ LiveBus（内存：每会话一行，当前回合的阶段栈与事件流，已脱敏）──subscribe──▶ /live/stream（SSE）──▶ live.js
  │              ▲ 会话宿主只读快照（每 5 秒，仅有订阅者时；页面渲染与 SSE 首帧前各取一次）
  │              │ 排队输入键、子 agent 数、会话后端、重启后仍在进行的回合
  │                                    snapshot → snapconversation × N → snapshot_end，随后 conversation / remove 增量
  │                                    context_usage 事件另推 context 增量（也发往 /usage/stream）
  └──append──▶ ObsStore（SQLite events.key：回合、输入与会话的时间线、指标）
```

- 会话行（`LiveConversation`）：`thread`（owner / group:<id> / private:<qq>）、`label`（群名，来自消息库 `scope_names`）、`backend`、`state`（`working` / `idle`）、`turn`（当前回合）、`queued`（排队等本轮结束的入站键）、`subagents`（在跑的子 agent 数）、`recent`（最近 5 个完成的回合，不带事件流）。
- 当前回合（`LiveTurn`）：`id`、`kind`（user / scheduled / wake）、`sender`、`started`、`inputs`（开轮与插话的输入：键、发送者、正文前 500 字）、`sends`（本轮 send_message：目标、正文前 200 字、状态、是否系统消息，最多 20 条）、`tools`（已结束的工具调用数）、`phase`（阶段栈顶）与事件流 `items`。结束后 `outcome` 为 completed / failed / lost；被后端唤醒回合取代的旧回合记 `superseded`。
- 事件归属：`in:` 的 received / queued / delivered 维护输入正文与排队集合（空闲会话的输入也先 queued 再开轮，delivered 可能先到，已送达的不再计入排队）；`turn:` 事件按 `dispatched` / `received` 带出的会话键归属，会话键未知的先暂存（每回合最多 80 条，最多 100 个回合，半小时过期）；`thr:` 事件（停滞、面板停止）进当前回合的事件流；`@` 系统键与旧版键不进实时视图。重启前的回合只剩终态、或已结束回合的迟到事件，不重开会话行。
- 子 agent 数：pi 取会话 `SubagentDoc` 中未停止且有未结束汇报的子 agent；codex 取 app-server `subAgent` 通知维护的在跑子线程数。两者都经 main.ts 的会话宿主快照（`ThreadHost.keys()` + `thread()`）汇总；后端未知时为 null，界面不显示这一项。
- 快照分帧：`snapshot`（`{now, count}`，页面据此清空）→ 每个会话一帧 `snapconversation`（`{conversation}`，带当前回合事件流，逐会话脱敏，不受数组 100 项截断影响；总数受 300 个会话上限约束）→ `snapshot_end`。服务端先订阅、再刷新宿主快照并取快照，期间的增量缓存后排在快照之后发出（客户端按回合 id 与事件 seq 去重）。
- 增量：`conversation`（`{conversation, item?}`，会话头不带事件流，`item` 为新的一条事件）、`remove`（`{thread}`）、`context`。事件序号：每个回合内事件带单调递增的 `seq`，服务端每回合只保留最近 80 条；客户端同一回合按 `seq` 只追加更大的事件，换了回合清空事件流。
- 淘汰：空闲、没有排队、没有在跑子 agent 的会话在最后活动半小时后淘汰（每分钟检查一次，`close()` 时清除），推送 `remove`。
- 背压：所有 SSE 帧经写队列按序写出；`write()` 返回 false 时等待 `drain`。只有待写字节（队列 + socket 缓冲）超过 2 MB，或一次 `drain` 等待超过 10 秒，才断开该客户端。
- 停止：会话行与回合页的"停止"按钮 `POST /thread/stop`（`key` 为会话键，`return` 只接受 `/live` 或该会话页，其余回 `/agents`），中止当前回合与子 agent，排队的输入随后照常开轮；记 `thr:<会话键>` 的 `thread_stopped`。
- 页面不轮询；唯一的定时器在浏览器本地刷新"已耗时 / 空闲"文字。SSE 与日志流共用 20 个连接上限，慢客户端按上面的背压规则断开。

## 观测存储

- `observability.sqlite` 的 `events` 表按 trace 键存事件：`key` 列（旧库的 `ticket` 列在打开时改名，见下）。回合聚合（`ObsStore.turns` / `turnBriefs`）只看 `turn:` 键：会话取终态或 received / dispatched 的 `thread_key`（pi 为 `conversation_key`），种类取终态 → dispatched → received 的 `kind`，结果取终态事件（`reply_sent` / `failed`，`terminal: true`）的 `detail.status`，缺省按 stage。
- 每个 trace 键最多保存 `OBS_EVENT_CAP`（旧名 `OBS_TICKET_EVENT_CAP` 仍可用）条事件、256 KiB detail；管理事件（`@` 键与设置 / 提示词 / 线程重置）独立按年龄保留。
- 存储迁移（一次性、幂等、崩溃安全）：打开时用 `RENAME COLUMN` 在同一写事务里改列名并重建索引，中途失败整体回滚、下次打开重做；已是新列名时不做任何事。
  - `observability.sqlite`：`events.ticket` → `events.key`（索引 `events_ticket` → `events_key`）；`recall_events.ticket` → `recall_events.turn_id`（索引 `recall_events_ticket` → `recall_events_turn`），qq_context MCP 进程打开同一库时同样执行（`BEGIN IMMEDIATE` 串行）。
  - `qq-messages.sqlite`：`messages.ticket` → `messages.outbox_key`（唯一索引 `messages_ticket` → `messages_outbox_key`），只由主进程的读写连接执行；只读连接（qq_context MCP、面板记忆页）读主进程迁移后的库。
  - `qq-bridge.sqlite` 的旧 `tickets` 表原样留在磁盘上，不再创建、补列、读或写；旧版生图路由留下、只在票据表里有记录的机器人图片不再能召回。

## 运行时设置

`${DATA_DIR}/settings.json`（`{version:1, settings:{…}}`，原子写，zod 严格校验）覆盖 `.env` 默认值：`agentBackend`、`backendOverrides`、`codexReasoningEffort`、`alertOwner`。后端与 Codex 推理强度在开轮时读取 `settings.current()` 并冻结为本轮设置快照（记在首条输入的 `admitted` 与回合的 `dispatched` 事件，回合页显示）；owner 告警开关独立现读。回复原文照发（仅 4000 字发送保护），面板不再提供回复方式选项。旧文件中的 `codexReplyMode` 读取时剥离，下次保存时移除，其它字段仍严格校验。每次变更写观测事件 `settings_changed`（trace 键 `@settings`，含变更前后值与来源 `dashboard`）；agent.md 保存记 `prompt_changed`（`target: "pi"`）；codex.md 保存记 `prompt_changed`（`target: "codex"`，`file: prompts/codex.md`，前后字节数）——由面板启动时对 `codexPrompt.subscribe` 的唯一订阅写入，POST 处理器本身不记，避免重复；线程重置记 `thread_reset`（`@codex` / `@pi`）。

codex.md 编辑器旁的「codex 基础指令（当前 codexModel）」编辑 `DATA_DIR/prompts/codex-base/<安全 slug>.md`，显示「与目录默认不同」状态及自动追加的 QQ 受管规则。保存和「恢复目录默认」均校验 CSRF、模型和文件 revision，冲突返回 409；变更记录为 `prompt_changed`（`target: "codex-base"`）。下一轮即生效，包含已有线程续聊；Codex 升级不会更新已播种文件，请用「恢复目录默认」。模板缺失时沿用 Codex 默认行为，不创建空文件。

## 安全

- 所有写操作：仅 POST；只认 cookie 会话（URL 口令不可用于写）；表单隐藏字段 `_csrf` = HMAC-SHA256(口令, 固定标签)，常数时间比较；响应使用 `Referrer-Policy: same-origin`，保留浏览器同源表单的来源信息；有 `Origin` 时必须匹配当前源，唯独字面值 `null` 仅在浏览器提供 `Sec-Fetch-Site: same-origin` 时允许；有 `Sec-Fetch-Site` 时只接受 `same-origin` 或 `none`（`none` 不允许 `Origin: null`）；只接受 `application/x-www-form-urlencoded`，正文 ≤ 512 KB。
- agent.md：固定路径、目录与文件均拒绝软链接、LF 规范化、≤ 64 KB、临时文件 + rename；若内容含已注册的秘密则只读展示脱敏版，且服务端同样拒绝覆盖（409）。表单带隐藏字段 `revision`（当前文件 mtime + 大小的摘要，不存在为 `none`），与提交时的文件不符或缺失即返回 409，防止覆盖容器内或其他标签页的修改。
- codex.md（DESIGN-codex-context §8.6）：面板通过 `DashboardOptions.codexPrompt`（`CodexPromptStore` 的结构类型：`read()` / `save(custom, expectedRevision)` / `subscribe(fn)`）读写，不直接碰文件。表单带隐藏字段 `revision`（取自 `read()`），提交内容先把 CRLF / CR 规范为 LF 再交给 `save`；`StaleRevisionError` → 409"codex.md 已在别处被修改，请刷新后再保存"，存储的其他拒绝（为空、超过 64 KB、含凭据样式内容）→ 409 并显示存储给出的中文原因（先脱敏）；成功后 303 跳回 `/settings?ok=codexPrompt#codex-prompt`。当前自定义段含已注册秘密时只读展示脱敏版、不给表单。受管段只读折叠展示；完整 AGENTS.md 在 `/codex/agents-md` 只读脱敏查看。未接入存储时显示提示，POST 返回 404。
- 渲染：服务端文本一律先脱敏再转义；客户端只用 `textContent`。CSP 为 nonce（样式与脚本），无内联 `style=` 属性；Host 白名单、图片路径段与 realpath 双重限制保持不变。
- 线程重置排在该线程的回合队列之后，不打断进行中的回合；请求最多等 1.5 秒，否则提示"已排队"。


## 临时手动压缩

`/agents` 页在 Codex / Pi 的重置按钮旁提供“压缩会话”，分别调用 `POST /codex/compact` 和 `POST /pi/compact`。压缩保留摘要，清理活动上下文中的旧工具输出与图片；会话 ID 不变，磁盘历史不会因此删除。操作与回合、重置共用每会话队列，等待当前回合完成，不注入本轮 MCP 令牌。

请求沿用同源、CSRF 和线程键校验，最多等待 1.5 秒：跳回 `/agents?ok=compacted|compactQueued|unchanged`；窗口内失败显示 `compactFailed` 错误提示，排队后的失败写日志。成功记录 `thread_compacted`（`@codex` / `@pi`）。

Codex 使用同一二进制、`CODEX_HOME` 受管配置和提供者环境，启动一次性 `app-server`，依次初始化、恢复线程并调用 `thread/compact/start`，最长等待 5 分钟，结束后清理进程。Pi 调用已有会话的 `compact(undefined, context)` 并检查任务终态。压缩需要后端模型可用；操作完成不代表所有历史图片都必然移除，具体保留范围由后端决定。

协议已用本机 `codex-cli 0.163.0-alpha.10.2` 的 `app-server generate-json-schema --experimental` 核对：`initialize` 要求 `clientInfo.name/version`，`thread/resume` 和 `thread/compact/start` 要求 `threadId`。完成依据为目标线程的 `item/completed`（`item.type=contextCompaction`）、成功的 `turn/completed`，或兼容已弃用的 `thread/compacted`；失败/中断的回合不会报成功。服务端请求中未实现的方法返回 JSON-RPC `-32601`。离线 smoke 仅验证握手和不存在的线程恢复；未调用真实模型验证压缩效果。协议概览见 [官方 App Server 文档](https://developers.openai.com/codex/app-server)。

### 统一发送观测

总览的吞吐按回合计：近 1 / 24 小时结束的回合数、其中失败或中断（`failed` / `lost`）的个数，以及开轮的输入数（`admitted`，按 `in:` 键去重）。回合页与时间线中的 `send_message` 记在所在回合（`turn:<id>`，不属于回合的系统消息记在 `thr:<会话键>`），含目标、正文前 500 字、message_id、图片数、文件状态与 already_sent，仅记录首次发送尝试，重放 / 对账不重复计数；被发送规则拒绝的记 `send_rejected`。`final_answer` 为仅留存、没有发出的最终回答。
