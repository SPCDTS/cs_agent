# 设计：面板上下文长度监控与缓存未命中标记

状态：已实现并部署（2026-10-20）。关联：设计 §8.5 上下文占用条（`src/obs/ui/context-bar.ts`、`src/agent/context-usage.ts`）。

## 0. 事实（2026-10-20）

- 每个完成的模型回合都会经 `ContextUsageStore.update` 写一条观测事件 `context_usage`（ticket 为本轮票据；`@context` 的是回填/估算/压缩），detail 即 `ContextUsage`：`backend`、`key`、`usedTokens`（本轮输入占用）、`cachedTokens`（本轮缓存命中）、`windowTokens`、`effectiveWindowTokens`（codex）、`compaction`（pi）、`turns`、`source`（turn | estimate | compact）、`lastCompactionAt`、`updatedAt`。库里已有 147 条（10-18 起）。
- 相关系统事件：`@settings` 票据下的 `settings_changed`（含 before/after，模型切换会让缓存前缀失效）、`prompt_changed`（codex.md 变更 → 全局 AGENTS.md 重写）；压缩会写 `source: "compact"` 的 `context_usage`；线程重建后 `turns` 回到 1。
- 缓存语义：OpenAI/DeepSeek 的提示缓存按前缀命中，正常连续对话时本轮 `cachedTokens` ≈ 上一轮 `usedTokens`（上轮整个上下文是本轮前缀）。实测样本：owner 线程 10-19 第 2 轮 `in=18067, cache_read=200320`（命中），pi 群线程 `usedTokens 21188 / cached 20992`。首轮或压缩后的下一轮 cached 很小是正常的。
- 面板已有：每线程"当前占用"进度条（contextBar，SSE 实时更新），没有历史与 miss 标记。`/context` 已被"上下文检索"占用。

## 1. 目标与非目标

目标：新页面 `/context-usage`（导航名"上下文监控"）按线程展示最近 N 轮的上下文长度走势（输入占用、其中缓存命中/未命中、占窗口比例）并标记异常的缓存未命中，给出可解释的原因；票据页的模型回合行也带命中率与标记。
非目标：实时推送（刷新页面即可）；修改缓存行为；跨重启的事件持久化以外的新存储（全部从观测库推导）。

## 2. 数据与判定（`src/obs/context-turns.ts`，obs 层纯函数 + ObsStore 查询）

```ts
export interface ContextTurn { ts: number; ticket: string; used: number; cached: number; uncached: number; window: number; pct: number; turns: number; source: "turn" | "compact" | "estimate";
  mark?: "miss" | "partial" | "first" | "compact" | "reset"; reasons: string[]; gapMs?: number }
export interface ThreadContextSeries { backend: "codex" | "pi"; key: string; turns: ContextTurn[]; misses: number; window: number }
export function analyzeContextTurns(events: ContextUsageEvent[], system: SystemEvent[], opts?: { missRatio?: number; partialRatio?: number; minPrevTokens?: number; gapMs?: number }): ContextTurn[]
```

- 取数：`ObsStore.contextSeries(limitTurnsPerThread = 40, since?)`：`stage='context_usage'` 按 `json_extract(detail_json,'$.backend')`/`'$.key'` 分组、`ts` 升序；同时取区间内 `@settings` 的 `settings_changed`/`prompt_changed` 与各线程的 `thread_reset`（如有）事件作为"系统事件"。只保留 `source` 为 turn 或 compact 的记录；estimate 跳过。
- 判定（对每条 `source=turn` 且存在上一条 `turn` 记录 `prev` 的回合）：
  - `expected = prev.used`；`ratio = cached / expected`。
  - `prev.used < minPrevTokens(默认 4096)` → 不判定（缓存粒度）。
  - 上一条记录是 `compact`，或本条 `turns === 1`（重建） → `mark = compact | reset`，不算 miss。
  - 无 prev → `first`。
  - `ratio < missRatio(0.5)` → `miss`；`ratio < partialRatio(0.9)` → `partial`。
  - `reasons`（按发生顺序，可多条）：`prev.ts` 与本条 `ts` 之间出现 `settings_changed` 且 changed 含 `codexModel`/`piModel`/`agentBackend` → "切换模型"；`prompt_changed` → "提示词变更"；`gapMs > gapMs(默认 60 min)` → "间隔 N 分钟"；本条 `window !== prev.window` → "窗口变化"；都没有 → "未知（可能是服务端缓存过期或驱逐）"。
  - `uncached = max(0, used - cached)`；`pct = used / (effectiveWindowTokens ?? windowTokens)`。
