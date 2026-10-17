# cs_agent 部署手册

单容器：QQ（NapCat）→ 规则分流 →（`奶龙:` 前缀）ComfyUI 生图，或（其他消息）执行 agent（默认容器内 codex）→ 回到原 QQ 会话。设计见 `docs/ARCHITECTURE.md`。

## 0. 使用方式（v3）

- **生图**：消息以 `奶龙:` 或 `奶龙：`（半角/全角冒号均可，`IMAGE_PREFIXES` 可改）开头，前缀之后的全部文字原样作为提示词，例如 `奶龙: 一只戴墨镜的柴犬，赛博朋克风`。群里照常 @机器人 后再写。前缀后为空时回复"奶龙: 后面写要画的内容"。成功回复"图片生成好了"+图；失败按类别回复：服务不可用 / 超时 / 内容被拒 / 其他。不经过任何模型。
- **其他消息**：整条交给执行 agent（`AGENT_BACKEND`，默认 codex）。codex 可以联网搜索、检索聊天记录，也可以通过 `image_gen` 工具自己出图（例如"查一下今年 Major 冠军队的队标然后画一张海报"），图片随回复一起发出。追问改图（"把刚才那张改成蓝色"）也走这里：codex 从聊天记录里看到上一条 `[我] → 生图 prompt="…"` 后重新生成。
- **顺序**：同一个群/私聊里严格按消息顺序逐条回复；不同会话并行（总数 ≤ `AGENT_CONCURRENCY`）。


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
| `AGENT_BACKEND` | `codex` | 执行 agent 后端：`codex`（容器内 codex 固定线程）或 `pi`（第 3 组实现；当前选中时回复失败模板，日志 `pi backend not implemented yet (group 3)`） |
| `AGENT_BACKEND_OVERRIDES` | 空 | 按会话覆盖后端：`group:200000001=pi,private:10000001=codex`。格式错误时启动失败。切换只影响之后的消息，两个后端的记忆互相独立 |
| `CODEX_REPLY_MODE` | `relay` | codex 回复的后处理：`relay` 先用意图模型（下一行）把回答整理成 QQ 纯文本（20 s 超时，失败回退），再做代码清洗；`direct` 只做代码清洗（去代码围栏、标题符号、表格竖线，`@` 换成全角 `＠`，截断到 4000 字） |
| `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID` | `deepseek` / `deepseek-flash` | 意图模型：v3 只用于 codex 回复的 relay 整理与聊天记录日/周摘要（pi 后端将来也用它）（DeepSeek OpenAI 兼容接口 `https://api.deepseek.com`）。也可切换到 `openai-codex`（复用 `auth.json` 的 ChatGPT OAuth，如 `gpt-6-luna`）、`openai`、`anthropic` 等，后两者需设置对应的 `*_API_KEY` |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek API key；写作 `DEEPSEEK_APIKEY` 也可（启动时自动映射）。provider 为 `deepseek` 时缺少密钥，agent 启动即退出 |
| `AGENT_THINKING_LEVEL` | `low` | 意图模型思考档位。deepseek-flash 支持 off/low/high/max，其他值就近调整（如 medium → high）并记 warn 日志 |
| `AGENT_CONCURRENCY` | 2 | 同时处理的 QQ 消息数，多出来的排队（排队状态已持久化） |
| `COMFY_MODE` | `mcp` | `mcp`：经 comfy-mcp；`http`：直连 ComfyUI HTTP API（默认 SD1.5 文生图工作流） |
| `COMFY_WORKFLOW_FILE` / `COMFY_PROMPT_NODE` | `.env.example`：`/app/workflows/qwen-image-2.1-turbo-api.json` / `4` | API 格式工作流（镜像内自带本机 Qwen Image 2.1 Turbo 版本）。设置后 mcp 走 `run_workflow`，http 直接提交它。程序把提示词写入提示词节点，并随机化 seed。**本机 ComfyUI 没有 SD1.5 checkpoint，留空时默认模板会失败** |
| `COMFY_CHECKPOINT` | 空 | 指定 checkpoint；留空时用模板默认（mcp）或第一个可用的 checkpoint（http） |
| `CODEX_SANDBOX` | `workspace-write` | 如果容器内 codex 报 sandbox/landlock 错误，改为 `danger-full-access`（这时容器本身就是沙箱） |
| `CODEX_TIMEOUT_SEC` / `COMFY_TIMEOUT_SEC` | 600 / 300 | 单轮超时；codex 超时后会 kill 整个进程树 |
| `CODEX_MODEL` / `CODEX_REASONING_EFFORT` | `gpt-6.1-sol` / `high` | 写入受管的 `./data/codex/config.toml`（见第 4 节）。`CODEX_REASONING_EFFORT`（`low/medium/high/xhigh/max`）固定使用，每轮也以 `-c model_reasoning_effort="…"` 显式传入（日志 `codex backend done` 的 `effort` 字段）；v3 不再按请求选择 |

