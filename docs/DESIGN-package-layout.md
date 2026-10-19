# 包结构与分层整理（2026-10-19）

用户要求：在观测面板 v2 收尾后，顺手把"包之间耦合过度"的问题整理掉。本文是约束实施的设计，§7 记录验收。

## 0. 现状（2026-10-19，commit c856372）

用脚本统计 `src/` 下目录间的 import（类型与值一并计入）：

| 指标 | 数值 |
|---|---|
| 目录 / 文件 / 行数 | 13 / 115 / 16,640 |
| 跨目录依赖对 | 62 |
| 双向依赖（包级环） | 19 |
| 文件级直接互引 | `log.ts` ↔ `obs/redact.ts`；`obs/http.ts` ↔ `obs/sessions/http.ts` |

问题按影响排序：

1. **横切工具寄生在 `obs/`**：`obs/redact.ts`（8 个包引用）、`obs/trace.ts`（6）、`obs/usage.ts`（4）、`obs/errors.ts`，加上根目录 `log.ts`（7），且 `log.ts` 反向 import `obs/redact.ts`。结果所有业务包都"依赖观测层"，掩盖真实依赖。
2. **图片 / 媒体功能摊在 5 个包、17 个文件、约 1,900 行**：`agent/image-*`（7 文件）、`agent/qwen-workflow.ts`、`agent/pi-tools/images.ts`、`qq/image.ts`、`qq/image-header.ts`、`qq/incoming-http.ts`、`context/media.ts`、`context/media-recall-server.ts`、`obs/image.ts`、`obs/image-events.ts`、`mcp/image-gen*.ts`、`mcp/media-recall-client.ts`。`context/media.ts` 一个文件 import 6 个 `qq/` 模块。
3. **`obs/http.ts` 863 行枢纽**：路由表 28 个分支 + 页面渲染 + CSRF + 提示词编辑 + 会话/记忆二次分发，import 了 `agent`、`context`、`mcp`、`config`；`obs ↔ obs/ui`、`obs ↔ obs/sessions`、`obs ↔ obs/memory` 三个环都经过它。
4. **`agent/` 平铺 28 文件**：codex-*（7 文件约 1,400 行）、image-*、pi-* 三簇混放；`agent/backends → agent` 14 条、反向 6 条；`backends/types.ts` 从 971 行的 `codex-runner.ts` 取类型。
5. **传输层回调业务层**：`qq/bridge.ts → agent/dispatch.inboundFromTicket`，而该函数的入参出参类型都在 `qq/types.ts`。
6. **核心记忆层依赖观测层**：`context/aging.ts → obs/memory/instrumentation`（类型）、`obs/usage`、`obs/trace`；`obs/memory/read.ts → obs/ui/html.scopeLabel`（后端依赖 UI）；`obs/store.ts → obs/memory/instrumentation.ensureMemoryTables` 而 `obs/memory/*` 又 import `obs/store`。
7. **`config.ts` 不是叶子**：import `agent/router`、`agent/backends/select`、`context/access` 的解析函数。
8. **`obs ↔ mcp`**：`obs/http.ts`、`obs/memory/http.ts` 直接 import `mcp/qq-context-server.callQQContextTool`（为了和模型走同一条路径，决定正确，位置不对）；`mcp` 又 import `obs/memory/instrumentation`、`obs/image`。

可接受、不动的：`obs/context → obs/sessions`（分析器依赖会话模型，12 条，内聚合理）；`mcp → context/agent`（薄适配层）；`obs/ui → obs/memory`、`obs/ui → obs/sessions` 全为类型 import。

## 1. 目标分层

自下而上，**只允许向下 import**（含 `import type`；不区分类型与值，规则才简单可查）：

