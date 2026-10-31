# cs-agent 迁移 Cloudflare Workers 设计

状态：P0–P3 全部上线（agent.spcdts.dev，2026-10-30）：面板 `/admin/`、定时任务、外部事件与 Gmail、Cron 维护、子 agent 子 DO、沙箱 coding 工具、技能目录、历史记录导入；模型直连 DeepSeek 与 OpenAI Codex 订阅（magpie 已移除）；当前源码已移除借用 Codex 订阅的联网搜索与生图工具，`web_search` 已补齐为 DeepSeek 原生搜索，保留 `web_page` 网页读取。本机 Docker 版 cs-agent 与 NapCat 容器已停。首稿日期：2026-10-28。设计基线：cs-agent `153718f`、pi-durable `1.3.0`。前提由主人定：**砍掉 codex 后端，只保留 Pi**；NapCat 留在本机；模型出站仍经 magpie，但 magpie 也上云（第 3.7 节）。

## 1. 结论

把"一个常驻进程加本地 sqlite"的形状换成"一个会话一个 Durable Object（DO）"。每个 QQ 会话键对应一个 **Thread DO**，里面跑 pi-durable 的 Harness，存储是这个 DO 自带的 SQLite（pi-durable 现成的 `openDurableObjectSqliteStorage`）。NapCat 以 OneBot 反向 WebSocket 客户端直连 Worker，由一个 **Bridge DO** 持有连接；不需要 Cloudflare Tunnel 承载消息面。消息库、记忆、授权等宿主自己的表跟着会话或命名空间拆进对应 DO，跨会话的只有一个 **Registry DO**。媒体进 R2，面板经 Cloudflare Access。

这样做的依据：

- 现有架构已经是"按会话键一条线程、线程内串行、线程间独立"（[ARCHITECTURE.md](ARCHITECTURE.md) §2.3），DO 的单线程 actor 模型与之一一对应，ThreadHost 的大部分调度逻辑原样保留。
- pi-durable 的存储是接口，Cloudflare 适配器已经在包里；codemode 有 `RemoteCodemodeSandbox`；图片处理有 `/images/cloudflare`。包为 Workers 提供了这三处适配，便携的存储核心不依赖 Node API；Harness 在 DO 里的实际表现由 P0 验证。
- DO 的 SQLite 支持 FTS5，消息库与记忆库的 trigram 全文索引可以照搬。
- DO 的 CPU 限额只计活跃计算，等模型、等工具的 I/O 不计；一次回合在一个请求里跑完是可行的。

代价在第 10 节：宿主自己的 14 个直接写 SQL 的模块要从同步改成异步，依赖本地文件系统的工具要换成 Sandbox 或砍掉，观测与面板要重做数据面。

## 2. 范围

| 保留 | 改造 | 砍掉 |
|---|---|---|
| Pi 后端、ThreadHost 调度规则、身份与权限模型、send_message 与发送规则、Inbox 状态机、记忆系统、定时任务、外部事件、PI-MCP、技能 | 存储层（同步→异步、按 DO 拆分）、NapCat 连接方式、模型出站、媒体存储、观测与面板数据面、coding 工具（→Sandbox）、子 agent（→子 DO） | codex 后端及 `src/agent/codex/`、`src/mcp/`（codex 的 stdio MCP 入口）、宿主机 magpie 与 `host.docker.internal`、Docker 部署、本地 sidecar 进程形态 |

## 3. 拓扑

```
QQ ─ NapCat(本机，反向 WS 客户端) ──wss──▶ Worker 入口 ──▶ Bridge DO（持有 NapCat 连接，可休眠）
                                                              │ 授权·@检测·去重·入库
                                                              ▼
                                           Thread DO <会话键>（Inbox + Harness + 消息库 + 本会话记忆）
                                              │ 子 agent          │ MCP / 模型 / web      │ send_message
                                              ▼                   ▼                       ▼
                                        Subagent DO           fetch 出站            Bridge DO → NapCat API
Registry DO（授权、审批、定时任务目录、OAuth 凭据、事件游标、技能目录）
magpie 容器（Cloudflare Containers，模型网关；状态经 R2 同步）
R2（媒体、附件、技能文件、magpie 状态）  Secrets Store（magpie gateway key、Google refresh token、NapCat token）
Cron Trigger（日/周摘要、夜间整理、保留清理）  Sandbox（coding 工具的工作区）
面板 Worker（Cloudflare Access 保护，读各 DO 的快照）
```

