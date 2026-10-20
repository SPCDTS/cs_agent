# 容器内 codex 经宿主机 magpie 出站（2026-10-19，用户决定）

用户原话："容器中的 codex 模型都不再直连，全都连到我宿主机的 magpie，codex 通过 `supports_websockets = false` 来关闭 websocket。"本文是实施约束；§6 记录验收。

## 0. 已核实的事实

- **宿主机 magpie**（yetone/magpie，`C:\Users\SPCDTS\AppData\Local\Programs\yetone-magpie\magpie.exe`，配置 `~/.config/magpie/`）正在运行，网关只监听 `127.0.0.1:3425`（另有 `127.0.0.1:9709` 为内部端口）。`GET /v1/models` 列出 `codex/gpt-6.1-sol`（`/v1/responses`，窗口 500,000）、`codex/gpt-6-astra`（272,000）、`deepseek/deepseek-flash`；`GET /v1/magpie/usage` 有 `calls/input/output/cache_read/cost/ttft_ms` 等字段。magpie 的 `providers.json` 里 codex 提供者走你的 ChatGPT 计划（`quotas.json`：plan pro，余 61,496 credits）。
- **宿主机 codex 已经是 magpie 接管的形态**：`~/.codex/config.toml` 由 magpie 写入 `[model_providers.magpie]`：`base_url = "http://127.0.0.1:3425/v1"`、`wire_api = "responses"`、`experimental_bearer_token = "…"`、`http_headers = { "x-openai-actor-authorization" = "magpie" }`。容器照抄这一形态即可，差别只在地址与鉴权。
- **远程调用规则**（magpie reference "LAN sharing"）：只有打开 **Settings → Share on local network** 后网关才监听所有接口；来自非回环地址的请求（Docker 端口映射与 bridge 都算远程）必须带一把启用的 gateway key（`Authorization: Bearer sk-magpie-key-…`，也接受 `x-api-key`），否则 401；未共享时远程请求 403。可用 `MAGPIE_ALLOW_IPS`（或 Settings → Network and sharing → Allowed addresses）把允许来源限定为 compose 网段 `172.20.0.0/16`（`docker network inspect cs_agent_default`）。Codex 在别的机器上可把共享 magpie 设为 model provider，并从 `GET /v1/codex/models` 读 codex 形状的模型目录（`/v1/models` 是 OpenAI 形状，codex 读不了）。
- **codex 0.163 提供者配置**（二进制字符串核实）：`model_providers.<id>` 支持 `name`、`base_url`、`wire_api`（必须 `"responses"`，`"chat"` 已不支持）、`env_key`、`experimental_bearer_token`、`http_headers`、`model_catalog_url`、`requires_openai_auth`、`supports_websockets`/`prefer_websockets`；顶层 `model_provider = "<id>"` 选用。`supports_websockets = false` 即用户指定的关闭 WebSocket 方式（二进制里存在该键；实测见 §4）。
- **cs-agent 对 codex 的依赖面**：`codexHome` 下的 `auth.json`（ChatGPT OAuth）仅用于直连；`loadCodexContextWindow` 通过 `codex debug models` 读目录取 `context_window`，离线签名（全部 272,000）时回退 `models_cache.json`；rollout 的 `model_context_window` 仍由 codex 自己写，O3 分析不受影响；`features.plugins=false` 已关插件同步。
- 现状问题（cs-agent-b7 发现）：owner 线程请求体 16.87 MB，WebSocket 在约 16 MiB 时被服务端关闭，codex 每轮重试 1.5–2 分钟后才降级 HTTPS。关 WebSocket 直接解决；经 magpie 后 magpie 自身也只用 HTTPS 转发。

- **实测（2026-10-19，Share on local network 打开后）**：容器内 `host.docker.internal:3425` 带 key `GET /v1/models` 200 且只列 `codex/*`（key 限定生效）；**不带 key 的 `GET /v1/models` 与 `POST /v1/responses` 也都 200 并真实完成了一次模型调用**（usage.jsonl 记为 `node`）。原因：Docker Desktop（Windows）把容器到 `host.docker.internal` 的流量经宿主机 NAT，magpie 看到的对端是回环地址，按"回环永远宽松"处理。结论：对这条路径，gateway key 的作用是**归集用量与限定模型**，不是访问控制；`MAGPIE_ALLOW_IPS` 对它也不生效。宿主机上任何本地进程本来就能用 magpie，容器并未扩大攻击面；但 codex 沙箱内的命令若能访问网络，也能直接调 magpie 绕过 key 的模型限制——**`CODEX_SANDBOX_NETWORK` 保持现状（联网）时需接受这一点**，或在 magpie 侧用 `MAGPIE_ADDR` 固定到 LAN 网卡地址（文档称此时本机调用也要 key），作为可选加固列入 §5。

