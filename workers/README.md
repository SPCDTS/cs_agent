# Workers 管理面板

浏览器打开 `/admin/`，输入 `ADMIN_TOKEN` 后可以看总览、会话、审计事件、MCP、设置、定时任务、事件来源与记忆。口令只存在本标签页的 sessionStorage，每个请求以 `Authorization: Bearer` 发送；任一接口返回 401 时页面清掉口令并回到登录框。页面与 `/admin/app.js` 不需要口令，也不含数据；`/admin/` 下其余路由都在 `src/admin/routes.ts` 的路由表里，先匹配路由再鉴权，未知路径返回 404。页面响应带 CSP（`script-src 'self'`、`frame-ancestors 'none'`）、`no-store`、`no-referrer` 与 `nosniff`，接口文本一律用 `textContent` 写入。

| 接口 | 作用 |
| --- | --- |
| GET /admin/overview | Bridge 连接、模型、熔断、MCP 状态、各线程 stats（单个 Thread 失败显示 unavailable）、secrets 是否已配置；`schedule`（`ScheduleDO.status()`）与 `events`（`EventsDO.health()`），任一个 DO 出错时该字段为 `{ error: "unavailable" }`，整页仍 200 |
| GET / PUT /admin/settings | 运行时设置；PUT 带 `expectedRevision`，不一致返回 409 与当前值，成功后推送给 Bridge |
| GET /admin/events?thread=&kind=&result=&before=&limit= | 单个线程的审计事件，按 rowid 倒序翻页，limit ≤ 200。`result` 按 `thread.ts` 的 `EVENT_RESULT_PATH` 取各类型的结果字段（mcp_call、web_search、generate_image、coding_* 为 `result`，mcp_catalog 为 `status`），表里没有的类型不按结果过滤 |
| POST /admin/threads/:key/stop | 中止该线程当前回合并撤回排队输入（pi-durable `root.abort`） |
| GET /admin/threads/:key/subagents | 该线程最近 50 个子 agent：任务前 200 字、状态、派出与结束时间、最近汇报、派出者 |
| POST /admin/subagents/:id/cancel?thread=、GET /admin/subagents/:id/transcript?thread=&limit= | 取消运行中的子 agent；查看子会话最近 limit（≤ 50）条条目的类型与文本前 200 字。子 DO 名字含父线程键，所以要带 thread |

| POST /admin/threads/:key/sandbox/reset | 销毁该线程的沙箱容器（`/work` 随之清空）；没有容器绑定时 503 `sandbox_unavailable`。总览里 owner 行带 `sandbox`：`running` / `stopped` / `unavailable` |
| GET /admin/memory?ns=&q=、DELETE /admin/memory/:id?ns=、PUT /admin/memory/profile | 记忆列表与搜索（`#id` 按编号）、遗忘、画像 CAS；ns 只能是 owner 或 group:群号 |
| POST /admin/mcp/:server/login-link、logout、refresh | 一次性登录链接、本地登出、刷新 owner 线程的 MCP 目录 |
| POST /admin/send-rules/release | 解除某个 scope 的熔断 |
| GET / PUT /admin/model | 当前模型、可选模型、ChatGPT 登录状态与 `imageGeneration`（`unknown` / `available` / `unavailable`）；PUT 带 `expectedRevision`（与设置共用），切到不可用的模型返回 400 `invalid_model` |
| POST /admin/model/oauth/codex/start、complete、logout | ChatGPT 订阅登录：生成授权链接、提交粘贴回来的回调地址、登出 |
| GET /admin/skills、GET / PUT / DELETE /admin/skills/:name、POST /admin/skills/:name/enable、disable | 技能目录：列表（不含正文）、读单个技能、写入（body `{ markdown, files? }`）、删除、启停 |
| POST /admin/messages/import | 历史聊天记录导入，见“历史记录导入” |

设置保存在 Registry 的 `settings` 表（一行整份覆盖值）：`groupTrigger`（`mention_or_reply` / `mention_only` / `off`）、`allowGroups`、`allowUsers`、`extractNamespaces`。没有保存过时沿用 `QQ_ALLOW_GROUPS`、`QQ_ALLOW_USERS`、`QQ_GROUP_MENTIONS`（false 对应 off，其余对应 mention_only）与 `MEMORY_EXTRACT_NAMESPACES`；保存后这四个 secrets/vars 只作默认值显示。revision 是有效内容 SHA-256 的前 16 位。`mention_or_reply` 新增“回复机器人发出的消息”也能触发，判定查本群消息库里 `is_self=1` 的消息。Bridge 在内存缓存设置，面板保存后立即重载；Thread 判定抽取命名空间时缓存 60 秒，取不到设置时本轮不抽取。owner 只来自 `QQ_OWNER`，面板不能修改。

“定时任务”卡片列出 `GET /admin/schedules` 的全部任务（规则原文或一次性、北京时间的下次触发、连续失败数、最近一次运行），可暂停 / 恢复、立即运行与删除（点两次确认）。“事件来源”卡片按来源显示状态（已暂停 / 降级 / 正常）、游标、上次轮询、积压、本小时预算与 Gmail watch 到期，可暂停 / 恢复；“设置”展开后整份提交 `PUT /admin/event-sources/:source/settings`，展开期间 30 秒刷新不覆盖未保存的输入；下方列该来源最近 10 次投递。审计事件的类型 chips 之外另有“更多”下拉，含 web_search、generate_image 与 coding_*。

解除熔断把该行的 `until` 改成当前时间而不删除，它仍是计数窗口的起点，否则熔断前的 60 条会让下一条立刻再次熔断。

# 模型与 ChatGPT 登录

2026-10-30 起不再经 magpie 容器。Worker 用 pi-ai 直连两个 provider：`deepseek`（API key，secret `DEEPSEEK_API_KEY`）与 `openai-codex`（ChatGPT Plus/Pro 订阅的 OAuth，请求 `https://chatgpt.com/backend-api/codex/responses`）。provider 注册表在 `src/models.ts`，测试配置另有 `faux`。

- 当前模型是 Registry 设置里的 `model`：`{ provider, id, reasoningEffort? }`，推理强度可选 low / medium / high / xhigh，不选即模型默认。没保存过时用 vars `MODEL_PROVIDER` / `MODEL_ID`（生产为 `deepseek` / `deepseek-flash`）。在面板“模型”卡片里切换，保存走设置的 CAS；Thread 在接纳下一批输入前重新读设置，变了就 `configure` 切到新模型，不用重新部署。记忆抽取、摘要与整理用同一个 provider，`MEMORY_EXTRACT_MODEL` 只换模型 id。
- 只能选已注册、目录里有、且可用的模型：DeepSeek 缺 key 时原因为 `missing_key`；Codex 没登录为 `login_required`，没有 `OAUTH_STORE_KEY` 为 `unconfigured`。只有模型变化时才校验，已选的 Codex 登出后，群与白名单等其他设置仍能保存，`/healthz` 的 `model` 变为 `{ unavailable }`，回合失败，直到重新登录或切走。
- 登录步骤：面板“模型”卡片点“开始登录”，打开授权链接登录 ChatGPT；授权后浏览器跳到打不开的 `http://localhost:1455/auth/callback?code=…&state=…`，把地址栏里的整串地址粘贴回面板，点“完成登录”。授权链接 10 分钟有效，每次开始都会作废上一条；state 在换 token 前就消费，失败后要重新开始。错误只回分类（`invalid_state`、`missing_code`、`authorization_denied`、`invalid_callback`、`token_exchange`、`unconfigured`），不回显 code 或 token。
- 授权端点、token 端点、client id、scope 与 PKCE S256 都与 pi-ai 自带的 openai-codex 登录相同（`src/codex-login.ts`）。没有调 pi-ai 的 `login()`，它要在本机起 1455 端口的回调服务器；也没有用 pi-ai 的 `openaiCodexProvider()`，它的 OAuth 实现经变量路径动态 import，打包进 Worker 后加载不到，所以按同一端点自己写 refresh，目录与 Codex Responses API 照用 pi-ai 的。
- 凭据存在 Registry 的 `model_credentials`：整份 pi-ai `Credential`（`{ type: "oauth", access, refresh, expires, accountId, email? }`）经 AES-GCM 加密，AAD 为 provider id；`meta_json` 只有类型、邮箱、account id 与过期时间，面板和健康检查只读这一列。account id 取自 access token 的 `chatgpt_account_id`，pi-ai 用它填 `chatgpt-account-id` 请求头。
- pi-ai 在 access token 剩 5 分钟内时于 `CredentialStore.modify` 里刷新。Thread 一侧的 store（`src/model-credentials.ts` 的 `remoteCredentials`）经 Registry 租锁：`credentialAcquire` 拿锁与当前凭据，回调在 Thread 里跑，`credentialSettle` 按版本 CAS 写回并放锁；租约 30 秒到期自动放锁。所以多个会话同时请求时只刷新一次，轮换后的 refresh token 不会被另一份旧 token 的刷新冲掉。
- Codex 固定走 SSE：Harness 的 stream 设置与 `directComplete` 都传 `transport: "sse"`。pi-ai 默认先试 WebSocket 并按会话缓存连接，DO 里的连接跨不了请求。
- secrets：`DEEPSEEK_API_KEY` 由 `scripts/put-secrets.sh` 从仓库根 `.env` 的 `DEEPSEEK_APIKEY` 读取，为空就跳过并提示；ChatGPT 登录不经 secrets，只依赖已有的 `OAUTH_STORE_KEY`，换这个密钥会使已存的 ChatGPT 凭据解不开，要重新登录。