### 3.1 Worker 入口

无状态路由：

- `GET /onebot`：NapCat 反向 WS 握手，校验 `Authorization: Bearer <NAPCAT_TOKEN>`，转交 Bridge DO。
- `POST /events/<source>`、`POST /gmail/pubsub`：外部事件与 Gmail Pub/Sub push，校验后投 Registry DO 的事件服务。
- `GET /mcp/oauth/callback`：PI-MCP 的 OAuth 回调（CIMD 的 redirect 从 `127.0.0.1:8787` 改成 Worker 域名，CIMD 文档本身仍在 Jule）。
- `/dashboard/*`：面板，Cloudflare Access。
- `/healthz`。

### 3.2 Bridge DO（单例）

- 用 WebSocket Hibernation API 接受 NapCat 的反向连接。空闲时休眠不计费，收到帧时唤醒。OneBot v11 的反向 WS 既推事件也接受 API 调用，所以发消息、查历史、下载图片都走这一条连接，NapCat 的 HTTP 端口不需要暴露。
- 职责与现在的 QQBridge 一致：授权判定（`QQ_ALLOW_*`、owner）、触发检测（私聊 / 群里真实 @）、去重、把允许范围内的每条消息经 `raw` 事件写入所属 Thread DO 的消息库、把触发消息作为 Inbox 输入投给 Thread DO。
- API 调用用 `echo` 关联请求与响应，等待中的调用放在 DO 存储里而不是内存里，休眠后唤醒仍能对上。发送审计（现在的 `outbox` 表）也在这里。
- 发送规则（[ARCHITECTURE.md](ARCHITECTURE.md) §3.3 的限速、链接、@ 规则）留在 Bridge DO，Thread DO 的 send_message 经 RPC 调它，鉴权信息随调用传入。
- NapCat 断线：hibernation 的 `webSocketClose` 记一条事件；Bridge DO 没有连接时 send_message 返回 `channel_down`，Thread DO 把待发消息留在 Outbox，连接恢复后重放，和现在重启后的处理相同。

Cloudflare Tunnel 在这个方案里只用于一件事：主人从外面访问 NapCat WebUI 重新扫码。消息面不经过它。

### 3.3 Thread DO（每个会话键一个）

- 名字即会话键：`owner`、`group:<群号>`、`private:<QQ号>`。`idFromName` 保证同一会话永远落在同一个对象上。
- 启动时 `Harness.open(openDurableObjectSqliteStorage(ctx.storage, { prefix: "pi_" }))`，宿主表用同一个 `DurableObjectSqliteDatabase` 共享操作队列（pi-durable README 的"share the database with host tables"写法）。一个 DO 就是现在的 `pi.sqlite` 的一个会话加它的子 agent，再加 `qq-messages.sqlite`、`qq-bridge.sqlite` 的 `inbound` 中属于这个会话的行。
- 一条输入的处理是一次 RPC 请求：Bridge DO 调 `thread.submit(inbound)`，Thread DO 按现在的规则决定开轮、插话或排队，然后 `await` 到回合结束再返回。请求在飞行中，DO 不会被驱逐；CPU 限额按请求计，`limits.cpu_ms` 设到上限 5 分钟以防长回合里工具的 JSON 处理超时。等模型、等 MCP 的时间不计 CPU。
- 回合结束后 Harness 保持打开，DO 常驻在内存直到平台驱逐；驱逐后下一次请求重新 `open` 并 `resume()`，pi-durable 的未完成任务从检查点恢复，和现在重启后的行为一致。`contextRetentionMs` 保持默认，驱逐就是回收。
- 子 agent 不在同一个 DO 里跑：现在的 `subagent` 工具派出一个 Subagent DO（名字 `sub:<父会话键>:<uuid>`），父子各自有 Harness。子 agent 的汇报经 RPC 回到父 DO，作为后续输入提交，和现在 Reporter 投递的语义相同；父 DO 用 alarm 兜底超时。子 DO 结束后保留 N 天供面板查看，到期由父 DO 删除。
- 定时任务：`schedule` 工具写 Registry DO 的目录，Registry DO 用 alarm 到点把定时输入投给目标 Thread DO。每个 DO 只有一个 alarm，所以 Registry DO 维护最近到期时间并在触发后重设。
- 记忆：owner 命名空间的记忆与画像放在 `owner` Thread DO 里；群与其他私聊的命名空间放各自的 DO。跨命名空间读（owner 在私聊里读全部）经 RPC 向各 DO 查询，现在 `memoryAccess` 的权限判定不变。回合后抽取在同一个 DO 里排队，用 alarm 节流。
- 对话历史不随 DO 驱逐丢失，都在 DO 的 SQLite 里；10 GB 的单对象上限对一个会话够用，第 11 节有保留策略。