- `misses` = 该线程序列里 `miss` 的个数；页面顶部汇总各线程最近 24 h 的 miss 数。

## 3. 页面 `/context-usage`

- 顶部：每线程一行汇总：线程名（沿用 contextBar 的标签）、当前占用条（复用 `contextBar`）、最近 24 h 回合数 / miss 数 / 平均命中率。
- 每线程一个区块：
  - 走势条：最近 N 轮（默认 40）横向排列的竖条，高度 = `pct`，条内分两段（缓存命中、未命中）用两种颜色；`miss` 的条加红色顶标并在 title 写原因；`partial` 橙色；`compact`/`reset` 用虚线分隔符。用 `data-h`/`data-c` 整数百分比 + theme.ts 生成的属性选择器（与 ctx-fill 同一机制），不写内联 style、不用脚本。
  - 明细表（默认折叠 `<details>`）：时间、票据（链接）、输入、缓存命中、未命中、占窗口、标记、原因、与上一轮间隔。
- 票据页：模型回合行追加 `命中 X/Y（Z%）` 与 miss/partial 标记（同一判定函数，prev 取该线程此票据之前的最近一条 turn 记录；需要 `ObsStore.previousContextTurn(backend,key,beforeTs)`）。
- 导航：在"上下文检索"旁加"上下文监控"。参数：`?limit=` 每线程回合数（≤200）、`?backend=`、`?key=` 过滤单线程（从 agents 页的线程行加一个"监控"链接）。
- 查询开销：按 ts 索引倒序取最近 M 条 `context_usage`（M = 线程数 × limit 上限 2000）后在内存分组，`@settings` 事件同理取最近 500 条。

## 4. 配置

无新环境变量；阈值作为分析函数的默认参数，页面 `?miss=0.5&partial=0.9` 可临时覆盖（仅展示）。

## 5. 测试

- `test/obs/context-turns.test.ts`：命中（ratio ≥ 0.9）无标记；miss/partial 阈值边界；首轮/压缩后/重建后不算 miss；`minPrevTokens` 以下不判定；原因推断（模型切换、提示词变更、长间隔、窗口变化、未知）及多原因顺序；`uncached`、`pct` 计算；estimate 记录被跳过。
- `test/obs/store*.test.ts`：`contextSeries` 分组与排序、limit、since；`previousContextTurn`。
- 页面测试：走势条的 data 属性与 title 原因、表格列、过滤参数、导航入口；票据页命中率显示。

## 6. 验收（主会话）

部署后：页面能看到 owner（codex）与 group:200000001 / owner（pi）三条线程的走势；10-19 12:30Z 的 owner 首轮（cached 3712 / 上轮 20 万）被标为 miss（原因"间隔"或"提示词变更"），其后一轮命中；f2 10-20 08:39Z 压缩后的回合标 compact 不算 miss；票据页显示命中率。

## 7. 验收记录

### 2026-10-20，主会话验收

- 代码：数据层 8b5e9a3（codex 实现：`analyzeContextTurns` 纯函数 + `ObsStore.contextSeries/previousContextTurn`，53 个测试）、页面 75a205f（Opus 实现：`/context-usage`、票据页命中率、agents 页"监控"链接；类型移到 `src/shared/context-turns.ts` 以满足 UI 层 import 白名单，阈值通过 `contextSeries({ analysis })` 传入而不是在 http.ts 重算）、主会话修正 02f1527（基准改为 `min(上一轮长度, 本轮输入)`）。沙箱外全量 1703 项通过。
- 部署：镜像 `dfc9209e…`（干净 build worktree，main 02f1527），容器 healthy。
- 真实数据核对（owner codex 线程，60 轮）：设计 §6 的样本全部符合——10-19 20:31（12:31Z）输入 204,820 / 命中 3,712（2%）标 miss，原因"间隔 108 分钟、窗口变化"；其后 20:35 命中 92%、20:40 命中 100% 不标记；10-20 16:42（08:42Z）命中 3% 标 miss，原因"切换模型、提示词变更、间隔 1202 分钟"（f2 当日切换模型 slug 与 developer_instructions）；f2 的压缩回合标 compact。修正前的误报：10-18 21:34 上一轮 445k、本轮 53k、命中 52k（旧版本压缩无 compact 记录）被标 miss，改基准后不再标记；10-20 18:08 由 miss 变为 partial（81%）。10-18 19:23/19:24 两轮（历史里内联生图的 39 万/44 万 token 时期）命中 66%/70% 标 partial、原因未知，与当时 WebSocket 超限回退 HTTPS 的现象一致，保留。
- 页面列出 5 条线程（codex owner/group/shared、pi owner/group），导航"上下文监控"，agents 页线程行有"监控"入口。

