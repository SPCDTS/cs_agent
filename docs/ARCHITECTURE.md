# cs-agent 架构

应用统一运行在 Cloudflare Workers。旧 Node 主服务、Codex app-server 后端、观测后台和 Gmail 侧车已移除，当前入口为 `workers/src/index.ts`。

## 消息与执行

1. 独立 NapCat 经 `/onebot` 反向 WebSocket 连接 BridgeDO；Bridge 校验身份、触发条件和作用域，记录消息并路由到 ThreadDO。
2. 每个会话的 ThreadDO 运行 pi-durable，组合人设、记忆、技能与工具。模型调用由 Registry 中的账号和模型配置决定。
3. QQ 回复经 Bridge 的发送账本与限速规则投递；管理台网页续聊共享相应会话上下文，网页回复留在网页。
4. 子任务在 SubagentDO 中运行，定时任务由 ScheduleDO 调度，外部事件由 EventsDO 处理。

## 身份与权限

每轮执行绑定触发时的身份、会话和入口，工具不能通过模型传入的 QQ 号、namespace 或路径取得额外权限。owner 账号来自 `QQ_OWNER`。跨目标发送、群 MCP 授权和写工具审批分别检查。

子任务保存派出时的身份快照，使用能力时仍检查当前授权；不把后来到达的其他人的消息当作派出者授权。群或其他私聊的上下文读取范围以当前线程为准。

## 状态与存储

| 组件 | 责任 |
| --- | --- |
| BridgeDO | NapCat 连接、聊天目录、发送与回执 |
| RegistryDO | 设置、模型账号、技能、人设及授权 |
| ThreadDO | 会话执行、聊天记录、记忆与工具状态 |
| RequestsDO | 模型请求明细和统计 |
| ScheduleDO / EventsDO | 定时、外部事件和投递状态 |
| SubagentDO | 子任务执行与汇报 |
| SandboxDO + R2 | 按需编码容器、工作区版本与文件 |

## 外部服务

模型和 Gmail 由 Worker 直接请求；MCP 由云端客户端连接远程 HTTPS 服务。CS2 Workshop 本体在独立项目，本仓库仅提供本机 MCP / Tunnel 接入。编码工具仍需 Cloudflare 容器，由 `workers/sandbox/Dockerfile` 构建。

具体边界见 [Workers 运行设计](WORKERS-DESIGN.md)、[权限与发送](CLOUD-ACCESS-CONTRACT.md)、[资产与工作区](CLOUD-ASSETS-CONTRACT.md)、[MCP 与子 agent](CLOUD-MCP-CONTRACT.md)。管理入口见 [管理台](ADMIN-CONSOLE.md)。
