# 独立 GitHub App：统一事件接入

## 范围与入口

面向同一个个人 owner，不是多租户平台。owner 可明确连接多个 GitHub 身份及其个人/组织安装；事件只进入 owner 私聊，不增加群路由、eventAllow 或外部命令权限。独立创建事件 App，**不要复用开发 VM 的 bot App 或凭据**。

生产入口是 `GitHubConnections`（`github/connections.ts`）与 EventsDO。旧 `GitHubAppConnection` 单行基础原语保留历史测试，但不用于生产接入；旧单安装记录不会静默升级成权限。

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
`GITHUB_MODE=app`、`GITHUB_APP_ID`、`GITHUB_APP_SLUG`、`GITHUB_APP_CLIENT_ID`、
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
- GitHub expiring access token 通常八小时；refresh token 通常六个月。access 到期前两分钟刷新，按身份 single-flight；新令牌加密落库前再次检查 epoch，不回退旧令牌。刷新远端成功但落库前崩溃可能使旧 refresh token 失效，此时重新 OAuth，不以 App 权限替代用户授权。
- 如运营历史配置仍返回不失效 access token，本地最多保留一年；新授权主动请求 offline_access。失败或 key 解密失败不会放宽权限。
- Cron 每五分钟后台复验用户身份、用户安装列表、用户仓库与安装仓库交集；授权快照最多十分钟且不超过 token 有效期。不是十分钟人工租约。过期时收件/执行许可 fail closed，过期积压在续期前抑制。后台同步不等待 GitHub 网络后才处理 Gmail/普通 owner 工作。
- 用户级 API/刷新失败保守撤销该身份凭据和绑定，需要重新授权；单安装核验失败只停用该安装。网络故障可能造成可用性下降，这是刻意 fail closed，不使用旧权限兜底。
- installation token 仅内存缓存最多四分钟，永不落库或传前端；使用前仍核验权威 installation 的 app_id/id/暂停状态。每次仓库交集重新读取 API，不能凭 App 拥有 installation 证明用户权限。
- 固定 GitHub HTTPS origins，拒绝重定向、不跟随上游 Link；单次请求十秒、响应一 MiB，分页最多十页/1000 项。单身份最多发现 20 个本 App 安装，最多 20 个身份；超限拒绝而非截断后授权。API 错误不带远端诊断或 token。

## 收件、生命周期与恢复

- App 模式只使用 GITHUB_APP_WEBHOOK_SECRET；原始 body 有界 HMAC 验证后，持久 receipt 与 held 在同一 SQL 事务中写入，storage.sync 后才 ACK。
- installationId + repositoryId + 用户交集 + 明确 repositoryIds 选择共同决定接收和执行许可。未知安装持久记录 installation_not_authorized 抑制，不自动投递 owner。
- 所有业务、ping、生命周期共享唯一 bodyHash 去重域；未签名 event/delivery header 不能切换去重域。同 delivery 不同 body 返回 409；容量拒绝保持 503；保留原收件恢复、CAS、空列表、执行许可和暂停语义。
- github_app_authorization.revoked 仅按 GitHub user ID 撤销匹配身份，不误停其他身份。installation、installation_repositories、repository 生命周期保守失效其安装并原子吊销尚未获执行许可的积压。
- 生命周期任何 action（包括 created/unsuspend/added）都**不直接恢复**；重复/乱序旧 Webhook 最多导致再次失效。管理员同步必须通过权威用户+安装 API 才恢复，已抑制积压永不复活。仓库变化暂时停用整个相关安装，其他安装不受影响。
- 已取得执行许可的操作不能撤回；receipt finished 不等于 QQ 已送达。签名 ping 可在尚无 installation/repository 时确认配置，但不建立授权。
- DO 重建从密文与安装独立记录恢复；没有主密钥、凭据撤销、API 失败、过期快照均不能凭历史仓库名称恢复。
- 本服务断开只删除本地接入，不替用户卸载 GitHub App 或撤销 GitHub 全局授权；需要全局撤销时到 GitHub Settings → Applications 操作。

## 从旧手工模式迁移

仅显式 GITHUB_MODE=manual 时保留既有手工 Webhook；未设置、空值、拼写错误一律拒收，不自动回退旧 secret。原手工部署升级时也必须明确设置 manual。运营方设置 app 并配置独立 App secrets 后：
- 不再接受旧 secret；手工 delivery 没有合法 installation 时拒收。
- 旧 repositories 名称、repo_pin、单行基础连接均不赋予 App 权限。
- 旧待执行收件 installation_id=0，在重新鉴权/claim 时抑制；先连接身份、再按 ID 明确选择仓库。
- 不自动恢复默认仓库；清空 repositoryIds 保持空。迁移后可由用户自行关闭旧逐仓库 Webhook，避免无意义拒收请求。
- 不把临时关闭 App 配置当成自动回退 manual；不要在故障时切模式绕过授权。

