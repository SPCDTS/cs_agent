# cs-agent

基于 Cloudflare Workers 与 Durable Objects 构建的**全栈个人智能体（Personal Agent）**。

`cs-agent` 面向单一主人（Single-Owner）打造，而非多租户 SaaS 平台。它以日常高频使用的 **QQ（私聊与群聊）** 和 **专属管理台网页** 为交互入口，由云端 Durable Objects 全天候托管你的个人长期记忆、日程提醒、外部事件（Gmail / GitHub）与异步子任务；同时向下连接 Cloudflare 编码沙箱、你本机的 Windows / macOS / Linux 设备以及 Windows Hyper-V 开发虚拟机与 WSB 临时沙箱，成为能够跨聊天软件、个人云端工作区与私人物理设备协同工作的个人数字分身。

应用主代码位于 `workers/`，`runner/` 提供跨平台设备接入（命令行与桌面 MCP）。持久 Windows VM 在来宾内配对，Windows Sandbox（WSB）由宿主机 runner 管理。

---

## 设计定位：为什么是 Personal Agent

- **单主人（Single-Owner）信任锚点**：整个实例围绕 `QQ_OWNER` 运转。主人在私聊与管理台拥有完整控制权；同时 Agent 也能走进主人的群聊和其他私聊参与互动，但所有跨会话操作（跨目标发消息、群内调用主人的外部 MCP 服务、执行写操作）均在宿主侧按触发身份与会话边界严格鉴权、收窄或逐次向主人发起审批，绝不因模型提示词注入而越权。
- **云端全天候在线 + 私人设备随时召唤**：大脑、记忆、定时器和轻量 Linux 编码容器运行在 Cloudflare 边缘网络，无需本机 24 小时开机即可接收 QQ 消息、处理邮件与 GitHub 动态；当需要重度开发环境、本地工具链或 GUI 桌面操作时，再通过加密 Cloudflare Tunnel 随时唤醒并操作主人的开发虚拟机或随身电脑。
- **复用个人既有订阅与数字资产**：支持直接绑定个人 ChatGPT 订阅账号（通过 Codex 原生 OAuth 配对，共享推理与 `gpt-image-2` 订阅生图额度）与 DeepSeek API Key；直连个人的 Gmail 与多身份 GitHub 账号，将分散在各处的通知、代码仓库与日常对话沉淀到同一套个人记忆库中。

---

## 核心特性

- **双渠道无缝协同与可靠投递**：独立运行的 NapCat 通过 `/onebot` 反向 WebSocket 接入 `BridgeDO`；专属管理台（`/admin/`）支持选择任意 QQ 会话进行网页续聊（共享同一套记忆与上下文，网页发起的回复留在网页）。所有 QQ 出站消息经持久投递账本、限速器与未知状态（`unknown`）核对保护，杜绝网络抖动时的盲目重发。
- **多模型推理、服务端联网与订阅生图**：支持 DeepSeek 与 ChatGPT 订阅账号（Codex 原生 OAuth 本机配对登录、Registry 串行租约续期）。主/子 Agent 均支持对应模型的服务端 `web_search` 与网页抓取；会话可直连 Codex 接口调用 `gpt-image-2` 生成或编辑图片，产物存入会话私有 R2 资产。
- **执行与管理查询严格隔离**：每个会话由独立的 `ThreadDO` 基于 `pi-durable` 驱动，耗时调研与编码任务可派生出独立的 `SubagentDO` 异步推进。主/子 Agent 的每次 OpenAI/Codex 出站请求均经 `ModelAlarm` 在新的 `alarm()` 首行同步派发，隔离入站 RPC 对 `IoContext` 的干扰。管理台所有读取请求只访问 `RequestsDO` 的增量同步展示副本，绝不唤醒执行 DO。
- **多层次代码执行与个人设备接入**：
  - **Cloudflare 云端编码容器（`cs.coding`）**：由 `SandboxDO` 按需启动 Lite 容器（空闲 3 分钟停止），提供受控 Linux `bash` 与文件读写；`/work` 快照与 SHA-256 去重 blob 持久化至私有 R2，支持为子任务克隆独立工作区及按路径合并产物。
  - **跨平台个人设备接入（Device MCP）**：在管理台生成一次性配对链接，在个人的 Windows / macOS / Linux 电脑上运行单文件客户端，即可自动配置 Cloudflare Tunnel、用户级登录自启动与本机 Shell MCP（可选启用 `agent-desktop` 桌面 GUI 操控）。
  - **Windows Hyper-V 持久工作区 & WSB 临时沙箱**：在持久 VM 内用开发账户配对设备客户端，沿用来宾磁盘上的仓库、依赖和工具链。临时 WSB 由宿主机 runner 创建和回收。
