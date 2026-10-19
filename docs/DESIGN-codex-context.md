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
7. **符号链接竞态（minor，接受）**：codex 对 `/data/media` 既不可写也不可读（第 1 条）。§10.2 已给 pi 增加路径检查及写入边界；`realpath` 检查与实际 I/O 之间仍有路径被并发替换的窗口，按 §10.2 的决定保留这一 TOCTOU 限制。
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
> 已被 §10.1 取代：codex 改为按会话域分线程（owner / 每群 / 每个其他私聊），工作区按会话域隔离。
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
- **回复后处理（两后端统一）**：原文照发，只做发送保护（UTF-16 ≤4000 截断且不拆代理对、空文本占位）。两个后端由系统提示要求纯文本，后处理不调用模型；2026-10-19 起不再做 Markdown/`@` 转换。

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
  - 执行环境：`PiExecutionEnv`，每个会话一个工作目录 `${DATA_DIR}/pi-work/<会话键>/`（`:` 换成 `_`）；每次工具调用从已提交的 `PiRequestDoc` 绑定 access 与 ticket，恢复时同样重建，不依赖进程内的“当前请求”变量。
  - `bash` 必须经 Linux bwrap：隔离 PID 并挂载新 `/proc`，根目录只读，仅当前工作区和临时 `/tmp` 可写，网络保留。与 codex 共用受管 `deny_read`，目录用只读空 tmpfs、文件用 `/dev/null` 遮蔽；其他 pi 工作区、pi 状态库也不可读。bwrap 缺失或配置读取、解析、展开失败时返回工具错误，不裸跑。子进程仅继承 `SHELL_ENV` 白名单及工具显式变量，单次最多 60 秒。
  - 文件方法经 `realpath` 检查：禁读目标不可读；媒体文件须通过当前 access 的 `mediaPathAllowed`，另允许本票据的 `incoming/<ticket>/` 和 `images/<ticket>/`。写入仅限本会话工作区与本票据 `images/<ticket>/`；宿主 `/proc`、`/sys`、`/dev` 不向文件工具开放。
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

### 8.9 远程插件修剪（2026-10-19，主会话验收）

- 现象：上下文分析页 developer 区出现 figma/notion/gmail 等技能说明（`<skills_instructions>` 约 21.8 KB / 4,800 token），来源是 codex-cli 0.163 的 `remote_plugin` 功能自动从 OpenAI 精选远程市场下载到 `$CODEX_HOME/plugins/cache/openai-curated-remote/` 的 15 个插件，不是宿主机配置泄入（compose 只挂 data/ 与 workspace/，容器内 `/home/node/.codex` 为空）。
- 实测（临时 CODEX_HOME，6 次真实 exec）：`features.remote_plugin=false` 与 `[plugins."x@openai-curated-remote"] enabled=false` 都不会让已缓存插件退出提示词，删缓存目录才有效；清空后默认配置短时间内未重新拉取；关远程目录另少约 900 字插件提示。`codex debug prompt-input` 不显示远程插件，验证只能看真实 rollout。
- 修复（d54caa5、8b5da19）：entrypoint 受管配置新增 `[features] remote_plugin = false`（`CODEX_REMOTE_PLUGINS=off|on`，默认 off），启动时按 `CODEX_PLUGIN_PRUNE`（默认 `figma,gmail`，`all` 清空，显式空串不清，名单只允许 `[A-Za-z0-9._-]`，拒绝 `.`/`..`）删除缓存目录并清理安装暂存目录；entrypoint 测试 22 项；用户决定多代理功能暂不关闭。
- 验收：沙箱外复跑 77 文件 / 1098 项通过；部署后 `config.toml` 第 50–51 行为 `[features] remote_plugin = false`，缓存目录剩 13 个（figma、gmail 已删，暂存目录消失），容器 healthy。其余 13 个缓存插件（其中 6 个带 skills）仍会进入提示词，约 3,800 token/请求；全清设 `CODEX_PLUGIN_PRUNE=all`。下一次真实回合的上下文分析页应不再出现 figma 技能，待观察。

### 8.10 事故：误判线程丢失与回合收尾卡死（2026-10-19，主会话验收）

