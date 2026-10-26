# cs_agent 架构

本文描述系统**现在**如何工作，以 `src/` 为准；部署、配置与排障见 [DEPLOY.md](DEPLOY.md)，已定的取舍见 [DECISIONS.md](DECISIONS.md)，面板见 [DASHBOARD.md](DASHBOARD.md)。历史设计与验收记录只在 git 历史里。

## 1. 概览

cs_agent 是一个 QQ 机器人：每个 QQ 会话对应一个**常驻 agent 线程**，体验与在 TUI 里使用 codex / pi 一致。

- **输入**：触发机器人的 QQ 消息（私聊；群里真实 @ 机器人）。线程空闲时开一轮；同一发送者在回合进行中追加的消息插话进当前回合；其他人的消息与定时任务排队到本轮结束。
- **输出**：模型调用 `send_message`。发几条、什么时候发由模型决定；回合中途、被子 agent 唤醒后都可以发。模型的最终回答只留存，不自动发出；模型没发消息不兜底，只在出错时提示。
- 没有单轮时限、没有每轮条数上限。防失控由 QQ bridge 的发送规则统一负责（§3.3）。

```
QQ ─NapCat(OneBot v11)─▶ QQBridge ──@消息──▶ Inbox ──▶ ThreadHost(会话键) ──▶ 后端适配器 ──▶ codex app-server / pi harness
 ▲                        授权·@检测·去重·入库     queued→delivered→done   空闲→开轮 / 同人→插话 / 其余→排队      │ 子 agent 完成 → 唤醒
 └── 原私聊/原群 ◀── 发送规则 ◀── Outbox ◀── SendService ◀── send_message（绑定会话，按本轮的人鉴权）◀──────┘
```

会话键（ThreadKey）：owner 的私聊（`QQ_OWNER` 的所有账号共用）为 `owner`，群为 `group:<群号>`，其他私聊为 `private:<QQ号>`。codex 与 pi 用同一套键。

外部依赖（版本以 `package.json`、`Dockerfile` 为准）：

| 组件 | 事实 |
|---|---|
| `@earendil-works/pi-durable` / `pi-ai` 1.3.0 | 宿主 harness（`agent.sqlite`）与 pi 后端（`pi.sqlite`）的持久执行；pi-ai 提供模型与 provider |
| `@openai/codex` `0.164.0-alpha.8` | 镜像内固定版本；cs-agent 常驻一个 `codex app-server`（stdio JSON-RPC）。子 agent 唤醒 `wake_on_agent_messages` 自此版本起才有，仍处于开发中，升级前须复测（§4.3） |
| NapCat | Compose 服务 `napcat`，镜像按 digest 固定；cs-agent 经 `http://napcat:3000` / `ws://napcat:3001` 连接（[DEPLOY.md](DEPLOY.md)「NapCat 容器」） |
| magpie（宿主机） | codex 与 pi 的模型默认经宿主机 magpie 网关出站（[DEPLOY.md](DEPLOY.md)「模型出站：magpie」） |

## 2. 消息流：输入

### 2.1 触发与入库（`src/qq/`）

- `QQBridge`（`qq/bridge.ts`）：WS 收事件、HTTP 调动作、重连与心跳；过滤自回声；以 `self_id:type:group_id:user_id:message_id` 去重（`seen_messages`）。
- 授权（`qq/policy.ts`）：`QQ_ALLOW_USERS` 中的用户在任何地方都可触发；`QQ_ALLOW_GROUPS` 内的成员需真实 `at` 段（`QQ_GROUP_MENTIONS`）。正文、段都为空的消息（文件传输等系统事件）不投递，只记 `ignored`。
- 所有允许范围内的消息（含不触发的群消息）经 `raw` 事件写入消息库（§9）作上下文；**只有触发消息**进入 Inbox，群里其余消息不是输入。
- 群名由 `get_group_info` 缓存（6 小时 TTL），随入站消息传递并写入消息库 `scope_names`。
- 触发消息的图片在接纳后有界下载（§8.1），附件到达终态后才投递。

### 2.2 Inbox（`src/agent/inbox.ts`）

- 入站键由消息确定性生成；`qq-bridge.sqlite` 表 `inbound` 记录每条输入：`queued`（未交给后端）→ `delivered`（后端已确认收下）→ `done`（所在回合结束）。
- 定时任务到点同样作为一条输入投递（入站键以 `run_` 开头，发送者为创建者，§6）。
- 重启后宿主先恢复回合（§4.4），Inbox 再按 `seq` 重新投递 `queued` 输入；输入以入站键幂等。

### 2.3 ThreadHost（`src/agent/host/`）

每个会话键一份持久文档 `cs.thread-host`（宿主 harness，`agent.sqlite`），记录：是否忙、当前回合、本轮发送者、唤醒回合继承的人（`turnInherited`）、本轮输入、排队输入、本轮是否已 @、会话后端。每条输入另有 `cs.thread-host.input` 文档（`new | queued | starting | delivered | done`）。

**一轮只有一个人。** 每轮只用一条输入开轮；开轮成功后，队首紧随其后的同一发送者（owner 多账号算同一人）的连续用户消息逐条插话进本轮，遇到他人或定时即止。

| 输入 | 线程空闲 | 线程忙 |
|---|---|---|
| 用户消息，发送者与本轮相同 | 开新一轮 | 插话（codex `turn/steer` 带 `expectedTurnId`；pi `whenBusy: "steer"`）；被拒（回合恰好结束）则排队 |
| 用户消息，发送者不同 | 开新一轮 | 排队，本轮结束后按到达顺序开轮 |
| 定时任务 | 开新一轮 | 排队，空闲时开轮（不插话） |
| 子 agent 完成 | 后端原生开一轮唤醒（§4.3） | 后端原生排队 |

同一人的消息只插话进他自己的用户回合，**不插话进唤醒回合**（排队，唤醒回合结束后单独开轮）。不同会话完全并行；`AGENT_CONCURRENCY` 只限制同时进行中的回合数，超出的开轮请求排队，插话不受限。

