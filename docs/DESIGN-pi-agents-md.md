# pi 后端的 AGENTS.md 支持（2026-10-19，用户要求）

用户要求：参考 pi-durable 的示例给 pi 后端加上 AGENTS.md 支持，并评估能否复用 pi coding-agent 导出的 `loadProjectContextFiles`。

## 0. 已核实的事实

- **现状**：pi 后端完全不读 AGENTS.md。它的 system prompt 只有一个来源：`data/prompts/agent.md`，由 `PiPromptLoader` 读取（按 mtime/size 缓存），以 pi-durable 的 `section("cs-pi", …, { tag: false })` 注册；pi-durable 的生成任务把所有 section 渲染成**一条 system 消息**并保持在最前（`pi.system` 条目，只在内容变化时重发以保住提示缓存）。
- **codex 侧的对照**：codex 自动读取 `$CODEX_HOME/AGENTS.md`（受管全局指引）与 cwd（`/workspace/<key>`）的 AGENTS.md；父目录 `/workspace/AGENTS(.override).md` 由 `prepareCodexWorkspace` 读出后显式带入每轮（非 Git 目录 codex 不会向上找）。AGENTS.md 在 codex 请求里以 **user 角色**注入；在 pi 里 section 进入 **system** 消息。
- **上游 `loadProjectContextFiles({ cwd, agentDir })`**（`@mariozechner/pi-coding-agent` 0.73.1，`src/core/resource-loader.ts`）：先取 `agentDir` 的全局文件，再从 `cwd` 逐级向上到文件系统根目录，每级按 `AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD` 取第一个存在的普通文件，去重，**最外层在前**；含 Git worktree 的"主仓库文件被 worktree 遮蔽"判断；同步 `fs`，读失败用 `chalk` 向 stderr 打警告。渲染为 `Project-specific instructions and guidelines:` + 每个文件一段 `<project_instructions path="…">…</project_instructions>`。
- **复用代价**：该函数只能随整个 `@mariozechner/pi-coding-agent` 一起安装，带来约 20 个依赖（pi-tui、photon wasm、undici、marked、cli-highlight、extract-zip……）以及**第二套 pi-ai**（`@mariozechner/pi-ai`，与我们用的 `@earendil-works/pi-ai` 是不同分支），镜像体积与供应链面都明显增大；函数本身是同步 fs、向上走到 `/`、打印 chalk 警告，与我们"读取受路径策略约束、绑定到 WORKSPACE_DIR、日志走 shared/log"的要求都不合。

## 1. 决定

**不引入 `@mariozechner/pi-coding-agent`；在本仓库重写同语义的加载器**（`src/agent/pi-tools/project-context.ts`，约 40 行），保留上游的候选文件名顺序、去重与"最外层在前"的拼接顺序，以及 `<project_instructions path="…">` 的渲染格式（模型对这个格式熟悉），去掉 Git 遮蔽逻辑，向上查找**止于 `WORKSPACE_DIR`**，读失败记 `log.warn`。在 `docs/THIRD-PARTY.md` 注明"语义参照 pi-coding-agent `loadProjectContextFiles`（MIT），未复制代码"。

## 2. 行为

### 2.1 文件来源（最外层在前）

| 顺序 | 路径 | 说明 |
|---|---|---|
| 1 | `${DATA_DIR}/prompts/agent.md` | 现有全局提示词，保持为独立 section `cs-pi`，位置不变（不并入下面的项目上下文） |
| 2 | `${WORKSPACE_DIR}/AGENTS.override.md`，否则 `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD` | 运维层说明，与 codex 的 `prepareCodexWorkspace` 读的是同一个文件 |
| 3 | `${DATA_DIR}/pi-work/<key 冒号换下划线>/…`（同样的候选顺序） | 会话域自己的说明；pi 的工作区由 `PiPathPolicy` 定为 `${DATA_DIR}/pi-work/<key>`（**不是** `/workspace/<key>`，2026-10-19 核实）；模型用 `write`/`edit` 可以改它（与 codex cwd AGENTS.md 同等行为） |