### 3.4 Registry DO（单例）

跨会话的状态：授权（`auth`）、群内 MCP 审批（`cs.mcp.approval`）、定时任务目录、PI-MCP 的服务配置摘要与 OAuth 凭据（现在的 `mcp-oauth.sqlite`）、事件服务（去重键、游标、预算、held 列表）、技能目录、面板口令。单点但轻：每次写都是小事务，读由各 Thread DO 以 RPC 发起并在本地缓存一个配置摘要，摘要不变不回源，和现在委派快照的做法一样。

**P1c 实现事实（2026-10-29）**：`RegistryDO`（绑定 `REGISTRY`，名字 `main`，迁移 v4）目前只放 PI-MCP 的 OAuth 状态：`mcp_oauth_tokens`（access/refresh token 用 AES-GCM 加密，密钥为 secret `OAUTH_STORE_KEY`，AAD 绑定服务、账号、版本与字段）、`mcp_oauth_logins`（一次性 nonce 的哈希、state、加密的 verifier）、`mcp_oauth_client`。服务配置不在 DO 里：`workers/mcp.json` 构建期打包、typebox 严格校验（只允许 `streamable-http`、`owner-private`、`replay: "unsafe"`）。CIMD 文档由 Worker 自己在 `/oauth/client-metadata.json` 提供，client_id 就是这个 URL，不做 DCR。登录没有面板：`POST /admin/mcp/oauth/login-link`（Bearer `ADMIN_TOKEN`）签发 10 分钟一次性链接 → `/mcp/oauth/start` 302 到授权页 → `/mcp/oauth/callback` 换 token，页面只回「已登录 <server>」或错误分类，不回显 code/token。MCP 工具只在 owner 命名空间的 Thread DO 装配、`callers: ["tools"]` 只给 codemode 脚本调用（inline QuickJS 沙箱，占本 DO 线程），每次调用再复核本回合发送者是 owner 私聊；目录快照存 Thread DO 的 `mcp_catalog`，审计写 `events`（`mcp_call`、`mcp_catalog`，只记元数据）。Notion 托管 MCP 已验证端到端。

**P2 实现事实（2026-10-29）**：定时与事件没有放进 Registry DO，而是各自一个 DO，免得共用一个 alarm：`ScheduleDO`（绑定 `SCHEDULE`，迁移 v5；`schedules` / `schedule_runs`，单一 alarm 取最小 `next_fire_at`，RRULE 用 `rrule` 2.8.1、时区 Asia/Shanghai）和 `EventsDO`（绑定 `EVENTS`，迁移 v6；去重、60 s 合并、安静时段、每小时预算、来源状态、Gmail 的 access token 缓存与 watch 状态、`gmail_send` 幂等回执）。`InboundInput.kind` 为 `message | schedule | event`；Thread DO 的接纳是 `enqueue + pump`，按回合档位（chat / event）在会话空闲时切换工具集，定时与事件输入都不插话、不进消息库、不参与记忆抽取。Gmail 推送走 `POST /gmail/pubsub`（Pub/Sub push，OIDC token 校验：iss、aud = `PUBLIC_ORIGIN/gmail/pubsub`、email = var `GMAIL_PUBSUB_SERVICE_ACCOUNT`），Cron `*/5 * * * *` 轮询兜底；Gmail API 在 Worker 内直接调用（secrets `GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN`），不再有 sidecar。维护走 Cron `30 19 * * *`（北京 03:30），逐线程 RPC `maintain`。运行时设置（群触发、允许群/用户、抽取命名空间）在 Registry DO 的 `settings` 表，面板保存后推送 Bridge 重载。

### 3.5 Sandbox（coding 工具）

现在 Pi 的 `read` / `write` / `edit` / `bash` 作用在 `DATA_DIR/pi-work/<key>`。Workers 没有文件系统，两条路：