> codex 子进程只拿到最小环境变量：`PATH`、`HOME`、`LANG`/`LC_ALL`、`TERM`、`CODEX_HOME`、`NO_COLOR=1`，以及设置了的 `HTTP(S)_PROXY`/`NO_PROXY`。`NAPCAT_TOKEN`、`*_API_KEY` 等配置不会传给 codex。

## 3. 启动

```powershell
docker compose up -d --build
docker compose logs -f            # 一行一个 JSON 的结构化日志（不含 token）
docker compose ps                 # HEALTH 列
docker compose exec cs-agent node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)"
```

`/healthz` 只监听容器内的 127.0.0.1:8787，返回：
- `ws_connected`：NapCat WS 是否在线（离线时 HTTP 503，容器显示 unhealthy）
- `comfy`：启动时 comfy 的自检结果（mcp：`server_info`；http：`/system_stats`）
- `codex`：`auth.json` 是否存在，以及当前固定会话 id

> comfy-cli 1.22 在 local 模式下拒绝从非 loopback 主机获取 `/object_info`（SSRF 防护），所以 mcp 模式下 agent 会在容器内的 `127.0.0.1:${COMFY_LOOPBACK_PORT:-8188}` 启动一个 TCP 转发，指向 `COMFYUI_URL`，再把 comfy-mcp 指向这个 loopback 地址。日志中出现 `comfy loopback proxy listening` 即表示转发已启动。

## 4. 数据卷