输入交给后端之前（开轮、插话）先标为 `starting`，插话被拒改回 `queued`；崩溃后 `starting` 的输入可能已在后端里，只能按会话后端重新开轮（pi `requestId`、codex `clientUserMessageId` = 入站键去重）。

### 2.4 会话后端（`src/agent/turns.ts` 的 BackendRouter）

后端属于会话，不属于输入：会话文档的 `backend` 是唯一来源，开轮、插话、放弃、恢复都用它。首次见到会话时按配置选定：`AGENT_BACKEND`（默认 `codex`）+ `AGENT_BACKEND_OVERRIDES`（`group:<id>=pi,private:<qq>=codex`；owner 线程按 `QQ_OWNER` 首个账号的 `private:<qq>` 项），面板设置页可改。

之后只有同时满足以下条件才切换（宿主串行内、开新回合之前判断）：会话空闲；队列里只有将开轮的这一条；这条输入从未交给过后端；旧后端在该会话不忙（pi run 或子 agent 汇报未结束；codex 有进行中的回合、子 agent 或压缩）。任一不满足就沿用旧后端。不需要实时切换。两个后端的记忆互相独立；切换不压缩、不搬运历史，新后端靠期间消息（§9）接上切换前的对话。

### 2.5 每轮设置快照（`src/agent/turn-settings.ts`）

面板设置（后端、codex 模型与推理强度、pi 模型与思考档位）在**每轮开始时**冻结一次，进行中的回合不受之后的修改影响。档位为 `auto` 时按本轮输入选档（`src/agent/effort-router.ts`，定时与唤醒回合同样适用）：

- 快路径：去掉头部后 ≤12 字、无问号/代码符号/任务词 → `low`；含"仔细想/深入分析/认真思考/think hard" → `xhigh`。
- 否则用 `AUTO_EFFORT_MODEL`（magpie 下的模型，默认 `deepseek/deepseek-flash`）分类为 low / medium / high / xhigh，超时 `AUTO_EFFORT_TIMEOUT_MS`；失败回退到 `.env` 缺省档位（`effortSource: auto-fallback`），记 `effort_route` 事件。
- codex 经 `turn/start` 的 `model` / `effort` 生效；pi 按快照选模型与思考档位，模型不支持的档位就近收敛。codex 模型名必须是 magpie 目录中的完整 slug（如 `codex/gpt-6.1-sol`），不在目录中的值告警并回退。
- 换模型前先用原模型压缩一次（失败照常切换）。

### 2.6 输入的呈现

每条用户输入前加来源头（codex 与 pi 共用，`buildCodexPrompt`）：

```
[来源] 群 家庭群(123456) · 昵称(10001) · 10-22 14:03
[引用 #<message_id>] 昵称: 被引用的原文（≤200 字）
正文
[本轮参考图]
/data/incoming/<入站键>/...
```

群名、昵称折成单行、限 40 字并中和 `[来源]` / `[引用]` 标签，只作显示，不赋予授权语义；身份只取 Channel 的真实发送者，模型无法冒充。定时输入以 `[定时任务] …` 开头（§6）。历史不自动注入，模型需要时自己调检索工具（§9）。

## 3. 消息流：输出

### 3.1 send_message（`src/agent/send-service.ts`）

```ts
send_message({ text, images?: string[], files?: { path, name? }[], target? }) → { status, message_id, already_sent }
```

- 省略 `target`：发往本线程的会话，任何时候都能发（回合中、唤醒回合中）。子 agent 没有这个工具，只有主 agent 对外说话。
- `target`：只支持 ref `qq:group:<群号>` / `qq:private:<QQ号>`，不设别名表；模型从 `[来源]` 头和 `qq_chats` 推断。校验：格式；本轮的人是 owner 或持有覆盖本会话的有效 `send` 授权且 target 在其列表内（§5.4）；群在 `QQ_ALLOW_GROUPS` 且 bot 在群内、私聊对象是好友（缓存 5 分钟）；该 ref 当天（Asia/Shanghai）主动发送 < 100 条。主动发送不 @，消息写入**目标会话**的消息库。定时回合发出的所有消息都计入主动额度。
- 校验：文字 1–4000 字；每条最多 4 张图、3 个文件（单个 ≤ `ATTACH_FILE_MAX_MB`，默认 20 MiB），来源规则见 §8.2。不截断、不改写，失败原样返回给模型。
- 规则只写在一处受管位置：`SEND_RULE`（进入 codex 受管基础指令与 pi 的 `cs-pi` 段），不在每条消息里追加提醒；用户可编辑的 `codex.md` / `agent.md` 不承担这条规则。
- pi 进程内调用 SendService；codex 经独立 `im` MCP（`src/mcp/im.ts`）回环调用主进程 `/send`。

### 3.2 @ 规则与 Outbox（`qq-bridge.sqlite` 表 `outbox`）

- 群会话里，用户回合第一条发往本群的消息 @ 本轮发送者，之后不再 @；定时与唤醒回合不 @。发往本群时 `reply_to_id` = 本轮最后一条输入的 message_id。
- 行键 `<threadKey>:<callKey>`：pi 用稳定的 `toolCallId`，codex 用 MCP 请求的 `_meta.callId`，崩溃重放取回同一行。系统消息（出错提示、熔断通知）键为 `<threadKey>:sys:<uuid>`，不计主动额度。
- 状态机 `pending → sending → sent | uncertain`；sending / uncertain **永不自动重发**。同目标相同正文哈希复用已有行；结果不确定时以非错误结果告诉模型"可能已送达，不要重发"。
- 文字（含图片段，`base64://`）发出后逐个上传文件（`upload_private_file` / `upload_group_file`，`base64://`，群里放根目录），每个文件单独持久化状态；启动与每个回合结束时补传 `pending` 的文件。
- 每条成功消息立即写一行机器人消息进消息库，可按 message_id 引用与检索。

### 3.3 发送规则（防失控，`src/qq/send-rules.ts`）

所有出站消息（含系统消息，不含 owner 运维告警）在 bridge 统一过规则，与模型、后端无关；不设单轮条数上限：

