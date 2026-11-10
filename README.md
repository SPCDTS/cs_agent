# cs-agent

基于 Cloudflare Workers 的 QQ / 网页 agent。会话、授权、定时任务与记忆由 Durable Objects 管理，媒体与编码工作区存入私有 R2。应用代码和依赖统一位于 `workers/`。

## 开发与验证

需要 Node.js 24+。在仓库根目录运行：

```sh
npm run install:workers
npm run check
```

`check` 顺序执行类型检查、单 worker 的 Workers 测试、独立 Node 测试和 Worker 打包检查，不发布服务。测试使用模拟模型、NapCat 和外部接口。依赖分别由 `workers/package-lock.json` 与Windows MCP 服务的 `runner/package-lock.json` 固定；根目录 package.json 只提供命令入口。`check` 也检查 runner 并构建 guest 执行器。

Cloudflare Container 保留原生 coding 工具与源码持久化，其他远程环境通过通用 MCP 接入，并继续由 Code Mode 调用。`runner/` 提供 Windows MCP 服务：Hyper-V VM 是持久工作区，WSB 是没有宿主项目映射的临时隔离沙箱。见 [设计](docs/REMOTE-SANDBOX-DESIGN.md) 和 [Windows MCP 接入](docs/WINDOWS-MCP.md)。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 本地 Wrangler 开发服务 |
| `npm run typecheck` | Workers 类型检查 |
| `npm test -- --maxWorkers=1` | workerd 中的业务测试 |
| `npm run test:node` | 沙箱控制服务、登录助手和技能导入测试 |
| `npm run build` | 不发布的 Worker 打包检查，不构建容器镜像 |
| `npm run deploy` | 发布 Workers 及编码沙箱镜像，需要显式部署授权 |

## 目录

| 目录 | 内容 |
| --- | --- |
| `workers/src/` | Worker、Durable Objects、管理台与工具 |
| `workers/sandbox/` | Cloudflare 按需启动的编码沙箱及 Dockerfile |
| `runner/` | Windows MCP 服务、Hyper-V 来宾助手与 WSB 临时执行器 |
| `workers/test/` | Workers 与独立 Node 测试 |
| `workers/scripts/` | secret 配置、技能导入和模拟 NapCat 工具 |
| `scripts/` | worktree 管理、工作区导入导出及本机 Workshop 连接 |
| `docs/` | 当前架构、部署、功能与接口说明 |

原 Node 主服务、旧观测面板、Gmail 侧车和 Docker Compose 部署已移除。Cloudflare 编码沙箱仍使用容器。NapCat 是独立运行的 QQ 接入端，通过反向 WebSocket 连接 Worker。

CS2 Workshop 本体属于另一个项目；本仓库只保存云端调用它所需的 MCP / Tunnel 接入脚本。旧私有数据库、素材、凭据和备份不属于代码清理范围，继续由 Git 忽略。

## 文档

- [架构](docs/ARCHITECTURE.md)、[Workers 运行设计](docs/WORKERS-DESIGN.md)
- [部署与验证](docs/DEPLOY.md)、[管理与功能说明](workers/README.md)
- [管理台](docs/ADMIN-CONSOLE.md)、[云端功能与资源预算](docs/CLOUD-PARITY.md)
- [权限与发送](docs/CLOUD-ACCESS-CONTRACT.md)、[资产与持久工作区](docs/CLOUD-ASSETS-CONTRACT.md)、[MCP 与子 agent](docs/CLOUD-MCP-CONTRACT.md)
- [本机 Workshop 接入](docs/WORKSHOP-LOCAL.md)
