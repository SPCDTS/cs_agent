# cs_agent 部署手册

单容器：QQ（NapCat）→ pi-durable agent → ComfyUI（生图）或容器内 codex（其他请求）→ 回到原 QQ 会话。设计见 `docs/ARCHITECTURE.md`。

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

> 刷新冲突：refresh_token 会轮换。容器（agent / 容器内 codex）刷新后会写回 `./data/codex/auth.json`，宿主机那份 `~/.codex/auth.json` 可能随之失效，反过来也一样。容器内的 agent 每次读写都重新读取文件，并且只在 token 快过期时刷新，所以 agent 和容器内 codex 之间不会互相覆盖。宿主机 codex 失效时重新 `codex login` 即可。

## 2. 配置

```powershell
Copy-Item .env.example .env
# 编辑 .env：至少填写 NAPCAT_TOKEN，确认 QQ_ALLOW_USERS / QQ_ALLOW_GROUPS
```

关键变量（完整列表见 `.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID` | `openai-codex` / `gpt-6-luna` | 意图识别模型（openai-codex 目录中最便宜的）。可以切换到 `openai`、`anthropic` 等 provider，同时设置对应的 `*_API_KEY` |
| `AGENT_CONCURRENCY` | 2 | 同时处理的 QQ 消息数，多出来的排队（排队状态已持久化） |
| `COMFY_MODE` | `mcp` | `mcp`：经 comfy-mcp；`http`：直连 ComfyUI HTTP API（默认 SD1.5 文生图工作流） |
| `COMFY_WORKFLOW_FILE` / `COMFY_PROMPT_NODE` | `.env.example`：`/app/workflows/qwen-image-2.1-turbo-api.json` / `4` | API 格式工作流（镜像内自带本机 Qwen Image 2.1 Turbo 版本）。设置后 mcp 走 `run_workflow`，http 直接提交它。程序把提示词写入提示词节点，并随机化 seed。**本机 ComfyUI 没有 SD1.5 checkpoint，留空时默认模板会失败** |
| `COMFY_CHECKPOINT` | 空 | 指定 checkpoint；留空时用模板默认（mcp）或第一个可用的 checkpoint（http） |
| `CODEX_SANDBOX` | `workspace-write` | 如果容器内 codex 报 sandbox/landlock 错误，改为 `danger-full-access`（这时容器本身就是沙箱） |
| `CODEX_TIMEOUT_SEC` / `COMFY_TIMEOUT_SEC` | 600 / 300 | 单轮超时；codex 超时后会 kill 整个进程树 |

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
| `./data/codex/` | `CODEX_HOME`：`auth.json`、`config.toml`（缺失时由入口脚本生成）、sessions |
| `./data/codex-session.json` | 固定 codex 会话 id；删掉它，下一条请求就会新建会话 |
| `./data/images/<ticket>/` | 生成的图片 |
| `./data/*`（QQBridge） | 票据与去重 SQLite |
| `./workspace/` | codex 工作目录 |

## 5. 测试

```powershell
npm ci
npm run typecheck
npx vitest run            # 全部（agent + qq）
npx vitest run test/agent # 仅 agent：faux 模型路由、假 codex、假 comfy-mcp、reply_qq 截断
docker build -t cs-agent:dev .
docker compose config
```

测试不访问真实 QQ、模型或 ComfyUI。

## 6. 排障

- **comfy 自检失败 / 生图一直失败**：在 `.env` 设置 `COMFY_MODE=http` 后重启。这个模式直接调用 ComfyUI 的 `/prompt`、`/history`、`/view`。
- **codex 一直失败**：`docker compose exec cs-agent codex exec --skip-git-repo-check -s read-only "hi"`，看具体报错（auth、sandbox、网络）。
- **会话卡住**：重启容器后，未完成的消息会从 `agent.sqlite` 继续处理。被中断的工具调用不会自动重跑，模型会收到 interrupted 结果，再回复用户。如果模型最终没有调用 `reply_qq`，系统会发一条兜底回复。
