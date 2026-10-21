# 常驻 agent：消息即输入，send_message 即输出

状态：设计稿（2026-10-21），待确认后分阶段实施。
取代：`DESIGN-schedule-runtime.md` 中"定时运行 = 出站票据"的部分；票据（ticket）不再作为对话概念存在。

## 1. 目标

每个会话（群 `group:<id>`、私聊 `private:<qq>`、owner 多账号共用的 `owner`）对应一个**常驻的 agent 线程**：

- **输入（stdin）**：触发它的 QQ 消息。线程空闲时开一轮；正在工作时像 TUI 里打字插话一样送进当前这一轮。
- **输出（stdout）**：`send_message`。发几条、什么时候发由模型决定，一轮中途、被子 agent 唤醒后都可以发。
- 除此之外，模型的工作方式与在 TUI 里使用 codex / pi 没有区别：没有单轮时限、没有每轮条数上限、没有"每条消息必须回复一次"。

已确认的规则：

| 问题 | 决定 |
| --- | --- |
| 模型没回复 | 不兜底；只在出错（模型报错、进程崩溃、回合失败）时提示 |
| 群里什么算输入 | 只有 @ 机器人的消息；其余照常入库作上下文 |
| 防失控 | 由 QQ bridge 的规则统一限制，不设单轮限制 |
| 定时任务 | 到点向来源会话线程输入一条"定时任务：<提示词>"，线程忙则排队等空闲（不插话） |
| 长任务 | 派子 agent 去做，主 agent 结束本轮；子 agent 完成时唤醒主 agent，由它汇报 |

## 2. 现状与问题

现在一条入站消息 = 一张票据 = 一次 agent 回合 = 一次结算（详见附录 A 的耦合清单）：

- 派发器为每张票据新建一个 pi-durable 会话（`TicketDoc` + `DispatchDoc.pending[ticket]`），按会话 FIFO 串行，最多重试 3 次，结算时没发过就兜底。
- `send_message` 绑定票据：票据一结算就不能再发；每轮最多 3 条（定时 5 条）；群里第一条 @ 提问者。
- codex 每张票据起一个 `codex exec`，结束即杀进程组；IM / 召回令牌、生图目录、附件目录都按票据发放。
- pi 每张票据重写一次 `cs.pi.request`，`whenBusy: "reject"`，`bounded()` 到点中止。
- 定时运行为了复用这套流程，伪造了 `run_` 出站票据。

由此产生的问题：回合结束后无法再发消息（长任务、子 agent 完成都发不出）；新消息只能排队，不能插话；时限一到整单结算；定时运行要特殊分支。

## 3. 总体结构

```
QQ bridge ──@消息──▶ Inbox ──▶ ThreadHost(会话键) ──▶ 后端适配器 ──▶ codex app-server / pi harness
   ▲                               │  idle→开一轮 / busy→插话            │
   │                               │  定时输入：排队等 idle               │ 子 agent 完成 → 唤醒（后端原生）
   └──── 发送规则 ◀── Outbox ◀── send_message(会话绑定) ◀────────────────┘
```

| 组件 | 职责 | 替代 |
| --- | --- | --- |
| Inbox | 入站去重、持久化、附件下载、按会话键投递；记录每条输入的投递状态 | `tickets` 表 + `Dispatcher` |
| ThreadHost | 每个会话键一个：跟踪空闲/忙、当前回合、本轮输入集合；决定开新轮、插话或排队 | `DispatchDoc`、`TicketDoc`、scope FIFO |
| 后端适配器 | codex：常驻 app-server 客户端；pi：进程内 harness | `CodexRunner.exec`、`PiBackend.turn` |
| 发送（Outbox） | `send_message` 绑定会话；防重发状态机沿用 | `SendBinding.ticket`、`#fallback` |
| bridge 规则 | 限速、每日主动额度、熔断 | 每轮 3/5 条上限 |

## 4. 输入：Inbox 与 ThreadHost

### 4.1 Inbox

