# cs_agent 部署手册

Compose 核心服务：`napcat`（QQ，OneBot v11）与 `cs-agent`（Inbox / ThreadHost → 执行 agent → `send_message` 回到 QQ）。系统如何工作见 [ARCHITECTURE.md](ARCHITECTURE.md)，面板见 [DASHBOARD.md](DASHBOARD.md)。

另有 `datasette` 只读浏览器和可选的 `gmail-sidecar` 邮件 MCP 服务；Gmail 与 cs-agent 共用镜像、独立持有凭据，不发布宿主机端口，首次授权与启动顺序见 [GMAIL-SIDECAR.md](GMAIL-SIDECAR.md)。Gmail 默认不启动；在 `.env` 设置 `COMPOSE_PROFILES=gmail` 后，普通 `docker compose up -d` 会包含它，也可通过 `docker compose --profile gmail up -d` 启用。只有启动 sidecar 才要求有效的 `GMAIL_SIDECAR_TOKEN`，未配置 Gmail 不影响其他服务的 Compose 解析、构建与启动。

## 0. 使用方式

- **消息**：私聊直接发，群里 @ 机器人；群里没 @ 的消息只作上下文。整条交给执行 agent（`AGENT_BACKEND`，默认 codex）。
- **顺序**：每个群/私聊一个常驻线程：空闲时开一轮；同一发送者在回合进行中的新消息插话进当前回合，其他人的消息与定时任务排队到本轮结束。不同会话并行（进行中的回合数 ≤ `AGENT_CONCURRENCY`）。
- **回复**：只有模型调用 `send_message` 发出的内容用户才能看到；模型没发消息不兜底，只有出错时会收到一条提示。
- **长任务**：模型会先告知、派子 agent 去做并结束本轮，子 agent 完成后再汇报。
- **生图**：cs-agent 不提供生图工具；codex 后端可用其内置生图出图，pi 后端不能生图。

## 1. 宿主机前置条件

1. **Docker Desktop**（Windows），能使用 `host.docker.internal`；构建需要 BuildKit（Docker Desktop 与 `docker compose build` 默认启用，旧版 `docker build` 需 `DOCKER_BUILDKIT=1`）。
2. **NapCat**：默认作为 Compose 服务运行（§4）。首次需扫码。
3. **模型出站**：默认经宿主机 magpie（§3），需要一把 gateway key。仅 `CODEX_PROVIDER=openai` 直连时需要容器内 ChatGPT 凭据（§3.3）。

## 2. 配置

```powershell
# 仅首次安装时复制；已有 .env 不覆盖。
Copy-Item .env.example .env
# 编辑 .env：CODEX_MAGPIE_KEY、NAPCAT_TOKEN、NAPCAT_WEBUI_TOKEN、DEEPSEEK_API_KEY（或 DEEPSEEK_APIKEY），确认 QQ_ALLOW_USERS / QQ_ALLOW_GROUPS / QQ_OWNER
```