## 联网搜索、网页与图片生成

ChatGPT 订阅自带的托管工具做成 Worker 工具，当前模型是 DeepSeek 时也能用。代答走一次独立的 Codex 补全（`src/codex-hosted.ts`），不经 Harness、不进会话历史；请求体在 pi-ai 的 `onPayload` 里追加托管工具，托管工具的输出项从 `onProviderStreamEvent` 的原始事件里取，因为 pi-ai 把 `web_search_call`、`image_generation_call` 静默丢掉（不报错，也不进结果）。代答模型由 var `CODEX_SEARCH_MODEL` 指定，留空时按 `models.ts` 的 `searchModel` 挑：先找 id 含 mini / nano 的，没有就取目录标价最低的（现为 `gpt-6-luna`）。推理强度固定 low。

- `web_search`（`src/search.ts`、`src/tools/web-search.ts`）：所有会话、所有回合都有，事件回合也有。响应里没有 `web_search_call` 输出项就当作没搜、凭记忆作答，整份结果丢弃并回 `not_searched`。结果规整为 `{ title, url, snippet }`，URL 去掉 `utm_*`。超时 60 秒。审计 `events.kind = web_search` 只记分类、耗时与结果数，不记查询。
- `web_page`（`src/tools/web-page.ts`）：Worker 自己 fetch。只按主机名字面判断（拿不到 DNS 结果）：IP 字面量、单标签名、localhost 与 `.local` / `.internal` / `.container` 一律拒绝，每跳重定向重新校验，最多 3 跳；20 秒、4 MiB，只收 HTML、纯文本与 JSON；HTML 去掉脚本、样式、导航、页脚与 noscript 后抽正文，默认截到 8000 字。所有回合可用。
- `generate_image`（`src/tools/generate-image.ts`）：只注册在 owner 线程，执行时再核对本回合是 owner 亲自发来的消息，定时回合拒绝，事件回合的工具档里没有它。图片取自 `image_generation_call.result`（base64 PNG），经 Bridge 的 `sendImage` 以 OneBot `base64://` 图片段发到当前会话，按一条消息计入发送规则。成功或被后端 4xx 拒绝时把结果写进 Registry，面板“模型”卡片显示“图片生成：未知 / 可用 / 不可用”。ChatGPT 订阅是否允许这个托管工具要看真实调用，探针见 `test/codex-image.probe.test.ts`（`CODEX_PROBE=1` 时从本机 Codex CLI 的 `~/.codex/auth.json` 读凭据，默认跳过）。
- `send_message` 发出前经 `src/send-clean.ts`：Markdown 链接 `[文字](url)` 改成 `文字（url）`，所有 URL 去掉 `utm_*` 参数，其余文字不动。

# Workers P3b：技能目录与历史记录导入

## 技能目录

- 存在 Registry 的 `skills` 表：`name` 主键、`description`、`body`（整份 SKILL.md，含 frontmatter）、`files_json`（`{ "<相对路径>": "<文本>" }`）、`updated_at`、`enabled`。代码在 `src/skills.ts`，Registry RPC 为 `skillsList()`（不含正文）、`skillGet`、`skillPut`、`skillDelete`、`skillSetEnabled`、`skillsDigest()`（启用技能的 name+description 的 SHA-256 前 16 位）。
- 写入只经面板：`PUT /admin/skills/:name`，body `{ markdown, files? }`。校验照 Docker 的 `skills-store.ts`：name 须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，frontmatter 的 name 与 URL 一致（没写 name 时以 URL 为准），description 必填且不超过 500 字，SKILL.md 不超过 256 KiB；附件只收文本，单个 ≤ 64 KiB、合计 ≤ 512 KiB，路径不能含 `..`、反斜杠或控制字符，不能以 `/` 开头。错误返回 400 与分类（`invalid_name`、`name_mismatch`、`missing_frontmatter`、`missing_description`、`description_too_long`、`skill_too_large`、`invalid_path`、`invalid_file`、`file_too_large`、`files_too_large`）。覆盖写入保留启用状态；省略 `files` 时保留已有附件，传 `{}` 才清空。
- 提示注入：每个 Thread 有 `skills` section，按 Docker 的 `<available_skills>` 格式只列启用技能的名称与描述，没有启用技能时不渲染。Thread 缓存目录 60 秒，到期先取 digest，变了才重新取列表渲染；文本不变时 pi-durable 不重发。Registry 暂时取不到时沿用上一份目录。
- 工具 `read_skill { name, path? }`：不传 path 返回 SKILL.md，传 path 返回附件，超过 20000 字截断；技能不存在或已停用时返回说明文字。所有线程都有，事件回合的只读工具档也有。没有写技能的工具。
- 面板“技能”卡片：列表、启停、编辑、删除（点两次确认）；新增或编辑都是把 SKILL.md 粘进文本域保存，名字取自 frontmatter。附件暂无页面入口，只能经接口上传。
- 从 Docker 迁移（Bash，仓库根目录）：`scripts/import-skills.mjs` 读 `data/skills/<name>/SKILL.md` 与该目录下的文本文件（含子目录），输出 PUT 请求体；二进制、`__pycache__`、点开头的文件与超过 64 KiB 的文件跳过，并在 stderr 列出路径。

