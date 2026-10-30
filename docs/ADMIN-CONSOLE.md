# 管理台：请求统计与网页续聊

## 使用

打开 `/admin/`，使用原有 ADMIN_TOKEN 登录。侧栏包含用量总览、请求记录、会话对话、配置与管理。

- 总览可选最近 24 小时、7 天、30 天，并按会话、模型、用途、状态筛选；趋势按北京时间分桶。
- 点击请求时间，查看该次 pi-ai 调用的有效系统提示、消息、工具定义和模型输出。工具结果可在下一次请求的 toolResult 消息中查看。
- 会话对话选择已有 QQ 会话，继续同一个 Harness root；最近 100 条 QQ/网页消息合并展示并标明来源。输入框支持 Ctrl/⌘ + Enter。
- 网页发言只回复网页。QQ 消息仍按原规则回复 QQ。网页请求使用稳定 UUID，断网重试同一编号不会重复入队。
- 原有模型登录、设置、审计、记忆、技能、定时与事件管理保留在“配置与管理”。

请求采集从本版本上线后开始，不补造历史请求。网页对话无需 NapCat 在线，但 QQ 的实际收发仍依赖 NapCat。

## 调用方式与数据边界

```ts
// 同一基础 Models 的凭据仍由 Registry 管理，观察视图只绑定固定来源。
const models = captureModels(base, env, ctx, {
  thread: "owner", actor: "thread", purpose: "conversation"
});
await Harness.open(storage, { models, registry }, context);

// 网页提交只接收文字与幂等编号，不接收 QQ 身份、目标或权限字段。
await thread.submitWeb("owner", requestId, text);
const history = await thread.chatView("owner");

// 查询集中在 RequestsDO，读取不会唤醒每个会话。
const page = await env.REQUESTS.getByName("main").list(query);
```

新增数据接口均要求 Bearer ADMIN_TOKEN：

| 接口 | 用途 |
| --- | --- |
| GET /admin/usage | 合计、趋势、模型分布 |
| GET /admin/requests | 请求游标分页 |
| GET /admin/requests/:id | 单次上下文详情 |
| GET /admin/threads/:key/chat | 最近消息与网页排队数 |
| POST /admin/threads/:key/chat | 网页输入，接纳后返回 202 |

列表使用递增序号游标，前页之后的新请求不会让后页重复。时间、会话、模型、用途和状态条件同时作用于列表与统计。状态和用量可能随进行中的请求完成而更新；不是冻结的历史数据库快照。

## 架构与综合决策

比较了集中 RequestsDO 与按 Thread/Subagent 分散保存、查询时合并两种方案。五项评估为请求覆盖、渠道隔离、查询完整性、存储上限、维护复杂度；独立评审同样推荐集中式方案。选用集中式：一个查询所有者隐藏跨会话索引、分页与保留策略，不增加目录版本、租约或多游标归并，也不把统计流量混进 Registry 的凭据刷新。

采用分散式候选对渠道归属的约束：QQ/网页不混入同一运行回合；子任务继承派出来源。同一子任务拒绝跨回复入口追加指令，需在当前入口另建，避免一次任务的后续汇报改道。使用流的终态 Promise 采集，不增加第二个事件消费者，不抢占 Harness 的流事件。

| 模块 | 职责 |
| --- | --- |
| workers/src/requests/capture.ts | 装饰 stream/streamSimple/complete/completeSimple，记录一次模型调用的开始与结束 |
| workers/src/requests/snapshot.ts | 白名单上下文投影、凭据隐藏与大小限制 |
| workers/src/requests/do.ts | 全局 SQLite 索引、用量聚合、分页、详情与清理 |
| workers/src/thread.ts | 网页接纳、原会话调度、权限与输出入口 |
| workers/src/subagent/ | 子任务采集与回复来源继承 |
| workers/src/admin/console.ts | 总览、详情、对话的页面与交互 |
| workers/src/admin/page.ts | 登录、静态壳、原有管理功能 |
| workers/src/admin/routes.ts | 鉴权、参数验证与 RPC 路由 |

实施采用异步 RPC 上报；采集写入失败记录 `request_record_failed`，不打断正常回复，目前没有持久补送队列。因此这里是运行观测，不是保证无丢失的计费账本。一小时未收到结束记录标为“采集未完成”；晚到终态可补正。工具实际结果保留在后续模型请求快照，不另建工具事件数据库。主会话、子任务、记忆/维护及上下文压缩均采集；SDK 内部 HTTP 重试不拆成独立记录。

## 用量与保留

输入 token = pi-ai input + cacheRead + cacheWrite；输出包含 reasoning，不能再叠加。通过提供方 usage 事件区分上报的零值与未上报；没有提供方事件但规范化 usage 非零时保留该用量。未知用量显示“—”，不参与合计；统计同时显示已返回用量的请求数。系统、消息、工具组成使用字符数，不能理解为精确 token 拆分。

元数据最多 30 天、20,000 条；详情最多 7 天、全局 32 MiB。容量限制可能提前淘汰。单次请求输入快照最多 96,000 字符，输出最多 24,000 字符；每条消息、单工具定义另有限额，最近消息优先。页面明确提示截断；含凭据模式的内容整块隐藏，图片二进制与认证选项不进入快照。

网页输入存入原线程 inbound，来源为 web、身份为 admin:web，不进入 QQ messages；输出写 web_outputs，不进入 QQ outbox。管理员在 owner 会话使用该会话的管理工具，群和其他私聊仍受会话范围限制。网页输入不进入 QQ 自动记忆抽取；显式记忆工具仍按当前会话权限执行。默认已有行的 reply_channel 为 qq，保持旧会话恢复兼容。

## 界面设计

背景 #F6F7F9、表面 #FFFFFF、正文 #13272B、次要文字 #64767B、强调 #087F73、分隔线 #E7EDF0。采用系统中文无衬线字体，标题 28px、正文 14px、辅助信息 12px，数字使用 tabular-nums。桌面为 204px 侧栏与数据工作区；指标放在连续行，图表和模型分布居中，请求表支持进入详情。手机使用顶部导航，图表按实际宽度绘制，表格在容器内横向滚动。

设计复核保持数据密度与空态说明，配置功能独立于日常请求查看。已按桌面与 390px 手机尺寸检查登录、总览、详情和对话；动态内容只通过 textContent 展示。

## 验证

- Workers 类型检查与全量测试覆盖原有功能及新增请求采集、真实零用量、失败未知用量、流事件完整性、脱敏、分页和详情保留。
- 网页测试覆盖共享 QQ 上下文、同编号重复提交、内容冲突、拒绝伪造身份、QQ 插话隔离、网页子任务延迟汇报。
- 本机 Wrangler 使用 faux 模型完成浏览器发言、回复与对应两次模型调用的详情检查；这些预览数据不是生产用量。
- 发布增加 v10 RequestsDO 迁移，无需新密钥。合并前按仓库工作区流程运行根项目检查；上线仍由 main 推送后的 CI 执行。