`.env` 只是初始默认值：后端、模型、思考档位、发送规则、告警在面板设置页修改后持久化到 `data/settings.json`，从下一个回合起生效。关键变量（完整列表见 `.env.example` 与 `src/config.ts`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAPCAT_HTTP_URL` / `NAPCAT_WS_URL` | `http://napcat:3000` / `ws://napcat:3001` | Compose 内网；不允许内嵌用户名密码 |
| `NAPCAT_TOKEN` | 空 | HTTP/WS 共用的 OneBot Bearer token；播种脚本要求非空 |
| `NAPCAT_WEBUI_TOKEN` / `NAPCAT_WEBUI_PORT` | 空 / 6099 | NapCat WebUI 口令（仅 `webui.json` 不存在时生效）与宿主机回环端口 |
| `QQ_BOT_ACCOUNT` | 空 | 可选，传给 NapCat `ACCOUNT` 快速登录；首次仍需扫码 |
| `QQ_ALLOW_USERS` / `QQ_ALLOW_GROUPS` | 空 | 允许的用户（任何地方可触发，逗号分隔或 `*`）/ 群（成员需 @） |
| `QQ_OWNER` | `QQ_ALLOW_USERS` 首项 | owner QQ 号，逗号分隔可填多个账号：同一人，共享 owner 私聊线程与权限；首项为主账号 |
| `AGENT_BACKEND` / `AGENT_BACKEND_OVERRIDES` | `codex` / 空 | 缺省后端与按会话覆盖（`group:200000001=pi,private:10001=codex`，格式错误启动失败）。owner 线程按 `QQ_OWNER` 首个账号的 `private:` 项；切换在会话空闲且旧后端没有后台工作后生效 |
| `AGENT_CONCURRENCY` | 2 | 同时进行中的回合数上限；插话不占名额 |
| `CODEX_PROVIDER` / `CODEX_MAGPIE_URL` / `CODEX_MAGPIE_KEY` | `magpie` / `http://host.docker.internal:3425/v1` / 空 | 见 §3 |
| `CODEX_MODEL` / `CODEX_REASONING_EFFORT` | `codex/gpt-6.1-sol` / `high` | codex 缺省模型（必须是 magpie 目录中的完整 slug）与缺省档位 |
| `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID` | `deepseek` / `deepseek-flash` | pi 与日/周摘要的模型；经 magpie 时设 `magpie` / `deepseek/deepseek-flash`（§3.2）；也可 `openai-codex`、`openai`、`anthropic`（后两者需 `*_API_KEY`） |
| `AGENT_THINKING_LEVEL` | `low` | pi 缺省思考档位；模型不支持的档位就近调整并告警 |
| `AUTO_EFFORT_MODEL` / `AUTO_EFFORT_TIMEOUT_MS` | `deepseek/deepseek-flash` / 4000 | `auto` 档位的分类模型（magpie 提供者下）；空值只走规则快路径 |
| `MEMORY_EXTRACT_MODEL` | 同 `AUTO_EFFORT_MODEL` | 回合后记忆抽取的模型（magpie 提供者下，[MEMORY-DESIGN.md](MEMORY-DESIGN.md) §8）；两者都为空或不在目录中时不抽取（面板记 `no_model`）。各命名空间的开关在面板设置页 |
| `MEMORY_EXTRACT_TIMEOUT_MS` | 20000 | 单次抽取的模型超时；超时放弃本轮，不重试 |
| `DEEPSEEK_API_KEY` | 空 | 也可写作 `DEEPSEEK_APIKEY`。provider 为 `deepseek` 时缺失即启动失败；pi 的联网检索始终需要它 |
| `SKILLS_DIR` / `PI_SKILLS_DIR` | `./data/skills` / 空 | 共享技能目录（宿主机路径，可指向 magpie Library 的 skills 目录，Windows 写 `C:/…`）；`PI_SKILLS_DIR=off` 关闭 pi 的技能段 |
| `COMPOSE_PROFILES` | 空 | 填 `gmail` 启用 Gmail sidecar，之后普通 `docker compose up -d` 即包含它；也可用 `--profile gmail` |
| `GMAIL_SIDECAR_TOKEN` | 空 | 启动 sidecar 时必填：至少 32 字符的无空白 ASCII 随机串，sidecar 静态 Bearer |
| `GMAIL_SIDECAR_AUTH_HEADER` | 空 | `Bearer <同一个串>`，Pi MCP `secretHeaders` 引用，注入 cs-agent |
| `PI_MCP_CONFIG` | 空 | Pi 外部 MCP 管理员 JSON 配置绝对路径；留空禁用。Streamable HTTP、静态凭据、owner 私聊，见 [PI-MCP.md](PI-MCP.md) |
| `ATTACH_FILE_MAX_MB` / `ATTACH_FILES_MAX` / `ATTACH_FILE_DENY_EXT` | 20 / 3 / `.exe,.bat,…,.lnk` | 发送文件的单个上限、每条数量与扩展名黑名单 |
| `CODEX_SANDBOX` | `workspace-write` | `workspace-write` 或 `read-only`；`danger-full-access` 无法做会话隔离，codex 回合会被拒绝执行 |
| `TZ`（compose） | `Asia/Shanghai` | 影响衰老任务时刻与聊天记录里显示的时间 |

codex app-server 只拿到最小环境变量（PATH、HOME、LANG/LC_ALL、TERM、TZ、`CODEX_HOME`、`NO_COLOR=1`、设置了的代理变量）；`NAPCAT_TOKEN`、`*_API_KEY`、`OBS_TOKEN` 不会传给 codex；magpie 模式只额外注入 `CODEX_MAGPIE_KEY`。

## 3. 模型出站：magpie

codex 与 pi 的模型调用默认都经宿主机 magpie 网关（`CODEX_MAGPIE_URL` / `CODEX_MAGPIE_KEY` 两者共用），用量在 magpie Usage 页按 key 名 `cs-agent` 归集。pi 的联网检索（DeepSeek Search/Fetch）是 DeepSeek 专有接口，magpie 不代理，始终直连。

### 3.1 宿主机侧

1. magpie Settings → **Share on local network** 打开局域网共享。
2. `magpie gateway-key add cs-agent`，把 key 填进私有 `.env` 的 `CODEX_MAGPIE_KEY`；`magpie gateway-key models <id> 'codex/*'` 限定可用模型（pi 也经 magpie 时再放开 `deepseek/*`）。不要把真实 key 写进文档或提交。
3. Settings → Network and sharing → Allowed addresses 填 Docker 网段（如 `172.20.0.0/16`）；防火墙只对 Docker 虚拟网卡放行 3425。

**NAT 例外**：Docker Desktop 下容器访问 `host.docker.internal` 被 magpie 视为回环，无 key 的请求也能成功，Allowed addresses 也不起作用。这条路径上 key 只用于归集用量与限定模型，不是访问控制；codex 命令沙箱可联网，因此命令能直接访问网关、绕过 key 的模型限制。可选加固：magpie 以 `MAGPIE_ADDR=<LAN 网卡 IP>:3425` 启动并把 URL 指向该 IP（本机其他调用也需要 key）。

### 3.2 cs-agent 侧