~~~bash
for dir in data/skills/*/; do
  name=$(basename "$dir")
  node workers/scripts/import-skills.mjs "$name" | curl --fail-with-body -X PUT "$WORKER_URL/admin/skills/$name" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' --data-binary @-
done
~~~

## 历史记录导入

- 导出（仓库根目录，Node ≥ 24）：`node workers/scripts/export-messages.mjs <scope>`，scope 为 `group:<群号>` 或 `private:<QQ号>`。只读打开 `data/qq-messages.sqlite`，输出 `{ scope, name?, messages, summaries }`；Docker 的 `summaries.level` 改名 `kind`，`outbox_key`、`status` 丢弃，`detail` 含 `data:` URI 或 256 字符以上的 base64 串时置空。
- 导入：`POST /admin/messages/import`（ADMIN_TOKEN），body 即导出结果，≤ 8 MiB（超过 413，格式不对 400 `invalid_import`）。`group:<群号>` 进同名线程；`private:<owner 号>` 进 `owner` 线程，消息仍按 `private:<owner 号>` 作用域保存，`qq_context` 才能按当前会话召回；其他私聊进 `private:<号>`。owner 号取自 `QQ_OWNER`。Thread 再经 `idFromName` 复核。
- 消息按 `(scope, message_id)`、摘要按 `(scope, kind, period_start)` 去重（`INSERT OR IGNORE`），线上已有的同号消息不被覆盖；`scope_names` 用导入的 name 更新。FTS（trigram）由触发器同步。返回 `{ messages: { inserted, skipped }, summaries: { inserted, skipped } }`，同样的计数写进审计事件 `history_import`，不含正文。

~~~bash
node workers/scripts/export-messages.mjs group:123456789 > history-group.json
curl --fail-with-body -X POST "$WORKER_URL/admin/messages/import" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @history-group.json
~~~

- 导入后由维护任务接管：早于 `HISTORY_RAW_DAYS` 的原文，已被摘要覆盖的在下一次 aging 时删除；没被覆盖且一天 ≥ 5 条的，aging 会逐日调用模型补日摘要。早于 `HISTORY_SUMMARY_DAYS` 的摘要会被清理。
- 测试：`test/skills.test.ts`、`test/message-import.test.ts`（vitest），`test/export-messages.node.mjs`、`test/import-skills.node.mjs`（`node --test` 单独运行）。
# 子 agent（P3a）

主 agent 用 `subagent` 工具把耗时或可并行的事交给子 agent。每个子 agent 是一个独立的 `SubagentDO`（绑定 `SUBAGENT`，迁移 `v8`，名字 `sub:<父线程键>:<id>`），里面跑自己的 pi-durable Harness；完成后结果作为后续输入投回父线程，唤醒主 agent 再由它对用户说。代码在 `src/subagent/`：`model.ts` 是两边共用的类型与身份合并，`do.ts` 是子 DO，`parent.ts` 是父线程的登记表与工具。

- 工具：`spawn { task, timeoutMs? }` 立即返回 id；`message { id, text }` 追加消息；`list`；`cancel { id }`。只有用户亲自发消息的回合能用（owner 私聊与群都可以），定时、事件与汇报回合调用会被拒绝；事件工具档里没有它。每个父线程同时最多 3 个运行中的子 agent，第 4 个 spawn 返回拒绝文本。spawn 的 id 与 message 的请求 id 由工具调用的任务 id 哈希得出，工具重放不会重复派出或重复交代。
- 子会话的工具只有 `web_search`、`web_page`、`qq_context`、`mem_search`。后两个经 RPC 回父线程执行：`qq_context` 只读派出时的会话，`mem_search` 读父命名空间，owner 命名空间只对确证的 owner 派出者开放。没有 `send_message`、`generate_image`、gmail、schedule、`subagent`、记忆写工具与 MCP。模型与推理强度在 spawn 时取 Registry 设置的当前值。
- 子 DO 的表：`meta`（一行 JSON：parent、id、task、createdAt、identity、model、status、endedAt、reportCount、version）与 `inbox`（request_id、text、received_at、status、answer、outcome）。输入一次只跑一条，每条各得一个回答、各汇报一次：queued → running → answered（回答落库）→ reported（父线程收下）。汇报经 `THREAD.subagentReport` 投回；送不到时停在 answered，由子 DO 每 60 秒的心跳 alarm 补送，驱逐后也由心跳重开 Harness 续跑。结束（done / failed / cancelled）满 14 天后 alarm 删除整个对象。
- 父线程表 `subagents`：id、task、状态（running / done / failed / cancelled / timeout）、身份快照、派出会话、限时与 deadline、子 DO 版本。子 DO 每次状态变化推进 `version`，父线程只采纳更新的版本，所以 message 的返回与汇报无论谁先到都收敛。cancelled 与 timeout 是父线程的终态，之后迟到的汇报丢弃。结束 14 天后由夜间 retention 删除登记。
- 汇报输入：`kind = "subagent"`，入站键 `subagent-report:<id>:<requestId>`（超时为 `timeout@<deadline>`），文本以 `[子 agent 完成]`、`[子 agent 失败]` 或 `[子 agent 超时]` 开头。归 chat 档、followUp 排在当前回合之后、不进消息库、不参与记忆抽取，回合的 `turn-identity` 段说明这是子 agent 的汇报与派出者。
- 身份（ARCHITECTURE §5.1）：spawn 时快照本回合发送者；汇报回合以快照里的人为本回合的人，owner 派出的汇报回合有 owner 的记忆写、schedule 与 MCP 权限（发邮件、生图仍只限主人亲自发消息的回合）。别的回合 message 它时与快照合并，不是同一人（owner 多账号算同一人）就降为基础权限，之后的汇报 userId 为空。快照时与当前配置的 owner 身份不一致也降为基础权限。
- 超时：spawn 的 `timeoutMs` 默认 30 分钟，范围 1 秒到 6 小时；每次 message 从当时起重新计时。父 DO 的 alarm 同时服务记忆抽取与最早的 deadline；到期时先取消子 DO（它若刚好答完就按完成处理），再以 `[子 agent 超时]` 汇报唤醒父线程，最后记为 timeout。
- 审计：父线程 events 记 `subagent_spawn`（id、限时、任务字数）与 `subagent_report`（id、结果、自派出起的耗时、汇报字数），不记正文。面板会话表每行显示运行中的子 agent 数，点开列出任务摘要、状态与时间，运行中的可取消。

| 功能 | 对应测试（test/subagent.test.ts） |
| --- | --- |
| 子 DO 启动、汇报唤醒主模型并 send_message、汇报不进消息库不抽取、子会话工具集、审计只含元数据 | runs the task in its own DO with read-only tools… |
| message 追加、子 DO inbox 按 requestId 幂等 | delivers follow-up messages and processes each child request id once |
| 群成员派出的汇报回合没有 owner 工具，owner 派出的有（群里 schedule、私聊 mem_remember） | wakes with the spawner's rights… |
| 父 alarm 到期取消子 DO 并以超时汇报唤醒 | cancels the child at the deadline… |
| 第 4 个 spawn 被拒 | rejects a fourth concurrent spawn |
| 面板端点鉴权、列表、记录、取消 | lists, inspects and cancels subagents through the authenticated admin API |

与 Docker 版（`src/agent/pi-tools/subagent.ts`）的差异：子 agent 在自己的 DO 里而不是同一 Harness 的子会话；输入一律 followUp，没有 steer；没有每天 20 个的上限，改为限时；按 id 而不是名字寻址，没有 status 动作（list 即可）；工具集是固定的只读白名单，不再从父会话复制后减去排除名单；汇报回合不能再派子 agent，Docker 版允许沿链继承。

## 沙箱 coding 工具（P3c）

owner 私聊里的 `read` / `write` / `edit` / `bash` 跑在 Cloudflare Containers 的沙箱容器里，每个会话一个，工作区 `/work`。

- 容器：`SandboxDO`（`src/sandbox/do.ts`，绑定 `SANDBOX`，迁移 `v9`，名字是线程键）。本账户只允许 `durable_object` 调度策略，所以和当年的 magpie 一样由普通 DO 用 `ctx.container.start({ image: images.sandbox, enableInternet: true, instance: "lite" })` 按需拉起，`setInactivityTimeout` 10 分钟。冷启动时轮询 `/health`（500 ms，最多 30 秒）；就绪后每个请求只发一次，连接失败回 `sandbox_unavailable` 并在下次重新确认就绪，exec 不会被重放。
- 镜像：`sandbox/Dockerfile`，`debian:bookworm-slim` 加 python3、nodejs、git、curl，由 `wrangler deploy` 构建推送（需要 Docker，本机 `--dry-run` 也要 Docker，没有时加 `--containers-rollout=none`）。没用官方 `cloudflare/sandbox` 镜像：`@cloudflare/sandbox` 1.x 只带 `sandbox-shim`，文件操作要经 SDK 的帧协议，Worker 侧就得引入这个依赖。
- 控制服务：`sandbox/server.mjs`，监听 3000，只有 DO 能到达。`POST /exec {cmd, cwd, timeoutMs ≤ 120 s}` → `{stdout, stderr, code, timedOut, truncated}`，两路输出各留末尾 64 KiB 并在开头标出省略字节数；超时杀整个进程组；shell 退出后最多再等 1 秒，后台进程不拖住请求。`GET/PUT /file`、`POST /edit {path, edits}`（每处 oldText 必须唯一、互不重叠，与 Docker 版 edit 一致）、`GET /ls`。服务以 root 运行，命令降到 uid 1000 的 `sandbox` 用户执行，服务写出的新文件与目录交给该用户。
- 路径：Worker 侧 `workPath`（`src/sandbox/client.ts`）先按 `/work` 词法规范化，出界就不发给容器；控制服务再按 realpath 校验，符号链接指到 `/work` 外一律 `path_denied`。
- 工具（`src/tools/coding.ts`，扩展 `cs.coding`）：参数与说明移植 Docker 版（`edit` 同样修正模型把 edits 写成 JSON 字符串或单个对象的情况），`bash` 默认 60 秒、最长 120 秒。只注册在 owner 线程，执行时核对本回合是 owner 亲自发来的消息（与 `generate_image` 同一道门），定时回合拒绝，事件回合的工具档里没有它们。`bash` 的 `replay` 为 `unsafe`，其余 `safe`。系统提示段 `sandbox` 只在本次请求提供了 `bash` 时出现。失败按分类码回给模型（`sandbox_unavailable`、`path_denied`、`edit_not_found` 等）。
- 审计：`coding_exec` 记 `{result, commandLength, code, ms}`，`coding_read` / `coding_write` / `coding_edit` 记 `{result, ms}`；不记命令、路径、文件内容与输出。
- 工作区不保证跨容器重建保留。产物写到 `/work/out/`；发文件给主人（`send_file`）尚未实现。
- 测试：`test/coding-tools.test.ts`（路径与协议、用假容器测 DO 的启动与不重放、工具注册与分类、面板）；控制服务用真实 Node 测：`node --test test/sandbox-server.node.mjs`（Windows 上用 Git 的 bash）。

# Workers P2：定时任务、外部事件与维护

## 定时任务（P2a）

- owner 在私聊或群里让机器人用 `schedule` 工具建任务，时间按北京时间解析（一次性 `at` 或 RRULE）。`ScheduleDO` 用单一 alarm 触发，把一条 `kind=schedule` 输入投给对应会话的 ThreadDO。
- 定时回合归 chat 工具档：排在当前回合之后（不插话）、不进消息库、不做记忆抽取；回合内只能用 `schedule_control` 控制自己这条任务，不能再建任务。回合结束按 `outbox.input_id` 统计发送条数，回写 sent / silent / failed。
- 连续 3 次失败自动暂停并私聊告警；上一次还在执行时本次记为 overlap 跳过。
- 管理端点：`GET /admin/schedules`、`POST /admin/schedules/:id/pause|resume|delete|run-now`。`/healthz` 的 `schedule` 给出活动数、暂停数与下一次触发时间。
- 不需要额外的 var 或 secret，owner 仍只来自 `QQ_OWNER`。

## 外部事件与 Gmail（P2b）

- `EventsDO`（绑定 `EVENTS`）拉取外部来源，目前只有 Gmail。触发有两路：Pub/Sub 推送到 `POST /gmail/pubsub`（校验 OIDC 令牌的服务账号与 audience，不用 `ADMIN_TOKEN`），以及 Cron `*/5 * * * *` 轮询兜底（来源默认间隔 120 秒）。
- 新邮件先按标签与发件人过滤，再按合并窗口、每小时预算（默认 10）和安静时段节流，最后以 `kind=event` 输入投给 owner 线程。事件回合用 event 工具档，只读：`send_message` 只发给 owner，另有 `qq_context`、`mem_search`、`gmail_search`、`gmail_read` 与 `mcp.json` 里 `eventAllow` 列出的 MCP 工具；不写记忆、不进消息库、不做抽取。回合结束回报 `finishRun`。
- 主人私聊回合可以用 `gmail_search`、`gmail_read`、`gmail_send`。发信只允许主人亲自发消息的回合，定时与事件回合都不行。
- vars：`GMAIL_PUBSUB_SERVICE_ACCOUNT`（推送订阅用的服务账号邮箱）、`GMAIL_PUBSUB_TOPIC`（`projects/<项目>/topics/<名称>`）。两项都为空时只靠轮询。secrets：`GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN`，由 `scripts/put-secrets.sh` 从 `secrets/gmail/client.json` 与 `token.json` 读取，缺任一项时跳过这三项。
- 管理端点：`GET /admin/event-sources`、`POST /admin/event-sources/:source/pause|resume`、`PUT /admin/event-sources/:source/settings`（整份来源设置，严格校验）。`/admin/events` 仍是线程审计事件。`/healthz` 的 `events` 给出各来源状态与积压数。
- 用户侧要做的事：在 Google Cloud 建 Pub/Sub topic，给 `gmail-api-push@system.gserviceaccount.com` 授予该 topic 的 Publisher 角色；建推送订阅，端点为 `https://agent.spcdts.dev/gmail/pubsub`，开启身份验证并指定一个服务账号，audience 留空（默认即端点 URL，Worker 按它校验）；把 topic 与服务账号邮箱填进 `wrangler.jsonc` 的两个 var；然后重跑 `bash workers/scripts/put-secrets.sh` 上传 Gmail secrets，再部署。

