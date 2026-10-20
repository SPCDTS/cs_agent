# 定时任务与统一发送（设计 v2，2026-10-20，取代 DESIGN-pi-heartbeat.md）

> 页面版（含图）：https://claude.ai/artifact/NwwBzUGdCpoQo7TXFjAMHw 。本文件是实现依据，二者冲突时以本文件为准。

## 1. 已定的决策（用户 2026-10-20）

| # | 决策 |
|---|---|
| D1 | 定时任务与回复解耦：到点在来源会话里跑一轮提示词；发不发、发到哪、怎么发都写在用户创建任务时的提示词里。 |
| D2 | 默认 thread 模式（pi、codex 都直接在会话主线程里跑）；fork 只作可选项。 |
| D3 | 统一发送工具 `send_message`：所有回合都靠它发消息；模型的最终回答不再自动发出，只留在会话历史与 trace。 |
| D4 | 入站消息回合结束时一条都没发 → 发现有兜底 `FALLBACK_REPLY`（"抱歉，这条消息处理失败了，请稍后再试。"），记 `no_send_fallback`；已发过任何一条则不补兜底。超时 / 后端失败：发过就不补，没发过按 `AGENT_FAILURE_REPLIES`。 |
| D5 | 定时任务回合没发就是静默，不兜底；失败只记录、计数，连续 3 次失败自动暂停并告警。 |
| D6 | 网关一份实现，两个后端共用：pi 进程内工具；codex 经独立 MCP server 走回环端口调回主进程（不放进 qq_context）。 |
| D7 | 主动发送的目标直接用 ref 字符串 `<channel>:<scope>`（`qq:group:123`、`qq:private:10001`），不设别名表；模型靠 `[来源]` 头里的群名、`qq_chats` 自己推断。 |
| D8 | 定时任务按来源运行：在哪个会话创建就在哪个会话的上下文里跑；`send_message` 不带 target 时发回该会话。 |
| D9 | owner 在任何会话里都是全部读取范围 + 全部动作授权；owner 可按人、按目标授予 `send` / `schedule` 能力。 |
| D10 | 错过的触发不补跑；停机期间错过的合并记一条"跳过"，下一次从"现在"往后算。 |
| D11 | 限额：消息回合 ≤3 条、定时回合 ≤5 条；主动发往每个群 / 私聊每天 ≤100 条；周期最小间隔 5 分钟；被授权人 ≤5 条定时任务、最小间隔 30 分钟。 |

## 2. 实施步骤

1. ~~群名进上下文 + `qq_chats`~~（已上线，main 0318d34）。
2. **Outbox + `send_message`（本步，见 §3）**：仅发回本回合会话，不含 target。
3. 回合令牌扩展、授权表 `GrantsDoc`、`auth_*` 工具、`send_message.target`；owner 在群里改为全部读取范围（D9）。
4. `ScheduleDoc` 与管理 API（RRULE 校验、revision、面板增删改）。
5. 排程器 `cs.schedule`（wait / fire 两阶段，持久化 `next_fire_at`，`runtime.sleep` 只负责进程存活期间的等待）。
6. admit 与运行（`DispatchDoc` 的 `kind: "scheduled"`、输入外壳、record、连续失败自停），pi 与 codex 的 thread / fork。
7. `schedule_*` / `schedule_control` 工具（MCP `schedule`）。
8. 面板定时任务页；owner 私聊实测（不在真实群里测试）。

每一步单独实现、评审、部署、验收。

## 3. 第 2 步：Outbox + send_message

### 3.1 行为

- 模型通过 `send_message({ text, images?, files? })` 向**本回合会话**发一条消息：立即发送，返回 `message_id`。
- 新调用的正文哈希若与本票据已有 sent / sending / uncertain 行相同，返回已有结果，不再建行或发送。不确定结果以非错误工具结果提示“消息可能已送达，不要重发”；已 sent 但缺回执时明确返回状态和空 message_id。
- 每次未被去重的有效调用就是一条 QQ 消息；本回合会话为群时，**本回合第一条**消息 @ 提问者（与现在一致），之后的不 @。
- 校验失败（空文本、超过 4000 字、图片 >4、文件 >3 或 >20 MiB、路径不在允许范围、本回合已达 3 条）直接返回错误文本给模型，不截断、不改写。路径规则沿用 `media/attach.ts`。
- 图片随该条消息发出；文件在该条文字发出后用 `uploadFile` 单独发送（与现在的附件顺序一致），状态各自记录。
- `qq_send_image` / `qq_send_file` 删除（不做兼容），由 `send_message` 的 `images` / `files` 取代。
- 生图路由（前缀分流的 `cs.image` 任务）不变，仍由网关直接回复。

