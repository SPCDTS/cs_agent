# 贡献流程

仓库当前仅公开源码，尚未提供开源许可证。提交改动前，请先与维护者确认需求和贡献范围。

## 环境

通用检查需要 Node.js 24+、npm 和 Python 3.12+。Windows runner 的原生检查需要 Windows；真实 Hyper-V/WSB 验证按对应环境说明单独进行。Cloudflare 容器镜像发布需要 Docker，日常 Worker 打包检查不构建镜像。

```sh
npm run install:workers
npm run check
```

根目录命令检查 `workers/` 和 `runner/`，各自依赖由各自的 lockfile 固定；每个 worktree 独立安装依赖。

## 提交与 PR

1. 从最新 main 创建功能分支；agent 使用 `codex/` 前缀。Windows 可用 `scripts/wt.ps1 new <名称>` 创建 worktree。
2. 完成一个逻辑变更，运行相关检查，核对暂存区不含凭据、私有数据或无关文件。
3. 推送功能分支，使用已获授权的 GitHub 身份创建 PR，说明问题、修改后的行为和验证结果。
4. 等待 GitHub Actions 的 `workers check` 成功，再由获授权的人通过 GitHub 合并。main 禁止直接推送、强推和删除。
5. 主工作区使用 `git pull --ff-only` 更新；`scripts/wt.ps1 land` 不再执行本地合并。

合入 main 会启动生产部署，因此合并需要发布授权。不要用跳过 hook、直接更新 Git ref 或其他凭据规避保护。

## 修改边界

模型出站、DO 数据迁移、文件持久化和发送幂等是关键行为；目录整理不得改变这些语义。尽量分开提交功能修复和结构提取。新增测试优先覆盖实际触发条件，无需为普通可逆变更建立大量模拟用例。

安全问题不要公开凭据或用户数据，见 [SECURITY.md](SECURITY.md)。