| 层 | 目录 | 职责 | 允许 import |
|---|---|---|---|
| 0 | `shared/` | 日志、脱敏、trace 事件总线、usage 字段、错误类型、数字格式化 | 仅 node 内建与第三方 |
| 1 | `config.ts` | 环境变量 → 原始配置值（zod） | shared |
| 2 | `media/` | 图片下载/校验/魔数、生图流水线（ComfyUI/Qwen）、生图任务与清单、图片事件 | shared, config |
| 3 | `qq/` | OneBot 传输、票据、策略、入站消息类型（`qq/types.ts` 同时是领域类型） | shared, config, media |
| 4 | `context/` | 消息库、衰老、格式化、媒体持久化、media-recall 服务、`qq_context` 工具门面、观察者接口 | shared, config, qq, media |
| 5 | `agent/`（含 `agent/codex/`、`agent/backends/`、`agent/pi-tools/`） | 分流、派发、任务、后端、codex 运行器 | ≤4 |
| 6 | `obs/`（含 `obs/sessions`、`obs/context`、`obs/memory`、`obs/ui`） | 观测存储、仪表盘、会话索引、上下文分析、记忆可视化 | ≤5 |
| 7 | `mcp/` | stdio MCP 进程入口与服务实现（`qq_context`、`image_gen`、media-recall 客户端） | ≤6（独立进程需要自己打开 `obs/memory/instrumentation`） |
| 8 | `main.ts` | 组合根 | 任意 |

`obs/` 内部子层：`obs/ui` 只可 import `obs/sessions/types`、`obs/memory/types`、`obs/context/types` 与 `shared`；`obs/memory`、`obs/sessions`、`obs/context` 不可 import `obs/ui`、`obs/http.ts`；`obs/sessions` 不可 import `obs/context`（路由移走后）；`obs/context` 可 import `obs/sessions`。`agent/` 内部：`agent/backends/types.ts` 与 `agent/backends/select.ts` 不可 import 任何实现文件（`codex-runner`、`docs` 之外的具体后端）。

**不可移动的入口**（被 `Dockerfile`、`config.toml`、`scripts/entrypoint.sh`、`docs/DEPLOY.md` 以 `dist/...` 路径引用）：`src/main.ts`、`src/mcp/qq-context.ts`、`src/mcp/image-gen.ts`。

## 2. 分组与搬迁对照表

每组一个分支内若干提交，用 `git mv` 保留历史；每条提交只做一件事（搬一组文件 + 改 import，或只改一个接口）。行为零变化，不改任何对外路由、API、文件格式、配置键。

### P0 横切工具归位、断掉最便宜的环

| 现位置 | 新位置 | 说明 |
|---|---|---|
| `src/log.ts` | `src/shared/log.ts` | |
| `src/obs/redact.ts` | `src/shared/redact.ts` | 与 log 的互引消失：log 不再 import redact 之外的东西，redact 不 import log |
| `src/obs/trace.ts` | `src/shared/trace.ts` | `Trace`、`LiveEvent`、`trace()` |
| `src/obs/usage.ts` | `src/shared/usage.ts` | `usageFields` |
| `src/obs/errors.ts` | `src/shared/errors.ts` | |
| `obs/ui/context-bar.ts` 中的 `fmtPct`/`fmtShort`/`ratio`/`toContextUsage` 等纯计算 | `src/shared/format.ts` | `context-bar.ts` 只留 HTML；`obs/live.ts` 改 import shared |
| `agent/dispatch.ts: inboundFromTicket` | `src/qq/ticket.ts`（或并入 `reply-store.ts`） | `qq/bridge.ts` 与 `agent/dispatch.ts` 都从 qq 取；qq 成为叶子 |
| `obs/http.ts: SseWriter / sseWriter / csrfToken` | `src/obs/http-util.ts` | `obs/sessions/http.ts`、`obs/live.ts` 改 import http-util |
| `obs/sessions/http.ts` 中 `/context` 路由分支 | `src/obs/context/http.ts` | 由 `obs/http.ts` 挂载；`obs/sessions` 不再 import `obs/context` |
| `obs/ui/html.ts: scopeLabel` | `src/context/access.ts` | 作用域语义属于 context；`obs/memory/read.ts`、`obs/ui` 都从那里取 |
| `obs/memory/instrumentation.ts: ensureMemoryTables` | `src/obs/store.ts`（或新建 `obs/schema.ts`） | 表结构归存储层；`obs/memory/*` 单向依赖 `obs/store` |
| `mcp/qq-context-server.ts: callQQContextTool` 及其依赖的结果拼装 | `src/context/qq-context-tool.ts` | `mcp/qq-context-server.ts` 变薄：注册工具、注入 `onRecall`；`obs/http.ts`、`obs/memory/http.ts` 改 import context |
| 新增 `test/architecture/deps.test.ts` | | §3 的依赖规则测试；P0 末尾带"临时例外清单"（P1/P2 要消的边），P2 末尾清单为空 |

