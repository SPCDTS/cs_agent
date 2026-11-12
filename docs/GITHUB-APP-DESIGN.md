# 独立 GitHub App：统一事件接入

## 范围与入口

面向同一个个人 owner，不是多租户平台。owner 可明确连接多个 GitHub 身份及其个人/组织安装；事件只进入 owner 私聊，不增加群路由、eventAllow 或外部命令权限。独立创建事件 App，**不要复用开发 VM 的 bot App 或凭据**。

生产入口是 `GitHubConnections`（`github/connections.ts`）与 EventsDO。旧单连接模块已删除，相关测试已迁移到生产多身份服务；旧单安装记录不会静默升级成权限。

用户操作：
1. 管理台 → 外部事件 → GitHub →「安装 / 调整 App 仓库授权」，在 GitHub 选择账号/组织与仓库。
2. 返回管理台，点击「连接 / 添加 GitHub 身份」，完成 GitHub OAuth；回来后点击「确认连接刚授权的 GitHub 身份」。
3. 服务端列举该身份可访问、属于本 App 且未暂停的安装，分别验证用户仓库和安装仓库，**按稳定仓库 ID 取交集**。其他 App、其他用户无权访问的私有仓库不进入视图。
4. 在事件设置勾选安装下的仓库、既有事件动作，取消暂停并保存。仓库、安装、身份与收件列表每页 10 条。空列表表示不监听；分页及刷新保留打开中的草稿；CAS 冲突不会自动覆盖。
5. 添加另一个身份需再次明确执行连接。不会替换已有其他身份；同一安装归属于先前明确关联的身份，换归属须先断开该安装。
6. 独立断开安装或撤销身份。前者不影响其他安装；后者停用该身份全部安装。调整授权/暂停恢复后可点击「同步 / 恢复此身份安装」，不必每十分钟重新 OAuth。

管理 API（均须 owner admin Bearer；回调静态页例外）：
- GET /admin/github/connections
- POST /admin/github/connect/start：browser（64 位十六进制浏览器随机值）
- POST /admin/github/connect/complete：state、code、browser
- POST /admin/github/connect/sync：可选 userId
- POST /admin/github/connect/disconnect：kind=user|installation、id
- PUT /admin/github/config：expectedRevision 与 value；App 选择为 repositoryIds 数组，元素 installationId、repositoryId。
- POST /github/webhook：唯一收件 URL，不使用 admin Bearer，以独立 App raw-body HMAC 验签。

OAuth callback /admin/github/oauth/callback 和安装 setup /admin/github/callback 均已接线。公开回调页使用 nonce CSP、no-store、no-referrer，清理 URL，仅把有限长 code/state 暂存同浏览器 sessionStorage，再返回管理台。它不直接授予权限，不把管理员 token 放进 URL，不信任 setup 的 installation_id。真正消费发生在已认证 POST complete；成功/失败后前端清除暂存 code。

## 一次性运营配置（本次未创建、未部署）

在 GitHub Settings → Developer settings → GitHub Apps 新建**独立事件 App**：
- Homepage：管理台公开 HTTPS origin。
- User authorization callback URL：`https://<PUBLIC_ORIGIN>/admin/github/oauth/callback`。
- Setup URL：`https://<PUBLIC_ORIGIN>/admin/github/callback`。它不是 OAuth callback。
- Webhook URL：`https://<PUBLIC_ORIGIN>/github/webhook`；启用 webhook，设置独立随机 secret。
- 保持 user-to-server token expiration 启用。授权 URL 也请求 offline_access，以获取可轮换令牌。
- 多账号/组织安装需允许目标账号安装（必要时选 Any account；不需要发布 Marketplace）。**允许其他人安装不等于允许进入本 owner**，未显式连接的安装默认抑制。
- 最小 Repository permissions：Metadata read；Issues read；Pull requests read；Contents read（push/release）；Actions read（workflow_run）。不授予写权限或额外组织权限。
- 订阅 issues、pull_request、release、push、workflow_run，以及 repository 生命周期。installation、installation_repositories、github_app_authorization 按 GitHub App 自动生命周期推送规则接收。业务动作仍以管理台既有 CHOICES 为限。
- 用户必须自身有权查看仓库；组织 SSO、管理员审批及安装仓库选择仍由 GitHub 决定。