- 入站判定不变：`isTriggered`（私聊；群里真实 @）才进 Inbox，其余只走 `raw → store.ingest` 作上下文。
- 消息键沿用确定性 ID（现 `ticketIdFor` 改名 `inboundKey`）和 `seen_messages` 去重；附件下载目录改为 `/data/incoming/<inboundKey>`（仅改名）。
- 表 `inbound`（由 `tickets` 迁移）：`key, scope, thread_key, user_id, group_id, message_id, text, images, attachments, created_at, seq, state`。
  `state`：`queued`（未送达后端）→ `delivered`（后端已确认收下：codex 收到 `turn/started` 或 `turn/steer` 成功；pi `submit` 返回）→ `done`（所在回合结束）。
- 重启恢复：`queued` 的按 `seq` 重新投递；`delivered` 但回合未结束的，由后端恢复决定（见 5.3、6.3）。

### 4.2 ThreadHost

每个会话键一个，状态持久化在派发 harness 的文档 `cs.thread-host`（per 会话键）：

```ts
{ threadKey, busy: boolean, turnId?: string,
  turnInputs: InputRef[],     // 本轮已送入的输入（用户消息 / 定时 / 唤醒）
  pending: InputRef[],        // 等空闲的输入（定时任务、插话失败的回退）
  mention?: { userIds: string[] } }  // 见 7.2
```

投递规则：

| 输入 | 线程空闲 | 线程忙 |
| --- | --- | --- |
| 用户 @ 消息 / 私聊 | 开新一轮 | 插话进当前回合（codex `turn/steer`，pi `whenBusy: "steer"`）；插话被拒（回合恰好结束）则开新一轮 |
| 定时任务 | 开新一轮 | 进 `pending`，空闲时开新一轮 |
| 子 agent 完成唤醒 | 由后端原生开一轮（codex `wake_on_agent_messages`、pi follow-up） | 后端原生排队 |

不同会话键之间完全并行；保留一个全局并发上限（现 `concurrency`）只限制"同时进行中的回合数"，超出的开新一轮请求排队，插话不受限。

### 4.3 输入的呈现

每条输入前加一行来源头，沿用现格式：`[来源] <群名/私聊> <昵称>(<qq>) <时间>`，引用、图片、附件说明照旧。一轮里插进来的多条输入各带自己的来源头，模型能分清是谁说的。定时输入的来源头是 `[定时任务] <名称> 创建者 <qq>`。

## 5. codex 后端：常驻 app-server

### 5.1 进程

- 一个常驻 `codex app-server`（stdio JSON-RPC），由 cs-agent 启动并监管，承载所有线程。
- 版本锁定 `0.164.0-alpha.8`（`wake_on_agent_messages` 仅此版本起有，状态 under development）。镜像里单独安装，CLI 版本号写进面板。
- 受管配置新增：`features.multi_agent = true`、`features.wake_on_agent_messages = true`；其余沿用（apps/plugins 关闭、magpie provider、沙箱可写目录）。

### 5.2 线程与回合

- 线程映射沿用 `ThreadKey → threadId`；首次 `thread/start`，进程重启后 `thread/resume`。基础指令（`model_instructions_file`）、托管 `AGENTS.md`、线程轮换规则沿用。
- 每轮参数（推理强度、模型）走 `turn/start` 的 `effort`、`model` 字段，不再用 `-c` 覆盖。
- 开一轮：`turn/start`；插话：`turn/steer`（带 `expectedTurnId`）；中止（面板"停止"）：`turn/interrupt`。
- 回合结束：`turn/completed`。`status != completed` 或有 `error` 通知 → 回合失败，走 8.1 的出错提示。
- 唤醒：子 agent 完成后 app-server 自己开一轮（实测 0.164.0-alpha.8，父线程收到 `subAgentActivity kind=completed` 后 0.1 s 内 `turn/started`）。ThreadHost 从 `turn/started` 得知"这是一轮没有新输入的唤醒回合"。
- 后台终端命令跑完**不会**唤醒（实测）。提示词要求长任务派子 agent。

### 5.3 MCP 与令牌