- 现象：07:07:47 恢复 owner 线程时 codex 返回 JSON-RPC -32603（其启动时同步插件市场克隆目录 `$CODEX_HOME/.tmp/plugins*` 与 `rg` 扫描的竞态），外层措辞 `thread/resume failed`；`MISSING_SESSION_PATTERNS` 里过宽的 `/thread\/resume failed/i` 命中 → 映射被删、新建线程，原线程既未归档也未保留。同一回合模型用自带 imagegen 出图并成功登记 `qq_send_image`，07:11:03 `task_complete`，但模型开的交互式 shell/python 子进程持有 stdout 管道，运行器等 `close` 直到 600 s 超时，按失败回复、附件随票据清理丢失。
- 数据修复：主会话在宿主机把 `data/codex-threads.json` 的 owner 改回 `01a14a4a…`，并在 `codex-threads-archive.jsonl` 归档误建线程 `01a152fc…`（reason `false-missing-detection`）。重启后面板显示 owner 会话 `01a14a4a…` active、8 回合。
- 代码修复（5f9a74b、9e53d8b、52f3503、39d763c）：丢失判定只认 codex 0.163 真实措辞（`no rollout found for thread id` / `conversation id`、`not found`），`-32603` 一律按其他失败处理并保留映射；真丢失时先归档旧映射（reason `missing` + stderr 尾部）再新建；收尾以 `exit` 为准，`close` 最多等 `CODEX_CLOSE_GRACE_MS`（默认 5000）后清理进程树并释放本端管道，`turn.completed` 后 `CODEX_EXIT_GRACE_MS`（默认 15000）仍未 `exit` 且输出文件非空则按成功收尾；Linux 下 codex 以独立进程组启动，整组清理可覆盖孤儿孙进程（Windows 无法验证，对应用例按平台跳过）。
- 验收：沙箱外复跑 80 文件 / 1176 项通过 + 1 跳过；镜像 `9e9b6a8b…`（干净 worktree，main 39d763c）以 `--no-deps` 只切换 cs-agent，容器 healthy、无新告警；面板与附件 stdio 冒烟零错误。待用户在 QQ 私聊验证"把 skirk.png 发给我"（文件已在 `/workspace/owner/skirk.png`）。
- 调查：干净未登录的临时 CODEX_HOME 下，默认与 `features.plugins=false` 都不触发 `.tmp/plugins` 同步，无法据此证明关闭插件能消除生产竞态；记录在 `docs/research/codex-runnerfix-2026-10-19.md`，暂不改插件配置，靠判定收紧兜底。

### 8.11 根因修正：codex 插件市场启动同步（2026-10-19）

- §8.9 的修剪方案是错的：codex 0.163 启动时 `startup_sync` 会 git clone `github.com/openai/plugins` 到 `$CODEX_HOME/.tmp/plugins`，并**重装缺失的精选插件**到 `plugins/.remote-plugin-install-staging/remote-plugin-bundle-*`；`features.remote_plugin=false` 与 `[plugins."x@openai-curated-remote"] enabled=false` 都拦不住（临时 CODEX_HOME 真实 exec 三组实验：现状配置 exit 1 并复现 `ripgrep unreadable glob scan failed … remote-plugin-bundle-*/skills/figma-use`；按名禁用后 figma/gmail 被装回且 54 个技能全部进入提示词）。被修剪的插件每轮重装，安装临时目录与技能扫描的 `rg` 竞态 → `thread/start -32603`，即 §8.10 两次事故的根因。
- 修正：受管配置改写 `[features] plugins = false`（同时保留 `remote_plugin = false`），实测无同步、无安装，提示词只剩 `.system` 内置技能（imagegen、openai-docs、skill-creator、skill-installer）。`CODEX_PLUGIN_PRUNE` 保留但已非必要（`CODEX_REMOTE_PLUGINS=on` 时修剪会再次触发重装竞态，文档已注明）。main 87bc811，镜像 `eb0f899d…` 以 `--no-deps` 部署，容器 healthy，`config.toml` 第 37–39 行为 `[features] plugins = false / remote_plugin = false`。
- `codex debug prompt-input` 不触发该同步，只能用真实 exec 验证。

### 8.12 受管规则下发路径

2026-10-19 使用真实 codex 0.163、临时 `CODEX_HOME` 对照 rollout，已确认以下行为；此结论修正 §10.8 中“受管规则经 developer_instructions 每轮注入”的描述，也取代早期将全部规则放在全局 AGENTS.md 的方案。

| 操作 | rollout 结果 |
|---|---|
| 新建线程，`-c developer_instructions` 含 `MARK_DEV_V1`，cwd 的 `AGENTS.md` 含 `MARK_AGENTS_V1` | developer 消息含 `MARK_DEV_V1`；user 消息 `# AGENTS.md instructions` 含 `MARK_AGENTS_V1` |
| resume，参数和文件都不变 | 无新注入 |
| resume，只把 `developer_instructions` 改为 `MARK_DEV_V2` | 无新注入，线程内仍只有旧 V1 开发者指令 |
| resume，只把 cwd 的 `AGENTS.md` 改为 `MARK_AGENTS_V2` | 新增 user 消息含 V2，并声明新的 AGENTS.md 指令替换此前指令 |

因此，逐轮传入 `developer_instructions` 无法更新已有线程的受管规则。此次调整后的路径为：

