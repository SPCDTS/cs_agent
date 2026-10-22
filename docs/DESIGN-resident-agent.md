# 常驻 agent：消息即输入，send_message 即输出

状态：当前架构（2026-10-21 设计，已实施）。第 14 节第 1–4 阶段已落地；第 5 阶段（删除票据残留、观测改造）进行中，涉及的条目在文中标注。
取代：`DESIGN-schedule-runtime.md` 中"定时运行 = 出站票据"的部分、`DESIGN-codex-context.md` 中每轮一个 `codex exec` 的执行方式；票据（ticket）不再作为对话概念存在。

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

## 2. 改造前的问题（历史）

改造前一条入站消息 = 一张票据 = 一次 agent 回合 = 一次结算（详见附录 A 的耦合清单）：

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
  turnSender?: string,        // 本轮发送者（用户输入）；定时为创建者；唤醒回合为空
  turnInherited?: RunPerson,  // 唤醒回合继承的人（派出子 agent 那一轮的人，见 7.3）；缺省 = 会话基础权限
  turnInputs: InputRef[],     // 本轮已送入的输入
  pending: InputRef[],        // 等本轮结束的输入（他人消息、定时任务）
  mentioned: boolean,         // 本轮是否已 @ 过发送者，见 7.2
  backend?: string }          // 会话后端：开轮、插话、放弃、恢复都用它，空闲后保留
