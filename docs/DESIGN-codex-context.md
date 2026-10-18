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
  - **按需检索，不自动注入**（2026-10-18 用户确认，取代早期"派发器每条消息前注入 recent 块"的方案）：派发时不预先拼接历史，只有消息指代此前内容或用户要求回顾时，由执行层自己调工具检索（见两个后端的提示词）。唯一自动带入的历史是 `[引用]` 头部：消息带 reply 段时按 `replyTo` 从库里查原文（≤200 字）。
  - codex：`qq_context` MCP 服务是同一模块的 stdio 外壳，工具 `qq_recent` / `qq_search` / `qq_message`，访问范围由 `QQ_ACCESS` 注入。
  - pi：进程内直接调用同一个 `callQQContextTool`，工具名与参数相同。
  - 观测后台：聊天记录页同样经 `callQQContextTool` 渲染。
- 效果：两层看到的历史内容、裁剪规则、字数上限完全一致；追问"把刚才那张图改成蓝色"时，意图层与 codex 看到的都是同一行 `[我] → 生图 prompt="..."`。

### 2.5 图片记忆与召回（2026-10-18 用户需求；同日用户改为"按需召回"，取代先前的"全部入库"方案）
**问题**：消息库只存 `[image]` 占位；入站图片只在触发消息里下载到 `incoming/<ticket>/`，且只能被本票据使用。用户说"上面那张图"或引用一张旧图时，agent 拿不到这张图；机器人自己发出的图在票据清理后也找不回。
**原则**（用户决定）：图片**默认不进入记忆系统**。只有 LLM 调用召回工具时，才下载这张图放进媒体库，并把消息库里对应的 `[image]` 占位换成本地路径。

#### 2.5.1 默认行为不变
- 入库、`[image]` 占位、触发消息的票据图片（`incoming/<ticket>/`，只供本票据使用，不进媒体库）全部保持现状。不做后台下载，不在入库时存图片 URL。
- `[引用]` 头部改为 `[引用 #<message_id>] 昵称: 正文`，让 LLM 能拿这个 id 去召回被引用消息里的图。被引用消息已召回过的，正文里自然带着路径。

#### 2.5.2 召回工具 `qq_image`
- 参数：`message_id`（来自 `qq_recent` / `qq_search` / `qq_message` 行首的 `#id`，或 `[引用 #id]`；机器人自己的回复行同样可以召回）。
- 两个后端同名同参数：pi 在进程内调用；codex 通过 `qq_context` MCP 调用（见 2.5.4）。两边最终都调用主进程的同一个 `MediaRecall.recall(access, messageId)`（`src/context/media.ts`，新增）。
- `recall` 的步骤：
  1. **范围**：`store.message(access, id)` 必须命中，否则返回"没有这条消息，或不在当前会话范围内"。命中行的 `scope` 记为 S，后续一律以 S 为准。
  2. **已召回**：S 下这条消息已有 `ok` 的媒体行时，直接返回已有路径，不访问网络（幂等）。
  3. **没有图**：用户消息正文不含 `[image]`、机器人行 `image_count` 为 0 时，返回"这条消息没有图片"。
  4. **取原消息**：调 NapCat `get_msg(message_id)`，**必须校验**返回的消息属于 S：
     - 群 S：`message_type=group` 且 `group_id` 一致；
     - 私聊 S、用户发的消息（库中行 `is_self=0`）：`message_type=private` 且发送者 `user_id` 就是 S 的用户；
     - 机器人自己发的消息（库中行 `is_self=1`，群聊私聊都适用）：`get_msg` 只能证明发送者是机器人，证明不了收件人，所以**收件人以本地票据为准**——库中行必须带 `ticket`，`bridge.getTicket(ticket)` 的记录必须满足：会话（群号 / 私聊用户）等于 S、`status=sent`、`reply_message_id` 等于本次的 `message_id`；`get_msg` 返回的发送者必须是该票据的 `self_id`。如果 `get_msg` 另外带了收件人或会话字段（不同 NapCat 版本可能有），也必须与 S 一致。任何一项缺失或不符都拒绝。
     不一致直接拒绝并记 warn，不下载任何东西。只取这一条，不沿引用链往上。
  5. **下载**：取其 image 段（每条最多 6 张），复用 `incoming-http.ts` 的 `downloadImage`（SSRF 防护、重定向、大小上限），失败时同样走 `get_image` 刷新 URL，绝不读 NapCat 宿主机路径。校验规则与参考图一致（12 B–10 MiB、PNG/JPEG/WebP/GIF、`validateImageHeader`）；不合格的记 `skipped` 并写原因（例如"动图不支持"）。
  6. **入媒体库**：写入 `${DATA_DIR}/media/<sha256 前 2 位>/<sha256>.<ext>`，按内容寻址，同图只存一份；目录与文件沿用 `incoming.ts` 的防符号链接 / 越界检查，已存在的同名文件校验字节一致后复用。新表 `message_media(scope, message_id, ordinal, sha256, path, status, reason, created_at)`，主键 `(scope, message_id, ordinal)`，由 `ContextStore` 建表与迁移。
  7. **换占位**：见 2.5.3。
  8. **返回**：每张一行，`图1: /data/media/ab/<sha>.png（1024×768）`，或 `图2: 不可用（原因）`。
- 并发与限额：同一 `(S, message_id)` 并发调用合并为一次；全局并发 2；单次召回总截止 60 s；**每个票据最多召回 5 次**，超出返回"本轮召回次数已用完"。

#### 2.5.3 记忆里的表示
- 召回成功后，用 `UPDATE` 把 `messages.text` 里对应的 `[image]` 换成 `[image:<绝对路径>]`；FTS 由现有触发器自动同步。替换规则：
  - 用 `get_msg` 返回的段按 `policy.ts` 的 `renderText` 重新渲染，如果结果（按入库时同样截断到 16000）与库里的 `text` 完全一致，就按段的顺序精确替换：第 n 个图片段 → 第 n 张图的路径，失败的保持 `[image]`；
  - 不一致时（例如用户亲手打了 `[image]` 字样），在正文末尾追加 ` [image:<path>]`，不改动原文；
  - 机器人行（正文是摘要，不含占位）一律追加到末尾。
- `format.ts`：正文 120 字截断时，`[image:...]` 当作一个不可分割的整体，要么完整保留，要么整体移到省略号之后，绝不截出半个路径；总字数超出时整行丢弃。
- 衰老任务的摘要输入把 `[image:...]` 还原成 `[image]`（路径对摘要没有价值）。
- 删除：`recall` 撤回和 `purge` 清理时同步删除对应的媒体行；每日衰老任务做文件 GC，删除没有任何媒体行引用、且 mtime 超过 1 天的文件。媒体保留期因此与原始消息一致，不另设配置。

