# 包结构与分层整理（2026-10-19）

> 2026-10：本地 ComfyUI 生图（生图前缀路由、generate_image、image_gen MCP）已移除，本文相关段落仅作历史记录。

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

### 6.2 P1 实际搬迁对照

分层澄清：下载、魔数与尺寸校验是 QQ 传输依赖的底层能力，因此将 §1 的层序修正为 media（2）→ qq（3），且 media 禁止依赖任何 qq 模块（包括 qq/types），不增加白名单或临时例外。

本轮只实施 P1。整文件迁移使用 `git mv`，调用处同步更新 import；通用校验与媒体访问权限检查按职责拆分，函数签名和实现逻辑保持不变。

| 旧路径 | 新路径 | 移动的导出 / 逻辑 |
|---|---|---|
| `src/qq/image-header.ts` | `src/media/header.ts` | `validateImageHeader`，含容器头、动画与尺寸校验 |
| `src/qq/incoming-http.ts` | `src/media/download.ts` | `downloadImage`、`DownloadHooks`、`forbiddenAddress`，含地址检查、DNS 固定、重定向和下载边界 |
| `src/qq/image.ts` | `src/media/limits.ts` | `MAX_IMAGES`、`MIN_IMAGE_BYTES`、`MAX_IMAGE_BYTES`、`MAX_TOTAL_IMAGE_BYTES`、`isSupportedImage`、`loadImage` 及私有根目录/有界读取校验；`prepareImages`、`ImageSegment` 留在 qq，原有公开的校验导出保留兼容重导出 |
| `src/agent/image-gen.ts` | `src/media/gen/image-gen.ts` | 生图后端、提交/收取/恢复/清理、失败分类与环境构造；只改 import，不改内部实现 |
| `src/agent/image-references.ts` | `src/media/gen/image-references.ts` | `imageRefsValue`、`validateReferences`，即 TOML 参数与票据参考图校验 |
| `src/agent/image-references.ts` | `src/context/image-references.ts` | `validateReferencesWithMedia`，保留原签名、媒体访问范围检查与读取顺序 |
| `src/agent/image-collect.ts` | `src/media/gen/image-collect.ts` | `listFiles`、`collectNewImages` |
| `src/agent/image-options.ts` | `src/media/gen/image-options.ts` | 参数 schema、尺寸预设、验证与超时预算 |
| `src/agent/image-pending.ts` | `src/media/gen/image-pending.ts` | 延迟收图清单、原子保存、隔离与目录校验 |
| `src/agent/image-files.ts` | `src/media/gen/image-files.ts` | 图片文件清单、校验与原子落盘 |
| `src/agent/qwen-workflow.ts` | `src/media/gen/qwen-workflow.ts` | Qwen 模型配置与工作流构造，内容不变 |
| `src/obs/image.ts` | `src/media/gen/observed.ts` | `observeImages`，通过 shared/trace 包装生图生命周期 |
| `src/obs/image-events.ts` | `src/media/gen/events.ts` | `ImageEventSpool`、`ingestImageEvents`、`IMAGE_EVENT_BYTES`；`ObsEvent` 类型改从 shared/trace 导入 |

实现说明：

- `image-events` 属于生图任务生命周期：子进程只向票据目录内的 `obs-events.jsonl` 写入 submit/collect/recovered 事件，主进程领取并校验后调用共享 Trace。它不打开 `observability.sqlite`、不定义观测表，也不被面板直接读取，因此整文件迁入 media/gen，无需新增注入接口。
- 原 `image-references.ts` 的 `validateReferencesWithMedia` 依赖 ContextStore、Access 与受限媒体读取。将这一段原样放到新增的 context/image-references，其余通用部分迁入 media/gen，避免 media → context；MCP 与 pi 工具仅调整 import，原参数、错误信息、检查顺序均保留。这是对 P1 整文件搬迁表的必要细分，未提前实施 P2 的观察者接口。
- `loadImage` 的根目录和文件大小校验同样属于通用媒体逻辑，一并迁入 limits，避免生图实现反向依赖 qq/image。当前 media 无需 qq/types 的任何类型，未新增 media/types 或类型重导出。
- `src/main.ts`、`src/mcp/qq-context.ts`、`src/mcp/image-gen.ts` 的入口路径保持不变；context 媒体持久化/召回服务、MCP 适配和 agent 调度留在原目录。

