# 沙箱工具注册与 Code Mode

更新日期：2026-11-01。远程功能默认关闭；启动与升级步骤见[运行说明](REMOTE-SANDBOX-RUNBOOK.md)。

## 调用方式

所有沙箱工具只允许 Code Mode 调用。Cloudflare 保留有明确参数类型的 `bash/read/write/edit`；远程设备把工具声明注册到管理服务，由固定的 `sandbox_call` 分派。选中远程设备不会改变 Cloudflare 文件工具的目标。

```ts
const { sandboxes } = await tools.sandbox_list({
  requirements: { os: "windows", tools: ["powershell"] }
});
const device = sandboxes.find(x => x.provider === "windows-wsb" && x.availability === "ready");
if (!device) throw new Error("没有可用 WSB");
const lease = await tools.sandbox_acquire({
  sandboxId: device.id, capabilityRevision: device.capabilityRevision
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

## 组件职责

| 组件 | 职责 |
| --- | --- |
| 公共 Code Mode 运行时 | 每个 Harness 一个脚本运行时；主 agent 和 coding-only 子 agent 均有入口；MCP 刷新不重建它 |
| `cs.sandbox` extension | 资源摘要、租约、远程调用与查询；逐次检查 owner、消息来源及当前 generation |
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
3. 每设备一个活动租约、一个执行槽。每次调用携带 leaseId，旧租约不能改道到新设备。
4. Code Mode 入口按沙箱或 MCP 权限放行，各叶工具仍逐次授权。事件、其他用户、过期 generation 不能借嵌套调用使用沙箱。
5. 子 agent 的 coding 授权只授予独立 Cloudflare 工作区，不继承父 agent 的 WSB 租约。
6. 每次嵌套调用有独立且重放稳定的任务 ID；同 ID/参数返回已有回执，不同参数拒绝。
7. connector 在派发命令前写 journal；重启后发现已执行但无结果时返回 `unknown`，不自动重跑。
8. `unknown` 保留槽位；确认取消或管理员封存后才能解除任务等待。租约失效后仍需停止握手，不把取消请求当成停止证据。

有界调用参数与任务回执在 DO 中原子保存，较大的工具结果放在 R2；两者都不包含远程源码、`.git` 或 `node_modules`。详细结果保留约 7 天；过期回执不能变成重新执行许可。

## WSB 的首期行为

工作区位于 guest 的 `C:\AgentWork`；同一租约的命令复用 VM，`.git`、依赖和 npm 下载缓存自然保留，无需复制或在宿主校验。每次调用启动独立 PowerShell 进程，变量、`$env` 修改和 `Set-Location` 不跨调用保留；需要目录时显式传 cwd。

源码不映射到宿主项目目录。Node/Git 工具目录只读映射，控制输入和有界结果使用专用通道，宿主不执行模型生成的 PowerShell。设备 Token 不进入 guest、命令行或模型上下文。

释放、连接器停止、取消或实例故障会销毁 VM。释放之前把需要保留的代码保存到远程仓库等外部系统；没有跨租约缓存、持久源码或自动 PR 发布承诺。GitHub 凭据须另行显式授权，不能映射宿主用户或凭据目录。

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

测试覆盖无 MCP 的 Code Mode、coding-only 子 agent、同段 list → acquire → call、逐调用权限、图片、schema、版本、跨工作区访问、任务去重、未知状态和停止握手。WSB smoke 验证真实连续命令保留 Git/依赖和取消停止。Cloudflare adapter、中文 BOM/换行、编辑歧义、缓存排除、恢复与原有资产路径保留测试。本地检查不替代生产容器验证，部署需要单独授权。

旧 v1 的 R2 源码中转图仅作历史参考，不描述当前实现：[旧时序 SVG](diagrams/remote-sandbox.svg)、[可编辑图源](diagrams/remote-sandbox.sequence.json)。
