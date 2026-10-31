# 远程 WSB 沙箱运行说明

这是默认关闭的实验功能。实现范围和限制见 [设计文档](REMOTE-SANDBOX-DESIGN.md)。

## 准备

本机需要 Windows Sandbox、可用的 wsb CLI、Node 24+ 和 npm。Git 是可选只读工具。连接器以当前 Windows 用户运行，不需要把整台设备开放到公网。

在项目根目录安装并检查：

~~~powershell
npm run install:workers
npm run check
npm --prefix runner run test:wsb
~~~

test:wsb 会启动自己登记的 WSB，验证 npm 安装/测试、缓存复用和取消；不会停止用户其他实例。临时测试文件位于命令打印的专用临时目录，停止实例后可自行删除。

正式使用时为连接器准备独立 state 目录，例如 D:\sandbox-runner-state；不要选真实项目、用户主目录或存有其他文件的目录。state 包含源码缓存、结果与 DPAPI 加密的设备凭据，不提交 Git，也不与其他 Windows 用户共享。

## 本地完整链路验证

先运行 npm --prefix runner run build。一个终端在 workers 目录运行：

~~~powershell
npx wrangler dev --config wrangler.smoke.jsonc --local --persist-to .wrangler/remote-smoke
~~~

另一个终端在项目根目录运行：

~~~powershell
node runner/scripts/smoke-worker.ts
~~~

这个入口仅监听 127.0.0.1:8797，使用明确标记的合成管理员 Token、本地 R2 和独立测试设备。成功后脚本停止自己的连接器、撤销测试设备；关闭 Wrangler 终端即可结束本地服务。每次使用独立工作区 ID，避免旧测试任务影响重跑。不要部署 smoke 配置。

## 启用与配对

先在审核通过的部署中将 REMOTE_SANDBOX_ENABLED 设置为 "true"，保留 SANDBOX_FLEET binding 和 v11 migration。仓库默认值是 false；本说明不代表已部署。

使用管理 API，Authorization 头为现有 ADMIN_TOKEN：

1. POST /admin/sandbox-devices/pairings，得到 pairingId 和一次性 code。
2. 本机执行以下命令，然后在提示中输入配对 ID 和配对码：

~~~powershell
npm --prefix runner start -- pair --origin https://你的Worker域名 --state D:\sandbox-runner-state --name 我的Windows设备
~~~

如需 Git，可追加 --git-dir "C:\Program Files\Git"。工具目录只读映射给 guest，不能填项目 checkout。Node 工具目录默认使用运行连接器的 Node 安装目录，可用 --node-dir 指定；内存默认 6144 MiB，可用 --memory 调整。

3. GET /admin/sandbox-devices，核对设备声明。
4. POST /admin/sandbox-devices/{deviceId}/approve，批准该设备。
5. 启动连接器：

~~~powershell
npm --prefix runner start -- inspect --state D:\sandbox-runner-state
npm --prefix runner start -- run --state D:\sandbox-runner-state
~~~

inspect 不输出 Token。run 是前台进程，保持运行；Ctrl+C 请求停止其当前 WSB。首版尚未安装 Windows 服务或开机任务。

配对响应丢失可重新执行 pair，使用同一 pairingId/code 和原 state 目录；pending 凭据会被复用。配对码过期时创建新码。不把配对码或设备 Token 放到命令行、聊天或日志里。

## Agent 使用

通过 owner 本人私聊或已认证网页回合，让 agent：

1. sandbox_list，选择符合任务 OS、shell、工具版本和内存需求的目标。
2. sandbox_acquire，使用刚查询的 sandboxId/capabilityRevision 和任务类别。
3. read/write/edit 准备持久源码。
4. exec_start 提交 shell.exec 或 node.test；operation.cwd 使用 /work 或子目录。
5. exec_status 查询 jobId，确认执行退出码与 persistence.state。
6. 完成后 sandbox_release；下一条 bash 恢复默认 Cloudflare 沙箱。

shell.exec 的示例操作：

~~~json
{
  "kind": "shell.exec",
  "shell": "powershell",
  "cwd": "/work",
  "timeoutMs": 1200000,
  "command": "npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm.cmd test"
}
~~~

node.test 会在 cwd 先运行 npm ci，然后 npm run 指定 script。必须提供该包的 package-lock.json；monorepo 应选择正确包目录，或使用 shell.exec 写出完整安装/测试流程。

每个任务都会重建 node_modules。需要依赖安装、代码生成和测试连续运行时，将它们放在同一次任务中；npm 下载缓存可跨任务复用。源码快照排除 .git、node_modules、.wrangler，其余文件仍受 10/50 MiB 限制。

## 状态与恢复

- dispatch_pending：保留同一个 jobId；先查询或取消，不换机器创建重复副作用。
- completed + committed：命令结束且文件已提交；仍需检查 code 是否为 0。
- completed + conflict：远程结果未覆盖新 HEAD；云端保留任务结果约 7 天。首版未提供模型侧自动合并冲突工具。
- unknown：结果不确定，工作区保持写锁。先恢复连接器或使用 exec_cancel 并核对停止状态。
- 取消返回 requested：还没有确认停止，需要继续查询。
- HTTP/R2 回传失败：保留本机 state/jobs；不要删除目录或重新派发命令。

设备永久失联时，管理员先核对宿主实例和可能的联网副作用，再调用：

~~~text
POST /admin/sandbox-devices/jobs/{jobId}/abandon
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{"acknowledgeUnknownExecution":true}
~~~

该操作只封存云端任务并解除等待，不证明远端已经停止，也不能撤销 GitHub 等外部副作用；晚到结果会被拒绝。该接口不向 agent 暴露。

撤销设备使用 DELETE /admin/sandbox-devices/{deviceId}。最好先取消并确认活动任务已停止；离线撤销可能仍需管理员封存未知任务。关闭功能开关前先处理活动任务并释放租约。

## 已知限制

首版没有管理页、自动完成通知、Git 对象缓存、WSB 热复用或自动 PR 发布。公网部署与目标仓库兼容性需另行验证；本地 smoke 通过不代表所有项目都适合 Windows。

可写 spool 和 npm 副本没有磁盘硬配额，正式使用前需给专用 state 所在磁盘安排容量与监控。不要通过映射真实宿主目录来绕过源码配额。guest 快照超限或失效时不提交；原实例会停止，无法保证取回未成功导出的修改。