- `im`、`qq_context`、`image_gen` 三个 MCP 服务按线程启动。令牌改为**线程令牌**：`thread/start` / `thread/resume` 的 `config` 里写入 `mcp_servers.im.env.IM_TOKEN` 等，绑定 threadKey，线程存在期间有效，进程重启时重新签发。
  **待验证（阶段 3 开工前）**：app-server 是否为每个线程单独起 MCP 子进程、`config` 里的 MCP env 是否按线程生效。若不是，退而求其次：令牌不区分线程，`im` 服务在每次调用时带上 codex 提供的线程标识（`_meta` 或请求头），主进程据此解析。
- 令牌只证明"来自哪个线程"；发送者身份、读取范围、目标授权由主进程在每次调用时从 ThreadHost 的当前状态求出（7.3），不再把 `QQ_ACCESS`、`IMAGE_TICKET_DIR` 烤进环境变量。
- 生图输出与附件目录按线程：`/data/images/<threadKey>/`、`/data/files/<threadKey>/`，定期清理（保留 7 天）。

### 5.4 崩溃与恢复

- app-server 退出：监管器重启它，对所有已知线程 `thread/resume`。崩溃时正在进行的回合、子 agent、后台进程**丢失**（app-server 不可持久恢复，接受这一点）。
- 丢失回合里 `delivered` 的输入：向该会话发一条出错提示（"处理中断了，需要的话请再说一次"），输入标记 `done`，不自动重放（避免重复执行有副作用的操作）。

## 6. pi 后端：harness 原生

### 6.1 线程与回合

- 会话映射 `PiThreadsDoc` 沿用。输入用 `conv.submit({ type: "input", requestId: inboundKey, whenBusy })`：用户消息 `steer`，定时 `followUp`（等本轮结束）。`requestId` 保证重放不重复提交。
- 去掉 `bounded()` 的单轮时限和 `waitForIdle` 前置等待；回合结束由会话事件（idle）驱动 ThreadHost。
- `cs.pi.request` 由"每票据重写"改为"每轮输入集合"，由 ThreadHost 维护；工具调用时从中解析身份与范围（7.3）。
- 工具按票据计的配额（内置 20、qq_image 5、生图 2、历史 4）取消，失控防护交给 bridge 规则（第 9 节）。

### 6.2 子 agent

按 pi-durable 示例 `23-subagent-background` 实现 `subagent` 扩展：后台锚定任务持有子会话，完成后由汇报任务把结果作为 follow-up 输入投回父会话，从而唤醒主 agent。子会话工具集与父相同但不含 `subagent`、`auth_*`、`schedule_*`；`send_message` 对子会话不可用（只有主 agent 对外说话）。

### 6.3 恢复

pi-durable 持久化：进程重启后进行中的回合和子 agent 自动续跑，`delivered` 输入无需处理。

## 7. 输出：send_message 绑定会话

### 7.1 工具

```ts
send_message({ text, images?, files?, target? }) → { status, message_id, already_sent }
```

- 省略 `target`：发往本线程的会话。任何时候都能发（回合中、唤醒回合中）。
- `target` 为其他会话：主动发送，按 7.3 校验授权，计入每日主动额度（沿用 100 条/目标/天）。
- 去掉"每轮最多 N 条"与"本回合已经结束"两条校验；`SEND_RULE` 改写为不含条数的版本。

### 7.2 @ 规则

群会话里，每条用户输入进入线程时把发送者加入 `mention.userIds`；下一条发往本群的消息 @ 这些人并清空。效果与现在"一轮第一条 @ 提问者"一致，且一轮插进多人时会一起 @。定时与唤醒回合不 @。

### 7.3 身份与授权

每次工具调用（发送、召回、生图、定时、授权）的身份取自**本轮输入集合**的发送者：

- 本轮只含一个发送者：按此人的权限（owner 全权；他人按授权表）。
- 本轮插进了多个发送者：取**最严格**者（交集），防止低权限者插话借用 owner 权限。
- 定时输入：创建者身份，且不提供 `auth_*`（沿用现规则）。
- 唤醒回合（没有新输入）：只允许发往本会话、读取本会话范围；不允许主动发往别处、不允许定时与授权工具。需要别的权限时，模型在汇报里请用户确认。

