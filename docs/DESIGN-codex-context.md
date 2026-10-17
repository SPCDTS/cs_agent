# 设计：codex 执行层的上下文、聊天记录检索、Web 搜索与"先查再画"

> 状态：待用户确认，未实现。目标是让 codex 适合长期运行：有自己的语境，但上下文增长有界、不注入冗余信息。

## 0. 现状与问题

| 现状 | 问题 |
|---|---|
| 所有发送者共用一个固定 codex 线程，无限续聊 | 私聊与群聊串在一个上下文里；rollout 无限增长，每次 resume 都要重放；无法按需清理 |
| 每轮只给 codex 一行来源标注 + 正文 | codex 看不到任何 QQ 历史，"刚才那条"、"上面说的"无法理解 |
| `AGENTS.md` 只有安全规则 | 回复格式靠意图层兜底，codex 自己可能先写一大段 Markdown |
| `web_search` 未配置（默认 cached 索引） | 时效性问题答不准 |
| 意图层"恰好一个业务工具" | 生图请求涉及现实实体/时事时，没有机会先查资料再组织提示词 |

## 1. 总体原则

1. **拉取优于推送**：历史记录不随每轮注入，由 codex 在需要时通过工具按需拉取，且返回紧凑格式、有硬上限。
2. **按会话域隔离**：codex 线程以"私聊某人 / 某个群"为单位，语境天然相关，不串话。
3. **有界轮换 + 交接摘要**：线程达到阈值即轮换，用一段受控的交接笔记延续记忆，而不是让上下文无限堆积。
4. **codex 只能看见自己会话域的历史**：权限由中继层按次注入，不由消息内容决定。
5. **研究与执行分离**：生图前的资料检索用一次性 codex 会话完成，不污染长期线程。

## 2. codex 线程模型：按会话域 + 有界轮换

### 2.1 线程键
- `scope = private:<user_id>` 或 `group:<group_id>`。
- 映射表 `/data/codex-threads.json`：`{ [scope]: { thread_id, created_at, turns, last_input_tokens, last_used_at, archived: [...] } }`，原子写。
- 每个 scope 一把互斥锁（同一线程不并发），不同 scope 可并行（受 `AGENT_CONCURRENCY` 约束）。
- 迁移：现有 `codex-session.json` 的线程归入 `private:<owner>`，保持你的连续性；其他 scope 首次使用时新建。

### 2.2 每轮注入内容（最小化）
```
[来源] 群 200000001 · 昵称(QQ号) · 2026-10-17 22:41
[引用] 昵称: 被引用消息正文（≤200 字，仅当消息带 reply 段时出现）
<正文>
```
不再附带任何历史、规则或状态说明；规则全部放在 `AGENTS.md`（一次性加载）。

### 2.3 轮换（rotation）
触发条件任一满足即在**下一轮开始前**轮换：
- 上一轮 `turn.completed.usage.input_tokens` > `CODEX_ROTATE_INPUT_TOKENS`（默认 120000，低于 codex 自身压缩阈值，保证摘要内容受我们控制）；
- 累计轮数 > `CODEX_ROTATE_TURNS`（默认 150）；
- 线程年龄 > `CODEX_ROTATE_DAYS`（默认 14）。

轮换流程：
1. 在旧线程里以 `low` 强度发一条固定指令："写一份交接笔记，≤400 字，纯文本，只包含：对方的长期偏好与事实、未完成的任务、你已承诺的事项。不要复述聊天内容。"
2. 笔记存 `/data/codex-handoff/<scope>.md`（覆盖）。
3. 新建线程，首轮 prompt 前置 `[交接笔记]\n<内容>`，随后是正常的本轮消息。
4. 旧线程 id 进 `archived`，不再 resume。
5. 失败兜底：交接步骤超时或出错 → 不带笔记直接新建线程，并记录日志。

codex 自身的自动压缩仍然保留作为安全网，但正常情况下不会触发。

## 3. 聊天记录：本地消息库 + MCP 按需检索

### 3.1 消息库（QQBridge 新增职责）
- 存储：`/data/qq-messages.sqlite`，表 `messages(scope, message_id, time, user_id, nickname, is_self, text, reply_to_id)` + FTS5 虚表（`tokenize='trigram'`，中文子串可检索）。
- 范围：**仅**允许的群的全部消息 + 允许用户的私聊消息；机器人自己发出的回复也入库（`is_self=1`），codex 才能知道"我上次说了什么"。
- 媒体只存 `[image]` 等占位，永不下载。
- 保留 `QQ_HISTORY_RETENTION_DAYS`（默认 30）天，每日清理；撤回事件（`group_recall`）删除对应行。
- 消息入库与现有触发/票据逻辑解耦：不触发的群消息也入库。

### 3.2 MCP 服务 `qq_context`（容器内，stdio，Node）
注册进受管 `config.toml`：
```toml
[mcp_servers.qq_context]
command = "node"
args = ["/app/dist/mcp/qq-context.js"]
startup_timeout_sec = 10
tool_timeout_sec = 15
```
**作用域按次注入**：每次 `codex exec` 追加 `-c mcp_servers.qq_context.env.QQ_SCOPE="group:200000001"`。MCP 进程只能读该 scope；参数里不接受 scope。私聊 scope 永不可见于群，反之亦然。

工具（返回全部为紧凑纯文本，不含 JSON 噪音）：

| 工具 | 参数 | 返回 | 上限 |
|---|---|---|---|
| `qq_recent` | `limit≤30`, `before_message_id?` | `HH:MM 昵称: 文本` 每行一条，自己发的标 `[我]` | 单条 ≤120 字，总量 ≤2500 字 |
| `qq_search` | `query`, `days≤30`, `limit≤20` | `MM-DD HH:MM 昵称: 文本`，按时间倒序 | 同上 |
| `qq_message` | `message_id` | 该条完整正文 + 其引用链（≤3 层） | ≤1500 字 |

