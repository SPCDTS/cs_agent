# cs_agent 部署手册

Compose 双服务：QQ（`napcat` 容器）→ `cs-agent` 规则分流 →（`奶龙:` 前缀）宿主机 ComfyUI 生图，或（其他消息）执行 agent（默认容器内 codex）→ 回到原 QQ 会话。设计见 `docs/ARCHITECTURE.md`。

## 0. 使用方式（v3）

- **生图**：消息以 `奶龙:` 或 `奶龙：`（半角/全角冒号均可，`IMAGE_PREFIXES` 可改）开头，前缀后先解析空格分隔的内联选项，其余文字原样作为提示词，例如 `奶龙: 一只戴墨镜的柴犬，赛博朋克风`。群里照常 @机器人 后再写。前缀后为空时回复"奶龙: 后面写要画的内容"。成功回复"图片生成好了"+图；失败按类别回复：服务不可用 / 超时 / 内容被拒 / 其他。不经过任何模型。
- **其他消息**：整条交给执行 agent（`AGENT_BACKEND`，默认 codex）。codex 可以联网搜索、检索聊天记录；cs-agent 自带的 `image_gen` MCP 默认关闭（`CODEX_IMAGE_GEN=off`），codex 内置技能不受影响。历史图片可通过 `qq_image` 召回，再用 `qq_view_image` 查看。
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
2. **NapCat** 默认运行在 Compose 内网，地址为 `http://napcat:3000` / `ws://napcat:3001`，使用同一 `NAPCAT_TOKEN`，`messagePostFormat: array`。首次使用按下文「NapCat 容器」播种配置并扫码。也可通过环境变量指向宿主机 NapCat：`host.docker.internal:3000/3001`；原宿主机 `agent-http` / `agent-ws` 的 loopback 绑定可保留。迁移时沿用已有 `NAPCAT_TOKEN`。
3. **ComfyUI** 用 `D:\Tools\ComfyLocal\start.ps1` 启动（127.0.0.1:8188），不需要改监听地址。
4. **Codex 提供者**：默认经宿主机 magpie，按下文「codex 经 magpie」配置 gateway key。仅 `CODEX_PROVIDER=openai` 直连时需要容器内 ChatGPT 凭据，在仓库根目录运行
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\init-auth.ps1
   ```
   它会把 `~/.codex/auth.json`（`auth_mode=chatgpt`）复制到 `./data/codex/auth.json`。仅直连的 codex 使用这一份；如果另外选择 `AGENT_MODEL_PROVIDER=openai-codex`，pi / 摘要模型也会使用它（不随 CODEX_PROVIDER 改变）。脚本不会打印 token。
   也可以不复制，改为在容器里登录：`docker compose run --rm cs-agent codex login --device-auth`（`CODEX_HOME=/data/codex`）。
   入口脚本带参数时，会先准备目录和 `config.toml`，再 `exec` 这个命令；不带参数时才启动 agent。其他一次性命令同理，例如 `docker compose run --rm cs-agent codex --version`。

> 以下刷新冲突仅涉及使用 ChatGPT OAuth 的进程（codex 仅在 `CODEX_PROVIDER=openai` 时）：refresh_token 会轮换。容器（agent / 容器内 codex）刷新后会写回 `./data/codex/auth.json`，宿主机那份 `~/.codex/auth.json` 可能随之失效，反过来也一样。容器内的 agent 每次读写都重新读取文件，只在 token 快过期时刷新；刷新完成、写回之前会再读一次文件，如果其中的 `refresh_token` 已经变了（说明容器内 codex 在此期间刷新过），agent 采用文件里的新 token，丢弃自己的刷新结果，不覆盖。这样能避免绝大多数互相覆盖，但"再读一次"和写回之间仍有极短的窗口，两者不共享文件锁，不能做到绝对互斥；万一出现鉴权失败，重新运行 `scripts/init-auth.ps1` 或在容器内 `codex login --device-auth` 即可。宿主机 codex 失效时重新 `codex login` 即可。

## 2. 配置

```powershell
# 仅首次安装时复制；已有 .env 不覆盖。
Copy-Item .env.example .env
# 编辑 .env：填写 CODEX_MAGPIE_KEY、NAPCAT_TOKEN、NAPCAT_WEBUI_TOKEN、DEEPSEEK_API_KEY（或 DEEPSEEK_APIKEY），确认 QQ_ALLOW_USERS / QQ_ALLOW_GROUPS
```

关键变量（完整列表见 `.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAPCAT_HTTP_URL` / `NAPCAT_WS_URL` | `http://napcat:3000` / `ws://napcat:3001` | 默认 Compose 内网；本地直接运行或回退宿主机时显式覆盖 |
| `NAPCAT_TOKEN` | 空 | HTTP/WS 共用的 OneBot token；播种脚本要求非空，迁移时保留原值 |
| `NAPCAT_WEBUI_TOKEN` | 空 | 随机生成的 WebUI 登录口令，与 OneBot token 分开；已有 WebUI 配置不会被此变量覆盖 |
| `QQ_BOT_ACCOUNT` | 空 | 可选 QQ 号，传给 NapCat `ACCOUNT` 快速登录；首次仍需扫码 |
| `IMAGE_PREFIXES` | `奶龙:,奶龙：` | 生图前缀，逗号分隔，逐字匹配（大小写与全/半角按原样），较长的优先；留空用默认 |
| `AGENT_BACKEND` | `codex` | 执行 agent 后端：`codex`（容器内 codex 固定线程）或 `pi`（进程内 pi-durable 长期会话，工具可联网检索、查历史、生图） |
| `AGENT_BACKEND_OVERRIDES` | 空 | 按会话覆盖后端：`group:200000001=pi,private:10000001=codex`。格式错误时启动失败。后端按会话（线程）选择：owner 的所有账号共用 owner 线程，按**首个 owner 账号**（`QQ_OWNER` 列表第一个）的 `private:<QQ号>` 覆盖选择，其他 owner 账号的覆盖项对 owner 线程无效。切换（含面板修改）在会话空闲且旧后端在该会话没有后台工作（pi 子 agent 在跑、旧 exec 未退出）后的下一轮生效，两个后端的记忆互相独立 |
| `AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID` | `deepseek` / `deepseek-flash` | 执行模型：用于 pi 后端与聊天记录日/周摘要（DeepSeek OpenAI 兼容接口 `https://api.deepseek.com`）。也可切换到 `openai-codex`（复用 `auth.json` 的 ChatGPT OAuth，如 `gpt-6-luna`）、`openai`、`anthropic` 等，后两者需设置对应的 `*_API_KEY` |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek API key；写作 `DEEPSEEK_APIKEY` 也可（启动时自动映射）。provider 为 `deepseek` 时缺少密钥，agent 启动即退出 |
| `AGENT_THINKING_LEVEL` | `low` | 意图模型思考档位。deepseek-flash 支持 off/low/high/max，其他值就近调整（如 medium → high）并记 warn 日志 |
| `AGENT_CONCURRENCY` | 2 | 同时处理的 QQ 消息数，多出来的排队（排队状态已持久化） |
| `COMFY_MODE` | `mcp` | 两种模式共用参数化 Qwen 工作流；mcp 写临时 JSON 后调用 run_workflow，http 直接 POST /prompt |
| `COMFY_WORKFLOW_FILE` / `COMFY_PROMPT_NODE` | 空 / `4` | 可选自定义 API 图覆盖；留空使用生成器，旧部署显式配置不会自动清除 |
| `COMFY_CHECKPOINT` | 空 | 旧接口兼容项，内置 Qwen 生成器不使用 |
| `COMFY_QWEN_CACHE` | `false` | `true` 时在 UNETLoader 后插入 QwenImage21Cache，需本机安装对应节点 |
| `CODEX_SANDBOX` | `workspace-write` | 如果容器内 codex 报 sandbox/landlock 错误，改为 `danger-full-access`（这时容器本身就是沙箱） |
| `ATTACH_FILE_MAX_MB` / `ATTACH_FILES_MAX` | 20 / 3 | 单个文件上限（MiB）与每轮文件数；同内容按 sha256 去重 |
| `ATTACH_FILE_DENY_EXT` | `.exe,.bat,.cmd,.ps1,.vbs,.js,.scr,.msi,.com,.lnk` | 附件扩展名黑名单，逗号分隔、不区分大小写 |
| `CODEX_IMAGE_GEN` | `off` | cs-agent 的生图 MCP：`off` 不注册、不注入参数，`on` 恢复；不影响 pi 与规则分流 |
| `COMFY_TIMEOUT_SEC` | 300 | codex 不设单轮时限（停滞由看门狗判定）；生图收取预算按 1mp/2mp/2k 分别为 120/240/600 秒 × count，上限 COMFY_TIMEOUT_SEC；默认额外收取 2 次，始终使用原 prompt_id |
| `IMAGE_GEN_MCP_WAIT_SEC` / `IMAGE_COLLECT_EXTENSIONS` | 90 / 2 | MCP 最多等待参数预算与前者的较小值；超时交给 agent 的 lateImages 阶段，后者控制两条生图路径的额外收取窗口数 |
| `CODEX_PROVIDER` | `magpie` | `magpie\|openai`；默认经宿主机网关，`openai` 恢复直连 |
| `CODEX_MAGPIE_URL` | `http://host.docker.internal:3425/v1` | Responses API 根地址；入口脚本只接受安全字符组成的 HTTP(S) URL，不能含凭据、查询或片段；尾斜杠会移除 |
| `CODEX_MAGPIE_KEY` | 空 | 基础配置解析允许为空，magpie runner 启动时必填；只经环境变量注入并注册脱敏 |
| `CODEX_MODEL` / `CODEX_REASONING_EFFORT` | `codex/gpt-6.1-sol` / `high` | 写入受管的 `./data/codex/config.toml`（见第 4 节）。`CODEX_REASONING_EFFORT`（`low/medium/high/xhigh/max`）固定使用，每轮也以 `-c model_reasoning_effort="…"` 显式传入（日志 `codex backend done` 的 `effort` 字段）；v3 不再按请求选择 |

