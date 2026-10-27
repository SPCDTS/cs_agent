# cs_agent 多 agent 协作约定

常有多个 Claude 会话和它们派出的 Codex 同时开发本仓库。下面的约定让任何一方都不需要冻结主工作区。

## 开发与合并

- 每个任务在自己的 worktree 里做：`scripts/wt.ps1 new <名称>`，建出 `<主工作区>-wt-<名称>` 与同名分支。Codex 和其他子 agent 也在这个 worktree 里写，不进主工作区。
- 主工作区 `D:\project\cs_agent` 只做集成。`scripts/hooks/pre-commit` 拒绝在主工作区提交（`wt.ps1` 会设置 `core.hooksPath`），确有必要时设 `CS_ALLOW_MAIN_COMMIT=1`。
- 合并用 `scripts/wt.ps1 land <名称>`：rebase 到 main，跑 typecheck 与单测，再在主工作区 `merge --ff-only`。冲突在自己的 worktree 里解决；测试期间 main 前进了就重跑。不需要事先通知别的会话。
- 清理用 `scripts/wt.ps1 rm <名称>`，不要直接 `git worktree remove`：worktree 的 `node_modules` 是指向主工作区的链接，直接删会把主工作区的依赖一起删掉。
- 不要在 worktree 里 `npm install`，它会改到主工作区的依赖。改依赖时先删掉该 worktree 的 `node_modules` 链接再 `npm ci`，land 之后在主工作区 `npm ci`。

## 部署

- 只在用户明确要求时部署，只部署用户同意上线的提交。
- 用 `scripts/deploy.ps1 -By <会话名>`。脚本会列出线上版本到目标之间的全部提交；其中有别的会话的提交时，先问用户。
- 脚本持部署锁、等 agent 空闲、核对健康与容器内提交，记录在 `.git/deploy.log`。细节见 [docs/DEPLOY.md](docs/DEPLOY.md) §5。