| 规则 | 默认 | 触发后 |
|---|---|---|
| 每会话每分钟 | 6 条 | 拒绝本条，告诉模型"发送过快" |
| 每会话每小时 | 60 条 | 熔断该会话 60 分钟，通知 owner |
| 全局每分钟 | 30 条 | 熔断全部发送 10 分钟，通知 owner |
| 每目标每日主动 | 100 条 | 拒绝主动发送（SendService 计数） |
| 单条长度 | 4000 字 | 拒绝 |

数值在面板设置页"发送规则"可调（`settings.json` 的 `sendRules`），熔断在面板查看与解除；计数与熔断存于 `send_log` / `send_breakers`。被拒的行不计数；系统消息被拒只记告警。

### 3.4 出错提示、看门狗与停止（`src/agent/turns.ts` 的 TurnMonitor）

只在出错时向会话发一条系统消息，同一会话 10 分钟内最多一条（`src/agent/replies.ts`）：

| 情况 | 文案 |
|---|---|
| 回合失败（提供方报错、codex `turn/completed` 非 completed、pi 回合 error、看门狗中止） | 这次处理出错了，需要的话请再说一次。 |
| 后端进程崩溃导致回合丢失 | 处理中断了，需要的话请再说一次。 |
| 输入投递失败（后端不可用超过 2 分钟） | 现在暂时处理不了，请稍后再试。 |

模型正常结束但没发消息：不提示。定时回合失败只记入运行记录，不向会话提示。

- 看门狗：回合**连续 30 分钟没有任何事件**（模型输出、工具调用、子 agent 活动）视为卡死，中止并提示（`STALL_MS`）。
- 面板会话行"停止"：codex `turn/interrupt`，pi `conv.abort`，连同子 agent 一起停；排队的输入随后照常处理。

## 4. 执行后端

### 4.1 codex：常驻 app-server（`src/agent/codex/`）

- **进程**：cs-agent 启动并监管**一个**常驻 `codex app-server`（`app-server/supervisor.ts`），承载所有会话线程。进程退出、管道错误或握手失败即视为掉线：按 1 s→60 s 退避重启（稳定运行后归零），并清理进程树。环境变量走白名单（PATH/HOME/LANG/TERM/TZ/代理、`CODEX_HOME`），magpie 模式只额外注入 `CODEX_MAGPIE_KEY`。
- **线程**：每个会话键一条线程，映射在 `/data/codex-threads.json`；首次 `thread/start` 后立即原子落盘，之后 `thread/resume`，只有确认线程不存在（`no rollout found`）才归档旧映射并新建。线程空闲、开新一轮前检查安全阀：rollout 超过 `CODEX_ROLLOUT_MAX_MB`（50）或线程超过 `CODEX_THREAD_MAX_DAYS`（90）天则轮换，历史靠 `qq_context` 找回。面板可重置或压缩（`thread/compact/start`）线程。
- **压缩**：换模型前先用原模型压缩一次（失败照常切换）。
- **线程级配置**：`thread/start` / `thread/resume` 的 `config` 用点号键注入：命名权限 `cs_agent_scope`（`codex/workspace.ts`，与 `sandbox_mode` 互斥）、`model_instructions_file`、`project_doc_max_bytes`、`im` / `qq_context` 两个 MCP 的线程令牌（`mcp_servers.<名>.env.IM_TOKEN` / `QQ_RECALL_TOKEN`）。app-server 为每个线程单独起 MCP 进程（同一线程跨回合复用）；令牌只证明"来自哪个线程"，线程重新加载或 app-server 重启时作废重发。工作目录 `/workspace/<会话键>`（冒号换下划线）；approval policy `never`。
- **回合**：开轮 `turn/start`（`effort`、`model` 为本轮快照，`clientUserMessageId` = 入站键）；插话 `turn/steer`；停止 `turn/interrupt`；结束 `turn/completed`。适配层把每个服务端回合分类一次（user / wake / compaction / suppressed）；MCP 调用按 `_meta.callId` 登记到所属回合，子 agent 线程与过期回合的调用一律拒绝。
- **受管 `config.toml`**：入口脚本每次启动按环境变量重写（provider、模型缺省值、web_search、`[features]` 的 `apps = false`、`multi_agent = true`、`wake_on_agent_messages = true`、可选 `plugins = false`、MCP 段等，见 [DEPLOY.md](DEPLOY.md)「codex 配置」）。
- **提示词层次**（全部以 user 角色进入上下文；不用无法更新已有线程的 `developer_instructions`）：
  1. 基础指令：`DATA_DIR/prompts/codex-base/<slug>.md`（每个模型一份，首次从模型目录的 `instructions_template` 播种，可在设置页编辑或恢复目录默认）+ 固定的 QQ 受管规则，拼成 `CODEX_HOME/base-instructions/<slug>.md`，经 `model_instructions_file` 生效。
  2. 全局指引 `CODEX_HOME/AGENTS.md`：通用保密与会话隔离说明 + 用户可编辑的 `DATA_DIR/prompts/codex.md`（面板保存，校验 revision、≤64 KB、拒绝含秘密的内容）。
  3. 会话域受管 `AGENTS.md`（`/workspace/<key>/AGENTS.md`，首行受管标记）：按该线程实际权限渲染可写目录、聊天记录与图片、发送图片与文件、技能规则，以及本会话的记忆段（画像与未完成承诺，§9.1），并拼入运维维护的 `/workspace/AGENTS(.override).md`。加载线程前生成，内容不变不重写；模型改写后下次加载线程时恢复。

  已加载线程是否在同一 app-server 进程内重读改动后的 AGENTS.md 取决于 codex；要立即生效就重置该会话线程或重启容器。
- **崩溃**：app-server 不可持久恢复。掉线时进行中的回合、子 agent、后台进程丢失；其中已 `delivered` 的输入标 `done`，向会话发"处理中断了"，不自动重放（避免重复执行有副作用的操作）。长任务用 pi 更稳。

### 4.2 pi：进程内 harness（`src/agent/backends/pi.ts`、`src/agent/pi-tools/`）