### 3.2 Outbox

`ReplyStore`（`qq-bridge.sqlite`）新增表 `outbox`，状态机与票据相同：

| 列 | 说明 |
|---|---|
| `key` TEXT PK | `<回合票据>#<序号>`；兜底为 `<回合票据>#fallback`；迟到图片为 `<回合票据>#late` |
| `ticket` | 回合票据（入站票据 id；以后定时运行用 `run:<fire_key>`） |
| `ordinal` | 本票据内序号，从 1 开始 |
| `call_id` | 后端给出的稳定工具调用 id（pi 的 toolCallId），可空；`(ticket, call_id)` 唯一 |
| `message_type` / `target_id` | 发送目标 |
| `mention_user_id` | 群里要 @ 的人，可空 |
| `status` | pending → sending → sent / uncertain；sending / uncertain 永不自动重发 |
| `message_id`、`text_sha256`、`images`、`created_at`、`sent_at` | 回执与审计 |

Channel 接口新增 `send(key, target, text, images, { mention?, signal })`：
- 已 sent → 返回原回执（`already_sent: true`）；sending / uncertain → 抛"结果不确定，不重发"；
- 否则 markSending → 发送 → markSent，失败 markUncertain。与 `reply()` 共用 `buildMessage`、登录号校验、允许名单校验。
- 现有 `Channel.send(type, targetId, text)`（运维用、非幂等）改名或删除，避免和新接口混淆。

系统补发的 `#late` / `#fallback` 独立记入 Outbox，不占模型的 3 条额度，也不受这个上限限制；`#fallback` 仍只在没有任何已发送或结果不确定的消息时出现。

入站票据的含义调整：回合结束且（Outbox 里本票据有任何 sent / sending / uncertain 行，或兜底已发）时，票据置 sent，派发器照常把它当终态。

### 3.3 序号与重跑

- pi：工具调用带稳定的 `toolCallId`。网关按 `(ticket, call_id)` 查 Outbox：已有行 → 返回该行的结果（已发则返回原回执），否则分配 `ordinal = 本票据最大序号 + 1` 并插入。崩溃后 pi 重放同一调用时拿到同一行。
- codex：MCP 调用 id 不稳定。网关按"本回合尝试内的第 n 次调用"分配序号（计数器按 `ticket + 回合尝试号` 存在内存）：回合重跑时第 n 次调用映射到已有的 `#n` 行，已发过就直接返回原回执。重跑时第 n 次的正文哈希若与已有行不同，返回 already_sent 和原文，并说明“新内容未发送，如需发送请再调用一次”；下一次调用按第 n+1 次映射。
- 每回合 3 条上限仅按 Outbox 里本票据的模型 `send_message` 行数计，重跑不额外消耗额度；系统 `#late` / `#fallback` 不计入且不受此上限限制。数字键 `#n` 对应模型调用顺序，`ordinal` 记录包括系统消息在内的写入顺序。

### 3.4 回合结束规则（agent 任务）

`cs.agent` 的阶段改为：handle → lateImages → **settle**（取代 postprocess + reply）：
1. 迟到图片（包含已 done 但可能未将路径交给模型的任务）：保留与已发图片哈希不重复的完成图片，以 `#late` 发一条（文字用 `IMAGE_SUCCESS_REPLY`），附件收取失败或生图超时的提示也放在这条里。
2. 本票据 Outbox 中有任何 sent / sending / uncertain 行 → 票据 sent，任务完成。
3. 一条都没有：后端成功 → 发 `FALLBACK_REPLY`（`#fallback`）并记 `no_send_fallback`；后端超时 / 失败 → 发 `AGENT_FAILURE_REPLIES[failure]`（`#fallback`）。
4. 升级兼容：旧 postprocess/reply 检查点，或已有 replyDraft 且无 Outbox 行时，以 `#fallback` 发送 `replyDraft ?? fitReply(agentResult.text)` 及最多 4 张 agentResult.images，避免丢失旧回合答案。票据已非 pending 时，settle 跳过系统补发，仅恢复附件与终态。
5. 最终回答写入 `TicketDoc.agentResult` 与 trace（`postprocess` 事件改为 `final_answer`，`detail: { text, sent_messages }`），不发送。