## 验证边界与已知限制

本地使用实际 Worker HTTP/admin/callback、EventsDO、持久 SQL、真实 HMAC/PKCE/AES-GCM，GitHub 上游为 mock；没有真实独立 App，尚未进行真实 OAuth、组织 SSO、安装事件和线上联调。上线前必须由运营方在独立测试安装验证上述配置。

本地最终测试统计与日志见交付记录。未执行部署、创建 App、推送、PR 合并或真实 Hyper-V/WSB smoke。测试中的既有平台 skip 与真实 App 未验证必须分别记录。

官方依据：
https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url
https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens


## 本次本地最终验证（2026-11-12）

- `npm run check` 最终退出 0：Workers/browser/runner 类型检查通过；66 个 Workers 测试文件、441 项通过。
- Workers Node：19 通过、1 skip；runner：28 通过、2 skip。合计 47 通过、3 skip、0 失败。
- runner build 与 Worker `deploy --dry-run --containers-rollout=none` 通过；没有部署。
- GitHub 定向：6 文件、59 项通过；新增完整 HTTP/EventsDO mock 安全链路 8 项。新增真实 UI 模块 DOM 交互 2 项通过，既有管理台 loadSources/UI 测试也通过。
- 既有 skip：JS fork 后台子进程清理、独立桌面身份检查器、Hyper-V 来宾原生助手。没有运行真实 Hyper-V/WSB smoke 或真实 GitHub App 联调。
- 日志目录：`C:\AgentWork\github-app-connect-logs`；最终主日志 `multi-check-release.log`；定向 `multi-final-targeted.log`；类型 `multi-final-types.log`；UI `multi-browser.log`；独立 Node/build `multi-node-final.log`、`multi-build-final.log`。
- 保留中间失败，不把重跑当成根因修复：首轮全量 435 通过/3 失败（安装 token 缓存测试仍使用旧 mock 序列、旧 UI 文案断言、既有 group-coding:114 一秒级等待超时）；前两项按新行为修正。群测试没有跳过或增加 timeout，单独 7 项通过，之后两轮完整 Workers 均 441 项通过；群偶发超时根因仍未证明。
- 第二轮 Workers 全通过后，Node 的旧手工 UI fixture 缺少新增必填 mode/connections 导致契约拒绝；补齐 fixture，未放宽浏览器 schema，最终完整 check 全通过。
- 旧环境更新取消的 PKCE 全量任务未盲目重放；先确认其测试进程已停止，再用新 requestId 启动验证。

运营方可在 `workers/` 使用 `npx wrangler secret put <名称>` 交互输入上述四项独立 secrets；主密钥须自行安全生成 32 字节随机值。私钥通过安全管道或交互输入 PKCS#8 内容，不放入命令参数、版本库或日志。非秘密配置放入待部署环境的 vars。创建 App、真实联调、推送与部署均留待父 agent 审查及用户后续授权。


## 固定主线合并与聚焦安全复查

本轮只合并指定 main 提交 987c0d7d6e54f504959a9306fd231120c0de1019（统一环境工具并按会话授权 envId），不追后续 main，不推送或部署。

发现并修正的实质问题：
- 原 syncIdentity 用全局 epoch 判断 refresh 结果是否可写。另一个身份/安装失效会改变全局 epoch，导致已经在 GitHub 轮换成功的新 token 未落库；下次使用旧 refresh token 会误要求重连。现在 refresh 使用身份自身的单调 generation，安装快照提交使用该身份与该安装 generation，其他身份失效不再丢弃有效轮换。
- 身份 generation 由全局单调计数分配，避免删除再连接从 1 开始产生 ABA；旧异步失败不会撤销新连接。全局 epoch 仍只负责尚未确定 GitHub 主体的 OAuth state/complete 防重放与撤销竞争。其他生命周期可能使待完成 OAuth 重新开始，但不会误删其他身份凭据；这是保守的待授权边界。
- 同身份重新 OAuth 不再先吊销所有合法积压：新交集仍包含的、未过期未撤销安装保留 pending receipts；被移出交集、过期或已撤销的积压仍抑制且不会复活。
- Webhook 模式必须显式 app 或 manual。模式未配置/非法返回 503；App 缺少必需配置或 callback 格式错误同样拒收，不使用 legacy secret。DO 接收及执行许可也 fail closed，防止仅 HTTP 层检查而内部退回 manual。

新增回归覆盖两个身份并发刷新/撤销、同身份安装失效中的 token 轮换、删除重连 ABA、重连保留/缩小交集积压、模式缺失/错误/部分 App 配置的 HTTP 与 DO 拒收。既有手工模式测试环境显式设置 manual，不放宽生产默认值。合并后的最终统计见最新交接记录，上一节为合并前已完成的历史验证。
