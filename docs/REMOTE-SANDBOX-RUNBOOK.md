# 远程 WSB 沙箱运行说明

协议 v2：设备注册工具，WSB 只提供 `powershell`。可将项目和 npm 缓存保留到本机专用目录，跨租约复用，不与 R2 同步。首次默认关闭，在管理台 **Sandbox** 标签页启用；架构见[设计文档](REMOTE-SANDBOX-DESIGN.md)。

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

登录管理台，进入独立的 **Sandbox** 标签页，点击“启用远程任务”。开关持久保存在 Fleet 中，现有会话下一次工具调用即读取新值，无需重新部署。`REMOTE_SANDBOX_ENABLED` 仅作为尚未保存设置时的默认值，保留 `SANDBOX_FLEET` binding 和 v11 migration。管理 API 使用现有 `ADMIN_TOKEN`，不将管理员 Token 交给连接器。

1. 点击“生成配对码”，复制配对 ID 和一次性配对码；有效期 10 分钟，仅在生成时返回。离开标签页、登出或到期会清除页面显示，不写入浏览器持久存储。
2. 执行以下命令，在提示中输入配对信息：

```powershell
npm --prefix runner start -- pair --origin https://你的Worker域名 --state D:\sandbox-runner-state --data-dir D:\sandbox-data --name 我的Windows设备
```

Git 可追加 `--git-dir "C:\Program Files\Git"`；工具目录只读映射，不要填写项目源码或用户目录。Node 默认取连接器自身的安装目录，可用 `--node-dir` 指定；内存默认 6144 MiB，可用 `--memory` 调整。

3. 返回 Sandbox 标签页，刷新设备列表，展开“配置、工具与使用说明”核对设备配置、`tools`、`instructions` 和 `persistence`。这些说明由 runner 提供，Worker 不按 provider 推断。
4. 点击“批准设备”。未批准设备不能连接或执行任务。
5. 检查并运行：

```powershell
npm --prefix runner start -- inspect --state D:\sandbox-runner-state
npm --prefix runner start -- run --state D:\sandbox-runner-state
```

`inspect` 不输出 Token。`run` 为前台进程，Ctrl+C 停止自身实例；未自动安装系统服务。配对响应丢失可使用同一 pairingId/code 和 state 重试；不要把配对码或设备 Token 放进聊天、日志或命令行参数。

## 本机持久文件与依赖

`--data-dir` 必须是独立的新目录，不得使用现有项目 checkout、连接器 state、Node/Git 工具目录或它们的父子目录。首次配置要求目录为空；初始化后记录所属设备，拒绝其他设备共用。已配对设备先处理并释放活动租约、停止连接器，再配置：

```powershell
npm --prefix runner start -- storage --state D:\sandbox-runner-state --data-dir D:\sandbox-data
npm --prefix runner run build
npm --prefix runner start -- run --state D:\sandbox-runner-state
```

连接器重连会更新注册的 `instructions` 和 `persistence`。本次新增可选的 `workspacePreparation: "git-clone-v1"` 声明：升级前排空并释放租约，先部署支持此字段的 Worker，再更新 runner、构建 guest 并重连。旧 runner 可继续连接新 Worker，但不具备自动准备子仓库的能力；新 runner 不应连接尚未支持该字段的旧 Worker。未配置 `dataDir` 的旧设备仍使用临时工作区，不会自动移动原有 guest 文件。

| 本机目录 | guest 路径 | 保留范围 |
| --- | --- | --- |
| `dataDir/projects/<工作区哈希>` | `C:\AgentWork` | 从 GitHub 克隆的新仓库、`.git`、`node_modules`、构建产物 |
| `dataDir/cache/<工作区哈希>/npm` | `C:\AgentCache\npm` | npm 下载缓存 |

工作区标识沿用 Fleet 租约；不同工作区的可写项目目录隔离。子任务获得宿主签发的来源工作区时，另将来源目录只读映射到 `C:\AgentSeed`，npm 缓存改用来源工作区的缓存路径；没有来源的普通工作区维持上表映射。同一工作区的新租约、连接器重启和 VM 重建都会挂载原目录。数据仅在本机，state 中的设备凭据不映射进 guest，Node/Git/runner 工具仍只读映射。释放、取消和超时会销毁 VM，但不回滚持久目录的写入，也不自动清理磁盘文件。Windows 注册表、服务和其余 guest 路径仍是临时状态。

真实 WSB 验证发现，共享目录中创建符号链接会返回 `EPERM`。普通 npm 包可以持久安装；本地目录依赖可先 `npm pack` 再安装 `.tgz`。必须依赖符号链接的 workspace、pnpm 或构建流程应在 guest 临时目录运行，并显式保存产物；目录映射不提供原生 NTFS 的全部语义。

在沙箱内克隆仓库，再进入有 `package-lock.json` 或 `npm-shrinkwrap.json` 的项目目录：

```powershell
git.exe clone https://github.com/组织/仓库.git C:\AgentWork\repo
Set-Location C:\AgentWork\repo
node.exe C:\AgentTools\runner\npm-ensure.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd test
```

`npm-ensure.mjs` 比较 manifest、lockfile、Node/ABI、平台架构、npm 版本、有效 npm 配置和支持的安装参数，并用 `npm ls` 检查依赖结构。匹配成功标记时复用 `node_modules`，否则执行 `npm ci`；标记在安装前移除、成功后写入，安装失败或中断不会被当作成功缓存。`--fresh` 强制重装；支持 `--ignore-scripts`、`--install-links`、`--legacy-peer-deps`、`--strict-peer-deps`、`--prefer-offline`、`--offline`、`--foreground-scripts`、`--no-bin-links`、`--omit=dev|optional|peer|prod`、`--include=dev|optional|peer|prod`、`--install-strategy=hoisted|nested|shallow|linked`。修改本地 `file:` 依赖的内容或怀疑包文件损坏时用 `--fresh`，结构检查不代表逐文件内容校验。直接运行 `npm ci` 仍会重新安装；持久 npm 缓存只减少下载。

