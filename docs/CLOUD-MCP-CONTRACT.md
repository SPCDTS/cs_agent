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

MCP 图片作为原生 image content 返回，允许 PNG/JPEG/WebP/GIF，单张最多 4 MiB、最多 4 张，总响应仍受 messageBytes 限制。图片只作为已有 MCP 结果，不提供生图工具。文本输出最多 8000 字；凭据继续仅由 Registry 获取，不传给模型或子 agent。
