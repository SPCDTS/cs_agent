# 独立 GitHub App 接入：基础层与待完成集成

## 当前交付状态（不可作为完整功能发布）

本次只实现并测试 `github/app.ts` 与 `github/connection.ts` 基础原语；尚未接入 EventsDO、HTTP 路由、Webhook 或浏览器。
原 PR 的 manual repo webhook 行为没有改变。不要把基础层测试通过解释为用户连接功能已完成，也不要现在创建 App 或迁移线上配置。

## 已实现的边界

- 独立配置类型：非密钥 `GITHUB_APP_ID`、`GITHUB_APP_SLUG`；Worker secrets `GITHUB_APP_PRIVATE_KEY`、`GITHUB_APP_WEBHOOK_SECRET`。尚未加入 Env/管理台状态。
- 私钥仅支持 PKCS#8 PEM（`BEGIN PRIVATE KEY`）；GitHub 下载的 PKCS#1 PEM 必须由运营方在受信环境转换成 PKCS#8。私钥不入库、不进日志/前端，也不复制开发 bot 的任何配置。
- 服务端 RS256 JWT：iat 回退 60 秒，exp 距当前 540 秒。使用 App JWT 查询 installation，核验 id、app_id、suspended_at；再签发短期 installation token，读取实际授权仓库。
- token 不持久化、不缓存；失败不回退到旧授权。API origin 固定，拒绝 redirect，不跟随 Link；单请求 10 秒，正文 1 MiB，最多 10 页/1000 仓库；不返回上游诊断。
- 连接 state 使用两个随机 UUID；只存 SHA-256。绑定管理员身份上下文和浏览器 verifier，10 分钟有效，最多 20 个未过期状态。消费后才调用 GitHub，失败需重新发起；不携带线程或路由。
- connection generation 防止旧异步 API 响应覆盖之后的吊销。同步/重连采用保守的先失效策略，调用者必须在同一 SQL 事务内吊销尚未取得执行许可的收件。
- `GitHubAppConnection` 自身不是 HTTP 鉴权边界。调用者必须先通过 owner admin 鉴权，传入服务端确定的身份绑定，不能直接接受客户端声称的管理员身份。

## 认证边界须明确

安装 setup callback 的 installation_id 及 setup_action 不能证明发起者的 GitHub 身份。当前设计只有单 owner 管理台，owner 管理员被视为有权关联专属 App 的所有安装。服务端查询保证属于该 App，但不证明管理员属于安装账号。
若将来 App 服务多个互不信任的 owner/租户，不能复用这个假设：需要 GitHub 用户授权及用户可访问 installations 的交集验证；不得以 state 或管理员登录替代该验证。

## 后续必须完成（发布阻断）

1. 管理台 POST start：已认证 owner + 浏览器 sessionStorage 随机 verifier；回调静态页只清理 URL 并回到管理台，由已认证 POST complete 消费 state。不要通过 URL 传 admin token。
2. Env 和安全状态视图接入；前端仅展示配置完整性、App slug、安装 ID、授权仓库，绝不展示私钥、JWT 或 installation token。
3. GitHubInbox 改为 installation ID + repository ID 绑定；增加 repositoryIds 配置/CAS；管理台只列 API 授权仓库、每页 10 条、保留草稿、允许空列表。旧 repo name 不能自动升级成授权。
4. Webhook raw HMAC 后在与业务事件相同的 body-hash 去重域内接收 lifecycle；不要按未签名的 event/delivery header 切换独立去重域。支持真实 installation/installation_repositories payload。
5. lifecycle 只作失效/触发权威同步的信号，不能用旧 body 重放恢复授权；卸载/暂停/移除仓库与未执行积压吊销原子化。API 失败 fail closed；明确恢复、重复、乱序和 DO 重建策略。
6. 执行许可前检查已验证的安装、授权仓库和失效代次。同步应优化为差异吊销，避免无变化同步也丢弃所有积压；当前基础原语刻意保守。
7. 切入 App 模式后旧 manual webhook 必须拒收且不可静默回退。迁移需用户重连并重新选择仓库，禁止靠历史名称 pin 自动授权。
8. 追加完整 HTTP mocked 契约、浏览器可达入口、生命周期/撤销/恢复收件、敏感信息、空列表 CAS 与旧 pump/Gmail 回归。

## 目标用户流程（尚未接通）

管理台「连接 GitHub」→ GitHub 安装专属 App 并选择授权仓库 → 返回管理台 → 同步授权仓库 → 选择监听仓库/事件并保存启用。用户不逐仓库建立 webhook、不复制 secret。

## 运营方将来一次设置（规划值，集成前不能使用）

- 独立 App 名称、homepage、App ID、slug；只供本 owner 时限制安装范围。
- Webhook URL：`https://<PUBLIC_ORIGIN>/github/webhook`；启用 webhook，设置独立随机 secret。
- Setup URL：计划 `https://<PUBLIC_ORIGIN>/admin/github/callback`（当前没有此路由）；不是 OAuth authorization callback，不应开启额外 OAuth 流程来冒充完成身份验证。
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
