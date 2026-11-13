# GitHub 可配置事件通知

## 四层边界
1. **能力发现**：App JWT 调用 GET /app 和 GET /app/installations/{id}，仅用于候选及诊断。
2. **认证/控制分流**：有界读取、HMAC、严格 UTF-8 JSON、安装及仓库信封；控制撤销走既有专门路径。
3. **权限/规则**：当前 App 安装、已连接用户可访问仓库的交集，再与 owner 明确选择的安装/仓库 ID、事件规则及过滤条件相交。
4. **聚合/投递**：原子收件、去重、合并、预算、暂停、授权复验、owner 私聊事件回合。能力快照不参与授权判决。

GitHub 事件名 header 不在 HMAC body 签名范围内，不是授权依据。真实签名事件也不授予仓库或用户权限。控制处理只能失效权限，不能依据 webhook 恢复权限；恢复必须经过已有上游复验/连接流程。安装撤销等控制事件不受普通用户规则、暂停、评论过滤或预算阻断。

## 配置兼容与明确语法
原 repositoryIds、selections、paused、settings 保留。默认四项事件保持原样，新安装不自动开启评论。
- selections 不再以预设枚举限制；最多100项，event 或 event.action 精确匹配。裸 event 只匹配没有 action，不改变旧 push 语义。
- rules 最多100项，结构为 {event, actions, subject?}。event 精确匹配 ^[a-z_]{1,40}$，不支持通配。
- actions **必填**，为 "*" 或1至32个不重复字符串的数组。"*" 表示该 event 的所有 action（含没有 action）；[""] 只匹配无 action。非空 action 同上述安全名称语法。[]、缺省、数组里的 "*"、正则及表达式拒绝。
- subject 仅 issue_comment 可带 any / issue / pull_request；缺省 any。其他 event 带 subject 拒绝。
- selections 与 rules 为 OR；commentFilters 与既有 settings.filters 是所有匹配规则共享的排除条件，不能靠另一条 OR 绕过过滤。
- commentFilters 可选；提交时对象为 {excludeConnectedUser:boolean, ignoreBots:boolean}。缺省两项均 false，保持旧行为，不静默过滤自己的测试评论。
- 配置未知字段拒绝；配置 UTF-8 JSON 最大256KiB，HTTP封装最大257KiB（覆盖旧版1000组最大安全整数ID及Unicode过滤器合法上界，不能因迁移新增上限清空仓库）。原仓库数组最大1000项且仍受总大小限制。

旧有效配置事务补 rules=[] 和默认过滤，revision 只增加一次；不恢复显式空列表，不将名称迁移为 ID 权限。旧客户端 PUT 缺少新增字段时，在同一 CAS 事务保留现有新字段；显式 rules=[] 才清空。完整新 UI 显示全部预设与自定义规则，说明二者 OR、取消预设不删除自定义规则，并保留冲突编辑供重新加载。旧无效/name-based 配置仍 fail-closed。

不存在模板、JSONPath、eval、任意字段路径或通知目标 DSL。

## 上游能力发现
分别持久化 App、已连接活动安装的 events、permissions，安装额外保留 repository_selection、suspended_at。验证 App/安装 ID 归属，只保留有界字段（最多256事件、128权限键），不保存 JWT、原响应或 OAuth 材料。
- fetchedAt 为最后成功读取时间，lastAttemptAt 为最近尝试，另有 expiresAt、retryAt 和受控错误码。
- 状态 fresh / stale / error / never；fresh+events=[] 才代表成功读取到明确空列表。缺字段或畸形响应不是空列表。
- 成功缓存5分钟；管理页提供显式刷新，GET能力接口按TTL读取/刷新；请求单飞，最短30秒间隔，失败指数退避至15分钟，并遵守有界 Retry-After 秒数。
- 失败保留旧数据及成功时间，标明 error；过期成功值为 stale；从未读取是 never。App/各安装独立，不因一项失败抹去其他结果。
- 安装结果在写回前核对现有 epoch/generation/身份标记，删除或撤销后的迟到结果不复活缓存绑定。
- **能力类没有修改授权的入口**。读取失败、快照缺失/陈旧/未列出事件均不否决 webhook、不丢积压、不延长授权。真正授权复验失败仍按既有机制 wait/deny。
- 动态候选取发现事件、已有配置、常用预设，新增候选不自动选择，不改本地监听。当前 fresh 快照未列出已配置事件时提示缺口，不静默删规则。
- events 不是所有潜在可开启类别，不含 action 全集，更不证明投递成功。action 用明确文本或常用预设。管理员仍须配置 GitHub App 上游订阅/权限并批准安装变化；本地选择不能授予这些权限。

官方依据：
https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app
https://docs.github.com/en/rest/apps/apps#get-an-installation-for-the-authenticated-app

## 普通、未知与控制事件
保留256KiB流式体积限制、5秒读取超时、content-type/encoding 限制、签名验证、SHA256 body全局去重及事务落库后ACK。payload 缺 action 与 null、显式空字符串不同：无字段允许匹配 [""]；null 或显式空拒绝。未来新 action 不自动匹配显式列表。