- **受控 Code Mode 与细粒度权限**：模型在 QuickJS 沙箱中编写脚本编排多步工具调用，内部工具的大体积中间输出不重复挤占模型上下文，MCP 返回的截图可自动落盘并发送。每次调用均由宿主强制校验真实触发身份、会话代次（generation）与作用域。
- **个人长期记忆、技能演进与外部事件**：按 owner、群聊、私聊分别沉淀长期记忆，支持带原文证据片段的自动抽取、与显式记忆冲突时的待确认保护、遗忘抑制、画像关联失效与整理回滚。Agent 可在编码工作区中编写、检查并通过双版本 CAS 发布新技能。内置 `ScheduleDO` 定时任务与 `EventsDO` 事件引擎（支持 Gmail 推送及多身份独立 GitHub App Webhook 接入，事件统一投递至主人私聊）。
- **全景管理台**：提供 Token 用量与缓存命中率趋势、24 小时 Agent 父子球体拓扑图、嵌套子会话只读流式查看、请求级上下文字符组成与相邻回合 diff、Code Mode 内部调用树追踪，以及带版本 CAS 保护的人设、记忆、技能、MCP 和运维配置管理。

---

## 系统架构

```
  NapCat (QQ OneBot WS)             主人管理台 (/admin/)             GitHub Webhook / Gmail / Cron
           │                                 │                                    │
           ▼                                 ▼                                    ▼
     ┌───────────┐                     ┌───────────┐                    ┌───────────────────┐
     │ BridgeDO  │◄─── 投递账本/回执 ───│ ThreadDO  │◄── 定时 / 事件 ────│ ScheduleDO        │
     └───────────┘                     │ (主会话)  │                    │ EventsDO          │
                                       └─────┬─────┘                    └───────────────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              ▼                              ▼                              ▼
        ┌───────────┐                  ┌───────────┐                  ┌───────────┐
        │SubagentDO │                  │RegistryDO │                  │RequestsDO │
        │ (子任务)  │                  │(配置/凭据)│                  │(统计/副本)│
        └─────┬─────┘                  └───────────┘                  └───────────┘
              │                              │
              └──────────────┬───────────────┘
                             ▼
       ┌───────────────────────────────────────────┐
       │           代码执行、设备与外部工具        │
       ├─────────────────────┬─────────────────────┤
       │ SandboxDO + 私有 R2 │ 远程 HTTPS MCP 服务 │
       │ (Cloudflare 容器)   │ (个人设备/VM/WSB)   │
       └─────────────────────┴─────────────────────┘
```