- **codex**：受管 `config.toml` 写入 `model_provider = "magpie"` 与 `[model_providers.magpie]`（`wire_api = "responses"`、`env_key = "CODEX_MAGPIE_KEY"`、`supports_websockets = false`、`model_catalog_url = <URL>/codex/models`）。key 只经进程环境注入、注册脱敏，不落盘。`CODEX_MAGPIE_URL` 只接受安全字符组成、不含凭据/查询/片段的 HTTP(S) URL。主进程构造 CodexRunner 时检查 key，缺失即启动失败（「配置无效：CODEX_PROVIDER=magpie 需要 CODEX_MAGPIE_KEY」）；MCP 进程的基础配置不要求 key。
- **模型名**：`CODEX_MODEL` 与面板的 `codexModel` 必须与 `GET <URL>/codex/models` 的 `slug` 完全一致（如 `codex/gpt-6.1-sol`），不省略、不自动补前缀：codex 按完整 slug 查模型元数据，短名即使能被网关路由也会落到默认窗口与能力。目录可用时，不在目录中的值告警并显示「不在目录中」，新回合回退到 `CODEX_MODEL`，再不行用内置 `codex/gpt-6.1-sol`；目录不可用时沿用配置值。
- **pi**：`AGENT_MODEL_PROVIDER=magpie`、`AGENT_MODEL_ID=deepseek/deepseek-flash`。启动时拉一次 `<URL>/models`（失败重试 5 次、间隔 3 s，仍失败则启动失败，靠 restart 策略等 magpie 起来），日志 `pi models via magpie {base_url, models}`。换模型清单需重启。
- 设置页只读显示两边的出站方式；健康检查在 magpie 模式只确认 key 已配置，不探测远端。

### 3.3 直连回退（`CODEX_PROVIDER=openai`）

设 `CODEX_PROVIDER=openai`，准备容器内 ChatGPT 凭据，重建/重启。入口脚本会移除 magpie 段，runner 不再注入 magpie key。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\init-auth.ps1   # 复制 ~/.codex/auth.json 到 ./data/codex/auth.json，不打印 token
docker compose run --rm cs-agent codex login --device-auth         # 或在容器内登录（CODEX_HOME=/data/codex）
```

入口脚本带参数时先准备目录与 `config.toml` 再 `exec` 该命令，可用于一次性命令（如 `codex --version`）。`AGENT_MODEL_PROVIDER=openai-codex` 时 pi 也使用这份 `auth.json`。refresh_token 会轮换：容器刷新后写回 `./data/codex/auth.json`，宿主机那份可能随之失效（反之亦然）；agent 写回前会重读文件，若 codex 已刷新则采用文件里的新 token，但两者不共享文件锁。出现鉴权失败时重跑 `init-auth.ps1` 或 `codex login --device-auth`。

## 4. NapCat 容器

| 服务 | 容器监听 | 宿主机发布 | 用途 |
|---|---|---|---|
| NapCat HTTP / WS | `0.0.0.0:3000` / `0.0.0.0:3001` | 不发布 | cs-agent 调动作 / 收事件（同一 Bearer token，`messagePostFormat: array`） |
| NapCat WebUI | `6099` | `127.0.0.1:${NAPCAT_WEBUI_PORT:-6099}` | 登录、扫码与配置 |
| cs-agent HTTP | `0.0.0.0:8787` | `127.0.0.1:8787` | 面板与 `/healthz` |

镜像 `mlikiowa/napcat-docker` 按 index digest 固定（镜像标签与 NapCat 版本号不对应），`NAPCAT_UID/GID=1000`，固定 `mac_address: 02:42:ac:11:00:02`（减少设备指纹变化，升级时不要改 MAC 或删 QQ 数据目录），不设 `MODE`。cs-agent 用普通 `depends_on: [napcat]`，不等健康状态；未登录时由 WS 重连等待。NapCat 健康检查（curl `127.0.0.1:6099`）只代表 WebUI 就绪，不代表 QQ 已登录。

### 4.1 首次登录

1. `.env` 设非空 `NAPCAT_TOKEN`；为 `NAPCAT_WEBUI_TOKEN` 生成独立随机口令（`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`）；可选 `QQ_BOT_ACCOUNT`。
2. 播种 OneBot 配置：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/napcat-config.ps1`（PowerShell 5.1 / 7；在仓库外运行时加 `-Root <仓库目录>`）。脚本读 `.env` 的两个键（支持单行引号与行尾注释，不展开变量；含 `$`、`#` 的 token 用单引号）；生成 `onebot11.json`，账号非空时另写 `onebot11_<QQ号>.json`。
3. `docker compose up -d napcat`，`docker compose logs -f napcat` 等 WebUI 就绪；打开 `http://127.0.0.1:6099/webui` 用 WebUI 口令登录并扫码。
4. 确认账号（口令从容器环境读取）：

   ```powershell
   docker compose exec cs-agent node -e "fetch('http://napcat:3000/get_login_info',{headers:{Authorization:'Bearer '+process.env.NAPCAT_TOKEN}}).then(r=>r.json()).then(console.log)"
   ```

5. 启动 cs-agent，发一条私聊确认收发，在面板 `/live` 检查事件。

**同一账号只能连一个 NapCat**：同一 QQ 号在别处（如宿主机 QQNT 注入的 NapCat）登录时，容器端登录会把它挤下线，而宿主机启动器可能立即重拉。从宿主机 NapCat 迁移时：容器扫码后**立即**把 cs-agent 切到 `napcat:3000/3001`（`docker compose up -d --no-deps cs-agent`），再停掉宿主机 NapCat 的根进程与自启动项，避免双响应。

