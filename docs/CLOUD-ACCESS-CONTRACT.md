# 云端权限、发送与运维接口

本切片以 Bridge 为 QQ 唯一发送事实源，Registry 保存授权、persona、技能 CAS 和运维配置。以下 RPC 均为 Worker 内部接口，模型只能调用 Thread 安装的工具；管理 HTTP 必须经现有 Bearer 鉴权。

## 发送与恢复

`Bridge.deliver({ id, operationAt, runId, target, text, atUserId?, attachments?, source })` 返回 `{ id, state, payloadHash, createdAt, updatedAt, messageId?, error? }`。

- `operationAt` 必须使用宿主持久保存的操作创建时间（毫秒），重试不得改成当前时间。新操作只接纳最近 30 天且大于持久拒绝水位的时间；已存在 ID 仍返回原回执。
- `id` 必须稳定，例如 `thread/generation/taskId`；同 ID 不同载荷抛 `delivery_payload_conflict`。同 ID 重放只读取已有账本，不重复发帧。
- `source = { thread, inputId, generation, scope }`。`thread` 是 namespace（可以是 `owner`），`scope` 是真实 QQ 来源地址，如 `private:12345`。
- Bridge 在每次 queued 实际发送前调用 `Thread.validateDeliverySource(source, target)`；宿主必须从持久 input 验证 QQ 回复入口、当前 generation 和当前跨目标授权。缺 RPC 或验证失败均拒绝发送。
- 状态为 `queued / sending / sent / unknown / failed / rejected`。发帧前同步保存 sending、echo、连接 ID。重建把 sending 改成 unknown；unknown 永不自动重发。迟到回执仍可按持久 echo 结算。
- 同一 `runId + group` 串行发送，只有首条携带群 @；unknown 保留 @ 占位，明确失败释放占位。
- `delivery(id)` 查询发送事实，`deliveryList({ state?, limit? })` 查询最近账本（最多 200）；Thread 可在 RPC 中断后查询 sent 回执，修补自己的 outbox 投影。
- `reconcile(id)` 只读调用 `get_group_msg_history / get_friend_msg_history`。只有本人、目标、时间窗口、完整消息段、平台消息 ID 和唯一匹配都成立才认定 sent；附件与含糊匹配继续 unknown。
- `cancelQueued({ thread, generation })` 将旧代次 queued 结算为 rejected，保留 ID/hash 墓碑。正文/附件/echo 默认保留 30 天，随后只保留小回执；小墓碑最多 90 天且全部发送记录硬上限 5000 条。回收 ID 前原子推进 minimumOperationAt 水位，回收后重放旧操作只能拒绝，不能重新发送。离线 queued 上限 200，超过 30 天的 queued 拒绝并清除正文。
- `send(target,text,at?) / sendPrivate(userId,text)` 保持旧接口，内部建立独立 intent。`systemDeliver(input)` 是定时、事件、告警等已授权后台路径，不能向模型暴露。

## 附件与 QQ 查询

`attachments` 只接收媒体仓库返回的 AssetRef：`{ id, scope, sha256, bytes, mime, name, kind }`，不得传模型 URL 或本地路径。Bridge 核验 `asset.scope === source.thread`，重新读取私有 R2 对象验证元数据与摘要，再生成限定对象、5 分钟有效的下载票据。

- 图片、音频、视频可与文字组成单条 QQ 消息，分别映射 OneBot image、record、video 段。
- 文件使用 `upload_group_file / upload_private_file`，每个文件必须是独立 intent，不能同时携带文字、其他附件或 @。Thread 应按 `taskId:file:assetId` 分拆。成功上传 ACK 可能没有 messageId，此时 sent 事实保留，但不能伪造 QQ 消息 ID 写 outbox。
- `chats(refresh?)` 返回好友与群 `{ target, name }[]`，缓存 5 分钟；`getMessage(messageId)`、`getHistory(target,count)`（最多 100）、`getForward(id)` 是媒体层只读接口。缺少远端 URL 时，`getFileUrl(target,fileId,busid=102)`、`getImage(file)`、`getRecord(file)`、`getFile(file)` 仅提取 NapCat 返回的 HTTP(S) URL，不把本地缓存路径伪装成云端可读地址；后续下载仍受媒体仓库来源/大小校验。参数依据 [NapCat 官方示例](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/example/FileActionsExamples.ts)。读取授权仍须由源 Thread 与目标 Thread 核验，send 授权不蕴含历史读取权限。

