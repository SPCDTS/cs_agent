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

连接器重连会更新注册的 `instructions`、`persistence` 和可选 `resourceLifecycle` 声明。升级前排空并释放租约，先部署支持生命周期声明的 Worker，再更新 runner、构建 guest 并重连。旧 runner 可继续使用已有资源；新版创建/克隆必须有相应能力声明。未配置 `dataDir` 的设备仍使用临时工作区，不会自动移动原有 guest 文件。

| 本机目录 | guest 路径 | 保留范围 |
| --- | --- | --- |
| `dataDir/projects/<工作区哈希>` | `C:\AgentWork` | 从 GitHub 克隆的新仓库、`.git`、`node_modules`、构建产物 |
| `dataDir/cache/<工作区哈希>/npm` | `C:\AgentCache\npm` | npm 下载缓存 |

工作区标识沿用 Fleet 租约；不同资源的可写项目目录和 npm 下载缓存隔离。显式克隆首次准备时，提供方另外将来源目录只读映射到 `C:\AgentSource`；准备完成后的新租约不再挂载来源。同一工作区的新租约、连接器重启和 VM 重建都会挂载原目录。数据仅在本机，state 中的设备凭据和准备收据不映射进 guest，Node/Git/runner 工具仍只读映射。释放、取消和超时会销毁 VM，但不回滚持久目录的写入，也不自动清理磁盘文件。Windows 注册表、服务和其余 guest 路径仍是临时状态。

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

主 agent 从 `sandbox_list.resources` 选择具体资源 ID，通过 `subagent` 的 `sandboxId` 分配：同 ID 共享工作区和运行租约，新 ID 独立；省略时继承父会话默认 Cloudflare 资源。需要新资源时，先看提供方 `resourceLifecycle` 声明，再在 Code Mode 调用 `sandbox_create({providerId})` 或传 `sourceId` 请求该提供方克隆。不要把设备 ID 或 leaseId 当作资源 ID。创建 subagent 不准备源码，也不自动克隆。创建、克隆的实现和语义属于提供方；Cloudflare 使用固定源码快照，WSB 使用文件复制。

WSB 配置持久目录后支持克隆，不要求配置 Git：首次工具调用前，guest 从只读 `C:\AgentSource` 复制整个工作区到 `C:\AgentWork`，包含未提交与未跟踪文件、`.git`、`node_modules`，不另建分支。目标文件和 npm 下载缓存各自独立；操作系统、进程、其他目录不复制，链接不支持，文件中的外部路径引用不自动改写。来源须已初始化并释放租约，复制期间不要在宿主改写来源。中断后重试重新读取来源；成功后跨租约和重启不会覆盖目标修改。已有非空目录拒绝首次初始化；复制失败不会执行用户命令。可用 `npm-ensure.mjs --prefer-offline` 验证并复用复制的依赖。GitHub 登录凭据不会自动转交。

旧设备未声明 `resourceLifecycle` 时仍可打开已有资源，但新建返回 `create_not_supported`；没有 clone 声明时返回 `clone_not_supported`。先更新 Worker，释放活动租约，再更新并重启 runner。旧资源目录原样保留，不重新初始化；旧初始化租约收到 `legacy_preparation_requires_release` 时先释放。以下工具全部在 Code Mode 内通过 `tools.*` 调用：

Agent 会收到沙箱注册的使用说明，并可通过 `sandbox_list` 查看完整配置、说明和 schema。通用扩展不设 Cloudflare/WSB 优先级；平台的路径、缓存、命令及结果用法由各自注册信息决定。若更新说明，先释放活动租约，再让连接器重新注册。

| 工具 | 用途 |
| --- | --- |
| `sandbox_list` | 查看 enabled、提供方 sandboxes、资源 resources、默认 assignedSandboxId、工具 schema 和自己的租约引用 |
| `sandbox_create` | 用 providerId 创建资源；可用 sourceId 显式克隆，返回资源 id |
| `sandbox_acquire` | 按资源 sandboxId 和提供方 capabilityRevision 加入运行租约，返回租约 id |
| `sandbox_call` | 以 leaseId、tool、arguments、timeoutMs 提交任务 |
| `sandbox_job` | 按 jobId 查询；`action: "cancel"` 请求取消 |
| `sandbox_release` | 按 leaseId 退出自己的引用，最后一位退出才请求停止 guest |

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

相同资源上的命令串行执行，并发时返回 job_running；同设备其他资源占用时返回 busy。子 agent 完成或取消只清理自己的任务和租约引用，不会取消父 agent 的命令。若取消该子 agent 自己正在执行的 PowerShell，WSB 的整机停止机制仍会使共享租约失效；确认停止后用同一资源 ID 重新获取租约。

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
