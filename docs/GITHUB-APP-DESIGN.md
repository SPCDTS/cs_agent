# 独立 GitHub App 接入：基础层与待完成集成

## 当前交付状态（不可作为完整功能发布）

本次只实现并测试 `github/app.ts` 与 `github/connection.ts` 基础原语；尚未接入 EventsDO、HTTP 路由、Webhook 或浏览器。
原 PR 的 manual repo webhook 行为没有改变。不要把基础层测试通过解释为用户连接功能已完成，也不要现在创建 App 或迁移线上配置。

## 已实现的边界

- 独立配置类型：非密钥 `GITHUB_APP_ID`、`GITHUB_APP_SLUG`、`GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CALLBACK_URL`；Worker secrets `GITHUB_APP_PRIVATE_KEY`、`GITHUB_APP_WEBHOOK_SECRET`、`GITHUB_APP_CLIENT_SECRET`。尚未加入 Env/管理台状态。
- 私钥仅支持 PKCS#8 PEM（`BEGIN PRIVATE KEY`）；GitHub 下载的 PKCS#1 PEM 必须由运营方在受信环境转换成 PKCS#8。私钥不入库、不进日志/前端，也不复制开发 bot 的任何配置。
- 服务端 RS256 JWT：iat 回退 60 秒，exp 距当前 540 秒。使用 App JWT 查询 installation，核验 id、app_id、suspended_at；再签发短期 installation token，读取实际授权仓库。
- token 不持久化、不缓存；失败不回退到旧授权。API origin 固定，拒绝 redirect，不跟随 Link；单请求 10 秒，正文 1 MiB，最多 10 页/1000 仓库；不返回上游诊断。
- 连接 state 使用两个随机 UUID；只存 SHA-256。绑定管理员身份上下文和浏览器 verifier，10 分钟有效，最多 20 个未过期状态。消费后才调用 GitHub，失败需重新发起；不携带线程或路由。
- connection generation 防止旧异步 API 响应覆盖之后的吊销。同步/重连采用保守的先失效策略，调用者必须在同一 SQL 事务内吊销尚未取得执行许可的收件。
- `GitHubAppConnection` 自身不是 HTTP 鉴权边界。调用者必须先通过 owner admin 鉴权，传入服务端确定的身份绑定，不能直接接受客户端声称的管理员身份。

## 认证边界须明确

安装 setup callback 的 installation_id 及 setup_action 不能证明发起者的 GitHub 身份，**即使单 owner 也不得仅凭管理员登录和 App 归属绑定**。此前的单 owner 信任假设已删除。

绑定前必须完成独立事件 App 的 GitHub 用户 OAuth web flow：`start()` 返回固定 GitHub authorize URL，回调经 owner 管理员身份+浏览器 verifier+一次性 state 校验后，服务端 POST code/client ID/client secret 到固定 GitHub token endpoint。用户 token 仅存在当次调用内，用于有界分页 GET `/user/installations`，确认所选 installation ID 属于该用户、配置 App 且未暂停；随后再用 App JWT 查询安装、installation token 获取仓库。任何一步失败均不绑定。用户 token、refresh token 不入库、不返回前端；setup ID 仍只是待验证提示。

用户授权 callback URL 固定为配置 origin 下 `/admin/github/oauth/callback`，与 setup URL `/admin/github/callback` 是两个不同入口。实际路由和浏览器接线仍待实现，不能把 URL 构造及 mocked code 交换当成已完成的浏览器流程。

官方安全依据（父 agent 核验）：https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url

## 后续必须完成（发布阻断）

1. 管理台 POST start：已认证 owner + 浏览器 sessionStorage 随机 verifier；回调静态页只清理 URL 并回到管理台，再发起用户 OAuth，由已认证 POST complete 消费 state/code 并核验用户 installation 交集。不要通过 URL 传 admin token。
2. Env 和安全状态视图接入；前端仅展示配置完整性、App slug、安装 ID、授权仓库，绝不展示私钥、JWT 或 installation token。
3. GitHubInbox 改为 installation ID + repository ID 绑定；增加 repositoryIds 配置/CAS；管理台只列 API 授权仓库、每页 10 条、保留草稿、允许空列表。旧 repo name 不能自动升级成授权。
4. Webhook raw HMAC 后在与业务事件相同的 body-hash 去重域内接收 lifecycle；不要按未签名的 event/delivery header 切换独立去重域。支持真实 installation/installation_repositories payload。
5. lifecycle 只作失效/触发权威同步的信号，不能用旧 body 重放恢复授权；卸载/暂停/移除仓库与未执行积压吊销原子化。API 失败 fail closed；明确恢复、重复、乱序和 DO 重建策略。
6. 执行许可前检查已验证的安装、授权仓库和失效代次。同步应优化为差异吊销，避免无变化同步也丢弃所有积压；当前基础原语刻意保守。
7. 切入 App 模式后旧 manual webhook 必须拒收且不可静默回退。迁移需用户重连并重新选择仓库，禁止靠历史名称 pin 自动授权。
8. 追加完整 HTTP mocked 契约、浏览器可达入口、生命周期/撤销/恢复收件、敏感信息、空列表 CAS 与旧 pump/Gmail 回归。