## 维护任务（P2c）

- Cron `30 19 * * *`（UTC，即北京时间 03:30）对 Bridge 见过的每个线程依次调用 `ThreadDO.maintain`，跑三项：aging（生成日、周聊天摘要并清理过期原文）、consolidate（记忆夜间整理）、retention（审计事件、入站与发件记录、抽取队列的保留期清理）。单项失败只记日志，不影响其他线程。
- `index.ts` 的 `scheduled()` 用 `CRONS` 表按 cron 字符串分派，事件轮询与维护各占一项；`wrangler*.jsonc` 的 `triggers.crons` 两项都要有。
- vars（可选，单位为天，0 表示不清理）：`HISTORY_RAW_DAYS`（默认 30）、`HISTORY_RAW_HARD_MAX_DAYS`（90）、`HISTORY_SUMMARY_DAYS`（365）、`EVENTS_RETENTION_DAYS`（30）。
- 没有单独的管理端点。`/healthz` 与 `/admin/overview` 中线程 stats 的 `maintenance` 字段给出上次 aging、consolidate 的时间和摘要条数。

# Workers P1c

P1c 在 owner 私聊增加外部 MCP 与 codemode，初始服务为 Notion 托管 MCP。配置在 [mcp.json](mcp.json) 中随构建打包，只有非秘密的服务地址、账号引用版本、CIMD URL 和精确工具白名单。仅修改配置文件不会热更新，需重新构建部署。现有 QQ、记忆与模型路径继续保留。

## 配置与登录

| 项目 | 行为 |
| --- | --- |
| PUBLIC_ORIGIN | var，生产为 https://agent.spcdts.dev；须为无路径、query、hash 的 HTTPS origin |
| ADMIN_TOKEN | secret，保护记忆导入及 POST /admin/mcp/oauth/login-link，只接受 Bearer |
| OAUTH_STORE_KEY | secret，32 字节 hex；缺失或格式错误时 OAuth 状态为 unconfigured，不阻塞普通回合 |
| credential.kind | none、external-account、oauth；external-account 的 transport.secretHeaders 只引用 Worker secret 名 |
| oauth.registration | 仅 cimd，省略时也按 CIMD 执行；不回退 DCR |
| access.kind | 仅 owner-private；不接受群、定时、唤醒或子 agent 权限开关 |
| replay | MCP 业务与 mcp_refresh_tools 均为 unsafe；codemode 的脚本日志恢复由 pi-durable 管理 |

GET /oauth/client-metadata.json 返回本 Worker 的客户端元数据，Content-Type 为 application/json，Cache-Control 为 public, max-age=300。client_id 是 PUBLIC_ORIGIN + /oauth/client-metadata.json，redirect_uris 唯一项是 PUBLIC_ORIGIN + /mcp/oauth/callback。Notion 配置中的 clientMetadataUrl 已使用生产 Worker 域名，不依赖 Vercel。更换域名时同时修改 PUBLIC_ORIGIN 与 mcp.json 中的 URL。

管理员以 Bearer 调用 POST /admin/mcp/oauth/login-link，JSON body 为 {"server":"notion"}，得到 {"url":"…"}。打开该一次性链接后，GET /mcp/oauth/start?nonce=… 返回 302 到授权服务器。授权成功回调 GET /mcp/oauth/callback?code=…&state=…，换码后返回纯文本“已登录 notion”。错误仅返回固定分类；登录相关响应均 no-store、no-referrer。链接是登录能力本身，应由管理员私下交给 owner；聊天工具不生成链接。

每个服务只保留一条待登录记录；重新发链接会使旧链接失效。nonce 在 start 联网前消费，state 在换码前消费，成功或失败均不能重放。十分钟有效期从签发链接起计算。PKCE 使用随机 32 字节 verifier 与 S256 challenge。发现必须宣告 CIMD 和 S256，client_id 直接使用配置中的元数据 URL。

RegistryDO 绑定 REGISTRY，以 main 为单例名，v4 迁移新建 SQLite DO。三张表为 mcp_oauth_tokens、mcp_oauth_logins、mcp_oauth_client；失败分类另保存在该 DO 的 KV。access/refresh token 以独立随机 IV 的 AES-GCM 密文保存，AAD 绑定 server/account/revision/字段；登录 verifier 连同本次发现结果与配置快照也加密。client 表只保存公开 CIMD 身份，不保存 client_secret。更换 revision 后不读取旧版本 token。

accessToken 在到期前 60 秒按需刷新；并发刷新共享结果。刷新响应未给新 refresh token 时保留旧值。invalid_grant、invalid_client、unauthorized_client 删除当前版本 token 并标 error；网络失败、超时、5xx 保留 token。401 在账号锁内复核已用 token，同一 HTTP 请求最多换 token 重试一次，403 不重试。logout RPC 删除本地 token 与待登录状态，P1c 没有公开 logout 路由。

scripts/put-secrets.sh 增加读取 secrets/oauth-store-key.env；缺文件时以 UTF-8 生成随机密钥并保存，然后随既有 secrets 经 stdin 上传。脚本只在显式运维执行时生成或上传，本次开发未执行。请保留原密钥，改值会使现有密文无法解密。

## 工具、快照与审计

每个 owner Thread DO 有独立 SDK Client 连接池，按服务串行调用；连接默认空闲十分钟后在下一次 MCP 请求时关闭，不占用记忆抽取的 alarm。初始化 10 秒，调用总预算 60 秒，默认每服务队列上限 16。目录完整分页后按 allow 精确过滤；重复名称/游标、分页或字节超限拒绝整个候选目录，schema 不支持只隔离单个工具。

schema 移植严格 draft-07 子集：根 object、本地无环引用、definitions/$defs、数值 exclusiveMinimum/exclusiveMaximum；拒绝未知关键字、未知 format、外部/循环引用。只剥离 schema 节点的有界 $schema 注解。工具名称使用原 mcp-tool-v2 契约摘要与 SHA-256 前 12 位；描述变化及无关工具变化不会改名，业务属性和 const/default 数据仍参与身份。

Thread 表 mcp_catalog 保存当前完整目录。启动先验证并注册快照，再通过 waitUntil 后台刷新；首次调用、重连、目录通知和五分钟 TTL 到期时重新发现并核对契约。刷新失败保留快照，但不发送依赖失效目录的新调用。每服务替换当前 extension，旧名称不可用于新的调用；变更后的工具在下一段 codemode 脚本中可见。