`agentDir` 这一级不另设：pi 没有 CODEX_HOME 的对应物，`agent.md` 已承担全局角色。第 2 级与第 3 级不在同一棵目录树上，所以不做上游那种"从 cwd 逐级向上"的遍历，而是显式读两处：`WORKSPACE_DIR` 一处、`input.env.cwd`（即 pi 工作区）一处；绝不读 `${DATA_DIR}/AGENTS.md` 或 `pi-work/AGENTS.md`。

### 2.2 读取与校验（主进程 Node fs，不经 PiExecutionEnv）

父目录 `/workspace` 不在会话工作区内，路径策略会拒绝，所以与 codex 一样由主进程读取：
- 只接受普通文件（`lstat` 非符号链接、非目录），≤ 128 KiB（与 codex 侧一致），UTF-8，去 BOM；超限或不可读 → 跳过并 `log.warn`（每个文件每次变化只警告一次）。
- 空白内容视为不存在。
- 每次 section 渲染时按 `mtimeMs:size` 戳缓存（沿用 `PiPromptLoader` 的方式），内容未变则返回同一字符串，保证 pi-durable 不重发 system 条目。

### 2.3 渲染

新增 section `project-context`（`tag: false`），排在 `cs-pi` 之后：

```
Project-specific instructions and guidelines:

<project_instructions path="/workspace/AGENTS.md">
…
</project_instructions>

<project_instructions path="/workspace/group_200000001/AGENTS.md">
…
</project_instructions>
```

没有任何文件时 section 返回 `undefined`（pi-durable 省略）。`path` 用容器内绝对路径，和模型在工具里看到的一致。

### 2.4 会话域从哪来

section 的 `input.env.cwd` 即 `PiExecutionEnv` 的 `policy.workspace`（`${DATA_DIR}/pi-work/<key>`），据此确定第 3 级目录；第 2 级目录是 `WORKSPACE_DIR`（取自 `PiBackend` 的 `workspaceDir`，通过扩展工厂参数传入）。`input.env` 缺失（例如纯文本回合没有环境）时只渲染第 2 级。读取只接受 `cwd` 恰为 `${DATA_DIR}/pi-work/` 直接子目录的情况，否则忽略第 3 级并 `log.warn`。

## 3. 改动清单

| 文件 | 改法 |
|---|---|
| `src/agent/pi-tools/project-context.ts`（新） | `loadProjectContextFiles({ cwd, workspaceDir })` + `renderProjectContext(files)` + 带缓存的 `ProjectContextLoader` |
| `src/agent/pi-tools/index.ts` | `sections` 增加 `section("project-context", input => loader.render(input.env?.cwd), { tag: false })`；扩展工厂接收 `workspaceDir` |
| `src/agent/backends/pi.ts` | 把 `workspaceDir` 传给扩展工厂（已有该值） |
| `docs/THIRD-PARTY.md` | 注明语义参照 |
| `docs/ARCHITECTURE.md` §5.x、`docs/DEPLOY.md` | pi 的提示词组成：`agent.md` + `/workspace/AGENTS.md` + `/workspace/<key>/AGENTS.md`；与 codex 的差异（system vs user 角色） |
| `test/agent/pi-project-context.test.ts`（新） | 候选顺序与 override 优先；最外层在前；去重；止于 WORKSPACE_DIR（上一级的 AGENTS.md 不被读取）；符号链接与 >128 KiB 跳过并告警；空文件省略；缓存戳不变时返回同一引用；渲染格式快照 |
| `test/agent/pi.test.ts` | 一条集成用例：工作区放 AGENTS.md 后，system 消息包含 `<project_instructions path=…>` |

不改 `agent.md` 的内容与地位；不改 codex 侧；不引入新依赖。

## 4. 与观测面板的关系

pi 的 system 基础指令在上下文分析页仍是"多段合成、暂无全文引用"。本改动之后 system 消息多一段项目上下文；O3 的 pi 适配器把整条 system 消息按一条消息估算 token，仍正确。给 pi 的 system 段做分段引用留作后续项。

## 5. 实施顺序