- **会话**：独立 `Harness.open`（`DATA_DIR/pi.sqlite`），每个会话键一条 ownerless 长期会话；映射写在 session 文档 `cs.pi.threads`，`pi-threads.json` 是其原子镜像，启动从 SQLite 重建。工作区 `DATA_DIR/pi-work/<key>`。
- **回合**：开轮 `conv.submit({ type: "input", requestId: 入站键, whenBusy: "followUp" })`，同一发送者插话 `whenBusy: "steer"`；回合结束由会话 idle 事件驱动宿主。
- **工具**：`read` / `write` / `edit` / `bash`（`PiPathPolicy` + bwrap 沙箱，§5.5）、`web_search` / `fetch_page`（DeepSeek Search/Fetch API 直连，需 `DEEPSEEK_API_KEY`）、`qq_recent` / `qq_search` / `qq_message` / `qq_image` / `qq_chats`、`send_message`、按本轮权限出现的 `auth_*` / `schedule_*`、`mem_*`（§9.1）、`subagent`。工具调用不按回合计次。每轮开始（含唤醒与重启恢复）时按本轮的人重新选择 IM、定时与记忆工具集；调用时服务端逐次复核。
- **提示词**：pi-durable 把各 section 合成为最前面的一条 system 消息，内容不变不重发（保住提示缓存）：
  1. `cs-pi`：受管规则（发送、链接、安全、工作区、子 agent 用法、记忆工具的使用规则）+ `DATA_DIR/prompts/agent.md`（仅人设、语气与输出格式；缺失时播种，已有不覆盖，按 mtime/size 热加载）。工具使用指引放在各工具描述中。
  2. `project-context`：运维层 `WORKSPACE_DIR/AGENTS.md` 与会话层 `DATA_DIR/pi-work/<key>/AGENTS.md`，各按 `AGENTS.override.md → AGENTS.md → AGENTS.MD → CLAUDE.md → CLAUDE.MD` 取第一个普通文件（≤128 KiB、严格 UTF-8、去 BOM、拒绝链接），渲染为 `<project_instructions path="…">`。主进程直接读取，不向上遍历，不读 `/data/AGENTS.md`；cwd 不是 `pi-work` 的直接子目录时只用运维层并告警一次。语义参照 pi-coding-agent 的 `loadProjectContextFiles`，未引入该包（[THIRD-PARTY.md](THIRD-PARTY.md)）。
  3. `memory`：本会话的画像与未完成承诺（§9.1），空则不渲染。
  4. `skills`：可用技能列表（§7）。
- **压缩**：harness 级自动压缩开启，`PI_COMPACTION_RESERVE_TOKENS`（16384）/ `PI_COMPACTION_BACKGROUND_TOKENS`（32768）/ keepRecentTokens 20000；不轮换，压缩不删除数据库原文。换模型前先用原模型压缩一次（失败照常切换）。
- **模型**：`AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID`；为 `magpie` 时启动拉一次 magpie 目录注册为 pi-ai provider（`src/agent/magpie-models.ts`）：codex 模型走 `openai-responses`，其余走 `openai-completions`；pi-ai 有内置定义的模型（如 deepseek-flash）继承其 `thinkingLevelMap`、`compat`、价格，窗口以 magpie 为准。日/周摘要用同一模型。
- **恢复**：pi-durable 持久化，进程重启后进行中的回合与子 agent 自动续跑，`delivered` 输入无需处理。

### 4.3 子 agent 与唤醒

长任务派子 agent，主 agent 结束本轮；子 agent 完成时唤醒主 agent，由它汇报。两个后端的受管提示都写明"长任务先告知用户、派子 agent 后结束本轮，收到结果再汇报"。模型漏发结论时系统不自动补一步。

- **codex**：受管配置开启 `features.multi_agent` 与 `features.wake_on_agent_messages`；子 agent 完成后 app-server 自己开一轮（`turn/started`），宿主据此识别"没有新输入的唤醒回合"。适配器求出派出者并随 `onTurnStarted` 交给宿主；求不出就只有会话基础权限。后台终端命令跑完**不会**唤醒。codex 子 agent 线程调用 cs-agent 的 MCP 工具（`qq_context` 召回、`im` 的发送与记忆工具）一律在主进程求绑定时被拒绝（"子 agent 不能使用此工具"），所以 codex 子 agent 没有记忆工具。升级 codex 前须复测：父线程收到 `subAgentActivity kind=completed` 后应很快出现 `turn/started`。
- **pi**：`subagent` 扩展（`pi-tools/subagent.ts`，仿 pi-durable 示例 `23-subagent-background`），动作 `spawn / message / status / list / stop`，每会话同时存活 ≤3 个、每天派出 ≤20 个。后台锚定任务持有子会话，完成后汇报任务把结果作为 follow-up 输入（`[子 agent 完成]`）投回父会话。子会话工具集与父相同但不含 `subagent`、`send_message`、`auth_*`、`schedule_*` 与记忆写工具（只留 `mem_search` / `mem_list`）；读取权限继承派出者在本会话的权限。
- **身份随汇报带回**：spawn 时快照这一轮的人，登记在 `cs.subagent.children` 并写入汇报输入；唤醒回合继承它（§5.1）。`message` 给已有子 agent 时与这一轮的人合并，不是同一人就降为基础权限，之后的汇报都带合并后的身份。

### 4.4 重启顺序

宿主先恢复回合（pi 续跑；codex 丢失的回合发"处理中断了"），Inbox 再按到达顺序重新投递 `queued` 输入；Outbox 中 sending / uncertain 的消息不重发；定时排程任务按检查点继续（§6）。

## 5. 身份与权限

### 5.1 每个回合绑定一个人

每次工具调用（发送与 target、召回与历史读取范围、参考图、定时、授权、技能发布）都按本轮绑定的人检查，统一在 `src/agent/host/identity.ts` 求出 `runRights`，各工具不再按回合类型或会话自行判断。

| 回合 | 绑定的人 |
|---|---|
| 用户输入 | 发送者（一轮只有一个发送者；owner 多账号算同一人） |
| 定时输入 | 创建者；没有 `auth_*`，授权按当前授权表复核 |
| 唤醒回合 | 派出该子 agent 的那一轮的人（派出时快照）；唤醒回合派出的再唤醒时沿链继承。同一唤醒回合带回多个汇报而派出者不是同一人或类型不同 → 基础权限 |

