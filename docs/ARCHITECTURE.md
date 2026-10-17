# cs_agent 架构设计

> 主会话负责本文件与 `src/qq/types.ts` 契约；具体实现由子 agent 完成。实现若需偏离本设计，须在 PR/报告中说明原因。

## 1. 目标

一个基于 **pi-durable** 的最小 agent，Docker 单容器部署，只做一件事：

1. 通过内置 **QQBridge** 工具从 QQ（NapCat OneBot v11）接收消息；
2. **规则分流**（无模型，v3）：消息以 `IMAGE_PREFIXES`（默认 `奶龙:` / `奶龙：`）开头 → 前缀之后解析内联选项，其余文本作为提示词；
3. **生图路径** → 调用 **ComfyUI 的 MCP**（`comfy-mcp`）生成图片，以固定模板把图片回到原 QQ 会话；
4. **其他消息** → 交给**执行 agent**：后端可切换（`AGENT_BACKEND=codex|pi`，可按会话覆盖），默认是**同一容器内**的 `codex` CLI 固定线程（owner / shared），其回答经后处理后回到原 QQ 会话；codex 可经 `image_gen` MCP 自行生图，图片随回复发送。

> v2 的"意图识别模型选工具"（`generate_image` / `ask_codex` / `reply_qq` 三个模型工具与热加载 `system.md`）已在 v3 移除，见 §5.2 与 §10。

## 2. 外部依赖与事实（已核实，2026-10-17）

| 组件 | 版本 / 事实 |
|---|---|
| `@earendil-works/pi-durable` | 1.3.0；依赖 `@earendil-works/pi-ai` 1.3.0、`@earendil-works/chord` 1.3.0；实验性 API |
| `@earendil-works/pi-ai` | 内置 provider `openai-codex`（ChatGPT 订阅 OAuth，baseUrl `https://chatgpt.com/backend-api`）、`openai`、`anthropic` 等；`providers/faux` 可用于测试 |
| `@openai/codex` | npm 0.163.0（本机 0.160.1）。`codex exec [PROMPT] --json -o <file> -C <dir> --skip-git-repo-check -s workspace-write`；`codex exec resume <SESSION_ID> [PROMPT]` 固定会话续聊；`CODEX_HOME` 决定 auth.json/config.toml/sessions 位置 |
| `comfy-mcp` | PyPI 0.10.0，依赖 `mcp>=2,<3`、`pydantic>=2`、`anyio>=4.9`；入口 `comfy-mcp`（stdio MCP）。读取 `COMFYUI_URL` / `COMFYUI_HOST` / `COMFYUI_PORT` 指向远端 ComfyUI；`generate_image(prompt)` 内部走 `comfy run-template`（需要 `comfy-cli`，`COMFY_BIN`） |
| NapCat（宿主机） | HTTP `agent-http` 127.0.0.1:3000、WS `agent-ws` 127.0.0.1:3001，Bearer token，`messagePostFormat: array`。**已实测：Docker Desktop 容器经 `host.docker.internal:3000/3001` 可直达宿主机 loopback 端口（返回 403/426），无需改绑定** |
| ComfyUI（宿主机） | `D:\Tools\ComfyLocal\start.ps1` 以 `--listen 127.0.0.1 --port 8188` 后台启动；容器经 `host.docker.internal:8188` 可达，无需改为 0.0.0.0 |
| 本机凭据 | 无 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`；`~/.codex/auth.json` 为 `auth_mode=chatgpt`（含 tokens）。因此 agent 的意图模型默认走 `openai-codex` provider 复用 ChatGPT OAuth |

## 3. 总体结构（v3）

```
QQ 用户 ──NapCat(OneBot v11)──► QQBridge(ws 收 / http 发)
                                     │ 授权 + @检测 + 去重 + 票据(pending) + 消息库入库
                                     ▼
                     Dispatcher：规则分流（router.ts，无模型）→ 写 TicketDoc(route/prefix/prompt)
                     同一 scope 严格 FIFO，不同 scope 并行（≤ AGENT_CONCURRENCY）
                     pi-durable Harness（SQLite /data/agent.sqlite）：每条消息一个 ownerless 会话 + 一个 durable 任务
                 ┌───────────────────┴──────────────────────────────┐
        route=image / image_usage                              route=agent
        任务 cs.image：generate → reply                        任务 cs.agent：handle → postprocess → reply
        generate：comfy-mcp(stdio) 或 HTTP                     handle：AgentBackend（AGENT_BACKEND / OVERRIDES）
          COMFYUI_URL 经 127.0.0.1 loopback 转发                  codex：codex exec [resume] 固定线程 owner/shared
          → /data/images/<ticket>/                                  -c QQ_ACCESS / IMAGE_TICKET_DIR，effort=CODEX_REASONING_EFFORT
        reply：固定模板（成功 / 服务不可用 / 超时 /              MCP：qq_context、image_gen（→ /data/images/<ticket>/）、browser
               内容被拒 / 其他）+ 图                              回合后收集新图片（≤4，魔数校验）
                                                                  pi：第 3 组（当前占位，选中即回复失败模板）
                                                                postprocess：代码清洗；codex 且 CODEX_REPLY_MODE=relay 时
                                                                  先经意图模型整理（20 s，失败回退清洗）
                 └───────────────────┬──────────────────────────────┘
                                     ▼
                  QQBridge.reply(ticket, text, images)（票据幂等：sent 不重发，uncertain 不自动重试）
                                     ▼
                              QQ 原私聊 / 原群(@原发送者)