### 2026-10-20，§8 口径切换的主会话验收

- 代码：数据层 bfdc324（codex：`recordRequest` 写 `model_request`；codex 回合内全部 token_count；pi 每请求记录、每票据一次 `recordTurn`；分析混合新旧数据）、页面 7c86f0f（Opus：按票据分组的走势条、汇总加请求数、明细"请求"列与 `└ 第 n 次`、票据页逐请求命中率；票据分析逻辑由主会话抽到 `obs/context-ticket.ts` 以满足 http.ts ≤ 300 行的架构约束）。与 f2 的 b98bc9c（最终回答允许为空）在 pi.ts 合并，两边语义都保留。全量 1843 项通过。
- 部署：镜像 `3fae2527…`（main 7c86f0f）。页面：5 条线程，codex owner "最近 40 次请求（18 个票据）"，pi 群 "32 次请求（9 个票据）"——旧数据在 pi 侧本就是每请求一条，现在正确按票据分组；codex 旧票据每票据一条（当时只记最后一次请求），新票据起会按请求展开。
- 待观察：下一批带工具调用的 codex 票据应在图上出现多根相邻条，首条之后命中接近 100%。

### 2026-10-20，§9 页面重做的主会话验收

- 部署：main 1b436e3（数据层 4bdf0c7 + 页面 1b436e3，f2 已同意），镜像 9b67676d，队列空闲时 `up -d`，健康。
- 伪票据：`/context-usage` 全页 `票据 @context` 0 处；codex owner 线程从"40 次请求（18 个票据）"变为"24 次请求（22 个票据）"（23 根重启快照条消失，预算让给更早的真实票据）。
- 新口径数据：部署后首个带工具调用的 codex 票据 1440af37 记了 3 条 `model_request`（输入 136,463 / 137,849 / 138,064，缓存 136,320 / 136,320 / 137,728），后两次命中接近 100%，图上一组 3 根相邻条。
- 预览面板：55 个票据组按钮与 55 个 `.cu-pop` 一一对应；抽查 pi 票据 db5b9acd 的面板含状态戳、私聊会话、发送者、收到时间、总耗时、"Pi · deepseek/deepseek-flash · low（来源 auto）"、工具调用 2 次、原文、请求表与票据时间线链接；`/assets/context-usage.js` 200。时间轴跨天带日期（10/19 20:41 → 10/20 21:01）。
- 测试：数据分支全量 1869 通过，页面分支全量 1878 通过（含新增 context-usage-client 测试）；Opus 报告一次 dashboard.test.ts 偶发失败，重跑通过，未定位。
- 未验证：真实浏览器里的点击与窄屏布局（Opus 用无头 Edge 看过桌面宽度的渲染）。

## 8. 口径改为"每请求一根、按票据分组"（用户 2026-10-20 决定）

### 8.1 现状与问题

- codex：每票据一条 `context_usage`，取回合末尾最后一次请求的 `token_count.last_token_usage`；回合内因工具调用产生的多次请求不可见。
- pi：每条助手消息（即每次模型请求）调一次 `recordTurn`，一个票据多条记录，`turns` 计数随请求数膨胀（群线程显示 31 回合实为 31 次请求）。
- 两边口径不一致，图上一根条的含义不同。

### 8.2 数据采集