| 路径 | 内容 |
|---|---|
| `./data/agent.sqlite` | pi-durable 会话、任务和派发索引（崩溃后自动续跑） |
| `./data/codex/` | `CODEX_HOME`：`auth.json`、`config.toml`、sessions。**`config.toml` 是受管文件**：入口脚本每次启动都按 `CODEX_MODEL` / `CODEX_REASONING_EFFORT` / `CODEX_WEB_SEARCH` / `CODEX_WEB_SEARCH_CONTEXT` / `CODEX_BROWSER` / `CODEX_MCP_APPROVAL_MODE` / `QQ_CONTEXT_MAX_CHARS` 重写（含 `web_search`、`[mcp_servers.qq_context]`、可选 `[mcp_servers.browser]`），手工修改会被覆盖；要改请改 `.env` 后重启 |
| `./data/qq-messages.sqlite`（+ `-wal` / `-shm`） | 统一上下文消息库：允许范围内的全部 QQ 消息（含不触发的群消息）、机器人回复行（动作、生图提示词、codex 推理强度、状态）、日/周摘要。**按聊天记录保管**。撤回的消息会删除原始行 |
| `./data/prompts/system.md` | **已弃用**：v2 意图模型的系统提示。v3 规则分流不经模型，不再读取它；文件保留不删，存在时启动日志记一行 `system.md is deprecated and no longer used` |
| `./data/codex-threads.json` | 两条固定 codex 线程：`{"owner": {thread_id, created_at, updated_at}, "shared": {…}}`。owner 私聊（`QQ_OWNER`）用 `owner`，所有群和其他私聊共用 `shared`；删掉某个键（或整个文件），对应线程下一条请求就新建。旧版的单线程 `codex-session.json` 在新文件不存在时自动迁移为 `owner`（日志 `codex thread migrated`），旧文件改名为 `codex-session.json.migrated` |
| `./data/images/<ticket>/` | 生成的图片 |
| `./data/*`（QQBridge） | 票据与去重 SQLite |
| `./data/codex/AGENTS.md` | codex 的全局规则（安全规则、QQ 回复格式、聊天记录工具与浏览器使用纪律），**受管文件**：agent 每次启动按实际生效的可写目录重写（版本标记 `<!-- cs-agent-agents-template v3 -->`，日志 `wrote codex global AGENTS.md`）。codex 执行的命令对 `/data/codex` 只读，改不了它；要改规则请改代码里的模板 |
| `./workspace/` | codex 工作目录（可写）。没有 `AGENTS.md` 时写入一份占位说明（“规则见全局 AGENTS.md；本目录是你的工作区”）。与旧版 v1 / v2 模板**全文相同**（忽略 CRLF）的文件会替换为占位说明（日志 `replaced old workspace AGENTS.md template with a stub`）；带旧模板标记但被改过的文件保持不动，并记 warn `workspace AGENTS.md is a modified old cs-agent template`。codex 会同时读取全局与工作区的 `AGENTS.md`（全局在前）；工作区这份 codex 自己能改，所以规则不放这里 |

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
- **`/data/prompts` 可写**（用户接受的风险）：codex 命令可以改写 `/data/prompts` 下的文件。v3 中 `system.md` 已不再被读取，影响暂时为零；第 3 组的 pi 后端将从这里热加载 `agent.md`，届时风险恢复。全局 AGENTS.md 规定只在 owner 私聊明确要求时才修改、群聊请求一律拒绝，但这**只靠模型遵守**。想彻底禁止，把 `/data/prompts` 从 `CODEX_WRITABLE_ROOTS` 去掉。
- **image_gen 可被群成员触发**：任何能让 codex 处理消息的发送者都可以间接让它生图（每回合最多 4 次，图片只写到本票据目录、只随本条回复发出）。
- **聊天记录**：群成员可以让 codex 检索本群 30 天内的原始消息和 180 天内的摘要（与能翻群记录一致）；owner 私聊可以检索全部会话。`./data/qq-messages.sqlite` 按聊天记录保管。

### 生图 MCP（image_gen）

- 受管 `config.toml` 中的 `[mcp_servers.image_gen]`：`node /app/dist/mcp/image-gen.js`，`tool_timeout_sec = COMFY_TIMEOUT_SEC + 30`，审批模式同 `CODEX_MCP_APPROVAL_MODE`；`[mcp_servers.image_gen.env]` 透传 `DATA_DIR` 与已设置的 `COMFY_MODE` / `COMFYUI_URL` / `COMFY_MCP_BIN` / `COMFY_BIN` / `COMFY_CHECKPOINT` / `COMFY_WORKFLOW_FILE` / `COMFY_PROMPT_NODE` / `COMFY_TIMEOUT_SEC` / `COMFY_LOOPBACK_PORT` / `LOG_LEVEL`（含引号或反斜杠的值会被跳过并告警）。
- 输出目录每轮由 cs-agent 以 `-c mcp_servers.image_gen.env.IMAGE_TICKET_DIR="/data/images/<ticket>"` 注入；没有注入、不是 `/data/images/` 的直接子目录（含软链接逃逸）时工具一律拒绝。回合结束后 cs-agent 从该目录收集本回合新出现的图片（最多 4 张，校验 PNG/JPEG/WebP/GIF 魔数）随回复发送；codex 只需在回复里写一句说明。
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

测试不访问真实 QQ、模型或 ComfyUI。

