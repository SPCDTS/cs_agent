# O4 记忆只读接口契约

本契约供记忆页面直接使用，字段名固定；类型定义见 `src/obs/memory/types.ts`。全部接口为 `GET`，挂载在 dashboard 已通过 Host / cookie 鉴权的分支，沿用 CSP、Referrer-Policy 等安全头。没有整理、清理、召回下载或其它写操作，不包含 O5 新埋点。

所有时间均为 Unix **毫秒**；聊天库内部的秒只在读取出口转换。字符上限按 JavaScript UTF-16 长度计算，避免截断代理对；`chars` 是 SQLite `length(text)` 对应的 Unicode 字符数。JSON 经 `redactSessionValue` / `redactText` 脱敏，编码后最大 **1 MiB**，超过返回 `413 {"error":"响应超过 1 MiB，请缩小查询范围"}`，不静默删除数组项。错误统一为 `{error: string}`；参数非法、重复或未知为 400，不存在的 scope / 摘要 / 路由为 404，工具或归档不可用为 503，其它读取错误为 500。未登录沿用 dashboard 的 401 登录页，POST 为 405 并带 `Allow: GET`。

## 总览：`GET /api/memory`

```ts
{
  scopes: ScopeSummary[],
  aging: { last_run: number | null, last_report?: AgingReport,
    next_run: number | null, running: boolean, catch_up_needed: boolean },
  retention: { rawDays: number, summaryDays: number, hardMaxDays: number, dailyHour: number, tz: string }
}
type ScopeSummary = {
  scope: string, label: string, messages: number, summaries: { day: number, week: number },
  first_ts: number, last_ts: number, bytes_estimate: number,
  pending_day_summaries: number, media_count: number
}
type AgingReport = {
  day_summaries: number, week_summaries: number, failed: number,
  purged_messages: number, purged_summaries: number, ms: number
}
```

- scope 按字典序，包含仅有摘要的域；`first_ts` 为最早消息时间 / 摘要起点，`last_ts` 为最新消息时间 / 摘要终点。空库为 `scopes: []`。
- `label` 复用现有规则：`owner` → `owner 私聊`，`group:123` → `群 123`，`private:456` → `私聊 456`。实际聊天库使用 `private:`；兼容 `user:456` 标签为 `私聊 456`，不重命名原始 scope。
- `bytes_estimate` 为消息及摘要的 `sum(length(text))`，只是体量估计，不是 UTF-8 字节或 SQLite 文件大小。媒体计数来自 `message_media`，包括 skipped 条目；不返回文件路径。
- `pending_day_summaries` 与整理器口径相同：今天之前、每日至少 5 条、日首未被同域日/周摘要覆盖。聚合在 SQL 中执行，不加载全部原文。
- `last_run` 来自 `aging_last_run`，缺失或无效为 null；`last_report` 仅在最新 aging 事件包含完整报告字段时提供。`catch_up_needed` 表示从未成功运行或已过 24 小时，与是否正在运行独立。
- `running` 来自调度器新增的只读方法；`next_run` 为按进程本地小时推算的下一次每日计划时间，执行中可能顺延。未注入调度器时分别为 false / null。`tz` 为进程解析出的时区。

## 时间线：`GET /api/memory/scopes/:scope?from=&to=`

```ts
{
  scope: string, label: string, range: { first_ts: number, last_ts: number },
  retention_edges: { raw_until: number, day_until: number, week_until: number },
  tracks: { raw: TrackBucket[], day: SummaryItem[], week: SummaryItem[] },
  gaps: { from: number, to: number, reason: 'purged' | 'no_records' }[]
}
type TrackBucket = { start: number, end: number, count: number, senders: number, preview?: string }
type SummaryItem = {
  id: number, kind: 'day' | 'week', period_start: number, period_end: number,
  created_at: number, chars: number, preview: string, source_messages: number | null
}
```

`from/to` 接受非负整数毫秒、`YYYY-MM-DD`（UTC）或带时区的 ISO 时间（如 `2026-10-18T03:00:00+08:00`，加号须 URL 编码）。非法日期不自动滚动到下月。查询区间为 **[from, to)**，`from < to`；缺省 from 为全域最早时间，to 为全域最新时间加 1 毫秒（包含最后一条消息）。`range` 返回最终查询区间，所有轨道按时间升序。

区间 ≤3 天按小时桶，≤60 天按日桶，否则按周桶。桶按 `ContextStore.tzOffsetSec` 对齐，周从周一开始；桶边界可超出查询范围，计数和第一条摘录只来自查询范围内。`senders` 为不同 user_id 数；只返回非空桶，preview ≤80 字。摘要与查询区间有交集即返回，preview ≤120 字；`source_messages` 直接读取现有 `msg_count`，缺失为 null。