**无法确证就只有会话基础权限（fail closed）**：没有派出记录、不是汇报的 run、宿主尚未确认或已放弃的回合、数据缺失或不一致，一律回落基础权限，绝不向上回落。owner 标记只降不升：快照时与当前配置都必须是 owner。

### 5.2 两层权限

- **会话基础权限**（任何回合都有）：读本会话范围、只发往本会话；没有 target、没有 `schedule_*`、没有 `auth_*`。
- **人的权限**（只在确证时叠加）：owner 全权（target 不查授权表、`skill_publish`、交互回合有 `auth_*`）；他人按授权表（`send` 开放 target，`schedule` 开放定时管理）。群里每个人的权限仍按人区分。

### 5.3 读取范围按线程，不按人

共享会话（群）的线程历史对会话里所有人可见：一轮读进上下文的内容，之后任何人的回合都可能间接看到。因此**读全部只在 owner 私聊线程**；群线程无论谁发言（包括 owner）都只读本群；其他私聊只读本人。要查别处，到 owner 私聊里查。`qq_chats`（列出群名/群号与好友备注，每类 ≤200 条）同样只在读全部的回合可用。

### 5.4 授权表与授权工具

- `GrantsDoc`（`cs.grants`，宿主 harness 的 session 文档，`src/agent/grants.ts`）以 `qq:<号>` 为键：`caps`（`send` / `schedule`）、`targets`（可主动发往的 ref）、可选 `scopes`（在哪些来源会话生效）、`expires_at`。过期授权只读展示、不生效。
- 只能由 owner 修改：面板设置页"授权"（owner 运维口令 + 同源/CSRF），或 owner 交互回合里的 `auth_grant` / `auth_revoke` / `auth_list`。变更记 `auth_changed`（来源、操作者、前后差异）。
- 工具可见性：pi 按回合配置工具；codex 的 `im` 子进程启动时查询 `/im-info`，仅有权回合列出 `target`，仅 owner 交互回合列出 `auth_*`；服务端每次调用都复核。

### 5.5 文件系统权限

- **codex**：命令在 codex 自带的 bwrap 沙箱执行（需 compose 的自定义 seccomp profile）。每个线程的命名权限收窄可写根：owner 线程为 `/workspace/owner`、`/data/prompts`、`/data/codex/skills/shared`；其他会话只有本会话目录；其他会话工作区、`/data/pi-work`、`/data/codex/trace` 不可读。系统级 `/etc/codex/requirements.toml` 的 `deny_read` 禁读凭据、会话、SQLite、运行日志、图片/附件/媒体目录与面板口令。细节见 [DEPLOY.md](DEPLOY.md)「codex 权限」。
- **pi**：`PiPathPolicy` 校验 `read/write/edit`，`bash` 在 bwrap 中只把本会话工作区绑定为可写（每条命令一个独立 `/tmp`，不跨命令保留）；禁读沿用 codex 的 `deny_read` 加 pi 自身状态与 codex 工作区。仅 `access.kind = "all"` 的主人回合可只读访问 `DATA_DIR/observability.sqlite`（含 `-wal/-shm`）与 `DATA_DIR/logs/`；路径检查与 bwrap 展开使用同一例外，其余库和凭据仍禁读。观测库用 `node:sqlite` 的 `{ readOnly: true }` 打开，WAL 侧文件须已存在且可读。技能目录对任何回合都只读（写技能只走 `skill_publish`，§7）。
- `AGENTS.md` 只约束模型行为，不是访问控制。

## 6. 定时任务（`src/agent/schedule/`）

**定时任务只跑提示词。** 到点在创建它的会话（线程）里跑一轮提示词；发不发、发给谁、怎么发都写在提示词里。目标用 ref，没有别名表。

- **定义** `SchedulesDoc`（`cs.schedules`，宿主 harness）：`id`、`revision`、`name`（1–64 字）、`prompt`（1–8000 字）、`conversation`（来源会话，不可改）、`rule`（`rrule` 或一次性 `at`，Asia/Shanghai）、`status`（active / paused / completed）、`options`（`stale_after_ms` 默认 10 分钟；`timeout_ms` 仍保存但不限制回合时长）、`next_fire_at`、`runs`（最近 20 条，在途的不裁剪）、`failures`、`created_by`。
- **校验**：`rrule@2.8.1`，`DTSTART;TZID=Asia/Shanghai`（rrule.js 把北京墙钟放进 UTC 字段，`nextFireAt` 统一减 8 小时）；RRULE 字段白名单、禁止嵌入 DTSTART/TZID、UNTIL 须为 UTC、遍历限时 250 ms；最小间隔 owner 5 分钟、被授权人 30 分钟；被授权人最多 5 条 active；`at` 必须在未来。创建者须是 owner 或持有覆盖来源会话的 `schedule` 授权，非 owner 不得在 owner 线程建任务。
- **排程**：每条 active 定义一个 background durable 任务 `cs.schedule`：`wait`（检查点 `next_fire_at`，`runtime.sleep`）→ `fire`（一次提交内：重读定义，失效则退出；迟到超过 `stale_after_ms` 记 skipped(stale)，停机期间错过的合并为一条；上一轮仍未结束记 skipped(overlap)；否则接纳并记 queued；从"现在"往后算下一次）。**错过的不补跑。** 服务启动及每 10 分钟巡检，缺失或已终结的排程任务重建。`run_now` 不改 `next_fire_at`。
- **运行**：接纳时向来源会话投一条定时输入（入站键 `run_` + fire_key 哈希，发送者为创建者），线程忙则排队到空闲；运行记录保存在 session 文档族 `cs.schedule.run`，成员键为入站键，不另建会话。输入外壳：

  ```
  [定时任务] <名称> · 计划时间 <MM-DD HH:mm>（北京时间）· 第 n 次 · 创建者 qq:<id>
  <提示词>
  [最近运行] <最多 3 条>
  [说明] 这是定时任务，不是用户消息。需要通知就调用 send_message（可带 target），不需要就直接结束。需要停止后续触发时调用 schedule_control……
  ```

  `send_message` 不带 target 时发回该会话，不 @。权限按创建者求出，无 `auth_*`；创建者已失去权限则本次记 failed 并暂停。