- `$CODEX_HOME/AGENTS.md` 承载用户可编辑的全局行为指引：编辑源为 `${DATA_DIR}/prompts/codex.md`，`CodexPromptStore` 拼接通用保密与会话隔离说明后生成；启动、面板保存及每轮 `preparePrompt` 都会再生成。不要直接编辑生成文件。
- `${WORKSPACE_DIR}/<key>/AGENTS.md`（默认 `/workspace/<key>/AGENTS.md`，键中的冒号换成下划线）承载受管规则。`turn()` 在启动新线程或 resume 前，按本轮实际权限渲染安全规则、可写目录、聊天图片召回与图片/文件发送说明，再追加可选的 `## 运维工作区指引`。父目录 `AGENTS.override.md` / `AGENTS.md` 仍是运维维护的输入，服务不改写它们，也不再播种占位文件。
- 会话域文件以 `<!-- cs-agent-managed-workspace-agents v1 -->` 开头，下一行为“由 cs-agent 每轮生成，改动会被覆盖。”。每轮比较完整内容，文件缺失或内容不同才通过 `writeAtomic`（同目录临时文件 + rename）原子写入；相同则不写，保留 mtime。模型对该文件的修改在下一轮覆盖恢复，不再识别或保留旧占位/V1/V2 模板。
- 全局与会话域 AGENTS.md 都以 **user 角色**进入 codex 上下文，内容变化时由 codex 在续轮重新注入。不再传入 `-c developer_instructions=`，保留 `project_doc_max_bytes=131072`；无需重置已有线程，受管规则更新从它的下一轮生效。

回归测试沿用 fake-codex，在子进程启动时记录 cwd 的 AGENTS.md，覆盖首轮生成、内容相同时 mtime 不变、规则/权限/运维指引变化、模型改写后的恢复，以及新建与 resume 均不传 `developer_instructions`。提示词不是访问控制；会话权限仍由现有命名沙箱配置执行。

**主会话验收（2026-10-19）**：分支 `fix/managed-rules-via-workspace-agents` 3 条提交 ff 到 main（b750b54…241e938），沙箱外复跑 82 文件 / 1214 项通过；镜像 `275b0fb6…` 部署，容器 healthy。真实回合（票据 31ae0ded，09:16:46 "生成一张极恶骑的图片给我"）：09:17:07 owner 线程 rollout 出现新的 `# AGENTS.md instructions` user 消息（2,357 字，含"发送图片与文件"与内置生图说明）；09:18:15 模型调用 `qq_send_image`，路径为当前线程 `generated_images` 下的 PNG，登记成功；`reply_sent.images = 1`，用户确认图片到达。owner 线程自 10-18 以来首次收到规则更新。`/workspace/owner/AGENTS.md` 首行为受管标记。读写加固（符号链接、临时文件名、父目录复核）由 `fix/harden-managed-agents-write` 跟进。
**读写加固（2026-10-19）**：上述 `writeAtomic` 已由 `writeManagedFile` 替代，会话域文件与 `writeGlobalAgentsMd` 共用此入口。每轮先 `lstat`；缺失则创建，仅对不超过 256 KiB 的普通文件，通过 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开、`fstat` 复核类型、大小及文件身份后进行有界读取比较，内容相同时保留 mtime。符号链接、目录、FIFO、设备等非普通文件及超大文件不读取，删除原路径后重建，并记录 `managed file replaced`（file、kind）。临时文件采用同目录随机 UUID 名，以 `wx` 独占创建，写入、fsync、关闭后 rename；失败清理临时路径，避免可预测临时链接写穿到工作区外。rename 前重新确认父目录为真实目录，写后再以 lstat 校验普通文件及 UTF-8 字节长度，校验失败即让本轮失败。Windows 缺少 NOFOLLOW/NONBLOCK 时保留文件身份检查，无法创建文件符号链接（EPERM）的测试明确跳过；Linux 的 FIFO、设备与并发竞态保护不能以 Windows 测试替代。此措施不改变规则的加载时机：回合内篡改不影响已启动的 codex exec，下一轮启动前检查并恢复；即使前一轮留下后台进程，也不额外依赖回合结束时的进程组清理。父目录复核是写入前的检查，不宣称抵御具备替换父目录权限的持续竞态。

### 8.13 codex 不再拥有 /data/workflows 可写根（2026-10-19，主会话验收）

- 用户指出受管 AGENTS.md 里"`/data/workflows：ComfyUI 生图工作流 JSON…`"一行已无意义（codex 用自带 imagegen，不做本地生图）。用户决定 ComfyUI 本地生图整体保留（`奶龙:` 规则路由与 pi 的 `generate_image` 仍用），只收窄 codex。
- 改动（7541963、47ac621）：`codexWorkspacePolicy` owner 的额外可写根只剩 `${DATA_DIR}/prompts`；`describeRoot` 删除 workflows 描述；`scripts/entrypoint.sh` 与 `src/config.ts` 的 `CODEX_WRITABLE_ROOTS` 默认值改为 `/workspace,/data/prompts`；workflows 目录播种与 `COMFY_WORKFLOW_FILE` 不变；`.env.example`、`docs/DEPLOY.md`、`docs/ARCHITECTURE.md` 同步。
- 验收：沙箱外复跑 83 文件 / 1237 项通过；镜像 `2593b102…`（干净 worktree，main 47ac621）部署，容器 healthy、bridge 已连，受管 `config.toml` 不再出现 `/data/workflows`。owner 线程下一回合将收到更新后的 AGENTS.md 注入（可写目录列表只剩工作区与 prompts）。子代理提交署名被其运行时改为 Sonnet 5.5，落 main 时已改回项目规范的 Fable 5.1。