### P1 `media/` 包

| 现位置 | 新位置 | 说明 |
|---|---|---|
| `qq/image-header.ts` | `media/header.ts` | 魔数校验 |
| `qq/incoming-http.ts`（`downloadImage`、`DownloadHooks`） | `media/download.ts` | `qq/incoming.ts`、`context/media.ts` 改 import |
| `qq/image.ts` 中的尺寸常量与通用校验 | `media/limits.ts` | QQ 消息段（`prepareImages`、`ImageSegment`）留在 `qq/image.ts`，改为 import media |
| `agent/image-gen.ts` | `media/gen/image-gen.ts` | ComfyUI 流水线 |
| `agent/image-references.ts`、`image-collect.ts`、`image-options.ts`、`image-pending.ts`、`image-files.ts`、`qwen-workflow.ts` | `media/gen/*.ts` | |
| `obs/image.ts`（`ImageBackend` 的 trace 包装） | `media/gen/observed.ts` | 依赖 shared/trace，不再属于 obs |
| `obs/image-events.ts` | `media/gen/events.ts` | 若阅读后发现它本质是观测存储表，则留在 `obs/` 并改为 `main.ts` 注入；由实施者读代码后决定并在报告中说明 |
| `context/media.ts`、`context/media-recall-server.ts`、`mcp/media-recall-client.ts`、`mcp/image-gen*.ts`、`agent/pi-tools/images.ts`、`agent/docs.ts` | 不动 | 只改 import 指向 `media/` |

规则：`media/` 不可 import `qq/`（包括 `qq/types`）、`context/`、`agent/`、`obs/`、`mcp/`。

### P2 `agent/codex/`、接口文件去实现依赖、config 成叶子、观察者接口

| 现位置 | 新位置 / 改法 | 说明 |
|---|---|---|
| `agent/codex-runner.ts`、`codex-prompt.ts`、`codex-trace.ts`、`codex-context-usage.ts`、`codex-model-catalog.ts`、`codex-workspace.ts` | `agent/codex/{runner,prompt,trace,context-usage,model-catalog,workspace}.ts` | |
| `auth/codex-oauth.ts` | `agent/codex/oauth.ts` | 单文件包并入 |
| `agent/backends/types.ts` import `ThreadKey`（codex-runner）、`TicketSource`（docs） | 类型移到 `agent/backends/types.ts` 自身或 `agent/codex/types.ts`；`agent/docs.ts` 不再被接口文件 import | 接口文件只依赖类型文件 |
| `config.ts` import `parseImagePrefixes`、`parseBackendOverrides`、`resolveOwner` | `config.ts` 只输出原始字符串/数组；解析下沉到 `agent/router.ts`、`agent/backends/select.ts`、`context/access.ts` 的构造处（或 `main.ts` 组合时解析） | `config.ts` 只 import zod 与 shared |
| `context/aging.ts` → `obs/memory/instrumentation`（类型）；`agent/pi-tools` → `obs/memory` | 在 `context/observer.ts` 定义 `SummaryObserver` / `RecallObserver` 接口（即 instrumentation 现有方法签名的子集）；`obs/memory/instrumentation.ts` 实现它；`main.ts` 注入；`mcp/` 独立进程仍可直接 `MemoryInstrumentation.openOwn` | context、agent 不再 import obs |
| `obs/http.ts` | 只保留 `createDashboard` 路由挂载与页面 shell，目标 ≤ 300 行；页面体与 API 分别在 `obs/ui/*`、`obs/sessions/http.ts`、`obs/memory/http.ts`、`obs/context/http.ts` | 已有分发结构，主要是把内联页面体搬到 `obs/ui/dashboard-pages.ts` |