MCP 业务工具和 mcp_refresh_tools 使用 callers: ["tools"]，不出现在模型工具定义中；只有 codemode 作为脚本入口。QQ 与记忆工具使用 callers: ["model"]。codemode 使用 createInlineCodemodeSandbox()，models: false，声明按服务前缀分组。每次脚本入口、控制调用及嵌套业务调用均按本回合入站身份复核 owner；排队和连接等待后再次检查。群内 owner、群成员与其他私聊根本不安装 MCP/codemode。

文本结果拼接后限制在 8000 字符内并标出截断；图片、音频、二进制资源给出省略提示，不下载链接。声明 outputSchema 的 structuredContent 先校验再交给脚本，否则只传有界文本。业务请求发送后失败返回 outcome_unknown，不自动重发；远端可能已产生副作用，需先查询实际状态。

events 表的 mcp_call 仅保存服务、工具名、耗时、结果分类、输入输出字节数；mcp_catalog 保存刷新结果、目录摘要、工具数和有界 schema 拒绝原因。不保存正文、凭据、code 或 verifier。正常 Pi 工具历史仍包含业务参数和有界结果。GET /healthz 增加 mcp 数组，含 server、enabled、credential、login 和 tools；tools 为最后持久目录的数量，OAuth 状态不会改变原有模型健康码。

## P1c 文件与验证

| 文件 | 职责 |
| --- | --- |
| mcp.json、src/mcp/config.ts | 静态 Notion 配置、TypeBox + Check 严格边界 |
| src/registry.ts、src/mcp/crypto.ts、oauth.ts、oauth-fetch.ts | Registry OAuth 状态、AES-GCM、CIMD、PKCE、受限发现/换码/刷新 |
| src/mcp/connection.ts、transport-http.ts | SDK Streamable HTTP、Bearer、分页、流限额、关闭 |
| src/mcp/catalog.ts、schema.ts、names.ts、result.ts | SQLite 快照、严格 schema、稳定名称、结果转换 |
| src/mcp/index.ts、src/thread.ts | 连接池、codemode、权限复核、工具装配与审计 |
| src/index.ts、env.ts | 登录/元数据路由、健康字段与绑定类型 |
| wrangler.jsonc、wrangler.test.jsonc、worker-configuration.d.ts、tsconfig.json | REGISTRY、v4、PUBLIC_ORIGIN、生成类型、JSON import |
| scripts/put-secrets.sh、vitest.config.ts | 运维密钥脚本与仅用于测试的合成密钥绑定 |
| test/mcp-*.test.ts、test/mcp-helpers.ts | workerd 集成、协议桩与边界测试 |

| 功能 | 对应测试（test/ 下） |
| --- | --- |
| Notion 配置、未知字段、重复 id、owner-private、unsafe、stdio/HTTP/危险头拒绝 | mcp-config-schema.test.ts：bundles…、rejects unsupported or unsafe config、accepts static secret references… |
| 严格 schema、本地引用、$defs、边界、注解、允许列表、单工具拒绝、名称稳定 | mcp-config-schema.test.ts：checks local refs…、rejects unsupported schema、filters allow lists… |
| 文本拼接、8000 字、图片占位、远端错误、结构化输出校验 | mcp-config-schema.test.ts：joins text… |
| 自托管 CIMD 文档、PUBLIC_ORIGIN 回调、缓存头 | mcp-oauth.test.ts：serves its own client metadata… |
| 管理鉴权、缺密钥降级 | mcp-oauth.test.ts：requires an admin Bearer… |
| 完整链接→start→callback→token、S256、单次消费、十分钟过期、密文与健康状态 | mcp-oauth.test.ts：runs login-link…、expires links and states… |
| 刷新单飞、保留 refresh token、invalid_grant、暂态错误、DO 重建、logout | mcp-oauth.test.ts：single-flights refresh…、keeps tokens on temporary refresh failures… |
| CIMD 必需、第三方端点零请求、AES-GCM 随机 IV/AAD/防篡改 | mcp-oauth.test.ts：refuses absent CIMD support…、uses randomized AES-GCM… |
| OAuth HTTPS/来源/cookie/重定向/256 KiB/5 秒超时 | mcp-oauth.test.ts：bounded OAuth fetch 两项 |
| 真实 Thread + faux 模型 + QuickJS + SDK、模型不可直调 MCP、快照及脱敏审计 | mcp-tools.test.ts：runs codemode through the real Thread… |
| 本轮发送者变更复核、群内 owner/成员/其他私聊隔离、unsafe 不重发 | mcp-tools.test.ts：rechecks the current sender…、installs no MCP…、does not resend… |
| Streamable HTTP 初始化、分页、静态 secrets、GET 405、DELETE、快照冷恢复、半截目录、空闲关闭 | mcp-tools.test.ts：uses SDK Streamable HTTP…、restores snapshots before network refresh… |
| POST/GET/DELETE 的 401 单次上限、来源与重定向、JSON/SSE 原始流限额 | mcp-transport.test.ts 全部测试 |

在 workers/ 执行：npx.cmd wrangler types、npx.cmd tsc -p tsconfig.json --noEmit、npx.cmd vitest run。类型生成成功，tsc 无错；全量 14 个测试文件、107 项测试通过（含原 58 项）。测试不需要真实外部服务或账号。额外使用 wrangler.test.jsonc 做 deploy --dry-run，QuickJS WASM 和 Worker 成功打包；未部署。

## P1c 简化与 SDK/workerd 差异

- P1c 仅支持 HTTPS、owner 私聊、CIMD；不移植 DCR、群审批、子 agent、定时/唤醒、资源工具或 Docker 的图片解码。配置拒绝这些未实现字段与对应 limits；只保留本期实际使用的限额。文本上限固定 8000 字符。
- 目录只保留每服务当前快照，不实现 Docker 的多版本目录回收账本。所有页成功才原子替换，Pi 自身负责既有调用检查点；没有增加跨业务幂等或 exactly-once 保证。重连没有后台退避计时器，仅下次调用重试连接准备。
- 登录入口采用管理员签发的一次性能力链接，不使用面板会话或 cookie。logout 只做本地退出，不调用远端 revocation endpoint。不存在真实 Notion 登录或远端写入的验证。
- OAuth 网络保留来源限制和响应/时间边界；Workers fetch 不提供 Node 的 DNS/socket lookup 固定能力，因此没有移植 Docker 的 DNS 解析结果绑定。只允许管理员配置的资源 HTTPS 来源与该资源声明的 issuer 来源。
- Streamable HTTP 用 SDK 的 fetch + eventsource-parser，不依赖浏览器 EventSource，也不回退旧 SSE transport。GET 405 是可选流不支持，不能当作初始化失败；关闭时 DELETE 是尽力清理。禁用 SSE 自动恢复。
- Workers 不接受 redirect: "error"，须 manual 并拒绝 3xx；RequestInit 没有 credentials，平台没有 cookie jar，代码显式删 Cookie。用 new Headers 统一 SDK 的 header 输入，Bearer 每次请求从 Registry 取，401 不交给 SDK 自动授权。
- Check 采用解释式校验，避免 Compile/new Function 在部署运行时被禁止。SDK 用 client.request 配合 ListToolsResultSchema/CallToolResultSchema，避免 callTool 的逐页 outputSchema 缓存及默认 Ajv 编译；完整输入输出校验由本模块负责。
- AbortSignal 向 SDK 传播，并设置不随 progress 重置的总超时；OAuth 同时使用 signal 和 Promise.race，防止实现忽略 signal 时永不结算。测试的 DO RPC thenable 在 Vitest rejects 断言前包装为普通 async Promise，避免产生误报的未处理 rejection。
- QuickJS /cloudflare 入口由 Wrangler 默认 CompiledWasm 规则打包，不需要额外 rules；不能在 Worker 内从字节编译 WASM。inline VM 会占用本 DO 线程，计算循环只能由 interruptBudget 限制，Date.now() 在纯计算期间不推进；分离 Worker 的远程沙箱留待后续。
- 生产配置 dry-run 会先构建既有 Magpie 容器，本机无法启动 Docker CLI；本次采用无容器的测试配置验证同一 Worker 入口打包。Vitest 有已安装包改名/缺 sourcemap 提示，以及负向 RPC 测试的固定分类异常输出；最终没有未处理错误。

原 package.json 和 package-lock.json 的依赖增量为任务开始时已有内容，本次保留；未运行 npm install 或 git commit。既有文件保持 UTF-8 无 BOM 与原换行；新增文本为 UTF-8 无 BOM、LF。

以下保留 P0～P1b 文档与历史验证记录。

# Workers P1b

NapCat 的 OneBot v11 Universal 反向 WebSocket 连接 `/onebot`。Bridge DO 单例 `napcat` 负责授权、去重、群名与发送规则；群消息进入 `group:<群号>` 的 Thread DO，owner 私聊仍共用 `owner`，其他允许用户进入 `private:<QQ号>`。Thread 中运行 pi-durable，保存消息与回合，工具调用经同一条反向 WS 回复 QQ。