```

每轮只用**一条**输入开轮。排队的输入轮到时单独开一轮；开轮成功后，队首紧随其后的同一发送者（owner 多账号算同一人）的连续用户消息逐条插话进本轮（遇到他人或定时即止；插话被拒则留在队列）。不做"多条一起开轮"：未确认的开轮在重启后只涉及一条输入，后端按 requestId 去重即可。

后端属于会话，不属于输入：会话文档的 `backend` 是唯一来源，开轮、插话、放弃与恢复都用它。首次见到会话时按配置选定（适配器 `plan`，按会话键：owner 线程用首个 owner 账号私聊的覆盖）。之后只有同时满足下列条件才可能改变，在宿主串行内、开新回合之前判断：会话空闲；队列里只有将开轮的这一条；这条输入从未交给过后端（输入文档不是 `starting`）；旧后端在该会话不忙（pi run 未结束、子 agent 有未结束的汇报，在同一事务里判断；codex exec 未退出，含被放弃的）。任一条件不满足就沿用旧后端。输入交给后端之前（开轮、插话）先把输入文档标为 `starting`，插话被拒改回 `queued`；崩溃后 `starting` 的输入可能已在会话后端里，只能按会话后端重新开轮（requestId 去重）。`plan` 或 `busy` 抛错时沿用当前后端；新会话没有可沿用的后端，就不开轮、稍后重试。

投递规则：

| 输入 | 线程空闲 | 线程忙 |
| --- | --- | --- |
| 用户消息，发送者与本轮相同 | 开新一轮 | 插话进当前回合（codex `turn/steer` 带 `expectedTurnId`，pi `whenBusy: "steer"`）；插话被拒（回合恰好结束）则进 `pending`，按到达顺序开新一轮 |
| 用户消息，发送者与本轮不同 | 开新一轮 | 进 `pending`，本轮结束后按到达顺序开新一轮 |
| 定时任务 | 开新一轮 | 进 `pending`，空闲时开新一轮 |
| 子 agent 完成唤醒 | 由后端原生开一轮（codex `wake_on_agent_messages`、pi follow-up） | 后端原生排队 |

不同会话键之间完全并行；保留一个全局并发上限（现 `concurrency`）只限制"同时进行中的回合数"，超出的开新一轮请求排队，插话不受限。

### 4.3 输入的呈现

每条输入前加一行来源头，沿用现格式：`[来源] <群名/私聊> <昵称>(<qq>) <时间>`，引用、图片、附件说明照旧。按 4.2 的规则，**一轮只有一个发送者**（owner 的多个账号算同一人）；其他人的消息排队到下一轮，模型不会把两个人的诉求混在一轮里。定时输入的来源头是 `[定时任务] <名称> 创建者 <qq>`。

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
- 唤醒：子 agent 完成后 app-server 自己开一轮（实测 0.164.0-alpha.8，父线程收到 `subAgentActivity kind=completed` 后 0.1 s 内 `turn/started`）。ThreadHost 从 `turn/started` 得知"这是一轮没有新输入的唤醒回合"。codex 唤醒回合要继承派出者（7.3），须由适配器求出派出者并随 `onTurnStarted` 交给宿主；求不出就只有会话基础权限。
- 后台终端命令跑完**不会**唤醒（实测）。提示词要求长任务派子 agent。

### 5.3 MCP 与令牌

- `im`、`qq_context` 两个 MCP 服务按线程启动（原 `image_gen` 已随本地生图移除）。令牌改为**线程令牌**：`thread/start` / `thread/resume` 的 `config` 里写入 `mcp_servers.im.env.IM_TOKEN` 等，绑定 threadKey，线程存在期间有效，进程重启时重新签发。
  **已验证（2026-10-21，0.164.0-alpha.8）**：`thread/start` 的 `config` 用点号键（`{"mcp_servers.im.env.IM_TOKEN": "..."}`）即按线程生效；app-server 为每个线程单独起一个 MCP 进程（两个线程两个 pid、各自的 env），同一线程跨回合复用。MCP `tools/call` 请求带 `_meta.callId`（与 `mcpToolCall` 条目 id 相同，形如 `exec-<uuid>`）和 `_meta["x-codex-turn-metadata"]`（含 `session_id`、`thread_id`）。
- 令牌只证明"来自哪个线程"；发送者身份、读取范围、目标授权由主进程在每次调用时从 ThreadHost 的当前状态求出（7.3），不再把 `QQ_ACCESS`、`IMAGE_TICKET_DIR` 烤进环境变量。
- 图片与文件的 Outbox 副本按线程存放在 `/data/images/<threadKey>/outbox/<uuid>/`（冒号换成下划线），回合结束时清理一小时前且已发送完毕的副本（`SendService.cleanup`）。

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

按 pi-durable 示例 `23-subagent-background` 实现 `subagent` 扩展：后台锚定任务持有子会话，完成后由汇报任务把结果作为 follow-up 输入投回父会话，从而唤醒主 agent。子会话工具集与父相同但不含 `subagent`、`auth_*`、`schedule_*`；`send_message` 对子会话不可用（只有主 agent 对外说话）。子会话继承派出者的读取权限（取父会话登记里它的派出者快照：派出者在这个会话里能读什么，子会话就能读什么；被另一人 message 后随登记降为基础权限，登记缺失或已停止一律基础权限）。

身份随汇报带回（7.3）：

- `spawn` 时快照父会话这一轮的身份 `{ turn: user|scheduled|wake, as?: { kind, person, owner } }`（`as` 为本轮确证的人，基础权限则缺省），登记在 `cs.subagent.children` 的子 agent 记录里，并写进汇报任务的输入。
- 汇报输入的条目（`cs.subagent.report`）数据带上该快照；适配器在唤醒 run 开始时按 run 的全部输入求出身份：全部是带确证派出者的汇报、且是同一人同一类型 → 继承该人，否则基础权限；随 `onTurnStarted`（或开轮时让出的 `backendTurnId`）交给宿主，宿主写入会话文档的 `turnInherited`，重启保持。
- 工具调用时再按 run 当前的输入核对一次（有汇报插进同一 run 就重新合并），与宿主记下的不一致即基础权限。
- 唤醒 run 开始（及重启恢复）时按继承的身份重新选择 IM 与定时工具集（与用户回合同一套选择逻辑）；配置从下一次模型请求起生效，调用仍逐次按唤醒身份复核。
- `message` 给已有子 agent 时，把登记的快照与这一轮的身份合并：不是同一人就降为基础权限（子 agent 上下文里已有两人交代的内容），之后的汇报都带合并后的身份。

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

群会话里，用户输入开启一轮时记下本轮发送者；本轮第一条发往本群的消息 @ 他，之后不再 @（与现在一致）。定时与唤醒回合不 @。

### 7.3 身份与授权

**每个回合绑定一个人**，每次工具调用（发送与 target、召回与历史读取范围、定时、授权、技能写权限）都按这个人检查。权限分两层，在一处求出（`src/agent/host/identity.ts`：`base(threadKey, scope)` + `elevation(identity)` → `runRights`），各工具不再按回合类型或会话自行判断：

- **会话基础权限**（任何回合都有）：读本会话范围、只发往本会话；没有 target、没有 `schedule_*`、没有 `auth_*`。
- **人的权限**（只在确证时叠加）：owner 全权（target 不查授权表、技能写权限、交互身份有 `auth_*`；**读全部只在 owner 私聊线程**，在群里也只读本群——群线程历史对群里所有人可见，读进来的别处记录会被后来的人间接看到，见 7.5）；他人按授权表（send 授权开放 target，schedule 授权开放定时管理）。

这个人是谁：

- 用户输入：发送者（一轮只有一个发送者，见 4.2；owner 的多个账号算同一人）。
- 定时输入：创建者，不提供 `auth_*`，授权照常按当前授权表复核（沿用现规则）。
- 唤醒回合（子 agent 汇报）：**派出该子 agent 的那一轮的人**（派出时快照，见 6.2）。唤醒回合派出的子 agent 再唤醒时沿链继承。同一唤醒回合带回多个汇报而派出者不是同一人（或类型不同）时取最严格：回落到会话基础权限。owner 标记只降不升：快照时与当前配置都必须是 owner。
- **无法确证就只有会话基础权限（fail closed）**：没有派出记录（升级前派出的子 agent）、不是汇报的后端 run、宿主尚未确认的 run、宿主放弃的回合、数据缺失或不一致，一律回落到基础权限，绝不向上回落。owner 线程不再有"唤醒回合读全部"的例外——owner 派出的子 agent 唤醒时本来就继承 owner。继承的快照与当前 owner 配置不一致（之后被加入或移出 owner）也回落基础权限。汇报任务提交汇报时再与登记的当前身份合并（只降不升），子 agent 运行中被别人转向后，原汇报任务的快照不会单独带回。

一轮只有一个人：其他人的消息排队到本轮结束；同一人的消息只插话进他自己的用户回合，**不插话进唤醒回合**（排队，唤醒回合结束后单独开轮）。子会话始终没有 `send_message`、`auth_*`、`schedule_*`。

### 7.4 Outbox

- 行键改为 `<threadKey>:<callKey>`。`callKey`：pi 用稳定的 `toolCallId`；codex 用 MCP 请求的 `_meta.callId`（已验证随每次调用提供），`im` 服务原样转给主进程。
- 状态机 `pending → sending → sent | uncertain`、永不自动重发、文件分步上传、`recordSent` 写入消息库，全部沿用。
- 系统消息（出错提示、熔断通知）键为 `<threadKey>:sys:<uuid>`，不计主动额度。
- `outbox.ticket` 列改为 `thread_key`，新增 `turn_id`（观测用）、`input_key`（引用用：发往本群时 `reply_to_id` = 本轮最后一条输入的 message_id）。

### 7.5 读进上下文就可能被看到

共享会话（群）的线程历史对会话里所有人可见：一轮读进上下文的内容，之后任何人的回合都可能间接看到。因此读取范围按"线程"而不是按"人"放宽：只有 owner 私聊线程读全部，群线程无论谁发言都只读本群。要查别处，到 owner 私聊里查。

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
- 运行记录：`cs.scheduled-run` 保留，结果改为统计该输入所在回合发出的消息数：有发送 → `sent`，无 → `silent`，回合失败、丢失或投递不确定 → `failed`。原设计还要计入其后的唤醒回合，当前实现只统计输入所在的那一个回合（`src/agent/schedule/run.ts`）。定时回合失败不向会话发出错提示，只记入运行记录。
- 重叠判定：上一次运行的输入尚未 `done` 时跳过本次（沿用 skip 语义）。
- 权限：创建者身份，无 `auth_*`（沿用）。

## 11. 生图前缀路由（已移除）

2026-10：本地 ComfyUI 生图整体移除，`奶龙:` 前缀路由随之取消。所有触发消息（包括以 `奶龙:` 开头的）都由 Inbox 作为普通输入投递给会话宿主；`Dispatcher`、`cs.image` 任务、`TicketDoc` / `DispatchDoc`、`bridge.reply` 旧路径、`generate_image` 工具与 `image_gen` MCP 均已删除。
`qq-bridge.sqlite` 的 `tickets` 表只读保留（召回机器人旧回复时核对发出状态），不再写入；codex 自带的内置生图（imagegen，输出在 `/data/codex/generated_images`）不受影响。

## 12. 观测

- trace 事件键：`turn:<turnId>`（回合）、`in:<inboundKey>`（输入）、`thr:<threadKey>`（线程级事件）。`events.ticket` 列改名 `key`（第 5 阶段，尚未完成）。
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
| `/data/images/<ticket>`、`/data/files/<ticket>` | 按线程目录（Outbox 副本在 `images/<threadKey>/outbox/`）；旧票据目录不再使用 |
| `codex-delivery-notes/` | 删除 |
| `observability.sqlite` `events.ticket` | 改名 `key`，历史数据保留（第 5 阶段，尚未完成） |

## 14. 分阶段实施

每阶段独立可上线、可回滚（第 1–4 阶段已完成，第 5 阶段进行中）：

1. **发送绑定会话 + bridge 规则**：`send_message` 改为会话绑定，去掉每轮条数上限，加 bridge 发送规则与熔断；仍在旧派发流程里运行。
2. **pi 常驻**：ThreadHost + Inbox 落地，pi 改为 steer/follow-up 投递，去掉单轮时限、兜底与 delivery note，定时任务改为输入；codex 暂时走适配层（每轮 exec，输入排队）。
3. **codex 常驻**：常驻 app-server 0.164.0-alpha.8、线程令牌、steer、唤醒、监管与恢复。
4. **子 agent**：pi `subagent` 扩展；两个后端的提示词加"长任务派子 agent、完成后汇报"。
5. **清理**：删除票据、派发器残留、旧回复路径；观测与面板改造完成。

## 15. 风险

- **codex alpha**：`wake_on_agent_messages` 仍在开发中，可能变更或移除。锁版本，升级前用第 5.2 的探针复测。
- **codex 不可持久**：容器重启丢失进行中工作（5.4）。长任务用 pi 更稳。
- **群里他人排队**：主回合进行时，其他人要等这一轮结束。长任务交给子 agent 后主回合通常很短，等待可接受。
- **成本**：常驻 + 子 agent 会增加 token 用量；面板按线程显示用量，bridge 规则兜底发送量。

## 附录 A：改造前的耦合点（实现时逐项处理，保留作记录）

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
11. 消息库 `self:<ticket>` 占位行（生图路由；已随生图路由移除，旧行只读保留）。
12. 观测以票据为键：`events.ticket`、实时卡片、票据页、指标标签、`GrantsService.verify` 从票据行取身份。
13. 生图路由的 `bridge.reply(ticket)` 旧路径（已删除）。