依赖守卫删除以下三条 P1 例外；其余 **13 条均为 §6.1 列出的 P2 例外，原样保留**，没有新增例外。测试同时拒绝 media → qq/image 与 media → qq/types。

| 删除的 from | 删除的 to |
|---|---|
| `src/agent/pi-tools/images.ts` | `src/obs/image.ts` |
| `src/agent/tasks.ts` | `src/obs/image-events.ts` |
| `src/agent/tasks.ts` | `src/obs/image.ts` |

### 6.3 P2 实际搬迁对照

本轮在 `D:/project/cs_agent-p2`、分支 `refactor/package-layout-p2` 上，以 `ed622f5` 为起点实施。七个整文件迁移使用 `git mv`；其余为职责与类型抽取，调用处直接引用新归属。没有修改 §1 的分层规则或 UI 白名单，13 条 P2 临时例外全部消除，`ALLOWED_EXCEPTIONS = []`，仍保留过期、重复例外检查。

| 旧路径 / 职责 | 新路径 / 改法 | 移动的导出 / 逻辑 |
|---|---|---|
| `src/agent/codex-runner.ts` | `src/agent/codex/runner.ts` | Codex 运行器、参数构造、线程与提示词逻辑；内部流程不改 |
| `src/agent/codex-prompt.ts` | `src/agent/codex/prompt.ts` | `CodexPromptStore`、提示词版本与持久化 |
| `src/agent/codex-trace.ts` | `src/agent/codex/trace.ts` | 官方 trace 清理 |
| `src/agent/codex-context-usage.ts` | `src/agent/codex/context-usage.ts` | rollout 用量读取 |
| `src/agent/codex-model-catalog.ts` | `src/agent/codex/model-catalog.ts` | 模型上下文窗口目录 |
| `src/agent/codex-workspace.ts` | `src/agent/codex/workspace.ts` | 按会话隔离的工作区规则 |
| `src/auth/codex-oauth.ts` | `src/agent/codex/oauth.ts` | OAuth 凭据适配；移除空 auth 目录和依赖测试特判 |
| `agent/docs.ts`、`agent/codex/runner.ts` 的请求契约 | `src/agent/backends/types.ts` | `TicketSource`、`TicketSettings`、`ThreadKey`、`ReasoningEffort`；实现反向引用契约，接口不再引用 docs/runner |
| `agent/backends/select.ts → pi.ts` | 删除 `PiBackend` 转导出 | 选择器原本已接收注册的后端实例；main 直接 import Pi，无需增加工厂或改变初始化 |
| `obs/sessions/pi-adapter.ts` 的会话源类型 | `src/agent/backends/pi-session-types.ts` | `PiConversation`、`PiEntryPage`、`PiSessionSource`；PiConversation 直接声明原有字段，不依赖观测 SessionRef |
| `config.ts` 的业务解析 | `src/agent/config.ts` | `resolveAgentConfig` / `loadAgentConfig` 在主入口、MCP 构造或面板构造处调用原来的 owner、前缀、覆盖表解析；原配置键、默认值、启动错误文字和配置页派生字段保留 |
| `obs/memory/instrumentation.ts` 的业务观察契约 | `src/context/observer.ts` | `SummaryObserver`、`RecallObserver`，以及 `RecallHit`、`RecallObservation`、`RecallRecord`、`SummarySource`；实现类显式 implements，main 已有的实例注入继续使用，MCP 独立打开行为不变 |
| `obs/ui/memory-pages.ts → context/aging.ts` | 经 `obs/memory/types.ts` 引用 | `AgingReport` 作为记忆页面契约转导出；这是任务要求的契约出口，不是旧路径兼容层 |
| `obs/http.ts` 内联页面与页面路由 | `src/obs/ui/dashboard-pages.ts` | 总览、实时、票据、设置、配置、会话/记忆页面组合及 `agingNote`；通过结构化只读接口取得业务数据，不 import 存储或后端实现 |
| `obs/http.ts` 的文件/表单边界、POST 与选项类型 | `obs/dashboard-io.ts`、`obs/dashboard-post.ts`、`obs/dashboard-types.ts` | 路径、大小、秘密与版本检查，写操作及面板组合接口；`agentMdRevision` 与测试契约改为直接 import 新位置 |