Worker 非秘密配置：
`GITHUB_APP_ID`、`GITHUB_APP_SLUG`、`GITHUB_APP_CLIENT_ID`、
`GITHUB_APP_CALLBACK_URL=https://<PUBLIC_ORIGIN>/admin/github/oauth/callback`。

只通过运行环境 secrets 配置：
`GITHUB_APP_PRIVATE_KEY`、`GITHUB_APP_CLIENT_SECRET`、
`GITHUB_APP_WEBHOOK_SECRET`、`GITHUB_APP_STORE_KEY`（独立随机 32 字节的 64 位十六进制主密钥）。
不得把值放入源码、SQLite 明文、日志、截图或管理台。用部署工具的 secret 输入方式；本任务没有生成/读取真实凭据。

私钥需 PKCS#8 PEM（BEGIN PRIVATE KEY）。GitHub 下载的 PKCS#1 私钥请在受信环境转换：
`openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`。
将转换结果作为 Worker secret，避免在终端日志打印；按运营方密钥管理流程处理临时文件。

主密钥轮换前先暂停 GitHub 来源；轮换后立即同步使旧密文解密失败并 fail closed，重新连接身份后再恢复；本版本不提供双密钥在线迁移。备份须同时保护运行环境主密钥和 DO 持久数据，不把两者公开存放。

## 长期授权与安全边界

- 一次性 state 只存 SHA-256，绑定服务端管理员凭据摘要与浏览器随机值；服务端独立生成 32 字节 PKCE verifier，使用 S256，十分钟过期，最多 20 个待消费 state。state/verifier 同一事务消费，防跨浏览器、过期、重放。全局 epoch 防止进行中的旧授权在撤销后回写。
- 每个 GitHub 身份独立保存 AES-256-GCM 密文，里面是必要 user access/refresh token 及期限。随机 IV，AAD 绑定用途、用户 ID、代次；密钥仅来自 GITHUB_APP_STORE_KEY。前端只得用户 ID/login、安装 ID、授权仓库和状态。
- GitHub expiring access token 通常八小时；refresh token 通常六个月。access 到期前两分钟刷新，按身份 single-flight；新令牌加密落库前再次检查身份自己的单调 generation，不回退旧令牌。刷新远端成功但落库前崩溃可能使旧 refresh token 失效，此时重新 OAuth，不以 App 权限替代用户授权。
- 如运营历史配置仍返回不失效 access token，本地最多保留一年；新授权主动请求 offline_access。失败或 key 解密失败不会放宽权限。
- Cron 每五分钟后台复验用户身份、用户安装列表、用户仓库与安装仓库交集；授权快照最多十分钟且不超过 token 有效期。不是十分钟人工租约。过期时收件/执行许可 fail closed，过期积压在续期前抑制。后台同步不等待 GitHub 网络后才处理 Gmail/普通 owner 工作。
- 用户级 API/刷新失败保守撤销该身份凭据和绑定，需要重新授权；单安装核验失败只停用该安装。网络故障可能造成可用性下降，这是刻意 fail closed，不使用旧权限兜底。
- installation token 仅内存缓存最多四分钟，永不落库或传前端；使用前仍核验权威 installation 的 app_id/id/暂停状态。每次仓库交集重新读取 API，不能凭 App 拥有 installation 证明用户权限。
- 固定 GitHub HTTPS origins，拒绝重定向、不跟随上游 Link；单次请求十秒、响应一 MiB，分页最多十页/1000 项。单身份最多发现 20 个本 App 安装，最多 20 个身份；超限拒绝而非截断后授权。API 错误不带远端诊断或 token。

## 收件、生命周期与恢复