#### 2.5.4 codex 侧接入：主进程 loopback 端点
- `qq_context` MCP 保持只读，不持有 NapCat 凭据，也不写库。召回经主进程完成，沿用 ComfyUI loopback 转发的先例：
  - 主进程在 `127.0.0.1:MEDIA_RECALL_PORT`（默认 8790，只绑定 loopback）提供 `POST /recall`，请求体 `{message_id}`，带 `Authorization: Bearer <token>`。
  - **令牌**：每次 codex exec 生成一个随机 32 字节令牌，在主进程内绑定 `{access, ticket, 截止时间 = 本轮截止, 剩余次数 = 5}`，通过 `-c mcp_servers.qq_context.env.QQ_RECALL_TOKEN="…"` 注入，本轮结束（无论成败）立即作废。访问范围只取令牌绑定的值，请求里不接受范围。
  - codex 能看到自己的令牌，也能从 shell 访问 loopback，但令牌只覆盖它本来就有的访问范围和次数，没有提权。
- pi：工具直接调用 `MediaRecall`，`access` 取自 `PiRequestDoc.access`，次数限额同样按票据计。

#### 2.5.5 召回后的图怎么用
- **看图**（2026-10-18 用户决定：两个后端行为一致）：`qq_image` 在两个后端都**只返回路径文本**，不在工具结果里附带图片内容。看图由各自的文件工具完成：codex 用自带的本地图片查看，pi 用内置 `read` 工具（§4.5，`read` 读图片文件时返回图片内容）。
- **当参考图**：`generate_image.reference_images` 的允许列表 = 本票据参考图 ∪ **媒体库中属于本次访问范围的 `ok` 路径**（`access=all` 时为全部 scope）。路径必须 realpath 落在 `${DATA_DIR}/media/` 下，并且在 `message_media` 里能按 path 查到 scope 在访问范围内的行，否则拒绝。这样群聊里的 agent 拿不到 owner 私聊或其他群的图。
  - `image-references.ts` 新增带媒体库的校验函数，原 `validateReferences` 不变；
  - pi `generate_image` 用请求的 `access` 判断范围；
  - codex 的 `image_gen` MCP 每次 exec 追加注入 `QQ_ACCESS`（与 `qq_context` 同值），以只读方式打开 `ContextStore` 判断范围；`IMAGE_REFS` 语义不变；
  - `tasks.ts` 的显式生图路由（`奶龙:` 前缀，不经 LLM）**不变**：它没有 LLM 调用召回工具，引用旧图在这条路由上仍不可用。
- 两个后端的提示词同步修改：`[image]` 表示未召回的图，需要看图或拿来当参考图时，用 `qq_image` 召回（每轮最多 5 次），拿到路径后用文件工具打开查看；`[image:<路径>]` 表示已召回，可以直接使用；`reference_images` 只能用本轮参考图或这些路径，不得编造。

#### 2.5.6 配置
`MEDIA_RECALL_PORT`（默认 8790）、`MEDIA_RECALL_MAX_PER_TICKET`（默认 5）。写入 `config.ts`、`.env.example`、`docs/DEPLOY.md`。

#### 2.5.7 验收要点
- 单测：
  - 范围：跨 scope 的 message_id 被拒；`get_msg` 返回其他群 / 其他私聊被拒，且不落任何文件；机器人行：没有 ticket、票据会话不是 S、`reply_message_id` 不符、票据不是 sent 时都被拒（覆盖"机器人发给 B 的消息冒充 `private:A`"的反例）。
  - 幂等与限额：重复召回不访问网络；并发召回合并为一次；每票据 5 次限额。
  - 占位替换：段一致时精确替换、不一致时末尾追加、机器人行追加；FTS 能搜到路径。
  - 格式化：路径不被截断、超额整行丢弃；摘要输入还原成 `[image]`。
  - 媒体库：内容寻址与复用、符号链接越界拒绝、级联删除 + GC 宽限期。
  - loopback 端点：无令牌 / 过期 / 作废 / 次数用完都被拒；只绑定 127.0.0.1。
  - 历史选图：允许本范围路径，拒绝跨 scope 和非媒体目录路径；pi 与 `image_gen` MCP 两个入口都要覆盖。
  - `[引用 #id]` 头部格式及其防伪造改写。
- 冒烟：群里未 @ 发一张图 → `qq_recent` 只看到 `[image]`，媒体库为空；随后 @机器人 "把上面那张图改成卡通风格" → agent 调 `qq_image` → 媒体库出现文件，`qq_recent` 显示路径 → 生图请求带参考图；另一个群的 agent 召回这条 id 被拒。

#### 2.5.8 验收修正（2026-10-18，对抗审查 1 阻断 + 3 major + 4 minor）
1. **codex 不得直接读媒体库（阻断）**：所有会话的图都在同一个 `/data/media`，而 codex 的 `deny_read`（`scripts/entrypoint.sh`）没有覆盖它，群聊里的 codex 能用 shell 枚举、读取 owner 召回的私聊图片，绕过 `qq_image` 与参考图校验。修正：
   - `deny_read` 加入 `"$D/media"`，AGENTS.md 删掉"可只读打开 media 路径"那条，改为"用 `qq_view_image` 查看"；
   - `qq_context` MCP 新增 `qq_view_image(path)`：经同一个 loopback 端点（`POST /view`，同一个每轮令牌，不另计召回次数）由主进程校验 `mediaPathAllowed(令牌绑定的 access, path)` 与 `readMediaFile`，通过后以 MCP 图片内容返回（一次一张）。MCP 进程本身不读媒体文件。
   - `qq_image` 仍只返回路径文本（用户要求的两后端一致不变）；看图在 pi 用内置 `read`，在 codex 用 `qq_view_image`。
   - 冒烟时必须实测：codex 沙箱内 `ls/cat /data/media/...` 读不到；codex 自带的本地看图能力也读不到 `/data/media`（若能读到，记为新的阻断并上报）。