包结构整理 P2 正在改 `agent/pi-tools/index.ts` 与 `agent/backends/pi.ts`（观察者注入），本改动排在 P2 合入之后、附件发送 B 组（也动 pi-tools）之前或与之串行，交 Codex 子代理；主会话验收：真实容器切 `AGENT_BACKEND_OVERRIDES` 让 owner 私聊走 pi，放一个 `/data/pi-work/private_10000001/AGENTS.md`，在上下文分析页确认 system 消息包含该文件内容；同时确认 `/workspace/AGENTS.md` 的内容也在。

## 6. 验收记录

（待填）

### 本地验收

2026-10-19，在 `D:/project/cs_agent-piagents` 的 `feat/pi-agents-md` 分支完成实现。未构建镜像、未部署，也未操作运行数据目录。

- 加载器公开 API：`loadProjectContextFiles({ dataDir, workspaceDir, cwd? }): Promise<ProjectContextFile[]>`、`renderProjectContext(files): string | undefined`，以及 `new ProjectContextLoader({ dataDir, workspaceDir })` 的 `load(cwd?)` / `render(cwd?)`。文件对象为 `{ path, content }`。
- 相对 §3 的 API 草案，增加显式 `dataDir` 参数，供校验 `cwd` 是否为 `DATA_DIR/pi-work` 的直接子目录；使用已有后端参数，没有新增配置键。路径采用 §2.1 和任务说明修正后的 `/data/pi-work/<key>`，没有使用 §3 文档清单中遗留的 `/workspace/<key>`。实现另对 path 属性做 XML 转义、对 UTF-8 做严格解码；读取范围、顺序与接入行为均按设计执行。
- 每次渲染重新 lstat 候选文件，以 `mtimeMs:size` 缓存文件内容；戳未变直接复用文件对象和该 cwd 的缓存字符串。戳改变后若渲染文本仍相同，继续返回原缓存字符串。JavaScript 字符串为原始值；单测同时检查读取次数和缓存对象复用，集成测试验证连续相同回合只有一条 `pi.system`，文件更新后才新增第二条。
- `npm.cmd run typecheck`、`npm.cmd run build` 均通过。加载器、pi 后端和依赖分层定向测试共 96 项通过，其中新增加载器测试 16 项、system 集成测试 2 项。
- 全量 `npx.cmd vitest run`（附加 JSON 报告参数）首次结果：81 个文件，1123 通过、32 失败、3 跳过，共 1158 项。入口脚本的 28 项失败来自 Git Bash 无法写系统临时目录；将该次测试进程的 TEMP/TMP 指向当前 worktree 内临时目录后，28 项全部通过。综合全量与补跑结果：1151 项已通过，剩余 4 项受沙箱限制未验证成功，3 项平台跳过；不声明全量全绿。

以下 4 项已单独复跑，仍受 Windows `taskkill /T /F` 的“拒绝访问”影响，需主会话在沙箱外验证；未等待审批、未修改相关用例或业务代码：

| 文件 | 未验证成功的用例 | 结果 |
|---|---|---|
| `test/agent/codex-runner.test.ts:303` | `timeout kills the process tree and throws CodexTimeoutError` | 子进程约 20 秒自然退出，未满足 8 秒内终止断言 |
| `test/agent/backends.test.ts:98` | `two restarts while queued keep attempts at zero, then the ticket runs once (F5)` | 30 秒超时 |
| `test/agent/dispatch.test.ts:1004` | `crash after codex wrote its output but before the agentResult commit`（R1） | 测试及清理 hook 超时 |
| `test/agent/dispatch.test.ts:1024` | `crash mid-turn (marker, no output)`（R1） | 测试及清理 hook 超时 |

Windows 平台按现有条件跳过 `test/agent/pi-sandbox-linux.test.ts` 的 2 项真实 bwrap 用例和 `test/media/attach.test.ts` 的 1 项 FIFO 用例。真实容器及模型验收按任务约束未执行，留给主会话。第三方说明、架构 §5.8 和部署说明已同步；设计原文保持不变，仅在 §6 末尾追加本小节。