### 4.2 配置、数据与口令

- `./napcat/config` → `/app/napcat/config`（OneBot 配置、`webui.json`）；`./napcat/qq` → `/app/.config/QQ`（登录态）。整个 `napcat/` 在 `.gitignore`，备份时两目录一起保管。聊天记录在 cs-agent 自己的 `data/` 里，不依赖 NapCat。
- 播种脚本幂等：受管服务 `agent-http` / `agent-ws` 的 token 一致时打印 `unchanged`、不写文件；不同则先备份为 `*.bak-<UTC时间戳>`，只替换 token 字段，其余字段、编码、BOM、换行保留。缺 token、账号非法、JSON 损坏或缺受管服务时退出，不覆盖。
- 轮换 `NAPCAT_TOKEN`：维护窗口内停 NapCat、改 `.env`、重新播种，再重建 NapCat 与 cs-agent。WebUI 口令只能在 WebUI 里改。

### 4.3 更新镜像与回退

更新：备份两个目录 → `docker buildx imagetools inspect mlikiowa/napcat-docker:latest` 取新 index digest → 改 `docker-compose.yml` 的 digest 与日期注释 → `docker compose pull napcat && docker compose up -d napcat`。保留旧 digest 供回退；更新后核实镜像内仍有 curl（健康检查依赖）。

回退到宿主机 NapCat：`docker compose stop napcat`，把两个 URL 改为 `http://host.docker.internal:3000` / `ws://host.docker.internal:3001`，确认宿主机 OneBot token 与 `.env` 一致，`docker compose up -d --no-deps cs-agent`（必须 `--no-deps`，否则会拉起容器 NapCat），再启动宿主机 NapCat。

## 5. 启动与健康检查

```powershell
docker compose up -d --build
docker compose logs -f            # 一行一个 JSON 的结构化日志（不含 token）
docker compose ps                 # HEALTH 列
docker compose exec cs-agent node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)"
```

`/healthz`（无需口令）返回：`ws_connected`（离线时 HTTP 503，容器 unhealthy）；`codex`（magpie 模式检查 key 已配置，直连检查 `auth.json`；列出各会话线程 id）；`pi.threads`（数量与键）；`context_usage`；`degraded`（观测降级）。不返回服务地址、错误原文或凭据。

**卷权限**：容器以 `node`（uid 1000）运行，`./data`、`./workspace` 须可写；入口脚本与 agent 启动时写删探针文件，不可写则以退出码 1 退出。Linux 宿主机可 `sudo chown -R 1000:1000 data workspace`。

## 6. 数据卷

| 路径 | 内容与运维说明 |
|---|---|
| `./data/agent.sqlite` | 宿主 harness：会话宿主文档、授权表、定时任务（崩溃后自动恢复） |
| `./data/pi.sqlite`（+WAL）/ `pi-threads.json` | pi 长期会话与子 agent；JSON 是 SQLite 映射的原子镜像，丢失时启动重建。**不要单独删 JSON 当作清空记忆**；备份须含数据库、WAL 与映射 |
| `./data/qq-bridge.sqlite` | 入站输入（含附件 URL/file id，按聊天附件敏感信息保管）、Outbox、去重、发送规则计数与熔断；旧版 `tickets` 表留在磁盘上，不再读写 |
| `./data/qq-messages.sqlite`（+WAL） | 消息库与摘要，**按聊天记录保管**。清空：停容器后删除 `qq-messages.sqlite*`，启动重建 |
| `./data/memory.sqlite`（+WAL）、`./data/memory/<ns>/profile.md` | 记忆条目与各会话画像（ns 的冒号换下划线）；对 codex 命令与 pi 文件工具禁读，只经记忆工具与面板读写 |
| `./data/observability.sqlite`（+WAL） | 观测事件与指标；备份用 SQLite 一致性备份或含 WAL |
| `./data/codex/` | `CODEX_HOME`：受管 `config.toml`（手改会被覆盖，改 `.env` 后重启）、生成的 `AGENTS.md`（不要手改，编辑 `prompts/codex.md`）、`base-instructions/`、sessions、trace、`generated_images/`、`auth.json`（仅直连） |
| `./data/codex-threads.json`、`codex-threads-archive.jsonl` | 每个会话一条 codex 线程；重置请用面板（空闲时归档并清除，下一轮新建） |
| `./data/prompts/` | `codex.md`（codex 行为指引，首次播种，面板可编辑，保存后下次加载线程生效）、`agent.md`（pi 提示词，缺失才播种，每次模型请求热加载）、`codex-base/<slug>.md`（每模型基础指令，可在设置页「恢复目录默认」）。`system.md` 已弃用不再读取 |
| `./data/settings.json` | 面板运行时设置；读取时剥离已废弃的 `codexReplyMode` |
| `./data/context-usage.json` | 每线程上一轮输入占用（250 ms 防抖原子写，突发退出可能丢最后一次） |
| `./data/skills/`（`SKILLS_DIR`） | 共享技能，挂到 `/data/skills` 与 `/data/codex/skills/shared`（容器读写；agent 沙箱只读，经 `skill_publish` 写入） |
| `./data/incoming/<入站键>/` | 触发消息的参考图，7 天清理；对 codex 命令禁读 |
| `./data/images/<会话键>/outbox/` | `send_message` 的图片与文件副本，回合结束清理一小时前且已发完的 |
| `./data/media/` | 按需召回的聊天图片，随原始消息保留，每日 GC 无引用文件 |
| `./data/files/`、`./data/tickets/`、`./data/images/<旧版键>/` | 旧版遗留目录，不再写入，可删除；仍在禁读名单 |
| `./data/pi-work/<键>/` | pi 会话工作区；可放会话层 `AGENTS.md` |
| `./workspace/` | codex 会话工作区父目录；运维可维护 `AGENTS.override.md` / `AGENTS.md`，拼入每个会话的受管文件 |
| `./workspace/<键>/AGENTS.md` | **受管规则文件**（首行 `<!-- cs-agent-managed-workspace-agents v1 -->`），加载线程时生成，改动会被覆盖 |
| `./secrets/gmail/` | Google 桌面客户端 `client.json` 与授权 `token.json`；只挂入 Gmail sidecar，客户端文件只读，token 原子写入、0600；不可移入 `data/` |
| `./data/gmail-sidecar/` | Gmail `sent.json` 幂等回执（保留 7 天），不含 OAuth 凭据；随备份保留，勿在运行时删除 |
| `./napcat/` | NapCat 配置与登录态（§4.2） |