2. **文件发布原子化 + GC 不误删（major）**：先写同目录唯一临时文件 `.<sha>.<rand>.tmp`，校验后 `link()` 发布为最终文件名（已存在则校验已有文件；已有文件损坏时用 `rename()` 原子替换）；复用已有文件时 `utimes` 刷新 mtime，使 1 天 GC 宽限期覆盖"复用后尚未提交媒体行"的窗口；GC 跳过临时文件但清理 1 天前的残留临时文件。
3. **子进程环境改为白名单（major）**：pi 的 `bash` 子进程只继承 `PATH HOME USER LOGNAME SHELL LANG LANGUAGE LC_* TZ TERM TMPDIR` 及工具自身传入的变量，不再按变量名黑名单过滤（`COMFYUI_URL` 之类带内嵌凭据的 URL 也不会泄漏）。
4. **动态令牌不占长期秘密表（minor）**：召回令牌不再 `registerSecrets`；改为可撤销的临时秘密（注册返回 dispose，令牌作废时移除）。长期秘密表满额时记一次 warn，而不是静默忽略。
5. **single-flight 生命周期独立（minor）**：共享任务只受自身 60 s 截止控制；每个等待者按自己的取消信号单独退出；全部等待者都退出时才取消底层任务。
6. **票据额度回收（minor）**：票据没有活跃令牌且距最后一次作废超过 30 分钟时删除其额度记录（保留重试窗口，不因单个令牌作废而重置额度）。
7. **符号链接竞态（minor，接受）**：利用前提是能修改 `/data/media` 目录；codex 对该目录既不可写也不可读（第 1 条），pi 已按 §4.5 接受全文件访问风险。不改代码，在此记录。
8. **撤回也删除机器人行**：实现把 `recall` 的 `is_self = 0` 条件去掉了。评估后接受：被撤回的机器人消息在 QQ 里已不存在，删除其行与媒体行是正确的；撤回事件只来自 NapCat，不能伪造。

#### 2.5.9 验收记录（2026-10-18，主会话验收通过，合并 707538a 并已部署）
- 实现：分支 feat/image-recall 共 10 个提交（5aa7d19…e3d206a），含 §2.5.8 的 5 个修正提交。
- 测试：Linux 容器（node:24-bookworm-slim）内 typecheck 通过，49 文件 631 项全部通过。Windows 本机全量多次出现已知的原生 worker 退出 3221226505（落在不同文件；main 基线 fa019ae 两次运行中也复现一次），无任何断言失败；新增的 media.test.ts 单独连跑 5 次均为 36/36。
- 代码复读：召回前后两次范围校验、机器人行按票据核对收件人、参考图授权以 message_media 为准（手写 `[image:/etc/passwd]` 不产生授权）、loopback 只绑 127.0.0.1 且令牌在所有退出路径作废、bash 子进程环境白名单、原子发布与 GC 宽限。
- 对抗审查（gpt-6-astra）：1 阻断 + 3 major + 4 minor，处理见 §2.5.8；修正后复查通过。
- 线上冒烟（容器内，不向 QQ 发消息）：召回端点无令牌 401；qq_context MCP 列出 qq_image / qq_view_image；对群 200000001 的一条机器人发图消息实测召回——跨会话访问被拒、get_msg + 票据校验通过、图片入库 `/data/media/70/…png`（1024×1024）、二次召回走缓存、消息库正文替换为 `[image:<路径>]`、本会话 view 返回 image/png、他群 view 被拒；codex 沙箱内 `ls /data/media`、读该文件、读 qq-messages.sqlite 均 Permission denied（对照 `/data/prompts` 可读）。
- 未覆盖：真实 QQ 端到端（用户发图 → @机器人"把上面那张图…"）留待用户实测；pi 内置工具尚未在真实流量上使用（pi 后端需经设置切换）。

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

## 4. 分流与执行（v3，2026-10-18 用户决定：规则分流器 + 可切换后端的执行 agent）

> 取代 v2 的"意图识别 agent / 路由器"。分流不用模型：消息以 `奶龙:` 开头 → 前缀之后全部作为提示词直接生图；否则整条消息交给**执行 agent**。执行 agent 有两个可互相切换的后端：**pi-durable**（进程内 durable 会话 + 工具）与 **codex**（容器内 CLI 固定线程）。

### 4.1 规则分流器（无模型）
- 取 normalize 后的 `text`（群聊的真实 at 段已由 bridge 剥离）去首尾空白；前缀匹配 `IMAGE_PREFIXES`（默认 `奶龙:,奶龙：`，逗号分隔，大小写与全/半角按配置原样匹配）。
- 命中：`prompt = 前缀之后的全部文本`（保留原文，不翻译不改写）；为空 → 回复固定用法提示"奶龙: 后面写要画的内容"。
- 未命中：整条原文交给执行 agent。
- 分流结果与原因写入票据文档（`route: image|agent`，`prefix`），供观测。

### 4.2 生图路径（无模型）
pi-durable 任务两阶段：`generate`（现有 generate-image 实现，走 comfy-mcp / http）→ `reply`（固定模板：成功"图片生成好了"+ 图；失败按类别：服务不可用 / 超时 / 内容被拒 / 其他）。检查点保证崩溃后不重复生图、不重复发送。统一上下文 `completeReply(action=generate_image, detail=prompt)`。

### 4.3 执行 agent 与后端抽象
```ts
interface AgentBackend {
  name: "codex" | "pi";
  handle(req: { ticket; scope; access; threadKey: "owner"|"shared"; source; text; quote? },
         ctx: { signal; onEvent(e) }): Promise<{ text: string }>;
}
```
- 选择：`AGENT_BACKEND=codex|pi`（全局默认 `codex`，保持现状），可选 `AGENT_BACKEND_OVERRIDES=group:200000001=pi,private:10000001=codex` 按 scope 覆盖。切换只影响后续消息，两后端的记忆各自独立。
- **线程键**沿用 owner / shared 两分（§3.1），两后端都按此隔离记忆；同一线程键串行，不同并行。
- **图片附带（两后端统一）**：后端在回合中若调用了生图（pi 的进程内工具 / codex 的 `image_gen` MCP），图片写入 `/data/images/<ticket>/`；适配层在回合结束后收集该目录内本回合产生的文件（≤4 张）随文本一并发出。后端不需要也不能指定回复目标。
- **回复后处理（两后端统一）**：代码清洗（去 Markdown 代码围栏/标题/表格符号，不出现 `@`，UTF-16 ≤4000 截断）。codex 后端额外保留 `CODEX_REPLY_MODE=relay|direct`（默认 `relay`：用意图模型做一次 ≤5 行提示的格式整理，失败回退清洗；`direct`：仅清洗）。pi 后端由其系统提示直接产出合规文本，仅清洗。