## 授权与配置

Registry RPC：`grantsList()`、`grantPut(input,actor)`、`grantRevoke(input,actor)`、`canAccess({ user, cap, scope, target? })`。actor 为宿主确认的 `qq:<id>`；写授权时再次与 secret QQ_OWNER 比较。

- grant input 保持旧 `auth_grant` 形状：`user, caps:['send'|'schedule'], targets?, scopes?, expires_in_hours?`。revoke 为 `user,caps?`，省略 caps 撤销全部。
- `scopes` 省略允许所有来源，空数组不允许任何来源；send 的 targets 必须明确命中，schedule 不要求 send target。每次查询重新读取授权，撤权立即生效。
- `importGrants({ datasetId, sourceHash, schemaVersion:1, dryRun, grants })` 先 dry-run。导入保留旧 created_at、updated_at、expires_at；已有用户或撤权墓碑一律 preserved。已提交 receipt 重放不再次写入。
- `persona() -> { text, revision }`，`setPersona(text,expected) -> {ok:true,value}|{ok:false,conflict}`；与 memory profile 独立。
- `skillRevision(name)` 查询技能修订；`skillPublish(input,expected|'absent')` 原子 CAS。旧 skillPut/delete/enable 接口会递增独立修订，防止相同正文的 ABA 覆盖。调用人的 owner/管理员身份由 Thread 工具宿主核验。

`opsSettings() -> { value, revision, updatedAt }` 和 `putOpsSettings(value,expected)` 独立 CAS，不影响旧 runtime settings 行。

```ts
type OpsSettings = {
  sendLimits: { perChatMinute:number; perChatHour:number; chatBreakerMinutes:number; globalMinute:number; globalBreakerMinutes:number };
  alertOwner:boolean; alertThrottleMinutes:number; ownerAlertThrottleMinutes:number;
  defaults:{ rawDays:number; rawHardMaxDays:number; summaryDays:number; eventsDays:number; consolidate:boolean };
  threads:Record<string,Partial<OpsSettings['defaults']>>;
};
```

默认发送额度为每会话 6/分钟、60/小时、全局 30/分钟，熔断为 60/10 分钟；alertOwner 默认 true；告警种类+会话间隔至少 10 分钟，owner 私聊通知至少间隔 30 分钟。保留期沿用环境默认值（30/90/365/30 天，0 不清理），整理默认开启。`threadOpsSettings(value,thread)` 得到合并后的线程维护参数。

## 告警与管理接线

- Thread 每次回合结算调用 `recordTurn({ scope, origin:'qq'|'web', outcome:'ok'|'failed'|'auth_failed' })`。鉴权失败立即开 episode，连续三次失败开失败 episode，成功结算 episode。网页来源只进入面板。
- `recordAlert({ kind:'model_auth'|'model_failures'|'qq_disconnect', scope, episode, origin, message })`、`resolveAlert(kind,scope,origin)` 和 `alerts(limit?)` 用于状态所有者上报及面板。
- Cron 调用 `Bridge.tick()`（最多恢复 20 个 queued、清理/压缩 100 行）检测 QQ 断线超过 5 分钟并恢复 queued；调用 `Registry.opsTick()` 发送仍有效的告警。离线期间留面板记录，重连关闭旧断线 episode，并生成恢复摘要。通知复用稳定 systemDeliver intent，unknown 不换 ID 重发。
- 管理路由通过 `...accessRoutes()` 注册到既有 ADMIN_ROUTES：persona、grants/import/revoke、ops-settings、alerts、deliveries/detail/reconcile、skills/revision/publish。工厂自身不包含 public 路由。

## 验证与边界

`access-parity.test.ts` 使用真实 Worker SQLite 与 WebSocket 验证稳定 ID 防重、冲突、发送前持久化、unknown、迟到回执、群 @、旧代次取消、唯一历史查证、撤权、增量导入、persona/skill/运维 CAS、网页告警隔离及持久节流。Thread 的真实来源验证、工具和管理页面接线由集成切片补齐。


## 套餐核算用开销清单

以下为代码路径的逻辑调用量，不是平台账单实测，也不包含 root Thread、模型、沙箱和资产本身的保留开销。

