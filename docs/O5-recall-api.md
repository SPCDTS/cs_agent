# O5 摘要血缘与召回观测接口

本契约供后续记忆页面使用，以下字段名固定。沿用 [O4 记忆接口](O4-memory-api.md) 的 Host / cookie 鉴权、安全头、结构化脱敏和 **JSON 编码后 1 MiB 上限**。全部为 GET，不触发模型、整理、图片下载或埋点写入；不修改 O1 的回合详情接口，不调用 O3 上下文重建引擎。

接口时间统一为 Unix 毫秒。字符数为 JavaScript UTF-16 长度，针对实际工具原文或落库摘要计算，脱敏后的显示长度可能不同。JSON 字段采用 snake_case；数据库的 `*_json` 在出口解析为对应对象或数组并去掉 `_json` 后缀，`is_error` 转为 boolean，不同时提供另一套驼峰别名。

## 摘要详情与血缘

`GET /api/memory/summaries/:id` 保留原有字段，扩展 `lineage`：

```ts
{
  id: number, scope: string, kind: 'day' | 'week',
  period_start: number, period_end: number, created_at: number,
  text: string, surviving_raw: number,
  deleted?: true,
  lineage: { versions: SummaryVersion[], replaced: SummaryVersion[] } | null
}
type SummaryVersion = {
  id: number, summary_id: number, level: 'day' | 'week',
  period_start: number, period_end: number, created_at: number,
  batch_id: string, model: string | null, provider: string | null, usage: unknown,
  input_message_ids: string[], input_summary_ids: number[],
  input_chars: number, kept_chars: number, text_sha256: string, text: string,
  replaced_by: number | null, replaced_at: number | null
}
```

- `summary_id` 是聊天库 `summaries.id`；版本 `id` 是观测库独立主键。`replaced_by` 指向替换它的**版本 ID**。
- `versions` 是此摘要 ID 的版本，按版本 ID 升序；`replaced` 是被这些版本直接替换的版本，按 `(period_start, id)` 升序。没有版本记录时 `lineage: null`，不能解释为没有来源。
- 日摘要被周摘要删除后，只要观测版本还在，此 URL 仍返回 200，以最后一个快照补充摘要详情，附 `deleted: true`。现存摘要不带 deleted。聊天库和版本都不存在时返回 404。
- `surviving_raw` 始终是当前同域、同区间尚存的消息数量。正文先整体脱敏；`text_sha256` 是原始落库快照的 SHA-256，不是脱敏文本的校验值。
- `created_at` 为版本记录时间；摘要详情读取现存摘要时沿用聊天库创建时间，读取已删除摘要时使用快照记录时间。
- 每次 `runAging` 使用一个 UUID `batch_id`。日摘要的消息 ID 仅包含经过输入裁剪实际保留的行；周摘要的 `input_summary_ids` 是用于合并的日摘要 ID。
- `input_chars` 是发给模型的 user input 长度（包含会话、日期等前缀，不含 system prompt）；`kept_chars` 是实际入库文本长度。只有一条日摘要时沿用原文，不调用模型，周版本 model/provider/usage 为 null、input_chars 为 0。历史日摘要首次快照没有可追溯的模型信息和输入，使用 null、空数组和 0，不补造来源。
- 同一现存正文版本在折叠时复用，保留原批次和模型数据；未记录的历史日摘要在删除前补快照。除 replaced_by/replaced_at 的首次回填外不修改版本正文及来源。

每组版本最多读取 10,001 行作为超限探针，超过 10,000 行或总 JSON 超过 1 MiB 返回 413，不静默丢弃血缘。

## 召回列表

`GET /api/memory/recalls?scope=&session=&ticket=&backend=&tool=&since=&page=&turn=`

```ts
{ items: RecallEvent[], page: number, has_more: boolean }
type RecallHit = { kind: 'message', id: string } | { kind: 'summary', id: number }
type RecallEvent = {
  id: number, ts: number, backend: string,
  ticket: string | null, session: string | null, task_id: string | null,
  tool: string, args: Record<string, unknown>, access: string, scope_hint: string | null,
  returned: RecallHit[], returned_count: number, dropped_count: number,
  chars: number, max_chars: number, duration_ms: number, is_error: boolean,
  turn_href: string | null
}
```

| 参数 | 规则 |
| --- | --- |
| scope | 精确匹配 scope_hint；使用原始 `group:123` / `private:456` 等域值；没有当前聊天记录的历史域也可过滤 |
| session | 精确匹配 Codex thread ID 或 Pi conversation ID 的字符串形式 |
| ticket | 精确匹配票据 |
| backend | `codex` 或 `pi` |
| tool | `qq_recent`、`qq_search` 或 `qq_message` |
| since | 毫秒时间戳或 O4 接受的 ISO 日期，包含下界 |
| page | 从 0 开始，默认 0，最大 1,000,000；固定每页 50 条 |
| turn | 必须同时给 session；按该 O1 回合的时间窗筛选。可带 backend 限定后端；未带时查询两个后端；未知回合返回空列表 |