### 8.14 内置生图输出清理

Codex 内置 imagegen 将原图写入 `$CODEX_HOME/generated_images/<thread_id>/exec-*.png`。`qq_send_image` 登记时已把副本复制到票据图片目录，原图主要供模型后续回看或“把刚才那张再发一次”；清理原图不会删除已登记的票据副本，也不改变生图与发送逻辑。

`purgeGeneratedImages` 沿用官方 trace 的清理口径：`CODEX_GENERATED_IMAGES_RETENTION_DAYS` 默认 7 天，`CODEX_GENERATED_IMAGES_MAX_MB` 默认 1024 MiB（1 GiB）。先删 mtime 早于保留期截止时间的普通文件，再将剩余普通文件跨线程按 mtime 从旧到新清理到总量不超限；mtime 相同时按路径排序。两个限制各以 0 禁用，都为 0 时连空目录也保留。

根目录不存在、不是目录或本身为链接时返回零；遍历使用 lstat 跳过链接，并以 realpath 二次限定根内范围，容量阶段删除前再次核验。文件清理后由内向外以非递归 rmdir 移除空子目录，保留非空目录、链接与根目录；并发删除导致的 ENOENT 或目录变为非空不视为失败。返回 removed（文件数）、bytes（实际删除字节数）、dirs（空目录数）。参数校验与 trace 一致，非法值抛错。

每日任务在 `purgeCodexTrace` 之后调用；removed > 0 时记录成功日志与三个计数，失败只告警。保持现有调度：启动不立即清理，正常情况下在 `Metrics.start()` 后约 60 秒首次执行，后续间隔至少 24 小时；观测库降级时不执行。

**主会话验收（2026-10-19）**：分支 `feat/generated-images-purge` 2 条提交 ff 到 main（472079a、dee6231）+ 日志小修 f546785；沙箱外复跑 85 文件 / 1331 项通过；镜像 `c1dce9ba…`（干净 worktree，main f546785）部署，容器 healthy、bridge 已连。容器内用构建产物对临时目录实测：10 天前的 3 MiB 文件按保留期删除且空线程目录被清（`removed 1 / dirs 1`），总量上限 3 MiB 时按 mtime 从旧到新再删 1 个文件，新文件保留；真实目录 2 个线程 4 张图均在 7 天内，未被清理。首次清理在启动约 60 秒后随每日维护任务运行，之后每 24 小时一次。另记：cs-agent-b7 发现 owner 线程请求体已达 16.87 MB（历史里内联的 4 张生图），WebSocket 传输在约 16 MiB 时被服务端关闭、每轮降级 HTTPS 前白耗约 1.5–2 分钟；本清理不影响已内联进历史的图片，缓解需靠压缩/重置线程或强制 HTTPS 传输（待实测开关后在受管配置处理）。

## 7. 实施拆分（各自测试、单独重建部署）

1. **消息库 + 衰老任务 + `qq_context` MCP + AGENTS.md + codex web_search**。测试：假 OneBot 入库/撤回/清理、摘要任务（faux 模型）、FTS 中文检索、MCP 上限与访问过滤、`QQ_ACCESS` 注入。
2. **规则分流 + 生图路径 + 后端抽象 + codex 适配**（§4.1–4.4）：`IMAGE_PREFIXES` 分流、两阶段生图任务、`AgentBackend` 接口与 `AGENT_BACKEND` 切换、codex 适配（固定 effort、`image_gen` MCP、图片收集、仅代码清洗的后处理）、按 scope FIFO。意图模型的 `route` 会话与系统提示退场（`system.md` 不再使用，保留文件但记录弃用）。测试：前缀匹配（半/全角、空提示）、生图崩溃恢复不重复、codex 适配经 fake codex、image_gen MCP 经 stdio、图片收集上限、后处理清洗。
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
- **运行时切换后端**：面板"设置"页可修改全局 `AGENT_BACKEND` 与按会话域的覆盖表，保存到 `${DATA_DIR}/settings.json`（原子写），立即对后续消息生效，无需重启；`.env` 值仅作初始默认。所有写操作需口令会话 + CSRF 令牌，并记入观测事件（who=面板、时间、变更前后值）。同页可切 `CODEX_REASONING_EFFORT`、`ALERT_OWNER`，以及查看/编辑热加载的 `agent.md` 与全局 AGENTS.md（受管文件只读展示）。
- **进行中会话实时视图**：`/live` 页按会话域列出正在处理与排队中的票据，每张卡片实时显示：原文、路由、后端、当前阶段与已耗时、codex/pi 的事件流（工具调用、命令执行摘要、搜索查询、生图任务进度）、延迟收图状态；通过 SSE 推送事件，页面不轮询。完成后卡片收起并链接到票据时间线。观测事件表需要在阶段开始时就写入"进行中"事件，而不是只在结束时写。
- **codex / pi 会话查看**：`/codex` 与 `/pi` 页可查看各线程最近 N 轮的摘要（来自观测事件，不读 rollout 原文），并提供"重置该线程"（新建会话、旧会话归档）的受口令保护操作。
- **视觉重设计**（由 Opus 负责前端）：统一的设计系统（排版、间距、颜色令牌、深浅色自动），信息层级清晰（总览卡片 → 列表 → 详情时间线），中文界面，无外部 CDN，仍为服务端渲染 + 少量原生 JS + SSE；移动端可读。