删除的 P0/P1 兼容 re-export 如下，源码和测试调用方均直接 import 目标模块：

| 原模块 | 删除的名字 | 直接引用的目标 |
|---|---|---|
| `agent/dispatch.ts` | `inboundFromTicket` | `qq/ticket.ts` |
| `agent/router.ts` | `legacyRouteText` | `qq/ticket.ts` |
| `obs/http.ts` | `SseWriter`、`sseWriter`、`csrfToken` | `obs/http-util.ts` |
| `obs/ui/html.ts` | `scopeLabel` | `context/access.ts` |
| `obs/memory/instrumentation.ts` | `ensureMemoryTables` | `obs/schema.ts` |
| `mcp/qq-context-server.ts` | `callQQContextTool` | `context/qq-context-tool.ts` |
| `obs/store.ts` | `ObsEvent` | `shared/trace.ts` |
| `obs/ui/context-bar.ts` | `STALE_MS`、`toContextUsage`、`fmtInt`、`fmtShort`、`ratio`、`usageWindow`、`fmtPct`、`sortUsage`、`ContextUsage`、`ContextUsageView` | `shared/format.ts` |
| `qq/image.ts` | `MAX_IMAGES`、`MIN_IMAGE_BYTES`、`MAX_IMAGE_BYTES`、`isSupportedImage`、`loadImage` | `media/limits.ts` |

另外删除 `agent/backends/select.ts` 的 `PiBackend` 转导出。`shared/log.ts`、`shared/redact.ts` 是带初始化职责的正式门面，其 core 导出不是旧路径兼容出口，因此保留；已有 `qq/index.ts`、Codex prompt 常量出口等非 P0/P1 兼容导出不扩大清理范围。

实现与验收口径说明：

- 面板除页面体外还抽出了 POST、I/O 与接口，以满足 HTTP 入口 ≤300 行并保持 UI 依赖白名单；`obs/http.ts` 为 **240 行**。静态逐字比对确认：页面函数只将指标 SQL 和上下文工具调用替换为等价的注入回调，POST 函数内容未变。既有 dashboard/http 测试只调整必要 import，断言未改。
- `config.ts` 不再 import 任何业务模块。基础路径拼接及第三方 `DEFAULT_COMPACTION_POLICY` 默认值读取保持不变；业务派生字段由 `AgentConfig` 承载，不改变环境变量语义或面板展示。
- **§4 的“P2 包级环为 0”按 §0 的物理目录口径未达成：实际为 7 对。** §1 的逻辑分层与物理目录不是同一个图：`main.ts` 和 `config.ts` 都计入 `src`，因此合法的 `main → agent → config` 会被折叠成目录双向边；同样，obs 根目录同时放路由与存储，agent 根目录同时放调度与共享后端工具。Codex 子目录与接口搬迁也会改变目录统计，但不等于引入文件环。未为了数字归零而改入口路径、增加白名单或进行任务外的存储/运行时目录搬迁。
- 7 对为：`src ↔ src/agent`、`src ↔ src/obs`、`src/agent ↔ src/agent/backends`、`src/agent ↔ src/agent/codex`、`src/agent/backends ↔ src/agent/codex`、`src/obs ↔ src/obs/memory`、`src/obs ↔ src/obs/sessions`。按 §1 包归属统计的跨包依赖环为 **0**，所有内部方向约束通过。测试保留原物理目录 ≤10 的断言，新增逻辑包无环与 HTTP 行数检查；没有将物理目录数字冒充为 0。