## 3. 依赖规则测试（`test/architecture/deps.test.ts`）

- 扫描 `src/**/*.ts` 的静态 `import`/`export … from`/`import()` 相对路径，归到包：`shared`、`config`、`qq`、`media`、`context`、`agent`（含子目录）、`obs`（含子目录）、`mcp`、`main`。
- 断言：每条跨包边 `A → B` 满足 `layer(B) ≤ layer(A)`，且满足 §1 的 `obs/` 内部、`agent/` 内部与 `media/` 规则。
- 维护一个 `ALLOWED_EXCEPTIONS: Array<[from, to]>`，P0 时列出 P1/P2 待消的边，并断言**每条例外仍然存在**（防止例外过期不清）；P2 结束时清单为空。
- 失败信息列出违规的文件对，便于定位。脚本复用主会话的统计方式（见 scratchpad `depgraph.mjs` 的正则），但只认 `src/`。

## 4. 验收（主会话亲自做）

每组各一次：

1. `npm run typecheck`、`npx vitest run` 全绿（Windows 偶发 worker exit 3221226505 / "bad port" 为已知抖动，单独重跑）；`deps.test.ts` 绿且例外清单与本文一致。
2. `npm run build` 后 `dist/main.js`、`dist/mcp/qq-context.js`、`dist/mcp/image-gen.js` 存在。
3. 从干净的 detached worktree 构建镜像、部署（与 cs-agent-b7 串行），容器健康无告警；浏览器 smoke（已有 `smoke-o6.mjs` / `smoke-mem.mjs` / `smoke-recall-ui.mjs`）零错误；`smoke-mcp-recall.mjs` 以真实 stdio 进程调用 `qq_search` 成功并写入召回事件。
4. 重新跑依赖统计：P0 后包级环 ≤ 10；P2 后为 0；`obs/http.ts` ≤ 300 行。
5. `docs/ARCHITECTURE.md` §4"目录与模块归属"更新为新布局；本文 §7 写验收记录。

## 5. 非目标

- 不拆 `obs/context` 与 `obs/sessions`；不把 `mcp/` 的适配层再抽象。
- 不改任何行为、路由、数据格式、配置键、`dist/` 入口路径；不借机重写 `codex-runner.ts` 或 `image-gen.ts` 内部。
- 不引入新依赖（不装 dependency-cruiser / madge，自写测试即可）。

## 6. 协调

- 另一会话 cs-agent-b7 有一个进行中的改动（删除 codex 回复 relay 转写与代码清洗），涉及 `agent/reply-postprocess.ts`、`config.ts`、`agent/settings.ts`、`agent/docs.ts`、`agent/dispatch.ts`、`agent/tasks.ts`、`main.ts`、`obs/http.ts`、`obs/live.ts`、`obs/usage.ts` 等。双方约定：它先合入并部署，然后发消息；本重构在其之后从 main 开 `refactor/package-layout` 分支。期间 main 只接受纯文档提交。
- 重构落地后把 §2 的对照表发给 cs-agent-b7 作为 rebase 依据。
- 实施全部交给子代理（Codex gpt-6-astra），P0 → P1 → P2 顺序在同一分支上进行，组间由主会话验收后再继续。

### 6.1 P0 实际搬迁对照

本轮只实施 P0。整文件迁移使用 `git mv`；从大文件抽出的函数保持原有逻辑与输出。兼容导出保留在下表注明的原模块，供另一会话 rebase 时逐项核对。