## P1b 记忆系统

每个 Thread DO 保存自己的记忆命名空间。新增表为 memories、memory_versions、memory_links、memories_fts（FTS5 trigram）和 profile；不创建 proposals、pair_checks 或夜间整理表。记忆正文修改、状态修改与 supersedes 关系使用同一个 SQLite 事务，旧条目的 until 设为取代时间。所有宿主 SQL 都走与 Pi 共享的 DurableObjectSqliteDatabase 队列。

本期按 P1B brief 收紧权限：owner 私聊提供五个 mem_* 工具，只读写 owner；群（包括 owner 在群内的回合）与其他私聊仅提供 mem_search，只查本 DO。工具执行时再次核对当前入站身份，不接受模型传入命名空间，也不通过 subject 路由到其他 DO。工具参数和说明文字复制自 Docker；其中跨会话写入、面板恢复等旧能力描述以本段限制为准，调用不支持的跨会话写入会明确返回错误。

- mem_search：最多 20 条；带 query 时按空白分词且全部命中，更新展示条目的召回统计；不带 query 列出最近更新，commitment 按截止日期排序。输出沿用 #id [kind] (时效) 正文 ← 来源，总量最多 2500 字符。
- mem_remember：规整后的 SHA-256 精确去重；即使新正文重复，合法 supersedes 仍同事务取代旧条目并建链。
- mem_update / mem_forget：只修改本命名空间；更新只允许 active，遗忘只标 forgotten，版本保留。时间参数使用北京时间，空字符串可清空。
- mem_profile：画像最多 4096 UTF-8 字节；未创建时 revision 为 none，保存后为正文 SHA-256 前 16 位。CAS 冲突返回当前 revision 与内容，错误输出也受 2500 字符限制。相同内容的 revision 不变。
- 每轮最多 20 次工具写入尝试，计数持久化；凭据形态的正文、subject、遗忘原因及画像拒绝保存。memory_write / memory_recall 事件只含操作名和计数，不含正文。
- memory section 保留画像全文及未完成承诺前 10 条，按 due_at 升序、无截止的最后。按 brief，画像为空时整个 section 不渲染；承诺仍可检索。文本仅由画像和承诺决定，召回计数或当前时间变化不会触发 Pi 重发。

### 回合后抽取

inbound 和 outbox 新增 turn_id 与索引。Pi 的 run.taskId 在工具续轮会变化，因此使用本轮首条 submission 的 ID 生成稳定业务回合键；同人插话共享该键。send_message 在收到成功回执后，和自发消息历史一起记录 outbox 的 turn_id。全部入站完成结算后，settle 在同一事务中入队并设置 alarm；失败回合不入队。

| 配置 | 行为 |
| --- | --- |
| MEMORY_EXTRACT_MODEL | var，默认空，使用主模型 ID；provider 仍为 MODEL_PROVIDER |
| MEMORY_EXTRACT_NAMESPACES | var，默认 owner；逗号分隔完整命名空间，空字符串关闭全部抽取；可显式开启群或其他私聊的后台抽取 |
| ADMIN_TOKEN | 独立 secret，只保护导入端点；不是 NAPCAT_TOKEN，不能用 query token |

alarm 间隔 5 秒，每次最多处理 3 个回合；队列最多 50 条，超限丢最旧的并记计数事件。extract_receipts 防止重复 settle 或 alarm 重试再次抽取同一回合；extract_daily 按北京时间日期持久计数，每命名空间每天最多 200 次模型调用。只用本回合 inbound 正文和成功 outbox，交错排序；不读 final answer、工具结果或其他回合。正文不足 80 字跳过，单条最多 2000 字，整份材料最多 12000 字；材料关键词召回最多 20 条已有记忆供模型判断冲突。

抽取提示词复制自 Docker。直接调用 pi-ai Models.complete，不创建第二个 Harness，不提供工具；20 秒超时，AbortSignal 与 Promise.race 同时生效。JSON 形状错误整批丢弃；confidence < 0.6、凭据形态及非法日期丢弃；重复只更新召回，合法 supersedes 同事务取代，每轮最多新写 5 条，author=extractor。抽取不会修改画像或发送 QQ。events(at, kind, detail) 的 memory_extract 只保存计数、用量、耗时和固定原因，不保存材料、模型响应或错误正文。

GET /healthz 的 owner thread 增加 memory: { active, profileBytes, extractQueue }；profileBytes 是 UTF-8 字节数，active 是 active 状态条目数。

### 导出与导入

Node >=24，脚本在仓库根目录运行，只读 data/memory.sqlite 和 data/memory/<ns>/profile.md。Docker 实际目录名把冒号换成下划线，例如 group_<群号>；脚本沿用这一约定。输出是单个命名空间的 JSON，不上传。下面是 **Bash** 示例，Node stdout 与重定向文件均为 UTF-8 无 BOM；不要直接套用 Windows PowerShell 5.1 的默认重定向编码。

~~~bash
node workers/scripts/export-memory.mjs owner > memory-owner.json
curl --fail-with-body -X POST "$WORKER_URL/admin/memory/import" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @memory-owner.json
~~~

ADMIN_TOKEN 应通过 Wrangler secret 注入，上例只引用环境变量，没有内置 token。此任务未执行真实导出、上传或 secret 配置。

POST /admin/memory/import 接收 { ns, profile?: { text }, memories: [...] }，成功返回 { inserted, skipped }；401 表示 Bearer 鉴权失败，400 表示格式、命名空间、画像大小或凭据检查不通过。验证整批后路由对应 DO，DO 再复核 ns 与 idFromName 一致。memories 保留 id、状态、时间、召回统计和来源；重算 hash，id 冲突跳过计数。省略的可选列使用表的默认语义。导入事务为新增条目写 import 版本；FTS 由触发器同步。profile 如提供则作为管理员覆盖，revision 按导入内容重算。

### P1b 文件与测试

| 文件 | 职责 |
| --- | --- |
| src/memory/types.ts、schema.ts、store.ts | 条目契约、SQLite schema、索引、版本、关系、CAS 与写入额度 |
| src/memory/contracts.ts、tools.ts、render.ts、time.ts、secrets.ts | 原工具契约、权限复核、文本与 section、北京时间、凭据形态检测 |
| src/memory/extractor.ts、import.ts | 持久队列、直接模型调用、落库过滤与导入校验 |
| src/thread.ts、index.ts、env.ts | DO 装配、回合关联、alarm、管理端点与健康计数 |
| wrangler.jsonc、wrangler.test.jsonc、worker-configuration.d.ts | 同步 vars 与重新生成的类型 |
| scripts/export-memory.mjs | 只读 Node 导出 CLI |
| test/memory*.test.ts、test/export-memory.node.mjs | workerd 集成测试与真实 Node 导出验证 |
| README.md | 配置、迁移用法、测试与限制 |

| 功能 | 对应测试（test/ 下） |
| --- | --- |
| hash 去重、版本、重复赢家 supersedes、事务回滚 | memory.test.ts：deduplicates normalized hashes and atomically versions supersedes including duplicate winners |
| trigram、短词、字面通配符、范围隔离、来源格式 | memory.test.ts：searches trigram, short terms and literal wildcards with namespace isolation and source rendering |
| 更新/删除 FTS、遗忘版本、2500 字符 | memory.test.ts：updates FTS triggers, marks forgotten with versions and bounds output to 2500 characters |
| 画像 CAS 并发冲突、内容 revision、UTF-8 限额与凭据拒绝 | memory.test.ts：uses content revisions and CAS, enforcing UTF-8 byte limits and secret rejection |
| 稳定 section、空画像、未完成承诺排序与前 10 条 | memory.test.ts：keeps memory sections stable and renders only ten unfinished commitments in deadline order |
| 日期与 commitment 参数限制 | memory.test.ts：rejects invalid Beijing dates and non-commitment timing |
| 五工具真实执行、当前回合来源、CAS 返回、section 实际注入且不重复发送、事件不含正文 | memory-tools.test.ts：executes all five tools with source attribution, deduplication, CAS feedback and next-request memory sections |
| 群成员、群内 owner、其他私聊无写工具，读不到 owner 数据 | memory-tools.test.ts：offers only mem_search in $ns and cannot read owner memories（三组参数） |
| 拒绝跨 DO subject 与每轮 20 次写入 | memory-tools.test.ts：rejects cross-DO subject routing and caps tool writes at twenty per turn |
| faux 单次 completion、confidence、去重召回、supersedes、每轮 5 条、来源与只记统计 | memory-extractor.test.ts：calls pi-ai once with faux JSON and applies confidence, duplicate recall, supersedes, five-write cap and sources |
| 每批 3 轮、幂等收据、日额 200、北京时间跨日、积压 50 | memory-extractor.test.ts：processes at most three jobs…；persists the Beijing daily quota… |
| 过短、关闭、非法 JSON、超时晚到、失败不重试、材料预算与注入中和 | memory-extractor.test.ts：skips short or disabled turns…；times out and ignores late model output…；bounds material… |
| 插话与成功发送共享 turn_id、默认 owner 开启、指定抽取模型、排除 final answer | memory-extractor.test.ts：binds steered inputs and acknowledged output to one turn and uses the configured extraction model in alarm |
| DO 驱逐后队列恢复、真实 alarm 每批 3 轮及续约/清理 | memory-extractor.test.ts：keeps queued work across DO eviction and rearms alarms after batches of three |
| 失败回合不入队、默认群关闭与命名空间 var 开启 | memory-extractor.test.ts：does not queue failed turns and only enables other namespaces through the explicit var |
| Bearer 鉴权、缺 secret、拒绝 NapCat/query token、id 去重、健康字节数、跨 DO 隔离、整批校验 | memory-import.test.ts 的 3 项测试 |
| 真实 Node CLI、中文 stdout JSON、画像目录、id/来源、只读原库 | export-memory.node.mjs（node --test 单独运行；workerd 不支持 node:sqlite） |