- **结果**（`run.ts`）：统计该输入所在回合发出的消息：有发送 → `sent`，无 → `silent`（静默，不兜底），回合失败/丢失/投递不确定 → `failed`。sent / silent 清零失败计数；连续 3 次 failed 自动暂停（`pause_reason = 连续 3 次失败`）并告警。
- **管理**：面板"定时任务"页与 JSON 接口 `/api/schedules` 只支持查看、暂停、恢复、立即运行和删除；创建与修改任务通过聊天工具完成。聊天里 `schedule_create / list / update / pause / resume / delete / run_now`（仅当前的人通过 `canSchedule` 的交互回合可见；owner 管理全部，他人只管自己的）。来源与 `created_by` 取本轮会话与确证的人，模型不能指定。规则使用北京时间 `YYYY-MM-DD HH:mm`；工具说明要求把"家庭群"等目的地先用 `qq_chats` 解析为具体 ref 写进提示词，按需静默的监控注明"无新内容则静默"。定时回合内只开放 `schedule_control({ action: pause | complete, reason })`，目标按本轮定时输入键从运行文档读取，不打断当前回合。

## 7. 技能（skills）

- **共享目录**：宿主机 `SKILLS_DIR`（默认 `./data/skills`）同时挂到 `/data/skills`（pi）与 `/data/codex/skills/shared`（codex 只扫 `$CODEX_HOME/skills`，会递归子目录），读写挂载。入口脚本的插件清理不触碰 `skills/shared` 与 `.system`。
- **pi 加载**（`pi-tools/skills.ts` 的 `SkillsLoader`；`PI_SKILLS_DIR` 空 = 默认目录，`off` 禁用）：深度 ≤3，含 `SKILL.md` 的目录即技能根且不再下探；跳过 `.` 开头目录、`node_modules`、符号链接、>256 KiB 的 SKILL.md。frontmatter `name`（缺省取目录名）、`description`（必填，缺失跳过）、`disable-model-invocation: true` 隐藏；同名先到先得。渲染为 `<available_skills>`（name / description / location），模型用 `read` 读全文。按目录树的 `(path, mtime, size)` 缓存，每轮检查。
- **写入**：两个后端的沙箱都不能直接写共享技能目录，增改技能只有一个入口——`skill_publish({ path, overwrite? })`：agent 在本会话工作区写好 `<name>/SKILL.md`（改已有技能先复制过来），由主进程把该目录发布到共享目录（`SkillsStore.publishDir`：只收普通文件，跳过 `.git`，拒绝链接与工作区外路径，校验与限额同面板 ZIP 上传，替换为原子改名）。放行条件是本轮确证的人是 owner（`runRights`，含继承 owner 身份的唤醒回合），不限私聊或群聊；codex 经 im MCP 与线程令牌到主进程复核，pi 只在这样的回合注册该工具并在调用时复核；子 agent 没有此工具。codex 的沙箱权限按线程固定、不能按回合切换，所以写权限做成主进程工具而不是可写目录。从 GitHub 安装用共享目录里的 `install-skill` 技能（下载到工作区再发布）。codex 已加载线程何时重扫技能目录未实测，要立即生效就重置线程。
- **面板 `/skills`**（`src/agent/skills-store.ts`）：列表（含诊断）、查看 SKILL.md、上传（zip 或单个 SKILL.md，multipart，≤20 MiB）、下载 zip、删除。zip 用 `fflate` 解析：拒绝绝对路径、`..`、Windows 设备名/ADS、大小写冲突，单文件 ≤5 MiB、条目 ≤500，链接条目按普通文件落盘；先写 `.tmp-*` 再改名到位，删除先改名再删（加载器跳过 `.` 开头目录，中间态不可见）。

## 8. 附件与图片

### 8.1 入站图片

只下载已授权且触发机器人的本条消息的图片：最多 3 张，每张 12 B–10 MiB，PNG/JPEG/WebP/GIF 魔数，只解析头部尺寸（边长 ≤4096、≤20 MP），拒绝动画。优先 OneBot 图片段的 `url`，失效时用 `file` 调 `get_image` 刷新；不读 NapCat 返回的宿主机路径。下载防 SSRF：只 HTTP(S)、解析全部 DNS 地址并拒绝内网/回环/链路本地、连接固定到校验过的 IP、手动重定向 ≤3 跳且每跳重验。每 scope 一个下载任务，全局 `INCOMING_DOWNLOAD_CONCURRENCY`（2），每位发送者在途 ≤2 条，截止 `INCOMING_DOWNLOAD_DEADLINE_SEC`（60 s，含排队，重启不重新计时）；超额或超时记 skipped 无图继续，校验失败记 failed。文件存 `/data/incoming/<入站键>/`，以 `[本轮参考图]` 列给模型，7 天后由衰老任务清理。

### 8.2 出站图片与文件

`send_message` 的 `images` / `files` 只接受：本会话工作区内的普通文件、本轮读取范围内已召回的媒体（`/data/media/<sha256>`）、本线程的 codex 内置生图输出（`/data/codex/generated_images/<线程>`）。逐级 lstat 拒绝链接与特殊文件，O_NOFOLLOW 打开，读取期间 inode/大小不变，按 sha256 去重（`src/media/attach.ts`）。文件名取 basename、去控制字符、≤120 字；扩展名黑名单 `ATTACH_FILE_DENY_EXT`。副本先复制到 `/data/images/<会话键>/outbox/<uuid>/`，回合结束时清理一小时前且已发完的副本。

### 8.3 生图

cs-agent 不提供生图工具。codex 自带的内置生图（`.system` 技能 `imagegen`）不受干预，输出在 `/data/codex/generated_images/`，把返回的路径传给 `send_message` 即可发出；该目录按保留天数与总量清理（[DEPLOY.md](DEPLOY.md)）。pi 没有生图工具。

## 9. 聊天记录与检索（`src/context/`）