### 3.3 AGENTS.md 中的使用纪律（防冗余）
- 只有在消息指代了此前内容（"刚才"、"上面"、"那个"、无先行词的代词、明显的追问）或用户明确要求回顾时才调用 `qq_recent`；一般问题直接回答。
- 优先 `qq_search` 带具体关键词，而不是大范围 `qq_recent`。
- 一次请求最多调用历史工具 2 次。
- 不要把检索到的历史原文复述进回复，只给结论。

## 4. 回复规则（写入 `/workspace/AGENTS.md`，热编辑）

- 回答会原样显示在 QQ 里：纯文本，不用 Markdown、代码围栏、表格、标题符号。
- 中文；默认 ≤300 字，用户明确要长文时再放开（上限由中继层 4000 字截断）。
- 不复述问题，不解释自己用了什么工具，不输出"作为 AI"类套话。
- 需要给链接时最多 1 条，不给链接列表。
- 不确定的事实要明说"不确定/未核实"，不要编造。
- 群聊中回答面向群内读者，私聊面向本人；不要在群里转述别人私聊内容（权限层本来也不允许）。
- 安全规则维持现状（不泄露凭据/环境/工作区外文件）。

## 5. Web 搜索

受管 `config.toml` 新增：
```toml
web_search = "live"            # CODEX_WEB_SEARCH=live|cached|disabled，默认 live
[tools.web_search]
context_size = "low"           # CODEX_WEB_SEARCH_CONTEXT=low|medium|high，默认 low：限制搜索结果注入量
```
`low` 是为了上下文经济：搜索结果摘要进线程越少越好；研究型任务由 §6 的一次性会话承担，可用 `medium`。

## 6. 意图层调整："先查再画"

### 6.1 新工具 `research`
- 参数：`question`（要核实什么、为画面服务）、`max_chars`（默认 600，上限 1000）。
- 实现：`codex exec --ephemeral -c web_search="live" -c tools.web_search.context_size="medium" -c model_reasoning_effort="medium"`，**不**使用任何长期线程，一次性会话，结束即丢。
- 固定指令：只返回与视觉呈现相关的事实（外观、颜色、标志、场景、人物/队伍身份、时间与结果等），纯文本，≤max_chars，不确定的标注"未核实"。
- 超时 `RESEARCH_TIMEOUT_SEC`（默认 180）；失败时返回空结果，意图层按"不依赖外部信息"继续生图并在回复里说明。

### 6.2 新的动作规则（系统提示 + 代码守卫）
```
纯生图，且画面不涉及需要核实的现实实体/时事  → generate_image → reply_qq
纯生图，但涉及具体队伍/人物/赛事结果/当日天气/节日等外部事实
                                              → research → 组装英文提示词 → generate_image → reply_qq
其他                                          → ask_codex → reply_qq
```
代码守卫 `claimBusinessCall` 改为状态机：`research ≤1 次`，`generate_image ≤1 次`，`ask_codex ≤1 次`，`ask_codex` 与 `generate_image` 互斥，`research` 之后必须接 `generate_image`。
生图回复文案可用一句话说明参考了哪些信息（如"按今天决赛结果画了 X 队举杯"）。

## 7. 配置项（新增）

```
CODEX_WEB_SEARCH=live
CODEX_WEB_SEARCH_CONTEXT=low
CODEX_ROTATE_INPUT_TOKENS=120000
CODEX_ROTATE_TURNS=150
CODEX_ROTATE_DAYS=14
QQ_HISTORY_RETENTION_DAYS=30
QQ_CONTEXT_MAX_CHARS=2500
RESEARCH_MAX_CHARS=600
RESEARCH_EFFORT=medium
RESEARCH_TIMEOUT_SEC=180
```

## 8. 边界与隐私

- 群成员能让 codex 检索**该群** 30 天内的消息，这与他们本来就能翻群聊天记录一致；私聊记录只对本人 scope 可见。
- 消息库是本地聊天记录，`./data` 需按聊天记录保管；撤回同步删除，但无法撤回已发出的 QQ 消息。
- 交接笔记是 codex 生成的摘要，可能带偏差；它只影响 codex 的"记忆"，不影响权限与路由。

## 9. 实施拆分（三个可独立验证的提交组）

1. **消息库 + `qq_context` MCP + AGENTS.md + web_search 配置**：QQBridge 入库与清理、FTS5、MCP 服务与作用域注入、受管 config.toml；测试：假 OneBot 入库/撤回/清理、MCP 工具上限与越权 scope 拒绝。
2. **按会话域线程 + 轮换**：`codex-threads.json`、每 scope 互斥、迁移旧会话、交接流程；测试：假 codex 验证 scope 隔离、阈值触发、交接失败兜底、并发。
3. **research 工具 + 意图规则 + 状态机守卫**：测试：faux 模型三条路径、守卫拒绝非法序列、research 失败降级。

每组通过后各自重建部署一次，便于定位问题。

## 10. 需要你确认的选项

| 选项 | 推荐 | 备选 |
|---|---|---|
| 线程粒度 | 按会话域（私聊/群各一） | 保持单一全局线程（简单，但串话且不可控增长） |
| 群内粒度 | 整群一个线程 | 群内按发送者分线程（隔离更强，但群聊语境割裂、线程数多） |
| 轮换阈值 | 120k 输入 tokens / 150 轮 / 14 天 | 更激进（60k）以压成本，或更宽松 |
| 历史保留 | 30 天 | 7 天 / 90 天 |
| research 执行者 | codex 一次性会话 + web_search | 给 DeepSeek 单独接搜索 API（当前无可用 key） |
