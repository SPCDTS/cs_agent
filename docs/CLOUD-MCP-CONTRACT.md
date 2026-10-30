# 云端 MCP 与子 agent 契约

## 状态归属与预算

主线程复用现有 ThreadMcp 连接、目录缓存和队列；子 agent 只保存派出目录快照，通过父线程执行 MCP，不建立额外远端连接。资源目录沿用 catalogTtlMs 缓存；资源读取沿用 callMs、queuedPerConnection、messageBytes 和 catalogBytes 限额。

子 agent 默认并发 1、运行 10 分钟、最多 24 次模型请求。coding 只在派出能力包含 coding 时安装，通过父线程定位独立克隆工作区；容器按需启动，宿主应设空闲 3 分钟停止。子 agent 没有发送、鉴权、技能发布、记忆写入或继续派出子 agent 的工具。

## 父线程必须实现的接口

接口定义以 workers/src/mcp/delegated.ts 的 SubagentCapabilityHost 为准：

- validateSubagentAccess(id)：核验父 scope、当前会话 generation、取消状态和当前授权，返回 authority 与有效 capabilities。
- subagentMcp(id, call)：先重核身份，再调用同一 ThreadMcp.invoke；call 只有 name、args、operationId，snapshot 必须从父持久登记读取，不能使用模型提供的数据。
- subagentSkill(id, input)：核验后读取当前已启用技能，不允许发布。
- subagentCoding(id, operation)：核验后调用该子 agent 独立工作区，不可路由父工作区；operationId 是持久操作标识。

派出时调用 captureCapabilities(authority)，把结果放入 SubagentStart.capabilities.mcp；coding 能力只能由宿主设置。snapshot 的 catalogJson 是有界目录 JSON，避免递归 JSON 类型扩大 DO RPC 类型和序列化成本。每次业务调用核验当前身份和授权，目录快照只缩小权限，不能扩大权限。

McpAuthority 必须由宿主构造，包含 kind、scope、actor、owner、generation 和 replyChannel。旧 owner-private 回调返回 TurnKind 仍可使用；群、网页与子 agent 应使用完整对象。网页来源的 replyChannel 必须保持 web，不能由审批、子任务或模型改成 QQ。

## 资源与图片

Notion 资源仅允许 notion://docs/ 前缀，并且 URI 必须在远端资源目录或模板内。resources/list、resources/templates/list、resources/read 使用同一授权和连接队列；资源 URI 不是任意网络抓取入口。

resources/read 的图片 blob 同样转原生图片；其他二进制资源写入当前 scope 的私有 R2 资产，返回 AssetRef 元数据，下载复用既有鉴权媒体入口。只有显式读取二进制时才发生这次 R2 写入。

MCP 图片作为原生 image content 返回，允许 PNG/JPEG/WebP/GIF，单张最多 4 MiB、最多 4 张，总响应仍受 messageBytes 限制。图片只作为已有 MCP 结果，不提供生图工具。文本输出最多 8000 字；凭据继续仅由 Registry 获取，不传给模型或子 agent。


## 群授权与逐次审批

ThreadMcp 构造第六参传 {scope: threadNs}。群默认没有任何 Notion 工具；宿主通过 setAccess(scope, server, input, expectedRevision, reviewerAuthority) 保存明确的工具、资源前缀、成员与到期时间。工具只能来自静态 allow，资源前缀只能缩小静态 resourceAllow。只授予授权表中的工具可见性，调用前再次检查当前授权。

MCP 配置的 tools.readOnly 是宿主维护的只读清单，不相信远端自行声明。群成员使用 owner 账号执行清单外工具时，每次产生独立审批；owner 本人也必须具有群工具 grant，但不需要审批自己的账号写入。事件回合不会借群授权调用 MCP。

审批绑定 actor、scope、generation、replyChannel、server/tool contract、参数摘要、operationId 和 10 分钟有效期。批准只执行已保存的确切参数；HTTP 批准接口不接收新参数。重复同一操作返回回执；已执行但结果不明的请求只返回 outcome_unknown，不重新调用远端。拒绝、过期及授权变更使请求失效。原生图片保留在原调用结果中，SQLite 回执只保存文本摘要，避免重复存放图片造成套餐写入膨胀。

主 runtime restore 时执行一次 recoverInterrupted，将 executing 账本标记 unknown；普通管理查询或 grant 读取不会执行恢复。reviewApproval(scope,id,decision,reviewer,current) 中的 current 回调由父宿主重新核验原 actor 和当前 generation，子 agent 还须核验登记与取消状态。回复入口必须与审批保存的入口一致。审批结果默认仅在网页面板与原工具回执可见，不主动向 QQ 发通知。

管理 HTTP 工厂为 createMcpAdminRoutes(resolve)，对应接口定义在 workers/src/admin/mcp-routes.ts 的 McpAdminRpc。它应安装到现有 Bearer 鉴权路由内；Thread RPC 还须核验自己实际绑定的 scope。管理审批仅提供 approve/reject，不允许改写工具或参数。


## 管理页装配

从 workers/src/admin/mcp-ui.ts 导入 MCP_ADMIN_HTML 与 MCP_ADMIN_APP_JS。把 HTML 放入管理视图，把 APP_JS 放到现有管理脚本 IIFE 的公共 helper 定义之后；它复用 api、el、readToken、show、fail、time，不新增定时器或轮询。线程列表通过“加载线程”读取 overview，授权和审批通过按钮或选择线程手动刷新。固定参数用只读文本显示，批准接口只接请求 ID 和动作。

Thread 需要实现 McpAdminRpc 的 mcpAccess、mcpSetAccess、mcpApprovals、mcpReviewApproval；签名以 workers/src/admin/mcp-routes.ts 为准。创建 ThreadMcp 时必须把 namespace 放入第六参 {scope: ns}，否则无法按本线程 grant 限制可见目录。非 owner 线程没有有效工具或资源 grant 时，refreshAll 直接返回 denied，不创建远端连接；保存非空 grant 后，宿主按需 refreshAll 一次即可恢复目录。