### 面板二期（2026-10-18，主会话验收通过）
> 2026-10-19 更新：回复模式已移除，随后代码清洗也移除，两个后端原文照发、只保留 4000 字发送保护；下文保留原验收记录。

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

## 10. IM 网关分层（v4，2026-10-18 用户决定）

> 目标：QQ 协议只留在通道适配层；网关层负责会话、排队、可靠投递与能力签发；agent 后端只面对回合上下文。参照 Bot Framework（Adapter / TurnContext / ConversationReference）与 NoneBot2 / Koishi / Satori 的通用做法；保留现有已验证的部分（推送式接入、票据状态机、按 scope FIFO、工具按范围授权）。

```
channels/qq（OneBot WS/HTTP、normalize、send、fetchMedia、fetchHistory）
   ⇅ Channel 接口
gateway（ConversationRef=scope、触发与分流、按会话队列、Inbox/Outbox 幂等、TurnContext 能力令牌）
   ⇅ TurnContext
agent（codex | pi，只依赖 TurnContext）   ←  tools（MCP / 进程内）只经 TurnContext 访问记忆、媒体、发送
```

原则：
- `ConversationRef = { channel, scope }` 是队列、记忆分区、授权范围、agent 会话的唯一键。
- 模型能触及的一切能力（记忆检索、媒体召回、看图、生图、发送）都由网关按回合签发、按会话约束；凭据与协议细节不进入模型的执行环境。
- 默认每回合只有一条最终回复，由网关经 Outbox 发出；agent 无收件人参数。

### 10.1 第 1 步：codex 按会话域分线程（安全修复，取代 §3.1 的 owner/shared 两分）
- 问题：非 owner 的所有群与私聊共用 codex `shared` 线程，A 群的对话内容留在线程上下文里，B 群下一轮可见；`QQ_ACCESS` 只约束工具，约束不了线程里已有的内容。此外所有会话共用可写的 `/workspace`（以及 `prompts`、`workflows`），文件也能跨会话传递，群成员还可借提示注入改写全局提示文件。
- 线程键：与 pi 一致，`owner` | `group:<id>` | `private:<qq>`（`threadKeyForSource` 对非 owner 返回 scope）。`codex-threads.json` 按键存记录；`shared` 记录不再使用：启动时归档到 `codex-threads-archive.jsonl`（reason=`scope-split`）后删除，不迁移给任何 scope（参照 pi 停用 shared 的做法）。
- 并发：每个线程键一条互斥队列（同键串行、不同键并行），总量仍受 `AGENT_CONCURRENCY` 约束；线程文件的读改写仍串行化。安全阀（rollout 大小 / 线程年龄）、上下文占用回填、面板重置线程都按动态键工作：面板列出 `codex-threads.json` 中现有的全部键；重置接口接受 `owner` 与合法 scope。
- 工作区按会话域隔离：每轮 `-C ${WORKSPACE_DIR}/<键，':'→'_'>`（首次使用时创建）；可写目录按回合注入：
  - 非 owner：仅本会话工作区（加 codex 运行必需的目录）；
  - owner：本会话工作区 + `${DATA_DIR}/prompts` + `${DATA_DIR}/workflows`（保留 owner 经 codex 编辑提示与工作流的能力）。
  - 受管规则与可编辑的行为指引在新工作区下仍须完整生效（实现方查明 codex 0.163 的 AGENTS.md 加载规则后选定方案，例如放入 `$CODEX_HOME/AGENTS.md` 或每个工作区生成一份；不得出现某个会话域缺规则的情况），`renderManagedAgentsMd` 按实际生效的可写目录渲染。
  - 其他会话的工作区对本回合不可读（deny_read 或等效机制；若 codex 无法按回合注入 deny_read，则说明可行方案并上报，不得静默跳过）。
- 配置兼容性补充（实现时收紧）：上述可写范围适用于 `workspace-write`；显式 `read-only` 仍禁止所有写入。`danger-full-access` 无法满足会话隔离，业务回合直接拒绝执行。入口脚本的 `CODEX_WRITABLE_ROOTS` / `CODEX_EFFECTIVE_WRITABLE_ROOTS` 不再扩大业务回合权限；每轮使用固定的会话权限配置覆盖。`WORKSPACE_DIR` 不得为系统根目录、包含 `DATA_DIR`，或经符号链接指向其它位置；遇到不安全布局则拒绝执行。
- 观测：上下文占用条与会话页的标签按键显示（`owner 线程` / `群 <id>` / `私聊 <qq>`），旧 `shared` 记录只在归档中可见。
- 验收：A 群与 B 群各发一轮后线程 id 不同；B 群回合的线程 rollout 中不含 A 群内容；非 owner 回合写 `/data/prompts` 失败、读其他会话工作区失败；owner 回合可写 prompts；重启后各键线程沿用；面板能列出并重置任一键。

