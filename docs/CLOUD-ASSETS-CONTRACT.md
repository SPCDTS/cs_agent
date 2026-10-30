# 云端资产与持久工作区接口

本协议的所有作用域都由宿主授权层决定，模型不能指定 R2 key、任意 namespace 或 NapCat 下载地址。R2 绑定为 `ASSETS`，所有对象位于 `cs-agent/v1/`。

## 私有媒体与出站附件

`workers/src/media/repository.ts` 导出 `AssetRef`：`{id,scope,sha256,bytes,mime,name,kind}`，`kind` 为 `image | file | audio | video`。单资产最多 10MiB。

- `new MediaRepository({bucket: env.ASSETS, scope})` 固定本次访问范围。
- `put({bytes:Uint8Array,name,mime?,kind?})` 保存二进制并返回引用。
- `get(id)` 返回 `{ref,bytes}`，验证作用域、大小与 SHA-256。
- `importRemote({url?,name?,kind})` 经公网地址、每跳重定向和流式大小检查后保存。
- `issueUrl(id, PUBLIC_ORIGIN, ttlSeconds=300)` 返回 `/media/object?token=...`。票据为随机单对象凭据，最长 600 秒，不包含管理员口令、原始 scope 或资产 id。Bridge 必须先校验引用的 scope 等于已授权来源 namespace；跨会话发送另由授权层批准目标，再签发。

`handleMediaRequest(request,{bucket,authenticateAdmin})` 供 index 接线，未命中返回 `undefined`。`GET /media/object?token=...` 使用对象票据；`POST /media/assets/:scope?name=...&kind=...` 上传原始 body、`GET /media/assets/:scope/:id` 下载都要求管理员认证。浏览器使用带 Authorization 的 fetch 获取附件，不能把管理员口令放 URL。响应均禁止缓存、嗅探并使用附件下载。

Bridge 出站只接受可信宿主解析后的 `AssetRef[]`。图片使用 `{type:'image',data:{file:await repository.issueUrl(ref.id,origin)}}`；音频为 `record`、视频为 `video`。普通文件经 OneBot 的 `upload_group_file` 或 `upload_private_file` 独立发送；它们不保证返回 message_id，发送账本必须允许该成功回执缺少消息号。

## 入站、历史与工具工厂

`InboundInput.media?: InboundMedia[]` 保留 `kind,ordinal,url?,file?,fileId?,name?,size?`。这些引用是不可信平台元数据，下载仍经过有界检查。`parseFrame` 对上传/撤回返回 `kind:'notice'`；上传带 `notice:{kind:'upload',input}`，撤回带 `notice:{kind:'recall',target,messageId,userId,selfId,time}`。上传只记录上下文，不自动授予模型触发权限；撤回保留审计并标注为已撤回。

`recallMedia(database,scope,messageId)` 只读取指定范围的历史引用；`markMessageRecalled` 标注撤回。媒体表独立创建，不改既有 messages schema。`recall` 输出中保留消息号与附件摘要，便于按 id 召回。

`createMediaExtension(deps)` 注册 `qq_image(message_id,ordinal?)`、`qq_attachment(message_id,ordinal?)` 和 `send_file(path,name?)`。依赖包括 `allowed(api,context)`、`repository(api,context)`、`lookup(messageId,api,context)`、`sandbox(api,context)`、`deliver(ref,api,context)` 以及可选 `record(kind,detail)`。lookup 必须验证当前访问范围，再读历史或让 Bridge 取原消息。repository 已锁定 scope。deliver 保留原始 web/QQ 回复入口。图片直接返回模型 image content；非图附件返回私有引用和元数据，不能伪装成已解析正文。

## 持久工作区

SandboxDO 的容器只是 `/work` 的临时物化视图。R2 保存不可变 manifest 和按 SHA-256 去重的二进制 blob，DO storage 只保存当前 head、epoch 和操作账本。

- `run({operationId,operation})` 串行执行，操作为 `exec/read/write/edit`。返回 `status:'committed'|'failed'|'unknown'` 与 `persistence` 和 `revision`。同一 id 不同参数拒绝，已执行中断的 bash 返回 unknown，绝不重跑。
- `exec/readFile/writeFile/editFile/list` 保持旧接口；exec options 和 write/edit 可选传入 operationId。工具宿主应使用稳定 taskId。成功的 write/edit/exec 必须完成 checkpoint；持久化失败明确报错并丢弃未提交的容器视图。
- `files(revision?)`、`snapshot()`、`listAssets(revision?)` 返回 `WorkspaceManifest`，包含 `schemaVersion,workspace,revision,parentRevision,files,directories,totalBytes`。
- `readBlob(path,revision?)` 从已提交版本返回 `{bytes:Uint8Array,mime,name}`，无须启动容器。skill_publish 应先 snapshot 一次，再固定 revision 逐文件读取，不能多次读变化中的目录。
- `exportAsset(path,scope,name?)` 将已提交文件导出为指定合法范围内的 `AssetRef`。
- `importSnapshot({manifest,expectedRevision,paths?})` 验证源 blob 并复制，CAS 发布。paths 为显式选择的文件路径，源中不存在的已选文件代表删除。
- `cloneFrom({sourceName,expectedRevision,sourceRevision?})` 克隆父版本；`mergeFrom({sourceName,expectedRevision,paths,sourceRevision?})` 选择文件合并。返回 `{ok:true,manifest}` 或 `{ok:false,conflict}`。这些是受信宿主 RPC，禁止直接向模型暴露任意 sourceName。
- `resetRuntime()` 与兼容的 `reset()` 只销毁容器，保留 durable 工作区。新 DO 实例先销毁旧容器再恢复，epoch 在每次执行和替换时递增，拒绝旧执行提交快照。