参数缺省表示不筛选，显式空字符串非法。所有筛选条件取交集，按 `(ts DESC, id DESC)` 倒序；同毫秒仍有确定顺序。未知或重复参数为 400。分页为 offset 语义，翻页期间新增事件可能使页边界移动。

`ts` 为工具调用开始时间，`duration_ms` 不包含观测写入耗时。args 保留调用时的原参数（默认值、trim 和 limit 夹取之前），API 输出时脱敏。access 来自授权配置，不能由工具参数改变；全域 access 为 `all`，scope_hint 为 null，单域为该域字符串。scope 过滤全域调用时不会按返回条目反推归属。

returned 与实际进入工具文本的条目顺序一致：消息 ID 为 `message_id` 字符串，摘要 ID 为 `summaries.id` 数字，不存正文。recent/search 按实际 formatter 行逐一匹配，重复行按次数消耗。message 包含主消息及进入文本的引用链，正文被部分保留也算一条；图片路径分支只保留完整条目。`dropped_count` 为本次查询取得的条数减 returned_count，**不包含数据库中被工具 limit 或时间条件排除的记录**。查询失败或参数错误也会记录事件；无命中时 count/dropped 为 0，chars 仍包含“没有记录”等提示。

recent/search 的 max_chars 沿用现有 QQ_CONTEXT_MAX_CHARS（Pi 仍额外限制至 2500）；message 沿用既有固定 **1500** 字上限，不改工具返回文本。

`turn_href` 为 `/agents/<backend>/sessions/<id>/turns/<turn>`，动态依据同 backend + session 的 O1 索引与 ts 关联，路径段进行 URL 编码。时间窗复用 O1 enrichment 的思路：下界为回合开始前 120 秒与上一回合开始加 1 毫秒的较大值；上界为回合结束（运行中则开始后 120 秒）与下一回合开始减 1 毫秒的较小值。优先实际回合区间包含事件的候选，再选开始时间最近者；同开始时间的歧义不强行归属。不能定位时为 null。关联只用当前 session 的索引，每次 HTTP 请求缓存，列表不读取回合正文块。

## 召回详情与三级证据

`GET /api/memory/recalls/:id` 返回单条 RecallEvent，并增加：

```ts
{
  ...event,
  evidence: {
    hits: (RecallHit & { ts?: number, preview?: string, deleted?: true })[],
    tool_returned: { count: number, chars: number, dropped: number },
    in_request: {
      status: 'confirmed' | 'not_found' | 'unavailable',
      turn?: string, call_id?: string, note: string
    }
  }
}
```

1. **命中条目**：hits 展开事件的 returned 引用，保持顺序，以原 access 在当前聊天库读取时间和最多 240 字脱敏预览。消息 ts 为消息时间，摘要 ts 为区间终点；条目缺失则仅返回 kind/id/deleted:true。这里不保存当时的正文，也不能重建被裁掉的命中。全域遇到跨域同 message_id 时沿用聊天库消息查询的“最新时间、最新行 ID”规则，不能保证还原历史跨域同 ID 的正文。
2. **工具返回**：count/chars/dropped 来自调用当时的埋点，不依赖当前聊天库，已删除原文也不改变这些数字。
3. **回合调用证据**：按本任务约定，in_request 使用 O1 的 tool_call 块确认关联，**不等同于工具结果进入了某次后续模型请求，更不等于模型采用**。没有调用 O3 重建或检查模型内部行为。

`confirmed` 要求：回合内有同名工具调用、arguments JSON 与事件 args 等价（对象键顺序无关，数组顺序及值类型有关）、调用时间与事件 ts 的绝对差不超过 120 秒，并有 callId。Pi 匹配 `qq_<工具>`；Codex 接受 `qq_<工具>`、`mcp__qq_context__qq_<工具>` 及 `mcp__qq_context__<工具>`。从 O1 的 text 读取参数，大块可通过 O1 自身的 ContentRef 读取不超过 1 MiB 的参数。多个符合条件的调用取时间最近者。

回合存在但找不到符合条件的块为 `not_found`；没有 session、无法定位回合、适配器缺失或回合正文不能读取为 `unavailable`。O1 已脱敏的参数不能与原始 args 严格等价时也不确认，避免两个不同秘密因被替换为同一占位符而误关联。note 始终给出限制说明；turn/call_id 无依据时省略。

示例（数字仅作示意）：

```json
{
  "id": 17, "ts": 1792324803000, "backend": "codex",
  "ticket": "ticket-example", "session": "thread-example", "task_id": null,
  "tool": "qq_search", "args": {"query": "比赛"}, "access": "group:123", "scope_hint": "group:123",
  "returned": [{"kind": "message", "id": "501"}], "returned_count": 1, "dropped_count": 2,
  "chars": 55, "max_chars": 2500, "duration_ms": 4, "is_error": false,
  "turn_href": "/agents/codex/sessions/thread-example/turns/1",
  "evidence": {
    "hits": [{"kind": "message", "id": "501", "deleted": true}],
    "tool_returned": {"count": 1, "chars": 55, "dropped": 2},
    "in_request": {"status": "confirmed", "turn": "1", "call_id": "call-example", "note": "O1 调用匹配；不证明模型采用。"}
  }
}
```