Sandbox 页每 10 秒刷新在线状态，列出当前任务和租约，可取消任务、释放租约和撤销设备。取消和释放只表示已发请求，等待连接器确认；撤销会断开连接并使设备凭据失效。内置 Cloudflare 沙箱单独显示，不受远程任务开关影响。

停用开关只阻止新配对、新租约和新任务，不中断已有任务，也不关闭结果回传、取消和释放通道；仍需按需处理任务并释放租约。设置保存采用版本检查，多页面同时修改时会提示刷新。

脚本集成仍可使用管理 API：`GET /admin/sandbox-devices/overview` 查看配置与设备，`PUT /admin/sandbox-devices/settings` 提交 `{enabled, expectedRevision}`；配对、批准和撤销分别使用 `POST /admin/sandbox-devices/pairings`、`POST /admin/sandbox-devices/{deviceId}/approve` 和 `DELETE /admin/sandbox-devices/{deviceId}`。

## Agent 使用

从 owner 本人的消息或已认证网页回合提出任务。宿主把沙箱权限保存为任务授权，用户输入和子 agent 回报绑定同一授权；工具逐次检查授权是否撤销、当前身份、回复入口、会话代次与子任务状态。停止会话会撤销已有授权，并阻止排队输入稍后重新签发；归档、身份降权或取消子任务也不能借回报恢复权限。新用户消息可以创建新授权。技能发布和权限管理仍只允许用户直接消息。

授权把远程操作分成查看、执行、管理三类。`sandbox_list` 和查询结果使用查看权；新租约及新命令使用执行权；取消和释放使用管理权。管理台的远程任务开关只额外限制执行，不撤销查看和管理权；`sandbox_list.enabled` 明确返回开关状态。此拆分不向非 owner 开放设备目录。任务授权支持宿主绑定后续输入，但当前只自动接续子 agent 回报；定时任务或普通外部事件不会仅凭文本取得授权。

主会话和子 agent 各有独立工作区，子 agent 不继承主会话的租约。对于同时配置 Git 和持久目录的新版 WSB，设备声明支持 `git-clone-v1`；宿主在子租约中填入 `workspaceSource`，模型不能指定其他来源。首次命令执行前，guest 从只读来源目录的一级 Git 仓库子目录读取当时的 HEAD，完整克隆到自己的 `C:\AgentWork`，建立 `agent/<子工作区哈希>` 分支。`.git` 对象独立，不使用硬链接或 alternates；已有子工作区不覆盖，未提交修改和 `node_modules` 不复制。主工作区根目录本身就是 Git 仓库时，不在自动发现范围，应把仓库放在 `C:\AgentWork\repo` 这样的子目录。

子任务复用主工作区的 npm 下载缓存，但首次仍需在自己的项目中运行 `npm-ensure.mjs --prefer-offline` 安装依赖；后续可复用自己的 `node_modules`。首次准备固定提交并记录进度，重试继续未完成的克隆；完成后不会随主分支前进而重置子工作区。来源没有仓库，或设备没有声明自动准备能力时，按设备说明自行克隆。GitHub 登录状态和宿主凭据不会自动转交，推送仍需明确配置。以下工具全部在 Code Mode 内通过 `tools.*` 调用：

Agent 会收到沙箱注册的使用说明，并可通过 `sandbox_list` 查看完整配置、说明和 schema。通用扩展不设 Cloudflare/WSB 优先级；平台的路径、缓存、命令及结果用法由各自注册信息决定。若更新说明，先释放活动租约，再让连接器重新注册。

| 工具 | 用途 |
| --- | --- |
| `sandbox_list` | 查看 enabled、沙箱、注册工具 schema、需求不匹配原因和本会话租约 |
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
    command: "node.exe C:\\AgentTools\\runner\\npm-ensure.mjs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm.cmd test"
  },
  timeoutMs: 1200000
});
text(job);
```

默认 cwd 为 `C:\AgentWork`；用 PowerShell 中的 git clone 或文件命令准备独立源码，不映射日常开发 checkout。后续命令复用 `.git`、`node_modules` 和文件，不继承变量或当前目录。跨租约保留范围以注册的 `persistence` 为准。文件不进入 Cloudflare `/work`，也不由 R2 自动恢复。

租约空闲约 10 分钟后请求释放。持久目录外的 guest 文件在释放、取消、连接器退出或实例故障后丢失。持久目录保留在本机磁盘，仍需按需要推送提交或备份。

## 状态与恢复

- `dispatched/accepted`：已提交或已接纳，尚未证明执行成功。
- `completed`：检查 `outcome.result`；PowerShell 的 code=0 表示进程成功退出，还需核对实际测试结果。
- `cancel_requested`：等待停止确认，不立即复用槽位。
- `unknown`：不盲目重跑；恢复连接器或请求取消并确认实例停止。
- `sessionLost` 或租约 `lost`：释放旧租约后重新获取；新 VM 重新挂载该工作区的持久目录，未启用持久目录时才是空工作区。
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

撤销设备可在 Sandbox 页操作，或使用 `DELETE /admin/sandbox-devices/{deviceId}`。远程文件导出、自动完成通知和自动 PR 发布不属于当前实现。