- **消息库** `/data/qq-messages.sqlite`（WAL）：允许范围内的全部消息、机器人发出的每条消息、日/周摘要；trigram FTS5（2 字中文词回退 `LIKE`）。所有读取带访问范围过滤（`context/access.ts`）。撤回删除原始行。
- **衰老**（`context/aging.ts`）：每天 `HISTORY_SUMMARY_HOUR` 点（容器 `TZ`，默认 Asia/Shanghai）：≥5 条消息的会话日生成 ≤400 字日摘要，已结束的自然周合并为周摘要；原始消息超过 `HISTORY_RAW_DAYS`（30）且已被摘要覆盖才删除，未覆盖的最多保留 `HISTORY_RAW_HARD_MAX_DAYS`（90）天；摘要保留 `HISTORY_SUMMARY_DAYS`（180）天。上次运行早于 24 小时则启动补跑。
- **检索工具**：`qq_recent` / `qq_search` / `qq_message`（总量 ≤`QQ_CONTEXT_MAX_CHARS`，2500 字）、`qq_chats`。**按需检索**：只有消息指代此前内容或用户要求回顾时由模型自己调用。自动带入的历史只有两种：`[引用]` 行，与首条用户输入前的 `[期间消息]`，即同会话里本后端上一条用户输入之后、这条输入之前的消息，去掉本后端自己的发言（按 Outbox 回合 id 前缀判断），最多 20 条、1500 字；本后端从未处理过该会话或其位置已清理时回看 24 小时（`src/agent/inbox.ts`）。群里未触发的发言与另一后端期间的对话由此进入上下文。
- **图片按需召回**：消息默认只存 `[image]`，不存 URL、不下载。`qq_image(message_id)` 下载到媒体库并只返回路径文本，正文改为 `[image:<路径>]`；看图用各自的文件工具（pi `read`，codex `qq_view_image`）。codex 每回合召回 ≤`MEDIA_RECALL_MAX_PER_TURN`（默认 5；旧名 `MEDIA_RECALL_MAX_PER_TICKET` 仍可用）；pi 不按回合计次。媒体随原始消息保留，每日 GC 回收无引用文件。
- **codex 接入**：`qq_context` MCP（只读库连接）经主进程 loopback 服务（`MEDIA_RECALL_PORT`，仅 127.0.0.1）完成召回与 `qq_chats`；主进程凭线程令牌与 `_meta.callId` 确认调用属于会话当前回合，再按本轮权限求出范围。pi 直接调用同一服务。

### 9.1 记忆（`src/context/memory/`、`src/agent/memory/`）

消息库之上的派生层：回答"你是谁、偏好什么、定过什么、答应过什么"，不回答"某天聊了什么"。设计与后续分期见 [MEMORY-DESIGN.md](MEMORY-DESIGN.md)；现在只有回合内的显式工具与面板，没有回合后抽取与夜间整理。

- **存储**：`/data/memory.sqlite`（WAL，`context/memory/store.ts`；与 `/data/memory/` 一样在 codex 与 pi 的禁读名单里，只能经记忆工具与面板读写）：`memories`（命名空间、种类 fact / preference / rule / commitment / episode、subject、一句话正文 ≤500 字、生效与失效时间、承诺的截止与完成时间、状态 active / superseded / retired / orphaned / forgotten、作者、来源会话与消息 id、回合 id、召回统计、去重哈希）、`memory_versions`（每次正文或状态变化一行，前后快照与原因）、`memory_links`（`supersedes` 取代链）；`memories_fts` 为 trigram FTS5，content 表触发器同步。命名空间与会话键一致（`owner`、`group:<id>`、`private:<qq>`）。哈希为 `ns + kind + 规整后正文` 的 SHA-256，同命名空间的 active 条目重复写入时返回已有条目。存储不认识权限，与消息库互不 import。
- **画像**：每个命名空间一份 `/data/memory/<ns>/profile.md`（冒号换下划线），纯文本 ≤4 KiB（超限的不进入提示，`mem_profile` 提示重写）；画像目录与文件不可为链接、真实路径须在画像根目录内；revision = mtime + size + 内容哈希，写入必须带读到的 revision（CAS），含凭据样式内容拒绝（与提示词编辑器同一条规则，`shared/redact.ts` 的 `containsSecret`）。
- **权限**（`agent/memory/service.ts`，每次调用按 `runRights` 重新求出）：owner 私聊且读全部的回合读全部命名空间、写 `owner`，`subject` 写成 `group:<id>` / `private:<qq>` 时记入那个会话，并可管理任意命名空间的条目；群线程（含 owner 在群里）只读写本群；其他私聊只读写本人；本轮没有确证的人时只读不写；pi 子 agent 只读；codex 子 agent 没有记忆工具（与 `qq_context` 相同，子线程的 MCP 调用一律拒绝，§4.3）。画像只在 owner 本人的回合、只写本线程命名空间。
- **工具**：`mem_search`（关键词子串匹配，最近召回优先、其次最新；命中记召回统计）、`mem_list`（承诺按截止排序）、`mem_remember`（可带 `supersedes`，同事务取代旧条目）、`mem_update`、`mem_forget`（只标记）、`mem_profile`。输出每条一行 `#id [kind] (时效) 正文 ← 来源 会话 #消息`，总量 ≤`QQ_CONTEXT_MAX_CHARS`；写入前过秘密检测；每轮写入 ≤20 次。使用规则只定义在 `agent/memory/tools.ts` 的 `MEMORY_RULE`，pi 放在 `cs-pi` 受管段，codex 放在 `mem_remember` 的说明里。trace 事件 `memory_recall`（工具名与命中 id，不记正文）、`memory_write`（作者、命名空间、种类、是否取代）。
- **两个后端**：pi 由 `pi-tools/memory.ts` 注册（读工具一个扩展，写工具按本轮权限分两档，`mem_profile` 只在 owner 档）。codex 的 `im` MCP 固定列出六个 `mem_*`，经线程令牌 loopback（`/mem_*` 端点）回主进程，`ThreadTokens` 求出本次调用的绑定后交给同一个服务复核。
- **提示注入**：只注入画像全文与未完成承诺的前 10 条（按截止升序，无截止的在后），渲染为 `<memory ns="…" profile_revision="…">` 段（`agent/memory/render.ts`），两者都空时不渲染。pi 为 `memory` section；codex 写进会话域受管 `AGENTS.md` 的"记忆"一节，随加载线程生成，已加载的线程何时重读取决于 codex（§4.1）。其余条目不自动注入，由模型按需 `mem_search`。
- **面板**：`/memory/entries`（列表与筛选）、`/memory/entries/<id>`（正文、来源、取代链、版本历史），可遗忘与恢复（[DASHBOARD.md](DASHBOARD.md) §8.4）。