`raw_until = now - rawDays × 86400000`；`day_until` 与 `week_until` 均为 `now - summaryDays × 86400000`，周折叠不等于日摘要另有保留期。原文只有被摘要覆盖才在 rawDays 后清理；未覆盖原文保留至 `max(rawDays, hardMaxDays)`。这些是配置边界，**不是实际删除证明**，调度失败时边界前仍可有记录。

`gaps` 为原文非空桶与摘要覆盖范围之外的空白，精度跟随桶。空白早于所有层的保留边界，即 `now - max(rawDays, hardMaxDays, summaryDays) × 86400000`，标 `purged`（基于策略推算的过期区域）；其余为 `no_records`。无删除日志，不能据此断言当时有聊天或确实发生了删除。即使超期，只要有现存记录也不会标为空白。

每次最多 10,000 个 scope、10,000 个非空原文桶或 10,000 条摘要，读取 LIMIT 为上限加一；超出返回 413。分桶使用 SQL GROUP BY。

## 消息：`GET /api/memory/scopes/:scope/messages?before=&before_id=&after=&after_id=&limit=`

```ts
{ items: MessageItem[], next_before?: number, next_before_id?: number }
type MessageItem = {
  message_id: string, ts: number, sender: string, sender_name: string, text: string,
  truncated?: true, reply_to?: string, bot_status?: string, bot_action?: string, media: number
}
```

`before/after` 接受与 from/to 相同的时间格式，换算为秒时保留小数；不带对应 ID 时保持严格时间界限：`time < before / 1000`、`time > after / 1000`。可选 `before_id/after_id` 为 messages 表主键 `id`（数字，不是字符串 `message_id`），必须是 1 至 `Number.MAX_SAFE_INTEGER` 的十进制整数；非法值或缺少对应 `before/after` 时返回 400。带 ID 时分别使用 `time < before_sec OR (time = before_sec AND id < before_id)` 和 `time > after_sec OR (time = after_sec AND id > after_id)`。同时提供上下界时须 `after < before`；若时间相等，必须同时提供两个 ID 且 `after_id < before_id`。

limit 默认 50，范围 1–200。始终按 `(time DESC, id DESC)` 排序，`after_id` 仅收窄下界，不改变排序。正文先整体脱敏再裁剪到 2000 字，超出附 `truncated: true`。可选字段无值时省略。`media` 为该消息的媒体行数。

存在下一页时同时返回 `next_before`（本页最后一条消息的毫秒时间戳 `ts`）与 `next_before_id`（该条消息的 messages 表主键 `id`）。客户端将两者原样传为 `before` 和 `before_id`，即可精确续页，跨页同秒消息不会重复或遗漏。没有下一页时两个字段均省略。旧客户端只传 `next_before` 仍按严格时间界限查询，因此会跳过该秒内尚未返回的消息。

## 摘要：`GET /api/memory/summaries/:id`

```ts
{ id: number, scope: string, kind: 'day' | 'week', period_start: number,
  period_end: number, created_at: number, text: string, surviving_raw: number, lineage: null }
```

id 为正整数。`surviving_raw` 统计同 scope 在 `[period_start, period_end)` 中仍存在的原文，不能等同于生成摘要时的原文数。`lineage: null` 表示 O5 血缘表尚未实现，不能解释为没有来源。

## 检索：`GET /api/memory/search?scope=&q=&days=&limit=`

```ts
{ hits: Hit[], tool_text: string, tool_text_chars: number, max_chars: number, dropped: number }
type Hit = {
  kind: 'message' | 'summary', id: string | number, ts: number, scope: string,
  excerpt: string, matched_fields: string[]
}
```

q 去首尾空白后不能为空，并按真实工具截到前 100 字；days 默认 30、1–180；limit 默认 10、1–20。scope 缺省为全部管理员可见域；显式传空值为 400，未知域为 404。

hits 直接来自 `ContextStore.search(access, ...)`，按时间新到旧；消息 id 是 message_id 字符串，摘要 id 是数字，结合 kind / scope 使用。`ts` 为消息时间或摘要终点。excerpt ≤240 字，为首个匹配字段中命中附近的脱敏原文片段；matched_fields 为参与命中的 `text` / `detail`，没有相关性分数。

`tool_text` **实际调用** `callQQContextTool({access, openStore, maxChars}, 'qq_search', {query, days, limit})`，没有另写 formatter。`max_chars` 取 `QQ_CONTEXT_MAX_CHARS`；`dropped` 逐条 formatter 结果与实际输出行匹配，重复行按次数消耗，不按字数猜测。`tool_text_chars` 是面板脱敏后的实际字符串长度，脱敏占位符可能让长度不同于原始工具文本。

面板与模型视角的差异：