| 旧路径 | 新路径 | 移动的导出 / 逻辑 |
|---|---|---|
| `src/log.ts` | `src/shared/log.ts`；实现位于 `src/shared/log-core.ts` | `log`、`logBuffer`、`setLogLevel`、`LogLine` |
| `src/obs/redact.ts` | `src/shared/redact.ts`；核心位于 `src/shared/redact-core.ts` | `registerSecrets`、`registerTemporarySecrets`、`withoutSecretEnv`、`redactText`、`redact`；环境初始化保留在门面 |
| `src/obs/trace.ts` | `src/shared/trace.ts` | `Trace`、`trace`、`LiveEvent`、`EventOptions` |
| `src/obs/store.ts` | `src/shared/trace.ts` | `ObsEvent`；store 保留类型重导出；新增结构契约 `TraceStore` 代替对 `ObsStore` 的类型依赖 |
| `src/obs/usage.ts` | `src/shared/usage.ts` | `Usage`、`usageFields`、`usageCost` |
| `src/obs/errors.ts` | `src/shared/errors.ts` | `Failure`、`classifyFailure`、`diagnosticFailure` |
| `src/obs/ui/context-bar.ts` | `src/shared/format.ts` | `ContextUsage`、`ContextUsageView`、`STALE_MS`、`toContextUsage`、`fmtInt`、`fmtShort`、`ratio`、`usageWindow`、`fmtPct`、`sortUsage`；原模块重导出这些名字；私有计算 `num/clampPct/tier/hoursAgo` 一并搬走 |
| `src/agent/dispatch.ts` | `src/qq/ticket.ts` | `inboundFromTicket`；dispatch 保留兼容重导出 |
| `src/agent/router.ts` | `src/qq/ticket.ts` | `legacyRouteText`；票据转换依赖它，必须一并下沉；router 保留兼容重导出 |
| `src/obs/http.ts` | `src/obs/http-util.ts` | `SseWriter`、`sseWriter`、`csrfToken` 及 SSE 队列常量；http 保留重导出 |
| `src/obs/sessions/http.ts` | `src/obs/context/http.ts` | `/api/agents/:backend/sessions/:id/context` 分支，由新增 `createContextRoutes` 承载；dashboard 挂载；会话查找与路径段校验通过原模块的 `sessionLookup/segment` 复用 |
| `src/obs/ui/html.ts` | `src/context/access.ts` | `scopeLabel`；html 保留兼容重导出 |
| `src/obs/memory/instrumentation.ts` | `src/obs/schema.ts` | `ensureMemoryTables`；store 与 instrumentation 共同调用，原模块保留重导出，`openOwn` 仍独立建表 |
| `src/mcp/qq-context-server.ts` | `src/context/qq-context-tool.ts` | `callQQContextTool`、查询和结果拼装；共享依赖类型为 `QQContextToolDeps`，另公开三个限额常量与 `qqContextText`；MCP 模块保留注册、图片回调、`QQContextDeps` 及调用函数的兼容重导出 |
| `src/mcp/recall-results.ts` | `src/context/recall-results.ts` | `returnedLines`、`returnedMessage` |

实现说明与设计澄清：

- 日志与脱敏除 `redact-core.ts` 外还抽出 `log-core.ts`。依赖为 `log → redact → log-core → redact-core`（log 也重导出 log-core）；这样单独使用脱敏时，长期秘密容量告警仍经过相同日志级别、缓冲区和订阅出口，不丢失原行为。shared 内部无文件级环。
- `ObsEvent/TraceStore` 的归位仅为清除 shared 对 obs 的类型依赖；P2 的记忆观察者接口没有提前实施，相关类型边列入下方例外。
- §1 的 UI 白名单与 P0 的 `scopeLabel → context/access` 要求冲突。本轮依照具体的 P0 条目，将 `context/access.ts` 作为 UI 的允许依赖；其他 UI 限制不变。该明确允许项不计入待清理例外。
- 设计未列入层表的 `src/fs-check.ts` 按 shared 底层工具检查；`src/auth/codex-oauth.ts` 按 agent 检查。两者物理路径未动，OAuth 搬迁仍留给 P2。
- 依赖测试扫描静态 import、export-from 与静态 import()，包括类型查询；使用正则并先遮蔽注释和普通字符串，不新增依赖。例外按具体文件对记录，过期、重复或新增违规均失败。