### 4.4 codex 后端（现有能力的适配）
- 现有 ask-codex：owner/shared 线程、`CODEX_HOME` 受管配置、`qq_context`（`QQ_ACCESS` 按次注入）、浏览器 MCP、`web_search = "live"`、沙箱与 deny_read。
- 推理强度：不再由模型选择，取 `CODEX_REASONING_EFFORT`（默认 high）；允许消息内显式指令如 `#low` / `#xhigh` 前缀？——**不做**，保持简单。
- 新增 **`image_gen` MCP**（容器内 stdio，复用 generate-image 实现）：工具 `generate_image(prompt)`，输出目录由每次 `-c mcp_servers.image_gen.env.IMAGE_TICKET_DIR=/data/images/<ticket>` 注入，返回生成文件名；工具注解非只读，审批模式同 `approve`。于是 codex 可以先 web_search 再生图（"先查再画"由执行 agent 自行决定，不再有专门研究器）。
- `AGENTS.md`（全局受管）补一条：需要出图时调用 image_gen，图片会随回复自动发给用户，回复文本只需一句说明。

### 4.5 pi-durable 后端（新）
- **每个会话域一条长期 durable conversation**（2026-10-18 评审后决定：owner 私聊一条；每个群一条；每个其他私聊用户一条；键 = `owner` | `<scope>`），id 持久化在 `/data/pi-threads.json`。与 codex 的 owner/shared 两分不同：pi 会话成本低，按域隔离可彻底避免非 owner 私聊与群聊共享记忆与压缩摘要。自动 compaction 开启（`reserveTokens` / `backgroundTokens` 取 pi-durable 默认或配置），记忆靠 compaction 摘要，不做轮换。
- 模型：`AGENT_MODEL_PROVIDER`/`AGENT_MODEL_ID`（现为 deepseek / deepseek-flash）、`AGENT_THINKING_LEVEL`。
- 工具（进程内，复用同一实现）：`web_search(query, count≤8)`、`fetch_page(url)`（§4.6）、`qq_recent` / `qq_search` / `qq_message`（统一上下文存储，**访问范围绑定到当前请求**：由适配层在 submit 时把 access 写入会话文档，工具执行时读取；shared 线程内不同 scope 的请求串行，因此不会串用）、`generate_image(prompt)`（写 `/data/images/<ticket>/`）、`qq_image`（§2.5）。不接浏览器。
- **内置工具全部启用**（2026-10-18 用户决定）：安装 pi-durable 的 `createCodingTools()` 扩展，即 `read` / `write` / `edit` / `bash`，所有会话都启用（群、owner 私聊、其他私聊一视同仁）。
  - `read` 配置图片处理（`ReadToolOptions.images`，取 `DEFAULT_IMAGE_LIMITS`），读 PNG/JPEG/WebP/GIF 时返回图片内容，用于查看 `qq_image` 召回的图和本票据参考图。
  - 执行环境：`NodeExecutionEnv`，每个 pi 会话一个工作目录 `${DATA_DIR}/pi-work/<会话键>/`（会话键中的 `:` 换成 `_`，首次使用时创建）；绝对路径不受限制。
  - 子进程环境：`bash` 启动的进程**不继承**主进程里的凭据类环境变量（`NAPCAT_TOKEN`、`DEEPSEEK_API_KEY`/`DEEPSEEK_APIKEY`、面板口令及其他已注册的秘密），与 codex 侧"口令不进子进程环境"一致。这只是不把凭据直接塞给子进程，不限制工具本身的能力。
  - **已接受的风险**：pi 跑在主进程里，没有 codex 那样的沙箱与 `deny_read`。内置工具能读写容器内的全部文件（包括各会话的消息库、票据库、`/data/obs-token`），群成员可以通过提示注入间接驱动这些工具，历史工具的访问范围过滤因此不再是硬边界。用户已知情并决定启用。
  - 观测：内置工具调用与 codex 内置命令同口径记录（工具名、命令或路径前 200 字、退出码、耗时），计入每票据事件预算。
- 系统提示：`/data/prompts/agent.md` 热加载（与 codex 的 AGENTS.md 规则对齐：纯文本中文简短、不可信内容声明、历史工具纪律、需要事实先搜索、需要出图调用 generate_image 并一句话说明）。内置默认值在代码中。
- 每轮输入格式与 codex 相同：`[来源] … / [引用] … / 正文`。
- 工具调用上限（代码守卫）：每回合 `web_search ≤4`、`fetch_page ≤4`、`generate_image ≤2`、历史工具 ≤4（`qq_image` 另按每票据 5 次计）、内置工具合计 ≤20（`bash` 单次超时 60 s）；超限工具返回错误文本。回合超时 `PI_TURN_TIMEOUT_SEC`（300）。

### 4.6 联网检索工具（DeepSeek Search/Fetch API，pi 后端使用）
已核实：`POST https://api.deepseek.com/v1/tools/search`（`query` ≤128 字、`count` ≤50、`need_content`、支持 `site:` `lang:` `after:` 操作符）与 `POST /v1/tools/fetch`（`url` → Markdown 正文），同一 API key，5 QPS，$0.75/千次，2026-11-01 前免费。
| 工具 | 参数 | 返回 | 上限 |
|---|---|---|---|
| `web_search` | `query`, `count≤8` | 每条 `标题 / 日期 / 摘要(summary) / url`，按 rerank_score 排序 | 总量 ≤2500 字 |
| `fetch_page` | `url` | 页面正文 | ≤4000 字，超出截断 |
429 时退避重试一次；其他 4xx 不重试。codex 后端用 codex 自带的 web_search，不走这组。

### 4.7 会话感知与顺序
- 两后端都有自己的记忆（codex 线程 / pi 会话 compaction），再加 `qq_context` 工具按需拉取历史；不再向任何模型注入"近期交互"上下文块。
- 派发器按 scope FIFO 串行，不同 scope 并行（受 `AGENT_CONCURRENCY`）：保证同一会话里回复顺序与消息顺序一致。
- 生图路径不经过任何 agent，追问改图（"把刚才那张改成蓝色"）会进入执行 agent，由它用 qq_context 看到上一条 `[我] → 生图 prompt="…"` 后调用生图工具完成。

### 4.8 容器内浏览器（codex 后端）（替代 egolite）
已核实：ego (lite) 目前仅有 macOS 桌面版，Windows 为未开放的 closed beta，Linux 在路线图；没有 headless / 独立 CLI / Docker 模式，agent 通过 `ego-browser` 技能驱动桌面应用内的页面 JS 工具，协议未公开。它无法在 Linux 容器内运行，本机也未发现安装。

