# 远程 WSB 沙箱运行说明

协议 v2：设备注册工具，WSB 首期只提供 `powershell`。文件和缓存保留在同一租约的 guest 内，不再与 R2 同步。功能默认关闭，架构见[设计文档](REMOTE-SANDBOX-DESIGN.md)。

## 准备与验证

本机需要 Windows Sandbox、可用的 `wsb` CLI、Node 24+ 和 npm；Git 可选。连接器主动连接 Worker，不需要开放本机公网端口。

```powershell
npm run install:workers
npm run check
npm --prefix runner run test:wsb
```

真实 WSB smoke 仅管理自己登记的实例，验证连续命令保留文件、依赖和取消停止。正式使用独立 state 目录，例如 `D:\sandbox-runner-state`，不要选项目 checkout 或用户主目录；其中保存 DPAPI 凭据、控制输入和回执，不提交 Git。

完整本地链路：先运行 `npm --prefix runner run build`，在 workers 目录启动：

```powershell
npx wrangler dev --config wrangler.smoke.jsonc --local --persist-to .wrangler/remote-smoke
```

再于根目录运行 `node runner/scripts/smoke-worker.ts`。该配置只监听 `127.0.0.1:8797`，使用合成管理员 Token、独立设备和工作区；不要部署 smoke 配置。

## 从 v1 升级

1. 使用旧版本完成或取消活动任务，确认实例停止，再释放所有旧租约。
2. 保留回执；`unknown` 必须先核对实例和可能的外部副作用，重启不等于回滚。
3. 部署获准的 Worker 版本，再更新 runner 并重新构建 guest。
4. 原配对凭据可保留，新连接发送 v2 工具声明，必须包含 `instructions` 使用说明和 `persistence` 持久化说明；缺少字段的旧 runner 也需更新。管理员列表 `protocolCompatible=false` 表示声明仍需升级。
5. v1 hello 和 `r2-source-v1` 会被拒绝。活动旧租约阻止能力版本改变，不能在未排空时切换。

## 启用与配对

在获准部署中将 `REMOTE_SANDBOX_ENABLED` 设置为 `"true"`，保留 `SANDBOX_FLEET` binding 和 v11 migration。管理 API 使用现有 `ADMIN_TOKEN`，不将管理员 Token 交给连接器。

1. `POST /admin/sandbox-devices/pairings` 获取 pairingId 和一次性 code。
2. 执行以下命令，在提示中输入配对信息：

```powershell
npm --prefix runner start -- pair --origin https://你的Worker域名 --state D:\sandbox-runner-state --name 我的Windows设备
```

Git 可追加 `--git-dir "C:\Program Files\Git"`；工具目录只读映射，不要填写项目源码或用户目录。Node 默认取连接器自身的安装目录，可用 `--node-dir` 指定；内存默认 6144 MiB，可用 `--memory` 调整。

3. `GET /admin/sandbox-devices` 核对设备配置、`tools` 声明、`instructions` 和 `persistence`。这些说明由 runner 提供，Worker 不按 provider 推断。
4. `POST /admin/sandbox-devices/{deviceId}/approve` 批准设备。
5. 检查并运行：

```powershell
npm --prefix runner start -- inspect --state D:\sandbox-runner-state
npm --prefix runner start -- run --state D:\sandbox-runner-state
```

`inspect` 不输出 Token。`run` 为前台进程，Ctrl+C 停止自身实例；未自动安装系统服务。配对响应丢失可使用同一 pairingId/code 和 state 重试；不要把配对码或设备 Token 放进聊天、日志或命令行参数。

## Agent 使用

从 owner 本人的消息或已认证网页回合提出任务。以下工具全部在 Code Mode 内通过 `tools.*` 调用：

Agent 会收到沙箱注册的使用说明，并可通过 `sandbox_list` 查看完整配置、说明和 schema。通用扩展不设 Cloudflare/WSB 优先级；平台的路径、缓存、命令及结果用法由各自注册信息决定。若更新说明，先释放活动租约，再让连接器重新注册。

| 工具 | 用途 |
| --- | --- |
| `sandbox_list` | 查看沙箱、注册工具 schema、需求不匹配原因和本会话租约 |
| `sandbox_acquire` | 按 sandboxId/capabilityRevision 获取租约，返回 id |
| `sandbox_call` | 以 leaseId、tool、arguments、timeoutMs 提交任务 |
| `sandbox_job` | 按 jobId 查询；`action: "cancel"` 请求取消 |
| `sandbox_release` | 按 leaseId 请求停止 guest 并释放租约 |

```ts
const job = await tools.sandbox_call({
  leaseId: "上一步返回的租约 id",
  tool: "powershell",
  arguments: {
    cwd: "C:\\AgentWork\\repo",
    command: "npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm.cmd test"
  },
  timeoutMs: 1200000
});
text(job);
```

默认 cwd 为 `C:\AgentWork`；用 PowerShell 中的 git clone 或文件命令准备源码。后续命令复用 `.git`、`node_modules` 和文件，不继承变量或当前目录。文件不进入 Cloudflare `/work`，也不由 R2 自动恢复。

租约空闲约 10 分钟后请求释放。及时查询并保存需要保留的修改；释放、取消、连接器退出或实例故障都可能丢失 guest 文件。未推送的提交不能当作永久备份。

## 状态与恢复

- `dispatched/accepted`：已提交或已接纳，尚未证明执行成功。
- `completed`：检查 `outcome.result`；PowerShell 的 code=0 表示进程成功退出，还需核对实际测试结果。
- `cancel_requested`：等待停止确认，不立即复用槽位。
- `unknown`：不盲目重跑；恢复连接器或请求取消并确认实例停止。
- `sessionLost` 或租约 `lost`：释放旧租约后重新获取；新租约是空工作区。
- `releasing`：等待停止握手；租约从 `sandbox_list.sessions` 消失才完成释放。
- 回传失败：保留 `state/jobs`，connector 从 journal 回传已有结果，不重新执行。

设备永久失联时，管理员核对实例和外部副作用后可封存：

```text
POST /admin/sandbox-devices/jobs/{jobId}/abandon
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{"acknowledgeUnknownExecution":true}
```

封存只表示接受未知结果，不证明远端停止，也不能撤销 GitHub 等副作用。租约失效，设备仍需停止握手后才能复用。该操作不向 agent 暴露。

撤销设备使用 `DELETE /admin/sandbox-devices/{deviceId}`。关闭开关前处理活动任务并释放租约。远程文件导出、跨租约缓存、自动完成通知和自动 PR 发布不属于当前实现。
