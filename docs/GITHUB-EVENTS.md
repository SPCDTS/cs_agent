# GitHub App 事件接入、规则与诊断

只支持独立 GitHub App（面向单个 owner，非多租户平台）。事件只进入 owner 私聊，不增加群路由或外部命令权限。**不要复用开发 VM bot App 或凭据。**

## 1. 一次性 App 配置与连接流程

### 1.1 GitHub App 配置

在 GitHub Settings → Developer settings → GitHub Apps 新建独立事件 App：

- **Homepage**：管理台公开 HTTPS origin。
- **User authorization callback URL**：`https://<PUBLIC_ORIGIN>/admin/github/oauth/callback`
- **Setup URL**：`https://<PUBLIC_ORIGIN>/admin/github/callback`（不是 OAuth callback）
- **Webhook URL**：`POST https://<PUBLIC_ORIGIN>/github/webhook`（独立随机 secret）
- 启用 user-to-server token expiration（授权 URL 主动请求 `offline_access`）；允许目标账号/组织安装（未显式连接的安装默认抑制）。
- **最小 Repository 权限**：Metadata read、Issues read、Pull requests read、Contents read、Actions read；不授予写权限或额外组织权限。
- 订阅 `issues`、`pull_request`、`release`、`push`、`workflow_run` 及 `repository`（按需加 `issue_comment`、`pull_request_review`、`pull_request_review_comment` 等）。

Worker 配置（写入部署档案 `vars`）：`GITHUB_APP_ID`、`GITHUB_APP_SLUG`、`GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CALLBACK_URL`。

Worker Secrets（通过 `wrangler secret put` 写入，不入库不落日志）：`GITHUB_APP_PRIVATE_KEY`（PKCS#8 PEM，可用 `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem` 转换）、`GITHUB_APP_CLIENT_SECRET`、`GITHUB_APP_WEBHOOK_SECRET`、`GITHUB_APP_STORE_KEY`（独立随机 32 字节 64 位十六进制主密钥）。

主密钥轮换前先暂停 GitHub 来源，轮换后同步触发旧密文解密 fail-closed，重新连接身份后再恢复。

### 1.2 管理台连接与勾选

1. 在管理台「任务与事件 → GitHub」安装/调整 App 仓库授权。
2. 点击「连接 / 添加 GitHub 身份」完成 OAuth，返回管理台后显式点击「确认连接刚授权的 GitHub 身份」（公开回调页使用 nonce CSP、`no-store`、`no-referrer`，清理 URL 并仅在同浏览器 `sessionStorage` 暂存有限长 `code`/`state`，真正消费在已鉴权的 `POST /admin/github/connect/complete`）。
3. 服务端按**用户可访问仓库 ∩ App 安装仓库的稳定数字 ID** 取交集（仓库名仅显示与构造链接，不授权）。
4. 勾选 `installationId + repositoryId` 与事件规则，取消暂停并保存（列表每页 10 条，保留打开草稿与 CAS 冲突）。默认不监听任何仓库。

管理 API（均要求 Bearer `ADMIN_TOKEN`）：`GET /admin/github/connections`、`POST /admin/github/connect/{start,complete,sync,disconnect}`、`PUT /admin/github/config`、`GET /admin/github/capabilities`、`POST /admin/github/capabilities/refresh`、`GET /admin/github/receipts/:id`。

## 2. 四层安全边界与长期授权

1. **能力发现**：App JWT 调用 `GET /app` 与 `GET /app/installations/{id}`（缓存 5 分钟，最短间隔 30 秒，失败退避至 15 分钟），仅用于候选提示与缺口诊断，**无权修改或延长授权**。
2. **认证与控制分流**：`POST /github/webhook` 流式上限 256 KiB、读取超时 5 秒，校验 Content-Type、严格 UTF-8 与 `GITHUB_APP_WEBHOOK_SECRET` 原始 body HMAC 后解析。未签名 `event`/`delivery` header 不作为授权依据。
3. **权限与规则交集**：当前有效安装快照（最长 10 分钟且不超过 token 有效期）∩ 用户交集 ∩ owner 显式勾选的 `repositoryIds` 与事件规则。
4. **原子收件与投递**：receipt 与 `event_held` 在同一 SQLite 事务提交并 `storage.sync()` 后才返回 ACK；仅新写入 `held` 的业务事件安排 alarm。

安全约束：