| 组件 | 核心职责 |
| --- | --- |
| `BridgeDO` | 维护 NapCat 反向 WebSocket 连接、聊天目录、限速熔断与持久化发送账本（`queued / sending / sent / unknown / failed / rejected`） |
| `ThreadDO` | 会话级执行引擎（`pi-durable`），主人私聊共享 `owner` 线程，群与外部私聊按各自键隔离；负责装配人设、记忆、技能、Code Mode 与 MCP 目录，管理 `ModelAlarm` 出站与子任务权限复核 |
| `SubagentDO` | 异步子任务执行，冻结派出时的身份与能力快照，支持显式分配工作区（`sandboxId`）与收窄 MCP 工具列表（`mcpTools`） |
| `RegistryDO` | 全局设置、模型账号与 OAuth 加密凭据（`OAUTH_STORE_KEY`）、人设、技能（双版本 CAS）、跨目标发送与群 MCP 授权 |
| `RequestsDO` | 集中保存有界模型请求快照、Token 用量、Code Mode 工具树，以及各会话/子任务的只读管理展示副本（`view:thread:*` / `view:sub:*`） |
| `ScheduleDO` / `EventsDO` | 定时规则调度、每日维护（摘要、记忆整理与过期清理），以及 Gmail / GitHub App 事件的验签、三层去重配额、积压与向 owner 的投递 |
| `SandboxDO` / `CloudflareWorkspaceResourcesDO` | 按需启动 Cloudflare 编码容器，管理 `/work` 目录与私有 R2 快照的事务提交、工作区克隆、文件合并及容量回收 |

---

## 目录结构

| 目录 | 说明 |
| --- | --- |
| `workers/src/` | Cloudflare Worker 入口、Durable Objects、模型传输层、记忆系统、GitHub/Gmail 事件与管理台后端路由 |
| `workers/browser/` | 管理台前端 TypeScript 源码（独立严格 DOM 类型检查，通过 esbuild 构建为 `/admin/app.js`） |
| `workers/sandbox/` | Cloudflare 线上按需编码沙箱控制服务及 `Dockerfile` |
| `workers/test/` | 运行在 `workerd` 中的业务与权限测试，以及独立 Node 测试（沙箱服务、登录助手、技能导入） |
| `workers/scripts/` | 管理台构建、Secret 批量配置、技能导入与模拟 NapCat 工具脚本 |
| `workers/deployments/` | 部署档案目录（`example.json` 模板与生产环境配置） |
| `runner/` | 跨平台设备客户端（`cs-agent-device.cjs`）、WSB 宿主机服务、旧 Hyper-V 环境兼容与桌面 MCP 桥接 |
| `scripts/` | Git worktree 协作脚本（`wt.ps1`）、CI 变更范围检查及本机 CS2 Workshop 接入脚本 |
| `docs/` | 架构设计、运行契约、安全边界与运维部署文档 |

> **说明**：旧版常驻 Node 主服务、旧观测面板、本机 Gmail 侧车与 Docker Compose 部署均已移除。NapCat 作为独立 QQ 协议端运行；CS2 Workshop 本体属于独立项目，本仓库仅保留连接它的本机 MCP / Tunnel 脚本。本机私有目录（`.env`、`secrets/`、`data/`、`workspace/`、`napcat/`）由 Git 忽略，不纳入代码提交。

---

## 快速开始（本地开发与验证）

### 环境要求

- **Node.js** 24+ 与 **npm**
- **Windows 环境**（可选）：仅在实际运行 Hyper-V / WSB 原生验证（`test:wsb`）时需要；常规跨平台检查在 macOS / Linux / Windows 均可直接完成。
- **Docker**（可选）：仅在实际部署构建 Cloudflare 编码沙箱镜像时需要；本地 `npm run check` 与 `npm run build` 使用 dry-run，不构建容器镜像。

### 安装与全套检查

仓库根目录 `package.json` 提供统一命令入口，实际依赖分别由 `workers/package-lock.json` 与 `runner/package-lock.json` 锁定：

```sh
# 分别安装 workers/ 与 runner/ 的固定依赖
npm run install:workers

# 执行全套静态检查、测试与打包验证（不发布服务）
npm run check
```