## 1. 目标形态

```
cs-agent 容器 ── codex exec ──► http://host.docker.internal:3425/v1 (Bearer sk-magpie-key-…, HTTPS 传输, 无 WebSocket)
                                   │
                           宿主机 magpie 3425（Share on local network 开；Allowed addresses = 172.20.0.0/16）
                                   │
                           ChatGPT 计划（codex 提供者）/ 其他提供者，按 magpie 路由
```

- 容器内 codex 不再持有 ChatGPT 凭据：`auth.json` 不再需要（保留文件但不使用；下一步可从 compose 卷里移除，见 §5）。
- 用量、缓存命中、费用统一在 magpie 的 Usage 页按 gateway key 名（`cs-agent`）归集；cs-agent 自己的观测（trace 的 `token_usage`、上下文占用）不变。
- 模型切换在 magpie 侧完成：cs-agent 的 `CODEX_MODEL` 写 magpie 的模型 id（默认 `codex/gpt-6.1-sol`，必须与 `/codex/models` 的 slug 完全一致，见 §2）。

## 2. 改动清单

| 文件 | 改法 |
|---|---|
| `scripts/entrypoint.sh` 受管 `config.toml` | 新增环境变量 `CODEX_PROVIDER=magpie\|openai`（默认 `magpie`）。`magpie` 时写入：顶层 `model_provider = "magpie"`；`[model_providers.magpie]` 含 `name = "magpie"`、`base_url = "${CODEX_MAGPIE_URL:-http://host.docker.internal:3425/v1}"`（`toml_path` 同一口径校验 URL 字符）、`wire_api = "responses"`、`experimental_bearer_token = "${CODEX_MAGPIE_KEY}"`（必填；缺失则 `echo ERROR` 并退出非 0，不写半截配置）、`http_headers = { "x-openai-actor-authorization" = "cs-agent" }`、`supports_websockets = false`、`model_catalog_url = "${CODEX_MAGPIE_URL}/codex/models"`（实测 §4 第 2 条确认后保留，否则删）。`openai` 时不写这些段，行为同现在。 |
| `scripts/entrypoint.sh` 禁读列表 | `$CODEX_HOME/auth.json` 已在 `deny_read`；`config.toml` 里现在含 magpie key，**把 `config.toml` 也加入 deny_read**（实测：codex 的 arg0 辅助程序只需 `$CODEX_HOME/tmp`，`config.toml` 由 codex 主进程而非沙箱内命令读取，加入禁读不影响运行；若实测影响，改为把 key 放 `env_key = "CODEX_MAGPIE_KEY"` 并经 `childEnv` 注入，不落盘）。 |
| `src/agent/codex/runner.ts` `childEnv` | `CODEX_PROVIDER=magpie` 时不再设置任何 OpenAI 直连相关环境；若采用 `env_key` 方案则注入 `CODEX_MAGPIE_KEY`。`registerSecrets` 加入该 key（脱敏）。 |
| `src/agent/codex/model-catalog.ts` | `codex debug models` 经 magpie 时返回 magpie 的目录；`CODEX_MODEL` 与目录 `slug` 必须完全相等，保留提供者前缀，窗口取目录值；离线签名回退也只匹配相同 slug。 |
| `src/config.ts` | `CODEX_PROVIDER`（枚举，默认 `magpie`）、`CODEX_MAGPIE_URL`（`serviceUrl`，默认 `http://host.docker.internal:3425/v1`）、`CODEX_MAGPIE_KEY`（string，`magpie` 时必填）；`CODEX_MODEL` 默认为 `codex/gpt-6.1-sol`。Codex 按完整 slug 匹配模型元数据，省略前缀会回退到默认 `ModelInfo`，即使网关仍能路由短名。 |
| `src/obs/ui/*`（设置页） | 后端信息里显示"codex 经 magpie（host.docker.internal:3425）"或"直连"，只读。 |
| `docs/DEPLOY.md` | 新章节"codex 经 magpie"：宿主机侧三步（开 Share on local network；`magpie gateway-key add cs-agent` 取 key；Allowed addresses 填 `172.20.0.0/16`）、`.env` 三个变量、回退到直连（`CODEX_PROVIDER=openai`）、magpie Usage 页按 key 看用量。现有"ChatGPT 凭据在容器内"的描述改为"仅 `CODEX_PROVIDER=openai` 时"。 |
| `.env.example`、`docs/ARCHITECTURE.md` §2/§5.6 | 同步。 |
| `test/entrypoint.test.ts` | 默认写出 magpie 段与 `supports_websockets = false`、缺 key 时退出非 0、`openai` 时不写；`test/agent/codex-model-catalog.test.ts` 前缀匹配；`test/config.test.ts` 默认值。 |

