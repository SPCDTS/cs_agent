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
- 模型：DeepSeek 使用 `DEEPSEEK_API_KEY`；ChatGPT 订阅在管理页用一次性本机助手完成 Codex 原生授权；已有 SIWC 授权可继续对话，订阅生图需要重新授权。流程与回退见 [模型与登录](../workers/README.md#模型与-chatgpt-登录)。
- Gmail：按需提供 `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN`，推送来源配置在 Wrangler vars。
- MCP：已有 `workers/mcp.json` 中引用的 secret 继续有效；新增远程服务通过 agent 或管理页接入，Token 加密保存在 Registry，无需逐个上传 Cloudflare Secret。见 [动态 MCP 接入](MCP-SETUP.md)；Workshop 本机连接见 [本机说明](WORKSHOP-LOCAL.md)。

在具备 Bash、Python 和 Wrangler 登录的环境中，可从仓库根运行 `bash workers/scripts/put-secrets.sh`。先准备私有 `secrets/` 目录；脚本读取 `.env`，仅在缺失时生成管理员口令和 OAuth 加密密钥，并通过 stdin 上传。不要覆盖既有 `OAUTH_STORE_KEY`，否则已有凭据无法解密。也可逐项使用 `npx wrangler secret put`。

NapCat 独立运行，在其反向 WebSocket 客户端中配置 `wss://<Worker 域名>/onebot` 和相同的 `NAPCAT_TOKEN`。图片回传设置见 [资产协议](CLOUD-ASSETS-CONTRACT.md)。仓库不再负责启动或重建 NapCat 容器。

## 发布

仅在用户明确授权发布时执行。GitHub 仓库配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，部署 job 使用 `workers` environment。

- PR 和 main 的 CI 均运行 `npm run check`。
- main 上检查成功后，CI 自动发布 Worker 和 coding 沙箱，并把提交号写入 `CS_AGENT_COMMIT`。因此推送 main 即触发发布。
- 手动发布在 `workers/` 运行 `npx wrangler deploy --var CS_AGENT_COMMIT:<已批准的提交号>`；检查待发布差异和目标账号，不上传私有本机目录。

## 上线核对

读取 `/healthz`，核对提交号和 Bridge / 模型状态；登录 `/admin/` 检查请求统计、会话、MCP 与工作区。部署成功不能代替模型实际可用性验证。真实 QQ 发送、邮件发送与 Workshop 制作动作需要相应授权；常规自动测试使用模拟服务。

## ChatGPT 刷新故障排查

管理页的登录状态来自账号凭据元数据，不会为了读取状态发起 OAuth 请求：

- “凭据有效”：access token 距到期超过 5 分钟，且没有未恢复的刷新故障。
- “到期待刷新”：已进入 pi-ai 的 5 分钟刷新窗口，下次模型请求会尝试刷新；这不等同于授权失效。
- “刷新失败”：最近一次刷新失败，但尚无需要重新授权的明确证据。
- “需要重新授权”：上游返回 invalid_grant、refresh_token_expired 等明确拒绝凭据的错误，或缺少订阅权限。

点击“刷新模型列表”可以验证现有凭据及刷新路径，不会发起模型生成或 QQ 发送。失败后页面更新账号状态，并显示 HTTP 状态、已知 OAuth 错误码、响应类型、请求 ID 和 Cloudflare Ray；凭据保留，以便临时故障后重试。重新授权或刷新成功会清除旧故障。只读取“刷新状态”不会尝试续期。

模型请求列表保留相同的脱敏诊断；Workers 日志事件名是 model_oauth_refresh_failed。账号状态保存在 Registry 的凭据元数据中，DO 重启后仍可读取；跨会话失败按当时的账号和凭据版本写回，不影响后来切换或更新的账号。错误正文、错误描述、认证头和令牌均不写日志；未知错误码显示为 unrecognized。

HTTP 403 的 HTML 响应和 Cloudflare challenge 属于接入失败证据，不能据此断言 refresh token 已失效；429、5xx、网络错误和超时同样不应直接要求重新授权。模型健康检查会暴露待刷新或失败状态，但不会阻止下一次正常请求尝试恢复。读取模型目录失败时，已经刷新并轮换的令牌仍会保存。

## 本地旧文件

代码清理不删除既有 `data/`、`workspace/`、`napcat/`、`secrets/` 或其他 worktree。老 worktree 可能通过目录链接共享根 node_modules，不能直接递归删除这份共享缓存。新 checkout 安装 `workers/` 和 `runner/` 各自的依赖；不能共享其他 worktree 的 node_modules。

远程 Windows 环境通过管理台的 MCP 服务接入，配置见 [Windows MCP](WINDOWS-MCP.md)。旧 Sandbox 标签、远程开关和配对协议已移除。上线前先用旧版本完成或取消远程任务并停止旧连接器；新服务使用独立状态目录，不复用或删除旧持久数据。Cloudflare 资源由 v12 DO class rename 保留，部署时必须连同迁移发布。