本期验证在 workers/ 中执行：

~~~text
npx.cmd wrangler types
Types written to worker-configuration.d.ts

npx.cmd tsc -p tsconfig.json --noEmit
退出码 0，无类型错误

npx.cmd vitest run
Test Files  10 passed (10)
Tests       58 passed (58)

node --test test/export-memory.node.mjs
tests 1 / pass 1 / fail 0
~~~

测试只使用合成 QQ ID、测试 token 与 faux 模型，未安装依赖、未联网取包、未提交 Git。原 35 项 P0/P1a 测试全部保留。Wrangler 首次尝试写用户配置目录日志被沙箱拒绝，但类型生成成功；后续设置 WRANGLER_LOG_PATH 到任务临时目录并关闭 metrics。生成文件恢复原 CRLF，其余既有文件保留 UTF-8 无 BOM 与 CRLF；新增文件为 UTF-8 无 BOM、LF。

### P1b 简化与容易踩的坑

- brief 与 Docker 文档的权限表不同，本期采用上述 owner 私聊写、其他会话只读的保守边界；不实现 owner 跨 DO 召回/写入。群或其他私聊的抽取只由管理配置显式开启，不能通过用户工具改变开关。
- 不含夜间整理、画像提议、面板、自动提醒、向量检索或历史清理。保留的版本与链接可供后续功能使用，当前没有恢复工具。队列收据、日计数、工具写次数与事件尚无清理策略。
- 按 brief，空画像时承诺也不进入 section。工具说明保留 Docker 原文中的“下一轮”，pi-durable 实际会在下一次模型请求重新计算 section；同轮工具后续请求也可能看到画像变更。
- P1a 的 outbox 只保存成功回执，所以抽取没有 Docker 的 uncertain、附件与主动目标材料；引用仅保留入站正文中的标记，不额外回查引用原文。
- 抽取先领取回合并保存收据，再调用模型。模型失败不重试；进程在领取后、落库前中断会放弃这一轮，未领取队列仍由预设 alarm 唤醒。这一取舍避免平台重试导致重复模型调用与重复费用。
- Pi 的工具续轮会换 run.taskId；稳定 turn_id 必须用首个输入，而不是最新输入或当前 generation task。FTS trigram 的短词不能直接 MATCH；这里沿用 Docker 的 FTS LIKE 路径，并对 %、_、反斜杠做字面转义。
- 管理员导入会覆盖所提供的画像，不走用户 CAS；相同 id 不覆盖已有记忆。接口只导入当前条目与画像，原 Docker 的版本历史和 links 不在 body 契约内。保留 id 仅保证来源引用不重新编号，不能恢复未导入的关系历史。
- Node 导出跨 SQLite 与画像文件没有联合快照，迁移时应停掉源端写入后导出。导出器只输出文件，不会自行上传。
- workerd 限制跨 DO 使用 WebSocket 等 I/O 对象；测试回执必须在创建 socket 的上下文发出。负向发送 RPC 测试仍有预期 exception 输出，Vitest 没有未处理错误。测试包的改名提示不影响本期已安装版本。

以下保留 P0/P1a 基础配置、行为及历史验证记录。

## 配置与行为

| 配置 | 类型与用途 |
| --- | --- |
| `NAPCAT_TOKEN` | secret；未设置时 `/onebot` 返回 401，支持 Bearer / query token |
| `QQ_OWNER` | secret，逗号分隔；owner 在任何会话可通过授权检查，群内仍需真实 @ |
| `QQ_ALLOW_USERS` | 可选 secret，逗号分隔；允许私聊，沿用原策略也允许这些用户在其他群真实 @ 后触发 |
| `QQ_ALLOW_GROUPS` | 可选 secret，逗号分隔；允许群内所有成员的消息入库，真实 @ 机器人时才触发 |
| `QQ_GROUP_MENTIONS` | var，默认 `true`；设为 `false` 时群消息仍入库，但不启动回合，包括 owner |
| `MODEL_PROVIDER` / `MODEL_ID` | 默认模型（`deepseek` / `openai-codex` 及对应 id，测试为 faux）；运行时以面板保存的设置为准，见“模型与 ChatGPT 登录” |
| `DEEPSEEK_API_KEY` | secret，DeepSeek 直连；ChatGPT 订阅在面板登录，不用 secret |
| `CODEX_SEARCH_MODEL` | var，默认空；代其他模型联网搜索与生成图片的 Codex 模型 id，空则按目录挑最便宜的 |
| `CS_AGENT_COMMIT` | 健康检查中的构建标识 |

QQ 列表默认空；非法 ID 被忽略，不支持通配符。文件上传等 notice / 系统事件不作为聊天输入；字符串形式的 CQ 码不解析，文本 `@昵称`、引用和 `@全体成员` 均不能冒充真实 `at` 机器人。正文保留 `[@你]`、`[reply]`、`[image]` 等标记，引用 ID 单独落库，昵称和群名折成单行。

`scripts/put-secrets.sh` 从 `.env` 增加读取两个可选白名单。缺项或空值跳过，不影响原有七个必需 secrets。**跳过不等于删除已部署的 secret**，清空现有线上配置需另行显式删除。此次没有执行真实 secrets 上传。

## 数据与回合

- Bridge 的 SQLite：`seen` 保存 `self_id:type:group:user:message_id`，最近 5000 条；`threads` 记录已见会话。相同平台消息 ID 在不同发送者或会话中不会共用入站键。
- 群名通过 `get_group_info` 获取，成功结果持久缓存 6 小时；失败保留旧名并负缓存 1 分钟。群消息按会话依次入库和提交，查名不会挡住 WS 回执。
- Thread 的 `messages` 保留 `UNIQUE(scope, message_id)`；`messages_fts` 使用 FTS5 trigram 与 INSERT / UPDATE / DELETE 三个同步触发器；`scope_names` 保存群名。非触发消息也入库。发送成功后的 outbox 回执与 `is_self=1` 消息在同一事务提交。
- `qq_context({ query?, limit?, before? })` 只读本回合的 scope。默认最近 20 条，最多 50 条；`before` 为严格小于的 Unix 秒时间戳。三字以上走字面短语 FTS；一、两字走转义后的 LIKE。最近记录旧到新，搜索结果新到旧；北京时间、昵称(QQ号)、正文按紧凑格式输出，总量至多 2500 字符。
- owner 多个账号共用 Harness，但召回工具仍限定当前私聊账号的 scope。其他群或私聊的历史不提供跨 DO 查询入口。
- 身份提示与工具目标均经 `LiveDoc.run.inputs → submission.requestId → inbound` 查找，避免用最新入站消息误绑定当前回合。系统提示包含 owner / 群成员 / 私聊用户、昵称、会话名称与 ID，以及发送约束和不可信内容规则。
- 群回复固定回本群，发送 `at` 段和文本段；私聊固定回输入账号。模型不能传入其他目标。
- 忙时同一 QQ 发送者使用 `whenBusy: "steer"`；不同发送者使用 `followUp`。已有其他成员排队时，后来消息也排队，保证到达顺序。宿主只串行接纳，不等待前一回合结束后才接纳。
- P0 表通过增列迁移，保留旧 `message_id` / requestId；新行使用复合入站键，并用 `platform_message_id` 保留 QQ 消息 ID。冷启动按行顺序幂等重投 queued 输入。

## 发送规则与健康检查

| 规则 | 行为 |
| --- | --- |
| 每会话每分钟 6 条 | 第 7 条拒绝，工具结果包含“发送过快” |
| 每会话每小时 60 条 | 超出后熔断该会话 60 分钟 |
| 全局每分钟 30 条 | 超出后熔断全部会话 10 分钟 |
| 单条 1～4000 字符 | 超长或空消息拒绝，不截断 |