```

每个阶段把结果写进 TicketDoc，并在同一次 `runtime.commit` 内推进任务检查点：进程在阶段之间崩溃时任务从检查点继续，
已完成的生图 / 后端调用不会重跑，回复不会重发。

## 4. 目录与模块归属

```
cs_agent/
├─ docs/ARCHITECTURE.md          ← 本文件
├─ docs/DEPLOY.md                ← 部署手册（Agent A 写）
├─ Dockerfile, docker-compose.yml, .env.example
├─ package.json, tsconfig.json   （ESM, TypeScript, Node 24, vitest）
├─ src/
│  ├─ main.ts                    启动：加载配置 → 打开 Harness → resume() → 启动 QQBridge → 事件循环
│  ├─ config.ts                  环境变量解析与校验（zod）
│  ├─ qq/                        ★ Agent B 独占
│  │  ├─ types.ts                ★ 主会话契约（只读）
│  │  ├─ bridge.ts               createQQBridge：WS 收事件、HTTP 发送、重连、心跳、去重
│  │  ├─ policy.ts               授权 / 触发规则（allowUsers、allowGroups、真实 at 段）
│  │  ├─ reply-store.ts          票据持久化（node:sqlite），pending→sending→sent|uncertain
│  │  ├─ image.ts                图片校验（魔数、大小、根目录、≤4 张/20MiB）→ base64:// 段
│  │  └─ index.ts                导出 createQQBridge
│  ├─ agent/                     ★ Agent A
│  │  ├─ harness.ts              createModels + openai-codex provider + 注册表 + SQLite storage
│  │  ├─ extension.ts            defineExtension("cs-agent")：注册两个 durable 任务（v3 无模型工具）
│  │  ├─ router.ts               规则分流（IMAGE_PREFIXES）
│  │  ├─ tasks.ts                defineTask：cs.image（generate → reply）、cs.agent（handle → postprocess → reply）
│  │  ├─ backends/               AgentBackend 接口、AGENT_BACKEND 选择、codex 适配、pi 占位
│  │  ├─ codex-runner.ts         固定 codex 线程 owner/shared；互斥队列；JSONL 解析；线程 id 持久化；AGENTS.md
│  │  ├─ image-gen.ts            生图实现：comfy-mcp(stdio) / HTTP，失败分类（任务与 image_gen MCP 共用）
│  │  ├─ image-collect.ts        回合内新图片收集（≤4，魔数校验）
│  │  ├─ reply-postprocess.ts    代码清洗 + relay 整理
│  │  └─ dispatch.ts             admit（会话 + TicketDoc + 索引）→ scope FIFO → 建任务 → waitForTask → 兜底
│  ├─ mcp/                       codex 的 stdio MCP：qq-context.ts（聊天记录）、image-gen.ts（生图）
│  └─ auth/codex-oauth.ts        把 /data/codex/auth.json 的 ChatGPT tokens 映射为 pi-ai 凭据
├─ test/                         vitest；qq/ 下的测试归 Agent B，其余归 Agent A
└─ scripts/                      init-auth.ps1（把宿主机 ~/.codex/auth.json 复制进 ./data/codex/）
```

## 5. 关键设计决策

### 5.1 每条消息一个 durable conversation
- 不用单一 root 累积所有 QQ 消息（上下文无限增长、串话）。
- 每条通过授权的消息：一个 ownerless 会话（v3：会话里不跑模型，只承载 TicketDoc 与一个 durable 任务）。
- 会话文档（`defineDoc`）保存 `{ ticket, source, text, route, … }`，回复只从文档取 ticket，**后端无法指定回复目标**。
- 进程崩溃后任务从最后提交的检查点继续（见 §3 末尾与 §10.1），避免重复生图、重复发消息。

### 5.2 规则分流（v3，取代意图识别模型）
- `src/agent/router.ts`：去掉群消息开头由 bridge 渲染出的 `[at]` / `[reply]` 段占位与首尾空白后，逐字匹配 `IMAGE_PREFIXES`（逗号分隔，默认 `奶龙:,奶龙：`，较长前缀优先）。
- 命中：前缀之后解析比例、尺寸、张数与透明选项，其余文本（去首尾空白，不翻译不改写）作为生图提示词；为空 → 固定用法提示"奶龙: 后面写要画的内容"。未命中：整条原文交给执行 agent。
- 分流结果（`route: image | image_usage | agent`、`prefix`、`prompt`）在 admit 的同一 commit 写入 TicketDoc，日志 `message routed`。
- 不经任何模型，没有系统提示；v2 的 `${DATA_DIR}/prompts/system.md` 不再读取，存在时启动记一行弃用 warn（文件保留）。
- 执行 agent 的后端选择：`AGENT_BACKEND`（默认 codex）+ `AGENT_BACKEND_OVERRIDES`（`scope=backend`，非法项启动失败）。

### 5.3 固定 codex 会话
- `CODEX_HOME=/data/codex`（容器卷），工作目录 `/workspace`（容器卷）。
- 首轮：`codex exec --json -o <out> -C /workspace --skip-git-repo-check -s workspace-write "<prompt>"`，从 JSONL 事件中取 thread/session id（`thread.started` 类事件；实现方以实际输出为准），持久化到 `/data/codex-session.json`。
- 之后：`codex exec resume <id> --json -o <out> ... "<prompt>"`。
- 每轮推理强度：v3 固定取 `CODEX_REASONING_EFFORT`，首轮与 resume 均追加 `-c model_reasoning_effort="<档位>"`（v2 曾由意图模型按请求选择）。若 resume 因会话丢失失败 → 新建会话并覆盖记录，回复中不暴露内部错误细节。
- **互斥队列**：固定会话一次只跑一轮，其余排队；单轮超时可配（默认 600 s），超时后 kill 进程树并回复用户"处理超时"。
- 容器内 `config.toml` 为受管文件，入口脚本每次启动按环境变量重写最小版本（`model`、`model_reasoning_effort` 来自环境变量，默认 `gpt-6.1-sol` / `high`；后者只是缺省值，每轮被上面的 `-c` 覆盖），**不**继承宿主机的 Windows 路径配置。
- 传给 codex 的 prompt 带来源标注（私聊/群、昵称），不带 QQ 号之外的任何授权语义。

### 5.4 ComfyUI 经 MCP
- 容器内以 stdio 启动 `comfy-mcp`（Python venv），`COMFYUI_URL=http://host.docker.internal:8188`，`COMFY_BIN=/opt/comfy/bin/comfy`。
- 用 `@modelcontextprotocol/sdk` Client 调用：`server_info`（启动自检）→ `generate_image(prompt, wait=False)` → `job(action="wait")` → `fetch_outputs` 到 `/data/images/<ticket>/`。
- 风险：`comfy run-template` 对远端目标是否需要本地 ComfyUI 工程目录（`COMFY_PROJECT`）**需实测**。若 MCP 路径在容器内不可行，实现 **fallback**：直接调 ComfyUI HTTP（`POST /prompt` 默认 t2i 工作流 → 轮询 `/history/<id>` → `GET /view`），并在报告中明确说明走了 fallback。
- 生图超时默认 300 s；失败时按类别回复固定模板（服务不可用 / 超时 / 内容被拒 / 其他）。