> codex 子进程只拿到最小环境变量：`PATH`、`HOME`、`LANG`/`LC_ALL`、`TERM`、`CODEX_HOME`、`NO_COLOR=1`，以及设置了的 `HTTP(S)_PROXY`/`NO_PROXY`。`NAPCAT_TOKEN`、`*_API_KEY` 等配置不会传给 codex；magpie 模式只额外注入专用 `CODEX_MAGPIE_KEY`，直连模式不传该 key。

## codex 经 magpie

宿主机侧按以下步骤配置（容器内 codex 使用宿主机 magpie 的模型提供者）：

1. magpie 的 Settings → **Share on local network** 打开局域网共享。
2. 在宿主机执行 `magpie gateway-key add cs-agent`，将返回的 key 填到私有 `.env` 的 `CODEX_MAGPIE_KEY`；再执行 `magpie gateway-key models <id> 'codex/*'`，将该 key 限定到 codex 模型。不要把真实 key 放进文档或提交。
3. Settings → Network and sharing → Allowed addresses 填入实际 Docker 网段（当前设计为 `172.20.0.0/16`）；如有防火墙阻拦，仅向 Docker 虚拟网卡放行 3425。注意下文 NAT 例外。

```dotenv
CODEX_PROVIDER=magpie
CODEX_MAGPIE_URL=http://host.docker.internal:3425/v1
CODEX_MAGPIE_KEY=<仅在私有环境中填写 gateway key>
CODEX_MODEL=codex/gpt-6.1-sol
```

入口脚本写入 `model_provider = "magpie"` 与 Responses provider，指定 `supports_websockets = false`，直接使用 HTTP 流而不先尝试 WebSocket。容器到默认网关地址为 HTTP，magpie 到上游为 HTTPS。模型默认是 `codex/gpt-6.1-sol`。`CODEX_MODEL` 和运行时 `codexModel` 必须与 `GET $CODEX_MAGPIE_URL/codex/models` 返回的 `slug` 完全一致，不省略或自动补齐前缀。Codex 0.163 按完整 slug 查找模型元数据；短名即使能被网关路由，也会使 Codex 回退到默认 `ModelInfo`（例如 272k 而非目录中的 500k 上下文，缺少 Responses Lite 等能力）。

配置文件仅保存 `env_key = "CODEX_MAGPIE_KEY"`。主进程构造 CodexRunner 时检查 key，缺失或纯空白会以「配置无效：CODEX_PROVIDER=magpie 需要 CODEX_MAGPIE_KEY」启动失败；目录查询、exec 和 resume 共用同一份受控环境。基础 `loadConfig` 不检查 key，以便 qq_context / image_gen MCP 继续读取自身配置；MCP 不新增 gateway key 透传。key 加入主进程脱敏表。由于 key 不落盘，`config.toml` 无需加入 deny_read，原有凭据和数据禁读规则不变。

目录地址为 `<CODEX_MAGPIE_URL>/codex/models`（默认 `/v1/codex/models`）；`codex debug models` 的 slug 仅精确匹配完整名称，取 `context_window` 原值。保留离线目录签名与 `models_cache.json` 回退，缓存也只匹配相同 slug。设置页只读显示「codex：经 magpie（URL）」或「codex：直连」。

在 magpie **Usage** 页按 gateway key 名 `cs-agent` 查看调用、缓存命中及费用；cs-agent 原有 token_usage 与上下文观测不变。健康检查在 magpie 模式只确认 key 已配置，不探测远端服务，也不再要求 `auth.json`；真实连通性以实验回答和 Usage 记录为准。

**Docker Desktop NAT 例外（设计 §0 已实测）**：容器访问 `host.docker.internal` 会被 magpie 视为回环，无 key 的请求也可能成功；这条路径上 key 用于归集用量与限定模型，不能当作访问控制，Allowed addresses 也不起作用。当前保持命令沙箱可联网，命令能够直接访问网关并绕过 key 的模型限制。可选加固是在 magpie 侧用 `MAGPIE_ADDR=<LAN 网卡 IP>:3425` 固定到 LAN 地址，再同步修改 URL；这会要求本机调用也提供 key，未包含在本次变更中。

回退时设置 `CODEX_PROVIDER=openai`、准备容器内 `auth.json`（`scripts/init-auth.ps1` 或 `codex login --device-auth`），然后重建 / 重启服务。入口脚本会重写受管文件并移除 magpie 顶层选择与 provider 段，runner 不再注入 magpie key。pi 后端与 DeepSeek 配置不受此开关影响。

容器真实验证脚本 `docs/magpie-exp.sh` 为未提交的交接文件，由主会话在独立 `CODEX_HOME=/data/codex-exp-mg` 中运行，检查 env_key、两种模型名、目录窗口及 WebSocket 对照。NAT 路径上「回答成功」本身不能证明 Bearer 已携带，须同时确认 Usage 归集到 `cs-agent`。16 MB+ owner 回合及真实缓存命中仍需主会话补验。

## NapCat 容器

本节是部署时执行的步骤；本次代码改动不启动容器、不修改实际 `.env`。OneBot 的 3000/3001 只在 Compose 网络内使用，容器中监听 `0.0.0.0`；WebUI 只发布到宿主机回环。`cs-agent` 用普通 `depends_on: [napcat]` 控制启动顺序，不等待健康状态，未登录时由现有 WS 重连逻辑等待。

| 服务 | 容器监听 / 目标 | 宿主机发布 | 用途 |
|---|---|---|---|
| NapCat HTTP | `0.0.0.0:3000` | 不发布 | `cs-agent` 调用 OneBot 动作 |
| NapCat WS | `0.0.0.0:3001` | 不发布 | `cs-agent` 接收 OneBot 事件 |
| NapCat WebUI | `6099` | `127.0.0.1:${NAPCAT_WEBUI_PORT:-6099}` | 登录、扫码与配置；宿主机旧 NapCat 仍占用 6099 时在 `.env` 设 `NAPCAT_WEBUI_PORT=6098` |
| cs-agent HTTP | `0.0.0.0:8787` | `127.0.0.1:8787` | 观测面板与健康检查 |
| 宿主机 ComfyUI | `host.docker.internal:8188` | 沿用宿主机 `127.0.0.1:8188` | 生图，迁移不改变此地址 |

