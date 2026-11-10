# 沙箱工具注册与 Code Mode

更新日期：2026-11-10。远程功能默认关闭；启动与升级步骤见[运行说明](REMOTE-SANDBOX-RUNBOOK.md)。

## 调用方式

所有沙箱工具只允许 Code Mode 调用。Cloudflare 保留有明确参数类型的 `bash/read/write/edit`；远程设备把工具声明注册到管理服务，由固定的 `sandbox_call` 分派。选中远程设备不会改变 Cloudflare 文件工具的目标。

```ts
const { sandboxes, resources } = await tools.sandbox_list({
  requirements: { os: "windows", tools: ["powershell"] }
});
const device = sandboxes.find(x => x.provider === "windows-wsb" && ["ready", "busy"].includes(x.availability));
if (!device) throw new Error("没有可用 WSB");
const resource = resources.find(x => x.providerId === device.id);
if (!resource) throw new Error("没有可用资源");
const lease = await tools.sandbox_acquire({
  sandboxId: resource.id, capabilityRevision: device.capabilityRevision
});
const job = await tools.sandbox_call({
  leaseId: lease.id, tool: "powershell",
  arguments: { command: "Get-ChildItem", cwd: "C:\\AgentWork" },
  timeoutMs: 120000
});
text({ leaseId: lease.id, jobId: job.jobId });
```

同一次 Code Mode 调用即可查询、获取租约、提交命令，不需要动态安装新 callable。异步命令通过后续 `tools.sandbox_job({jobId})` 查询；`completed` 只表示返回了工具结果，PowerShell 仍需检查 `outcome.result.code`。

```ts
// Cloudflare Linux 工作区始终使用自己的文件工具。
text(await tools.bash({ command: "pwd" }));
const file = await tools.read({ path: "out/report.png" });
if (file.kind === "image") image(file.image);
else text(file.text);
```

## 按资源 ID 分配

`sandbox_list.sandboxes` 中的 `cloudflare`、`remote:<deviceId>` 是提供方或设备 ID；`resources[].id`（`sbx:...`）才是具体沙箱资源。资源 ID、运行租约 ID 和 VM ID 分开：重建 VM 或更换租约不会改变资源 ID。默认 Cloudflare 与 WSB 资源沿用旧工作区位置，不移动已保存文件。

主 agent 通过 Code Mode 调用 `sandbox_create({providerId, sourceId?})`，只决定创建资源还是从哪个资源克隆。提供方通过 `resourceLifecycle.create` / `resourceLifecycle.clone` 声明能力、复制范围、准备时点和持久化语义；管理服务验证并转发请求，不推断仓库结构、Git 提交或分支。Cloudflare 提供方在创建时固定源码快照版本并幂等导入；远程提供方接收冻结的 `resourcePreparation` 指令，在首次工具命令前完成准备。登记远程资源不占设备槽位。跨提供方克隆和未声明的能力明确拒绝。

派出时用模型工具 `subagent({action:"spawn", task, sandboxId})` 分配资源。相同 ID 共享；需要独立工作时先创建新 ID，也可以把这个新 ID 分给多个子 agent。省略 ID 继承父会话默认 Cloudflare 资源。spawn 不创建或克隆目录；已派出的旧任务仍保持原有独立工作区，新任务保存明确绑定。资源只在本会话的已有授权下可用，知道 ID 不代表有权访问。

Cloudflare 主 agent 的 `read/write/edit/bash` 接受可选 `sandboxId`，省略时仍指向本会话默认资源；`read.workspace` 与 `sandboxId` 不能同时使用。子 agent 的工具固定路由到分配资源。分配远程资源时只安装远程调用工具，不提供另一个隐含 Linux 工作区。共享写入由 agent 协调文件范围；同资源已经共享，管理台禁止再做父子合并。

远程多个 agent 获取同一资源会加入同一个运行租约。Fleet 单独保存调用者引用，任务仍按调用者归属：不能查询或取消其他 agent 的命令。释放/结束只退出自己的引用，最后一位退出才请求停止；空闲租约仍按十分钟回收。资源登记与持久文件不会因引用退出删除，当前版本不提供删除资源或清除持久目录的工具。

