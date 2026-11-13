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

这四项写入当前环境的 `workers/deployments/<档案>.json` 的 `vars`。本仓库生产 CI 使用 `workers/deployments/production.json`；仅在 Cloudflare 控制台修改会在后续部署时被档案覆盖，因此控制台调整后也要同步档案。`CS_AGENT_COMMIT` 由 CI 注入当前提交，不复制控制台中的固定值。

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
- installationId + repositoryId + 用户交集 + 明确 repositoryIds 选择共同决定接收和执行许可。未知安装在独立短期有界辅助记录中记为 installation_not_authorized，不占业务配额、不自动投递 owner。
- 所有业务、ping、生命周期在记录保留窗口内共享唯一 bodyHash 去重域；未签名 event/delivery header 不能切换去重域。同 delivery 不同 body 返回 409；容量拒绝保持 503；保留原收件恢复、CAS、空列表、执行许可和暂停语义。
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

## 独立配额、持久控制与有限重放窗口

PR1 审查发现：陌生安装的合法签名收件及 ping/lifecycle 原先共同占用 5000 条业务 receipt，业务满载还会阻止撤销。本轮隔离如下：

- 只有真正入队的 owner 业务写入业务 ledger：上限 5000、pending 上限 200。后来撤销而 suppressed 的业务记录仍留在该 ledger，不会被噪声驱逐；terminal 保留三十天，pending 不按时间删除。
- 未入队的控制、ping、权限/过滤诊断进入独立辅助表。按已签名 body 的 installation/user ID 判定 owner 关联，**不是按未签名 event header 判定保护域**；ping 也保留这些主体字段。
- 已绑定或已发现的在途 owner 主体：control 最多 1024 条，TTL 24 小时；陌生主体：noise 最多 256 条，TTL 十分钟。各自 FIFO 滚动，满额只淘汰同类最老记录，不触碰业务 ledger，也不跨类挤占。辅助数据不进入模型队列，管理页显示有界计数而非陌生仓库内容。
- 所有业务、历史、control、noise 共用 bodyHash 与 delivery-ID 查询域；相同 delivery 不同 body 仍是 409，跨域改 header 仍去重。查重与记录/淘汰、撤销在一个 SQL 事务；失败完整回滚，DO storage.sync 成功后才 ACK。业务或控制配额满额都不会阻止已绑定安装的新撤销持久生效。
- **只保证记录尚在时的去重。** 辅助窗口以 TTL 到期或同类 FIFO 淘汰较早者为准；业务 terminal 记录三十天后亦可清理。窗口结束后，同一合法签名 body 可能再次处理，但仍须当前安装/用户交集及显式 ID 选择。旧控制重放最多保守失效，绝不自动授予或恢复权限。不声称无限防重放。
- 升级保留此前最多 5000 条旧 ledger 原文、状态、hash 和执行键，旧行一次性标记 quota=0，不消耗新业务配额；新业务始终 quota=1。旧 terminal 仍按原三十天清理，旧 pending 的鉴权/恢复不变。因此最坏升级暂存为旧 5000 + 新业务 5000 + control 1024 + noise 256 条；无新写入可扩张旧配额。
- 此隔离解决存储配额相互挤占，不是无限流量、网络或 CPU 的抗拒绝服务保证。

### 未知主体与 OAuth 竞争

陌生 installation 生命周期不增加全局 epoch、不删除 owner 待授权 state、不改变其他绑定。已绑定安装照常撤销；发现身份/安装后的在途授权只取消匹配主体，防迟到 API 结果恢复失效权限。

首次 OAuth 的 /user 尚未返回时，用户撤销不能直接丢弃：每个在途流程临时保留至多 256 个不同撤销用户 ID，识别身份后只检查匹配项并清空集合。溢出只拒绝该尚未识别的在途流程，不改变全局 epoch、其他待授权 state 或已绑定身份。陌生 installation 事件不进入此集合；单个陌生用户反复撤销不增加不同 ID 数量。最多 20 个在途流程，finally 清理；消费 state 已持久化，DO 重启中断的流程不能继续发布。新连接始终重新调用权威用户/安装 API，不从未知事件恢复权限。

### push 对象 ID

push.after 必须是字符串、精确 40 或 64 个十六进制字符（大小写均可）；拒绝数组/数字强制转换、非法字符以及尾随换行或空白。链接仍固定在 GitHub 仓库 commit 路径。


### 未签名 header 与唤醒边界（PR1 补充验证）

event/delivery header 不在 HMAC 内，不能作为可信事件身份。生命周期解析沿用保守失效策略：例如 issues.opened 的已签名 body 首次被改头为 repository/installation，可导致相关绑定失效，不能据此授予权限；不声称查重能够阻止首到请求的改头。现有记录保留期间，控制先到再业务、业务先到再控制都按同一个 bodyHash 去重，且同 delivery 不同 body 仍冲突。回归覆盖真实 lifecycle（不仅 ping）、重建、显式 API 恢复后再重投。

未知 body 在 owner 完成授权后仍受原噪声记录查重保护；TTL 或 FIFO 淘汰后可再次处理，但必须重新通过当前授权与显式仓库选择。测试覆盖 issues/repository/ping 三类未知 body、两种淘汰边界，以及失去选择时仍被抑制。

收件事务完成后，只有新写入 held 的业务事件安排 alarm；噪声、ping、控制、过滤、重复、冲突及容量拒绝不新增/提前 alarm，原有其他来源 alarm 不被删除。控制撤销仍在事务内同步完成并经 storage.sync 后 ACK，不依赖 alarm。若业务已提交而安排 alarm 失败，返回 503，重试按已存在的 body 去重；Cron 重建持久 held 的调度，覆盖提交与安排唤醒之间的故障窗口。配置变更/恢复的主动唤醒保留。