## 7. 验收记录

### P0 本地验收（2026-10-19）

- 分支 `refactor/package-layout`；工作目录 `D:/project/cs_agent-layout`。只实施 P0，未构建镜像、未部署，未修改 data/ 或入口脚本。
- `npm.cmd run typecheck` 通过；依赖规则测试 13 项通过。
- 主会话在沙箱外完成全量验收：`npm run typecheck` 两个 tsconfig 均无错误；`npx vitest run` 为 **77 passed / 1 skipped 测试文件，1089 passed / 2 skipped 测试项**，耗时约 89 秒，包含本轮 architecture 测试，无超时。此前本执行沙箱因 taskkill 权限和 shell 目录可写性检查导致环境相关失败；沙箱外自动审批曾因模型容量不足未执行，最终采用主会话提供的同 worktree 全绿结果。
- `npm.cmd run build` 通过；`dist/main.js`、`dist/mcp/qq-context.js`、`dist/mcp/image-gen.js` 均存在，入口路径保持不变。
- 当前 123 个源文件、466 条去重文件依赖边、59 条跨目录依赖对；按 §0 相同口径（物理目录、双向边对，非所有简单环枚举）包级环为 **7 对**，满足 P0 ≤ 10。
- 7 对分别为：`src ↔ src/obs`、`src/agent ↔ src/agent/backends`、`src/agent ↔ src/agent/pi-tools`、`src/agent ↔ src/obs`、`src/context ↔ src/obs/memory`、`src/obs ↔ src/obs/memory`、`src/obs ↔ src/obs/sessions`。
- `docs/ARCHITECTURE.md` §4 已同步布局。P1/P2、容器验收与浏览器 smoke 留待后续阶段；本轮任务说明明确排除镜像与部署。

### P1 本地验收（2026-10-19）

- 分支 `refactor/package-layout-p1`；所有实现和提交均在 `D:/project/cs_agent-p1`。仅实施 P1，未构建镜像、未部署，未修改 data/、入口脚本或依赖清单；任务文件不提交。
- `npm.cmd run typecheck` 通过，覆盖源码和测试两个 tsconfig；`test/architecture/deps.test.ts` 的 **14 项全部通过**。三条 P1 例外已删，13 条 P2 例外原样保留，无新增白名单或例外。
- `npx.cmd vitest run` 全量首轮为 **73 个文件通过 / 4 个文件失败 / 1 个文件跳过；1069 项通过 / 26 项失败 / 2 项跳过**（1097 项，156.52 秒）。其中入口脚本的 22 项因系统临时目录的 shell 写入检查失败；仅将该次测试的 TEMP/TMP 指向本 worktree 的 `workspace/layout-p1/test-tmp` 后，`test/entrypoint.test.ts` **22 项全部通过**，没有改动测试或入口脚本。
- 剩余 4 项进程终止/恢复用例单独重跑后仍失败，沙箱内对自建短生命周期子进程执行 `taskkill` 得到 `ERROR: Access denied`。未申请或等待沙箱外审批；下表仍需主会话在沙箱外验证。另有 `test/agent/pi-sandbox-linux.test.ts` 的两项真实 bwrap 测试按平台条件跳过（文件隔离、loopback 网络与进程树超时/取消），未在 Windows 验证。