### 首次登录与迁移

1. 在部署仓库的 `.env` 中设置非空 `NAPCAT_TOKEN`；迁移时沿用原值。为 `NAPCAT_WEBUI_TOKEN` 生成独立随机口令，可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`，将结果填入 `.env`。`QQ_BOT_ACCOUNT` 可填写机器人 QQ 号，留空则不启用快速登录。已有部署此时保持 cs-agent 的宿主机 URL 不变。
2. 在宿主机运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/napcat-config.ps1`（也可用 `pwsh`）。脚本默认定位自身所在仓库，支持 `-Root <目录>` 用于隔离测试。读取 `.env` 中的两个键，支持单行引号和行尾注释，不执行命令、不展开变量；含 `$`、`#` 的 token 建议用单引号包裹。账号为空只生成 `onebot11.json`；非空时另写 `onebot11_<QQ号>.json`。
3. 执行 `docker compose up -d napcat`，用 `docker compose logs -f napcat` 等待 WebUI 就绪。打开 `http://127.0.0.1:6099/webui`，用 WebUI 口令登录并扫码。`ACCOUNT` 只帮助快速登录，不能代替首次扫码。健康检查只确认 WebUI HTTP 可访问，不代表 QQ 已登录或 OneBot 已就绪。
4. 在 WebUI / 日志确认机器人在线，并从 Compose 网络用带 Bearer token 的 `/get_login_info` 确认账号。已有 cs-agent 容器可执行下列只读检查，口令从容器环境读取，不直接写入命令：

   ```powershell
   docker compose exec cs-agent node -e "fetch('http://napcat:3000/get_login_info',{headers:{Authorization:'Bearer '+process.env.NAPCAT_TOKEN}}).then(r=>r.json()).then(console.log)"
   ```

5. 迁移已有部署时，**先停宿主机 NapCat**（退出 QQNT 或停启动项），再把 `.env` 中两项 URL 切到 `http://napcat:3000` / `ws://napcat:3001`，执行 `docker compose up -d cs-agent`。新安装在扫码后按下一节启动。cs-agent 始终只连接一个 NapCat，避免双响应。
6. 发一条私聊确认收发，并在 `http://127.0.0.1:8787/live` 检查事件。真实迁移结果另记入设计文档 §6。宿主机 NapCat 停用但保留一周供回退，再由用户决定清理。

### 配置、数据与口令更新

- `./napcat/config` → `/app/napcat/config`：OneBot 配置及 `webui.json`。`./napcat/qq` → `/app/.config/QQ`：QQ 登录态和数据。整个 `napcat/` 已加入 `.gitignore`，包括备份都不得入库；备份时两目录一起保管。不迁移宿主机历史数据，cs-agent 聊天记录仍在原 `data/` 中。Windows Docker Desktop 卷由 VM 映射，不需要脚本修改目录权限。
- 播种脚本新建 JSON 使用 UTF-8 无 BOM。两个受管服务 `agent-http` / `agent-ws` 的 token 均一致时打印 `unchanged`，不写文件、不改 mtime。任一 token 不同时先保存原字节到 `*.bak-<UTC时间戳>`，再只替换这两个 token 字段；其余字段、排版、原编码、BOM 和换行保留。缺少 token、账号非法、JSON 损坏或缺少受管服务时退出，不覆盖已有文件。脚本不会重置手工调整的端口等选项。
- 轮换 `NAPCAT_TOKEN` 时，在维护窗口停止 NapCat、修改 `.env`、重新播种，再重建 NapCat 与 cs-agent 服务使两端生效。`WEBUI_TOKEN` 仅在 `webui.json` 不存在时初始化；已有 WebUI 口令通过 WebUI 修改，单改 `.env` 不会生效。
- 固定 `mac_address: 02:42:ac:11:00:02` 减少设备指纹变化；不要在升级时随意改 MAC 或删除 QQ 数据目录。OneBot 配置由脚本播种，Compose 不设置 `MODE`。

### 更新镜像与回退