P0 最终临时例外共 16 条（与 `test/architecture/deps.test.ts` 完全对应）：

| 阶段 | from | to |
|---|---|---|
| P1 | `src/agent/pi-tools/images.ts` | `src/obs/image.ts` |
| P1 | `src/agent/tasks.ts` | `src/obs/image-events.ts` |
| P1 | `src/agent/tasks.ts` | `src/obs/image.ts` |
| P2 | `src/agent/backends/pi.ts` | `src/obs/sessions/pi-adapter.ts` |
| P2 | `src/agent/backends/select.ts` | `src/agent/backends/pi.ts` |
| P2 | `src/agent/backends/types.ts` | `src/agent/docs.ts` |
| P2 | `src/agent/backends/types.ts` | `src/agent/codex-runner.ts` |
| P2 | `src/agent/pi-tools/index.ts` | `src/obs/memory/instrumentation.ts` |
| P2 | `src/config.ts` | `src/context/access.ts` |
| P2 | `src/config.ts` | `src/agent/router.ts` |
| P2 | `src/config.ts` | `src/agent/backends/select.ts` |
| P2 | `src/config.ts` | `src/agent/backends/types.ts` |
| P2 | `src/context/aging.ts` | `src/obs/memory/instrumentation.ts` |
| P2 | `src/context/qq-context-tool.ts` | `src/obs/memory/instrumentation.ts` |
| P2 | `src/context/recall-results.ts` | `src/obs/memory/instrumentation.ts` |
| P2 | `src/obs/ui/memory-pages.ts` | `src/context/aging.ts` |

其中 `pi → pi-adapter`、`select → pi`、`config → backends/types`、`memory-pages → aging` 是扫描确认的现有边，P2 需连同原表列出的边一起处理。当前媒体代码仍在原包内，尚无违反 media 规则的实际文件边，未为不存在的边预留例外。

## 7. 验收记录

### P0 本地验收（2026-10-19）

- 分支 `refactor/package-layout`；工作目录 `D:/project/cs_agent-layout`。只实施 P0，未构建镜像、未部署，未修改 data/ 或入口脚本。
- `npm.cmd run typecheck` 通过；依赖规则测试 13 项通过。
- 主会话在沙箱外完成全量验收：`npm run typecheck` 两个 tsconfig 均无错误；`npx vitest run` 为 **77 passed / 1 skipped 测试文件，1089 passed / 2 skipped 测试项**，耗时约 89 秒，包含本轮 architecture 测试，无超时。此前本执行沙箱因 taskkill 权限和 shell 目录可写性检查导致环境相关失败；沙箱外自动审批曾因模型容量不足未执行，最终采用主会话提供的同 worktree 全绿结果。
- `npm.cmd run build` 通过；`dist/main.js`、`dist/mcp/qq-context.js`、`dist/mcp/image-gen.js` 均存在，入口路径保持不变。
- 当前 123 个源文件、466 条去重文件依赖边、59 条跨目录依赖对；按 §0 相同口径（物理目录、双向边对，非所有简单环枚举）包级环为 **7 对**，满足 P0 ≤ 10。
- 7 对分别为：`src ↔ src/obs`、`src/agent ↔ src/agent/backends`、`src/agent ↔ src/agent/pi-tools`、`src/agent ↔ src/obs`、`src/context ↔ src/obs/memory`、`src/obs ↔ src/obs/memory`、`src/obs ↔ src/obs/sessions`。
- `docs/ARCHITECTURE.md` §4 已同步布局。P1/P2、容器验收与浏览器 smoke 留待后续阶段；本轮任务说明明确排除镜像与部署。