## 6. 排障

- **comfy 自检失败 / 生图一直失败**：在 `.env` 设置 `COMFY_MODE=http` 后重启。这个模式直接调用 ComfyUI 的 `/prompt`、`/history`、`/view`。
- **codex 一直失败**：`docker compose exec cs-agent codex exec --skip-git-repo-check -s read-only "hi"`，看具体报错（auth、sandbox、网络）。
- **会话卡住**：重启容器后，未完成的消息会从 `agent.sqlite` 按会话内顺序继续处理：任务从最后完成的阶段继续（已生成的图片、已拿到的 codex 回答不会重新生成），已发出的回复不会重发；发送结果不确定（uncertain）的票据不会自动重发。任务失败且没有回复时，系统发一条兜底回复。日志关键字：`message routed`、`ticket task settled`、`reply sent`。
- **生图前缀没生效**：确认消息开头就是前缀（前面只能有空白或 @机器人），全/半角与 `IMAGE_PREFIXES` 完全一致；日志 `message routed` 的 `route` 字段显示分流结果。

## 7. codex 权限

codex 以 `-s workspace-write` 运行，命令由它自带的 bwrap 沙箱执行。受管 `config.toml` 中的相关设置：

```toml
[sandbox_workspace_write]
network_access = true                                              # CODEX_SANDBOX_NETWORK
writable_roots = ["/workspace", "/data/prompts", "/data/workflows"] # CODEX_WRITABLE_ROOTS
```

- **前提**：bwrap 需要非特权用户命名空间。Docker 默认的 seccomp 配置阻止 `CLONE_NEWUSER`，所以在 `docker-compose.yml` 加 `security_opt: [seccomp=./docker/seccomp-codex.json]`（Docker 默认 profile + 仅放开命名空间/挂载相关系统调用）之前，codex 在容器里**任何命令都无法执行**。
- **身份**：容器进程与 codex 命令都以 `node`（uid 1000）运行。
- **写入**：只能写 `/workspace`、`/data/prompts`（提示词目录；`system.md` 已弃用）、`/data/workflows`（生图工作流），以及 codex 默认可写的 `/tmp`。`/data` 本身、`/data/codex`（auth.json、sessions）、`/data/*.sqlite`、`/data/images` 都不可写；入口脚本先规范化每一项（合并重复的 `/`，去掉 `/./`、末尾的 `/.` 与 `/`），再与规范化后的 `DATA_DIR` / `CODEX_HOME` 比较，拒绝 `/`、`/data` 本身及其上级目录、`/data/codex` 及其子目录、`/data/images` 及其子目录、`*.sqlite`、任何含 `..` 或非法字符的项，并打印 `rejected CODEX_WRITABLE_ROOTS entry`（例如 `/data//`、`/data/.`、`/data/codex/.`、`/data/images//x` 都会被拒绝）。
- **工作流**：`/data/workflows/` 不存在时，启动会从镜像的 `/app/workflows/` 复制一份（已存在则绝不覆盖）。默认 `COMFY_WORKFLOW_FILE=/data/workflows/qwen-image-2.1-turbo-api.json`。旧值 `/app/workflows/…` 仍然有效，只是 codex 改不了那份。
- **网络**：命令可以联网（`network_access = true`），因此能直接访问宿主机的 ComfyUI `host.docker.internal:8188`（无鉴权，可以提交任务、读取输出）。NapCat（3000/3001）需要 Bearer token，codex 拿不到。
- **规则文件**：codex 从 `$CODEX_HOME/AGENTS.md`（`/data/codex/AGENTS.md`，受管、命令只读）读取全局规则，再叠加工作区的 `/workspace/AGENTS.md`。全局规则里的“只读写下列目录”按入口脚本导出的 `CODEX_EFFECTIVE_WRITABLE_ROOTS`（规范化、校验后的 `CODEX_WRITABLE_ROOTS`）渲染：默认列出 `/workspace`、`/data/prompts`（提示词目录）、`/data/workflows`（ComfyUI 工作流 JSON）；`CODEX_WRITABLE_ROOTS` 去掉 prompts 后规则里也不再提它。
- **读取（deny_read）**：入口脚本每次启动重写 `/etc/codex/requirements.toml`（镜像内 `/etc/codex` 归 node 所有；写不进去时容器以退出码 1 退出）：

  ```toml
  [permissions.filesystem]
  deny_read = ["/data/codex/auth.json", "/data/codex/.credentials.json", "/data/codex/sessions", "/data/codex/archived_sessions",
    "/data/codex/history.jsonl", "/data/codex/log", "/data/codex/shell_snapshots", "/data/codex/memories",
    "/data/codex/*.sqlite*", "/data/*.sqlite*", "/data/images", "/data/codex-session.json*", "/data/codex-threads.json"]
  ```

  codex 0.163 只认系统级 `requirements.toml` 里的这个键（放在 `$CODEX_HOME/requirements.toml` 不生效；`config.toml` 的 `[permissions.<profile>]` 与 `sandbox_mode` 互斥，cs-agent 每轮要用 `-c sandbox_mode=…`）。命中的路径在 bwrap 里被空文件/空目录覆盖，`workspace-write` 与 `read-only` 都生效；glob 在每条命令启动时展开，所以之后新建的 `*.sqlite` 也会覆盖。不能整个禁读 `/data/codex`：codex 的 arg0 辅助程序在 `/data/codex/tmp`，整目录禁读时 codex 拒绝启动沙箱。`/data/codex/config.toml`、`/data/codex/AGENTS.md`、`skills/` 仍可读（不含秘密）。