- **A. Cloudflare Sandbox SDK**：每个会话一个沙箱容器，回合内按需启动，工作区挂在容器磁盘上，用 SDK 的文件与命令接口实现这四个工具。计费按活跃 CPU，空闲不计。工作区在容器重建后不保证保留，需要持久的产物放 R2。
- **B. 砍掉 coding 工具**：只保留 codemode（`RemoteCodemodeSandbox`）、MCP、web、im、memory、schedule。事件回合本来就是这一套。

建议 P1 走 B，P3 再接 A。主人在 QQ 里让 agent 写文件、跑脚本的场景有，但不是主路径；codemode 已经覆盖"多步调用工具"的需求。

**P3 实现事实（2026-10-30）**：子 agent 是独立的 `SubagentDO`（绑定 `SUBAGENT`，迁移 v8，名字 `sub:<父线程键>:<id>`），父线程用 `subagent` 工具派出/追加/取消，子 DO 回答落库后经 `THREAD.subagentReport` 投回 `kind = "subagent"` 的输入唤醒主 agent，心跳 alarm 补送，父 alarm 兜底超时，结束 14 天删除；子会话基础检索工具为 `web_search`、`web_page`、`qq_context`、`mem_search`。coding 工具走 A 路线但不用 Sandbox SDK（1.x 的文件操作依赖 SDK 私有帧协议，且本账户只允许 `durable_object` 调度）：`SandboxDO`（绑定 `SANDBOX`，迁移 v9）按需启动自建镜像 `workers/sandbox/`（debian-slim + node/python/git，`server.mjs` 控制服务，命令降权到 uid 1000，realpath 校验），`read / write / edit / bash` 只在 owner 私聊的 message 回合注册，空闲 10 分钟退出、工作区不保证保留。技能存在 Registry `skills` 表，提示里只列目录，`read_skill` 读正文，写入只经面板；历史聊天与摘要经 `POST /admin/messages/import` 导入各线程。模型侧：2026-10-30 已移除借用 Codex 订阅的搜索与生图，`web_search` 改接 DeepSeek 原生搜索，`generate_image` 不恢复，Codex 仍可作为会话模型；`send_message` 发出前清理 Markdown 链接与 `utm_*`。

### 3.6 Gmail 与其他侧车

Gmail sidecar 变成同一个 Worker 的一组路由加 Registry DO 里的凭据：refresh token 放 Secrets Store，access token 缓存在 Registry DO 并单飞刷新，三个 MCP 工具改为 Worker 内部直接调用（不再经 Streamable HTTP 自己连自己），`gmail_send` 的幂等回执存 Registry DO。Gmail 推送改为 Pub/Sub push 订阅到 `/gmail/pubsub`，Worker 本来就有公网 HTTPS，不再需要轮询和 pull 订阅。

ComfyUI 留在本机，不接。

### 3.7 模型出站