- `ContextUsageStore` 新增 `recordRequest(backend, key, { ticket, seq, usedTokens, cachedTokens, outputTokens?, windowTokens, effectiveWindowTokens?, at })`：只写观测事件 `model_request`（detail `{ backend, key, ticket, seq, turn, input, cached, output, window, effective_window?, at }`，`turn` 为该线程当前 `turns + 1`，即本票据的回合序号），**不改变** `ContextUsage` 状态、不自增 `turns`。`recordTurn` 语义不变：每票据一次，自增 `turns`，写 `context_usage`。
- codex：`readRolloutContextUsage` 增加返回本回合全部 `token_count` 记录（`task_started`/`turn.started` 之后、`task_complete` 之前，按时间升序，每条 `{ input, cached, output, at }`）；runner 在回合结束后先按序 `recordRequest`（seq 从 1 起），再用最后一条 `recordTurn`。rollout 缺失时两者都跳过并保留现有 warn。
- pi：`pi-context-usage.ts` 的 `consume` 对每条助手消息改调 `recordRequest`（seq 按票据内计数）；`recordTurn` 改到 `PiBackend.handle` 在该票据回合完成后调用一次，用最后一次请求的用量。压缩路径不变。
- 事件量：codex 每票据几条到十几条，pi 同现在；观测库保留期清理覆盖。

### 8.3 分析

- `contextSeries` 的输入改为 `model_request` 事件（按 backend/key 分组、ts 升序），并把 `context_usage` 中 `source=compact` 的记录合入序列作为压缩分隔；旧数据（没有 `model_request` 的区间）回退用 `context_usage` 的 `source=turn` 记录，视为 `seq=1` 的单请求票据。
- `ContextTurn` 增加 `seq`、`requests`（同票据的请求总数，渲染后填）、`turn`；重建判定改用 `turn === 1`（线程重置后的第一个票据）而不是 `turns`。miss/partial 的基准仍是上一条请求（跨票据或票据内均可），`gapMs` 同理。
- 汇总：`回合数` = 不同票据数，新增 `请求数` = 记录条数；`misses` 按请求计。

### 8.4 页面

- 走势条：同一票据的条相邻并用分组样式（外框或交替底色）；title 为 `票据 X · 第 n/N 次请求 · 时间 · 输入 · 命中 · 原因`。
- 明细表：票据列合并显示（同票据多行时只在首行放链接，后续行显示 `└ 第 n 次`），新增"请求"列；汇总表加"请求数"。票据页的模型回合行按请求列出命中率。

### 8.5 测试与验收

- store：`recordRequest` 写 `model_request` 且不改状态；codex 解析器返回全部 token_count；pi 每请求 recordRequest、每票据一次 recordTurn；分析对混合（新事件 + 旧 context_usage）序列的回退；UI 分组渲染。
- 验收：owner codex 一个带工具调用的票据在图上出现多根相邻条且首条之后命中接近 100%；pi 群线程"回合数"回落为票据数；旧数据区间仍能显示。

## 9. 页面重做：伪票据排除、票据预览面板（用户 2026-10-20 反馈）

### 9.1 现状与问题

- **不在票据内的请求**：`ContextUsageStore.backfill`（每次容器启动）、`ensure`、`reset` 用伪票据 `@context` 写 `context_usage`，其中 backfill 写出的是 `source=turn` 的快照（rollout 里最后一次用量，值与上一真实请求相同）。§8.3 的旧数据回退把 `source=turn` 全部视为 seq=1 的单请求票据，于是 owner 线程开头出现 23 根等高的条，题注"票据 @context · 第 1/23 次请求"，时间都是历次重启时刻。库里现有 42 条 codex、2 条 pi 这样的记录。
- **可读性**：图高 120 px、条宽 ≤ 20 px、分组只靠交替底色；没有纵轴刻度、没有时间轴；miss 只有 4 px 顶标；悬停 title 是唯一信息入口，无法点进票据。
- **缺少入口**：用户想点一个票据组看到该票据的信息（谁、何时、多少次请求、每次命中），再从那里跳到票据时间线。

### 9.2 数据层（obs，Codex）

