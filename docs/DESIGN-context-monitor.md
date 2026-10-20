# 设计：面板上下文长度监控与缓存未命中标记

状态：设计完成，待实现。关联：设计 §8.5 上下文占用条（`src/obs/ui/context-bar.ts`、`src/agent/context-usage.ts`）。

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

（主会话追加）