不改：codex 的 MCP（qq_context 等）、附件、受管 AGENTS.md、pi 后端（pi 走 pi-ai 的 DeepSeek provider，是否也经 magpie 另议）。

## 3. 宿主机侧（主会话执行，用户只需点一次开关）

1. **用户**：magpie 窗口 Settings → Share on local network 打开（CLI 无此开关，需在界面点）。
2. 主会话：`magpie gateway-key add cs-agent` 得到 `sk-magpie-key-…`，写入 `.env` 的 `CODEX_MAGPIE_KEY`（不入库；`.env` 已在 .gitignore）。`magpie gateway-key models <id> codex/*` 限定只能用 codex 提供者的模型（防止容器误用 DeepSeek 计费）。
3. 主会话：Settings → Network and sharing → Allowed addresses 填 `172.20.0.0/16`（或启动 magpie 时设 `MAGPIE_ALLOW_IPS`；桌面版以界面为准）。Windows 防火墙若拦 3425，放行该端口仅对 Docker 的虚拟网卡（`vEthernet (WSL)`）。
4. 验证：容器内 `curl -H "Authorization: Bearer $KEY" http://host.docker.internal:3425/v1/models` 返回 200 且含 `codex/gpt-6.1-sol`；无 key 返回 401。

## 4. 实测项（实施时在容器内用临时 CODEX_HOME 真实 exec 验证，结论写进 §6）

1. `model = "codex/gpt-6.1-sol"` 必须匹配 `/codex/models` 的完整 slug，核对 Codex 使用目录中的上下文窗口及能力，不能仅以请求是否成功路由判断模型配置有效。
2. `model_catalog_url = …/v1/codex/models` 是否让 `codex debug models` 返回带 `context_window` 的目录；否则靠 `models_cache.json`。
3. `supports_websockets = false` 生效：stderr 无 "Falling back from WebSockets"，首字节时间正常；对照组不加该键。
4. 一张 16 MB+ 请求（复制 owner 线程 resume 一轮）经 magpie 一次成功，无 1.5–2 分钟等待。
5. magpie Usage 页出现 `cs-agent` 键名下的调用与缓存命中。
6. 沙箱内 `cat $CODEX_HOME/config.toml` 被拒（deny_read 生效）且 codex 仍能正常启动。

## 5. 后续（不在本次）

- 可选加固：magpie 以 `MAGPIE_ADDR=<LAN 网卡 IP>:3425` 启动并把 cs-agent 指向该 IP，使容器调用也必须带 key（代价：宿主机本地 agent 也要配 key）。
- 从 compose/`data/codex` 中移除 `auth.json` 的依赖（init-auth 脚本标记为仅 `CODEX_PROVIDER=openai` 需要）。
- pi 后端的 DeepSeek 也经 magpie（pi-ai 的 OpenAI-compatible provider 指向 `host.docker.internal:3425`），统一用量归集。
- 观测面板读取 magpie `/v1/magpie/usage`（按 key 过滤）显示费用与缓存命中（设计 §8 曾讨论）。

## 6. 验收记录

### 2026-10-19，主会话验收