- **凭据**：codex 子进程的环境变量走白名单（PATH/HOME/LANG/TERM/TZ/代理变量），不含 NapCat token、API key 等任何秘密。codex 执行的命令读不到 `/data/codex/auth.json`（见上）。
- **QQ**：codex 没有发送 QQ 消息的能力，回复只经 cs-agent 的 agent 任务发回原会话（目标来自票据，codex 无法指定）。
- **实测**（`cs-agent:g1`，`codex sandbox -c sandbox_mode="workspace-write"`，seccomp=docker/seccomp-codex.json；unconfined 结果相同）：uid 1000；`/workspace`、`/data/prompts`、`/data/workflows`、`/tmp` 可写；`/data`、`/data/codex`、`/data/images`、`/data/qq-messages.sqlite` 写入被拒；`host.docker.internal:8188/system_stats` 返回 200，NapCat `:3000` 无 token 返回 403，公网 200；`CODEX_SANDBOX_NETWORK=false` 时三者都失败（EPERM / EAI_AGAIN）；沙箱内环境变量中没有 token / API key。默认 seccomp 下 bwrap 报 `No permissions to create a new namespace`。
- **实测 deny_read**（`cs-agent:g1fix`，`--security-opt seccomp=./docker/seccomp-codex.json --user node -w /workspace`，假数据卷）：`codex sandbox -c sandbox_mode="workspace-write" -- cat <路径>` 对 `/data/codex/auth.json`、`sessions/**`、`/data/codex/state_5.sqlite(-wal)`、`/data/agent.sqlite`、`qq-bridge.sqlite`、`qq-messages.sqlite(-wal)`、`observability.sqlite`、`/data/images/**`、`/data/codex-session.json` 均为 `Permission denied`；`cp` 到工作区、软链接后读取同样被拒，硬链接到 `/data/workflows` 报 `Invalid cross-device link`；`python3 open()` 报 `PermissionError`；`read-only` 模式同样被拒；`/data/codex/config.toml` 可读；`/workspace`、`/data/workflows`、`/data/prompts` 可写，`/data/codex`、`/etc/codex` 只读。
- 关闭联网：`.env` 中设 `CODEX_SANDBOX_NETWORK=false` 后重启（web_search 是 codex 服务端的工具，不受影响）。