### 10.2 第 2 步：pi 内置工具加沙箱（撤销 §4.5 的"已接受的风险"）
- `bash`：经 bwrap 执行，要求 `--unshare-pid`（新 `/proc`，看不到主进程 `/proc/1/environ`）、`--die-with-parent`；根文件系统只读绑定，仅本会话工作区 `${DATA_DIR}/pi-work/<键>` 与 `/tmp`（tmpfs）可写；禁读列表与 codex 同源（`/etc/codex/requirements.toml` 的 `deny_read`，展开其中的通配），另外禁读 `${DATA_DIR}/pi-work` 下其他会话的目录与 pi-durable 自身的状态库。网络保持可用（与 codex 一致）。bwrap 不可用或禁读列表读取失败 → `bash` 工具返回错误，**不得**退回无沙箱执行。环境变量白名单与 60 秒上限保留。
- `read` / `write` / `edit`：在 `PiExecutionEnv` 的文件方法上做路径检查（`realpath` 后判断，软链接 TOCTOU 沿用 §2.5.8 已接受的结论）：
  - 读：命中禁读列表 → 拒绝；例外：`/data/media/...` 中 `mediaPathAllowed(本回合 scope, path)` 为真的文件，以及本票据的 `incoming/<ticket>/`、`images/<ticket>/`；
  - 写：仅本会话工作区与本票据的 `images/<ticket>/`。
- 验收：pi 回合中 `bash` 读 qq-messages.sqlite / obs-token / 其他会话工作区 / `/proc/1/environ` 均失败；`read` 本会话召回的图成功、他群的图失败；bwrap 缺失时 bash 报错而非裸跑。
- 实现细节：先用只读空 tmpfs 遮蔽整个 `pi-work`，只挂回本会话，避免命令运行期间新建会话目录泄漏。文件接口覆盖二进制/文本流、元数据、目录列表、重命名两端及临时文件；临时文件（包括 bash 输出溢出日志）落在本工作区。递归监听不提供。
- 配置边界：解析入口脚本生成的 `[permissions.filesystem] deny_read` 字符串数组，支持注释、单/双引号、尾逗号和 `*`、`?`、`**`；不支持的 TOML/glob 语法及损坏 UTF-8 保守报错，不忽略规则。每次操作重新读取配置；读取路径可由 `CODEX_REQUIREMENTS_FILE` 覆盖。
- 挂载边界：bash 在每次启动时展开匹配路径并遮蔽，运行期间不会动态重挂载新增或替换的受管路径；这是按 Codex 同类挂载方式实现的限制。其他 pi 会话目录由整个父目录的遮蔽处理，不受新增会话影响。
- Linux 验证：镜像显式安装 `bubblewrap`，`USER node` 阶段检查 `/usr/bin/bwrap --version`；真实命名空间测试须在使用 `docker/seccomp-codex.json` 的容器中以非 root 用户运行 `npx vitest run test/agent/pi-sandbox-linux.test.ts`。该测试仅在非 Linux 跳过，在 Linux 上缺少 bwrap 或命名空间受限都会失败；覆盖文件遮蔽、只读挂载、PID 隔离、环境白名单、网络及超时/取消。Windows 只运行路径、参数、失败关闭及后端持久化回归，不能据此宣称已通过 Linux 容器实测。

### 10.3 第 3 步：抽出 Channel 接口（纯重构，行为不变）

> 2026-10-19 细化（用户批准实施）。原稿的第一项"通用代码迁出 `src/qq/`"已由包结构整理 P1 完成（`src/media/`）。原稿的 `src/channels/qq/` 改为**保留 `src/qq/` 作为 QQ 通道实现**：包名不变，避免刚完成的 P0–P2 再搬一次，归属在本节和依赖测试里写明。

**新包 `src/channel/`**（层位：shared → config → media → **channel** → qq → context → agent → obs → mcp → main），只放与具体 IM 无关的契约与纯函数，不得依赖 `qq/`：

| 文件 | 内容 |
|---|---|
| `channel/types.ts` | 从 `qq/types.ts` 迁入且**字段名、取值不变**的通用类型：`ChatType`、`MessageSegment`、`IncomingAttachment`、`InboundMessage`、`TicketStatus`、`ReplyTicketRecord`、`ReplyResult`；`BridgeStatus` 改名 `ChannelStatus`（字段不变）；`QQBridgeEvents` 改名 `ChannelEvents`。新增 `ConversationRef = { channel: string; scope: string }`（本步只有 `channel: "qq"`，`scope` 仍是 `group:<id>` / `private:<qq>`，持久化数据不变）。新增 `Channel` 接口与 `RemoteMessage`（见下）。 |
| `channel/ticket.ts` | 原 `qq/ticket.ts` 的 `inboundFromTicket`、`legacyRouteText`（只依赖类型）。 |

