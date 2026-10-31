# Cloudflare Workers 运行设计

本文件描述当前云端部署；迁移前的 Node / Pi 双后端和常驻容器实现已从代码中移除。入口、依赖和构建配置集中在 `workers/`。

## 1. 请求入口

`src/index.ts` 提供 `/healthz`、NapCat 反向 WebSocket、管理接口、媒体下载、MCP OAuth 与定时入口。所有路径在 Worker 内完成分派；管理数据和写操作必须鉴权。

## 2. 执行与恢复

会话执行基于 pi-durable。DO storage 保存执行状态和宿主业务表，R2 保存媒体与工作区 blob。恢复时不能把结果不确定的写操作当作未执行而重放；QQ 投递和工作区操作均保留稳定标识及回执。

## 3. 组件

### 3.1 BridgeDO

持有 NapCat 连接，处理消息路由、聊天目录、发送规则和投递账本。Bridge 不运行模型。回执未知时保留 unknown 状态，由后续核对处理，不能盲目重发。

### 3.2 ThreadDO

每个会话一份执行与上下文。owner 的私聊共享 owner 线程，群与其他私聊按各自键隔离。工具入口检查本轮发送者、触发种类、授权和目标范围。网页输入共享相应会话上下文，输出保留网页入口。

### 3.3 RegistryDO 与 RequestsDO

Registry 保存设置、人设、技能、授权与模型账号，管理更新使用 revision CAS。Requests 保存有界的模型请求明细与统计。私有凭据不进入页面、事件正文或日志。

### 3.4 后台执行

ScheduleDO 处理定时任务，EventsDO 处理 Gmail 等事件来源，SubagentDO 执行子任务。后台入口保留派出时身份，工具不能借后台执行扩大权限。每日维护在 UTC 19:30 触发，外部事件另有每 5 分钟的兜底触发。

### 3.5 Sandbox

`workers/sandbox/Dockerfile` 仍是线上组件。SandboxDO 经 `ctx.container.start()` 按需启动镜像，当前 instance 为 lite，空闲 3 分钟后停止。控制服务在容器内监听 3000，只有 DO 访问；命令降权到 uid 1000 执行。

`bash` 单次最长 120 秒。`/work` 从 R2 快照恢复，变更完成后提交新版本；文件上限和一致性协议见 [资产与持久工作区](CLOUD-ASSETS-CONTRACT.md)。停止运行时保留已提交的数据。该容器不运行旧 Node 主服务或旧观测面板。

### 3.6 外部连接

模型、Gmail 和 HTTPS MCP 由 Worker 发起请求。NapCat 与 CS2 Workshop 独立运行：NapCat 提供 QQ 协议接入；Workshop 通过鉴权 Tunnel 提供本机制作能力。它们的本体不在本仓库实现。

## 4. 构建与验证边界

Wrangler 使用生产配置打包 Worker，实际发布时构建并推送编码沙箱镜像。自动检查的 dry-run 禁止容器 rollout，不会发布线上资源。

测试包与应用在同一 `workers/`，不再依赖根目录 Node 源码或另一份 node_modules。workerd 测试覆盖业务、恢复、权限和接口；独立 Node 测试覆盖无法在 workerd 中运行的沙箱控制服务和本机助手。

DO 迁移列表属于线上 schema 历史，即使旧类已经移除也必须保留相应创建与删除记录。配置、secret 和上线核对见 [部署说明](DEPLOY.md)。