- **OAuth state / PKCE**：一次性 state 仅存 SHA-256，绑定管理员凭据摘要与 64 位十六进制浏览器随机值，PKCE S256，10 分钟过期、最多 20 个在途 state。
- **令牌加密与刷新**：每个身份的 user access/refresh token 独立 AES-256-GCM 加密（AAD 绑定用途、用户 ID、单调 generation）；access 到期前 2 分钟按身份 single-flight 刷新。installation token 仅内存缓存最多 4 分钟，永不落库或传前端。
- **固定上游边界**：仅允许 GitHub 固定 HTTPS origin，`redirect: "manual"`，单次 10 秒 / 1 MiB / 最多 10 页（1,000 项），单身份最多 20 个安装、最多 20 个身份。
- **授权新鲜度与退避**：10 分钟快照到期视为 `wait`（允许受配额约束的 held 收件，禁止入队执行）；5 分钟 Cron 与 alarm 后台复验，网络/限流失败持久化每安装指数退避（1～15 分钟），明确撤销或权限拒绝立即 `deny`。
- **生命周期保守失效**：`github_app_authorization.revoked` 仅撤销匹配用户 ID（含未完成首次 OAuth 的最多 256 个撤销用户 ID 内存竞争检查）；`installation` / `installation_repositories` / `repository` 任意 action 只失效该安装并吊销未获许可积压，**绝不凭 webhook 自动恢复**，恢复必须经权威 API 显式同步，已抑制积压永不复活。

## 3. 去重域、配额隔离与事件规则

### 3.1 独立配额与全局去重

- 所有业务、ping、生命周期在记录保留窗口内共享唯一 `bodyHash`（SHA-256）与 `deliveryId` 去重域：重复 body 返回 200，同 delivery 不同 body 返回 409。
- **业务 ledger**：仅真正入队的 owner 业务计入，最多 5,000 条、pending 最多 200（满载 503，不淘汰未完成数据；terminal 保留 30 天）。通用未知事件独立限 200 归档 / 20 未完成（`quota=0`，共享总 200 pending 上限）。
- **独立辅助账本**：已关联 owner 的 control 最多 1,024 条 / 24 小时，陌生 noise 最多 256 条 / 10 分钟，各自 FIFO 滚动，绝不挤占业务配额，也绝不阻止业务满载时的合法撤销落库。去重仅在记录尚在（TTL 或同类 FIFO 淘汰先到者）期间有效。

### 3.2 事件规则、评论与过滤语法

配置 JSON 上限 256 KiB（HTTP 封装 257 KiB），未知字段拒绝，不支持模板/JSONPath/eval：

- `selections`（最多 100 项）：`event` 或 `event.action` 精确匹配（裸 `event` 仅匹配无 action）。
- `rules`（最多 100 项）：`{ event, actions, subject? }`，`event` 匹配 `^[a-z_]{1,40}$`；`actions` 必填 `"*"` 或 1～32 项非空字符串数组（`[""]` 仅匹配缺失 action 的事件）；`subject` 仅 `issue_comment` 支持 `any | issue | pull_request`。
- `selections` 与 `rules` 为 **OR**；`commentFilters`（`{ excludeConnectedUser, ignoreBots }`，默认均 `false`）与 `settings.filters` 对所有匹配规则共享生效（不可被另一条 OR 绕过）。
- **专用与通用事件**：`issues`、`pull_request`、`release`、`push`（`push.after` 须为精确 40/64 位十六进制）、`workflow_run` 及三类评论（`issue_comment`、`pull_request_review`、`pull_request_review_comment`，不保存 diff_hunk/代码）走专用校验；其他仓库级普通事件在权限交集与显式规则满足时走受限通用摘要（不遍历原始 payload）。`meta`、`membership`、`organization`、`org_block`、`team`、`team_add`、`personal_access_token_request`、`deployment_protection_rule` 不开放普通订阅。
- **事件回合权限与调度**：评论与事件正文仅作外部资料，进入限权事件回合，宿主拒绝 shell、写文件、MCP 写入、派子 agent 与授权操作。每来源预算按滚动 60 分钟 `event_run` 批次计数，合并窗口从最早待处理事件起算（每批最多 10 条），不随新事件重置。

## 4. 连接失败诊断

`connect/start` 与 `connect/complete` 失败仅返回固定 `error` 与 `requestId`（同时写入响应头 `X-Request-ID`）。服务端仅记录 `event=github_connect_failed`、`requestId`、`operation`、白名单 `stage`、固定 `code`、对外 HTTP `status`，上游失败另记白名单 `reason`（`request_init`、`network`、`timeout`、`http_error`、`empty_body`、`invalid_encoding`、`invalid_json`、`server_error`、`temporarily_unavailable`、`body_too_large`）与 `upstreamStatus`；绝不记录原异常正文、token、code、state、browser、verifier 或 URL query。

| `stage` | 含义 |
| --- | --- |
| `state_missing` / `state_expired` / `state_binding` / `state_epoch` | state 缺失、超时、管理员/浏览器绑定不匹配或 epoch 变化 |
| `configuration` | 必需 App 配置或主密钥缺失（503） |
| `token_exchange` | code/PKCE 换 token 失败 |
| `user` / `discover` / `inspect` / `app_jwt` / `install_repo` | GitHub 用户身份、安装发现、用户/安装仓库查询或 App JWT 签名失败 |
| `vault` / `persist` / `snapshot` / `revoked` | 加密、落库、快照或连接期间被撤权 |
| `rpc` | DO 构造/传输层失败（500），不可归因于用户授权 |

排障时保存首次失败的 `error` 与 `requestId` 关联日志，切勿反复点击旧确认按钮或上传完整 HAR / OAuth 回调 URL。
