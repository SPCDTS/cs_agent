# Workers 开发与管理

此目录包含项目部署在 Cloudflare Workers 的应用。开发、测试和部署入口见 [根 README](../README.md) 与 [部署说明](../docs/DEPLOY.md)。当前能力见 [云端功能与资源预算](../docs/CLOUD-PARITY.md)，管理台交互见 [管理台说明](../docs/ADMIN-CONSOLE.md)。

## 管理面板

打开 `/admin/` 并输入 `ADMIN_TOKEN`。口令只保存在当前标签页 sessionStorage，每次请求通过 Authorization Bearer 发送；401 时清除口令并回到登录界面。页面和 `/admin/app.js` 不包含私有数据，数据接口在 `src/admin/routes.ts` 等路由模块中鉴权。

主要入口包含请求统计、会话对话、记忆、人设与技能、授权与发送、MCP、持久工作区和运维设置。请求详情可查看模型消息、工具、token 与错误；网页续聊共享所选 QQ 会话上下文，网页产生的回答留在网页。

设置使用 revision CAS；保存时发生冲突会返回 409，不能覆盖别人刚写入的版本。owner 来自 `QQ_OWNER`，管理页不能把普通用户提升为 owner。

## 模型与 ChatGPT 登录

模型选择保存在 Registry，后续回合读取当前配置。DeepSeek 使用 `DEEPSEEK_API_KEY`。ChatGPT 订阅使用 Codex 原生 OAuth，provider id `openai-codex` 和已有会话模型选择保留，推理走 `chatgpt.com/backend-api/codex/responses`，复用 pi-ai 的 Codex SSE 适配。

1. 在管理页的模型设置中添加账号或选择已有账号，开始授权。
2. 下载本机助手，用 Node.js 24+ 执行页面给出的命令并输入一次性配对码。
3. 助手监听 `127.0.0.1:1455`，用固定回调 `http://localhost:1455/auth/callback` 打开 Codex 授权页面，完成交换后经 HTTPS 提交凭据并退出。该端口需要空闲。
4. 回到管理页刷新状态和模型目录。首次真实推理成功前，不能仅凭“已登录”判定推理恢复。

配对码有效期为 10 分钟，只授权一次凭据导入。账号注册与稳定 host id 保存在 Registry，凭据使用 `OAUTH_STORE_KEY` 加密；本机助手不保存令牌文件，页面不会收到访问令牌。Thread 经 Registry 租锁串行续期，切换账号不会把旧请求的续期结果写给新账号。

管理页可切换账号、刷新目录和登出。新登录固定使用 Codex client id 与 `/oauth/authorize`、`/oauth/token`，不再申请 SIWC 的 `resource.invoke` / `chatgpt.tokens.use.direct`。已有 SIWC 授权按原通道继续工作；新登录通过身份和模型目录校验后才切换活动账号，旧账号保留可选。身份验证通过后先加密保存新授权；模型目录暂时失败会显示「已授权，目录待恢复」，保留旧活动账号。选择新 Codex 账号并点击「使用所选账号」即可重试目录，无需重复登录。模型目录由 Registry 的按需 alarm 请求，使用 DO 自身的执行上下文；不固定出口 IP 或国家。管理页只显示 HTTP 状态、错误分类和请求标识，不显示上游正文或凭据；生图必须完成原生登录。请独立登录 cs-agent，不复制正在使用的 Codex CLI / 桌面端凭据，以免多端争用轮换令牌。实现位于 `src/{codex-login,chatgpt-accounts,model-credentials,models}.ts` 与 `src/admin/chatgpt-helper.ts`。

排查模型地区拒绝时，可用管理员鉴权调用 `POST /admin/diagnostics/model-egress`。探针从实际 owner DO 发出，仅手动请求四个固定公开地址，不读取或发送模型凭据；每次请求超时 8 秒、正文上限 8 KiB。结果分别保留 OpenAI API、认证域名、Cloudflare 与 ipify 观察到的 IP/地区，不把机房代码或共享 Worker 地址当作确定的物理出口，也不能用公开探针结果证明带认证的模型请求一定成功。

## 订阅生图

DeepSeek 和 GPT 的普通聊天、网页聊天都能调用同一个 `generate_image`；工具独立解析当前 Codex 账号凭据，刷新仍经 Registry 串行租约。未完成原生登录时返回明确的登录提示，不会改用 API key 付费或自动切换对话模型。