读取范围（`qq_context`、`qq_image`）同理：owner 为 all，其他为本会话。

### 7.4 Outbox

- 行键改为 `<threadKey>:<callKey>`。`callKey`：pi 用稳定的 `toolCallId`；codex 由 `im` MCP 服务在每次调用时生成 UUID（常驻进程不会重放工具调用，靠状态机防"已发出未记账"）。
- 状态机 `pending → sending → sent | uncertain`、永不自动重发、文件分步上传、`recordSent` 写入消息库，全部沿用。
- 系统消息（出错提示、熔断通知）键为 `<threadKey>:sys:<uuid>`，不计主动额度。
- `outbox.ticket` 列改为 `thread_key`，新增 `turn_id`（观测用）、`input_key`（引用用：发往本群时 `reply_to_id` = 本轮最后一条输入的 message_id）。

## 8. 出错提示与停止

### 8.1 出错提示

只在以下情况向会话发一条系统消息（同一会话 10 分钟内最多一条）：

| 情况 | 文案 |
| --- | --- |
| 回合失败（模型/提供方报错、codex `turn/completed` 非 completed、pi 回合 error） | 这次处理出错了，需要的话请再说一次。 |
| 后端进程崩溃导致回合丢失 | 处理中断了，需要的话请再说一次。 |
| 输入投递失败（后端不可用超过 2 分钟） | 现在暂时处理不了，请稍后再试。 |

模型正常结束但没发消息：不提示。去掉 `FALLBACK_REPLY`、`#fallback`、delivery note（`cs.delivery_note` 与 `codex-delivery-notes`）。

### 8.2 停滞与停止

- 不设回合时限。看门狗：一个回合**连续 30 分钟没有任何事件**（模型输出、工具调用、子 agent 活动）视为卡死，中止并按 8.1 提示。
- 面板每个会话加"停止"按钮（codex `turn/interrupt`，pi `conv.abort`），连同子 agent 一起停。

## 9. QQ bridge 发送规则（防失控）

所有出站消息在 bridge 统一过规则（`src/qq/send-rules.ts`），与模型、后端无关：

| 规则 | 默认值 | 触发后 |
| --- | --- | --- |
| 每会话每分钟 | 6 条 | 拒绝发送，返回模型"发送过快，稍后再发" |
| 每会话每小时 | 60 条 | 熔断该会话 1 小时，通知 owner |
| 每目标每日主动 | 100 条（沿用） | 拒绝主动发送 |
| 全局每分钟 | 30 条 | 熔断全部发送 10 分钟，通知 owner |
| 单条长度 | 4000 字（沿用） | 拒绝 |

数值放进面板设置，可调。熔断状态在面板显示并可手动解除。

## 10. 定时任务

- 到点：`ScheduleTask` 照旧算时刻、判重叠、记运行；接纳时不再建出站票据，而是向来源会话的 ThreadHost 投一条定时输入（`pending`，等空闲）。
- 运行记录：`cs.scheduled-run` 保留，结果改为统计"该输入所在回合（及其后的唤醒回合，直到线程空闲）发出的消息数"：有发送 → `sent`，无 → `silent`，回合失败 → `failed`。
- 重叠判定：上一次运行的输入尚未 `done` 时跳过本次（沿用 skip 语义）。
- 权限：创建者身份，无 `auth_*`（沿用）。

## 11. 生图前缀路由

`奶龙:` 前缀走规则路由，不进 agent 线程，保持现有提交/收集/对账流程；状态从 `TicketDoc` 移到以 `inboundKey` 为键的 `cs.image-job` 文档；回复改走 Outbox（键 `<threadKey>:img:<inboundKey>`），去掉 `bridge.reply` 旧路径与 `self:<ticket>` 占位行。

## 12. 观测

- trace 事件键：`turn:<turnId>`（回合）、`in:<inboundKey>`（输入）、`thr:<threadKey>`（线程级事件）。`events.ticket` 列改名 `key`。
- 实时视图：从"每票据一张卡片"改为"每会话一行"：空闲/工作中、当前回合已用时间、本轮输入、已发消息、子 agent 数，附"停止"按钮。
- 回合详情页取代票据详情页：输入列表、工具调用、发送、子 agent 活动。
- 上下文用量按线程（已是如此），不再挂票据。