- `src/obs/store.ts` 的 `CONTEXT_REQUEST_SQL`：`context_usage` 的回退分支加 `AND events.ticket NOT LIKE '@%'`；`source=compact` 分隔不受影响（仍可来自 `@context`）。`contextSeries`、`previousContextTurn` 共用该谓词，预算、`requests`、`tickets` 计数随之不再包含伪票据。
- `analyzeContextTurns`：`kind !== 'request'` 且 `source === 'turn'` 且 `ticket` 以 `@` 开头的事件直接跳过（纯函数对任何调用方都安全）。
- `ContextTurn` 新增可选 `output?: number`（来自 `model_request.output`；旧记录无）。
- 新增 `ObsStore.ticketBriefs(tickets: readonly string[]): Map<string, TicketBrief>`，类型放 `src/shared/context-turns.ts`：
  ```ts
  export interface TicketBrief { ticket: string; scope: string; ts: number; status: string; sender: string | null; route: string | null; backend: string | null;
    duration_ms: number; text: string; reply: string; tools: number; settings?: Record<string, unknown> }
  ```
  `ts/status/sender/route/backend/duration_ms` 与 `tickets()` 同口径（把 `IN (...)` 过滤放进 `GROUP BY ticket` 之前，不要先全表分组再过滤）；`text` 取 received/recovered 的 `text`（库里已是脱敏前 500 字），`reply` 取 terminal 事件的 `reply`，否则 postprocess 的 `sent_text`，否则 model_turn 的 `raw_reply`/`reply`（与 `threadTurns` 一致）；`tools` 为 `stage LIKE 'tool:%' AND status<>'started'` 的条数；`settings` 取 `admitted` 事件的 `detail.settings`（无则省略）。最多 300 个票据，多余忽略；不存在的票据不在结果里。总查询次数固定（一次票据聚合 + 一次事件聚合），不要每票据单独查。

### 9.3 页面（UI，Opus）

- **图**：高 160 px；左侧纵轴刻度 0 / 25 / 50 / 75 / 100 %（占窗口），背景每 25 % 一条浅网格线（CSS 背景渐变，不用脚本）；图下方时间轴只标首尾两个时间（跨天时带日期）。条宽 8–14 px，组内间距 2 px，组间 6 px。
- **票据组**：`<button type="button" class="cu-group" aria-controls="cu-pop-<i>-<n>" aria-expanded="false">`，内含该票据的所有条；底部 2 px 基线用 `--carbon`，悬停/聚焦加外框；含 miss 的组基线改 `--fail`、含 partial 改 `--warn`。条本身：命中段 `--carbon`，未命中段 `--ink-3`，miss 条的未命中段改 `--fail`，partial 改 `--warn`；顶标保留。压缩 / 重建分隔：虚线 + 顶部小字标签（`::after{content:attr(data-label)}`，"压缩"/"重建"）。
- **预览面板**：每个线程区块在图下面放一个 `<div class="cu-pane">`，里面预渲染每个票据组对应的 `<div class="cu-pop" id="cu-pop-<i>-<n>" hidden>`：
  - 头：状态戳、票据短 id（链接 `/tickets/<id>`）、会话 `scopeLabel(scope)`、发送者、收到时间、总耗时、派发设置（`dispatchSettingsLine(settings)`，无则不显示）、工具调用数。
  - 原文前 120 字（`<blockquote class="said">`，超出加 …）；有回复时回复前 120 字。
  - 请求表：第 n 次 · 时间 · 输入 · 命中（%）· 输出（无则 —）· 标记 / 原因。
  - 底部链接："票据时间线 →"（`/tickets/<id>`）。
  - 点击组：面板显示对应 pop、组加 `.is-active`、`aria-expanded=true`；再点同一组或面板里的"关闭"按钮或 Esc 关闭。脚本 `/assets/context-usage.js`（新文件 `src/obs/ui/context-usage-client.ts`，加入 `ASSETS`），只改 `hidden`/`className`/`aria-*`，不拼 HTML、不设置 style；无脚本时明细表仍是完整信息来源。
- **其余**：图例并到区块标题右侧一行；汇总表、明细表结构不变；`esc()` 转义、无内联 style、无新依赖、UI import 白名单不变。

### 9.4 测试与验收

- 数据：`@context` 的 `source=turn` 记录在分析与查询里都不出现（混入序列时请求数、票据数不变），compact 分隔仍在；`ticketBriefs` 字段口径、300 上限、缺失票据省略；`output` 透传。
- 页面：票据组是带 `aria-controls` 的按钮且与 pop 一一对应；pop 含票据链接、原文、请求行；分隔 `data-label`；纵轴与时间轴存在；脚本资源可取；CSP 测试照常。
- 验收：owner 线程开头不再有 `@context` 组；点击任一组出现面板并能跳到票据页；下一批带工具调用的 codex 票据在面板里按请求逐行列出。