旧 `.env` 中残留的 `COMFY_*`、`IMAGE_PREFIXES`、`CODEX_IMAGE_GEN`、`IMAGE_COLLECT_EXTENSIONS`、`IMAGE_GEN_MCP_WAIT_SEC`、`CODEX_REPLY_MODE` 已不再读取，可删除。

## 7. codex 配置

受管 `config.toml` 由入口脚本每次启动按环境变量重写：provider（§3.2）、`model` / `model_reasoning_effort` 缺省值（每轮被 `turn/start` 覆盖）、`web_search`、`[features]`、`[mcp_servers.im]`、`[mcp_servers.qq_context]`、可选 `[mcp_servers.browser]`、`[sandbox_workspace_write]`。线程令牌不写在这里，由 cs-agent 按线程注入。

- **Apps 与插件**：始终 `[features] apps = false`（否则每轮附带约 14 万 token 的 ChatGPT Apps 工具定义，且群聊回合也能调用主人账号的连接器）。`CODEX_REMOTE_PLUGINS=off`（默认）写入 `plugins = false` 与 `remote_plugin = false`，避免启动时同步插件市场与技能扫描竞态导致线程启动失败；`.system` 内置技能仍可用。`CODEX_PLUGIN_PRUNE`（默认 `figma,gmail`，`all` 清空，空串不清）每次启动删除对应远程插件缓存并清理安装暂存目录，不触碰 `skills/shared` 与 `.system`。
- **子 agent**：`multi_agent = true`、`wake_on_agent_messages = true`。
- **联网**：`CODEX_WEB_SEARCH=live|cached|disabled`，`CODEX_WEB_SEARCH_CONTEXT=low|medium|high`。web_search 是服务端工具，不受命令沙箱联网开关影响。
- **浏览器**：`CODEX_BROWSER=playwright`（默认）注册 `@playwright/mcp`（`--headless --isolated --browser chromium --blocked-origins <宿主机与内网地址> --sandbox`，Chromium 在 `/opt/pw-browsers`，每次会话临时 profile）。`enabled_tools` 白名单只开 22 个工具，排除 `browser_run_code_unsafe`（可在 MCP 进程里执行任意 JS、读出 `auth.json`）、`browser_file_upload`、`browser_drop`；`file:` 由 playwright-mcp 自带拦截与 Chromium 拒绝（`--blocked-origins` 表达不了 `file:`）。Chromium 沙箱需 compose 的自定义 seccomp profile，默认 seccomp 下设 `PLAYWRIGHT_NO_SANDBOX=1` 退回无沙箱；`CODEX_BROWSER=none` 不注册浏览器。升级 `@playwright/mcp` 或 codex 后用 `scripts/verify-browser-mcp.mjs` 复测（挂假的 `/data`，全部通过退出码 0）。
- **MCP 审批**：`CODEX_MCP_APPROVAL_MODE=approve`（默认）。线程以 approval policy `never` 运行，需要审批的 MCP 调用会直接失败，`auto` 在实测中仍会要求审批，所以默认 `approve`。
- **线程**：每个会话一条线程，全部由同一个常驻 app-server 承载；日志 `codex thread created / rotated / missing / resume failed` 带 `key`。安全阀 `CODEX_ROLLOUT_MAX_MB`（50）、`CODEX_THREAD_MAX_DAYS`（90）。
- **升级 codex**：`wake_on_agent_messages` 仍在开发中；升级镜像里的 `@openai/codex` 前须复测子 agent 完成后能唤醒主 agent（[ARCHITECTURE.md](ARCHITECTURE.md) §4.3）以及浏览器白名单。