工具参照 [Magpie 图片实现](https://github.com/yetone/magpie/blob/main/internal/gateway/draw.go) 直连 Codex 的 `/images/generations`，填写本会话图片资产 ID 时使用 `/images/edits`。协议模型为 `gpt-image-2`；实际可用性和额度由订阅后端决定。支持画幅、质量、透明背景与 PNG / JPEG / WebP。生成图片大小与同次编辑参考图总大小分别沿用媒体的 10MiB 上限；不额外启动容器、轮询任务或中转代理。

生成原图保存在当前会话的私有 R2 资产中；模型收到资产引用，调用 `send_message({text, images: [id]})` 展示图片。网页入口只显示网页，QQ 入口复用既有图片投递。对话不重复保存 Base64；普通请求详情记录工具参数和结果引用，事件记录结果、耗时和脱敏错误，不将生图折算成对话 token 用量。

生成有额度副作用，标记为不可自动重放；连接中断、超时或保存失败时不自动重新生成。事件触发和子 agent 仍不开放该工具。真实可用性须在部署并完成新登录后验证：先执行一轮 GPT 工具调用，再分别用 DeepSeek、GPT 在网页生成图片，最后用已生成的资产测试编辑；QQ 发送另外由用户确认。

## 联网与外部工具

`web_search` 调用 DeepSeek Search API，复用现有 API key；`web_page` 直接请求指定网页。管理员在管理台的「模型与接入」配置 MCP 服务、凭据与工具白名单。`mcp.json` 用于初始化 Registry。远程执行环境由各自的 MCP 服务提供，Windows 的 VM 和 WSB 接入见 [Windows MCP](../docs/WINDOWS-MCP.md)。OAuth 登录、目录刷新、资源读取、群授权和逐次审批见 [MCP 契约](../docs/CLOUD-MCP-CONTRACT.md)。

CS2 Workshop 是外部项目。此仓库的 `scripts/workshop-local.*` 只维护连接它的本机 MCP 与 Cloudflare Tunnel；录制、合成、投稿和资源状态由 Workshop 自己管理，见 [本机接入](../docs/WORKSHOP-LOCAL.md)。

## 聊天、记忆与技能

每个 Thread 保存自己的聊天记录、摘要与记忆；查询按线程作用域限制。后台维护负责摘要、保留期和记忆整理。管理页支持当前条目、版本、关系、画像建议、恢复与整理回滚；具体接口在 `src/admin/memory-routes.ts`。

已有的聊天、记忆历史、授权等云端导入接口继续保留其校验和幂等契约；旧本地 SQLite 部署的专用导出脚本已移除。需要查看过去迁移的实现时从 Git 历史查阅，不重新启动旧服务。

技能在 Registry 存储，目录只向模型提供名称与描述，正文通过 `read_skill` 按需读取。管理页负责编辑、启停、删除；也可用 `scripts/import-skills.mjs` 从本地技能目录生成请求体。工作区中的技能经过 `skill_inspect` 与 `skill_publish` 检查和双版本 CAS 后发布，见 [资产协议](../docs/CLOUD-ASSETS-CONTRACT.md)。

## 定时、事件与子任务

ScheduleDO 管理定时规则、下次触发和运行状态；EventsDO 管理外部事件的来源、游标、预算与投递。Gmail 由 Worker 直接调用 OAuth / Gmail / Pub/Sub API，不运行本机 Gmail 侧车。

每 5 分钟的触发用于外部事件兜底；每日 UTC 19:30（北京时间 03:30）执行聊天摘要、记忆整理与保留清理。维护任务由 `src/maintenance/` 分段处理。

子任务使用独立 SubagentDO，并保存派出者身份与父线程状态；MCP、技能和工作区权限在使用时重新检查。Cloudflare 子任务默认继承父线程工作区。派出时传 `sandboxId` 可以分配已存在的工作区，同一 ID 共享文件。不同工作区之间按显式路径和版本检查合并文件。传 `mcpTools` 可以把子任务的 MCP 工具收窄到指定服务和原始工具名。当前配额与身份规则以 [资源预算](../docs/CLOUD-PARITY.md) 和 [权限协议](../docs/CLOUD-ACCESS-CONTRACT.md) 为准。

## 编码沙箱与持久文件

`sandbox/Dockerfile` 属于当前 Cloudflare 部署。SandboxDO 按需启动容器并访问内部控制服务；执行命令的用户为 sandbox（uid 1000）。`bash` 默认 60 秒、最长 120 秒，stdout / stderr 各保留末尾 64 KiB。镜像含 Python、Node、Git 和 curl，具体版本及软件以 Dockerfile 为准。

主人可以在 Code Mode 中调用 `sandbox_list({})` 查看默认工作区 ID 和已分配资源，再用 `sandbox_create({sourceId})` 复制来源已保存的源码。省略 `sourceId` 会创建空工作区。

容器的 `/work` 是临时执行视图，持久状态保存在 R2。写入与命令完成后提交版本快照；停止容器保留已经提交的工作区，重启时恢复。单文件 10 MiB、每工作区 50 MiB，不支持符号链接；完整协议见 [资产与工作区](../docs/CLOUD-ASSETS-CONTRACT.md)。

本地测试配置不启动 Cloudflare 容器。`test/sandbox-*.node.mjs` 在普通 Node 环境测试控制服务与文件操作；workerd 测试使用沙箱接口替身。Worker dry-run 不验证远端容器构建。

## 验证

从仓库根运行 `npm run check`，会执行：

1. Workers TypeScript 类型检查。
2. `vitest run --maxWorkers=1`，覆盖 Worker / DO 业务与权限。
3. `node --test test/*.node.mjs`，覆盖沙箱服务、登录助手与技能导入。
4. Wrangler dry-run，验证生产配置下的 Worker 打包，不发布容器。

`vitest.config.ts` 复用已安装 Wrangler 的 workerd，以匹配部署兼容日期。锁文件中的运行时版本保持原样；更换测试工具版本需要单独验证。CI 使用 Ubuntu 与 Node.js 24。