**`Channel` 接口**（= 现 `QQBridge` 的公开面 + 两个取代直连 OneBot 的方法）：

```ts
interface Channel {
  readonly name: string;                       // "qq"
  start(): Promise<void>; stop(): Promise<void>; status(): ChannelStatus;
  on/off<K extends keyof ChannelEvents>(...)   // message / raw / recall / connection / disconnect / error，语义不变
  reply(ticket, text, imagePaths?, opts?): Promise<ReplyResult>;
  uploadFile(type: ChatType, targetId: string, file: Buffer, name: string): Promise<{ file_id: string }>;
  send(type: ChatType, targetId: string, text: string): Promise<{ message_id: string }>;   // 仅运维告警
  prepareIncoming?(ticket): Promise<ReplyTicketRecord | null>;
  getTicket(ticket): Promise<ReplyTicketRecord | null>;
  listPendingTickets(limit?, afterSeq?): Promise<ReplyTicketRecord[]>;
  /** 取远端原消息（替代 media.ts 里的 get_msg）；不存在返回 null。 */
  fetchMessage(messageId: string, opts: { signal: AbortSignal; timeoutMs?: number }): Promise<RemoteMessage | null>;
  /** 图片直链失效时换新地址（替代 get_image）；拿不到返回 undefined。 */
  refreshImageUrl(file: string, opts: { signal: AbortSignal }): Promise<string | undefined>;
}

/** 适配器把协议字段归一化；范围核验仍由 context/media 按这些字段做，规则不变。 */
interface RemoteMessage {
  message_type: string;            // 原样透传，由核验方判断是否等于 group/private
  message_id: string;              // 远端未给出时为 ""
  group_id: string;                // 无则 ""
  sender_id: string;               // user_id 或 sender.user_id
  sender_conflict: boolean;        // sender.user_id 存在且与 user_id 不一致
  recipient_fields: Record<string, string>;   // NapCat 各版本的可选收件人字段（target_id、peer_id…）中实际出现的
  has_nonempty_group_field: boolean;          // 私聊里出现了非空 group_id
  segments: { type: string; rendered: string; image?: { url: string; file: string } }[];   // rendered = 原 policy.renderText 对单段的结果
}
```

**改动点**（行为逐字节不变）：
- `qq/bridge.ts` 实现 `Channel`：`QQBridge` 变为 `Channel` 的类型别名或子接口，由 `createQQBridge` 返回；`fetchMessage` / `refreshImageUrl` 在适配器内用现有 OneBot 客户端实现，归一化逻辑从 `context/media.ts` 的 `checkScope` / `run` 原样搬入。
- `context/media.ts`：`MediaRecallOptions` 去掉 `client: OneBotClient`，改为 `channel: Pick<Channel, "fetchMessage" | "refreshImageUrl" | "getTicket">`；`checkScope` 改为读 `RemoteMessage` 字段，判定条件一一对应原代码；`recalledText` 用 `segments[].rendered` 取代 `renderText`（整串比较用各段 `rendered` 拼接）。
- `agent/dispatch.ts`、`agent/tasks.ts`、`context/access.ts`、`context/store.ts`、`obs/alerts.ts`、`main.ts`：类型改从 `channel/` 导入，参数类型用 `Pick<Channel, …>`。`main.ts` 是唯一同时 import `qq/` 和其他包的地方。
- 不保留兼容转发导出（与 P2 一致）；`test/` 里引用 `qq/types.js` 的改为 `channel/types.js`。
- `test/architecture/deps.test.ts`：`LAYERS` 加入 `channel`；新增规则"`agent` / `context` / `obs` / `mcp` 不得 import `qq/`"和"`channel` 不得 import `qq` / `context` / `agent`"。

**不在本步**：字段改名（`group_id` / `self_id` 等 OneBot 风格的名字）、多通道 scope 前缀、Outbox、TurnContext 令牌。

**验收**：
- 依赖测试通过，且新规则对 `src/agent`、`src/context`、`src/obs`、`src/mcp` 生效。
- 全量测试通过；`test/context/media*.test.ts` 原有的范围核验用例（含 NapCat 收件人字段、私聊带 group_id、自回声票据核对）全部不改断言、照样通过。
- 新增适配器测试：对假 OneBot 的 `get_msg` / `get_image` 响应，验证 `fetchMessage` / `refreshImageUrl` 的归一化结果。
- 部署后现网票据库、消息库原样沿用，冒烟（面板、qq_context MCP 召回图片）零错误。

### 10.4 第 4 步：统一 TurnContext 能力令牌
- 把 §2.5 的召回令牌推广为回合令牌：绑定 `ConversationRef`、票据、截止时间、各项配额；记忆检索、媒体召回、看图、生图、发送都以令牌鉴权。codex 经 MCP（令牌只在 MCP 子进程环境里），pi 进程内直接持有；两后端共用同一份实现与配额账本。

### 10.5 第 5 步：Outbox 泛化 + 中途消息
- `ReplyStore` 泛化为 Outbox：每条出站消息有类型（中途 / 最终 / 兜底）与幂等键（票据 + 序号），状态机不变。
- 新工具 `qq_send(text)`：收件人固定为本回合会话，每回合 ≤2 条，经同一后处理与 trace；只要已发出任何消息就不再发兜底；最终回复照常。