### 7.1 Codex trace 与内置生图输出清理

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `CODEX_TRACE_RETENTION_DAYS` | 14 | 官方 rollout trace（runner 设置 `CODEX_ROLLOUT_TRACE_ROOT=$CODEX_HOME/trace` 启用，记录请求/响应、工具与压缩事件）保留天数；0 关闭 trace 与按天清理 |
| `CODEX_TRACE_MAX_MB` | 512 | trace 总量上限；0 不限 |
| `CODEX_GENERATED_IMAGES_RETENTION_DAYS` | 7 | 内置生图输出（`$CODEX_HOME/generated_images/<线程>/`）保留天数；0 关闭按天清理 |
| `CODEX_GENERATED_IMAGES_MAX_MB` | 1024 | 内置生图输出总量上限；0 不限 |

清理沿用观测库每日任务（首次约在启动 60 秒后，此后至少间隔 24 小时；观测降级时不执行）：先删超过保留期的普通文件，再按 mtime 从旧到新删到不超限；不跟随链接，删除前以 realpath 核验根目录，只移除空子目录。`send_message` 发出的图片已复制到 Outbox 副本，清理原图不影响发送。

## 8. codex 权限

命令由 codex 自带的 bwrap 沙箱执行，以 `node`（uid 1000）运行。

- **前提**：bwrap 需要非特权用户命名空间，Docker 默认 seccomp 阻止 `CLONE_NEWUSER`；compose 用 `security_opt: [seccomp=./docker/seccomp-codex.json]`（Docker 默认 profile + 仅放开命名空间/挂载相关系统调用），否则 codex 在容器里任何命令都无法执行。
- **写入**：受管 `[sandbox_workspace_write] writable_roots`（`CODEX_WRITABLE_ROOTS`，入口脚本默认 `/workspace,/data/prompts,/data/codex/skills/shared`）只是上限；每个线程的命名权限再收窄：owner 线程为 `/workspace/owner`、`/data/prompts`、`/data/codex/skills/shared`，其他会话只有本会话目录，`read-only` 没有可写根。入口脚本规范化每一项后拒绝 `/`、`/data` 及其上级、`/data/codex*`、`/data/images*`、`/data/files*`、`/data/incoming*`、`/data/tickets*`、`*.sqlite`、含 `..` 的项（日志 `rejected CODEX_WRITABLE_ROOTS entry`）。
- **读取（deny_read）**：入口脚本每次启动重写 `/etc/codex/requirements.toml`（写不进去则退出）：

  ```toml
  [permissions.filesystem]
  deny_read = ["/data/codex/auth.json", "/data/codex/.credentials.json", "/data/codex/sessions", "/data/codex/archived_sessions",
    "/data/codex/history.jsonl", "/data/codex/log", "/data/codex/trace", "/data/codex/shell_snapshots", "/data/codex/memories",
    "/data/codex/*.sqlite*", "/data/*.sqlite*", "/data/logs", "/data/obs-token", "/data/obs-token.*.tmp", "/data/images", "/data/files",
    "/data/media", "/data/memory", "/data/incoming", "/data/tickets", "/data/codex-session.json*", "/data/codex-threads.json"]
  ```

  codex 只认系统级 `requirements.toml` 里的这个键（`$CODEX_HOME/requirements.toml` 无效，`[permissions.<profile>]` 与 `sandbox_mode` 互斥）。命中路径在 bwrap 里被空文件/空目录覆盖，glob 在每条命令启动时展开。不能整个禁读 `/data/codex`（arg0 辅助程序在 `/data/codex/tmp`）；`config.toml`、`AGENTS.md`、`skills/` 可读，不含秘密。另外其他会话工作区、`/data/pi-work`、`/data/codex/trace` 对命令不可读。
- **网络**：`CODEX_SANDBOX_NETWORK=true`（默认）命令可联网，因此也能访问宿主机经 `host.docker.internal` 暴露的服务（见 §3.1 NAT 例外）。NapCat 需要 token，codex 拿不到。设 `false` 关闭。
- **规则文件**：受管 AGENTS.md 里"只读写下列目录"按实际权限渲染；它只约束模型行为，访问控制由沙箱执行。

## 9. pi 后端

部署时设 `AGENT_BACKEND=pi`，或 `AGENT_BACKEND_OVERRIDES=group:200000001=pi` 只覆盖指定会话，也可在面板设置页修改；改回 codex 使用原 codex 线程，两后端记忆各自独立。

| 配置 | 默认 | 作用 |
|---|---|---|
| `PI_COMPACTION_RESERVE_TOKENS` | 16384 | 上下文超过"模型窗口 − 此值"时阻塞压缩 |
| `PI_COMPACTION_BACKGROUND_TOKENS` | 32768 | 距阻塞阈值此 token 数时开始后台压缩；0 关闭后台压缩 |
| `PI_ARCHIVE_RETENTION_DAYS` | 90 | 退休会话目标保留期；pi-durable 1.3.0 没有删除会话 API，目前只校验，`pi.sqlite` 大小不保证有界 |