单文件 10MiB、工作区 50MiB、文件和目录各最多 20000；拒绝符号链接、设备、越界路径、冲突路径。quota 响应包含逐项 issues，绝不截断后冒充成功。manifest 中删除的文件在下一次恢复消失。`gc(options)` 默认 dry-run，保留当前 head、1小时传输租约、当前版及最近2份历史（并保护1小时内的新版本）；仅清理宽限期之后的孤立blob，单批最多500对象。扫描超过1000份manifest或1000个blob时返回deferred且不删除，供管理员单独维护。read不写持久结果；最近32个变更操作保留详细结果，小结果直接存DO，大于32KiB的结果才写R2。更旧操作压缩成稳定tombstone，不重放。`gcMediaTickets(bucket,{limit,cursor,dryRun})` 支持过期短票据分页清理。

## 离线迁移

`scripts/workspace-export.mjs` 只读扫描本地目录，默认 dry-run 输出 JSON manifest 与分类报告，超限和生成 frames 单独列出，不从 7194 个文件或 763MB 中静默截取工作集。显式指定 `--select` 相对路径列表后才计算选定用户文件的hash；frames、node_modules等生成缓存始终排除。`scripts/workspace-import.mjs` 仅在显式传入目标 workspace 与expected revision后生成R2上传key和CAS导入计划，不发送网络请求、不修改生产。执行迁移需由独立宿主流程审核计划，再上传选定blob并调用importSnapshot。

## 默认资源开销

工作区默认上限50MiB、单文件10MiB、容器空闲3分钟停止。普通write/edit只对内容变化的文件各写一个R2 blob，再写一份manifest；小于32KiB的操作结果直接存DO。bash未改变文件时不创建新manifest或blob。read不产生R2写入，也不建立持久操作账本。冷恢复需要读取一份manifest及其文件blob；热工作区只读DO head与manifest。历史维护默认保留head加最近2份历史，短期传输租约仍受保护。详细操作结果最多保留最近32条，更旧结果压缩为不会重放的tombstone；每个tombstone仍占少量DO存储，因此长期超高频使用应按会话分代保留幂等边界。

## Thread接线辅助

`lookupHostMedia({database,bridge,source:{scope,namespace,target},messageId,selection?})` 位于 `tools/media-host.ts`。source由宿主从已验证回合构造；scope是物理QQ会话（例如private:QQ），namespace是Thread与资产范围（owner私聊可为owner）。它只查询本scope的media；旧消息缺引用时，必须先在本scope找到原消息，才调用Bridge.getMessage，并核验返回的群或私聊目标。文件ID按该source.target调用getFileUrl，图片/语音/视频分别调用getImage/getRecord/getFile。函数不下载文件，返回URL仍经MediaRepository的受限下载。

`MediaDeps.lookup`第四个可选参数是 `MediaSelection`（kind/ordinal）；root可原样传给helper，使筛选在NapCat RPC之前发生，单次最多解析5个附件。source.namespace由宿主绑定repository，不能由模型提供。

## 容器按需运行

沙箱按 lite 规格按需启动，不设置每日累计时长、单次容器寿命或全项目容器并发配额。保留 3 分钟空闲自动停止；连续使用时不会因运行满 5 分钟被终止。文件事实源留在 R2，空闲停止或手动停止不删除已提交工作区。

## 工作区技能发布与管理接线

`createWorkspaceAdminExtension({allowed,sandbox,registry})` 注册 `skill_inspect(path,name?)` 与 `skill_publish(path,name?,workspaceRevision,expectedRevision)`。allowed只能由宿主核验owner本人私聊或owner网页入口后返回true，子agent不继承。sandbox绑定当前已授权工作区；registry只暴露skillRevision与skillPublish。inspect返回固定workspaceRevision和当前技能expectedRevision（不存在为absent），publish参数二者都必填。每次读取只取一份manifest，再按同一revision读取目录；UTF-8、路径、SKILL.md和附件大小先校验，再调用parseSkill与Registry CAS。不能把ADMIN_TOKEN放进模型参数或提示。

`createWorkspaceAdminApi({authorize,current,child})` 提供list、download({path,revision})、resetRuntime、inspectChild({childId})与mergeChild({childId,expectedRevision,sourceRevision,paths})。child是受信宿主回调：先验证当前访问者是owner，再确认子任务parentThread、origin与generation属于当前会话，才返回内部sourceName和其sandbox。子工作区检查一次返回{childId,parent,source}；合并固定父expectedRevision与子sourceRevision，路径必须明确选择，未出现在子快照中的已选父文件代表删除。resetRuntime只停止容器，保留manifest和文件。

Thread建议提供workspaceFiles、workspaceReadBlob({path,revision})、workspaceResetRuntime、workspaceInspectChild({childId})、workspaceMergeChild({childId,expectedRevision,sourceRevision,paths})五个已验证宿主RPC，映射到上述API。HTTP侧使用workspaceRoutes({forThread})，挂在统一handleAdmin鉴权之后；forThread把已认证owner网页身份传给Thread，不能仅依据URL里的thread参数授予跨会话权限。

管理页面拼入WORKSPACE_CSS、WORKSPACE_HTML和WORKSPACE_APP_JS；APP_JS放在已有api/readToken/describe闭包里。路径为GET /admin/threads/:thread/workspace、GET .../workspace/file?path=&revision=、POST .../workspace/reset-runtime、GET .../workspace/children/:childId、POST .../workspace/merge。所有按钮都手动触发，没有轮询；下载通过Authorization请求获取blob，不把口令放URL。发布技能的inspect/publish工具使用独立宿主权限，不借用管理面板口令。