| 未通过的测试文件 | 用例 | 沙箱内结果 |
|---|---|---|
| `test/agent/codex-runner.test.ts` | `timeout kills the process tree and throws CodexTimeoutError` | 子进程约 20 秒自行结束，未满足 < 8 秒的终止断言 |
| `test/agent/backends.test.ts` | `two restarts while queued keep attempts at zero, then the ticket runs once (F5)` | 等待取消中的子进程，30 秒超时 |
| `test/agent/dispatch.test.ts` | `crash after codex wrote its output but before the agentResult commit → recovery reuses the file; codex runs exactly once (R1)` | 30 秒测试超时，清理 hook 10 秒超时 |
| `test/agent/dispatch.test.ts` | `crash mid-turn (marker, no output) → logged as interrupted and re-asked exactly once (R1)` | 30 秒测试超时，清理 hook 10 秒超时 |

- `npm.cmd run build` 通过；`dist/main.js`、`dist/mcp/qq-context.js`、`dist/mcp/image-gen.js` 均存在。真实 image_gen/qq_context stdio 测试通过，入口路径保持不变。
- 当前 125 个源文件、468 条去重文件依赖边、66 条跨物理目录依赖对；按 P0 相同口径包级双向依赖为 **5 对**。media 的跨包依赖仅指向 shared，没有 qq（含 types）、context、agent、obs 或 mcp 依赖。
- 5 对为：`src ↔ src/obs`、`src/agent ↔ src/agent/backends`、`src/context ↔ src/obs/memory`、`src/obs ↔ src/obs/memory`、`src/obs ↔ src/obs/sessions`，后续处理仍留给 P2。
- 按迁移前版本逐项比对：10 个整文件迁移除 import 外内容一致；参考图权限拆分、通用读取校验与 QQ 图片段函数保持原样。变更文本保留 UTF-8、无 BOM、CRLF。`docs/ARCHITECTURE.md` §4 与本文 §6.2 已同步实际布局及澄清。

### P2 本地验收（2026-10-19）

- 分支 `refactor/package-layout-p2`，起点 `ed622f5`；所有实施与提交均在 `D:/project/cs_agent-p2`。没有构建镜像、部署、修改 data/ 或 scripts/entrypoint.sh；任务说明文件不提交。锁文件依赖仅安装在本 worktree，npm 缓存也位于本 worktree。
- `npm.cmd run typecheck` 通过，覆盖源码与测试两个 tsconfig。`test/architecture/deps.test.ts` 的 **16 项全部通过**，例外清单为空，未放宽任何依赖规则。
- `npx.cmd vitest run` 首轮为 **73 个文件通过 / 4 个文件失败 / 1 个文件跳过；1071 项通过 / 26 项失败 / 2 项跳过**（1099 项，159.74 秒）。入口脚本的 22 项因系统临时目录的 shell 可写性检查失败；仅将该次复跑的 TEMP/TMP 指向 `D:/project/cs_agent-p2/workspace/layout-p2/test-tmp`，`test/entrypoint.test.ts` **22 项全部通过**（46.83 秒）。未修改测试断言或入口脚本。汇总首轮与定向复跑，已有 **1093 项通过，4 项仍未通过，2 项按平台条件跳过**，不能称为全量全绿。
- 下列 4 项用原断言定向复跑仍失败（82.10 秒）。对本次创建、3 秒后自行结束的诊断子进程调用 `taskkill /PID <pid> /T /F`，返回 `ERROR: Access denied`。未申请或等待沙箱外审批，需主会话在沙箱外复验。

| 文件 | 未通过的用例 | 定向复跑结果 |
|---|---|---|
| `test/agent/codex-runner.test.ts` | `timeout kills the process tree and throws CodexTimeoutError` | 约 20 秒自行结束，不满足 <8 秒断言 |
| `test/agent/backends.test.ts` | `two restarts while queued keep attempts at zero, then the ticket runs once (F5)` | 30 秒测试超时 |
| `test/agent/dispatch.test.ts` | `crash after codex wrote its output but before the agentResult commit → recovery reuses the file; codex runs exactly once (R1)` | 30 秒测试超时，清理 hook 10 秒超时 |
| `test/agent/dispatch.test.ts` | `crash mid-turn (marker, no output) → logged as interrupted and re-asked exactly once (R1)` | 30 秒测试超时，清理 hook 10 秒超时 |