- 宿主机：用户打开 Share on local network（3425 监听 0.0.0.0）；`magpie gateway-key add cs-agent`（id ba4f49d9…，`gateway-key models … 'codex/*'` 限定只用 codex 提供者），key 写入 `.env` 的 `CODEX_MAGPIE_KEY`。容器内 `GET /v1/models` 带 key 只列 `codex/gpt-6.1-sol`、`codex/gpt-6-astra`；`GET /v1/codex/models` 返回 codex 形状目录。实测 NAT 结论见 §0。
- 代码（1ad383e…e421a51，5 条）：`CODEX_PROVIDER`（默认 magpie）/`CODEX_MAGPIE_URL`/`CODEX_MAGPIE_KEY`；缺 key 的校验在 `CodexRunner` 构造器（不在 `loadConfig`，MCP 进程不受影响）；受管 config.toml 写 `model_provider = "magpie"` 与 `[model_providers.magpie]`（`wire_api = "responses"`、`env_key = "CODEX_MAGPIE_KEY"`、`x-openai-actor-authorization = cs-agent`、`supports_websockets = false`、`model_catalog_url = …/v1/codex/models`），key 由 runner 注入子进程环境、`registerSecrets` 脱敏，直连模式清除残留 key，magpie 模式剔除 `OPENAI_*`；目录匹配兼容 `codex/` 前缀；设置页只读显示出站方式。沙箱外复跑 1354 项通过。
- 后续修正（2026-10-20）：下面的短名实验只验证路由成功；Codex 0.163 用短名会落到默认模型元数据（272k，缺少 Responses Lite），完整 slug 才能匹配目录中的 500k 与能力。因此默认值、校验和 UI 均改为精确 slug，不保留短名兼容。
- 容器内真实 exec 实验（临时 CODEX_HOME，`docs/magpie-exp.sh`）：`env_key` 鉴权成功回答 "ok"；`gpt-6.1-sol` 与 `codex/gpt-6.1-sol` 都被路由（rollout 记录各自的 model 字符串）；`codex debug models` 经 `model_catalog_url` 返回 `codex/gpt-6.1-sol` 窗口 500,000；有/无 `supports_websockets=false` 两组 stderr 均无 WebSocket/Falling back 字样，首字节约 18–20 s（低推理档）。magpie `usage.jsonl` 四次调用均为 `agent=codex`、`callerKeyName=cs-agent`、`host=chatgpt.com as …`，其中一次 `cache_read=4096`，证明 Bearer 已携带、归集与缓存命中可见。
- 部署：镜像 `703b1b00…`（干净 worktree，main e421a51），容器 healthy，启动日志 `codex context window 500000 source=catalog.context_window`（经 magpie 目录），`config.toml` 无 key 字样。待用户发一条私聊验证 owner 线程（16.87 MB 请求体）经 magpie 一次成功、无 WebSocket 回退等待。
- 主会话复核（2026-10-19 12:30–12:35，用户私聊两轮，owner 线程，effort high）：两轮均一次成功回复，`codex backend done` 分别 77.8 s / 94.7 s，`attempts: 1`，容器日志与 rollout 中没有任何 WebSocket/Falling back 字样，也没有之前每轮 1.5–2 分钟的降级空档。magpie `usage.jsonl` 两条记录均为 `agent=codex`、`callerKeyName=cs-agent`、`host=chatgpt.com as …`：第 1 轮 `in=201108`、`cache_read=3712`、`ms=45569`、`ttft_ms=21885`、`sent_ms=9636`；第 2 轮 `in=18067`、`cache_read=200320`（提示缓存跨轮命中，经 magpie 不丢）、`ms=62167`、`ttft_ms=19878`、`sent_ms=10363`。每轮只有一条用量记录，说明回合内的 web_search 由 Responses 服务端工具在同一请求内完成。按 rollout 时间戳分解第 2 轮：消息路由 12:33:37.3 → `thread_settings_applied` 12:33:56.5（codex 启动并加载 33.7 MB rollout，约 19 s）→ 用户消息入历史 12:33:59.8 → 首个 item 12:34:54.5（约 10 s 上传 16.87 MB 请求体 + 约 20 s 首 token + 推理）→ `task_complete` 12:35:10.7 → 进程退出 12:35:12.1。剩余可压的只有 resume 加载的约 19–22 s，根因是历史里内联的生图，缓解仍是压缩/重置 owner 线程（§5 可选项），与出站路径无关。结论：codex 经 magpie 的切换验收通过。
