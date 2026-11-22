# Agent 通信 MVP

## 身份与接口

运行时注入 agentSessionId：主会话为 owner、group:<群号> 或 private:<用户号>；子会话为 sub:<父会话>:<子 ID>。模型只可调用 agent_send({to,text?,files?})，不能指定来源、用户身份、权限或消息 ID。回复仍用 agent_send。

消息 ID 从来源、会话代次和工具调用 ID 稳定生成。同次调用重放复用原文件快照；accepted/duplicate 只表示原收件箱已收下，不表示已读或任务完成。通信不新增 cancel/wait/delegate/steer 或任务状态机。

## 控制入口（默认关闭跨会话通信）

部署环境变量 AGENT_COMMUNICATION_EDGES 是 JSON 有向边列表，例如：

```json
[["owner","group:200000001"],["group:200000001","owner"]]
```

仅由有部署配置权限的操作者在现有 Worker 配置入口设置；不接受通配符，不读取或复用 QQ send grant。不设置则拒绝所有跨主会话通信。双向通信需两条边。群内所有已可使用该群 Agent 的成员共用群会话身份；不是仅对配置者或某次发言人放行。QQ 群准入及触发规则仍独立生效。

已登记且未撤销的父子会话边使用既有派出关系，无需配置额外边。会话重置使旧来源证明失效。接收主会话需已有当前代次的本地用户上下文，否则返回 agent_recipient_not_ready；不会由陌生通信创建带权限的新会话。

本改动未设置任何生产环境变量。示例群号仅用于说明与测试；启用实际群必须由获授权操作者另行配置和发布。

## 权限与输出

Thread 使用既有 inbound，Subagent 使用既有 inbox，执行仍经 root.submit，忙时固定 followUp；不创建第二套收件箱。旧 subagent.message 与自动结果汇报使用相同通信服务，spawn/cancel/list 生命周期入口保留。

通信入站使用独立 kind=agent、空 user_id 及可追踪来源，不伪装成 owner 输入。接收方 coding/MCP 继续解析接收方当前已绑定的本地授权上下文，并复核原任务权限；不继承发送方权限、不写入新 grant。子代理不会因追加消息的发言人变化而改变既有派出权限。

需要用户本人输入的管理、写记忆等操作仍受原入口限制；Agent 回合只能只读本会话记忆。普通 send_message/send_file 不能把 Agent 回合输出发往 QQ/网页。自动子任务结果仍通过原报告格式交回父任务，不会直接通知 QQ。

## 文件

files 是发送方自己已授权工作区的路径列表，最多 5 个，单次总量不超过 10 MiB。宿主读取字节并冻结为来源 R2 资产；接收端验证来源证明和完整资产引用、哈希、大小，复制到接收 scope，然后经既有 saveAttachment 的 createOnly、manifest/CAS 路径持久化到 /work/agent-files/<消息哈希>/。只在持久提交成功后入箱，目标可用既有 read 读取。不能用裸跨 scope asset ID 或发送方路径代替副本。

登录凭据禁止转发。已知凭据文件名和凭据文本模式在完整内容上检查，不先截断；模式检查不是对任意编码/加密文件内容的万能识别，模型仍须遵守不传凭据的约束。

## 验证边界

本地测试使用 workerd/SQLite/R2 测试环境、faux 模型；工作区持久化用真实 WorkspaceManager/manifest/CAS，容器客户端使用测试夹具。它们验证源码链路，不等于真实 Cloudflare 容器、真实账号或线上群部署验收。发布前还需独立审查，并在另行授权的环境验证双方实际 read 文件及无 QQ 外泄。当前不得宣称线上可用。