- 唯一入口只使用 GITHUB_APP_WEBHOOK_SECRET；原始 body 有界 HMAC 验证后，持久 receipt 与 held 在同一 SQL 事务中写入，storage.sync 后才 ACK。
- installationId + repositoryId + 用户交集 + 明确 repositoryIds 选择共同决定接收和执行许可。未知安装持久记录 installation_not_authorized 抑制，不自动投递 owner。
- 所有业务、ping、生命周期共享唯一 bodyHash 去重域；未签名 event/delivery header 不能切换去重域。同 delivery 不同 body 返回 409；容量拒绝保持 503；保留原收件恢复、CAS、空列表、执行许可和暂停语义。
- github_app_authorization.revoked 仅按 GitHub user ID 撤销匹配身份，不误停其他身份。installation、installation_repositories、repository 生命周期保守失效其安装并原子吊销尚未获执行许可的积压。
- 生命周期任何 action（包括 created/unsuspend/added）都**不直接恢复**；重复/乱序旧 Webhook 最多导致再次失效。管理员同步必须通过权威用户+安装 API 才恢复，已抑制积压永不复活。仓库变化暂时停用整个相关安装，其他安装不受影响。
- 已实际执行的操作不能撤回；每次新 claim（含恢复）仍须有效安装授权，历史 permit 不是授权兜底；receipt finished 不等于 QQ 已送达。签名 ping 可在尚无 installation/repository 时确认配置，但不建立授权。
- DO 重建从密文与安装独立记录恢复；没有主密钥、凭据撤销、API 失败、过期快照均不能凭历史仓库名称恢复。
- 本服务断开只删除本地接入，不替用户卸载 GitHub App 或撤销 GitHub 全局授权；需要全局撤销时到 GitHub Settings → Applications 操作。

## 旧手工路径已移除

只保留独立 App，不存在模式切换、旧 secret、按仓库名白名单或首条收件 pin 授权路径。App 配置不完整时 HTTP 与 DO 均 fail closed。

- 配置仅接受 repositoryIds、selections、paused、settings；repositories 名称字段被拒绝。管理视图没有 mode、pins 或手工输入框。
- 默认 repositoryIds 为空。旧名称/混合配置首次加载时清空 ID 选择并增加 CAS revision，不能因为代码升级而赋权；已有 App 身份密文可以保留，owner 须明确重新选择仓库。
- 旧 pin 表被移除，旧单行连接和旧 state 不被导入生产授权表。旧 receipts/执行 ledger 保持可读。
- 没有当前安装授权的旧待执行收件全部抑制；旧 issued/finished 记录也不能作为新的执行授权。已实际执行的操作不能倒退。
- 合法 App receipt 的全局去重、恢复、暂停、容量、原子 ACK 保留。重新连接或重新选择不会复活旧抑制积压。
- 无需逐仓库创建 Webhook。运营方一次配置上述独立 App，owner 只需连接身份与勾选安装/仓库 ID；可关闭旧逐仓库 Webhook 以免重复拒收。

## 保留的并发安全修复

刷新使用身份自身单调 generation，安装发布检查其 generation；其他身份/安装失效不再丢弃已轮换 token，同身份安装失效也不丢有效用户 token。删除重连避免 ABA。未知 GitHub 主体的待完成 OAuth 仍由全局 epoch 保守防撤销竞争，可能要求重走授权，但不会误删其他身份凭据。相同身份重连只抑制失权、过期或已撤销积压，合法交集内待执行数据保留。

## 验证边界与已知限制

本地使用实际 Worker HTTP/admin/callback、EventsDO、持久 SQL、真实 HMAC/PKCE/AES-GCM，GitHub 上游为 mock；没有真实独立 App，尚未进行真实 OAuth、组织 SSO、安装事件和线上联调。上线前必须由运营方在独立测试安装验证上述配置。

本地最终测试统计与日志见交付记录。未执行部署、创建 App、推送、PR 合并或真实 Hyper-V/WSB smoke。测试中的既有平台 skip 与真实 App 未验证必须分别记录。

官方依据：
https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url
https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens


运营方可在 workers/ 使用 npx wrangler secret put <名称> 交互输入上述四项独立 secrets；主密钥须安全生成 32 字节随机值。私钥通过安全管道或交互输入 PKCS#8，不放命令参数、版本库或日志。非秘密配置放入部署环境 vars。创建 App、真实联调、推送与部署留待后续授权。