本期方案：
- **阅读型需求**（绝大多数）：意图层用 DeepSeek `fetch_page`（页面 → Markdown），codex 用 `web_search = "live"`。不需要浏览器。
- **交互型需求**（JS 渲染页、点击、登录态）：给 codex 配 `@playwright/mcp`（headless Chromium，容器内安装，镜像约增 400 MB），注册为 `[mcp_servers.browser]`，`--headless --isolated`，无宿主机登录态。意图层不接浏览器。
- egolite 推出 Linux/headless 版本后，可用同一个 `[mcp_servers.browser]` 槽位替换，AGENTS.md 中的浏览器使用纪律不变。
- 开关：`CODEX_BROWSER=playwright|none`，用户已确认本期默认 `playwright`。
- 可写目录（用户 2026-10-18 决定）：`/workspace`、`/data/prompts`、`/data/workflows`。其中 `/data/prompts` 可写意味着任何能触发 codex 的发送者理论上可经 codex 修改热加载的系统提示；用户知悉并接受，仅以 AGENTS.md 软规则限制为"owner 私聊明确要求时才改"。



### 4.9 生图工具 v2：发挥 Qwen Image 2.1 Turbo 的能力（2026-10-18 用户需求）

已核实（宿主机 ComfyUI、RTX 4070 Ti SUPER 16 GiB、INT8 Turbo + W4A8 文本编码器）：
- Turbo 固定 8 步、CFG 1、euler/simple（调度写在权重里，改步数无效）。
- 原生 2K（2048×2048）输出；默认 1MP；尺寸取 32 的倍数；预设最大到 2752×1536（16:9）及对应竖版。
- 生成与编辑是同一模型：`TextEncodeQwenImage21(prompt, negative_prompt, resolution, images[], vae)` 接受多张参考图（看图编辑、多图参考），输出正/负 conditioning 与 LATENT。
- `EmptyQwenImageLayeredLatentImage(width, height, layers)` 支持透明（RGBA/分层）输出；`QwenImage21Cache` 为 KV 缓存提速；官方模板还带 Qwen 3.5 提示词增强器（需额外模型，本期不做）。
- 文本渲染是 Qwen Image 的强项（中英文海报、UI、招牌）。

**工具接口（统一供三处使用：前缀路径、pi 后端进程内工具、codex 的 image_gen MCP）**
```ts
generate_image({
  prompt: string,                 // 原文，不翻译
  negative_prompt?: string,
  aspect?: "1:1"|"16:9"|"9:16"|"4:3"|"3:4"|"3:2"|"2:3",   // 默认 1:1
  size?: "1mp"|"2mp"|"2k",        // 默认 1mp；2k 仅 1:1 为 2048² ，其他比例按预设表
  count?: 1|2|3|4,                // batch_size，默认 1
  seed?: number,                  // 默认随机
  reference_images?: string[],    // ≤3，仅允许本票据的 incoming 目录内文件（看图编辑/参考）
  transparent?: boolean           // 分层潜变量，输出 PNG 带 alpha
})
```
- 工作流不再用静态 JSON 文件，改为代码按参数**生成 API 图**：UNETLoader → [QwenImage21Cache] → TextEncodeQwenImage21 → EmptyLatentImage / EmptyQwenImageLayeredLatentImage → KSampler(8, 1.0, euler, simple) → VAEDecode → SaveImage。编辑图的接线（参考图经 LoadImage 送入 `images`，`resolution` 取目标尺寸的边长）须以宿主机 `comfyui_workflow_templates` 包内的官方 Qwen Image 2.1 编辑模板为准核对，不凭猜测。
- 尺寸预设表（32 的倍数）：1mp：1:1 1024², 16:9 1344×768, 9:16 768×1344, 4:3 1152×864, 3:4 864×1152, 3:2 1216×832, 2:3 832×1216；2mp：按 1.414 倍取整到 32；2k：1:1 2048², 16:9 2752×1536, 9:16 1536×2752, 3:2 2528×1696, 2:3 1696×2528, 4:3 2368×1792, 3:4 1792×2368。超时按像素数与 count 线性放大（基准 1MP×1 = 60 s，上限 `COMFY_TIMEOUT_SEC`）。
- 旧 `COMFY_WORKFLOW_FILE` 保留为"自定义工作流覆盖"：设置时仍走文件（只替换提示词与 seed），不设置时走生成器。`/data/workflows/` 内可放用户自定义图。

**参考图来源（QQ 看图编辑）**
- QQBridge 对**触发**的消息下载图片段（OneBot `image` 段的 `url`/`file`，≤3 张、每张 ≤10 MiB、魔数校验）到 `/data/incoming/<ticket>/`，`InboundMessage.images: string[]`；未触发的消息不下载（历史库仍只存 `[image]` 占位）。保留 7 天后清理。
- 前缀路径：`奶龙:` 消息自带图片 → 自动作为 `reference_images`（编辑模式）。
- 后端：pi 工具参数 `reference_images` 只接受本票据 incoming 目录内的路径；codex 的 image_gen MCP 以 `-c mcp_servers.image_gen.env.IMAGE_REFS="<逗号分隔路径>"` 注入可用参考图清单，工具参数只能从中选择。

**前缀路径的内联选项**（`奶龙:` 之后、提示词之前，可多个，顺序任意，未识别的词算提示词）
`16:9` `9:16` `4:3` `3:4` `3:2` `2:3` `1:1` / `横`(16:9) `竖`(9:16) `方`(1:1) / `2k` `2mp` / `x2` `x3` `x4` / `透明`。例：`奶龙: 横 2k 一只在雪地里的橘猫`。

**提示词指引（写入 AGENTS.md 与 agent.md）**
- 直接用用户语言描述；要在图中出现文字时，把文字放在引号里并说明位置与字体风格（Qwen 对中英文文字渲染准确）。
- 编辑时描述"改什么、保留什么"；多图参考时说明每张图的用途。
- 不要加 "masterpiece, 8k" 之类的 SD 式咒语。

