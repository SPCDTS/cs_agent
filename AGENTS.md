# 仓库协作约定

## 开发与发布

- 在独立 worktree 和功能分支开发，分支按变更性质使用语义前缀（`feat/`、`fix/`、`docs/`、`refactor/`、`test/`、`chore/`、`ci/`）；主工作区用于读取和更新 main。
- 功能更新必须提交 PR，等待 `workers check` 成功后通过 GitHub 合并。禁止直推 main，不得用关闭 hook、强推或 API 更新分支绕过此流程。
- 创建或大幅更新 PR 时按 [.github/pull_request_template.md](.github/pull_request_template.md) 填写说明：讲清背景与原因、关键方案取舍（为什么这样做）、变更与影响范围（如全局或单会话生效）及验证与未覆盖边界；不逐文件复述 diff，小改动可精简。
- 每次创建或更新 PR 并推送后，跟进最新提交的 CI 直到完成；失败时读取日志、修复可处理的问题，重新推送后再次核验。不得仅以“CI 运行中”结束任务；如受权限或外部故障阻塞，明确报告原因及所需行动。
- 合并 main 会触发生产部署；创建 PR 不等于获准合并或部署。
- 每个提交只包含一项完整逻辑变更及其必要测试和文档。提交前检查暂存区，排除私有数据和凭据。
- 使用当前操作者已获授权的 GitHub 身份，不把个人凭据或环境特定的 App 私钥路径写进公共说明。

## 验证与文件

- 在各 worktree 独立安装依赖：`npm run install:workers`。不要共享或清理其他 worktree 的 node_modules。
- 单模块改动提交前运行相关测试和类型检查；可用 `npm run test:related -- src/<文件>.ts`（路径相对 workers/）。共享入口、DO 生命周期、构建/测试配置或跨模块改动运行 `npm run check`。CI 对代码变更执行完整检查，不要求每次小改动在本地重复全套。测试针对真实行为，保持精简。
- 纯逻辑单测须登记到 `workers/test/projects.mjs` 的 `NODE_TESTS`；`workers` 池测试文件数受预算上限（`36`）约束，修 bug、补 review 回归或扩展同域测试须追加到对应业务域现有文件，禁止新建 `*-fixes` / `*-review` / `*-regressions` 文件；容量与超时边界使用批量预置或可注入小超时，不写长等待或数百次串行 DO RPC；`npm run test:ci` 自动执行上述测试卫生门禁。
- 中文说明采用中文正文；编辑已有文本前检查编码、BOM 和换行，并原样保留。
- 不提交 `.env`、`secrets/`、`data/`、`workspace/`、`napcat/` 或真实执行环境数据。
- 不修改已上线 DO 的迁移历史；主/子 agent 的 `alarm()` 必须先派发已经准备好的模型请求。
- 退役设备接入时保留持久 VM 的工作区和项目盘。WSB 是独立的临时环境，其 session 关闭后销毁。

## PR 评审

- 不因 PR 体积小而跳过系统级核查；评审必须跳出局部 diff，核验上下游完整链路。
- 端到端闭环：涉及读取、导入、持久化或工具输出时，一路追到最终消费者（Agent 工具、`/work` 沙箱、管理台 UI 或出站投递），确认写入的数据下游真正可读可用，没有“写入即死胡同”。
- 外部协议与真实契约：修改或替换外部接口（OneBot / NapCat、模型供应商、Cloudflare API、MCP）时，不以 mock 测试等同真实服务端行为；核对真实请求参数、返回边界（空串、缺省字段、错误码）与事件形态。
- 删除能力回归面：移除旧分支或回退路径时，逐一核对旧路径覆盖的全部入口与历史数据（私聊、群聊、通知事件、过期缓存、已有持久化数据），确认新路径完整承接或明确取舍。
- 运行时硬边界与并发：涉及大对象编解码、并发 `Promise.all` 或经过全局单例 DO（`BridgeDO`、`RequestsDO`、`RegistryDO`）的路径，核算峰值内存（DO 128 MiB 上限）、WS 帧上限（32 MiB）、RPC 超时与 CPU 预算，防止单点 OOM 或打断共享连接。
- 安全与平台红线：同步核查授权/命名空间隔离、凭据与 PII 脱敏顺序（先检测再截断）、后台 RPC 是否挂 `ctx.waitUntil()`、DO 迁移历史未改及主/子 agent `alarm()` 首行派发模型请求。
- CI 耗时与测试卫生：核查 CI Summary 慢测榜，确认无 >3s 新慢测、未私自拉高超时、未将纯逻辑误放进 `workers` 池、未突破 `workers` 池文件数上限，且未与同域已有文件重复搭建全栈 DO 夹具。

详细流程见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CLAUDE.md](CLAUDE.md)。