- 阈值公式（pi-durable `CompactionPolicy`）：阻塞位置 = 窗口 − reserve；后台位置 = 窗口 − reserve − background；以 `tokens > 阈值` 判定。deepseek-flash 窗口 1,000,000 → 后台 950,848、阻塞 983,616。压缩保留最近 20,000 tokens，不轮换，不删除数据库原文。
- 提示词：`data/prompts/agent.md`（缺失时写入默认模板，已有不覆盖，热加载）→ 运维层 `/workspace/AGENTS.md` → 会话层 `/data/pi-work/<key>/AGENTS.md`（冒号换下划线），全部进入 system 消息。两层都用 ≤128 KiB 的 UTF-8 普通文件；链接、超限或不可读文件跳过并告警。
- 联网工具：DeepSeek Search 最多 8 条/2500 字，Fetch 最多 4000 字，仅 429 退避一次。`fetch_page` 只接受无凭据的公开 HTTP(S) URL 并拒绝解析到内网的地址，但实际抓取发生在 DeepSeek 服务器，服务端重定向不在本机控制范围。未配置 `DEEPSEEK_API_KEY` 时仅联网工具不可用。
- 线程重置：pi 把映射清空与归档写入同一次 `pi.sqlite` 事务，事务成功后重写 `pi-threads.json` 与 `pi-threads-archive.jsonl`（镜像失败只告警 `pi thread mirror stale; will retry`，之后从数据库重写）。codex 的 `codex-threads-archive.jsonl` 经文件串行队列原子替换。两份归档各保留最新 200 条。

## 10. 聊天记录

- **衰老任务**：每天 `HISTORY_SUMMARY_HOUR`（默认 3）点，按容器 `TZ`（compose 默认 Asia/Shanghai）。日志 `history aging done`（day_summaries / week_summaries / failed / purged_*）；模型失败只计数跳过，下次再试。
- **原文保留期**：`HISTORY_RAW_DAYS` 是全局缺省，默认 `0` = 永不清理原始消息；面板设置页"聊天记录保留"可按会话覆盖（`settings.json` 的 `history.rawDays`，0 = 永不，上限 3650）。保留天数大于 0 的会话按 [ARCHITECTURE.md](ARCHITECTURE.md) §9 在衰老任务中清理已被摘要覆盖的原文；日 / 周摘要的生成与 `HISTORY_SUMMARY_DAYS` 不受影响。
- **召回配置**：`MEDIA_RECALL_PORT=8790`（主进程仅监听 127.0.0.1，无需发布）；`MEDIA_RECALL_MAX_PER_TURN=5`（每回合；旧名 `MEDIA_RECALL_MAX_PER_TICKET` 仍可用）。
- **查看消息库**（容器内有 node，无需 sqlite3）：

```powershell
docker compose exec cs-agent node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/qq-messages.sqlite',{readOnly:true});console.table(d.prepare('select scope,message_id,datetime(time,\'unixepoch\') t,nickname,substr(text,1,40) text,action,status from messages order by time desc limit 20').all());console.table(d.prepare('select scope,level,date(period_start,\'unixepoch\') start,msg_count,substr(text,1,60) text from summaries order by period_end desc limit 10').all())"
# 列出 qq_context 的工具（工具调用需要主进程为某个线程签发的令牌，手工无法模拟）
docker compose exec cs-agent sh -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"cli\",\"version\":\"1\"}}}" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}" | node /app/dist/mcp/qq-context.js'
```

## 11. 观测面板

访问 `http://127.0.0.1:8787/`（Compose 只发布宿主机回环；面板只接受 localhost / 127.0.0.1 / [::1] 的 Host）。页面内容见 [DASHBOARD.md](DASHBOARD.md)。

- **口令**：始终要求。优先 `OBS_TOKEN`；留空则读 `DATA_DIR/obs-token`，缺失时生成 32 字节随机口令（0600，原子发布），只记一行日志不含口令。读取：`docker compose exec cs-agent cat /data/obs-token`。登录表单或 `/?token=` 认证后跳转到去掉口令的 URL 并设 HttpOnly、SameSite=Strict cookie。口令文件在 codex 禁读名单，`OBS_TOKEN` 不进 codex/MCP 环境。口令无法读取或生成时面板拒绝访问，业务照常。
- **保留**：普通事件与指标 `OBS_RETENTION_DAYS`（30），管理事件（`settings_changed`、`prompt_changed`、`thread_reset`、`@` 开头的键）`OBS_ADMIN_RETENTION_DAYS`（365，不受单键预算限制），记忆埋点数据 `OBS_MEMORY_RETENTION_DAYS`（90）。每个普通事件键默认最多 500 条（`OBS_EVENT_CAP`，8–10000；旧名 `OBS_TICKET_EVENT_CAP` 仍可用）、detail 256 KiB，为终态与丢弃摘要预留槽位。观测库列名（`events.key`、`recall_events.turn_id`）与旧库迁移见 [DASHBOARD.md](DASHBOARD.md) §9。
- **脱敏**：事件先脱敏再保存（已注册凭据、敏感字段、Bearer / API key / JWT、带凭据 URL），字符串最多 500 字；回合详情是诊断摘要，不是聊天归档。
- **降级**：观测库损坏、不可写或初始化失败时降级为无操作存储，`/healthz` 与总览显示 `degraded: true`，消息处理继续；修复后在维护时重启恢复采集。不要据空图表判断没有业务流量。
- **费用**：`DEEPSEEK_PRICE_IN_PER_M` / `DEEPSEEK_PRICE_OUT_PER_M`（默认 0）填入单价后估算 deepseek 用量费用（经 magpie 的 `deepseek/*` 也计入），不含搜索/抓页费用、不区分缓存优惠。codex 用量看 magpie Usage 页。
- **告警**：`ALERT_OWNER=false` 默认关闭。开启且有 owner 时，WS 连续离线超过 5 分钟、模型鉴权失败、连续三个回合失败、定时任务连续失败被自动暂停时私聊 owner（共用每 30 分钟一次限频）；发送规则熔断时另发一条通知。告警只带固定原因。
- **SQLite 浏览**：Compose 的 `datasette` 服务以只读挂载 `./data`，在 `http://127.0.0.1:${DATASETTE_PORT:-8001}/` 浏览六个库、跑只读 SQL（单条 5 秒、最多 1000 行）。无登录，只绑回环，不要改成局域网地址：库里有全部聊天记录与长期对话。官方镜像的 SQLite 3.34 读不了 pi-durable 的 STRICT 表，`docker/datasette.Dockerfile` 补装 `pysqlite3-binary`。`agent.sqlite`、`pi.sqlite` 的文档按基础版本 + 增量保存，这里只能看到原始 JSON。不需要时 `docker compose stop datasette`。
- **上下文占用**：启动时在面板开放前回填（codex 倒读 rollout 末尾至多 2 MiB 取最近 `token_count`；pi 从 harness 历史恢复）。codex 窗口来自模型目录的 `context_window`（`codex/gpt-6.1-sol` 为 500,000），失败回退 `CODEX_CONTEXT_WINDOW`（400,000），日志 `codex context window` 标明来源。重置或轮换后归零。