**不做**：提示词增强器、ControlNet、LoRA 管理、超过 2K 的分辨率。

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
2. **规则分流 + 生图路径 + 后端抽象 + codex 适配**（§4.1–4.4）：`IMAGE_PREFIXES` 分流、两阶段生图任务、`AgentBackend` 接口与 `AGENT_BACKEND` 切换、codex 适配（固定 effort、`image_gen` MCP、图片收集、relay/direct 后处理）、按 scope FIFO。意图模型的 `route` 会话与系统提示退场（`system.md` 不再使用，保留文件但记录弃用）。测试：前缀匹配（半/全角、空提示）、生图崩溃恢复不重复、codex 适配经 fake codex、image_gen MCP 经 stdio、图片收集上限、后处理清洗。
3. **pi-durable 后端**（§4.5、4.6）
3b. **生图工具 v2**（§4.9）：参数化工作流生成器、尺寸预设、透明输出、参考图编辑（bridge 下载触发消息的图片）、前缀内联选项、三处接入（前缀路径 / pi 工具 / image_gen MCP）。测试：工作流生成器快照、预设表、内联选项解析、参考图路径限制、bridge 图片下载与清理；真实 ComfyUI 冒烟（1MP 文生图、16:9、透明、单图编辑）。
（原 3）：长期 durable 会话（owner/shared）与 compaction、进程内工具（web_search / fetch_page / qq_* / generate_image）、访问范围绑定、`agent.md` 热加载提示、调用上限与超时、`AGENT_BACKEND=pi` 切换与 overrides。测试：faux 模型工具调用链、访问范围隔离、上限守卫、429 退避、切换后端互不影响。
4. **观测系统**（§8）：事件表与埋点、指标、面板、可选告警。测试：埋点覆盖每个阶段、面板页面渲染、SSE、脱敏。

决策（2026-10-17 用户确认）：设计 v2 通过；`CODEX_BROWSER=playwright` 本期开启。

每组完成后由 Codex 做一轮独立评审。

## 9. 验收记录

### 第 1 组（2026-10-18，主会话验收通过）
- 独立复跑：typecheck、178 测试、build、镜像构建通过；`docker compose up -d --build` 部署，容器 healthy。
- 代码审读：访问范围只来自票据/环境变量，`all` 仅 owner 私聊，所有读取带访问子句；entrypoint 对路径、枚举、可写目录白名单校验并规范化。
- Codex 对抗评审 8 条：7 条修复（含 2 条阻断：codex 命令可读 `/data` 凭据与库 → `/etc/codex/requirements.toml` 的 `deny_read`；单线程跨会话泄露 → owner/shared 双线程），1 条接受（浏览器黑名单非安全边界，用户已允许命令联网）。
- 主会话发现并修复：规则文件可被 codex 改写 → 移到只读的 `$CODEX_HOME/AGENTS.md`；头部昵称/引用可伪造行 → 清洗；浏览器 `browser_run_code_unsafe` 可在 MCP 进程内读凭据 → `enabled_tools` 白名单；非交互 exec 下 MCP 调用需审批 → `default_tools_approval_mode = "approve"`（`auto` 实测无效）。
- 实测（新镜像）：沙箱内凭据/库/图片不可读，仅三个目录可写，命令可访问宿主机 ComfyUI，环境无密钥；`scripts/verify-browser-mcp.mjs` 12/12 通过；真实 codex 回合经生成配置成功调用 `qq_recent`。
- 已知残余风险见 DEPLOY.md：`/data/prompts` 可写仅靠软规则；浏览器黑名单不拦重定向；`auto` 审批模式在工具加 readOnly 注解后或可用但未验证。

### 第 2 组 v3（2026-10-18，主会话验收通过）
- 独立复跑：typecheck、262 测试、build、镜像构建通过；`docker compose up -d --build` 部署，容器 healthy，受管 config.toml 含 qq_context / image_gen / browser 三个 MCP。
- 代码审读：规则分流器（route_text 由 bridge 按真实段计算、最长前缀匹配）、后端选择（严格校验 overrides）、图片收集（跳过软链接、魔数、≤4）、任务阶段守卫与检查点、提交意图与文件名前缀对账。
- 两轮对抗评审（gpt-6-sol 11 条、gpt-6-astra 6 条）全部修复：codex 回合按票据输出文件幂等；生图 submit/collect 拆分 + 提交意图 + 文件名前缀对账（历史 → 队列 → 探测输出）；scope 队首到终态语义、达到上限先中止任务；恢复按 bridge seq 排序并分页；取消信号贯穿回复准备；排队不消耗重试次数；票据工作目录终态清理并对 codex 沙箱禁读。
- 实测：真实 codex 回合经 image_gen MCP 在宿主机 ComfyUI 生成 PNG（约 1.8 MB，写入 `call-1/`）。
- 接受的残余：ComfyUI 接受提交与返回之间崩溃仍可能重提一次（comfy-mcp 不支持客户端指定 id）；`failed` 派发条目不清理（第四组保留策略处理）。

### 生图工具 v2（2026-10-18，主会话验收通过）
- 独立复跑：typecheck、364 测试、build、镜像构建通过；部署后容器 healthy。
- 实现与设计 §4.9 的偏差（已确认）：透明输出不用 `EmptyQwenImageLayeredLatentImage`（属另一套 layered 模型，latent 维度不匹配），改按官方 background_removal 模板的解码链输出 RGBA，本机依赖齐全。
- 真实 ComfyUI 结果（实现方）：1MP 15 s、16:9 40 s、2K 388 s、透明 17 s（alpha 有效）、单图编辑 14 s。
- gpt-6-astra 评审 9 条全部修复：参考图下载 SSRF 防护（内部主机名拦截、全部 DNS 地址校验、固定 IP 连接、≤3 跳逐跳重验）；先接纳落盘再下载、按会话有界并发、重启续传；图片头尺寸/动图校验；上传副本用完覆盖为 1×1 透明 PNG；2K 预算按实测调整、超时后延期收取；目录 confinement 顺序；别名查找原型键；stdio 测试统一构建。
- 运维变更：`.env` 清空 `COMFY_WORKFLOW_FILE` 以启用参数化工作流，`COMFY_TIMEOUT_SEC=600`。
- 接受的残余：ComfyUI history/queue 仍残留上传文件名；七天清理只覆盖本机 incoming。

