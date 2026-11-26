# 贡献流程

仓库当前仅公开源码，尚未提供开源许可证。提交改动前，请先与维护者确认需求和贡献范围。

## 环境

通用检查需要 Node.js 24+ 和 npm。Windows runner 的真实 WSB 验证需要已启用 Windows Sandbox 的 Windows 主机，单独运行 `npm --prefix runner run test:wsb`。Cloudflare 容器镜像发布需要 Docker，日常 Worker 打包检查不构建镜像。

```sh
npm run install:workers
npm run check
```

根目录命令检查 `workers/` 和 `runner/`，各自依赖由各自的 lockfile 固定；每个 worktree 独立安装依赖。

日常单模块改动先运行 `npm run typecheck` 和相关测试，例如 `npm run test:related -- src/github/app.ts`；路径相对 `workers/`。也可直接指定测试文件：`npm test -- test/github-user-auth.test.ts`。相关测试根据静态 import 关系选择，涉及共享入口、DO 生命周期、配置或跨模块行为时运行完整 `npm run check`。纯说明文档无需运行代码测试。

完整检查将测试拆分为轻量 `node` 池（`workers/test/projects.mjs` 中的 `NODE_TESTS`）与按文件隔离（`isolate: true`）的 `workers` 池，在 `workers` 池内通过全局 `workers/test/setup-workers.ts` 与每用例清理隔离 DO 状态，本机最多并发 2 个测试文件、CI 最多 3 个；排查时可以用 `npm test -- --maxWorkers=1` 或 `--sequence.shuffle` 验证隔离。

#### DO 后台任务与跨用例竞态规避

`cloudflare:test` 的 `reset()` 底层调用 `deleteAllDurableObjects()`，仅重置当前仍在 `ActorNamespace` 中活跃的 DO；一方面，若在 `reset()` 之前调用 `abortAllDurableObjects()`，会把 DO 从活跃映射移除导致存储未被清空、把脏数据漏给下一用例，还可能让遗留后台 Promise 抛出未捕获的 `Application called abortAllDurableObjects()` 异常；另一方面，若 DO 在用例内因 `ctx.waitUntil()`（如模型记账、20ms `pi-telemetry` 批量上报）提前被驱逐或测试 `afterEach` 先调用 `vi.restoreAllMocks()`，遗留后台任务还会打到真实网络、还原真实 provider，甚至使已驱逐 DO 的持久状态污染同文件后续用例（如在相同消息 ID 上返回 `{ deduped: true }`）。因此：
1. `workers` 池统一由 [workers/test/setup-workers.ts](workers/test/setup-workers.ts) 在每用例结束后通过 `listDurableObjectIds()` 兜底清理已驱逐 DO 的残留存储/alarm，并按 `reset() -> vi.restoreAllMocks()` 兜底收尾；
2. 任何测试文件自定义 `afterEach` 必须严格按「关闭客户端 WebSocket/句柄 -> `await reset()` ->（如确需显式中止活跃 DO 则再调用 `await abortAllDurableObjects()`）-> `vi.restoreAllMocks()`（如使用）」顺序执行，禁止在 `reset()` 前调用 `abortAllDurableObjects()` 或先还原 mock；
3. 业务代码中 DO 内延迟异步工作（如遥测聚合、日志/回执同步）必须挂载 `ctx.waitUntil()` 并控制队列/重试有界，避免无界定时 loop 在运行期与测试清理期长期悬停 DO。

`npm run test:ci` 自动执行测试卫生门禁（禁止过程命名文件、禁止 >12s 超时、纯逻辑必须分流至 `NODE_TESTS`、`workers` 池文件数上限 36，以及 `afterEach` 清理顺序校验），CI 还会输出 Vitest 耗时摘要并校验耗时预算红线；仅修改 `docs/` 或根目录说明文档时快速完成必需的 `workers check`，并跳过部署。合并 main 后的代码发布仍须通过该提交的完整检查。

## 测试取舍

测试的价值是捕捉行为回退，不以用例数量或覆盖率数字作为目标。新增或维护时先查已有覆盖：

- 同一行为默认只在一层验证。格式与边界放在解析器/领域层；HTTP、DO 或模型链路保留代表性贯通场景，不重复整套参数矩阵。
- 合并重复测试时，把独有断言移到保留的场景中，明确剩余覆盖位置；不能只删除失败或耗时用例。
- 分页与容量用最小数据跨过真实边界；可配置批次就缩小批次，不把压测塞进每次回归。时间边界用虚拟时钟，保留到期前后断言。
- 授权隔离、撤权竞态、发送幂等、持久化恢复、主/子 agent 的模型续轮隔离属于关键行为，不能仅因耗时而删除。提示词或页面文案只在有实际功能契约时检查，不锁定无关措辞。

## 提交与 PR

1. 从最新 main 创建功能分支，按变更性质使用语义前缀（`feat/`、`fix/`、`docs/`、`refactor/`、`test/`、`chore/`、`ci/`）。Windows 可用 `scripts/wt.ps1 new <前缀/名称>` 创建 worktree。
2. 完成一个逻辑变更，运行相关检查，核对暂存区不含凭据、私有数据或无关文件。
3. 推送功能分支，使用已获授权的 GitHub 身份按 [.github/pull_request_template.md](.github/pull_request_template.md) 创建 PR：重点写明背景与原因、关键方案取舍（为何如此设计）、对外行为与影响范围，以及实际验证与未覆盖边界；不逐文件复述 diff，小改动按需精简。
4. 等待 GitHub Actions 的 `workers check` 成功，再由获授权的人通过 GitHub 合并。main 禁止直接推送、强推和删除。
5. 主工作区使用 `git pull --ff-only` 更新；`scripts/wt.ps1 land` 不再执行本地合并。

合入 main 会启动生产部署，因此合并需要发布授权。不要用跳过 hook、直接更新 Git ref 或其他凭据规避保护。

## 修改边界

模型出站、DO 数据迁移、文件持久化和发送幂等是关键行为；目录整理不得改变这些语义。尽量分开提交功能修复和结构提取。新增测试优先覆盖实际触发条件，无需为普通可逆变更建立大量模拟用例。

安全问题不要公开凭据或用户数据，见 [SECURITY.md](SECURITY.md)。