### 3.5 工具暴露

- 网关实现：`agent` 层新模块（如 `src/agent/send-service.ts`），持有 Outbox、限额、序号逻辑；pi 工具与 codex 端点都调它。
- pi：进程内工具 `send_message`，从 `PiRequestDoc` 取票据与来源，`replay: "safe"`（幂等由 Outbox 保证）。
- codex：新 MCP server `im`（`src/mcp/im-server.ts` + entrypoint 受管配置 `[mcp_servers.im]`），工具 `send_message`；经回环服务新端点 `POST /send` 调主进程，用每轮令牌鉴权（令牌绑定票据与来源，模型不能指定目标）。runner 将 IM_TOKEN 与 QQ_RECALL_TOKEN 写入本轮 Codex 子进程环境，受管配置分别通过 env_vars 转发，令牌不得进入 argv。
- 提示词：在受管部分（codex `renderManagedAgentsMd`、pi 的 `cs-pi` 段）写明"回复用户必须调用 send_message；直接输出的文字不会发给用户；一条消息说完就不要再发"，用户可编辑的 codex.md / agent.md 不承担这条规则。codex.md 默认模板与 codex runner 里关于 `qq_send_image` / `qq_send_file` 的说明改为 `send_message`。

### 3.6 上下文与观测

- 每条发出的消息写入消息库的机器人行（现在 `recordPending` / `completeReply` 只记一条，改为每条 `send_message` 一行，`#fallback` 也记），`[引用]` 查找能命中这些 message_id。
- trace：`send_message`（ordinal、message_id、images、files、already_sent）只记录首次发送尝试，重放与对账不重复计数；`no_send_fallback` 仅在成功但零发送的新回合首次预留 #fallback 时记录；最终回答记录 `final_answer`。
- 面板首页显示近 24 小时 `no_send_fallback` 占入站回合的比例。

### 3.7 验收

- 单元测试：Outbox 状态机与幂等（sent 重放、sending 不重发）、pi 同 call_id 重放、codex 第 n 次映射、限额、@ 只在第一条、回合结束三分支、迟到图片、文件顺序。
- 部署后在 owner 私聊实测：普通问答、发图、发文件、一次超时（不在真实群里测试）；观察 `no_send_fallback` 比例。

## 4. 后续步骤要点（第 3–8 步，实现前再细化）

- 授权表 `GrantsDoc { user, caps: ("send"|"schedule")[], targets, scopes?, expires_at?, granted_by, created_at }`；动作授权只取 Channel 给出的真实发送者 QQ 号。
- `send_message.target` 校验：格式、bot 在群里或对方是好友、发言人有权、ref 当天限额。
- `ScheduleDoc` 字段：`id`、`revision`、`name`、`prompt`、`conversation`（来源，不可改）、`rule`（`rrule` 或 `at`，Asia/Shanghai）、`status`（active / paused / completed）、`mode`、`options`（`stale_after_ms` 默认 10 分钟、`timeout_ms` 默认 300 s 上限 900 s）、`next_fire_at`、`runs`（最近 20 次）、`failures`、`created_by`。
- 排程任务 fire 阶段一次提交：判定（去重 `fire_key = id@fire_at`、迟到、暂停 / revision、重叠）→ admit 或记跳过 → 计算晚于 now 的下一次 → 写检查点。
- 定时回合输入外壳：`[定时任务] 名称 · 计划时间 · 第 n 次`、提示词、最近 3 次运行记录、"需要通知就调用 send_message，不需要就直接结束，要停止调用 schedule_control"。
- `schedule_create` 时由模型把"发到家庭群"解析成具体 ref 写进保存的提示词。