## 13. 存储迁移

| 现 | 新 |
| --- | --- |
| `qq-bridge.sqlite` `tickets` | `inbound`（迁移字段，去掉 status/reply 列；`run_` 行丢弃） |
| `outbox.ticket`、`UNIQUE(ticket, ordinal)` | `thread_key`、`turn_id`、`input_key`，`UNIQUE(key)` |
| `agent.sqlite` `cs.dispatch`、`cs.ticket` 会话 | 删除（迁移时先排空：部署前确认无进行中票据） |
| `cs.thread-host` | 新增 |
| `pi.sqlite` `cs.pi.request` | 改为每轮输入集合 |
| `/data/images/<ticket>`、`/data/files/<ticket>` | 按线程目录；旧目录保留只读 7 天后清理 |
| `codex-delivery-notes/` | 删除 |
| `observability.sqlite` `events.ticket` | 改名 `key`，历史数据保留 |

## 14. 分阶段实施

每阶段独立可上线、可回滚：

1. **发送绑定会话 + bridge 规则**：`send_message` 改为会话绑定，去掉每轮条数上限，加 bridge 发送规则与熔断；仍在旧派发流程里运行。
2. **pi 常驻**：ThreadHost + Inbox 落地，pi 改为 steer/follow-up 投递，去掉单轮时限、兜底与 delivery note，定时任务改为输入；codex 暂时走适配层（每轮 exec，输入排队）。
3. **codex 常驻**：常驻 app-server 0.164.0-alpha.8、线程令牌、steer、唤醒、监管与恢复。
4. **子 agent**：pi `subagent` 扩展；两个后端的提示词加"长任务派子 agent、完成后汇报"。
5. **清理**：删除票据、派发器残留、旧回复路径；观测与面板改造完成。

## 15. 风险

- **codex alpha**：`wake_on_agent_messages` 仍在开发中，可能变更或移除。锁版本，升级前用第 5.2 的探针复测。
- **codex 不可持久**：容器重启丢失进行中工作（5.4）。长任务用 pi 更稳。
- **群里多人插话**：模型可能混淆诉求；靠来源头区分，权限取最严格（7.3）。
- **成本**：常驻 + 子 agent 会增加 token 用量；面板按线程显示用量，bridge 规则兜底发送量。

## 附录 A：现状耦合点（实现时逐项处理）

1. `Dispatcher`：每票据建会话、`DispatchDoc.pending`、重试/放弃/兜底、按票据序恢复（`src/agent/dispatch.ts`）。
2. `TicketDoc` 与 `cs.agent` 的 handle / lateImages / settle 阶段（`src/agent/tasks.ts`、`docs.ts`）。
3. `tickets.status` 作为"本轮是否已回复"的闸门（`settleTicket`、`SendService.send/system`、`bridge.send`）。
4. Outbox 键 `ticket#n/#late/#fallback`、每票据 3/5 条上限、`SEND_RULE` 文案。
5. 第一条 @ 提问者逻辑（`send-service.ts`、`reply-store.ts`、`bridge.ts`）。
6. codex 每票据一个 exec、IM/召回租约、`QQ_TICKET`/`IMAGE_TICKET_DIR`/`IMAGE_REFS`、`codex-last.txt` 幂等、delivery note 注入。
7. pi 每票据重写 `PiRequestDoc`、`whenBusy: "reject"`、`bounded()`、按票据计的工具配额。
8. 按票据的目录：`/data/images|incoming|files/<ticket>`、`ticketsDir/<ticket>`。
9. 定时运行的 `run_` 票据、`finish()` 按票据统计、各处 `origin === "scheduled"` 分支。
10. 推理强度路由按入站消息快照（改为每轮输入时计算）。
11. 消息库 `self:<ticket>` 占位行（生图路由）。
12. 观测以票据为键：`events.ticket`、实时卡片、票据页、指标标签、`GrantsService.verify` 从票据行取身份。
13. 生图路由的 `bridge.reply(ticket)` 旧路径。