## 10. 存储

镜像内 `/app/source/` 保存本次构建的源码、测试与文档，只读；`COMMIT` 记录部署提交与构建时间（`CS_AGENT_COMMIT` / `CS_AGENT_BUILT_AT`），启动日志记录同一版本。主人线程的固定系统提示给出自查路径，权限仍逐回合校验。

| 位置 | 内容 |
|---|---|
| `data/agent.sqlite` | 宿主 harness：`cs.thread-host*`（会话宿主与输入）、`cs.grants`、`cs.schedules` / `cs.schedule` / `cs.schedule.run` |
| `data/pi.sqlite`、`pi-threads.json` | pi 长期会话与子 agent 会话、`cs.pi.threads(.archive)`；JSON 是映射镜像 |
| `data/qq-bridge.sqlite` | `inbound`、`outbox`、`seen_messages`、`send_log` / `send_breakers`；旧版遗留的 `tickets` 表原样留在磁盘上，不再读写 |
| `data/qq-messages.sqlite` | 消息库（机器人消息带 Outbox 行键 `messages.outbox_key`）、摘要、`scope_names`、媒体引用 |
| `data/memory.sqlite` | 记忆条目 `memories`、版本 `memory_versions`、取代链 `memory_links`、`memories_fts`（§9.1） |
| `data/memory/<ns>/profile.md` | 各命名空间的核心画像（ns 的冒号换下划线，≤4 KiB） |
| `data/observability.sqlite` | 观测事件（`events.key`：`turn:<id>`、`in:<入站键>`、`thr:<会话键>`；`@` 开头为管理事件）与指标、会话索引、摘要血缘与召回记录（`recall_events.turn_id`），见 [DASHBOARD.md](DASHBOARD.md) §9 |
| `data/logs/` | `cs-agent.jsonl`：与 stderr 同级别、同脱敏对象的 JSON 行；10 MiB 轮转，保留 `.1`～`.3`，正常退出前排空写入 |
| `data/codex/`（`CODEX_HOME`） | 受管 `config.toml`、生成的 `AGENTS.md`、`base-instructions/`、sessions、trace、`generated_images/`、`skills/shared`（挂载） |
| `data/codex-threads.json`、`codex-threads-archive.jsonl` | codex 会话线程映射与重置归档（保留 200 条） |
| `data/prompts/` | `codex.md`、`agent.md`、`codex-base/<slug>.md`（可编辑提示词） |
| `data/settings.json` | 面板运行时设置（后端、模型、档位、发送规则、告警） |
| `data/context-usage.json` | 每线程上一轮输入占用（`backend:key`） |
| `data/incoming/`、`data/images/<键>/outbox/`、`data/media/` | 入站参考图、出站副本、召回媒体 |
| `workspace/<键>/`、`data/pi-work/<键>/` | codex / pi 会话工作区 |

数据卷细节、备份与清理见 [DEPLOY.md](DEPLOY.md)「数据卷」。

## 11. 模块地图

分层自下而上，只允许向下 import（含 `import type`），由 `test/architecture/deps.test.ts` 守卫：

| 层 | 目录 | 职责 |
|---|---|---|
| 0 | `shared/` | 日志、脱敏、trace 事件总线、usage/错误归一化、格式化、来源头字段清洗、owner 判定、定时与记忆工具名契约 |
| 1 | `config.ts` | 环境变量 → 原始配置（zod），不 import 业务模块 |
| 2 | `media/` | 下载与 SSRF 防护、图片头与限额、附件来源校验、参考图校验 |
| 3 | `channel/` | 通道公共契约：入站记录、Outbox、发送规则、回合身份类型（不依赖 qq / context / agent） |
| 4 | `qq/` | OneBot 传输（`bridge.ts`）、授权与触发（`policy.ts`）、`inbound` / `outbox` 持久化（`reply-store.ts`）、入站附件（`incoming.ts`）、发送规则执行（`send-rules.ts`）；`qq/types.ts` 是契约 |
| 5 | `context/` | 消息库、衰老、访问范围、格式化、媒体库与召回服务、`qq_context` 工具门面、观察者接口；`memory/`：记忆库与画像文件（只依赖 shared，与消息库互不 import） |
| 6 | `agent/` | `inbox.ts`、`host/`（ThreadHost、`identity.ts`）、`turns.ts`（BackendRouter / TurnMonitor）、`backends/`（codex / pi 适配）、`codex/`（app-server 客户端与监管、runner、提示词、工作区权限、模型目录）、`pi-tools/`（pi 扩展、沙箱、子 agent、技能、项目指引、记忆工具）、`memory/`（记忆服务：权限、工具语义、提示段渲染，不依赖后端实现）、`schedule/`、`send-service.ts`、`grants.ts`、`settings.ts`、`turn-settings.ts`、`effort-router.ts`、`skills-store.ts`、`magpie-models.ts` |
| 7 | `obs/` | 观测存储与指标、面板路由与页面（`ui/`）、会话 / 上下文 / 记忆视图、告警 |
| 8 | `mcp/` | codex 的 stdio MCP 入口：`qq-context.ts`（检索、召回、`qq_chats`）、`im.ts`（发送、授权、定时、技能发布、记忆） |
| 9 | `main.ts` | 组合根：加载配置 → 打开 harness → 恢复 → 启动 bridge、宿主、排程、面板 |

`src/main.ts`、`src/mcp/qq-context.ts`、`src/mcp/im.ts` 被入口脚本与受管 `config.toml` 以 `dist/...` 路径引用，移动时须同步。