## 12. 残余风险

- **只把能信任使用这个工作区的人加入 `QQ_ALLOW_USERS` / `QQ_ALLOW_GROUPS`。** codex 命令读不到凭据、会话、数据库与图片，但 codex 进程本身持有凭据（直连时）；MCP 进程（`qq_context`、浏览器）不受命令沙箱约束。
- **浏览器 MCP 的网络**：可访问容器能到达的任何网络。`--blocked-origins` 覆盖宿主机与内网地址，但不拦截重定向、不看 DNS 解析结果（`127.0.0.1.nip.io`、DNS rebinding），也未列入 `napcat` 服务名（NapCat 仍靠 token）。需要时设 `CODEX_BROWSER=none`；真正的隔离需在网络层实施。
- **`/data/prompts` 对 owner 线程可写**（用户接受）：owner 会话的命令可改写提示词，pi 下次请求即生效；受管规则要求只在 owner 私聊明确要求时修改。若连 owner 也要禁止，需收紧 `codexWorkspacePolicy`，改 `CODEX_WRITABLE_ROOTS` 不够。
- **magpie key 不是访问控制**（§3.1）。
- **codex 不可持久**：容器或 app-server 重启会丢失进行中的回合与子 agent；长任务用 pi 更稳。
- **聊天记录**：群成员可让 agent 检索本群 30 天原始消息与 180 天摘要（与翻群记录一致）；只有 owner 私聊线程可检索全部会话。

## 13. 测试

```powershell
npm ci
npm run typecheck
npm test                  # 快速单元组（日常改动跑这个，约 1 分钟）
npm run test:integration  # 集成组：entrypoint、NapCat 配置、bwrap、MCP stdio 冒烟（globalSetup 先 npm run build）
npm run test:all          # 全部（合并前跑；等同 npx vitest run）
```

镜像构建命令在 Bash / WSL 执行，写入实际提交与 UTC 构建时间；Compose 构建从同名环境变量 `GIT_COMMIT` / `BUILD_TIME` 取值，未设置时分别为 `unknown` / 空。

```bash
docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) --build-arg BUILD_TIME=$(date -u +%FT%TZ) -t cs-agent:dev .
docker compose config
```

测试不访问真实 QQ 或模型；不要向真实群发测试消息。`test/napcat-config.test.ts` 优先用 `pwsh`，否则 `powershell`，都不可用则跳过；只在临时目录播种。检测到 Docker Compose 时另跑 `docker compose config --quiet`。

## 14. 排障

- **codex 一直失败**：先看日志里 app-server 的掉线与重启记录；再手动跑 `docker compose exec cs-agent codex exec --skip-git-repo-check -s read-only "hi"`（仅诊断用）看 auth、sandbox、网络报错。
- **app-server 掉线**：主进程按 1 s→60 s 退避重启并清理进程树。掉线时进行中的回合与子 agent 丢失，会话收到"处理中断了，需要的话请再说一次。"；后端不可用超过 2 分钟、输入无法投递时收到"现在暂时处理不了，请稍后再试。"。
- **会话卡住**：回合连续 30 分钟没有任何事件由看门狗中止并提示（同一会话 10 分钟内最多一条）。也可在面板会话行点"停止"，当前回合与子 agent 一起中止，排队消息随后照常处理。
- **重启后的恢复**：宿主先恢复回合（pi 续跑；codex 丢失的回合提示、不自动重放），Inbox 再按到达顺序重投 `queued` 输入；已发送或 uncertain 的消息不重发。
- **"发送过快"/熔断**：bridge 发送规则拒绝或熔断，在面板设置页查看与解除；被拒的消息不计数。
- **改了 AGENTS.md / codex.md / 技能但 codex 没反应**：已加载线程不一定重读，在面板重置该会话线程或重启容器。
- **NapCat 双响应**：同一账号同时连了两个 NapCat，见 §4.1。
