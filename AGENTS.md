# 仓库协作约定

## 开发与发布

- 在独立 worktree 和功能分支开发，agent 分支使用 `codex/` 前缀；主工作区用于读取和更新 main。
- 功能更新必须提交 PR，等待 `workers check` 成功后通过 GitHub 合并。禁止直推 main，不得用关闭 hook、强推或 API 更新分支绕过此流程。
- 每次创建或更新 PR 并推送后，跟进最新提交的 CI 直到完成；失败时读取日志、修复可处理的问题，重新推送后再次核验。不得仅以“CI 运行中”结束任务；如受权限或外部故障阻塞，明确报告原因及所需行动。
- 合并 main 会触发生产部署；创建 PR 不等于获准合并或部署。
- 每个提交只包含一项完整逻辑变更及其必要测试和文档。提交前检查暂存区，排除私有数据和凭据。
- 使用当前操作者已获授权的 GitHub 身份，不把个人凭据或环境特定的 App 私钥路径写进公共说明。

## 验证与文件

- 在各 worktree 独立安装依赖：`npm run install:workers`。不要共享或清理其他 worktree 的 node_modules。
- 单模块改动提交前运行相关测试和类型检查；可用 `npm run test:related -- src/<文件>.ts`（路径相对 workers/）。共享入口、DO 生命周期、构建/测试配置或跨模块改动运行 `npm run check`。CI 对代码变更执行完整检查，不要求每次小改动在本地重复全套。测试针对真实行为，保持精简。
- 中文说明采用中文正文；编辑已有文本前检查编码、BOM 和换行，并原样保留。
- 不提交 `.env`、`secrets/`、`data/`、`workspace/`、`napcat/` 或真实执行环境数据。
- 不修改已上线 DO 的迁移历史；主/子 agent 的 `alarm()` 必须先派发已经准备好的模型请求。
- Hyper-V VM 是可信持久环境，WSB 是临时环境；不要把运行时清理变成删除持久工作区。

详细流程见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CLAUDE.md](CLAUDE.md)。