- `test/agent/pi-sandbox-linux.test.ts` 两项真实 bwrap 检查在 Windows 按平台条件跳过：文件/令牌/会话隔离及可写目录、loopback 网络与超时/取消的进程树传播。它们未在本轮 Windows 环境验证。定向复跑因名称过滤产生的 126 项 skipped 不属于新增未验证项，它们已包含在首轮全量结果内。
- 面板相关定向检查的 `memory-pages.test.ts` 曾出现 5 项 `bad port`，单独复跑 10 项全部通过，最终全量测试中也通过；dashboard/http 原有断言通过。全量测试触发的快照换行重写已核对内容一致并恢复原 CRLF，没有提交快照改动。
- `npm.cmd run build` 通过，`dist/main.js`、`dist/mcp/qq-context.js`、`dist/mcp/image-gen.js` 都存在；真实 stdio 的 image_gen / qq_context 测试在全量运行中通过。
- 当前 **132 个源文件、499 条去重文件依赖边、72 条跨物理目录依赖对**。§0 物理目录双向依赖为 **7 对**，未达到 §4 的物理口径 0，具体原因与清单见 §6.3；§1 逻辑分层跨包依赖环为 **0**。`obs/http.ts` **240 行**，已增加 ≤300 行守卫。
- 变更文本保持 UTF-8、无 BOM、CRLF；`docs/ARCHITECTURE.md` §4 与本文 §6.3 已更新。容器、浏览器 smoke、真实 Linux bwrap 和沙箱外进程终止检查不在本轮已验证范围内。

### P0（2026-10-19，主会话验收）

- 分支 `refactor/package-layout` 9 条提交 ff 到 main `cd4a1c3`；主会话沙箱外复跑：typecheck 通过，77 文件 / 1089 项通过（含 `test/architecture/deps.test.ts` 13 项），`npm run build` 后三个 dist 入口存在。
- 依赖规则：16 条临时例外全部对应 P1/P2 条目，并由"例外必须仍存在"的断言防止过期；按 §0 口径包级环 19 → 7 对（余下的是 obs 根 ↔ obs 子目录、agent ↔ agent 子目录、root ↔ obs、context ↔ obs/memory 这类 P2 或分层允许的边）。
- 与设计的偏离：log/redact 多拆出 `log-core.ts`/`redact-core.ts` 以消除文件级环；`legacyRouteText` 随 `inboundFromTicket` 一并下沉到 `qq/ticket.ts`；`ensureMemoryTables` 落在新建的 `obs/schema.ts`；`scopeLabel → context/access` 作为 UI 白名单的明确允许项；原模块保留兼容 re-export，P2 结束时统一删除。
- 部署：由 cs-agent-b7 以 main `c360eb8`（含 P0）构建部署，随后主会话以 `8b5da19`（+ 插件修剪）再次部署，镜像 `649a5e0c…`，容器 healthy。真实数据冒烟零错误：Agent/会话/上下文分析（含基础指令展开）、记忆时间线/检索/归档、召回记录与摘要血缘（整理后已出现版本 #4）、图片画廊与 `/media/<sha>`；独立 stdio 进程调用 `qq_search` 成功并写入召回事件 #6，证明搬到 `context/` 的工具门面与 `obs/schema.ts` 的建表在独立进程里正常。
- §4 第 4 条的"P2 后包级环为 0"按物理目录口径不可达（obs 根与子目录、config 作为叶子被 obs 引用都是允许边），改为：P2 结束时 `deps.test.ts` 的例外清单为空、无层序违规。

### P1（2026-10-19，主会话验收）