1. 面板是管理员检索视角，缺省 access 通过 `parseAccess('all')` 构造；scope 筛选使用对应的 scope access。它不代表某次会话的 QQ_ACCESS。
2. 格式化及裁剪路径与模型工具相同，但面板额外应用观测脱敏。没有敏感文本时与直接调用结果逐字相同；有凭据时返回工具结果的脱敏版本。若工具先裁剪留下了无法完整匹配的秘密残片（对比“整体脱敏后再格式化”结果发现不一致），整行替换为 `[已隐藏：原文含跨裁剪边界的凭据]`，仍算进入工具的条目。安全要求优先于输出秘密的逐字复现。
3. 这是当前数据库中“检索命中 → 工具实际返回”的对照，不证明历史某次调用发生过，也不证明结果进入了某次模型请求或被模型采用。第三级证据及召回历史属于 O5。

## 归档：`GET /api/memory/archives`

```ts
{ codex: ArchiveRow[], pi: ArchiveRow[], compactions: CompactionRow[] }
type ArchiveRow = {
  key: string, thread_id?: string, conversation?: number, created_at: number | null,
  archived_at: number | null, reason: string, session_href: string
}
type CompactionRow = { conversation: number | string, attempts: number, last_at: number, reasons: string[] }
```

Codex 行带 thread_id，Pi 行带 conversation；链接为 `/agents/<backend>/sessions/<id>`。读取注入的两个 JSONL 镜像，保留末尾 200 行并按 archived_at 倒序。文件缺失返回空数组，损坏返回 503；每文件最多读 4 MiB，单行最多 1 MiB，超限 413。Codex 老记录没有 created_at 时使用只在创建时写入的 updated_at；Pi 镜像没有创建时间时返回 null，不用归档时间冒充。

compactions 来自 ObsStore `stage='compaction'` 的 Pi / 未标 backend 的事件，按 conversation 聚合 COUNT 为 attempts、MAX(ts) 为 last_at、reason 去重为 reasons，按 last_at 倒序，最多 1000 个会话，超出 413。attempts 只表示观测事件条数，不能等同于压缩成功次数。观测库 degraded 时压缩列表为空；归档镜像仍可读取。

## curl 示例

以下使用已取得的面板 cookie，`$OBS_TOKEN` 为本地环境变量；不要把真实口令写进文档。

```bash
curl -sS -b "obs_token=$OBS_TOKEN" http://127.0.0.1:3000/api/memory
curl -sS -b "obs_token=$OBS_TOKEN" 'http://127.0.0.1:3000/api/memory/scopes/group%3A123?from=2026-10-01&to=2026-10-18'
curl -sS -b "obs_token=$OBS_TOKEN" 'http://127.0.0.1:3000/api/memory/scopes/group%3A123/messages?limit=50'
curl -sS -b "obs_token=$OBS_TOKEN" http://127.0.0.1:3000/api/memory/summaries/1
curl -sS -b "obs_token=$OBS_TOKEN" --get --data-urlencode 'q=比赛' --data-urlencode 'scope=group:123' http://127.0.0.1:3000/api/memory/search
curl -sS -b "obs_token=$OBS_TOKEN" http://127.0.0.1:3000/api/memory/archives
```

## 实现范围与验收

仅新增 `src/obs/memory/`、dashboard 接入、main 依赖注入和调度器 `running()`。未改 O1 会话接口、O3 上下文模块和 UI，未新增运行时依赖。所有 fixture 在临时目录匿名构造，不读取真实聊天，不写任何运行数据目录；测试覆盖各路由、参数和不存在分支、三档桶、保留边界、工具路径逐字一致、脱敏、响应上限与 dashboard 鉴权。完整验证计数在交付报告中列出。

2026-10-18 初次验收：Windows / Node v24.15.0，`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build` 全部通过，**63 个测试文件 / 867 项测试，0 失败、0 跳过**，相对基线新增 62 项记忆接口测试，并扩充整理器状态断言。首次完整运行受既有 entrypoint 临时目录权限与 Windows 进程树沙箱限制影响；在沙箱外重新执行三个完整命令通过，未放宽测试条件。未部署 Docker、修改 `.env` 或操作真实聊天数据；未进行生产库冒烟。面板脱敏对逐字复现的优先级与 `purged` 的策略推算语义已在上文固定；消息分页现支持时间与主键组成的复合游标，兼容旧客户端的严格时间界限。

2026-10-18 复合游标修补验收：`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build` 全部通过，**63 个测试文件 / 897 项测试，0 失败、0 跳过**；记忆接口测试为 92 项，相对初次验收净增 30 项。覆盖同秒 7 条消息以 limit=3 连续三页取全、保留 after_id 下界的续页、双向严格边界、旧客户端行为及非法游标。完整验证因上述 Windows 沙箱权限限制在沙箱外执行，测试条件未改动。