镜像固定为 2026-10-19 `latest` 的 index digest：`sha256:f611790ecffa23c3c182017d5cf68179dc24612403608cd835ad13d79642f1bd`。更新前备份上述两个目录，执行 `docker buildx imagetools inspect mlikiowa/napcat-docker:latest` 核实新 index digest，修改 `docker-compose.yml` 中 digest 和日期注释，再运行 `docker compose pull napcat`、`docker compose up -d napcat`。保留旧 digest 供回退；不使用 NapCat 版本号猜镜像标签。健康检查采用 `curl -fsS --max-time 4`；[官方基础镜像构建文件](https://github.com/NapNeko/NapCat-Docker/blob/main/base/Dockerfile) 明确安装 curl、未声明 wget，更新时需重新核实镜像工具。

回退到宿主机 NapCat：先 `docker compose stop napcat`，把 `.env` 的 HTTP/WS URL 分别改回 `http://host.docker.internal:3000` / `ws://host.docker.internal:3001`，确认宿主机 OneBot token 与 `.env` 一致，再执行 `docker compose up -d --no-deps cs-agent` 并重新启动宿主机 NapCat。这里必须带 `--no-deps`，防止 Compose 因依赖关系重新启动容器 NapCat；保留容器数据目录，完成私聊与 `/live` 验证。

Codex 收尾时先等待主进程退出，再给输出管道一个有限的刷新窗口；已取得退出码后，总超时不再把成功回合改判失败。正常 `close` 会立即返回，不额外等待 grace；强制收尾会保留本轮输出文件与附件，供正常结果提交或票据恢复使用。Linux 清理 runner 创建的进程组；Windows 使用 `taskkill /T /F`。若系统拒绝终止，runner 仍释放本端管道并结束等待，但进程是否实际清理需要在有权限的环境验证。

### Codex trace 与内置生图输出清理

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `CODEX_TRACE_RETENTION_DAYS` | 14 | 官方 trace 保留天数；0 禁用请求负载记录并关闭按天清理 |
| `CODEX_TRACE_MAX_MB` | 512 | 官方 trace 普通文件总量上限，单位 MiB；0 不限 |
| `CODEX_GENERATED_IMAGES_RETENTION_DAYS` | 7 | 内置生图输出保留天数；0 关闭按天清理 |
| `CODEX_GENERATED_IMAGES_MAX_MB` | 1024 | 内置生图输出普通文件总量上限，单位 MiB（默认 1 GiB）；0 不限 |

上述变量均接受非负整数；总量换算为字节后必须是安全整数。清理先删除 mtime 早于保留期截止时间的普通文件，再跨线程按 mtime 从旧到新删除，直到总量不超限；两个限制都为 0 时不清理。内置生图输出位于 `$CODEX_HOME/generated_images/<thread_id>/exec-*.png`（默认对应 `./data/codex/generated_images/`），清理不跟随链接，删除前以 realpath 核验根目录边界，最后仅移除空子目录并保留根目录。

`send_message` 发送图片前会把图片复制到票据图片目录，清理原图不影响已登记的副本；原图主要用于模型后续回看或再次发送。清理沿用观测库每日任务，在 trace 清理之后执行：启动不会立即执行，正常情况下首次在 `Metrics.start()` 后约 60 秒触发，此后间隔至少 24 小时；观测库降级时不执行。成功删除文件时记录 `codex generated images purged`（removed、bytes、dirs），失败只记录 `codex generated images purge failed` 告警。

## 3. 启动

首次使用先完成上节配置播种与扫码；下列命令会同时管理 cs-agent 和 NapCat。

```powershell
docker compose up -d --build
docker compose logs -f            # 一行一个 JSON 的结构化日志（不含 token）
docker compose ps                 # HEALTH 列
docker compose exec cs-agent node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)"
```

Compose 将容器 HTTP 监听设为 0.0.0.0:8787，宿主机仅发布 127.0.0.1:8787；本地直接运行仍默认监听 127.0.0.1。`/healthz` 的 JSON 和状态码不变，返回：
- `ws_connected`：NapCat WS 是否在线（离线时 HTTP 503，容器显示 unhealthy）
- `comfy`：启动时 comfy 的自检结果（mcp：`server_info`；http：`/system_stats`）
- `codex`：magpie 模式检查 key 已配置（不探测网关），openai 直连检查 `auth.json` 是否存在；同时报告当前固定会话 id
- `pi.threads`：`{count, keys: [...]}`，仅显示启用的会话数量和键，不返回 id 或聊天内容

> comfy-cli 1.22 在 local 模式下拒绝从非 loopback 主机获取 `/object_info`（SSRF 防护），所以 mcp 模式下 agent 会在容器内的 `127.0.0.1:${COMFY_LOOPBACK_PORT:-8188}` 启动一个 TCP 转发，指向 `COMFYUI_URL`，再把 comfy-mcp 指向这个 loopback 地址。日志中出现 `comfy loopback proxy listening` 即表示转发已启动。

## 4. 数据卷

| 路径 | 内容 |
|---|---|
| `./data/pi.sqlite` / `./data/pi-threads.json` | pi 长期会话按 `owner`（owner 私聊）或 `group:<id>` / `private:<id>` 隔离；JSON 是 SQLite 映射的原子写出镜像。旧 owner 保留，旧 shared 停用且仅记录一次日志，绝不复用混合历史。同键串行、不同键并行，受 AGENT_CONCURRENCY 限制 |
| `./data/agent.sqlite` | pi-durable 会话、任务和派发索引（崩溃后自动续跑） |
| `./data/codex/` | `CODEX_HOME`：`auth.json`（codex 仅直连时需要）、`config.toml`、sessions。**`config.toml` 是受管文件**：入口脚本每次启动都按 `CODEX_PROVIDER` / `CODEX_MAGPIE_URL` / `CODEX_MODEL` / `CODEX_REASONING_EFFORT` / `CODEX_WEB_SEARCH` / `CODEX_WEB_SEARCH_CONTEXT` / `CODEX_BROWSER` / `CODEX_MCP_APPROVAL_MODE` / `QQ_CONTEXT_MAX_CHARS` / `CODEX_REMOTE_PLUGINS` 重写（含 `web_search`、可选 `[features] plugins = false` 与 `remote_plugin = false`、`[mcp_servers.qq_context]`、可选 `[mcp_servers.browser]`），写完后按 `CODEX_PLUGIN_PRUNE` 清理远程插件缓存；手工修改会被覆盖；要改请改 `.env` 后重启 |
| `./data/qq-messages.sqlite`（+ `-wal` / `-shm`） | 统一上下文消息库：允许范围内的全部 QQ 消息（含不触发的群消息）、机器人回复行（动作、生图提示词、codex 推理强度、状态）、日/周摘要。**按聊天记录保管**。撤回的消息会删除原始行 |
| `./data/prompts/system.md` | **已弃用**：v2 意图模型的系统提示。v3 规则分流不经模型，不再读取它；文件保留不删，存在时启动日志记一行 `system.md is deprecated and no longer used` |
| `./data/codex-threads.json` | 两条固定 codex 线程：`{"owner": {thread_id, created_at, updated_at}, "shared": {…}}`。owner 私聊（`QQ_OWNER`）用 `owner`，所有群和其他私聊共用 `shared`；删掉某个键（或整个文件），对应线程下一条请求就新建。旧版的单线程 `codex-session.json` 在新文件不存在时自动迁移为 `owner`（日志 `codex thread migrated`），旧文件改名为 `codex-session.json.migrated` |
| `./data/incoming/<ticket>/` | 本票据参考图（≤3×10 MiB），票据 source_images 保存绝对路径供恢复；7 天清理，对 codex 命令沙箱禁读、不可写 |
| `./data/prompts/agent.md` | 启动时只播种缺失的模板，包含生图参数与提示词指引；pi 每次模型请求热加载，保留不跨会话转述私人内容的规则 |
| `./data/prompts/codex.md` | codex 自定义系统提示（`${DATA_DIR}/prompts/codex.md`）：首次启动创建默认回复规则、聊天记录工具纪律、联网与浏览器；已有文件不覆盖。已部署文件中的旧“生图提示词指引”需由运维手工删除。面板保存校验 revision、拒绝空白与超过 64 KB 的内容；当前文件或提交内容命中已注册秘密／凭据样式时拒绝保存。保存后立即原子重写全局 AGENTS.md，下一次 codex 调用生效，无需重启容器 |
| `./data/images/<ticket>/` | 生成的图片。pi / image_gen 每次生图写独立 `call-<n>/`；pending-jobs.json 在提交前记录意图、提交后记录 prompt_id，image-files.json 逐张记录下载状态。重启只收取/对账，不重提；坏 marker 隔离为 .bad-<时间戳>，回复保留正文并提示附件失败。未确认远端完成时保留参考图清理清单 |
| `./data/files/<ticket>/` | 文件附件副本与 `manifest.json`（原路径、名字、大小、sha256、来源）；QQ 上传使用 base64，无需与 NapCat 共享卷。票据清理时删除，命令沙箱禁读、不可写 |
| `./data/tickets/<ticket>/` | 票据工作目录：codex 回合的最后一条消息 `codex-last.txt`（崩溃恢复时据此不重复询问 codex）。reply 与派发终态对账均幂等清理；发送后、清理前崩溃会在恢复时补删，图片目录不动。入口脚本启动时创建。对 codex 命令沙箱禁读、不可设为可写目录 |
| `./data/*`（QQBridge） | 票据与去重 SQLite |
| `./data/codex/AGENTS.md` | codex 全局行为指引的**生成文件**：通用保密与会话隔离说明 + 两个换行 + 用户可编辑的 `prompts/codex.md`，保留标记 `<!-- cs-agent-agents-template v5 -->`。main 启动、store 保存和每轮 preparePrompt 时生成；编辑行为指引请通过面板或磁盘修改 `codex.md`，不要手改生成文件。具体安全规则、实际可写目录、聊天图片与发送图片/文件规则位于会话域 AGENTS.md |
| `./workspace/` | codex 各会话工作区的父目录。运维可维护 `AGENTS.override.md` 或 `AGENTS.md`，runner 将选中的非空指引拼入每个会话的受管文件；服务不再播种占位说明，也不再识别替换旧 V1/V2 模板 |
| `./workspace/<key>/AGENTS.md` | **受管规则文件**（key 中冒号换成下划线）。runner 每轮在 exec/resume 前生成，首行 `<!-- cs-agent-managed-workspace-agents v1 -->`，第二行“由 cs-agent 每轮生成，改动会被覆盖。”；包含按实际权限渲染的规则及可选的“运维工作区指引”。仅文件缺失或全文不同时原子写入，内容相同保留 mtime。模型改写后下一轮会恢复，不作为可编辑行为指引入口 |

面板保存 codex 自定义提示后，`CodexPromptStore` 立即重新生成 `$CODEX_HOME/AGENTS.md`，并通知订阅者记录变更。runner 每轮通过 `preparePrompt` 再生成全局指引，并更新会话域受管文件，然后启动独立的 `codex exec` 或 `codex exec resume` 进程；面板保存或直接在磁盘编辑 `codex.md` 都从下一轮生效，正在进行的回合保持其已加载内容，无需后台文件监听。全局与会话域 AGENTS.md 均以 user 角色进入上下文，内容变化时续轮重新注入；不再使用无法更新已有线程的 `developer_instructions`，保留 `project_doc_max_bytes=131072`，无需重置旧线程。自定义文件使用 UTF-8，保存保留原 BOM 和换行风格。实验结论见[设计稿 §8.12](DESIGN-codex-context.md#812-受管规则下发路径)。

Codex 每个模型的完整基础指令保存在 `DATA_DIR/prompts/codex-base/<安全 slug>.md`（例如 `codex__gpt-6.1-sol.md`），首次使用从 `CODEX_HOME/models_cache.json` 的 `model_messages.instructions_template` 原样播种，缓存缺失时查询 Magpie 目录；没有模板则沿用 Codex 默认行为。每轮将可编辑内容与固定 QQ 受管规则拼接到 `CODEX_HOME/base-instructions/<安全 slug>.md`，通过 `model_instructions_file` 应用于新线程、已有线程续聊和手动压缩。内容不变不重写生效文件。设置页或本地修改下一轮生效；Codex 升级不会覆盖已播种文件，需在设置页使用「恢复目录默认」取得当前目录模板。

### 聊天记录（统一上下文）

- **入库**：QQBridge 把允许群的全部消息、允许用户的私聊写入 `qq-messages.sqlite`；收到触发消息时写入一行 `[我] → 处理中`，回复后更新为 `生图 prompt=… → 已发送 N 张图` / `codex(high) → "摘要"` / `失败`。
- **衰老任务**：每天 `HISTORY_SUMMARY_HOUR`（默认 3）点运行，时间按**容器本地时区**——默认 UTC，即北京时间 11 点；想按北京时间 3 点运行，在 `docker-compose.yml` 的 `environment` 加 `TZ: Asia/Shanghai`（同时影响聊天记录里显示的 HH:MM）。任务内容：前一天（及更早未处理的日子）≥5 条消息的会话用意图模型生成 ≤400 字日摘要；已结束的自然周（周一起）的日摘要合并为周摘要；原始消息超过 `HISTORY_RAW_DAYS`（30）且所在日已被日/周摘要覆盖时删除——摘要失败的日子保留原始消息、下次重试，未被覆盖的（摘要一直失败或当天不足 5 条）最多保留 `HISTORY_RAW_HARD_MAX_DAYS`（90）天；摘要超过 `HISTORY_SUMMARY_DAYS`（180）删除。上次运行早于 24 小时时，启动后立即补跑。日志：`history aging done`（含 day_summaries / week_summaries / failed / purged_*）。模型失败只计数跳过，下次再试，不影响主流程。
- **按需图片召回**：消息默认只存 `[image]`，不保存 URL、不下载到媒体库。两个后端的 `qq_image(message_id)` 只返回路径文本；查看图片使用文件工具。成功召回后正文变为 `[image:<路径>]`，媒体文件随原始消息保留，撤回/清理删除关联，每日 GC 回收超过一天且无引用的文件。
- **召回配置**：`MEDIA_RECALL_PORT=8790`，主进程仅监听 `127.0.0.1`，无需发布容器端口；`MEDIA_RECALL_MAX_PER_TICKET=5`，正整数。Codex 每个会话线程一个随机令牌（经 thread/start、thread/resume 的 config 写入该线程的 MCP 环境，app-server 重启或线程重新加载即作废重发），每次调用由主进程按 `_meta` 确认属于会话当前回合后才按本轮身份求出范围，额度按回合计；MCP 仅持只读库连接，不持 NapCat 凭据。pi 直接调用同一召回服务，预算保存在本轮请求文档。
- **codex 检索**：codex 通过 stdio MCP `qq_context`（`node /app/dist/mcp/qq-context.js`，只读连接）调用 `qq_recent` / `qq_search` / `qq_message`。访问范围由 cs-agent 每轮以 `-c mcp_servers.qq_context.env.QQ_ACCESS=…` 注入：群聊只见本群，owner（`QQ_OWNER`，默认 `QQ_ALLOW_USERS` 第一项）私聊可见全部，其他私聊只见本人。返回文本单条正文通常 ≤120 字，完整媒体路径可附在省略号后，超额整行省略；总量 ≤`QQ_CONTEXT_MAX_CHARS`（2500）。
- **查看消息库**（容器内有 node，无需 sqlite3）：

```powershell
docker compose exec cs-agent node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/qq-messages.sqlite',{readOnly:true});console.table(d.prepare('select scope,message_id,datetime(time,\'unixepoch\') t,nickname,substr(text,1,40) text,action,status from messages order by time desc limit 20').all());console.table(d.prepare('select scope,level,date(period_start,\'unixepoch\') start,msg_count,substr(text,1,60) text from summaries order by period_end desc limit 10').all())"
# 以 codex 的视角试跑 MCP 工具（列出工具；QQ_ACCESS 换成要模拟的范围）
docker compose exec -e QQ_ACCESS=group:200000001 cs-agent sh -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"cli\",\"version\":\"1\"}}}" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"qq_recent\",\"arguments\":{\"limit\":10}}}" | node /app/dist/mcp/qq-context.js'
```

- **清空**：停容器后删除 `./data/qq-messages.sqlite*`，启动时会重建空库。

### codex 联网与浏览器

远程插件对 QQ 客服场景无用，默认关闭并清理 figma/gmail；其余已缓存插件会继续被加载，想全部清掉设 `CODEX_PLUGIN_PRUNE=all`。

- 受管配置始终写入 `[features] apps = false`：不加载登录账号的 ChatGPT Apps 连接器（Notion、GitHub、Drive、Gmail 等）。否则每轮附带约 14 万 token 的工具定义，且群聊回合也能调用主人账号的连接器。
- `CODEX_REMOTE_PLUGINS=off|on`，默认 `off`：受管配置写入 `[features]` 下的 `plugins = false` 与 `remote_plugin = false`（前者才是关键：codex 0.163 启动时会同步插件市场并重装缺失的精选插件，与技能扫描竞态导致线程启动失败；`.system` 内置技能仍可用）；设为 `on` 时省略该段，保持 codex 默认行为。非法值经 `toml_enum` 告警并回退 `off`。
- `CODEX_PLUGIN_PRUNE` 默认 `figma,gmail`：每次启动写完配置后删除 `$CODEX_HOME/plugins/cache/openai-curated-remote/<name>`；精确值 `all` 删除整个市场缓存目录，显式空字符串不清插件缓存。名单按逗号分隔，非空名称只允许 `[A-Za-z0-9._-]` 且不能是 `.` 或 `..`；非法项告警跳过，其余项继续处理，不展开通配符。无论是否清理插件缓存，都会删除 `$CODEX_HOME/plugins/.remote-plugin-install-staging`；目录不存在不报错。此清理开关独立于 `CODEX_REMOTE_PLUGINS`。

- `web_search = "live"`（`CODEX_WEB_SEARCH=live|cached|disabled`），`[tools.web_search] context_size = "low"`（`CODEX_WEB_SEARCH_CONTEXT`）限制搜索结果注入量。
- `CODEX_BROWSER=playwright`（默认）时注册 `[mcp_servers.browser]`：镜像内全局安装的 `@playwright/mcp`（`/usr/local/bin/playwright-mcp --headless --isolated --browser chromium --blocked-origins "<阻止列表>" --sandbox`），Chromium 位于 `/opt/pw-browsers`（`PLAYWRIGHT_BROWSERS_PATH`）。每次会话临时 profile，无任何宿主机登录态。阻止列表覆盖 `localhost`、`*.localhost`、`host.docker.internal`、`*.docker.internal`、`*.internal`、`127.*`、`10.*`、`172.16–31.*`、`192.168.*`、`169.254.*`、`0.0.0.0`、`[::1]`、`[::]`、`[fc*`/`[fd*`/`[fe80*`/`[::ffff*`（含任意端口）。Chromium 沙箱：Playwright 默认以 `--no-sandbox` 启动 Chromium，入口脚本显式加 `--sandbox` 开启。实测（node 用户）在 compose 的自定义 seccomp profile `docker/seccomp-codex.json`（以及 unconfined）下可以启动；默认 seccomp 下报 `Chromium sandboxing failed`，这时设 `PLAYWRIGHT_NO_SANDBOX=1` 退回无沙箱。设为 `none` 不注册浏览器。
- **MCP 工具审批**：`[mcp_servers.qq_context]` 与 `[mcp_servers.browser]` 都写了 `default_tools_approval_mode = "approve"`（`CODEX_MCP_APPROVAL_MODE=auto|prompt|writes|approve`，默认 `approve`）。cs-agent 以非交互的 `codex exec` 运行（approval policy `never`），需要审批的 MCP 调用会直接失败（`MCP tool call requires approval, but approval policy is never`）。`auto` 按工具 annotations 决定是否审批，2026-10-18 在 codex 0.163 实测 `auto` 下 qq_context 工具调用仍被要求审批而失败，`approve` 则成功，所以默认 `approve`；qq_context 工具现已声明 `readOnlyHint: true`，`auto` 之后可能可用，但不作为默认。浏览器可用的工具仍只限 `enabled_tools` 白名单。
- **浏览器工具白名单与 `file:`**：`playwright-mcp` 进程以 node 运行、不受 codex 命令沙箱约束，所以受管 `config.toml` 给 `[mcp_servers.browser]` 写了 `enabled_tools` 白名单（导航、快照、截图、点击/输入/选择/拖拽、`browser_evaluate`、标签页、对话框、控制台与网络记录等 22 个）。未列出的工具 codex 既不暴露给模型也拒绝调用，新版本新增的工具默认关闭。被排除的：`browser_run_code_unsafe`——在 playwright-mcp 进程里执行任意 JS，实测可以用 `page.constructor.constructor('return process')()` 拿到 Node 的 `fs` 直接读出 `/data/codex/auth.json`，也能 `page.goto('file://…')` 绕过 `file:` 拦截；`browser_file_upload`、`browser_drop`（把本地文件交给网页）。`file:` 协议本身：playwright-mcp 0.0.83 对 `browser_navigate` / `browser_tabs` 的 URL 自带拦截（`Access to "file:" protocol is blocked`），页面 JS 的 `location` 跳转与 `fetch` 由 Chromium 拒绝。`--blocked-origins` 表达不了 `file:`（file URL 的 origin 是 `"null"`，模式会退化成 `*://file:///…/**`）；Chromium 托管策略 `URLBlocklist` 在 Playwright 的 headless shell 里实测不生效，所以没有采用。
- **实测**（`cs-agent:g1fix`，经 `codex app-server` 的 `mcpServerStatus/list` 与 `mcpServer/tool/call` 调用，不发起模型请求）：白名单前 25 个工具，`browser_run_code_unsafe` 读出了假的 auth.json；白名单后只暴露 22 个，调用它返回 `tool 'browser_run_code_unsafe' is disabled for MCP server 'browser'`；`browser_navigate file:///etc/hostname`、`file:///data/codex/config.toml` 均为 `Access to "file:" protocol is blocked`；`data:text/html,<h1>x</h1>` 正常加载；页面内 `location.href='file:…'` 不跳转，`fetch('file:…')` 报 `Failed to fetch`。
- codex 线程：`owner` 与 `shared` 各一条互斥队列——owner 的请求与群聊请求可以同时运行，同一线程内一次一轮。日志 `codex thread created` / `rotated` / `missing` / `resume failed` 都带 `key`；healthz 的 `codex.threads` 显示两条线程的 id（每次请求现读）。
- 每条线程各自的安全阀：resume 前若 `${CODEX_HOME}/sessions/**/rollout-*-<thread_id>.jsonl` 超过 `CODEX_ROLLOUT_MAX_MB`（50）或线程超过 `CODEX_THREAD_MAX_DAYS`（90）天，新建线程，日志 `codex thread rotated`（历史靠 `qq_context` 找回）。

**卷权限**：容器以 `node` 用户（uid 1000）运行，`./data` 和 `./workspace` 必须对它可写。入口脚本和 agent 启动时都会写入并删除一个探针文件来检查；不可写时日志会给出目录名和当前 uid，容器以退出码 1 退出。Docker Desktop（Windows）的绑定挂载一般没有这个问题；Linux 宿主机上可以执行 `sudo chown -R 1000:1000 data workspace`。

### 残余风险

- codex 执行的命令读不到 `auth.json`、会话、SQLite 库和图片（deny_read，见「7. codex 权限」），但 codex 进程本身（不受沙箱约束）持有这份 ChatGPT 凭据；不在 deny_read 中的 `/data` 文件（`config.toml`、`prompts/`、`workflows/`）命令仍可读取，其中 `/data/workflows` 不在默认可写根中，受管 AGENTS.md 也不再介绍它。MCP 服务进程（`qq_context`、浏览器）同样不受命令沙箱约束：浏览器的 `file:` 访问与任意代码执行工具已用工具白名单和 playwright-mcp 自带拦截封住（见上），但这依赖 playwright-mcp 与 Chromium 的实现，升级 `@playwright/mcp` 或 `@openai/codex` 后需要重新实测：`scripts/verify-browser-mcp.mjs` 在镜像内经 `codex app-server` 调用浏览器工具并检查（不调用模型；用法见脚本开头，务必挂假的 `/data`），全部通过时退出码为 0。`AGENTS.md` 只约束模型行为，不是访问控制。**只把能信任使用这个工作区的人加入 `QQ_ALLOW_USERS` / `QQ_ALLOW_GROUPS`**。
- **浏览器 MCP 的网络访问**：`playwright-mcp` 进程由 codex 作为 MCP 服务启动，**不受 codex 命令沙箱约束**，可以访问容器能到达的任何网络。宿主机 ComfyUI（`host.docker.internal:8188`，无鉴权）、Compose 内网 NapCat（`napcat:3000/3001`，需要 token，也可指向宿主机）以及容器自身的 healthz 都在这个范围内。`--blocked-origins` 阻止列表覆盖宿主机地址和内网/链路本地 IP，但未列入 `napcat` 这个服务名；NapCat 仍靠 OneBot token 鉴权。@playwright/mcp 明确说明该列表**不是安全边界**：
  - 不拦截重定向：公网页面 302 到 `http://host.docker.internal:8188/…` 时不会被阻止；
  - 按 URL 主机名匹配，不看解析结果：解析到内网 IP 的公网域名（如 `127.0.0.1.nip.io` 之类、DNS rebinding）不会被阻止；
  - 只覆盖浏览器发出的请求，与 codex 自身的 web_search 无关。
  如需关闭浏览器访问，可设 `CODEX_BROWSER=none`；网络隔离需要按目标服务在宿主机或容器网络实施访问控制。
- **`/data/prompts` 可写**（用户接受的风险）：codex 的 owner 会话命令可以改写 `/data/prompts` 下的文件。v3 中 `system.md` 已不再被读取；pi 后端从这里热加载 `agent.md`，修改会在下一次模型请求生效。会话域受管 AGENTS.md 规定只在 owner 私聊明确要求时才修改；是否得到明确要求仍靠模型遵守，非 owner 会话的写入由沙箱禁止。若要连 owner 也禁止，需收紧 `codexWorkspacePolicy`；仅修改 `CODEX_WRITABLE_ROOTS` 不会改变业务回合的固定权限。
- **显式开启 image_gen 后可被群成员触发**：任何能让 codex 处理消息的发送者都可以间接让它生图（每回合最多 4 次，图片只写到本票据目录、只随本条回复发出）。
- **聊天记录**：群成员可以让 codex 检索本群 30 天内的原始消息和 180 天内的摘要（与能翻群记录一致）；owner 私聊可以检索全部会话。`./data/qq-messages.sqlite` 按聊天记录保管。

### 统一发送工具（im）

`send_message({ text, images: [path], files: [{ path, name? }] })` 立即发送文字和图片，再上传文件，name 缺省取原文件名。来源只能是本轮工作区普通文件或当前 QQ_ACCESS 范围已召回媒体，拒绝软链接；文件名取 basename、去控制字符、最多 120 字符。图片魔数、单张 10 MiB、合计 20 MiB、每条消息 4 张限制沿用回复通道。不限每回合条数；所有出站消息受 bridge 发送规则约束（默认每会话每分钟 6 条、每小时 60 条触发会话熔断 60 分钟、全局每分钟 30 条触发全局熔断 10 分钟），在面板设置页"发送规则"调整或解除熔断。当前票据的生成图片与绑定的 Codex 线程 generated_images 目录也可作为来源。

文件在文字（含图片）确认发送后逐个上传到原会话，群聊放根目录。每次上传前持久化 Outbox 的文件状态 `sending`，成功保存 `sent` 和 `file_id`，异常保存 `uncertain`；恢复只发送 `pending`，遗留 `sending` 转 `uncertain`。文字已发出但附件未结束时保留派发索引；观测 `send_message` 的 files 字段记录名字、大小和状态；票据结束时删除 Outbox 副本，仍有 pending/sending 文件的消息目录保留，避免破坏恢复。上传超时至少 30 秒，每 MiB 加 2 秒，最高 120 秒。

runner 每轮通过 Codex 子进程环境传入 `IM_TOKEN` 与 `QQ_RECALL_TOKEN`，受管 im / qq_context 配置各自用 env_vars 转发；令牌不进入 argv，端口仍通过非敏感配置注入。令牌在主进程绑定票据、来源与工作区，结束即撤销；模型不能选目标。发送网关通过 media/attach.ts 校验普通文件、软链接、realpath 与来源权限。旧附件目录参数仍由 runner 注入，但 qq_context 不再读取它们或提供发送工具。

### 生图 MCP（image_gen）

默认 `CODEX_IMAGE_GEN=off`，不写入两个 image_gen 配置段，也不注入 IMAGE_TICKET_DIR、IMAGE_REFS 或其 QQ_ACCESS。以下仅在 `CODEX_IMAGE_GEN=on` 时适用。受管 AGENTS.md 和新播种的 codex 提示词不再包含生图说明。

- 生图提交前写入票据目录的 `pending-jobs.json`；慢任务在 MCP 等待上限后返回“图片仍在生成……无需重试”。agent 在 `handle → lateImages → settle` 中按原 prompt_id 收取到原 `call-<n>/`，结果通过 #late 消息发送（最多 4 张）；这期间同 scope 的后续消息继续排队。最终失败追加“有一张图生成超时未能发送”。
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

`test/napcat-config.test.ts` 优先探测 `pwsh`，不可执行时尝试 `powershell`；均不可用则跳过并在用例名说明。播种只在临时目录执行，不触碰仓库 `.env` 或创建仓库 `napcat/`。检测到可用 Docker Compose 时另跑 `docker compose -f docker-compose.yml config --quiet`；命令不可用则跳过，不拉取镜像、不启动服务。

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
writable_roots = ["/workspace", "/data/prompts"] # CODEX_WRITABLE_ROOTS
```

- **前提**：bwrap 需要非特权用户命名空间。Docker 默认的 seccomp 配置阻止 `CLONE_NEWUSER`，所以在 `docker-compose.yml` 加 `security_opt: [seccomp=./docker/seccomp-codex.json]`（Docker 默认 profile + 仅放开命名空间/挂载相关系统调用）之前，codex 在容器里**任何命令都无法执行**。
- **身份**：容器进程与 codex 命令都以 `node`（uid 1000）运行。
- **写入**：入口脚本的默认可写根为 `/workspace`、`/data/prompts`。业务回合通过命名权限 `filesystem` 与 `writable_roots` 同步收窄：owner 仅 `/workspace/owner`、`/data/prompts`（提示词目录；`system.md` 已弃用），非 owner 仅本会话目录，read-only 没有可写根。`/data/workflows` 不在默认可写列表；`CODEX_WRITABLE_ROOTS` 的显式配置也不会扩大业务回合的固定权限。`/data` 本身、`/data/codex`（auth.json、sessions）、`/data/*.sqlite`、`/data/images`、`/data/tickets` 都不可写；入口脚本先规范化每一项（合并重复的 `/`，去掉 `/./`、末尾的 `/.` 与 `/`），再与规范化后的 `DATA_DIR` / `CODEX_HOME` 比较，拒绝 `/`、`/data` 本身及其上级目录、`/data/codex` 及其子目录、`/data/images`、`/data/tickets` 及其子目录、`*.sqlite`、任何含 `..` 或非法字符的项，并打印 `rejected CODEX_WRITABLE_ROOTS entry`（例如 `/data//`、`/data/.`、`/data/codex/.`、`/data/images//x` 都会被拒绝）。
- **工作流**：`/data/workflows/` 不存在时，启动会从镜像的 `/app/workflows/` 复制一份（已存在则绝不覆盖）。历史自定义工作流默认位置 `COMFY_WORKFLOW_FILE=/data/workflows/qwen-image-2.1-turbo-api.json` 保留可用；当前配置默认留空，使用 Qwen 参数化生成器。旧值 `/app/workflows/…` 仍然有效。目录播种与 ComfyUI 本地生图不变，codex 默认不可写 `/data/workflows`，受管 AGENTS.md 不再介绍其用途；显式将该路径传入渲染器时仅显示“运维开放的可写目录”。
- **网络**：命令可以联网（`network_access = true`），因此能直接访问宿主机的 ComfyUI `host.docker.internal:8188`（无鉴权，可以提交任务、读取输出）。NapCat（3000/3001）需要 Bearer token，codex 拿不到。
- **规则文件**：codex 从 `$CODEX_HOME/AGENTS.md` 读取全局行为指引，再加载 cwd 的 `/workspace/<key>/AGENTS.md` 受管规则，二者均为 user 角色。父工作区的运维指引由 runner 显式拼入会话域文件。受管规则里的“只读写下列目录”按 `codexWorkspacePolicy` 的实际权限渲染：非 owner 仅本会话目录，owner 额外只包含 `/data/prompts`，read-only 不宣称任何目录可写。每轮文件缺失或内容变化才原子重写；不变不触碰 mtime，模型修改会在下一轮覆盖恢复。
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
- **实测**（`cs-agent:g1`，`codex sandbox -c sandbox_mode="workspace-write"`，seccomp=docker/seccomp-codex.json；unconfined 结果相同）：uid 1000；`/workspace`、`/data/prompts`、`/data/workflows`、`/tmp` 可写；`/data`、`/data/codex`、`/data/images`、`/data/qq-messages.sqlite` 写入被拒；`host.docker.internal:8188/system_stats` 返回 200，NapCat `:3000` 无 token 返回 403，公网 200；`CODEX_SANDBOX_NETWORK=false` 时三者都失败（EPERM / EAI_AGAIN）；沙箱内环境变量中没有 token / API key。默认 seccomp 下 bwrap 报 `No permissions to create a new namespace`。（2026-10-19 起 /data/workflows 不在默认可写列表）
- **实测 deny_read**（`cs-agent:g1fix`，`--security-opt seccomp=./docker/seccomp-codex.json --user node -w /workspace`，假数据卷）：`codex sandbox -c sandbox_mode="workspace-write" -- cat <路径>` 对 `/data/codex/auth.json`、`sessions/**`、`/data/codex/state_5.sqlite(-wal)`、`/data/agent.sqlite`、`qq-bridge.sqlite`、`qq-messages.sqlite(-wal)`、`observability.sqlite`、`/data/images/**`、`/data/codex-session.json` 均为 `Permission denied`；`cp` 到工作区、软链接后读取同样被拒，硬链接到 `/data/workflows` 报 `Invalid cross-device link`；`python3 open()` 报 `PermissionError`；`read-only` 模式同样被拒；`/data/codex/config.toml` 可读；`/workspace`、`/data/workflows`、`/data/prompts` 可写，`/data/codex`、`/etc/codex` 只读。（2026-10-19 起 /data/workflows 不在默认可写列表）
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
| `PI_COMPACTION_RESERVE_TOKENS` | 16384 | 上下文超过模型窗口减此值时阻塞压缩 |
| `PI_COMPACTION_BACKGROUND_TOKENS` | 32768 | 距阻塞阈值此 token 数时开始后台压缩；0 关闭后台压缩 |
| `AGENT_MODEL_PROVIDER/AGENT_MODEL_ID` | deepseek / deepseek-flash | pi 模型；`AGENT_THINKING_LEVEL=low` 由现有模型能力解析器收敛 |

长期会话和工具检查点存 `DATA_DIR/pi.sqlite`（及 WAL/SHM），与票据任务的 `agent.sqlite` 分开。`pi-threads.json` 原子保存 `{owner, shared}`；SQLite 的会话创建事务同时保存映射，JSON 丢失或写回前崩溃时启动重建，勿单独删除 JSON 当作清空记忆。备份应包含数据库、相关 WAL 和映射。每个线程独立串行，owner 与 shared 可并行；恢复中的请求先占据线程锁，后来的请求不能覆盖其 access。压缩保留最近 20000 tokens（pi-durable 默认），不按天或大小轮换；压缩缩小模型上下文，不删除数据库原文。

`DATA_DIR/prompts/agent.md` 缺失时写入代码内的默认中文提示词，已有文件绝不覆盖；每次模型请求按 mtime/size 热加载，改完无需重启。旧 `system.md` 仍弃用。默认全文位于 `src/agent/pi-tools/prompt.ts`，涵盖 QQ 纯文本、事实搜索、历史工具纪律及生图文字/编辑指引。

pi 还读取两层项目指引：运维层 `WORKSPACE_DIR/AGENTS.md`（默认 `/workspace/AGENTS.md`），以及会话层 `DATA_DIR/pi-work/<key>/AGENTS.md`（默认 `/data/pi-work/<key>/AGENTS.md`，例如 `group_200000001`；冒号换成下划线）。提示词顺序为 `agent.md` → 运维指引 → 会话指引，全部进入 system 消息；codex 侧 AGENTS.md 以 user 角色注入。pi 会话指引位于 `pi-work/<key>`，该目录中的文件可由本会话 write/edit 工具修改。

两层目录均按 `AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD` 选择第一个普通文件。请使用不超过 128 KiB 的 UTF-8 普通文件；支持 BOM，空白文件不注入。链接、超限或不可读文件会被跳过并记录去重告警。每次模型请求检查 mtime/size，更新后无需重启，内容未变不会重复写入 system 条目。不会向父目录搜索，也不会读取 `/data/AGENTS.md` 或 `/data/pi-work/AGENTS.md`；无 cwd 时只使用运维指引，非 pi-work 直接子目录的 cwd 会被忽略并告警。

DeepSeek Search/Fetch 使用 `DEEPSEEK_API_KEY`（兼容 `DEEPSEEK_APIKEY`），即使执行模型是其他 provider，联网工具仍需要此密钥。未配置时仅联网工具返回不可用。Search 最多 8 条、2500 字，Fetch 最多 4000 字；仅 429 退避一次，其余 HTTP 错误不重试。每回合 web_search/fetch_page 各最多 4 次、三种 qq 工具合计 4 次、generate_image 最多 2 次，上限通过 ToolTask hook 持久化计数，模型不能修改。

fetch_page 只接收无凭据的公开 HTTP(S) URL，复用入站下载的 IP 判定，解析全部 DNS 地址并拒绝任何内网地址。实际抓取发生在 DeepSeek 服务器，无法在本机固定其 DNS 结果或检查服务端重定向链；该部分依赖 DeepSeek 服务端策略，本次未执行真实 API 请求。

pi 通过进程内 send_message 调用与 im 共用的 SendService，来源绑定 PiRequestDoc 与 PiExecutionEnv，文件按 Outbox 状态发送。

图片写到 `DATA_DIR/images/<ticket>/call-<n>/`，工具成功返回路径后由模型用 send_message 显式发送；未完成的任务交给 lateImages 收取并以 #late 发送。参考图只能取本票据 incoming 清单。远端参考图清单在上传前保存，完成或失败时覆盖清理，清理失败保留供既有终态清理恢复。生图工具使用 pi-durable 的 unsafe 重放策略：崩溃中断的外部生图调用不自动重提，模型收到 interrupted；已保存图片仍可通过 send_message 发送。`requestId=ticket` 保证提交幂等，不等于外部生图服务的事务性 exactly-once。慢图受 pi 总回合期限限制；此次没有改动并行任务负责的 image_gen MCP 延迟收图逻辑。

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

DEEPSEEK_PRICE_IN_PER_M / DEEPSEEK_PRICE_OUT_PER_M 默认 0；填入 deepseek-flash 的每百万 token 单价后估算费用，两项使用相同币种。输入包括可获得的 cache read / write；该估算不区分缓存优惠，也不包含搜索/抓页费用。用量来自 pi-ai 返回的 usage（pi、衰老），两条路径使用同一 usage 字段转换和费用计算（含 cacheRead / cacheWrite），未提供的用量不会猜测。观测为尽力记录，崩溃边界可能重记响应，已写入的事件通过持久化游标恢复聚合，尚未写入的事件仍可能丢失；durable 业务检查点独立，不受观测写入失败影响。

ALERT_OWNER=false 默认不发送。显式启用且存在 QQ_OWNER（或 allowUsers 的首项）时，WS 连续离线超过五分钟、模型鉴权失败、连续三条票据失败会经 bridge.send 向 owner 私聊告警；所有原因共用每 30 分钟一次限频。告警只带固定原因，不带用户原文或服务端错误正文。此功能仅使用 fake bridge 验证。

健康含义：ComfyUI / Codex 是启动检查快照，不能证明当前网络或鉴权仍有效；DeepSeek 仅显示是否配置密钥。Pi 压缩统计表示 hook 观察到的尝试，不声明压缩成功；Codex 回合数仅覆盖观测保留期。现有 failed 派发索引必须保留以阻止 pending 票据在恢复时成为孤儿重跑，不随观测日志过期删除。


### 运行时设置的票据快照

设置页的 `codexModel` 下拉按目录 slug 原样展示和保存。启动目录可用时，持久化或环境配置中不在目录里的值会记录告警，并保留原值显示为「不在目录中」，不自动改写 `settings.json`。新回合快照回退到 `CODEX_MODEL`；若环境默认也不在目录中，则用内置默认 `codex/gpt-6.1-sol`。目录不可用时继续使用配置值。旧短名需要在 `.env` 或面板手动改为目录中的完整 slug。

面板修改后端或 Codex 推理强度后，仅新派发的消息采用新值。Dispatcher 在等待附件准备和 scope 队列之前读取一次设置，将 `{backend, codexReasoningEffort}` 与票据一起写入 `TicketDoc.settings`。执行、机器人历史行和崩溃恢复都使用此快照；例如进行中的 high 票据不会因面板改成 low 而改变。两个后端的回复均原文照发，不做 Markdown/`@` 转换（格式由提示词约束）；只保留发送保护：UTF-16 ≤4000 截断且不拆代理对、空文本占位；后处理不调用模型。

升级前没有快照的存量票据无法还原历史设置：恢复时一次性写入固定 high，后端优先采用已有结果中的 pi，否则 codex；后续重试沿用。没有 TicketDoc 的孤儿票据重新派发时才采样当前设置。

升级无需手动迁移：`.env` 残留的 `CODEX_REPLY_MODE` 被忽略；`settings.json` 读取时剥离 `codexReplyMode`，保留其它有效设置，下次保存移除旧键；旧票据的同名字段不参与执行。旧 postprocess/reply 检查点由 settle 接管，新回合最终回答不自动发送；升级时旧草稿/最终答案及最多 4 张图片通过 #fallback 保留，已发送的旧附件继续恢复。历史 operation=relay/postprocess 事件仍可展示，新回合使用 final_answer 与 send_message。


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

codex 每次进程启动仅查询一次 `codex debug models`（使用 runner 相同的 `CODEX_HOME` 与环境白名单，最多等待 15 s），按 `CODEX_MODEL` 精确匹配 `models[].slug`，窗口取 `context_window`。查询失败、缺模型或字段无效时回退 `CODEX_CONTEXT_WINDOW`（默认 400000），日志 `codex context window` 的 `source` 标明目录或回退来源；不调用模型。2026-10-18 实查 gpt-6.1-sol 为 500000。`usedTokens` 直接取 `input_tokens`，缓存已包含其中。

pi 使用 pi-ai 模型窗口与实际 harness 压缩设置。deepseek-flash 为 1000000；默认 reserveTokens=16384、backgroundTokens=32768，对应后台 950848、阻塞 983616（公式与来源见 ARCHITECTURE §10）。BACKGROUND=0 关闭后台压缩，两条位置数值重合；超过阻塞位置时下一次请求等待压缩。输入包括 cacheRead / cacheWrite，缓存命中单列 cacheRead；工具循环中的每次 assistant 模型回合各计一次，压缩摘要生成的计费用量不混入占用。`lastCompactionAt` 仅在观察到已提交的 `pi.compaction` 摘要条目时更新，取主进程观测时间（条目没有墙钟时间戳），不把压缩尝试或失败当成功。启动时从持久化历史回填回合数与压缩消息时间；无回合用量的记录标为 `estimate`。