| 路径 | 新增调用与存储 |
| --- | --- |
| 普通 QQ 发送 | Bridge RPC 1；Registry.opsSettings RPC 1；可信来源验证 Thread RPC 1（授权跨目标时再由 Thread 查 Registry）；WebSocket 请求/回执各 1 帧；SQLite 约 20～30 条小查询/更新（另加已有 SendRules），selfId KV 读取 1 次 |
| 重复 operation ID | Bridge RPC 1、索引读取账本 1 次及摘要计算；不查权限/额度、不读 R2、不发帧 |
| 每个出站资产 | R2 get 2 次（核验 + 签发票据复核）、票据 put 1 次；NapCat 下载触发票据 get + 资产 get；不在模型历史保存 URL |
| 空闲 Bridge.tick | 一次 Bridge RPC；3 个带时间范围/状态索引的有界清理选择、最多 100 行写入；一页最多 20 个 queued；无队列时不访问 Thread/Registry |
| 空闲 Registry.opsTick | 一次 Registry RPC、读取 ops 设置及最多 10 个待告警；没有待告警时不访问 Bridge；unknown 通知不定时重查/重发 |
| 回合成功/失败结算 | Registry.recordTurn RPC 1；成功删除计数并关闭两类 episode，失败读取/更新一条计数；只在首个鉴权错误/第三次失败时写告警 |
| 管理界面 | 仅手动加载/刷新；不轮询、不添加定时器 |

总发送记录硬上限 5000，完整正文每条最多 4000 字、资产引用最多 10 项，正文最长 30 天；压缩记录只保留 ID/hash/state/时间/消息 ID 等小字段。群 @ 占位随其发送记录回收。通用告警最多 500 条，每条正文最多 1000 字；列表最多 200，Cron 待通知最多 10。授权、导入回执与配置仅在显式管理操作时增长，没有每回合复制数据。

容量回收会使较旧的新操作被拒绝，即便它从未成功发送；这是达到硬上限后的安全退路。不能把重试的 operationAt 改成当前时间来绕过拒绝水位。超出正文保留期的 unknown 保留状态并注明 evidence_expired，不再尝试内容查证。

## 容器预算硬限

`Registry.reserveContainerBudget(workspace)` 仅由 Sandbox 在冷启动前调用，返回 `{ expiresAt }`。每次固定预留 5 分钟，全项目按 UTC 日最多 120 分钟，同时最多 2 份有效预留；同 workspace 在有效期内幂等返回原到期时间。配额不返还，超额抛 `container_budget_exceeded`，并发上限抛 `container_budget_busy`。一次 KV 事务只读取/写入一个小 JSON，最多两条有效预留。容器宿主必须在 expiresAt 前关闭容器；有效预留不授权无限延长热容器运行。

## 管理面板片段

`admin/access-ui.ts` 导出 `ACCESS_HTML` 和 `ACCESS_APP_JS`：HTML 放在管理视图内，脚本放在现有 ADMIN_APP_JS 的 IIFE 末尾，复用 `$ / api / el / show / fail / time / ApiError`。片段首次插入不会请求数据，点击“加载 / 刷新”后读取五组数据；各列表也可单独刷新。人格和运维保存带当前 revision，409 时保留编辑内容并提示手动刷新。没有定时刷新或轮询。轻量 DOM 主流程已核对加载、人格 CAS、运维 CAS、授权与含斜线 operation ID 的查证路径；浏览器整体布局由集成后统一确认。

## 宿主工具与定时撤权

`createAccessExtension({ allowManage, registry, bridge })` 安装 qq_chats、auth_list、auth_grant、auth_revoke。allowManage 每次执行必须重新查当前持久输入，仅允许 owner 私聊交互消息或鉴权 owner 网页，并返回真实 `qq:<owner>` actor；群消息和子 agent 不能借用此入口。聊天目录默认最多 50 项（可限 100、按 query 过滤），授权列表最多 100 项，完整目录在面板查看。

ScheduleDO.listFor(conversation,actor) 和全部管理写入再次核验有效 schedule grant；普通授权用户只能管理由自己创建的同会话任务，owner/admin 可管理当前会话全部任务。后台触发前重新核验 created_by，失效即暂停、标注 authorization_revoked 并跳过投递。owner/admin 仍按 secret 身份正常运行；admin 网页创建任务时保存对应 QQ owner 为 created_by。非 owner namespace 不自动注入其他创建者的任务摘要，模型可通过自己有权调用的 list 查询。
