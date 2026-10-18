# cs_agent 部署手册

单容器：QQ（NapCat）→ 规则分流 →（`奶龙:` 前缀）ComfyUI 生图，或（其他消息）执行 agent（默认容器内 codex）→ 回到原 QQ 会话。设计见 `docs/ARCHITECTURE.md`。

## 0. 使用方式（v3）

- **生图**：消息以 `奶龙:` 或 `奶龙：`（半角/全角冒号均可，`IMAGE_PREFIXES` 可改）开头，前缀后先解析空格分隔的内联选项，其余文字原样作为提示词，例如 `奶龙: 一只戴墨镜的柴犬，赛博朋克风`。群里照常 @机器人 后再写。前缀后为空时回复"奶龙: 后面写要画的内容"。成功回复"图片生成好了"+图；失败按类别回复：服务不可用 / 超时 / 内容被拒 / 其他。不经过任何模型。
- **其他消息**：整条交给执行 agent（`AGENT_BACKEND`，默认 codex）。codex 可以联网搜索、检索聊天记录，也可以通过 `image_gen` 工具自己出图（例如"查一下今年 Major 冠军队的队标然后画一张海报"），图片随回复一起发出。追问改图（"把刚才那张改成蓝色"）也走这里：请把要编辑的图片附在本条消息里；历史记录仅有 `[image]` 占位，不能作为旧图文件来源。
- **顺序**：同一个群/私聊里严格按消息顺序逐条回复；不同会话并行（总数 ≤ `AGENT_CONCURRENCY`）。


### 生图 v2 参数与参考图

内联选项放在提示词之前，空格分隔、顺序任意；同类重复时最后一个生效，遇到第一个未知词后全部保留为提示词。

| 选项 | 含义 |
|---|---|
| `16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 1:1` | 宽高比，默认 1:1 |
| `横 / 竖 / 方` | 16:9 / 9:16 / 1:1 的别名 |
| `2mp / 2k` | 尺寸档位，默认 1mp；2k 方图是 2048×2048 |
| `x2 / x3 / x4` | 张数，默认 1 |
| `透明` | 生成带 alpha 的 PNG |

例：`奶龙: 横 2k 一只在雪地里的橘猫`；`奶龙: 透明 x2 一只猫的贴纸`。附图编辑例：附上原图，再写 `奶龙: 把杯子改为红色，保留猫的姿态和背景`。图中文字加引号并说明位置、字体，不需要 SD 式咒语。