## 目标用户流程（尚未接通）

管理台「连接 GitHub」→ GitHub 安装专属 App 并选择授权仓库 → 返回管理台 → 完成 GitHub 用户授权并验证所选安装可访问 → 同步授权仓库 → 选择监听仓库/事件并保存启用。用户不逐仓库建立 webhook、不复制 secret。

## 运营方将来一次设置（规划值，集成前不能使用）

- 独立 App 名称、homepage、App ID、slug；只供本 owner 时限制安装范围。
- Webhook URL：`https://<PUBLIC_ORIGIN>/github/webhook`；启用 webhook，设置独立随机 secret。
- Setup URL：计划 `https://<PUBLIC_ORIGIN>/admin/github/callback`（当前没有此路由）；不是 OAuth authorization callback。必须另外配置用户授权 Callback URL `https://<PUBLIC_ORIGIN>/admin/github/oauth/callback`，并配置独立事件 App client ID/client secret。
- 最小仓库权限：Metadata read（隐含）；Issues read；Pull requests read；Contents read（push/releases）；Actions read（workflow_run）。不授予写权限或组织权限。
- 订阅 issues、pull_request、release、push、workflow_run；installation 与 installation_repositories 生命周期按 GitHub App 的实际推送规则处理。后端与 UI 必须只开放已经支持的事件动作。
- 不创建或复用开发 bot；没有真实独立 App，因此尚无真实认证或端到端成功证据。

本文件是开发交接说明，不替代现有可用功能文档。官方流程由父 agent 独立复核后再确定最终集成方案。

## 本地验证记录

- GitHub 定向：`npm --prefix workers test -- test/github-app.test.ts test/github-connection.test.ts test/github-events.test.ts test/github-pump.test.ts --maxWorkers=1`，4 文件/34 项通过，其中新增 14 项。
- `npm run check`：Workers/browser/runner types 通过；Workers 全量 415 通过/1 失败。失败为未修改的 `group-coding.test.ts:114` 网页群聊回合等待 assistant 消息超时；单独重跑该文件仍为 6 通过/1 失败。没有宣称全量成功，也未证明这是基线问题。
- 因 check 在 Workers 测试中止，另行执行 `npm run test:node`：Workers Node 17 通过/1 skip，runner 28 通过/2 skip，0 失败。skip 为 JS fork 子进程清理、独立桌面身份检查器、Hyper-V 来宾原生助手；没有运行真实 WSB/Hyper-V smoke。
- 另行执行 `npm run build`：runner build 和 Worker deploy dry-run 成功，未部署。
- 初次定向发现 TextDecoder 类型参数与测试 JWT 验证使用私钥的问题，已修复后重跑通过。初次日志重定向因 PowerShell 将 native stderr 当异常中断；改为 cmd 重定向后获得上述完整日志，未关闭校验或绕过 hook。
- 真实独立 App 尚未创建，所有新认证测试为 API mocked 契约，不是端到端安装成功。

### 用户 OAuth 安全修正后的最终复验

按官方 setup URL 警告删除 App-only 绑定路径：`complete` 必须接受 code，先检查用户可访问安装再读仓库；缺少 `userVerified` 的旧基础层记录禁止直接 sync，必须重连。
新增 code 交换、固定 OAuth URL、不返回 token、伪造/不可访问/cross-App/暂停安装、用户安装分页上限、拒绝绑定后不读仓库及旧绑定拒绝静默升级的测试。

最终 `npm run check` **退出 0**：65 个 Workers 文件/426 项全部通过；Workers/browser/runner types 全通过；Workers Node 17 通过/1 skip，runner 28 通过/2 skip；runner build 与 Worker dry-run 通过。另行 Node/build 复跑也退出 0。此前群网页超时在这次全量中通过，保留之前失败记录而不修改测试或扩大超时。
OAuth 定向在最后一项旧绑定迁移测试加入前为 5 文件/43 项通过；该迁移测试随后包含在最终全量 426 项通过中。
日志：`oauth-check.log`、`oauth-targeted-final.log`、`oauth-types-final.log`、`oauth-node.log`、`oauth-build.log`。
这些结果仍只证明基础模块和回归；HTTP/浏览器完整 web flow 接线以及原任务余下的 App Webhook/UI 集成未完成，不可发布成完整功能。