```bash
curl -sS -b "obs_token=$OBS_TOKEN" 'http://127.0.0.1:3000/api/memory/summaries/1'
curl -sS -b "obs_token=$OBS_TOKEN" 'http://127.0.0.1:3000/api/memory/recalls?scope=group%3A123&backend=codex&page=0'
curl -sS -b "obs_token=$OBS_TOKEN" 'http://127.0.0.1:3000/api/memory/recalls?session=thread-example&turn=1'
curl -sS -b "obs_token=$OBS_TOKEN" 'http://127.0.0.1:3000/api/memory/recalls/17'
```

## 存储、保留期与边界

两张新表只存在于 `observability.sqlite`，不改聊天库结构。主进程复用 ObsStore 连接；Codex MCP 惰性打开独立连接，设置 WAL、busy_timeout=5000。写入失败只记 stderr warn，不能向工具抛错。Pi 另发轻量 memory_recall trace，Codex MCP 没有 trace 总线。Codex 每轮覆盖 QQ_TICKET / QQ_BACKEND / QQ_SESSION；新线程启动前不知道 thread ID，因此本轮 MCP 记录 session=NULL，不回填或猜测关联。

`OBS_MEMORY_RETENTION_DAYS` 默认 90，非负整数，0 禁用清理。接入已有每日 onPurge，按版本 created_at 和召回 ts 严格删除早于 cutoff 的记录，独立于 events、metrics、聊天原文和 trace 的保留期。`period_start/period_end` 在表内沿用聊天库秒，API 出口转毫秒，其余观测时间为毫秒。版本独立过期可能令 replaced_by 指向已清理版本；不能把断开的血缘解读为没有来源。

周折叠的所有观测写入使用同一 savepoint，周版本与替换关系一起提交；聊天库折叠失败会回滚本次观测快照。聊天库和观测库使用两个独立 WAL 连接，无法保证跨库崩溃原子性；观测不可写时优先完成整理，血缘可能缺失。单日写入后立即记录落库版本。没有为填补历史缺失而重新调用模型。

参数错误为 400；未知摘要/召回事件为 404；超限为 413；召回观测库已降级为 503；其它读取失败为 500，统一 `{error: string}` 且不输出底层路径。缺失 O1 只影响链接与第三级证据，不让召回详情整体失败。未登录为 401，非 GET 为 405；摘要在观测库降级时仍可返回现存聊天库正文和 lineage:null。

本次不新增运行时依赖、不修改 UI 或 O3、不部署 Docker、不改 `.env`，测试仅使用临时目录。真实生产 MCP 权限与进程崩溃窗口未进行线上验证；Windows 使用不可打开的观测库路径和 SQLite query_only 故障模拟写入不可用。

## 交付文件

共 25 个文件（17 个源码、7 个测试、1 个契约文档），按建议的四个逻辑提交组织。`docs/O5-task.md` 不进入提交。

| 逻辑变更 | 文件 |
| --- | --- |
| 表、写入器与保留期 | `src/obs/memory/instrumentation.ts`、`src/obs/store.ts`、`src/config.ts`、`src/main.ts`；`test/obs/memory-instrumentation.test.ts` |
| 整理血缘 | `src/context/aging.ts`、`src/context/store.ts`、`src/main.ts`；`test/context/aging-lineage.test.ts` |
| pi / Codex 召回埋点 | `src/mcp/qq-context-server.ts`、`src/mcp/qq-context.ts`、`src/mcp/recall-results.ts`、`src/agent/pi-tools/index.ts`、`src/agent/codex-runner.ts`、`src/main.ts`；`test/mcp/qq-context.test.ts`、`test/mcp/recall-results.test.ts`、`test/agent/pi.test.ts`、`test/agent/codex-runner.test.ts` |
| 只读 API 与契约 | `src/obs/memory/http.ts`、`src/obs/memory/read.ts`、`src/obs/memory/types.ts`、`src/obs/memory/lineage.ts`、`src/obs/memory/recalls.ts`、`src/obs/http.ts`（仅注入适配器）；`test/obs/recall-http.test.ts`；本文 |

## 验收记录

2026-10-18，Windows / Node v24.15.0：`npm.cmd run typecheck && npm.cmd test && npm.cmd run build` 全部通过，**70 个测试文件 / 972 项测试，0 失败、0 跳过**；相对 66 文件 / 917 项基线新增 4 个测试文件、55 项测试。原有 Windows 进程树测试需要沙箱外权限，完整验收在沙箱外运行。首次全量仅原有 memory-pages 导航测试遇到随机端口触发 `fetch: bad port`，单独复跑及随后完整三项检查全部通过，没有改动该测试条件或 UI。

相对设计的实现边界：第三级按任务要求使用 O1 调用块作关联证据，不声称重建了模型请求；跨两个 WAL 库为尽力一致而非分布式事务；新 Codex 线程 session 缺失保持 NULL。已删除摘要的详情增加可选 deleted:true，便于页面继续展示快照。故障测试和匿名 rollout / Pi 条目验证通过，未进行线上真实模型、生产文件权限或进程崩溃恢复冒烟。