设备仍只有一个执行槽：同资源并发命令返回 `job_running`，另一资源正在占用设备时返回 `busy`。WSB 取消正在运行的命令、超时或连接器故障仍可能销毁整个 VM，让共享租约返回 `session_lost`；这不删除资源或持久目录。各持有者退出旧租约并等停止确认后，可对同一资源重新获取租约。不要把资源 ID 稳定误解为运行进程永久存在。

## 组件职责

| 组件 | 职责 |
| --- | --- |
| 公共 Code Mode 运行时 | 每个 Harness 一个脚本运行时；主 agent 和 coding-only 子 agent 均有入口；MCP 刷新不重建它 |
| `cs.sandbox` extension | 资源摘要、租约、远程调用与查询；按操作核验持久任务授权、当前身份与 generation |
| `SandboxFleetDO` | 配对、批准、注册工具目录、能力版本、单槽位、任务回执和 WSS 调度；不处理远程源码 |
| runner connector | 主动连接 Worker，保管 DPAPI 凭据，记录 journal，回传结果；宿主仅执行固定生命周期操作 |
| WSB backend / guest | 每个租约复用一个 VM；guest 工具表目前仅有 `powershell`；命令实际发生在 guest |
| `SandboxDO` / `WorkspaceManager` | 独立的 Cloudflare 工作区、R2 manifest/blob、资产导出、子工作区 clone/merge 与版本检查 |
| Cloudflare native adapter | 官方 `Files` 与原生 `Container.exec`；不再运行自建 HTTP 控制服务 |

远程协议 v2 的核心数据：

```ts
type ToolDeclaration = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};
type ToolCall = {
  leaseId: string;
  tool: string;
  arguments: JsonObject;
  timeoutMs: number;
};
```

设备同时声明 provider、OS、架构、配置内存、时限、并发数及可选的软件版本清单。`tools` 是实际可调用工具，Node/npm/Git 版本属于 `environment`。声明只接受有界的基础 JSON Schema，禁止外部引用和正则，并限制目录、深度和输入/输出大小。Fleet 按注册 schema 校验，runner 按自身工具表再验。新设备可注册自己的工具，不需要增加宿主任务类型。

沙箱提供方必须在注册时提交 `instructions`（1～4000 字符）和 `persistence`（1～1000 字符）。前者说明适用任务、命令或工具用法、路径、会话状态和结果解读，后者说明文件与缓存的保留范围。单个工具的参数仍由 `description` 和 `inputSchema` 描述。使用说明只适用于对应沙箱，不能改变宿主权限或获取其他工具授权。

通用扩展只负责目录、选择、租约、调用和查询，不写死厂商、操作系统、Shell 或退出码格式。它把注册说明加入动态摘要，完整 `sandbox_list` 也返回这些字段；Agent 按需求与说明选择。`codeModeTools` 表示可直接调用的内置工具，远程 `tools` 则经租约分派，获取租约不会改变其他工具的执行目标。

Cloudflare 的注册信息与提示由 `workers/src/sandbox/registration.ts` 提供，主 agent、子 agent 和目录都使用该提供方模块；WSB 的说明由 runner 的 `descriptor()` 注册。其他沙箱可声明完全不同的工作目录、状态保留和结果格式，无需修改通用扩展。使用说明参与完整声明的 `capabilityRevision`：空闲时重新注册会更新摘要，活动租约期间禁止改变。

包含递归 JSON 的目录、输入和结果通过 DO 的 `*Json` RPC 传输，在消费边界解析验证，避免 Cloudflare RPC 类型对递归 schema 的无限展开。该传输细节不暴露给模型。

## 权限、租约和执行回执