- 分支 `refactor/package-layout-p1` 4 条提交 cherry-pick 到 main（2f36507…ed622f5）；主会话沙箱外复跑：typecheck 通过，77 文件 / 1095 项通过，`npm run build` 三个 dist 入口存在；`deps.test.ts` 14 项通过，例外由 16 条减到 13 条（P1 三条全部消除，无新增）。
- 设计澄清：§1 原把 qq 置于 media 之下，与 P1 要求 qq 引用 media 的下载/校验矛盾；裁定层序改为 shared → config → media → qq → context → agent → obs → mcp → main，media 不得 import qq 的任何文件（含 qq/types）。实际未出现 media 需要 qq/types 的情况。
- 与设计的偏离：`image-events.ts` 归入 `media/gen/events.ts`（只处理票据目录 JSONL，不开观测库）；`validateReferencesWithMedia` 依赖 ContextStore 权限检查，原样切到新建的 `context/image-references.ts`；`loadImage` 等通用校验进 `media/limits.ts`，`qq/image.ts` 保留 re-export（P2 删）。主会话逐行对比原文件确认为纯切分，测试只改 import 路径。
- 部署：镜像 `fb814556…`（干净 worktree，ed622f5），队列空闲时切换，容器 healthy、无新告警。冒烟零错误：仪表盘四套浏览器脚本（Agent/上下文分析含基础指令展开/记忆/召回/图片画廊与 /media）、stdio 真实进程调用 `qq_search`、搬动后的 `dist/mcp/image-gen.js` 以 stdio 启动并 `tools/list` 返回 `generate_image`。
- 备注：主目录 `node_modules` 曾缺 js-tiktoken 导致 vitest 全局构建失败，`npm ci` 后恢复，与代码无关。上一条提交 9a47168 的说明误称"恢复 P0 记录"，实际该记录此前从未写入成功，本次首次写入。

### P2（2026-10-19，主会话验收）

- 分支 `refactor/package-layout-p2` 11 条提交 cherry-pick 到 main（80da59f…f1278e2，文档一条与主会话记录冲突，按"两边保留"解决）；主会话沙箱外复跑：typecheck 通过，77 文件 / 1097 项通过，`npm run build` 三个 dist 入口存在；`deps.test.ts` 16 项通过，`ALLOWED_EXCEPTIONS` 为空，新增"包间无环"与"obs/http.ts ≤ 300 行"守卫（实际 240 行）。
- 落地内容：`agent/codex/{runner,prompt,trace,context-usage,model-catalog,workspace,oauth}.ts`（`auth/` 目录删除）；`config.ts` 成叶子，业务解析在 `agent/config.ts`（`loadAgentConfig`，main / mcp / 测试改用）；`context/observer.ts` 定义 `SummaryObserver` / `RecallObserver`，`MemoryInstrumentation` 实现，main 接线不变；`agent/backends/pi-session-types.ts` 承载 pi 会话源契约；P0/P1 全部兼容 re-export 删除；`obs/http.ts` 拆为 `http.ts` + `dashboard-io.ts` + `dashboard-post.ts` + `dashboard-types.ts` + `ui/dashboard-pages.ts`。
- 口径说明：按 §0 物理目录统计仍有 7 对双向边（`src ↔ agent`、`src ↔ obs`、`agent ↔ backends`、`agent ↔ codex`、`backends ↔ codex`、`obs ↔ memory`、`obs ↔ sessions`），全部是"根文件 ↔ 包"或"包 ↔ 自己的子目录"这类分层允许的边；按 §1 的逻辑分层，跨层违规为 0。P0 验收里已把 §4 第 4 条改为此口径。
- 部署：镜像 `54a81db2…`（干净 worktree，f1278e2），队列空闲时切换，容器 healthy、无新告警。冒烟零错误：首页 / 设置 / 实时 / Agent / 记忆 / 上下文检索页 200；四套浏览器脚本（含基础指令展开、图片画廊与 /media）；stdio 真实进程调用 `qq_search`（写入召回事件 #8）与 `dist/mcp/image-gen.js` 的 `tools/list`。
- **包结构整理 P0–P2 至此全部上线。** 后续新增跨包 import 由 `test/architecture/deps.test.ts` 把关。