只下载已授权且触发机器人的本条消息图片，最多 3 张、每张 10 MiB，并检查 PNG/JPEG/WebP/GIF 魔数。优先使用 OneBot array 图片段的 HTTP(S) `data.url`；缺失或失效时用 `data.file` 调 `get_image` 获取新 URL；不读 NapCat 返回的宿主机路径。校验或下载失败时明确报错；发送者超额及截止时间耗尽按 skipped 无图继续。正常 URL 字段见 [NapCat 图片段实现](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/api/msg.ts)，URL 过期刷新见 [文件文档](https://napneko.github.io/develop/file)。本次只用假 OneBot 验证，未调用真实 QQ；本机是否关闭图片 URL 上报仍需实际部署后确认。

编辑遵循官方模板：编码器的 LATENT 接采样器，因此输出比例取首张参考图；size 控制像素预算，aspect 不会强行裁切参考图。前缀自动附上本票据全部图片；codex 可从 `IMAGE_REFS` 中选择，最多 3 张。图片原始 URL 不存入聊天历史，下载文件保留在 `DATA_DIR/incoming/<ticket>/`，目录超过 7 天由每日衰老任务清理（按目录 mtime，不跟随软链接）。

**透明输出的设计偏差**：按用户后续决定，使用 Qwen 2.1 原生 RGBA：`KSampler → VAEDecode → SaveImageAdvanced(png, 8-bit, sRGB)`，沿用 `qwen_image_2.1_vae_bf16.safetensors`。没有采用设计 §4.9 的 `EmptyQwenImageLayeredLatentImage`：它为另一套 layered 模型创建 5D、16 通道 latent，而 2.1 使用 4D、64 通道，维度/通道不匹配。本机已有所需模型，不需要额外 RGBA VAE，也没有下载任何模型。启动自检在 healthz 的 comfy.transparent 中报告可用性；依赖缺失时返回 `透明输出未启用：缺少 <文件名>`，提交透明请求时再次检查。

升级时若原环境已设置 `COMFY_WORKFLOW_FILE`，它仍是自定义覆盖。要启用上述参数化图，需由运维清空该值后部署；本次没有更改现用 .env 或重启运行容器。自定义图仅替换 prompt、seed，并为恢复对账更新保存节点前缀；其他尺寸、参考图、透明等行为由该图自行定义。

## 1. 宿主机前置条件

1. **Docker Desktop**（Windows），能使用 `host.docker.internal`。
2. **NapCat** 保持现状：`agent-http` 127.0.0.1:3000、`agent-ws` 127.0.0.1:3001，使用 Bearer token，`messagePostFormat: array`。Docker Desktop 下容器经 `host.docker.internal` 可以直接访问宿主机 loopback 端口，无需改绑定。`.env` 里的 `NAPCAT_TOKEN` 取自 `D:\Tools\NapCat\config\onebot11_1670528780.json` 中 `agent-http` 条目的 token。
3. **ComfyUI** 用 `D:\Tools\ComfyLocal\start.ps1` 启动（127.0.0.1:8188），不需要改监听地址。
4. **Codex 凭据**：在仓库根目录运行
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\init-auth.ps1
   ```
   它会把 `~/.codex/auth.json`（`auth_mode=chatgpt`）复制到 `./data/codex/auth.json`。容器内的 codex 和 agent 的意图模型（`openai-codex` provider）共用这一份。脚本不会打印 token。
   也可以不复制，改为在容器里登录：`docker compose run --rm cs-agent codex login --device-auth`（`CODEX_HOME=/data/codex`）。
   入口脚本带参数时，会先准备目录和 `config.toml`，再 `exec` 这个命令；不带参数时才启动 agent。其他一次性命令同理，例如 `docker compose run --rm cs-agent codex --version`。

> 刷新冲突：refresh_token 会轮换。容器（agent / 容器内 codex）刷新后会写回 `./data/codex/auth.json`，宿主机那份 `~/.codex/auth.json` 可能随之失效，反过来也一样。容器内的 agent 每次读写都重新读取文件，只在 token 快过期时刷新；刷新完成、写回之前会再读一次文件，如果其中的 `refresh_token` 已经变了（说明容器内 codex 在此期间刷新过），agent 采用文件里的新 token，丢弃自己的刷新结果，不覆盖。这样能避免绝大多数互相覆盖，但"再读一次"和写回之间仍有极短的窗口，两者不共享文件锁，不能做到绝对互斥；万一出现鉴权失败，重新运行 `scripts/init-auth.ps1` 或在容器内 `codex login --device-auth` 即可。宿主机 codex 失效时重新 `codex login` 即可。

## 2. 配置

```powershell
Copy-Item .env.example .env
# 编辑 .env：至少填写 NAPCAT_TOKEN、DEEPSEEK_API_KEY（或 DEEPSEEK_APIKEY），确认 QQ_ALLOW_USERS / QQ_ALLOW_GROUPS
```

关键变量（完整列表见 `.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `IMAGE_PREFIXES` | `奶龙:,奶龙：` | 生图前缀，逗号分隔，逐字匹配（大小写与全/半角按原样），较长的优先；留空用默认 |
| `AGENT_BACKEND` | `codex` | 执行 agent 后端：`codex`（容器内 codex 固定线程）或 `pi`（进程内 pi-durable 长期会话，工具可联网检索、查历史、生图） |
| `AGENT_BACKEND_OVERRIDES` | 空 | 按会话覆盖后端：`group:200000001=pi,private:10000001=codex`。格式错误时启动失败。切换只影响之后的消息，两个后端的记忆互相独立 |
| `CODEX_REPLY_MODE` | `relay` | codex 回复的后处理：`relay` 先用意图模型（下一行）把回答整理成 QQ 纯文本（20 s 超时，失败回退），再做代码清洗；`direct` 只做代码清洗（去代码围栏、标题符号、表格竖线，`@` 换成全角 `＠`，截断到 4000 字） |
| `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID` | `deepseek` / `deepseek-flash` | 执行模型：用于 pi 后端、codex 回复的 relay 整理与聊天记录日/周摘要（DeepSeek OpenAI 兼容接口 `https://api.deepseek.com`）。也可切换到 `openai-codex`（复用 `auth.json` 的 ChatGPT OAuth，如 `gpt-6-luna`）、`openai`、`anthropic` 等，后两者需设置对应的 `*_API_KEY` |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek API key；写作 `DEEPSEEK_APIKEY` 也可（启动时自动映射）。provider 为 `deepseek` 时缺少密钥，agent 启动即退出 |
| `AGENT_THINKING_LEVEL` | `low` | 意图模型思考档位。deepseek-flash 支持 off/low/high/max，其他值就近调整（如 medium → high）并记 warn 日志 |
| `AGENT_CONCURRENCY` | 2 | 同时处理的 QQ 消息数，多出来的排队（排队状态已持久化） |
| `COMFY_MODE` | `mcp` | 两种模式共用参数化 Qwen 工作流；mcp 写临时 JSON 后调用 run_workflow，http 直接 POST /prompt |
| `COMFY_WORKFLOW_FILE` / `COMFY_PROMPT_NODE` | 空 / `4` | 可选自定义 API 图覆盖；留空使用生成器，旧部署显式配置不会自动清除 |
| `COMFY_CHECKPOINT` | 空 | 旧接口兼容项，内置 Qwen 生成器不使用 |
| `COMFY_QWEN_CACHE` | `false` | `true` 时在 UNETLoader 后插入 QwenImage21Cache，需本机安装对应节点 |
| `CODEX_SANDBOX` | `workspace-write` | 如果容器内 codex 报 sandbox/landlock 错误，改为 `danger-full-access`（这时容器本身就是沙箱） |
| `CODEX_TIMEOUT_SEC` / `COMFY_TIMEOUT_SEC` | 600 / 300 | codex 单轮超时；生图收取预算按 1mp/2mp/2k 分别为 120/240/600 秒 × count，上限 COMFY_TIMEOUT_SEC；默认额外收取 2 次，始终使用原 prompt_id |
| `IMAGE_GEN_MCP_WAIT_SEC` / `IMAGE_COLLECT_EXTENSIONS` | 90 / 2 | MCP 最多等待参数预算与前者的较小值；超时交给 agent 的 lateImages 阶段，后者控制两条生图路径的额外收取窗口数 |
| `CODEX_MODEL` / `CODEX_REASONING_EFFORT` | `gpt-6.1-sol` / `high` | 写入受管的 `./data/codex/config.toml`（见第 4 节）。`CODEX_REASONING_EFFORT`（`low/medium/high/xhigh/max`）固定使用，每轮也以 `-c model_reasoning_effort="…"` 显式传入（日志 `codex backend done` 的 `effort` 字段）；v3 不再按请求选择 |

> codex 子进程只拿到最小环境变量：`PATH`、`HOME`、`LANG`/`LC_ALL`、`TERM`、`CODEX_HOME`、`NO_COLOR=1`，以及设置了的 `HTTP(S)_PROXY`/`NO_PROXY`。`NAPCAT_TOKEN`、`*_API_KEY` 等配置不会传给 codex。

## 3. 启动

```powershell
docker compose up -d --build
docker compose logs -f            # 一行一个 JSON 的结构化日志（不含 token）
docker compose ps                 # HEALTH 列
docker compose exec cs-agent node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)"
```

Compose 将容器 HTTP 监听设为 0.0.0.0:8787，宿主机仅发布 127.0.0.1:8787；本地直接运行仍默认监听 127.0.0.1。`/healthz` 的 JSON 和状态码不变，返回：
- `ws_connected`：NapCat WS 是否在线（离线时 HTTP 503，容器显示 unhealthy）
- `comfy`：启动时 comfy 的自检结果（mcp：`server_info`；http：`/system_stats`）
- `codex`：`auth.json` 是否存在，以及当前固定会话 id
- `pi.threads`：`{count, keys: [...]}`，仅显示启用的会话数量和键，不返回 id 或聊天内容

> comfy-cli 1.22 在 local 模式下拒绝从非 loopback 主机获取 `/object_info`（SSRF 防护），所以 mcp 模式下 agent 会在容器内的 `127.0.0.1:${COMFY_LOOPBACK_PORT:-8188}` 启动一个 TCP 转发，指向 `COMFYUI_URL`，再把 comfy-mcp 指向这个 loopback 地址。日志中出现 `comfy loopback proxy listening` 即表示转发已启动。

## 4. 数据卷

| 路径 | 内容 |
|---|---|
| `./data/pi.sqlite` / `./data/pi-threads.json` | pi 长期会话按 `owner`（owner 私聊）或 `group:<id>` / `private:<id>` 隔离；JSON 是 SQLite 映射的原子写出镜像。旧 owner 保留，旧 shared 停用且仅记录一次日志，绝不复用混合历史。同键串行、不同键并行，受 AGENT_CONCURRENCY 限制 |
| `./data/agent.sqlite` | pi-durable 会话、任务和派发索引（崩溃后自动续跑） |
| `./data/codex/` | `CODEX_HOME`：`auth.json`、`config.toml`、sessions。**`config.toml` 是受管文件**：入口脚本每次启动都按 `CODEX_MODEL` / `CODEX_REASONING_EFFORT` / `CODEX_WEB_SEARCH` / `CODEX_WEB_SEARCH_CONTEXT` / `CODEX_BROWSER` / `CODEX_MCP_APPROVAL_MODE` / `QQ_CONTEXT_MAX_CHARS` 重写（含 `web_search`、`[mcp_servers.qq_context]`、可选 `[mcp_servers.browser]`），手工修改会被覆盖；要改请改 `.env` 后重启 |
| `./data/qq-messages.sqlite`（+ `-wal` / `-shm`） | 统一上下文消息库：允许范围内的全部 QQ 消息（含不触发的群消息）、机器人回复行（动作、生图提示词、codex 推理强度、状态）、日/周摘要。**按聊天记录保管**。撤回的消息会删除原始行 |
| `./data/prompts/system.md` | **已弃用**：v2 意图模型的系统提示。v3 规则分流不经模型，不再读取它；文件保留不删，存在时启动日志记一行 `system.md is deprecated and no longer used` |
| `./data/codex-threads.json` | 两条固定 codex 线程：`{"owner": {thread_id, created_at, updated_at}, "shared": {…}}`。owner 私聊（`QQ_OWNER`）用 `owner`，所有群和其他私聊共用 `shared`；删掉某个键（或整个文件），对应线程下一条请求就新建。旧版的单线程 `codex-session.json` 在新文件不存在时自动迁移为 `owner`（日志 `codex thread migrated`），旧文件改名为 `codex-session.json.migrated` |
| `./data/incoming/<ticket>/` | 本票据参考图（≤3×10 MiB），票据 source_images 保存绝对路径供恢复；7 天清理，对 codex 命令沙箱禁读、不可写 |
| `./data/prompts/agent.md` | 启动时只播种缺失的模板，包含生图参数与提示词指引；pi 每次模型请求热加载，保留不跨会话转述私人内容的规则 |
| `./data/prompts/codex.md` | codex 自定义系统提示（`${DATA_DIR}/prompts/codex.md`）：首次启动创建默认回复规则、聊天记录工具纪律、联网与浏览器、生图提示词指引；已有文件不覆盖。面板保存校验 revision、拒绝空白与超过 64 KB 的内容；当前文件或提交内容命中已注册秘密／凭据样式时拒绝保存。保存后立即原子重写全局 AGENTS.md，下一次 codex 调用生效，无需重启容器 |
| `./data/images/<ticket>/` | 生成的图片。pi / image_gen 每次生图写独立 `call-<n>/`；pending-jobs.json 在提交前记录意图、提交后记录 prompt_id，image-files.json 逐张记录下载状态。重启只收取/对账，不重提；坏 marker 隔离为 .bad-<时间戳>，回复保留正文并提示附件失败。未确认远端完成时保留参考图清理清单 |
| `./data/tickets/<ticket>/` | 票据工作目录：codex 回合的最后一条消息 `codex-last.txt`（崩溃恢复时据此不重复询问 codex）。reply 与派发终态对账均幂等清理；发送后、清理前崩溃会在恢复时补删，图片目录不动。入口脚本启动时创建。对 codex 命令沙箱禁读、不可设为可写目录 |
| `./data/*`（QQBridge） | 票据与去重 SQLite |
| `./data/codex/AGENTS.md` | codex 的全局规则，**受管生成文件**：安全规则、实际生效的可写目录、参考图范围、图片自动附带与异步返回纪律组成受管段，再以两个换行拼接 `prompts/codex.md`。保留版本标记 `<!-- cs-agent-agents-template v5 -->`；main 启动和 store 保存时生成，日志 `wrote codex global AGENTS.md`。codex 执行的命令改不了它；编辑行为指引请通过面板修改 `codex.md`，不要手改生成文件 |
| `./workspace/` | codex 工作目录（可写）。没有 `AGENTS.md` 时写入一份占位说明（“规则见全局 AGENTS.md；本目录是你的工作区”）。与旧版 v1 / v2 模板**全文相同**（忽略 CRLF）的文件会替换为占位说明（日志 `replaced old workspace AGENTS.md template with a stub`）；带旧模板标记但被改过的文件保持不动，并记 warn `workspace AGENTS.md is a modified old cs-agent template`。codex 会同时读取全局与工作区的 `AGENTS.md`（全局在前）；工作区这份 codex 自己能改，所以规则不放这里 |

面板保存 codex 自定义提示后，`CodexPromptStore` 立即重新生成 `$CODEX_HOME/AGENTS.md`，并通知订阅者记录变更。runner 每轮启动独立的 `codex exec` 或 `codex exec resume` 进程，本服务不缓存 AGENTS.md；新提示从下一次调用起生效，正在进行的回合保持其已加载内容。直接在磁盘编辑 `codex.md` 后，需要调用 store 的 `regenerate()` 或在下次服务启动时生成；没有后台文件监听。自定义文件使用 UTF-8，保存保留原 BOM 和换行风格。

### 聊天记录（统一上下文）

- **入库**：QQBridge 把允许群的全部消息、允许用户的私聊写入 `qq-messages.sqlite`；收到触发消息时写入一行 `[我] → 处理中`，回复后更新为 `生图 prompt=… → 已发送 N 张图` / `codex(high) → "摘要"` / `失败`。
- **衰老任务**：每天 `HISTORY_SUMMARY_HOUR`（默认 3）点运行，时间按**容器本地时区**——默认 UTC，即北京时间 11 点；想按北京时间 3 点运行，在 `docker-compose.yml` 的 `environment` 加 `TZ: Asia/Shanghai`（同时影响聊天记录里显示的 HH:MM）。任务内容：前一天（及更早未处理的日子）≥5 条消息的会话用意图模型生成 ≤400 字日摘要；已结束的自然周（周一起）的日摘要合并为周摘要；原始消息超过 `HISTORY_RAW_DAYS`（30）且所在日已被日/周摘要覆盖时删除——摘要失败的日子保留原始消息、下次重试，未被覆盖的（摘要一直失败或当天不足 5 条）最多保留 `HISTORY_RAW_HARD_MAX_DAYS`（90）天；摘要超过 `HISTORY_SUMMARY_DAYS`（180）删除。上次运行早于 24 小时时，启动后立即补跑。日志：`history aging done`（含 day_summaries / week_summaries / failed / purged_*）。模型失败只计数跳过，下次再试，不影响主流程。
- **codex 检索**：codex 通过 stdio MCP `qq_context`（`node /app/dist/mcp/qq-context.js`，只读连接）调用 `qq_recent` / `qq_search` / `qq_message`。访问范围由 cs-agent 每轮以 `-c mcp_servers.qq_context.env.QQ_ACCESS=…` 注入：群聊只见本群，owner（`QQ_OWNER`，默认 `QQ_ALLOW_USERS` 第一项）私聊可见全部，其他私聊只见本人。返回文本单条 ≤120 字、总量 ≤`QQ_CONTEXT_MAX_CHARS`（2500）。
- **查看消息库**（容器内有 node，无需 sqlite3）：

```powershell
docker compose exec cs-agent node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/qq-messages.sqlite',{readOnly:true});console.table(d.prepare('select scope,message_id,datetime(time,\'unixepoch\') t,nickname,substr(text,1,40) text,action,status from messages order by time desc limit 20').all());console.table(d.prepare('select scope,level,date(period_start,\'unixepoch\') start,msg_count,substr(text,1,60) text from summaries order by period_end desc limit 10').all())"
# 以 codex 的视角试跑 MCP 工具（列出工具；QQ_ACCESS 换成要模拟的范围）
docker compose exec -e QQ_ACCESS=group:200000001 cs-agent sh -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"cli\",\"version\":\"1\"}}}" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"qq_recent\",\"arguments\":{\"limit\":10}}}" | node /app/dist/mcp/qq-context.js'
```

- **清空**：停容器后删除 `./data/qq-messages.sqlite*`，启动时会重建空库。

### codex 联网与浏览器

- `web_search = "live"`（`CODEX_WEB_SEARCH=live|cached|disabled`），`[tools.web_search] context_size = "low"`（`CODEX_WEB_SEARCH_CONTEXT`）限制搜索结果注入量。
- `CODEX_BROWSER=playwright`（默认）时注册 `[mcp_servers.browser]`：镜像内全局安装的 `@playwright/mcp`（`/usr/local/bin/playwright-mcp --headless --isolated --browser chromium --blocked-origins "<阻止列表>" --sandbox`），Chromium 位于 `/opt/pw-browsers`（`PLAYWRIGHT_BROWSERS_PATH`）。每次会话临时 profile，无任何宿主机登录态。阻止列表覆盖 `localhost`、`*.localhost`、`host.docker.internal`、`*.docker.internal`、`*.internal`、`127.*`、`10.*`、`172.16–31.*`、`192.168.*`、`169.254.*`、`0.0.0.0`、`[::1]`、`[::]`、`[fc*`/`[fd*`/`[fe80*`/`[::ffff*`（含任意端口）。Chromium 沙箱：Playwright 默认以 `--no-sandbox` 启动 Chromium，入口脚本显式加 `--sandbox` 开启。实测（node 用户）在 compose 的自定义 seccomp profile `docker/seccomp-codex.json`（以及 unconfined）下可以启动；默认 seccomp 下报 `Chromium sandboxing failed`，这时设 `PLAYWRIGHT_NO_SANDBOX=1` 退回无沙箱。设为 `none` 不注册浏览器。
- **MCP 工具审批**：`[mcp_servers.qq_context]` 与 `[mcp_servers.browser]` 都写了 `default_tools_approval_mode = "approve"`（`CODEX_MCP_APPROVAL_MODE=auto|prompt|writes|approve`，默认 `approve`）。cs-agent 以非交互的 `codex exec` 运行（approval policy `never`），需要审批的 MCP 调用会直接失败（`MCP tool call requires approval, but approval policy is never`）。`auto` 按工具 annotations 决定是否审批，2026-10-18 在 codex 0.163 实测 `auto` 下 qq_context 工具调用仍被要求审批而失败，`approve` 则成功，所以默认 `approve`；qq_context 工具现已声明 `readOnlyHint: true`，`auto` 之后可能可用，但不作为默认。浏览器可用的工具仍只限 `enabled_tools` 白名单。
- **浏览器工具白名单与 `file:`**：`playwright-mcp` 进程以 node 运行、不受 codex 命令沙箱约束，所以受管 `config.toml` 给 `[mcp_servers.browser]` 写了 `enabled_tools` 白名单（导航、快照、截图、点击/输入/选择/拖拽、`browser_evaluate`、标签页、对话框、控制台与网络记录等 22 个）。未列出的工具 codex 既不暴露给模型也拒绝调用，新版本新增的工具默认关闭。被排除的：`browser_run_code_unsafe`——在 playwright-mcp 进程里执行任意 JS，实测可以用 `page.constructor.constructor('return process')()` 拿到 Node 的 `fs` 直接读出 `/data/codex/auth.json`，也能 `page.goto('file://…')` 绕过 `file:` 拦截；`browser_file_upload`、`browser_drop`（把本地文件交给网页）。`file:` 协议本身：playwright-mcp 0.0.83 对 `browser_navigate` / `browser_tabs` 的 URL 自带拦截（`Access to "file:" protocol is blocked`），页面 JS 的 `location` 跳转与 `fetch` 由 Chromium 拒绝。`--blocked-origins` 表达不了 `file:`（file URL 的 origin 是 `"null"`，模式会退化成 `*://file:///…/**`）；Chromium 托管策略 `URLBlocklist` 在 Playwright 的 headless shell 里实测不生效，所以没有采用。
- **实测**（`cs-agent:g1fix`，经 `codex app-server` 的 `mcpServerStatus/list` 与 `mcpServer/tool/call` 调用，不发起模型请求）：白名单前 25 个工具，`browser_run_code_unsafe` 读出了假的 auth.json；白名单后只暴露 22 个，调用它返回 `tool 'browser_run_code_unsafe' is disabled for MCP server 'browser'`；`browser_navigate file:///etc/hostname`、`file:///data/codex/config.toml` 均为 `Access to "file:" protocol is blocked`；`data:text/html,<h1>x</h1>` 正常加载；页面内 `location.href='file:…'` 不跳转，`fetch('file:…')` 报 `Failed to fetch`。
- codex 线程：`owner` 与 `shared` 各一条互斥队列——owner 的请求与群聊请求可以同时运行，同一线程内一次一轮。日志 `codex thread created` / `rotated` / `missing` / `resume failed` 都带 `key`；healthz 的 `codex.threads` 显示两条线程的 id（每次请求现读）。
- 每条线程各自的安全阀：resume 前若 `${CODEX_HOME}/sessions/**/rollout-*-<thread_id>.jsonl` 超过 `CODEX_ROLLOUT_MAX_MB`（50）或线程超过 `CODEX_THREAD_MAX_DAYS`（90）天，新建线程，日志 `codex thread rotated`（历史靠 `qq_context` 找回）。

**卷权限**：容器以 `node` 用户（uid 1000）运行，`./data` 和 `./workspace` 必须对它可写。入口脚本和 agent 启动时都会写入并删除一个探针文件来检查；不可写时日志会给出目录名和当前 uid，容器以退出码 1 退出。Docker Desktop（Windows）的绑定挂载一般没有这个问题；Linux 宿主机上可以执行 `sudo chown -R 1000:1000 data workspace`。

### 残余风险

- codex 执行的命令读不到 `auth.json`、会话、SQLite 库和图片（deny_read，见「7. codex 权限」），但 codex 进程本身（不受沙箱约束）持有这份 ChatGPT 凭据；不在 deny_read 中的 `/data` 文件（`config.toml`、`prompts/`、`workflows/`）命令仍可读取。MCP 服务进程（`qq_context`、浏览器）同样不受命令沙箱约束：浏览器的 `file:` 访问与任意代码执行工具已用工具白名单和 playwright-mcp 自带拦截封住（见上），但这依赖 playwright-mcp 与 Chromium 的实现，升级 `@playwright/mcp` 或 `@openai/codex` 后需要重新实测：`scripts/verify-browser-mcp.mjs` 在镜像内经 `codex app-server` 调用浏览器工具并检查（不调用模型；用法见脚本开头，务必挂假的 `/data`），全部通过时退出码为 0。`AGENTS.md` 只约束模型行为，不是访问控制。**只把能信任使用这个工作区的人加入 `QQ_ALLOW_USERS` / `QQ_ALLOW_GROUPS`**。
- **浏览器 MCP 的网络访问**：`playwright-mcp` 进程由 codex 作为 MCP 服务启动，**不受 codex 命令沙箱约束**，可以访问容器能到达的任何网络。宿主机上的 ComfyUI（`host.docker.internal:8188`，无鉴权）、NapCat（3000/3001）以及容器自身的 healthz 都在这个范围内。`--blocked-origins` 阻止列表能拦住直接访问这些地址和内网/链路本地网段，但 @playwright/mcp 明确说明它**不是安全边界**：
  - 不拦截重定向：公网页面 302 到 `http://host.docker.internal:8188/…` 时不会被阻止；
  - 按 URL 主机名匹配，不看解析结果：解析到内网 IP 的公网域名（如 `127.0.0.1.nip.io` 之类、DNS rebinding）不会被阻止；
  - 只覆盖浏览器发出的请求，与 codex 自身的 web_search 无关。
  如需真正隔离，可设 `CODEX_BROWSER=none`；或在宿主机侧让 ComfyUI/NapCat 只接受鉴权请求、用防火墙限制 Docker 网段访问。
- **`/data/prompts` 可写**（用户接受的风险）：codex 命令可以改写 `/data/prompts` 下的文件。v3 中 `system.md` 已不再被读取；pi 后端从这里热加载 `agent.md`，修改会在下一次模型请求生效。全局 AGENTS.md 规定只在 owner 私聊明确要求时才修改、群聊请求一律拒绝，但这**只靠模型遵守**。想彻底禁止，把 `/data/prompts` 从 `CODEX_WRITABLE_ROOTS` 去掉。
- **image_gen 可被群成员触发**：任何能让 codex 处理消息的发送者都可以间接让它生图（每回合最多 4 次，图片只写到本票据目录、只随本条回复发出）。
- **聊天记录**：群成员可以让 codex 检索本群 30 天内的原始消息和 180 天内的摘要（与能翻群记录一致）；owner 私聊可以检索全部会话。`./data/qq-messages.sqlite` 按聊天记录保管。

### 生图 MCP（image_gen）

- 慢任务在 MCP 等待上限后返回“图片仍在生成……无需重试”，仅此时写入票据目录的 `pending-jobs.json`。agent 在 `handle → lateImages → postprocess → reply` 中按原 prompt_id 收取到原 `call-<n>/`，结果并入同一条回复（最多 4 张）；这期间同 scope 的后续消息继续排队。最终失败追加“有一张图生成超时未能发送”。
- `lateImages` 将各任务的参数、期限、延期次数、对账步骤和结果保存到 TicketDoc；unknown 先按前缀对账，绝不重新提交。全部结果落盘后删除清单，恢复时复用已下载的有效图片或已保存的结果。参考图清单保留至最终收取结束再覆盖清理。`IMAGE_GEN_MCP_WAIT_SEC` 由启动脚本透传给 MCP；部署时需将该变量传入容器，未设置默认 90 秒。
- 工具参数与前缀共用 ImageOptions：prompt、negative_prompt、aspect、size、count、seed、reference_images、transparent。每轮（含 resume）注入 IMAGE_REFS，没图时显式注入空串，防止旧轮次路径继承；只允许本票据 incoming 下的允许列表文件，校验绝对路径、字符、realpath、大小、魔数。
- 参考图上传到 ComfyUI input 的每票据子目录。若 comfy-mcp 的 upload_file 支持 paths 和 subfolder 则使用它；本机安装版本只有 paths/overwrite，不能指定子目录，因而回退到同 COMFYUI_URL 的 HTTP /upload/image。真实冒烟覆盖 HTTP 上传，MCP 两种能力分支由假服务测试。

- 受管 `config.toml` 中的 `[mcp_servers.image_gen]`：`node /app/dist/mcp/image-gen.js`，`tool_timeout_sec = COMFY_TIMEOUT_SEC + 30`，审批模式同 `CODEX_MCP_APPROVAL_MODE`；`[mcp_servers.image_gen.env]` 透传 `DATA_DIR` 与已设置的 `COMFY_MODE` / `COMFYUI_URL` / `COMFY_MCP_BIN` / `COMFY_BIN` / `COMFY_CHECKPOINT` / `COMFY_WORKFLOW_FILE` / `COMFY_PROMPT_NODE` / `COMFY_TIMEOUT_SEC` / `COMFY_LOOPBACK_PORT` / `COMFY_QWEN_CACHE` / `LOG_LEVEL`（含引号或反斜杠的值会被跳过并告警）。
- 输出目录每轮由 cs-agent 以 `-c mcp_servers.image_gen.env.IMAGE_TICKET_DIR="/data/images/<ticket>"` 注入；没有注入、不是 `/data/images/` 的直接子目录（含软链接逃逸）时工具一律拒绝。每次调用输出到其下新的子目录 `call-<n>/`（工具返回 `call-<n>/<文件名>`）。回合结束后 cs-agent 从该目录（递归）收集本回合新出现的图片（最多 4 张，校验 PNG/JPEG/WebP/GIF 魔数）随回复发送；codex 只需在回复里写一句说明。
- 访问 ComfyUI：与 agent 主进程同一套配置。mcp 模式下 `COMFYUI_URL` 不是 loopback 时，image_gen 连 `http://127.0.0.1:${COMFY_LOOPBACK_PORT}`——即主进程启动的 loopback 转发（日志 `comfy loopback proxy listening`）；codex 和它的 MCP 子进程与主进程在同一容器网络命名空间里。MCP 子进程不在 codex 命令沙箱里，可以写 `/data/images`（命令沙箱对它仍是禁读、不可写）。

## 5. 测试

```powershell
npm ci
npm run typecheck
npx vitest run            # 全部（agent + qq + context + mcp + entrypoint；MCP stdio 测试会在 dist 过期时先编译）
npx vitest run test/agent # 仅 agent：规则分流、durable 任务崩溃恢复、scope FIFO、假 codex、假 comfy-mcp、回复后处理
docker build -t cs-agent:dev .
docker compose config
```

Vitest 测试不访问真实 QQ、模型或 ComfyUI。另有显式宿主机冒烟：先 npm run build，再设置 COMFY_MODE=http 运行 node scripts/smoke-image-v2.mjs。该脚本固定连接 127.0.0.1:8188，只生成 5 个用例（1MP、16:9、2K、透明、单图编辑），结果与 prompt_id 保存在 data/imgv2-smoke；超时后重跑会继续收取原任务，已有结果不重复生成。验收记录见 [IMAGE-GEN-V2-ACCEPTANCE.md](IMAGE-GEN-V2-ACCEPTANCE.md)。

## 6. 排障

- **comfy 自检失败 / 生图一直失败**：在 `.env` 设置 `COMFY_MODE=http` 后重启。这个模式直接调用 ComfyUI 的 `/prompt`、`/history`、`/view`。
- **codex 一直失败**：`docker compose exec cs-agent codex exec --skip-git-repo-check -s read-only "hi"`，看具体报错（auth、sandbox、网络）。
- **会话卡住 / 顺序**：同一会话（群或私聊）的消息严格按收到顺序处理：一条消息占据队首，直到进入终态——回复已发出（sent，含兜底）、发送结果不确定（uncertain），或失败（failed：重试 3 次后兜底也发不出）——下一条才开始。任务失败且兜底在发送前就失败（例如 NapCat 暂时不可用）时，这条消息留在队首、退避后重试（日志 `ticket still pending after attempt; retrying at the head of its scope`）；超过 3 次后先中止它的任务再发兜底（`ticket reached max attempts, giving up` → `ticket task aborted before fallback`），兜底仍发不出则标记 failed 并继续下一条（`ticket failed: fallback could not be sent after max attempts; moving on`；failed 条目留在 `agent.sqlite` 的派发索引里，重启不会重跑）。
- **重启后的恢复**：未完成消息由派发索引与票据库按 seq 恢复（pending 分页取尽）；空原文孤儿票据登记 `fallbackOnly`，同样在 scope 队首重试至终态。codex 仅在取得线程锁、复查取消信号后才记录次数并启动；排队时重启不消耗回合次数。已有输出直接复用，中途被打断最多再问一次。已发送或 uncertain 的回复不重发。
- **生图提交对账**：提交前在 TicketDoc 保存 `submitIntent={attempt,filenamePrefix}`，SaveImage 前缀为 `cs-<票据前12位hex>-<attempt>`。HTTP 与 MCP 自定义工作流都写入该前缀；默认 MCP 的 `generate_image` 若不支持 `filename_prefix`，改走可控的 `run_workflow`。意图已落盘但 prompt_id 丢失，或收取时报 unknown 时，两种模式均经 HTTP 查 `/history`、`/queue`，命中则认领；否则探测 `/view?filename=<前缀>_00001_.png&type=output`（多张按 count 递增，最多 4 张）。查询前后记录 `imageReconciliation`，只有确认无输出才用 attempt+1 重交，总提交上限 2 次；服务不可达不能证明未运行。mcp 模式对账也依赖同一 loopback 转发可达。
- **取消与发送**：任务在副作用前先检查 abort；QQBridge 在 `get_login_info` 前及 `markSending` 前再次检查。此前取消时票据保持 pending；一旦 `markSending` 成功便继续实际发送，发送失败仍记 uncertain，不因取消而重发。
- **生图前缀没生效**：确认消息开头就是前缀（前面只能有空白、真实的 @ 或引用），全/半角与 `IMAGE_PREFIXES` 完全一致；手打的 "[at]" 字样不算 @；日志 `message routed` 的 `route` 字段显示分流结果。

## 7. codex 权限

codex 以 `-s workspace-write` 运行，命令由它自带的 bwrap 沙箱执行。受管 `config.toml` 中的相关设置：

```toml
[sandbox_workspace_write]
network_access = true                                              # CODEX_SANDBOX_NETWORK
writable_roots = ["/workspace", "/data/prompts", "/data/workflows"] # CODEX_WRITABLE_ROOTS
```

- **前提**：bwrap 需要非特权用户命名空间。Docker 默认的 seccomp 配置阻止 `CLONE_NEWUSER`，所以在 `docker-compose.yml` 加 `security_opt: [seccomp=./docker/seccomp-codex.json]`（Docker 默认 profile + 仅放开命名空间/挂载相关系统调用）之前，codex 在容器里**任何命令都无法执行**。
- **身份**：容器进程与 codex 命令都以 `node`（uid 1000）运行。
- **写入**：只能写 `/workspace`、`/data/prompts`（提示词目录；`system.md` 已弃用）、`/data/workflows`（生图工作流），以及 codex 默认可写的 `/tmp`。`/data` 本身、`/data/codex`（auth.json、sessions）、`/data/*.sqlite`、`/data/images`、`/data/tickets` 都不可写；入口脚本先规范化每一项（合并重复的 `/`，去掉 `/./`、末尾的 `/.` 与 `/`），再与规范化后的 `DATA_DIR` / `CODEX_HOME` 比较，拒绝 `/`、`/data` 本身及其上级目录、`/data/codex` 及其子目录、`/data/images`、`/data/tickets` 及其子目录、`*.sqlite`、任何含 `..` 或非法字符的项，并打印 `rejected CODEX_WRITABLE_ROOTS entry`（例如 `/data//`、`/data/.`、`/data/codex/.`、`/data/images//x` 都会被拒绝）。
- **工作流**：`/data/workflows/` 不存在时，启动会从镜像的 `/app/workflows/` 复制一份（已存在则绝不覆盖）。默认 `COMFY_WORKFLOW_FILE=/data/workflows/qwen-image-2.1-turbo-api.json`。旧值 `/app/workflows/…` 仍然有效，只是 codex 改不了那份。
- **网络**：命令可以联网（`network_access = true`），因此能直接访问宿主机的 ComfyUI `host.docker.internal:8188`（无鉴权，可以提交任务、读取输出）。NapCat（3000/3001）需要 Bearer token，codex 拿不到。
- **规则文件**：codex 从 `$CODEX_HOME/AGENTS.md`（`/data/codex/AGENTS.md`，受管、命令只读）读取全局规则，再叠加工作区的 `/workspace/AGENTS.md`。全局规则里的“只读写下列目录”按入口脚本导出的 `CODEX_EFFECTIVE_WRITABLE_ROOTS`（规范化、校验后的 `CODEX_WRITABLE_ROOTS`）渲染：默认列出 `/workspace`、`/data/prompts`（提示词目录）、`/data/workflows`（ComfyUI 工作流 JSON）；`CODEX_WRITABLE_ROOTS` 去掉 prompts 后规则里也不再提它。
- **读取（deny_read）**：入口脚本每次启动重写 `/etc/codex/requirements.toml`（镜像内 `/etc/codex` 归 node 所有；写不进去时容器以退出码 1 退出）：

  ```toml
  [permissions.filesystem]
  deny_read = ["/data/codex/auth.json", "/data/codex/.credentials.json", "/data/codex/sessions", "/data/codex/archived_sessions",
    "/data/codex/history.jsonl", "/data/codex/log", "/data/codex/shell_snapshots", "/data/codex/memories",
    "/data/codex/*.sqlite*", "/data/*.sqlite*", "/data/images", "/data/tickets", "/data/codex-session.json*", "/data/codex-threads.json"]
  ```

  codex 0.163 只认系统级 `requirements.toml` 里的这个键（放在 `$CODEX_HOME/requirements.toml` 不生效；`config.toml` 的 `[permissions.<profile>]` 与 `sandbox_mode` 互斥，cs-agent 每轮要用 `-c sandbox_mode=…`）。命中的路径在 bwrap 里被空文件/空目录覆盖，`workspace-write` 与 `read-only` 都生效；glob 在每条命令启动时展开，所以之后新建的 `*.sqlite` 也会覆盖。不能整个禁读 `/data/codex`：codex 的 arg0 辅助程序在 `/data/codex/tmp`，整目录禁读时 codex 拒绝启动沙箱。`/data/codex/config.toml`、`/data/codex/AGENTS.md`、`skills/` 仍可读（不含秘密）。
- **凭据**：codex 子进程的环境变量走白名单（PATH/HOME/LANG/TERM/TZ/代理变量），不含 NapCat token、API key 等任何秘密。codex 执行的命令读不到 `/data/codex/auth.json`（见上）。
- **QQ**：codex 没有发送 QQ 消息的能力，回复只经 cs-agent 的 agent 任务发回原会话（目标来自票据，codex 无法指定）。
- **实测**（`cs-agent:g1`，`codex sandbox -c sandbox_mode="workspace-write"`，seccomp=docker/seccomp-codex.json；unconfined 结果相同）：uid 1000；`/workspace`、`/data/prompts`、`/data/workflows`、`/tmp` 可写；`/data`、`/data/codex`、`/data/images`、`/data/qq-messages.sqlite` 写入被拒；`host.docker.internal:8188/system_stats` 返回 200，NapCat `:3000` 无 token 返回 403，公网 200；`CODEX_SANDBOX_NETWORK=false` 时三者都失败（EPERM / EAI_AGAIN）；沙箱内环境变量中没有 token / API key。默认 seccomp 下 bwrap 报 `No permissions to create a new namespace`。
- **实测 deny_read**（`cs-agent:g1fix`，`--security-opt seccomp=./docker/seccomp-codex.json --user node -w /workspace`，假数据卷）：`codex sandbox -c sandbox_mode="workspace-write" -- cat <路径>` 对 `/data/codex/auth.json`、`sessions/**`、`/data/codex/state_5.sqlite(-wal)`、`/data/agent.sqlite`、`qq-bridge.sqlite`、`qq-messages.sqlite(-wal)`、`observability.sqlite`、`/data/images/**`、`/data/codex-session.json` 均为 `Permission denied`；`cp` 到工作区、软链接后读取同样被拒，硬链接到 `/data/workflows` 报 `Invalid cross-device link`；`python3 open()` 报 `PermissionError`；`read-only` 模式同样被拒；`/data/codex/config.toml` 可读；`/workspace`、`/data/workflows`、`/data/prompts` 可写，`/data/codex`、`/etc/codex` 只读。
- 关闭联网：`.env` 中设 `CODEX_SANDBOX_NETWORK=false` 后重启（web_search 是 codex 服务端的工具，不受影响）。

## 生图 v2 审查修复（2026-10-18）

入站先在 SQLite 同步保存去重、pending 票据及附件的 URL/file id，再启动下载。URL 只用于票据恢复，不写入日志或消息历史；应按聊天附件敏感信息保管票据库。附件终态为 ok、skipped、failed，达到终态才派发；超额或超时标为 skipped，继续无图处理原文，校验失败为 failed 并保留原因。

下载只允许 HTTP/HTTPS，无凭据 URL。每跳先解析全部 DNS 地址，任一地址属于回环、私网、链路本地、未指定或多播（含 IPv4-mapped IPv6）即拒绝；localhost、*.localhost、host.docker.internal、*.internal 及 *.docker.internal 禁止。连接固定到本次校验过的 IP，同时保留原 Host 和 HTTPS SNI/证书验证，避免 DNS rebinding。手动重定向最多 3 跳，每跳重新执行同一策略；NapCat get_image 刷新的地址也不例外。

每个 scope 最多 1 个下载任务，全局由 INCOMING_DOWNLOAD_CONCURRENCY 控制（默认 2）；每位发送者最多 2 张在途票据，超额跳过图片。INCOMING_DOWNLOAD_DEADLINE_SEC 默认 60 秒，包含 scope/global 排队、DNS、刷新与流式下载；截止时间随附件落盘，重启不重新计时，截止后释放 worker。同 scope 消息保序，其他 scope 的接纳及纯文本派发不等待图片下载。重启后按票据元数据恢复 pending 附件，必要时用 file id 向 NapCat 刷新 URL，再进入派发。

参考图最多 3 张，每张 12 B～10 MiB，流式计数不依赖 Content-Length。下载及上传前只解析 PNG IHDR、JPEG SOF、WebP VP8/VP8L/VP8X、GIF LSD 与 GIF 块结构，不解码像素；边长不得超过 4096，像素不得超过 20 MP。拒绝多帧 GIF、NETSCAPE 循环块、带动画标志的 WebP。创建票据目录前先确认 incoming 父目录 realpath 位于 DATA_DIR，创建后复查；已有文件恢复前 lstat 检查普通文件与大小。

生图基础收取预算：1mp 120 秒、2mp 240 秒、2k 600 秒，乘 count 后由 COMFY_TIMEOUT_SEC 截断。首次收取超时保留 imageJob.status=running、deadline、延期次数和下一次收取时间，使用 durable sleep 再次收取同一 prompt_id；IMAGE_COLLECT_EXTENSIONS 默认 2，即最多 3 次收取窗口。延期耗尽才回复“生图超时”。未知或丢失 id 仍按输出前缀查询 history/queue/view，不据超时重新提交。

参考图上传前把远端 name/subfolder 清单写入 TicketDoc；独立 image_gen MCP 同时使用票据输出目录下的 remote-uploads.json 写前清单。整个收取过程结束（成功或最终失败）后，通过 /upload/image、type=input、overwrite=true，以同名同子目录的 1×1 透明 PNG 覆盖。清理失败保留清单，恢复或票据终态清理时重做；延期等待期间保留图片供排队任务读取。此操作覆盖 input 文件内容，但 ComfyUI history/queue 仍会列出文件名，已生成输出、服务端缓存和管理员备份也不受此覆盖操作清除；它不是删除历史记录或安全擦除。

stdio 测试由 Vitest globalSetup 每次统一执行一次 npm run build，确保 image_gen 和 qq_context 都使用本次源码的 dist，不再维护手写依赖时间戳列表。

## pi 执行后端（第 3 组）

部署配置设为 `AGENT_BACKEND=pi`，或用 `AGENT_BACKEND_OVERRIDES=group:200000001=pi` 仅覆盖指定会话；改回 codex 使用原 codex 线程。配置在进程启动时读取，切换只影响新处理的消息，两后端记忆各自独立。本次验收只构建镜像，没有重启运行容器。

| 配置 | 默认 | 作用 |
|---|---|---|
| `PI_TURN_TIMEOUT_SEC` | 300 | 取得线程锁后的回合期限，覆盖模型与工具；到期中止实际回合并等待退出，再释放锁。排队不消耗预算，重启沿用保存的截止时间 |
| `PI_COMPACTION_RESERVE_TOKENS` | 16384 | 上下文超过模型窗口减此值时阻塞压缩 |
| `PI_COMPACTION_BACKGROUND_TOKENS` | 32768 | 距阻塞阈值此 token 数时开始后台压缩；0 关闭后台压缩 |
| `AGENT_MODEL_PROVIDER/AGENT_MODEL_ID` | deepseek / deepseek-flash | pi 模型；`AGENT_THINKING_LEVEL=low` 由现有模型能力解析器收敛 |

长期会话和工具检查点存 `DATA_DIR/pi.sqlite`（及 WAL/SHM），与票据任务的 `agent.sqlite` 分开。`pi-threads.json` 原子保存 `{owner, shared}`；SQLite 的会话创建事务同时保存映射，JSON 丢失或写回前崩溃时启动重建，勿单独删除 JSON 当作清空记忆。备份应包含数据库、相关 WAL 和映射。每个线程独立串行，owner 与 shared 可并行；恢复中的请求先占据线程锁，后来的请求不能覆盖其 access。压缩保留最近 20000 tokens（pi-durable 默认），不按天或大小轮换；压缩缩小模型上下文，不删除数据库原文。

`DATA_DIR/prompts/agent.md` 缺失时写入代码内的默认中文提示词，已有文件绝不覆盖；每次模型请求按 mtime/size 热加载，改完无需重启。旧 `system.md` 仍弃用。默认全文位于 `src/agent/pi-tools/prompt.ts`，涵盖 QQ 纯文本、事实搜索、历史工具纪律及生图文字/编辑指引。

DeepSeek Search/Fetch 使用 `DEEPSEEK_API_KEY`（兼容 `DEEPSEEK_APIKEY`），即使执行模型是其他 provider，联网工具仍需要此密钥。未配置时仅联网工具返回不可用。Search 最多 8 条、2500 字，Fetch 最多 4000 字；仅 429 退避一次，其余 HTTP 错误不重试。每回合 web_search/fetch_page 各最多 4 次、三种 qq 工具合计 4 次、generate_image 最多 2 次，上限通过 ToolTask hook 持久化计数，模型不能修改。

fetch_page 只接收无凭据的公开 HTTP(S) URL，复用入站下载的 IP 判定，解析全部 DNS 地址并拒绝任何内网地址。实际抓取发生在 DeepSeek 服务器，无法在本机固定其 DNS 结果或检查服务端重定向链；该部分依赖 DeepSeek 服务端策略，本次未执行真实 API 请求。

图片写到 `DATA_DIR/images/<ticket>/call-<n>/`，最终由既有回复任务附带最多 4 张；参考图只能取本票据 incoming 清单。远端参考图清单在上传前保存，完成或失败时覆盖清理，清理失败保留供既有终态清理恢复。生图工具使用 pi-durable 的 unsafe 重放策略：崩溃中断的外部生图调用不自动重提，模型收到 interrupted；已保存图片仍可随完成的回复附带。`requestId=ticket` 保证提交幂等，不等于外部生图服务的事务性 exactly-once。慢图受 pi 总回合期限限制；此次没有改动并行任务负责的 image_gen MCP 延迟收图逻辑。

## 观测面板

部署新版本后访问 http://localhost:8787 。Compose 只发布宿主机 loopback 的 8787 端口，容器内通过 HEALTH_HOST=0.0.0.0 接收端口转发；无需 CDN 或额外前端服务。本次实现只构建验收镜像，不重启现用容器。

| 页面 | 内容 |
|---|---|
| / | WS 与断线数、ComfyUI / Codex 启动检查、DeepSeek 密钥存在性、衰老最近结果、1h / 24h 完成量和错误率、队列、在途票据及最近一分钟指标 |
| /tickets | 每页 50 条；status、scope、route、backend 筛选；状态为 processing / sent / failed / timeout / fallback |
| /tickets/&lt;ticket&gt; | 原文摘要、路由、后端、阶段与重试、模型用量、工具调用、生图 prompt_id、原始/发送回复、票据终态和图片缩略图 |
| /logs | 进程内最近 1000 行结构化日志，SSE 实时追加；ticket / level 筛选，浏览器最多保留 500 行 |
| /context | 选择会话域，留空关键词看 recent，填写关键词看 search；直接复用 qq_context 与共享格式化器，包含原文和摘要 |
| /codex | owner / shared 当前线程、rollout 字节数、保留期内观察到的回合数、全局 AGENTS.md |
| /pi | 会话数量、键与 id、累计用量、压缩尝试数和最后时间、压缩配置 |
| /config | 脱敏后的生效配置、agent.md 内容与修改时间 |

面板始终要求口令，空 OBS_TOKEN 不再开放访问。启动时优先使用 OBS_TOKEN；留空则读取 DATA_DIR/obs-token，文件缺失时生成 32 字节随机数的 base64url 口令，以 0600 权限原子发布。仅生成时记录一次 observability token generated at /data/obs-token，日志不包含口令。管理员在自己的终端读取：

~~~sh
docker compose exec cs-agent cat /data/obs-token
~~~

打开 http://127.0.0.1:8787/，在登录表单粘贴口令；也支持 /?token=你的口令。若显式设置 OBS_TOKEN，应使用管理员配置的值。认证成功跳转到移除口令的 URL，并设置 HttpOnly、SameSite=Strict cookie。所有页面（含 /context）、图片和 SSE 都受保护。/healthz 保持无需口令的 JSON 探针，但仅发布连接状态、degraded、检查布尔值和线程信息，不返回服务地址、错误原文或凭据。不要分享带口令的 URL。面板只接受 localhost、127.0.0.1、[::1] Host。

口令文件和原子发布临时文件列入 Codex deny_read；OBS_TOKEN 不进入 Codex 或 MCP 子进程环境白名单。口令无法读取或生成时面板拒绝访问，业务继续运行，健康探针显示 degraded: true。

事件和指标存 DATA_DIR/observability.sqlite（WAL）。普通事件与指标默认 OBS_RETENTION_DAYS=30，管理事件默认 OBS_ADMIN_RETENTION_DAYS=365；启动后第一次指标刷新及之后每天按各自年龄清理过期 events / metrics；关闭时刷新最后窗口。备份需使用 SQLite 一致性备份或包含 WAL。日志环形缓冲不落盘，重启会清空；原有 stderr 日志仍可由 Docker 采集。

观测库损坏、路径不可写或 schema / Metrics 初始化失败时，观测降级为无操作存储；/healthz 与面板总览显示 degraded: true，消息处理继续运行。修复观测文件权限或隔离损坏文件后，在计划维护时重新启动进程以恢复采集；不要据空图表判断没有业务流量。此降级只覆盖观测子系统，业务数据库仍需正常工作。

普通票据默认最多 500 条事件，由 OBS_TICKET_EVENT_CAP 配置（8–10000）；detail 总量最多 256 KiB。普通事件为三种 terminal=true 终态（reply_sent / failed / fallback）及 events_dropped 摘要预留槽位和字节，终态单条 detail 最多 1 KiB；重复终态保留最新一条。摘要的 dropped 给出被预算拒绝的事件数。相同 Codex 工具调用的进度保留首条和末条，末条 count 为累计进度数。详情按 after=id&limit 游标分页（页面默认 100、最多 200）。Codex 内置命令与搜索每轮合计最多 100 条，只保存命令或搜索词前 200 字、退出码与耗时，不保存原始 JSONL。

image_gen MCP 不打开观测库，只向本票据 obs-events.jsonl 追加经 schema 校验的事件（每个文件最多 200 行 / 256 KiB）。主进程在 lateImages 和终态回收时领取文件，逐行校验、用主进程秘密注册表脱敏后入库并删除；超大文件直接忽略并删除，非法行忽略。旁路文件仅为尽力观测，不参与业务恢复判定。

观测事件先脱敏再保存：已配置凭据、敏感字段、Bearer / 常见 API key / JWT、带凭据 URL 都会隐藏；原文、prompt、reply 等字符串最多 500 字。票据详情保留摘要用于诊断，不是完整聊天归档。上下文页面通过既有消息库读取；正文、昵称、摘要、表单回显及其他渲染字符串均先脱敏再 HTML 转义，其存储保留策略不受 OBS_RETENTION_DAYS 影响。ws / wss 等任意协议 URL 的 userinfo 都会脱敏；NAPCAT_HTTP_URL / NAPCAT_WS_URL 禁止内嵌用户名和密码。

指标每 60 秒按独立窗口记录调用数、成功数、成功率、耗时 p50 / p95；超过一万次采样的类别用有界随机抽样计算分位数。窗口从主进程事件库读取，也包含已摄取的 Codex image_gen MCP 提交与收取；摄取保留子进程事件时间。队列深度不含正在运行的请求；全局使用槽位、各 scope 等待数分别展示。ComfyUI 同时记录各次 submit / collect / reconcile 调用耗时，以及能匹配 prompt_id 时从提交成功到收取成功的任务总耗时（comfy_job_duration_ms），均不等同 GPU 纯计算时间。

DEEPSEEK_PRICE_IN_PER_M / DEEPSEEK_PRICE_OUT_PER_M 默认 0；填入 deepseek-flash 的每百万 token 单价后估算费用，两项使用相同币种。输入包括可获得的 cache read / write；该估算不区分缓存优惠，也不包含搜索/抓页费用。用量来自 pi-ai 返回的 usage（pi、relay、衰老），三条路径使用同一 usage 字段转换和费用计算（含 cacheRead / cacheWrite），未提供的用量不会猜测。观测为尽力记录，崩溃边界可能重记响应，已写入的事件通过持久化游标恢复聚合，尚未写入的事件仍可能丢失；durable 业务检查点独立，不受观测写入失败影响。

ALERT_OWNER=false 默认不发送。显式启用且存在 QQ_OWNER（或 allowUsers 的首项）时，WS 连续离线超过五分钟、模型鉴权失败、连续三条票据失败会经 bridge.send 向 owner 私聊告警；所有原因共用每 30 分钟一次限频。告警只带固定原因，不带用户原文或服务端错误正文。此功能仅使用 fake bridge 验证。

健康含义：ComfyUI / Codex 是启动检查快照，不能证明当前网络或鉴权仍有效；DeepSeek 仅显示是否配置密钥。Pi 压缩统计表示 hook 观察到的尝试，不声明压缩成功；Codex 回合数仅覆盖观测保留期。现有 failed 派发索引必须保留以阻止 pending 票据在恢复时成为孤儿重跑，不随观测日志过期删除。


### 运行时设置的票据快照

面板修改后端、Codex 推理强度或回复模式后，仅新派发的消息采用新值。Dispatcher 在等待附件准备和 scope 队列之前读取一次设置，将 `{backend, codexReasoningEffort, codexReplyMode}` 与票据一起写入 `TicketDoc.settings`。执行、relay/direct 后处理、机器人历史行和崩溃恢复都使用此快照；例如进行中的 high/relay 票据不会因面板改成 low/direct 而改变。

升级前没有快照的存量票据无法还原历史设置：恢复时一次性写入固定 high/relay，后端优先采用已有结果中的 pi，否则 codex；后续重试沿用。没有 TicketDoc 的孤儿票据重新派发时才采样当前设置。


### 管理事件保留期

`settings_changed`、`prompt_changed`、`thread_reset`，以及任何 ticket 以 `@` 开头的事件，都归入管理审计类别。不受单票据事件数量或累计 detail 字节预算限制，不合并进度、不覆盖终态，也不消耗同名普通票据的预算；仍按原有规则脱敏。管理事件仅由年龄清理，默认保留 365 天（`OBS_ADMIN_RETENTION_DAYS`），面板查询接口与分页上限不变。

新增的 `PI_ARCHIVE_RETENTION_DAYS=90` 表示 pi 退休会话的目标保留期；当前安装的 pi-durable 1.3.0 没有删除会话 API，此项暂不触发数据库清理。两项配置均须为正整数。


### 线程重置与归档上限

Codex 的 `codex-threads-archive.jsonl`、pi 的 `pi-threads-archive.jsonl` 均只保留最新 200 条。Codex 在重置时通过进程内文件串行队列读改写，临时文件原子替换归档；不同键并发重置不会相互覆盖。

pi 将映射清空与归档行写入同一次 `pi.sqlite` 事务。归档追加或事务失败时，重置报错且映射不变；事务成功后重写 `pi-threads.json` 和 JSONL 镜像。镜像写入失败只记录 `pi thread mirror stale; will retry`，已提交的重置仍然有效，下次启动或映射操作从数据库重写。首次升级会将旧 JSONL 最新 200 条导入一次；之后 SQLite 为权威数据，镜像缺失或陈旧不会反向覆盖数据库。

限制：pi-durable 1.3.0 的公开 `Harness`、`Storage` 和 `StorageWrite` 接口均无删除会话能力，因此每日衰老任务暂不能按 `PI_ARCHIVE_RETENTION_DAYS=90` 删除退休会话，也不能清除迁移停用的旧 shared 会话。此配置目前仅校验、保留目标天数，不保证 pi.sqlite 大小有界；200 条上限仅约束重置归档记录和 JSONL 镜像，既有会话内容仍在数据库中。待库提供安全删除 API 后再接入每日衰老，不直接修改其内部表。

### 上下文占用数据（设计 §8.5）

启动在面板开放前回填上下文占用：codex 倒读 rollout 末尾至多 2 MiB，取最近已完成回合的 `token_count.info.last_token_usage`（输入已含缓存）与记录时间；超限时回合数仅为尾部可见计数或既有更大计数，日志标出 `truncated`；pi 从 harness 已提交历史恢复 assistant 用量、回合数和压缩消息时间；缺失或损坏保留原记录，每后端输出一行 `context usage backfilled` 计数，重置后重新核对当前映射并保持零占用。

每线程的上一轮输入占用保存在 `DATA_DIR/context-usage.json`，按 `backend:key` 索引，250 ms 防抖、临时文件原子替换；启动重载、优雅退出刷盘。突发退出可能丢失尚未刷盘的最后更新。记录不含提示词或凭据，面板通过同一存储读取，更新同时发出 `context_usage` 事件；`/healthz` 的 `context_usage` 数组也提供这些记录。重置会话或 codex 安全阀轮换后占用、缓存和回合数归零。

codex 每次进程启动仅查询一次 `codex debug models`（使用 runner 相同的 `CODEX_HOME` 与环境白名单，最多等待 15 s），按 `CODEX_MODEL` 匹配 `models[].slug`，窗口取 `context_window`。查询失败、缺模型或字段无效时回退 `CODEX_CONTEXT_WINDOW`（默认 400000），日志 `codex context window` 的 `source` 标明目录或回退来源；不调用模型。2026-10-18 实查 gpt-6.1-sol 为 500000。`usedTokens` 直接取 `input_tokens`，缓存已包含其中。

pi 使用 pi-ai 模型窗口与实际 harness 压缩设置。deepseek-flash 为 1000000；默认 reserveTokens=16384、backgroundTokens=32768，对应后台 950848、阻塞 983616（公式与来源见 ARCHITECTURE §10）。BACKGROUND=0 关闭后台压缩，两条位置数值重合；超过阻塞位置时下一次请求等待压缩。输入包括 cacheRead / cacheWrite，缓存命中单列 cacheRead；工具循环中的每次 assistant 模型回合各计一次，压缩摘要生成的计费用量不混入占用。`lastCompactionAt` 仅在观察到已提交的 `pi.compaction` 摘要条目时更新，取主进程观测时间（条目没有墙钟时间戳），不把压缩尝试或失败当成功。启动时从持久化历史回填回合数与压缩消息时间；无回合用量的记录标为 `estimate`。