1. 管理员创建一次性配对码。设备提交凭据摘要和声明，批准后才可连接、领取任务。
2. `capabilityRevision` 覆盖完整声明；租约固定设备、工作区和版本，有效期间不能修改声明。
3. 每设备一个活动运行租约、一个执行槽；同资源可有多个调用者引用。每次调用携带 leaseId，旧租约不能改道到新设备。
4. Code Mode 入口按沙箱或 MCP 权限放行，各叶工具仍逐次授权。沙箱授权保存到 `sandbox_tasks`，输入经 `sandbox_task_inputs` 绑定；已签发授权不因回合类型变化而失效，但仍要求身份、scope、回复入口和 generation 一致。仅可信用户输入可以签发，当前自动接续子 agent 回报，普通事件或定时输入不自动获权。
5. 子 agent 引用派出时的任务授权，逐次检查子任务状态并与授予能力取交集；取消、归档或身份降权不能恢复权限。停止会话撤销任务授权并为排队输入保留禁止重签发的绑定。旧子任务只从宿主保存且仍有效的身份与能力迁移一次。子 agent 的资源绑定由主 agent 显式选择，授权与资源标识分别检查。
6. 每次嵌套调用有独立且重放稳定的任务 ID；同 ID/参数返回已有回执，不同参数拒绝。
7. connector 在派发命令前写 journal；重启后发现已执行但无结果时返回 `unknown`，不自动重跑。
8. `unknown` 保留槽位；确认取消或管理员封存后才能解除任务等待。租约失效后仍需停止握手，不把取消请求当成停止证据。

远程权限分成 `view`（目录、结果查询）、`execute`（新租约、新命令）、`control`（取消、释放）。关闭远程任务时仅拒绝 `execute`，返回 `disabled`；没有对应任务授权时返回 `permission_denied`。目录返回 `enabled`，现有任务仍可查询和收尾，执行开关不影响 Cloudflare coding。此调整不开放非 owner 的远程目录，也不放宽技能发布或权限管理。

有界调用参数与任务回执在 DO 中原子保存，较大的工具结果放在 R2；两者都不包含远程源码、`.git` 或 `node_modules`。详细结果保留约 7 天；过期回执不能变成重新执行许可。

## WSB 的目录与生命周期

工作区位于 guest 的 `C:\AgentWork`；同一租约的命令复用 VM。设置 `dataDir` 后，项目和 npm 缓存通过 WSB 官方目录映射保留在本机专用目录，按租约工作区标识的 SHA-256 分隔；跨租约和 VM 重建继续使用同一目录。首次配置拒绝非空目录、其他设备占用、路径链接以及与 state、checkout 或工具目录重叠的路径。每次调用启动独立 PowerShell 进程，变量、`$env` 修改和 `Set-Location` 不跨调用保留；需要目录时显式传 cwd。

持久项目目录从 GitHub 拉取独立源码，不使用宿主日常开发 checkout。Node/Git/runner 工具目录只读映射，控制输入和有界结果使用专用通道，宿主不执行模型生成的 PowerShell。设备 Token 不进入 guest、命令行或模型上下文。

映射目录保留宿主所有者，guest launcher 仅为 `C:/AgentWork`、只读来源 `C:/AgentSource` 及其子目录设置 Git `safe.directory`。配置文件仅写在 guest 临时目录，使用 `GIT_CONFIG_SYSTEM` 供工具子进程继承，不修改宿主配置。WSB 共享目录不支持创建符号链接，需要链接的项目应使用 guest 临时目录；此限制随注册说明暴露给 agent。

最后一位调用者释放、空闲回收、连接器停止、取消运行中命令或实例故障会销毁 VM，但不会删除或回滚已映射的项目和缓存。未配置 `dataDir` 的设备沿用临时目录语义；Windows 系统状态及其他 guest 文件仍随 VM 丢弃。持久模式、路径和限制由 runner 的 `instructions` / `persistence` 声明，Worker 无须增加存储协议。GitHub 凭据须另行显式授权，不能映射宿主用户或凭据目录。

WSB 声明创建空资源；配置持久目录后同时声明文件级克隆，不要求配置 Git。首次执行前，来源工作区只读映射到 `C:\AgentSource`，目标独立映射到 `C:\AgentWork`。复制在 guest 内执行，涵盖整个来源目录，包括根目录文件、未提交/未跟踪文件、`.git` 和 `node_modules`；不发现仓库、不选择 HEAD、不建立分支、不调用 Git，也不改写文件中的外部路径引用。npm 下载缓存按目标资源独立持久保留，不复制来源缓存。系统状态、进程及其他 guest 目录不复制，链接明确拒绝。

