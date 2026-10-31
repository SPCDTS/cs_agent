# Cloudflare 部署与验证

唯一应用部署目录是 `workers/`。旧常驻 Node 服务、Docker Compose、Datasette 和 Gmail 侧车的部署方式已移除。

## 本地准备

安装 Node.js 24+，在仓库根运行：

```sh
npm run install:workers
npm run check
```

根目录没有运行依赖；不需要安装根目录旧 lockfile 中的包。`npm run install:workers` 会分别安装 Workers 与 runner 的固定依赖。`npm run build` 先构建 guest 执行器，再执行 Wrangler dry-run，并设置 `--containers-rollout=none`，只验证 Worker 打包，不发布也不构建镜像。

配置位于 `workers/wrangler.jsonc`：Worker 名称、自定义域名、Durable Object 绑定与迁移、R2 绑定、定时触发和编码沙箱镜像。`workers/wrangler.test.jsonc` 用于隔离测试。不要删除已上线的 DO migration 历史，包括已经删除的类。

实际部署编码沙箱需要可用的 Docker；这是构建 Cloudflare coding 镜像的依赖，不是恢复旧 Docker Compose 服务。

## 凭据与 NapCat

私有配置不进入 Git。`.env.example` 只列上传脚本使用的配置名；真实 `.env`、`secrets/` 继续由 Git 忽略。

- 必需：`NAPCAT_TOKEN`、`QQ_OWNER`、`ADMIN_TOKEN`、`OAUTH_STORE_KEY`。
- 模型：DeepSeek 使用 `DEEPSEEK_API_KEY`；ChatGPT 订阅在管理页用一次性本机助手授权。
- Gmail：按需提供 `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN`，推送来源配置在 Wrangler vars。
- MCP：只上传 `workers/mcp.json` 中引用的 secret；Workshop 接入见 [本机说明](WORKSHOP-LOCAL.md)。

在具备 Bash、Python 和 Wrangler 登录的环境中，可从仓库根运行 `bash workers/scripts/put-secrets.sh`。先准备私有 `secrets/` 目录；脚本读取 `.env`，仅在缺失时生成管理员口令和 OAuth 加密密钥，并通过 stdin 上传。不要覆盖既有 `OAUTH_STORE_KEY`，否则已有凭据无法解密。也可逐项使用 `npx wrangler secret put`。

NapCat 独立运行，在其反向 WebSocket 客户端中配置 `wss://<Worker 域名>/onebot` 和相同的 `NAPCAT_TOKEN`。图片回传设置见 [资产协议](CLOUD-ASSETS-CONTRACT.md)。仓库不再负责启动或重建 NapCat 容器。

## 发布

仅在用户明确授权发布时执行。GitHub 仓库配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，部署 job 使用 `workers` environment。

- PR 和 main 的 CI 均运行 `npm run check`。
- main 上检查成功后，CI 自动发布 Worker 和 coding 沙箱，并把提交号写入 `CS_AGENT_COMMIT`。因此推送 main 即触发发布。
- 手动发布在 `workers/` 运行 `npx wrangler deploy --var CS_AGENT_COMMIT:<已批准的提交号>`；检查待发布差异和目标账号，不上传私有本机目录。

## 上线核对

读取 `/healthz`，核对提交号和 Bridge / 模型状态；登录 `/admin/` 检查请求统计、会话、MCP 与工作区。部署成功不能代替模型实际可用性验证。真实 QQ 发送、邮件发送与 Workshop 制作动作需要相应授权；常规自动测试使用模拟服务。

## 本地旧文件

代码清理不删除既有 `data/`、`workspace/`、`napcat/`、`secrets/` 或其他 worktree。老 worktree 可能通过目录链接共享根 node_modules，不能直接递归删除这份共享缓存。新 checkout 安装 `workers/` 和 `runner/` 各自的依赖；不能共享其他 worktree 的 node_modules。

远程沙箱的生产开关 `REMOTE_SANDBOX_ENABLED` 默认是 `"false"`。启用前按 [运行说明](REMOTE-SANDBOX-RUNBOOK.md) 核对设备权限、WSB 与磁盘配置；本机连接器另行运行。`workers/wrangler.smoke.jsonc` 仅用于本地链路验证，不是部署配置。