**当前实现（2026-10-31）**：magpie 已移除。DeepSeek 使用 API key；ChatGPT 订阅迁到官方 Sign in with ChatGPT 自托管流程，管理页生成短期配对码，本机助手完成 loopback 授权并通过 HTTPS 导入云端，推理直连 `api.openai.com/v1/responses`（SSE、`store=false`）。按账号保存独立注册、加密凭据与模型目录，Registry 租锁续期；保留 `openai-codex` 历史 provider id，各会话下一回合采用面板设置。旧凭据需要重新授权，详见 [Workers 操作说明](../workers/README.md#模型与-chatgpt-登录)。以下为移除前的设计，保留作历史。

模型仍经 magpie 网关：它统一各家 provider、持有订阅类的 OAuth 登录、按 gateway key 归集用量。magpie 支持服务端部署：官方镜像 `ghcr.io/yetone/magpie`，`magpie web --gateway` 无桌面运行，状态在 `/config`，`MAGPIE_WEB_KEY` 保护 Web UI，`magpie s3` 可把 providers、key、设置经 S3 兼容存储（含 R2）加密同步。

**部署在 Cloudflare Containers**（P0 已实现，`workers/magpie/` 与 `workers/src/magpie-container.ts`）：

- 本账户只允许 `durable_object` 调度策略：容器由 `MagpieContainer` 这个普通 DO 用 `ctx.container.start()` 按需拉起，镜像在 `wrangler.jsonc` 的 `images.magpie` 里命名，实例规格与环境变量在 `start()` 里给，空闲 30 分钟后退出。`@cloudflare/containers` 的 `Container` 类不支持这种策略，没有用。
- 镜像 = 官方镜像 `ghcr.io/yetone/magpie`（Debian 底、静态链接的 `/magpie`、自带 dash/curl/perl）加一个入口脚本：先起 `magpie serve`，再起 perl 回环中继 `0.0.0.0:3426 → 127.0.0.1:3425`，最后在后台 `magpie s3 on ...`（secret 与 passphrase 走 stdin）并 `s3 auto 3`。顺序不能反：同步由网关进程执行，没有网关时 `s3 on` 一直等；`s3 restore` 要交互确认、`s3 now` 会等锁，都不能放在入口脚本里。
- **网关 key 不随 R2 同步**（同步的是 providers、provider key、设置、profiles、library），容器每次启动都是一份没有网关 key 的 magpie。Worker 进来的源地址是 10.0.0.1 不是回环，magpie 会拒绝。所以 Worker 只连中继端口 3426：中继把连接转到回环，magpie 按回环处理，任意 Bearer 都接受。容器端口只有绑定它的 DO 能到达，中继不再加鉴权。`MAGPIE_ALLOW_IPS`、`MAGPIE_GATEWAY_KEY` 两个环境变量都不能替代这一步（前者只是网络白名单，后者不是服务端设置）。
- 容器磁盘是临时的，`s3 on` 自己就同步一次并取回状态（本机验证：容器起来 15 秒内 providers 已恢复）。2026-10-30 起云端 magpie 是配置的唯一来源：它以 `magpie serve --web=0.0.0.0:3430` 同时提供 Web UI，Worker 把 `magpie.spcdts.dev`（var `MAGPIE_WEB_HOST`）整台主机代理到容器 3430，登录口令是 secret `MAGPIE_WEB_KEY`（`secrets/magpie-web-key.env`，由 put-secrets.sh 生成）；provider 与 key 在 Web UI 里改，容器自己每 3 分钟同步到 R2。主人电脑上的 magpie 已 `magpie s3 off`，不再参与。订阅类 OAuth 账号不在 `s3` 同步范围内（magpie 的设计），容器重启会丢，云端只用 key 型 provider；改了 secrets 后用 `POST /admin/magpie/restart` 让容器按新环境重启。
- Pi 侧：`MAGPIE_URL=container` 时 `baseUrl` 用哨兵主机名 `http://magpie.container/v1`，`installMagpieRoute` 把全局 fetch 里这个主机名的请求改道到 `MAGPIE` DO 的 `fetch`（pi-durable 的生成任务不暴露按请求注入 fetch 的入口）；DO 把请求转给容器的 3426 端口，冷启动期间按 500 ms 重试最多一分钟。目录每次 DO 冷启动拉一次，P0 没有缓存。
- 订阅类 provider 的 OAuth 登录（magpie 的 accounts）不在同步范围内，云端只有 API key 类 provider；目前只有 DeepSeek，Pi 用它够了。

**备选：小 VPS** 跑同一镜像，`/config` 挂卷，经 Cloudflare Tunnel 发布并套 Access 服务令牌，Worker 对该主机名的 fetch 注入 `CF-Access-Client-Id/Secret`。常开、无冷启动，多一台机器要管。magpie 把回环来源视为可信，隧道后面的 magpie 对任何能到主机名的人都是敞开的，所以 Access 不是可选项。

本机那份 magpie 继续给本机的 codex / claude 用，和云端那份经同一个 R2 bucket 同步配置（`keys=yes`），两边 provider 与 key 一致。

`AUTO_EFFORT_MODEL` 的分类调用同样经 magpie。

## 4. 消息流

1. NapCat 收到 QQ 消息，经反向 WS 发到 Worker，Bridge DO 唤醒。
2. Bridge DO 做授权与触发判定，向目标 Thread DO 发 `raw`（写消息库）；是触发消息则再发 `submit`。两次调用，`submit` 以入站键幂等，重复投递被 Thread DO 的 `inbound` 表拒绝。
3. Thread DO 落 `inbound`（`queued`），按规则开轮或插话，`delivered`；回合内模型调 `send_message` → Thread DO 经 RPC 调 Bridge DO → NapCat API → 返回 `message_id`，Thread DO 记发送审计并标 `already_sent`。
4. 回合结束 `done`，Thread DO 向 Registry DO 上报回合结果（供面板与事件记账），触发回合后抽取。
5. 外部事件：Worker 入口校验 → Registry DO 的事件服务（去重、合并、预算、安静时段）→ `submit` 到 `owner` Thread DO，只读回合规则不变。

现在 Inbox "重启后按 seq 重投 queued" 的恢复在 Thread DO 的每次冷启动时做：`open` 后扫 `inbound` 里的 `queued` 再投一次。

## 5. 存储映射

| 现在 | 去处 | 说明 |
|---|---|---|
| `pi.sqlite` | 各 Thread / Subagent DO 的 SQLite（`pi_` 前缀） | pi-durable 适配器现成 |
| `agent.sqlite`（宿主 harness：`cs.events.run`、`cs.mcp.approval`、`cs.pi.threads`、`cs.pi.input`） | 会话级文档随 Thread DO；全局文档进 Registry DO | 宿主 harness 的 `cs.pi.threads` 映射不再需要，DO 名字就是映射 |
| `qq-messages.sqlite`（消息库、FTS、日/周摘要） | 各 Thread DO | FTS5 trigram 照搬；owner 跨会话检索经 RPC 扇出，结果合并 |
| `qq-bridge.sqlite`（`inbound`、`outbox`、发送规则状态） | `inbound` 随 Thread DO；`outbox` 与限速状态进 Bridge DO | |
| `memory.sqlite`（条目、版本、关系、FTS）与 `memory/<ns>/profile.md` | 各命名空间的 Thread DO | 画像从文件变成一行，revision 语义不变 |
| `mcp-oauth.sqlite` | Registry DO | 凭据字段加密后存，密钥在 Secrets Store |
| `observability.sqlite` | Workers Logs + Analytics Engine 记指标；回合事件流存各 Thread DO 的 `obs_` 表并按保留期清理 | 面板实时视图改为订阅 Thread DO 的 WebSocket |
| `data/media`、`data/images`、`data/incoming`、`data/files` | R2，键为 `sha256` | 发送附件时 Bridge DO 从 R2 取流转给 NapCat；每日 GC 由 Cron 扫引用 |
| `data/codex/*`、`codex-threads*.json` | 删除 | |
| `secrets/gmail/*`、`.env` | Secrets Store / wrangler secrets | |
| `skills/shared` | R2 + Registry DO 的目录 | `skill_publish` 写 R2 |

DO SQLite 的硬限制：单对象 10 GB，单行值 128 KiB，一表 100 列。现有表没有超过 100 列的；超过 128 KiB 的值只有工具输出全文（现在落在临时文件），改为截断加 R2。

## 6. 身份与权限

模型不变：owner / 群成员 / 其他私聊三类，回合身份由 Bridge DO 判定后随 `submit` 传入，Thread DO 绑定到回合。DO 按会话隔离带来一个额外保证：一个群的 DO 物理上没有别的会话的消息库和记忆，跨会话读只能经 RPC，而 RPC 入口按调用方身份复核。`auth` 授权与事件回合的只读约束逻辑不动。

面板：Cloudflare Access 做登录，Worker 校验 Access JWT，不再有面板口令与 CSRF 自建逻辑（保留 same-origin 检查）。

## 7. 定时与后台工作

| 现在 | 去处 |
|---|---|
| 定时任务（`schedule`） | Registry DO 的目录 + alarm |
| 日/周摘要、衰老、夜间整理、保留清理 | Cron Trigger 触发一个管理 Worker，它逐个 RPC 各 Thread DO；DO 列表来自 Registry DO 登记（Thread DO 首次创建时登记自己） |
| 回合后记忆抽取 | Thread DO 内部队列 + alarm |
| 事件轮询（Gmail） | 改为 Pub/Sub push；webhook 来源天然支持 |
| 子 agent 超时、审批过期 | 各自 DO 的 alarm |

alarm 每个 DO 一个，需要多个到期时间的地方（Registry DO 的定时目录）自己维护最小堆。

## 8. 观测与面板

- 指标与告警：Workers Logs 结构化日志，Analytics Engine 记回合数、token、失败数；告警仍经 QQ 私聊发给 owner，由 Registry DO 的告警服务调 Bridge DO。
- 回合事件流与上下文占用：Thread DO 记自己的，面板页按会话键 RPC 取快照；实时视图用面板 Worker 到 Thread DO 的 WebSocket 转发。
- 脱敏规则（trace 只记元数据、事件回合只留固定字段）不变，脱敏在写入 DO 之前做。

## 9. 安全

- NapCat → Worker 的 WS 用现有 `NAPCAT_TOKEN`，另加 Cloudflare 的 IP 或 Access 服务令牌限制来源；token 轮换只改 Secrets Store 与 NapCat 配置。
- 所有密钥进 Secrets Store，代码与 DO 存储里不出现明文；OAuth refresh token 在 Registry DO 里以 Secrets Store 的密钥加密。
- Thread DO 的 RPC 只接受来自 Bridge DO、Registry DO、管理 Worker 和面板 Worker 的调用，调用方身份随 RPC 传入并复核。
- 事件回合的只读限制、PI-MCP 的 `eventAllow`、`allowPrivateNetworkHttp` 等规则不变；Workers 没有私网，MCP 目标只允许公网 HTTPS。
- 媒体下载的 SSRF 防护保留，Workers 的 fetch 不能访问内网，但仍要拒绝非 HTTPS 与重定向到别的 origin。

## 10. 代码改造清单

| 项 | 范围 | 量 |
|---|---|---|
| 删 codex | `src/agent/codex/`、`src/mcp/`、`backends/codex.ts`、BackendRouter 的双后端逻辑、受管 config/AGENTS.md 生成、面板 codex 页 | 删代码，连带 deps 测试 |
| 存储异步化 | 14 个直接用 `node:sqlite` 的模块：`context/store.ts`、`context/memory/store.ts`、`qq/reply-store.ts`、`qq/send-rules.ts`、`agent/pi-mcp/oauth-store.ts`、`agent/pi-tools/index.ts`、`obs/*` 六个、`shared/sqlite-migrate.ts` | 约 300 条 SQL 基本不改；同步调用链改 `await`，事务改为 `database.transaction(tx => …)`；这是最大的一块 |
| 按 DO 拆库 | 上述表按第 5 节归属拆到三类 DO 的 schema，迁移脚本从现有 sqlite 导出 | 新写 |
| 去文件系统 | `media/`（R2）、`agent/pi-tools/coding.ts` 与 `sandbox.ts`（Sandbox 或移除）、`project-context.ts` / `prompt.ts` / `skills.ts`（R2 或内联）、`context/memory/profile.ts`（改表）、`obs/ui` 的静态资源（内联） | 51 个文件 import 了 `node:fs`，其中 9 个属 codex 直接删 |
| 组合根 | `main.ts` 拆成 Worker 入口、三类 DO 类、管理 Worker、面板 Worker；配置从 `.env` 改为 wrangler 的 vars 与 secrets | 新写 |
| 通道 | `qq/bridge.ts` 从 WS 客户端改为 Hibernation 服务端；OneBot 协议编解码复用 | 中 |
| 子 agent | `pi-tools/subagent.ts` 从同 Harness 子会话改为子 DO + RPC 汇报 | 中 |
| Gmail | `sidecar/gmail` 从独立进程改为 Worker 路由与内部工具 | 中 |
| 测试 | vitest 跑 `@cloudflare/vitest-pool-workers`，Harness 与存储用 miniflare 的 DO；现有单测里依赖 sqlite 文件与 fs 的要重写 | 大 |

不变的部分：`channel/` 契约、`host/identity.ts`、ThreadHost 的调度规则、`turns.ts`、`events/service.ts` 的逻辑、`pi-mcp/` 除存储外、`memory/` 除存储外、提示词、发送规则。

## 11. 保留与容量

- 消息库：沿用 `history.rawDays`，由 Cron 管理 Worker 逐 DO 清理。
- Harness 历史：主会话不轮换；早于最近 3 次压缩标记且超过 N 天的条目删除。DO 的 SQLite 删行后空间会复用，不需要 VACUUM。
- 子 agent DO：结束后 14 天删除整个对象（`deleteAll`）。
- 回合事件流：7 天。
- R2 媒体：随消息库保留期，每日 GC。

## 12. 限制与风险

| 风险 | 处理 |
|---|---|
| 单次回合 CPU 超 5 分钟 | 只在极端的 JSON 处理下会发生；工具输出截断、codemode 脚本超时已限制 |
| DO 被驱逐时回合正在飞行 | 请求在飞行中不会驱逐；平台重启时任务从 pi-durable 检查点恢复，unsafe 工具按现在规则不重放 |
| Hibernation 被阻塞 | Bridge DO 里不能有 `setTimeout` 或挂起的 fetch；API 调用的等待用存储加唤醒实现 |
| NapCat 在中国大陆连 Cloudflare 边缘 | 反向 WS 走 443，一般可达；不稳则在 Tunnel 之外加一条备用域名。此风险要先实测 |
| 延迟 | DO 位置在首次访问的区域附近固定；模型出站到海外 provider 本来就是跨境，总延迟不比现在差 |
| 成本 | Workers Paid 5 美元/月起，DO 请求与存储按量；个人规模估计每月个位数美元；Sandbox 与 magpie 容器按活跃 CPU 另计，保活会把容器成本变成常量 |
| magpie 容器冷启动与状态 | 临时磁盘靠 R2 同步恢复；镜像须为 linux/amd64；容器内 magpie 对非回环来源仍校验 gateway key，但只有 Worker 能到达它 |
| 订阅类 OAuth 从云端 IP 使用 | 各 provider 条款不同，由主人确认；不行则该 provider 留在本机 magpie，云端只放 API key 类 provider |
| Pub/Sub push 要公网校验 | 用 Pub/Sub 的 OIDC token 校验，Worker 验签 |
| CIMD redirect 变更 | Notion 需重新登录一次 |
| 图片处理内存 | `/images/cloudflare` 在调用线程解码，大图占内存不释放；只对缩略图启用，大图走 R2 原样传给模型 |

## 13. 分期

1. **P0 可行性**：一个 Worker、Bridge DO、`owner` Thread DO；NapCat 反向 WS 直连；Harness 在 DO 里跑一个只有 `send_message` 的回合，先 DeepSeek 直连，再把 magpie 容器起在 Containers 上并从 Worker 调通 `/v1/models` 与一次补全。验证 CPU 限额、休眠唤醒、NapCat 连通、FTS5 建表、容器冷启动与 R2 同步恢复。三四天。
2. **P1 可用**：Inbox 状态机、消息库与 FTS、身份与权限、发送规则、记忆（读写与画像）、PI-MCP 与 codemode、群会话、面板最小页、数据迁移脚本。没有 coding 工具与子 agent。
3. **P2 完整**：定时任务、日/周摘要、夜间整理、外部事件（Pub/Sub push、webhook）、Gmail 内置、子 agent DO、告警。
4. **P3**：Sandbox coding 工具、技能发布、面板实时视图、历史数据全部导入。

P0 过不了就停，不动现有部署。

## 14. 明确不做

- 不保留 codex 后端的任何兼容层。
- 不把 ComfyUI、cs2-workshop 这类本机服务接到 Workers；它们如需保留走 PI-MCP 公网 HTTPS。
- 不做多实例 Bridge；一个 QQ 账号一个 Bridge DO。
- 不在 Workers 上跑 Playwright 或浏览器工具；需要时用 Cloudflare Browser Rendering 另议。

## 15. 依据

- pi-durable README「Storage」：`openDurableObjectSqliteStorage`、宿主表共享队列、便携 SQLite 核心不依赖 Node；「codemode」：`RemoteCodemodeSandbox`；「images」：`/images/cloudflare` 的内存提醒。
- Cloudflare 文档：[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits)（CPU 30 s 默认、`limits.cpu_ms` 至 5 分钟、SQLite 10 GB、单值 128 KiB、100 列）、[SQLite 存储 API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)（FTS5 支持）、[Containers 与 Sandbox GA](https://developers.cloudflare.com/changelog/2026-04-13-containers-sandbox-ga)、[Sandbox 平台](https://developers.cloudflare.com/sandbox/platform)。
- magpie 0.1.1549 的 `magpie --help`、`magpie web --help`、`magpie s3 help`；官方镜像 `ghcr.io/yetone/magpie`（[Railway 模板](https://railway.com/deploy/magpie-ai-gateway)：`/config` 卷与 `MAGPIE_WEB_KEY`）；[DEPLOY.md](DEPLOY.md) §3 的回环可信说明。
- 现有架构：[ARCHITECTURE.md](ARCHITECTURE.md) §2–§6、§11；[EVENTS-DESIGN.md](EVENTS-DESIGN.md)；[PI-MCP-DESIGN.md](PI-MCP-DESIGN.md)；[MEMORY-DESIGN.md](MEMORY-DESIGN.md)。