### 5.5 QQBridge（相对 D:\Tools\QQBridge 的取舍）
保留：真实 `at` 段检测、自回声过滤、`self_id:type:group_id:user_id:message_id` 去重、授权模型（`allowUsers` 任意处可触发；`allowGroups` 内成员需真实 @）、票据决定性 ID 与 `pending→sending→sent|uncertain` 幂等机制、群回复 `[at][text "\n"+正文]`、图片 `base64://` 发送与魔数校验、"结果不确定不自动重试"。
去掉：Codex 桌面管道、member-workspaces、group-context、MCP server 外壳、计划任务守护、loopback 限制（改为显式 URL + token 配置）。
改进：票据与去重状态改用 `node:sqlite` 单文件；端点由环境变量直接给出；暴露为进程内模块而非 MCP。

### 5.6 模型凭据
- 意图模型默认 provider `deepseek`、model `deepseek-flash`（pi-ai 内置 deepseek provider，OpenAI-completions 兼容接口 `https://api.deepseek.com`，支持工具调用）。密钥读环境变量 `DEEPSEEK_API_KEY`；`.env` 中写作 `DEEPSEEK_APIKEY` 也可，启动时映射为标准名，缺少密钥则启动失败。deepseek-flash 支持的思考档位为 off/low/high/max，`AGENT_THINKING_LEVEL` 不受支持时就近调整（如 medium → high）并记一条 warn 日志。
- `openai-codex` provider 仍可选（`AGENT_MODEL_PROVIDER=openai-codex`），凭据来自 `/data/codex/auth.json`（与容器内 codex 共用同一份，由 `scripts/init-auth.ps1` 从宿主机复制一次）。实现方须查明 pi-ai `auth/oauth/openai-codex` 期望的 credential 字段（access/refresh/account_id/expires）并做映射；pi-ai 自行刷新时**写回**同一文件以保持与 codex 一致，若两者刷新策略冲突须在报告中指出。
- 可通过 `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID` / 对应 API Key 环境变量切换到 `openai` / `anthropic` 等 API-Key provider。
- 意图识别用小/便宜模型即可。

## 6. 环境变量（`.env.example`）

```
NAPCAT_HTTP_URL=http://host.docker.internal:3000
NAPCAT_WS_URL=ws://host.docker.internal:3001
NAPCAT_TOKEN=
QQ_ALLOW_USERS=10000001          # 逗号分隔或 *
QQ_ALLOW_GROUPS=200000001          # 逗号分隔
QQ_GROUP_MENTIONS=true
COMFYUI_URL=http://host.docker.internal:8188
COMFY_TIMEOUT_SEC=300
CODEX_MODEL=gpt-6.1-sol
CODEX_REASONING_EFFORT=high        # 缺省值；每轮由意图模型选择的档位覆盖
CODEX_TIMEOUT_SEC=600
AGENT_MODEL_PROVIDER=deepseek
AGENT_MODEL_ID=deepseek-flash
DEEPSEEK_API_KEY=                  # 也可写作 DEEPSEEK_APIKEY
DATA_DIR=/data
WORKSPACE_DIR=/workspace
LOG_LEVEL=info
```

## 7. Docker

- 基础镜像 `node:24-bookworm-slim`；安装 `python3 python3-venv`，`/opt/comfy` venv 内 `pip install comfy-cli comfy-mcp`；`npm i -g @openai/codex@0.163.0`。
- 多阶段：builder 编译 TS → runtime 仅带 `dist/` 与生产依赖。
- `docker-compose.yml`：服务 `cs-agent`，`extra_hosts: ["host.docker.internal:host-gateway"]`，卷 `./data:/data`、`./workspace:/workspace`，`env_file: .env`，`restart: unless-stopped`，非 root 用户运行。
- 健康检查：进程内 HTTP `GET /healthz`（仅容器内 127.0.0.1 监听）返回 WS 连接状态与 comfy/codex 自检结果。

## 8. 宿主机前置条件（写入 docs/DEPLOY.md）

