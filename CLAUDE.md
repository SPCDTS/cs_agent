# cs_agent 协作约定

项目统一部署在 Cloudflare Workers，应用代码、依赖和测试位于 `workers/`。`runner/` 是可选的 Windows MCP 服务，提供 Hyper-V 持久工作区与临时 WSB。根目录 npm 命令统一检查这两个包；没有旧 Node 主服务或 Docker Compose 部署。

## 开发与合并

- 每个任务使用自己的 worktree：`scripts/wt.ps1 new <名称>`，创建 `<主工作区>-wt-<名称>` 和 `codex/<名称>` 分支。主工作区只做集成。
- 新 worktree 在自己的 `workers/` 和 `runner/` 安装依赖：`npm run install:workers`。不共享 node_modules，不在其他任务的依赖目录里安装或裁剪包。
- 老 worktree 可能仍有指向主工作区的 node_modules 链接。删除前先检查并断开链接；不要对链接指向的依赖目录做递归删除。
- 单模块改动在功能分支运行相关测试和类型检查后推送并创建 PR；共享入口、DO 生命周期、构建/测试配置或跨模块改动运行 `npm run check`。GitHub 的 `workers check` 必须成功才可合并；`scripts/wt.ps1 land` 已停用。通过 GitHub 合并后，主工作区只运行 `git pull --ff-only` 更新。
- `scripts/wt.ps1 rm <名称>` 清理 worktree；脚本会先断开已知的依赖目录链接。
- 提交前检查暂存区差异，排除私有数据、凭据和无关改动。`scripts/hooks/pre-commit` 仍禁止在主工作区直接提交；不得绕过钩子或分支保护直推 main。

## 验证与部署

- Node.js 24+；`npm run check` 包含类型检查、Workers 按文件隔离的并行测试（本机 2 个、CI 4 个）、独立 Node 测试、runner 检查/guest 构建和 Worker 打包检查。真实 WSB smoke 通过 `npm --prefix runner run test:wsb` 单独运行，不放入 Linux CI。
- 只在用户明确要求时部署，只部署用户同意上线的提交。PR 合入 main 后会触发 CI 自动部署，因此合并 PR 属于发布操作，仍需相应授权。
- 部署入口为 `.github/workflows/ci.yml` 或 Workers 的 `npm run deploy`；配置、密钥与验证见 [docs/DEPLOY.md](docs/DEPLOY.md)。
- `workers/sandbox/Dockerfile` 属于线上 coding 沙箱，必须保留。`scripts/workshop-local.*` 仅连接另一个项目的 CS2 Workshop，云端仍使用该连接。
- 不清理、提交或上传本机 `data/`、`workspace/`、`napcat/`、`secrets/` 和真实 `.env`；其中可能包含正在使用的接入配置、素材或历史备份。