`send_log(scope, at)` 与 `send_breakers(scope, until, tripped_at, reason)` 都在 Bridge SQLite。检查与占用额度在同步事务里完成，被拒消息不计数；已接纳发送即计数，即使随后回执失败或超时。限额使用实际 `group:` / `private:` 目标，不把多个 owner 私聊账号合成一个发送目标。熔断到期后从新窗口计数，保留过期熔断行作为窗口边界。

`GET /healthz` 保留 `bridge`、`model`、owner 的 `thread` 计数，新增顶层 `threads`（最近见过的会话键，最多 50 条）和 `sendRules`（当前熔断数组）。模型不可用仍返回 HTTP 503；熔断本身不改变 HTTP 状态。

## 文件变更

| 文件 | 改动 |
| --- | --- |
| `src/policy.ts`（新增） | 参数化移植消息规范化、允许与触发规则、目标及入站键 |
| `src/send-rules.ts`（新增） | Bridge SQLite 的限速、熔断与过期窗口 |
| `src/context.ts`（新增） | 消息 schema、入库、FTS/LIKE 召回、紧凑格式 |
| `src/prompt.ts`（新增） | 发送、安全与本回合身份提示 |
| `src/bridge.ts`、`src/onebot.ts` | 群路由、所有允许消息入库、去重、查名、通用 echo API、群发送 |
| `src/thread.ts` | P0 增列迁移、回合绑定、消息库、召回工具、steer / followUp |
| `src/env.ts`、`src/index.ts` | 环境类型、健康检查新增字段 |
| `scripts/put-secrets.sh` | 两个可选白名单 secrets |
| `wrangler.jsonc`、`wrangler.test.jsonc` | 同步增加 `QQ_GROUP_MENTIONS` var；未新增 DO 或迁移类 |
| `worker-configuration.d.ts` | 按生产 Wrangler 配置重新生成类型 |
| `vitest.config.ts`、`test/worker.test.ts` | 合成白名单绑定及 P0 回归测试适配 |
| `test/helpers.ts`（新增） | 合成 OneBot 事件和反向 WS 测试工具 |
| `test/policy.test.ts`、`test/groups.test.ts`、`test/context.test.ts`、`test/send-rules.test.ts`（新增） | P1a 的 workerd / SQLite / faux 集成测试 |
| `README.md` | 本说明与测试对照 |

## 验证与用例对照

命令全部在 `workers/` 执行，Windows 使用 `.cmd` shim：

```text
npx.cmd wrangler types
Types written to worker-configuration.d.ts

npx.cmd tsc -p tsconfig.json --noEmit
退出码 0，无类型错误

npx.cmd vitest run
Test Files  6 passed (6)
Tests       35 passed (35)
```

| 功能 | 用例（test/ 下） |
| --- | --- |
| 规范化、引用、图片、名称清洗 | `policy.test.ts`：`renders at, reply and image segments and sanitizes display names` |
| 真实 @、owner / allowUsers / groupMentions | `policy.test.ts`：`requires a genuine bot at segment and honors groupMentions`、`ports owner and allowUsers exemptions and routes owners to one private thread` |
| 非法帧、文件等系统事件 | `policy.test.ts`：`ignores system events and malformed IDs without interpreting string CQ messages`；`worker.test.ts` 的非法帧回归 |
| 群消息无 @ 只入库 | `groups.test.ts`：`ingests allowed group chatter without starting Pi and persists the cached group name` |
| 群 @ 回复、机器人入库、身份安全提示、驱逐后去重 | `groups.test.ts`：`replies to a real group mention with at, records self history, and deduplicates across eviction` |
| 不允许群忽略、allowUsers 私聊 | `groups.test.ts`：`ignores disallowed groups and admits allowUsers private messages` |
| 群名 TTL | `groups.test.ts`：`refreshes group names only after the six-hour cache expires` |
| 多人排队和正确收件人 | `groups.test.ts`：`queues different senders in arrival order and keeps each turn identity and at target`；`worker.test.ts` 的 queued 收件人回归 |
| 同人插话 | `groups.test.ts`：`submits same-sender followups with steer while the current tool is waiting`，验证两条输入由同一个最终 answer 结算 |
| 插话不越过已排队的成员 | `groups.test.ts`：`does not let a same-sender followup overtake an already queued member` |
| 去重 5000 / health threads 50 上限 | `groups.test.ts`：`bounds bridge deduplication to 5000 and health thread listings to 50` |
| 分钟限速与长度 | `send-rules.test.ts`：`accepts six concurrent sends and rejects the seventh without counting it`、`rejects 4001 characters before sending and permits exactly 4000` |
| 小时熔断、持久化、health sendRules、到期恢复 | `send-rules.test.ts`：`persists the hourly breaker, exposes it in healthz and resets the expired window` |
| 全局熔断 | `send-rules.test.ts`：`trips the global minute breaker across scopes and blocks other chats for ten minutes` |
| trigram、两字 LIKE、时间边界、scope 隔离、消息唯一性 | `context.test.ts`：`searches trigram and two-character Chinese terms with before and scope isolation` |
| FTS 更新/删除与 50 条上限 | `context.test.ts`：`maintains FTS triggers on update/delete and caps recall to fifty messages` |
| 实际 qq_context 工具和 owner 身份 | `context.test.ts`：`executes the read-only qq_context tool inside Pi with current-turn scope and owner identity` |
| 拒绝原因确实返回模型，失败不写回执或机器人历史 | `context.test.ts`：`returns send-rule rejections to the model without self history or outbox receipts` |
| P0 表升级 | `context.test.ts`：`migrates the P0 inbound table without losing request IDs or replaying completed inputs` |
| 鉴权、断线、重连、echo 失败、实际 15 秒超时 | `worker.test.ts` 中原有 9 项回归 |
| provider 与目录失败 | `models.test.ts` 中原有 5 项回归 |

secrets 脚本另做离线 Bash 检查：`bash -n` 通过；在任务临时目录中用替身 `npx` 截获 stdin，验证 `missing` / `empty` 两种夹具都只包含原七项，`filled` 包含九项及两个合成白名单。没有读取真实 `.env`、调用真实 secret 上传或连接 NapCat。

当前工作树原本没有 `node_modules`，离线复制主工作区的现成依赖后运行测试，没有 npm install、网络取包、修改锁文件或提交 Git。原有 UTF-8、无 BOM 文件保留其换行：工作树多数文件为 CRLF，shell 脚本为 LF；新文件使用 UTF-8 无 BOM、LF。

## P1a 简化与注意事项

- 不含跨会话召回、媒体下载/上传、摘要、历史清理、记忆、审批、子 agent、定时任务或可靠 outbox 重发。`SEND_RULE` 移植了可见回复、去重与长度约束，删除了未实现的附件和子 agent 能力描述；`PI_SAFETY_RULE` 保留原文。
- 只按同一个 QQ ID 判定插话身份；owner 多账号共用 Thread，但不同账号仍各排一轮。每次群工具发送都带 @，尚未实现“一轮只在第一条 @”。
- 历史工具只读 scope；owner 共用 Harness 的既有模型上下文仍然共享，这不是账号之间的完整安全隔离。
- Bridge 的 echo 等待和投递 Promise 仍在内存。API 有 15 秒上限，finally 清理计时器；等待时保持活动，空闲后可休眠。群名查询失败不会丢弃聊天。进程在 Bridge 去重落盘后、Thread 接纳前中断仍有投递窗口，P1a 没有持久化 Bridge 发件队列。
- 出站确认超时、断线或缺少消息 ID 时结果不确定，`replay: "unsafe"` 防止自动重复发送；outbox 只记确认成功。`inbound.done` 代表回合正常结束，不能等同于 QQ 发送成功。
- Thread 宿主 SQL 必须经过 `DurableObjectSqliteDatabase` 共享队列；事务内用回调的 `tx`，不能再调用外层 database。Bridge 没有 Pi，可使用原生同步 SQLite 事务；拒绝时返回原因后再抛错，避免把刚写入的熔断回滚。
- 当前 pi-durable README 把提交调度放在 `Busy Conversations`；API 实际选项是 `steer` / `followUp`，没有 `queue`。结算后的 submission 不保留 mode，插话验证应检查共享 answer 或在途 inbox。
- `harness.submission` 是异步接口；身份不能用“最近 queued 行”。工具必须返回 `output` 才能让模型看到召回内容与拒绝原因。FTS trigram 对一、两字没有 token，必须回退 LIKE。
- vitest-pool-workers 0.23 需要 `cloudflareTest`；配置继续使用已安装 Wrangler 的 workerd，以匹配部署的兼容日期。负向 RPC 测试会输出预期 workerd exception，Vitest 没有未处理错误；包改名提示也不影响通过。
- Wrangler 生成类型以生产配置为准，会重写文件换行；生成后恢复原 CRLF。`Env` 放宽 var 的字面量类型，测试才能覆盖 faux 等配置。

按任务要求未做本地真实 NapCat 冒烟，也未改 workers/ 之外的项目文件。