1. NapCat 保持现状（127.0.0.1:3000/3001 + token）；Docker Desktop 的 `host.docker.internal` 可直达宿主机 loopback 服务，已实测。`.env` 的 `NAPCAT_TOKEN` 取自 `D:\Tools\NapCat\config\onebot11_1670528780.json` 中 `agent-http` 条目的 token。
2. ComfyUI 用 `D:\Tools\ComfyLocal\start.ps1` 启动即可（127.0.0.1:8188），无需改监听地址。
3. 运行 `scripts/init-auth.ps1` 把 `~/.codex/auth.json` 复制到 `./data/codex/auth.json`；或在容器内执行 `codex login --device-auth`。
4. `docker compose up -d --build`；查看 `docker compose logs -f`。

## 9. 测试要求

- **qq/**：用本地假 OneBot 服务器（`ws` + `node:http`）测试：授权规则、@ 检测、去重、重连、票据幂等（sent / uncertain / 并发锁）、群回复段格式、图片校验。
- **agent/**（v3）：规则分流（半/全角、前导空白与 `[at]`、空提示、未命中）；生图任务崩溃恢复（阶段间关闭 harness 后重开：一次生图、一次发送）；任务失败后重跑跳过已完成阶段；scope FIFO 与跨 scope 并行；codex 后端经假 `codex` 脚本（`QQ_ACCESS` / `IMAGE_TICKET_DIR` / 固定 effort、图片收集 ≤4）；`image_gen` MCP 经 stdio（假 ComfyUI HTTP）与假 comfy-mcp；后处理清洗与 relay 回退（faux provider）；后端选择与 pi 占位。
- `docker build` 必须成功；`docker compose config` 校验通过。
- 不向真实群发测试消息。

## 10. 实现阶段确认的偏离与补充（2026-10-17）

| 项 | 实际做法 | 原因 |
|---|---|---|
| ComfyUI 访问 | 容器内 `loopback-proxy.ts` 把 `127.0.0.1:8188` 转发到 `COMFYUI_URL`，comfy-mcp 指向 loopback | comfy-cli 1.22 拒绝从非 loopback 主机读取 `/object_info`（SSRF 防护） |
| 生图工作流 | 默认 `COMFY_WORKFLOW_FILE=/app/workflows/qwen-image-2.1-turbo-api.json` + `COMFY_PROMPT_NODE=4`，mcp 走 `run_workflow`，http 直接 `POST /prompt`；程序写入提示词并随机化 seed | 宿主机 ComfyUI 没有 SD1.5 checkpoint，只有 Qwen Image 2.1 Turbo，comfy-mcp 默认 `generate_image` 模板校验失败 |
| codex resume | `codex exec resume` 无 `-C/-s`；cwd 由 spawn 决定，沙箱用 `-c sandbox_mode=…` | CLI 0.160/0.163 的参数限制 |
| 每会话工具纪律 | 代码层 `claimBusinessCall` 守卫：第二次业务工具调用直接报错并提示调用 `reply_qq`；`reply_qq` 失败返回带 terminate 的错误；会话结束而票据仍 pending 时派发器补发一条兜底回复 | 不依赖模型完全遵守系统提示 |
| 会话 | `harness.createConversation({ownership:{kind:"ownerless"}, init})`，`init` 同一提交内写入 `cs.ticket` 文档与 `cs.dispatch` 索引；启动时 `Dispatcher.recover()` 按索引重提交（requestId=ticket 去重）；自动 compaction 关闭 | 单消息会话无需压缩 |
| 凭据 | pi-ai openai-codex 凭据 `{type:"oauth", access, refresh, expires, accountId}` ← Codex `auth.json` 的 `tokens.*`；刷新后按 Codex 格式写回同一文件 | 容器内 codex 与 agent 共用一份 |
| 默认意图模型 | `deepseek/deepseek-flash`（DEEPSEEK_API_KEY 或别名 DEEPSEEK_APIKEY）；`openai-codex/gpt-6-luna` 仍可选 | 意图识别任务简单，改用 DeepSeek API key，不占 ChatGPT 额度 |
| codex 模型与推理强度 | 默认 `gpt-6.1-sol`；`ask_codex.reasoning_effort` 由意图模型按请求选 `low…max`，以 `-c model_reasoning_effort=…` 逐轮覆盖 | 简单问题不必用高推理强度，复杂任务按需提高 |
| 统一上下文消息库（设计 v2 §2.1/§2.4） | `src/context/store.ts`：`/data/qq-messages.sqlite`（WAL），`messages` / `summaries` + trigram FTS5（触发器同步）；2 字中文词用 `LIKE` 回退全表扫描，≥3 字走 trigram 索引；所有读取带 `Access` 过滤；`format.ts` 为意图层与 MCP 共用的唯一格式化器（非今天的行加 `MM-DD`，MCP 输出加 `#message_id`） | 设计稿 §2；trigram 对 <3 字的 MATCH 无结果 |
| QQBridge 入库事件 | `types.ts` 新增 `raw`（允许群全部消息 + 允许用户私聊，先于 `message`）与 `recall`（`group_recall` / `friend_recall`）事件；监听器异常转为 `error` 事件不影响触发 | 消息库需要不触发的群消息 |
| 机器人回复行 | 派发器 admit 时 `recordPending`（`处理中`），终态后按 `TicketDoc.imagePrompt` / `codexEffort` / `replyText` / `replyImages` 调 `completeReply`；兜底、uncertain 或业务工具失败记 `失败`；QQ 回复的 message_id 替换占位 id | 意图层与 codex 看到同一行 `[我] → …` |
| 衰老任务 | `src/context/aging.ts`：每日本地 `HISTORY_SUMMARY_HOUR` 点；`models.completeSimple` 直调意图模型生成日摘要；已结束自然周折叠为周摘要（仅 1 天时直接复用）；`meta.aging_last_run` 早于 24h 时启动补跑；原始消息只在所在时段被日/周摘要覆盖后才按 `HISTORY_RAW_DAYS` 清理，未覆盖的兜底保留 `HISTORY_RAW_HARD_MAX_DAYS`（90）天 | 设计稿 §2.2；"满 7 天"实现为"自然周结束" |
| qq_context MCP | `src/mcp/qq-context.ts`（低层 `Server` + stdio），只读连接；范围只来自 `QQ_ACCESS`，缺失/非法时所有工具返回错误文本 | 设计稿 §2.3 |
| ask_codex 注入 | 每轮 `-c mcp_servers.qq_context.env.QQ_ACCESS="…"`（群→本群、owner 私聊→`all`、其他私聊→本人）；头部改为 §3.2 的 `[来源]` / `[引用]` 两行；`TZ` 加入 codex 子进程环境白名单 | 设计稿 §3.2 |
| codex 双线程 | `owner`（owner 私聊，即访问范围 all）与 `shared`（所有群与其他私聊）两条线程，记录在 `/data/codex-threads.json`（原子写，读-改-写串行化）；每键一条互斥队列，两键可并行；旧 `codex-session.json` 在新文件缺失时迁移到 `owner` 并改名 `.migrated`；healthz `codex.threads: {owner, shared}` | 用户 2026-10-18 决定（评审 R1）：owner 的长任务不阻塞群聊，群聊上下文不进入 owner 线程 |
| codex 线程安全阀 | 每条线程 resume 前检查 rollout 文件大小与线程年龄（记录含 `created_at`，旧记录用 `updated_at`），超限新建该线程并记 `codex thread rotated`（带 `key`） | 设计稿 §3.1 |
| 受管 config.toml | entrypoint 写入 `web_search`、`[tools.web_search]`、`[mcp_servers.qq_context]`（env `DATA_DIR`、`QQ_CONTEXT_MAX_CHARS`）与可选 `[mcp_servers.browser]`；枚举/路径值经 `toml_enum` / `toml_path` 校验 | 设计稿 §3.4、§4.4 |
| 容器内浏览器 | 镜像全局安装 `@playwright/mcp@0.0.83` + Chromium（`/opt/pw-browsers`，`--with-deps`）；codex 以 `--headless --isolated --browser chromium --blocked-origins <宿主机/内网阻止列表>` 启动，显式 `--sandbox` 开启 Chromium 沙箱（需 compose 的 seccomp-codex.json profile；`PLAYWRIGHT_NO_SANDBOX=1` 关闭）；`enabled_tools` 白名单 22 个工具，排除 `browser_run_code_unsafe`（vm 逃逸可读 auth.json、可 goto file:）、`browser_file_upload`、`browser_drop`；`file:` 靠 playwright-mcp 自带拦截 + Chromium（`--blocked-origins` 表达不了 file:） | egolite 不可容器化（设计稿 §4.4）；浏览器 MCP 不受 codex 沙箱约束，阻止列表不拦重定向/DNS 指向内网（DEPLOY 残余风险） |
| codex 命令沙箱 | 受管 config.toml 写 `[sandbox_workspace_write] network_access`（`CODEX_SANDBOX_NETWORK`，默认 true）与 `writable_roots`（`CODEX_WRITABLE_ROOTS`，默认 `/workspace,/data/prompts,/data/workflows`，逐项规范化 `//`、`/.`、末尾 `/` 后再比较，拒绝 `/`、`/data` 及其上级、`/data/codex*`、`/data/images*`、`/data/tickets*`、`*.sqlite`、含 `..`）；entrypoint 缺失时从 `/app/workflows` 播种 `/data/workflows`；`COMFY_WORKFLOW_FILE` 默认改为 `/data/workflows/…` | 用户 2026-10-18 决定：命令需联网，codex 可改项目自有内容；compose 自定义 seccomp profile（docker/seccomp-codex.json）才能运行 bwrap |
| codex 命令禁读 | 入口脚本每次启动重写 `/etc/codex/requirements.toml` 的 `[permissions.filesystem] deny_read`（`/data/codex/auth.json`、`sessions`、`history.jsonl`、`log`、`shell_snapshots`、`memories`、`/data/codex/*.sqlite*`、`/data/*.sqlite*`、`/data/images`、`/data/tickets`、`/data/codex-session.json*`、`/data/codex-threads.json`）；镜像内 `/etc/codex` 归 node；写入失败则拒绝启动 | 评审 R2：沙箱原本可读凭据与数据库。codex 0.163 只认系统级 requirements（`$CODEX_HOME/requirements.toml` 无效，`default_permissions` 与 `sandbox_mode` 互斥）；不能禁读整个 CODEX_HOME（arg0 辅助程序在 `tmp/`）。实测见 DEPLOY §7 |
| AGENTS.md 位置与版本 | 规则模板 v3（首行 `<!-- cs-agent-agents-template v3 -->`）写到 `$CODEX_HOME/AGENTS.md`，agent 每次启动按 `CODEX_EFFECTIVE_WRITABLE_ROOTS`（entrypoint 导出）渲染可读写目录后重写；`/workspace/AGENTS.md` 只在缺失或与 v1/v2 模板全文相同（忽略 CRLF）时写入占位说明，带旧标记但被改过的保留并记 warn | 评审 L1：工作区可写，规则放那里 codex 自己能改；`/data/codex` 对命令只读。`codex debug prompt-input` 实测全局与工作区 AGENTS.md 都会注入 |
| 新增环境变量 | `COMFY_MODE`、`COMFY_MCP_BIN`、`COMFY_BIN`、`COMFY_CHECKPOINT`、`COMFY_WORKFLOW_FILE`、`COMFY_PROMPT_NODE`、`COMFY_LOOPBACK_PORT`、`CODEX_BIN`、`CODEX_SANDBOX`、`AGENT_THINKING_LEVEL`、`AGENT_CONCURRENCY`、`HEALTH_PORT`、`HEALTH_HOST`；设计 v2 第 1 组：`QQ_OWNER`、`HISTORY_RAW_DAYS`、`HISTORY_RAW_HARD_MAX_DAYS`、`HISTORY_SUMMARY_DAYS`、`HISTORY_SUMMARY_HOUR`、`QQ_CONTEXT_MAX_CHARS`、`CODEX_WEB_SEARCH`、`CODEX_WEB_SEARCH_CONTEXT`、`CODEX_ROLLOUT_MAX_MB`、`CODEX_THREAD_MAX_DAYS`、`CODEX_BROWSER` | 见 `.env.example` |

### 10.1 v3（设计稿 §4.1–4.4、§4.7，第 2 组）

| 项 | 实际做法 | 原因 |
|---|---|---|
| 分流 | `router.ts` 规则分流，取代意图模型；输入是 bridge 计算的 `InboundMessage.route_text`（`policy.ts` 跳过开头真实的 at / reply 段后渲染；`text` 不变，供历史使用），路由器只去首尾空白再逐字匹配前缀，用户亲手输入的 `[at]` 字样不做特殊处理。票据表 `source_route_text` 列保存它供崩溃对账；旧行 / v2 票据文档没有时才按旧规则去掉渲染出的占位（`legacyRouteText`） | 设计稿 §4.1；评审 R10：文本占位与用户输入无法区分 |
| durable 任务 | `tasks.ts`：`defineTask` 定义 `cs.image`（submit → collect → reply；旧任务停在 `generate` 时按 submit 处理）与 `cs.agent`（handle → postprocess → reply），经扩展的 `tasks` 注册；派发器轮到某票据时 `tx.createTask(…, {ownership:{kind:"conversation"}, conversationId})`，任务 id 记入 DispatchDoc，`harness.waitForTask` 等待 | 设计稿 §4.2 / §4.3 |
| 检查点 | 每阶段把结果（`imageJob` / `imageResult` / `codexTurn` / `agentResult` / `replyDraft` / `replyText`）写进 TicketDoc，并在同一 `runtime.commit` 里返回下一阶段的检查点；新任务（上一个任务失败后重跑）也先读 TicketDoc 跳过已完成阶段；进程关闭时阶段抛出而不提交 | 崩溃不重复生图 / 不重复发送 |
| 生图提交与收取 | 提交前保存 `submitIntent={attempt,filenamePrefix}`，SaveImage 使用 `cs-<ticket前12位hex>-<attempt>`；HTTP 与 MCP 的自定义 `run_workflow` 均修改图，默认 `generate_image` 不支持前缀时改走可控图。提交后保存 `imageJob` 并进入 collect。缺失 prompt_id 或 unknown 时统一经 HTTP 查 `/history`、`/queue` 认领任务，否则按前缀探测 `/view` 的 `_00001_.png` 至 count（默认 1、最多 4）；`imageReconciliation` 记录每步，明确无输出才以新 attempt 重交，总上限 2 次。查询失败不重交；有效本地图片仍可复用 | 评审 F1 / F2：覆盖提交响应丢失与历史被清理的窗口 |
| codex 回合幂等 | `-o` 固定写 `${DATA_DIR}/tickets/<ticket>/codex-last.txt`；取得线程锁、复查 signal 后，通过 `onAcquired` 在 spawn 前持久化 `codexTurn={outFile,attempts}`，排队不计次数。已有输出直接复用；有标记无输出最多再问一次。reply 与派发终态对账共用幂等 `cleanupTicketWorkdir`，覆盖 sent / sending / uncertain / failed / given-up，图片目录不动 | 评审 R1、F5 / F6：避免排队耗尽次数与崩溃遗留目录 |
| reply 阶段 | 发送前就失败（票据仍 pending）时任务内退避重试（≤3 次，次数在检查点）；sending/uncertain 一律不重发，任务以 failed 结束；任务失败且票据仍 pending → 派发器发兜底回复 | 沿用票据幂等 |
| 副作用前检查 | `blockedReason()` 首先检查 runtime.signal，再检查派发条目与票据；任务将 signal 传入 QQBridge.reply。bridge 在 `get_login_info` 前及 `markSending` 前检查取消，此前取消保留 pending；标记 sending 成功后不再取消实际发送，失败仍记 uncertain | 评审 R3、F4：避免已取消任务开始副作用 |
| 顺序 | 派发器每个 scope 一条 promise 链（FIFO），轮到时再占全局并发槽位（`AGENT_CONCURRENCY`）。票据占据 scope 队首直到终态 `sent` / `uncertain` / `failed`：任务失败且兜底在发送前失败时退避（`retryDelayMs`，默认 5 s × 次数）后在队首重试，attempts 每次落盘；超过 `MAX_ATTEMPTS`（3）→ giveUp（同一队列与槽位）：标记 `givenUp` → `harness.abortTask` 并等待终态 → 兜底；兜底仍发不出 → 条目标记 `state: "failed"` 保留在索引（重启跳过、对账不当孤儿），记 `ticket failed: fallback could not be sent`，继续下一条 | 设计稿 §4.7；评审 R3 / R4 / R5 |
| 恢复排序 | 唯一排序键是 bridge admit 时的票据 `seq`（票据表 rowid，与 `created_at` 同事务分配，`ReplyTicketRecord.seq`）；DispatchDoc 条目记 `ticketSeq`（旧条目从票据表补取）；`recover()` 把索引条目与孤儿票据（`listPendingTickets(limit, afterSeq)` 分页取尽）按 seq 合并排序后依次入队；pi-durable 一开启调度就会继续上次的活任务（绕过 FIFO），所以 recover 先给它们打中止标记，轮到该票据时等其以 aborted 结束再新建任务。启动时先 `recover()` 再 `harness.resume()` | 评审 R6 / R7 |
| 空原文孤儿票据 | 持久化 `fallbackOnly` 派发条目，跳过模型任务但沿用 scope FIFO、退避、次数上限与终态清理；兜底在 bridge 恢复前保持队首，failed 条目重启不再运行 | 评审 F3：兜底同样遵守终态 FIFO |
| v2 遗留 | 无 `taskId` 的旧索引条目：先 `conversation.abort()` 中止旧模型会话，再按原文重新分流建任务 | 升级时在途消息 |
| 后端 | `backends/types.ts`（`AgentBackend`，结果可带 `images`）、`select.ts`（`AGENT_BACKEND` / `AGENT_BACKEND_OVERRIDES`，`PiBackendStub` 抛 `pi backend not implemented yet (group 3)`）、`codex.ts`（适配 `CodexRunner`） | 设计稿 §4.3 / §4.4 |
| codex 适配 | `-c model_reasoning_effort`（`CODEX_REASONING_EFFORT`）、`-c mcp_servers.qq_context.env.QQ_ACCESS`、`-c mcp_servers.image_gen.env.IMAGE_TICKET_DIR="<DATA_DIR>/images/<ticket>"`（路径只允许 `[A-Za-z0-9._/-]`、不含 `..`）；回合前记下票据目录已有文件，回合后取新增的普通文件（不跟随软链接），按 QQBridge 口径校验大小与魔数，按 mtime 取前 4 张 | 设计稿 §4.4 |
| image_gen MCP | `src/mcp/image-gen.ts`（stdio，低层 `Server`）：工具 `generate_image(prompt)`，非只读注解；输出目录只来自 `IMAGE_TICKET_DIR`，必须是 `${DATA_DIR}/images/` 的直接子目录（realpath 复核），否则拒绝；每进程（每回合）≤4 次；每次调用输出到新的子目录 `call-<n>/`（n = 已有 call 目录数 + 1，同名输出不会互相覆盖），返回 `call-<n>/<文件名>`（评审 R9）；后端配置用 `loadConfig` 解析透传的 `COMFY_*`，mcp 模式下非 loopback 的 `COMFYUI_URL` 改走 `http://127.0.0.1:COMFY_LOOPBACK_PORT`（agent 主进程的 loopback 转发；codex 及其 MCP 子进程与主进程同一网络命名空间） | 复用同一生图实现 |
| 受管 config.toml | 新增 `[mcp_servers.image_gen]`（`tool_timeout_sec = COMFY_TIMEOUT_SEC + 30`，审批模式同 `CODEX_MCP_APPROVAL_MODE`）与 `[mcp_servers.image_gen.env]`（`DATA_DIR` + 已设置的 `COMFY_MODE`/`COMFYUI_URL`/`COMFY_MCP_BIN`/`COMFY_BIN`/`COMFY_CHECKPOINT`/`COMFY_WORKFLOW_FILE`/`COMFY_PROMPT_NODE`/`COMFY_TIMEOUT_SEC`/`COMFY_LOOPBACK_PORT`/`LOG_LEVEL`；含引号、反斜杠或非可打印字符的值告警跳过） | codex 给 MCP 子进程的环境只有少量默认变量 + env 表 |
| AGENTS.md | 模板 v4：新增"生图（image_gen）"一条（图片随回复自动发送，回复只需一句说明）；`/data/prompts` 说明改为 system.md 已弃用 | 设计稿 §4.4 |
| 后处理 | `reply-postprocess.ts`：去代码围栏行（保留内容）、标题符号、表格竖线/分隔行、加粗与行内代码标记；`@` 换为全角 `＠`；压缩空行；孤立代理项先替换为 U+FFFD（`toWellFormed`，评审 R11），再 `fitText` ≤4000 UTF-16。codex 后端 `CODEX_REPLY_MODE=relay`（默认）先用意图模型（5 行提示，20 s 超时）整理再清洗，失败回退清洗；`direct` 只清洗。`CODEX_REPLY_SANITIZE` 未引入：清洗在 v3 中总是开启 | 设计稿 §4.3 |
| 模型工具退场 | 删除 `generate_image` / `ask_codex` / `reply_qq` 工具、`claimBusinessCall` 与意图系统提示；`CodexRunner` 移至 `src/agent/codex-runner.ts`，生图实现移至 `src/agent/image-gen.ts` | 设计稿 §7 第 2 组 |
| 消息库机器人行 | 生图：`completeReply(action=generate_image, detail=prompt)`；codex 后端：`ask_codex`（detail = `CODEX_REASONING_EFFORT`）；用法提示与 pi：`reply`；业务失败或兜底记 `失败` | 统一上下文 §2.4 |
| 新增环境变量 | `IMAGE_PREFIXES`、`AGENT_BACKEND`、`AGENT_BACKEND_OVERRIDES`、`CODEX_REPLY_MODE` | 见 `.env.example` |

已实测：容器内 `codex exec`（OAuth + workspace-write 沙箱）正常；容器内经 mcp 与 http 两条路径均生成真实 PNG（约 10–17 s）。

### 10.2 生图工具 v2（2026-10-18，设计 §4.9）

本节覆盖前文旧版静态工作流与 generate_image(prompt) 的说明。统一契约位于 `image-options.ts`；前缀路径与 image_gen MCP 共用校验、尺寸表及 `qwen-workflow.ts` 生成器。pi 后端仍为第 3 组占位，已提供可复用契约及 agent.md 模板，本期没有新增真实 pi 模型执行。

| 环节 | 实现 |
|---|---|
| 参数 | prompt、negative_prompt、aspect（7 种）、size（1mp/2mp/2k）、count（1–4）、seed、reference_images（≤3）、transparent；2mp 为 1mp 每边乘 √2 后取最近的 32 倍数 |
| 分流 | 提示词之前空格分隔的比例、横/竖/方、2k/2mp、x2–x4、透明，任意顺序；未知词起的后续文本保留，重复选项后者覆盖；附件自动作参考图 |
| 生成 | UNETLoader → 可选 QwenImage21Cache → KSampler；CLIPLoader → TextEncodeQwenImage21 正/负 conditioning → KSampler；t2i 使用 EmptyLatentImage；固定 8 步、CFG 1、euler/simple |
| 编辑 | LoadImage.IMAGE → 编码器 images.image_N；VAELoader → 编码器 vae；编码器 LATENT（slot 2）→ KSampler.latent_image；count>1 经 RepeatLatentBatch；保持首图比例，resolution 为目标面积平方根取 32 倍数 |
| 透明（偏离原 §4.9） | 使用 2.1 原生 RGBA；KSampler → VAEDecode（2.1 VAE）→ SaveImageAdvanced(png/8-bit/sRGB)，不使用 EmptyQwenImageLayeredLatentImage。layered latent 为 5D/16 通道，2.1 是 4D/64 通道，不能混用。依用户后续决定实施，本机无需额外模型 |
| 自检 | 启动及透明提交检查 VAELoader 模型列表；缺失时明确返回“透明输出未启用：缺少 <文件名>”，不下载依赖 |
| 后端 | submit(ImageOptions, submission)、collect、reconcile；mcp 总是 run_workflow(临时 API JSON)，http POST /prompt；自定义 COMFY_WORKFLOW_FILE 优先，仅 patch prompt/seed 与对账前缀；默认改为空 |
| 超时与恢复 | 60 秒 × 实际预设像素/1024² × count，受 COMFY_TIMEOUT_SEC 上限约束；submitIntent 保存 options/count/参考图子目录，恢复依次查 history、queue、预计文件名（含透明 SaveImageAdvanced 命名） |
| 参考图入站 | QQBridge 授权、触发、去重后才下载 array 图片段，url 优先、get_image 刷新；≤3×10 MiB、流式上限与魔数检查；落盘 incoming/<ticket>/ 后与 source_images 一起 admit；失败原因入票据，恢复不会默默丢参考图 |
| 参考图访问 | codex 每轮以 -c 注入 IMAGE_REFS（没图时清空），MCP 仅允许清单中且 realpath 位于本票据 incoming 的文件；incoming 对命令沙箱 deny_read，禁止加入 writable_roots |
| 上传 | HTTP /upload/image 使用每票据 subfolder；comfy-mcp upload_file 需同时支持 paths 与 subfolder，否则回退同 URL 的 HTTP。本机版本只有 paths/overwrite，故走回退；不把本机绝对路径直接传 LoadImage |
| 清理与提示词 | 每日衰老任务清理超过 7 天的 incoming 票据目录；AGENTS.md 模板 v5、agent.md：文字加引号和位置字体、编辑说明改什么保留什么、不用 SD 咒语、参数范围 |

官方接线依据（本机 `comfyui_workflow_templates_json/templates/`）：

- `image_qwen_image_2_1_turbo_image_edit.json`：编码器节点 474（行 1251），ComfySwitchNode 468（行 1130）默认 false；link 724（行 2227）把 474 slot 2 接 false，link 913（行 2339）把开关输出接采样 latent；link 710（行 2443）输入参考图，link 720（行 2451）输入 VAE。因此生成器直接使用编码器 LATENT，不能在编辑时换回 EmptyLatentImage。官方最新模板的高级采样器等价连接在此按用户要求落实为固定 KSampler 参数。
- `image_qwen_image_2_1_background_removal.json`：VAEDecode 457（行 1011），SaveImageAdvanced 461（行 197）；link 651（行 1539）采样输出接 decode，649（行 1523）接 VAE，650（行 1531）接子图输出，顶层 672（行 390）接保存。使用同一 2.1 VAE，无单独 RGBA VAE。
- `image_qwen_image_layered.json` 的 EmptyQwenImageLayeredLatentImage 128（行 2731）搭配另一 UNET/VAE 及 LatentCut/LatentCutToBatch；本实现不混用它。

真实冒烟共 5 次，未访问真实 Codex、模型代理或 QQ；未改运行容器。透明 PNG 的 alpha 实测有 0–255。2K 冷启动超过一次 240 秒收取预算，重跑收取同一 prompt_id 成功，未重新提交；16 GiB 显存下不能承诺 2K 总在预算内完成。完整文件、耗时与验证尾部见 [验收记录](IMAGE-GEN-V2-ACCEPTANCE.md)。

## 11. 非目标（本期不做）

多轮上下文记忆、群聊上下文摘要、成员工作区、主动推送、Web 管理界面、多 codex 会话。