### 第 3 组 pi 后端 + agent 路径延迟收图（2026-10-18，主会话验收通过）
- 独立复跑：typecheck、431 测试、build、镜像构建通过（`test/qq/bridge.test.ts` 的一个发送用例偶发失败，已单独立项根治）；部署后容器 healthy，healthz 新增 `pi.threads`。
- 代码审读：pi 请求绑定（票据/访问范围写入会话文档、非 owner 键的访问范围必须等于当前会话域）、工具调用上限、DeepSeek 搜索/抓取的 SSRF 复用。
- gpt-6-astra 评审 1 阻断 + 4 major + 1 minor 全部修复：pi 会话改为按会话域隔离（阻断，设计稿 §4.5 已更新；原 shared 会话停用不复用）；优雅停机不再永久中止 pi 回合（协调两 harness 关闭顺序 + 持久化一次重提）；pi 生图持久化意图与 prompt_id 账本、重试复用未决任务；image_gen MCP 在提交前后即时落盘清单、lateImages 处理所有未完成项；延迟收图逐文件清单与原子写入；损坏清单隔离并保留正文。
- 默认后端仍为 codex；pi 后端通过 `AGENT_BACKEND=pi` 或 `AGENT_BACKEND_OVERRIDES` 切换，尚未在真实 QQ 流量上验证。
- 附带变更：vitest 在 Windows 上限制为 2 个 worker。

### 第 4 组观测系统（2026-10-18，主会话验收通过）
- 独立复跑：typecheck、466 测试、build、镜像构建、compose 校验通过；部署后容器 healthy，面板发布于宿主机 `127.0.0.1:8787`。
- 代码审读：CSP nonce、HTML 转义、图片路径段与 realpath 双重限制、SSE 连接上限、参数化查询。
- gpt-6-astra 评审 1 阻断 + 6 major + 3 minor 全部修复：面板默认无口令可被 codex 沙箱命令访问（阻断）→ 始终要求口令，首启自动生成 `/data/obs-token`（0600、对沙箱禁读、不进子进程环境）；`/context` 等字符串渲染先脱敏；image_gen MCP 子进程改写票据目录内有界事件文件由主进程脱敏入库；任意协议 URL userinfo 脱敏并拒绝 NapCat URL 内嵌凭据；观测初始化故障降级为 no-op 并在 healthz/首页标 degraded；每票据事件/字节预算、终态保留、游标分页；结构化错误分类触发鉴权告警；统一用量换算含缓存；codex 排队与执行计时分离；内置工具事件白名单记录。
- 实测：宿主机无口令访问 401、`/healthz` 200、带口令登录后各页 200；codex 沙箱内读取 `/data/obs-token` 被拒且访问面板得 401（见下方实测）。
- 运维：`.env` 开启 `ALERT_OWNER=true`（WS 断线、鉴权失败、连续失败 → owner 私聊，30 分钟限频）。
- 附带：实现方把 Comfy MCP 启动环境改为显式白名单。

### 8.4 面板二期（2026-10-18 用户反馈：要能切后端、要看进行中的会话、UI 要好看）
- **运行时切换后端**：面板"设置"页可修改全局 `AGENT_BACKEND` 与按会话域的覆盖表，保存到 `${DATA_DIR}/settings.json`（原子写），立即对后续消息生效，无需重启；`.env` 值仅作初始默认。所有写操作需口令会话 + CSRF 令牌，并记入观测事件（who=面板、时间、变更前后值）。同页可切 `CODEX_REPLY_MODE`、`CODEX_REASONING_EFFORT`、`ALERT_OWNER`，以及查看/编辑热加载的 `agent.md` 与全局 AGENTS.md（受管文件只读展示）。
- **进行中会话实时视图**：`/live` 页按会话域列出正在处理与排队中的票据，每张卡片实时显示：原文、路由、后端、当前阶段与已耗时、codex/pi 的事件流（工具调用、命令执行摘要、搜索查询、生图任务进度）、延迟收图状态；通过 SSE 推送事件，页面不轮询。完成后卡片收起并链接到票据时间线。观测事件表需要在阶段开始时就写入"进行中"事件，而不是只在结束时写。
- **codex / pi 会话查看**：`/codex` 与 `/pi` 页可查看各线程最近 N 轮的摘要（来自观测事件，不读 rollout 原文），并提供"重置该线程"（新建会话、旧会话归档）的受口令保护操作。
- **视觉重设计**（由 Opus 负责前端）：统一的设计系统（排版、间距、颜色令牌、深浅色自动），信息层级清晰（总览卡片 → 列表 → 详情时间线），中文界面，无外部 CDN，仍为服务端渲染 + 少量原生 JS + SSE；移动端可读。

### 面板二期（2026-10-18，主会话验收通过）
- Opus 实现：运行时设置（`settings.json` 热生效）、`/settings`（后端/覆盖/回复模式/强度/告警、agent.md 编辑、线程重置）、`/live` 实时视图（进程内事件总线 → SSE）、codex/pi 线程页、整体视觉重设计（设计令牌、深浅色、移动端）。主会话查看截图确认视觉与信息层级达标。
- 独立复跑：typecheck、498 测试、build、镜像构建通过；部署后容器 healthy，登录后各页 200，`/live/stream` 正常推送快照帧。
- gpt-6-astra 评审 10 条（无阻断）全部修复：SSE 快照分帧与背压、客户端 80 条后冻结、卡片页头刷新、卡片逐个脱敏、完成卡片定时淘汰、agent.md 服务端密文与 revision 守卫、时间列折行；热更新不改变在途消息（派发时固化设置快照）、管理审计事件独立保留策略、pi 重置原子化、线程归档限 200 条。
- 已知限制：pi-durable 1.3.0 无删除会话 API，退休的 pi 会话仅从映射移除、数据留在 `pi.sqlite`；`PI_ARCHIVE_RETENTION_DAYS` 暂只校验。

### 8.5 两个后端的上下文占用进度条（2026-10-18 用户需求）
- **数据**：每个线程一条记录，`src/agent/context-usage.ts` 维护并持久化到 `${DATA_DIR}/context-usage.json`（原子写），同时写观测事件 `context_usage`：
```ts
interface ContextUsage {
  backend: "codex" | "pi";
  key: string;                 // codex: owner | shared；pi: owner | <scope>
  usedTokens: number;          // 当前上下文占用：上一回合的输入 tokens（含缓存命中）
  cachedTokens?: number;       // 其中缓存命中部分
  windowTokens: number;        // 模型上下文窗口
  compaction?: { background: number; reserve: number };   // pi：后台压缩与阻塞压缩阈值（绝对 tokens）
  turns: number;               // 本线程累计回合
  lastCompactionAt?: number;   // pi：最近一次压缩时间（若可得）
  updatedAt: number;
  source: "turn" | "estimate"; // turn=来自真实回合用量；estimate=无回合时估算
}
```
- **采集**：codex 后端从 `turn.completed.usage`（`input_tokens` + `cached_input_tokens`）取值，窗口来自 `codex debug models` 的模型目录（启动时读取一次并缓存；失败回退 `CODEX_CONTEXT_WINDOW`，默认 400000）；pi 后端从回合 usage 取值，窗口与 compaction 阈值来自 pi-ai 模型定义与 harness 设置；线程重置后记录归零。
- **展示**（Opus）：总览页"上下文占用"区块与 `/codex`、`/pi` 页每线程一条进度条：已用/窗口与百分比，pi 条上标出后台压缩与阻塞压缩两条阈值线；颜色按占比分级（<60% 常态、60–85% 提醒、>85% 警示）；实时页卡片头部显示该线程的小型占用条；SSE 推送 `context_usage` 更新，不轮询。