### 10.6 第 6 步：排队中合并 + 重连补洞
- 同一 scope 内同一发送者在排队（未开始）期间的连续触发消息合并为一个回合；已开始的回合不打断。
- WS 重连后用 NapCat 群历史接口补齐断线期间的消息，只入库不触发。

### 10.7 节奏
第 1、2 步优先（安全），各自独立实现、评审、部署；第 3–6 步依次推进，每步单独可验证。

### 10.8 第 1、2 步验收记录（2026-10-19，主会话验收通过，main 949a19c 已部署）
- 第 1 步（astra，`4494158`）：codex 线程键改为 owner / group / private，`shared` 启动时以 `scope-split` 归档停用；每轮 `-C <WORKSPACE_DIR>/<键>` 并注入命名权限配置（隐藏整个 workspace 父目录、`pi-work`、`codex/trace`，仅开放本会话目录；owner 额外可写 prompts/workflows）；受管规则经 `developer_instructions` 每轮注入，父工作区 AGENTS.md 显式带入；拒绝 danger-full-access 与不安全目录布局。`scripts/verify-codex-scopes.mjs` 在构建镜像内用真实 codex 0.163 + 假模型服务实测 18 项全过（跨群绝对/相对路径、链接、复制、硬链接、写提示词/工作流、系统 deny_read 保留、trace、owner 读他会话、AGENTS.md 生效、view_image 跨会话、独立线程与重启续接）。
- 第 2 步（astra，`b834437` + `695f3da`）：pi bash 经 bwrap（`--unshare-user --unshare-pid --die-with-parent --new-session --cap-drop ALL`，只读根、新 /proc、tmpfs /tmp、隐藏整个 pi-work 后只挂回本会话），禁读与 codex 同源并展开通配；文件工具 realpath 后按策略检查；fail closed。
- 主会话审查补漏（major）：第 1 步引入的 codex 会话工作区与 `codex/trace` 不在共用禁读列表，pi 可跨会话读取 → `695f3da`：入口脚本禁读加 `$C/trace`，pi 整体禁读配置的 `WORKSPACE_DIR`。Codex 对抗审查因供应商内容过滤中断，未产出结论，改由主会话审查。
- 合并：两分支先在各自 worktree 合并 main（与 O5 的 `qqRecallContextArgs` 冲突，两者都保留；O5 测试补 `threadKey`），Linux 容器（生产 seccomp、node 用户、bwrap）全量 1023 通过。
- 事故：主会话一度在主树里做合并，冲突未解时被并行会话从主树构建部署，启动即归档了 shared；该会话已回滚并恢复。规则：合并只在独立 worktree 里做，部署从干净的提交构建。
- 线上实测（生产容器、真实 /data，不发 QQ 消息）：pi 沙箱内读 qq-messages.sqlite / obs-token 均 Permission denied；`ls /workspace`、`/data/codex/trace`、`/data/media` 为空；`/data/pi-work` 只见本会话；`/proc` 仅 4 个进程，PID 1 是 bwrap，环境无 token；写 `/data/prompts` 为只读文件系统；文件工具读 sqlite、`/workspace/AGENTS.md`、`codex/auth.json` 被拒，读 `prompts/agent.md` 正常。healthz 正常，codex 线程只剩 owner，`shared` 归档 1 条。
- 未覆盖：真实 QQ 群的端到端（两个群各问一轮确认互不可见）留给用户实测。

### 10.9 第 3 步验收记录（2026-10-19，主会话验收通过，main 8804aa9 已部署）
- 实现：Codex（gpt-6-astra）在独立 worktree 完成，1 条提交，30 个文件。新增 `src/channel/{types,ticket}.ts`；`qq/` 实现 `Channel`（新增 `fetchMessage` / `refreshImageUrl`，NapCat 字段归一化从 `context/media.ts` 原样搬入）；`context/media.ts` 不再引用 `qq/`，`main.ts` 不再单独创建 OneBot 客户端（改用通道自身的客户端，超时同为 15 s）。
- 审查：主会话逐条对照 `checkScope` 新旧判定（非对象响应、类型、群号、发送者回退与冲突、消息 id、自回声票据核对、可选收件人字段、私聊带 group_id）与 `recalledText`（`renderText` 本身是逐段拼接，与 `segments[].rendered` 拼接等价），行为一致。
- 测试：tsc 通过；全量 1295 通过、6 跳过；依赖测试新增 `channel` 层与三条规则，例外清单仍为空；原媒体召回用例断言未改；新增 `test/qq/channel.test.ts` 覆盖归一化。
- 部署：干净 detached worktree 构建，队列空闲时 `up -d --no-build cs-agent`（napcat 未重建），容器 healthy，`ws_connected: true`，面板页面 200。未做真实 QQ 冒烟（不向真实群发消息）；图片召回的 `get_msg` 路径待下一次实际召回时观察日志。