既有五类事件继续专用校验；已知结构畸形不降级。未知普通事件只在合法正整数 installation.id / repository.id、合法 repository.full_name、当前权限交集和显式规则全部满足时通用归一化。摘要仅仓库、事件名、action/固定文字、接收时间及有界 sender，不遍历 payload、不保留原 JSON、不把任意正文/URL灌给模型。链接只由本地构造 GitHub仓库地址。新普通类别无须新增 extractor 才能通知；丰富专用摘要可以另案增强。

无仓库或无安装的未知事件拒绝。ping、installation、installation_repositories、repository、github_app_authorization 保留专门路径。meta、membership、organization、org_block、team、team_add、personal_access_token_request、deployment_protection_rule 不开放普通订阅：这些类别不属于本功能当前普通仓库通知支持范围，包含非仓库范围和控制流程；拒绝不表示每一类都具有控制副作用。不采用无理由扩大的名称前缀禁令。新的安全敏感控制类型仍需安全审查；本功能不是“任何新控制能力都永不改代码”。

通用事件独立最多200条业务归档、最多20条未完成，quota=0，不占正常5000条收件额度；仍共享总200待执行上限，因此不可能填满正常待执行容量。未匹配/未授权事件只进原有有界控制/噪声辅助账本。满载503，不假ACK或淘汰已有待执行工作。终态保留和辅助去重TTL沿用原策略。

## 评论
- issue_comment：区分 issue / PR，PR标记必须是对象；构造 /issues/N 或 /pull/N#issuecomment-ID。
- pull_request_review：构造 /pull/N#pullrequestreview-ID，body=null 可为空，审核state是有界文本。
- pull_request_review_comment：构造 /pull/N#discussion_rID，不保存 diff_hunk、原始文件或代码。
- 校验数字对象ID、标题、作者ID/type及正文形状，采用 normalizeEvent 去控制/零宽字符并截断，title=200、summary=500、actor=120。上游 html_url 不参与链接。
- 作者来自 comment.user 或 review.user；sender 是操作人，两者不能混同。既有 excludeSenders 保持 sender 语义。
- excludeConnectedUser：按对应安装绑定的已连接 GitHub数值用户ID比较作者，不是 App 自身、不是 QQ用户、不是 login相似匹配；未知/不同ID不判 self。
- ignoreBots：仅作者 type==="Bot"，不猜测所有自动化账号。默认 false。
- 收据增加有界评论 subject/author元数据用于重新过滤。held/enqueued 在接收、重新授权、ready、claim继续复验；移除规则/收紧过滤会抑制未取得许可积压。已 started 的操作无法撤回，不作虚假承诺。
- 评论只作为外部资料进入现有限权事件回合，不能触发 shell、写文件、MCP写入、派子agent或授予权限。必须以宿主实际拒绝测试验证，不只检查工具名称或提示词。

## 调度与可观测性
每来源预算统计过去滚动60分钟创建的 event_run **批次**，queued/sent/silent/failed 均占用，不是评论条数、QQ消息条数或整点刷新。合并从最早待处理事件接收时间起算，不随新事件重置，每批最多10条；0是不主动等待，仍可被安静时段、预算、暂停或授权刷新延迟。GitHub预算满保留积压，额度释放后再处理。owner第一私聊固定路由和失败暂停保持。

收件/过滤/队列状态、Agent结果、QQ送达分开显示；ACK不是QQ送达，sent是Agent回合结果，缺少关联出站确认时明确“QQ送达未确认”。
主要过滤原因沿用 installation_not_authorized、repository_not_allowed、event_action_not_allowed、source_filter，并新增 comment_subject_not_allowed、comment_connected_user_filtered、comment_bot_filtered；generic_capacity 表示通用归档/待处理容量。能力状态/错误属于旁路诊断，不是这些过滤原因。

checkbox 使用专用 inline-flex label，输入固定自然宽度且紧邻标签；数字/时间字段保持原布局。全部自定义规则可见，发现候选不会覆盖未保存编辑。

## 验证和交付
- 独立安装依赖；真实 workerd 用合成 secret 生成 HMAC Request -> 实际 worker.fetch -> EventsDO SQLite归档/过滤 -> alarm -> owner ThreadDO。模型与外网用合成适配器，不能 mock 整条业务链。
- 覆盖三类评论、subject/action/作者过滤、旧配置及旧PUT/CAS/空列表、未知事件、签名/畸形/容量、能力空/失败/超时/新类别/矛盾/撤销迟到响应、授权失败wait/deny、claim前过滤变化、暂停控制撤销、既有批次/恢复回归。
- 用真实事件Code Mode尝试 shell、写文件、MCP写工具，断言宿主拒绝且副作用端点没有执行；不向真实QQ发送测试通知。
- UI往返、动态候选不自动启用、checkbox结构与真实浏览器合成页面布局检查。
- 本地 npm run check 全量通过后审查暂存区，再commit/push/PR；每次推送跟踪精确head远端CI终态。只授权PR，不merge/deploy。
- 不夹带 vars-sync 修改；下次部署仍存在既有变量持久化风险，需另案处理。