### 8.5 上下文占用进度条（2026-10-18，主会话验收通过）
- 数据（astra）：`context-usage.json` 持久化；codex 取 `turn.completed.usage`，窗口来自 `codex debug models` 的 `models[].context_window`（gpt-6.1-sol = 500,000）；pi 取回合用量，deepseek-flash 窗口 1,000,000，后台压缩阈值 950,848、阻塞阈值 983,616（按 pi-durable 实际公式）；重置归零；`context_usage` 事件与 `/healthz.context_usage`。
- 展示（Opus）：总览"上下文占用"区块、`/codex`、`/pi` 每线程进度条（三档颜色、pi 两条阈值线、估算虚线、过期灰显）、实时卡片迷你条；SSE 原地更新；无内联样式，CSP 不变。
- 独立复跑：typecheck、528 测试、build、镜像构建通过；部署后总览与 `/codex` 页出现进度条，`/healthz` 返回 `context_usage`。
- 说明：重启后线程占用显示为估算 0，待该线程下一回合后更新为真实值。

### 8.6 codex 系统提示可编辑（2026-10-18 用户需求）
- 全局 `$CODEX_HOME/AGENTS.md` 拆为两段：受管段（安全规则、可写目录、工具纪律，程序生成、不可编辑）+ 自定义段（`${DATA_DIR}/prompts/codex.md`，面板可编辑）。保存后立即重写 AGENTS.md，codex 每次调用重新读取，下一条消息生效；容器重启按同样方式再生成。
- 面板设置页增加"codex 系统提示"编辑框（与 agent.md 并列，同样的 revision 防覆盖、密文拒绝、64 KB 上限），受管段只读折叠展示。

### 8.6 codex 系统提示可编辑（2026-10-18，主会话验收通过）
- 后端（astra）：`CodexPromptStore`，`$CODEX_HOME/AGENTS.md` = 受管段（标记 v5、安全规则与有效目录、image_gen 附件规则）+ 自定义段（`/data/prompts/codex.md`，默认含回复规则、历史工具纪律、联网与浏览器、生图提示词指引）；保存即再生成，下一次 codex 调用生效。
- 前端（Opus）：设置页 codex.md 编辑卡（revision 防覆盖、密文拒绝、64 KB）、受管规则只读折叠、`/codex/agents-md` 只读页；变更记录区分 codex.md / agent.md；顺带修正总览"聊天记录整理"时间显示。
- 独立复跑：typecheck、548 测试、build、镜像构建通过；部署后 codex.md 已生成、AGENTS.md 含两段、设置页与只读页 200。
- 补充（2026-10-18）：启动回填——codex 从 rollout 的 `token_count` 事件取 `last_token_usage`，pi 从 harness 历史恢复；部署后 owner 线程 49,975 / 500,000（4 回合）、shared 83,413 / 500,000（8 回合）立即可见。554 测试通过。

### 8.7 面板表单在浏览器中被判为跨站（2026-10-18，缺陷修复，主会话验收通过）
- 现象：本机浏览器打开面板后，设置 / agent.md / codex.md / 重置线程等表单提交一律 403「跨站请求被拒绝」；curl 正常，单测未覆盖。
- 根因：面板响应带 `Referrer-Policy: no-referrer`，按 Fetch 规范浏览器在该策略下把非 GET 请求的 `Origin` 序列化为字面 `null`，同源检查随即拒绝。容器内无头 Chromium 复现：`Origin: null`、`Sec-Fetch-Site: same-origin`、403。
- 修复（astra，`ca62564`）：响应头改为 `Referrer-Policy: same-origin`；同源检查仅在 `Sec-Fetch-Site: same-origin` 时接受 `Origin: null`，其余不变，CSRF 令牌校验保留。新增 4 个回归测试。
- 独立复跑：typecheck、560 测试通过；部署后浏览器复现脚本返回 303 并跳回 `?ok=codexPrompt`，响应头为 `same-origin`。
- 排查事故：排查中经带 TTY 的 `docker compose exec` 读写提示文件，Windows 终端把 UTF-8 中文转码，codex.md / agent.md 短暂损坏；两文件当时仍为种子默认值，已按源码模板原样恢复（SHA-256 一致）。规则：容器内文件进出一律 `docker compose exec -T` 并以管道传递。

### 8.8 上下文占用条显示 645%（2026-10-18，缺陷修复，主会话验收通过）
- 现象：总览页 codex 共享线程显示 3,226,173 / 500,000 tokens（645%），owner 线程 110%。
- 根因：`codex exec --json` 的 `turn.completed.usage` 是线程累计计费量（等于 rollout `token_count.info.total_token_usage`），实时路径把它当成本次请求上下文写入占用条；启动回填用的 `last_token_usage` 是对的，于是重启后短暂正确、下一回合又被覆盖。同一时刻真实值为 115,947。
- 修复（astra，`8d26af1`）：回合结束、codex 进程退出后，从该线程 rollout 尾部读取最新 `token_count.last_token_usage` 写入占用条；读不到或比本轮开始更旧时保留旧值、只计一次回合并告警一次；`readRolloutContextUsage` 不再接受 `turn.completed.usage`；观测事件 `model_usage` 字段改名 `total_*`，实时页标注"线程累计"。
- 主会话验收：在 O1 之上变基并解决 `codex-context-usage.ts` 冲突（只取 `token_count`）；typecheck 通过，全量 718 项通过（一次 Windows worker 崩溃为既有抖动，新增用例单独复跑三次稳定）。部署时清掉 `data/context-usage.json` 中标记为实测的错误 codex 记录，启动回填两条成功：shared 115,947 / 500,000（23%），owner 53,864（11%）。副作用：shared 回合计数由 rollout 尾部 2 MiB 可见范围重算为 3（真实 18 回合见 `/api/agents` 会话索引），下一回合起继续累加。