WSB 为单槽位，来源须已初始化并释放运行租约后才能执行目标资源。复制读取准备时的来源文件；宿主外部程序同时改写来源时不保证一致快照。首次准备拒绝已有非空目标。宿主私有 state 保存 pending/ready 收据，不使用 guest 可修改的文件作为成功凭据；失败不执行用户命令，中断重试仅清理尚未交给用户的目标并重新读取来源。准备完成后先保存 ready 再执行工具，后续命令、新租约和连接器重启不重复复制，也不再要求来源存在。`.git` 和依赖文件独立复制；可继续调用 `npm-ensure.mjs` 检查依赖是否可复用。

升级保留原资源 ID 和已有目录；旧资源的 `sourceWorkspace` 仅作兼容读取，不触发准备。旧设备声明 `workspacePreparation` 不授予新建/克隆能力；已有资源仍可使用。已冻结旧 `workspaceSource` 初始化的租约返回 `legacy_preparation_requires_release`，须先释放。先升级 Worker，再释放活动租约并更新 runner 注册，才能使用新能力。Cloudflare 已开始的旧快照导入仍按原固定版本恢复。

guest 中的 `npm-ensure.mjs` 负责可选的依赖复用：用 manifest/lockfile、Node ABI、系统架构、npm 版本、有效配置及支持的参数形成指纹，再检查 npm 依赖结构。仅成功安装后写入收据；安装前撤销旧收据，失败和中断后重新安装。手动内容修改及本地文件依赖用 `--fresh` 重装，不把结构检查当成完整内容校验。该助手由现有 `powershell` 调用，不新增模型工具，不在宿主执行项目脚本。

WSB 与 Cloudflare `/work` 独立。Cloudflare `send_file`、资产导出和子工作区合并不会自动读取 WSB 文件；将来导出应注册明确的文件传输工具。

## Cloudflare 官方接口与持久化

使用 `@cloudflare/sandbox@1.0.3` 的 `Files` 读写文件、目录和元数据，镜像复制同版本官方 `sandbox-shim`；进程通过原生 `Container.exec` 启动。

固定的容器内 CLI 助手补充 SDK 未直接提供的 realpath 限制、整树扫描/恢复和命令进程组管理。它不监听端口；模型命令以非 root 用户运行，Worker 负责权限和源码提交。

普通源码继续写入 R2 manifest/blob，保持资产导出、容器重建恢复与子工作区 clone/merge 契约。新产生的 `.git`、`node_modules`、`.wrangler` 不进入快照，留在当前容器；空闲停止、重建或重置后缓存可能丢失。旧 manifest 已追踪的缓存文件继续遵守原持久化契约，不在升级时静默删除。

Cloudflare `read/write/edit` 在容器真实文件系统执行，成功变更再提交源码快照；R2 不是 WSB 的挂载。原有文件大小、格式和链接限制继续生效。

官方依据：[文件 API](https://developers.cloudflare.com/sandbox/reference/files/)、[SDK 迁移说明](https://developers.cloudflare.com/sandbox/sdk/migrate/)。

## 方案比较与收敛

候选 A 为每租约动态注册 typed 工具，参数提示更直接；但 Code Mode 会冻结工具表，获取租约后需下一次调用才能使用新工具，还需管理注册、撤回和旧闭包。

本次采用候选 B：远程目录作为数据，固定分派；Cloudflare 保留现有 typed 工具。接受远程参数依赖运行时 schema 校验，换取同段脚本可发现后执行。保留候选 A 的租约版本固定、逐调用授权、journal 和未知结果不重放约束。

删除旧远程 R2 源码中转、`shell.exec/node.test`、自动文件工具改道和每任务重建/复制缓存。v1 runner 必须升级；部署前先处理所有旧任务与租约。

## 验证范围与历史资料

测试覆盖无 MCP 的 Code Mode、coding-only 子 agent、同段 list → acquire → call、逐调用权限、图片、schema、版本、跨工作区访问、任务去重、未知状态和停止握手。WSB smoke 验证真实连续命令保留 Git/依赖、取消停止、文件级克隆保留未提交文件和依赖、Git 文件独立、来源只读及独立 npm 缓存。Cloudflare adapter、中文 BOM/换行、编辑歧义、缓存排除、恢复与原有资产路径保留测试。本地检查不替代生产容器验证，部署需要单独授权。

旧 v1 的 R2 源码中转图仅作历史参考，不描述当前实现：[旧时序 SVG](diagrams/remote-sandbox.svg)、[可编辑图源](diagrams/remote-sandbox.sequence.json)。