`npm run check` 会依次执行：
1. `workers` 与 `runner` 的 TypeScript 类型检查（含管理台浏览器源码构建与检查）。
2. CI 范围脚本自检（`scripts/ci-scope.test.mjs`）。
3. `workerd` 运行时中的业务、权限、恢复与路由契约测试（本机默认最多并发 2 个测试文件）。
4. 独立 Node 环境测试（Cloudflare 容器内控制服务、Codex 登录助手、技能导入与 `runner` 单元测试）。
5. `runner` 来宾执行器构建与 Wrangler 生产配置下的 dry-run 打包检查（`--containers-rollout=none`）。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run install:workers` | 在当前 worktree 独立安装 `workers/` 和 `runner/` 依赖 |
| `npm run dev` | 启动本地 Wrangler 开发服务（自动监听并构建管理台前端） |
| `npm run typecheck` | 执行 `workers`（服务端 + 浏览器端）与 `runner` 类型检查 |
| `npm test` | 运行 `workerd` 业务测试（排查时可加 `-- --maxWorkers=1` 串行运行） |
| `npm run test:related -- src/<文件>.ts` | 根据静态 import 关系仅运行单模块改动相关的测试（路径相对 `workers/`） |
| `npm run test:node` | 运行 `workers` 独立 Node 测试与 `runner` 测试 |
| `npm --prefix runner run test:wsb` | 在支持 Windows Sandbox 的 Windows 主机上运行真实 WSB 冒烟测试 |
| `npm run build` | 构建 `runner` 及 guest 执行器，并执行不发布的 Worker 打包检查 |
| `npm run deploy -- deployments/<档案>.json` | 合并指定部署档案并发布 Workers 与编码沙箱镜像（需显式授权） |

---

## 部署你自己的实例

完整部署步骤、Secret 清单与故障排查请参考 [docs/DEPLOY.md](docs/DEPLOY.md) 与 [workers/README.md](workers/README.md)。

1. **准备部署档案**：复制 `workers/deployments/example.json` 为被 Git 忽略的 `workers/deployments/my.local.json`，填入你自己的 Worker 名称、`PUBLIC_ORIGIN`、路由域名与 R2 桶名称。
2. **配置运行密钥**：准备 `.env`（参考 `.env.example`），必须包含 `NAPCAT_TOKEN`、`QQ_OWNER`（主人的 QQ 号）、`ADMIN_TOKEN` 与 `OAUTH_STORE_KEY`（32 字节加密主密钥，切勿随意覆盖）。可使用 `bash workers/scripts/put-secrets.sh deployments/my.local.json` 上传。
3. **接入模型与个人设备**：
   - **NapCat**：配置反向 WebSocket 指向 `wss://<PUBLIC_ORIGIN>/onebot`，携带相同 `NAPCAT_TOKEN`。
   - **模型账号**：DeepSeek 通过 `DEEPSEEK_API_KEY` 配置，Gemini 通过 `GEMINI_API_KEY` 配置；个人 ChatGPT 订阅在 `/admin/` 管理页下载一次性本机配对助手完成 Codex OAuth 登录。
   - **个人电脑与远程沙箱**：在管理台「模型与接入」中按需配对个人设备或持久 Windows VM；临时 WSB 单独登记宿主机服务。[设备配对](docs/DEVICE-MCP.md) · [Windows 沙箱与旧 VM 迁移](docs/WINDOWS-MCP.md)
4. **上线核对**：公开 `/healthz` 仅检查 Worker 进程存活；部署后请携带 `Authorization: Bearer <ADMIN_TOKEN>` 请求 `/admin/health` 或登录 `/admin/` 核对 Worker、Bridge 与模型组件的实际状态。

---

## 相关文档与贡献

- 架构与设计契约详见 `docs/` 目录（[架构与运行设计](docs/ARCHITECTURE.md)、[部署与验证](docs/DEPLOY.md)、[Workers 开发与管理](workers/README.md)）。
- 贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题报告见 [SECURITY.md](SECURITY.md)。

## 许可说明

当前仓库仅公开源码供查阅，尚未提供开源许可证或授予额外使用许可；如需额外授权，请联系维护者。
