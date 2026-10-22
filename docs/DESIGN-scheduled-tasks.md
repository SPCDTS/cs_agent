# 定时任务与统一发送（设计 v2，2026-10-20，取代 DESIGN-pi-heartbeat.md）

> 状态（2026-10-22）：发送与运行部分已被 [常驻 agent 设计](DESIGN-resident-agent.md) 取代，下文保留原记录。D4 的兜底回复（`FALLBACK_REPLY` / `#fallback` / `no_send_fallback`）已取消：模型没发消息不兜底，只在出错时提示。D9 改为 owner 只在 owner 私聊线程读取全部，群里也只读本群（§4.1 的"owner 在群里 access=all"不再成立）。D11 的每回合 3 / 5 条上限取消，改由 QQ bridge 发送规则限速与熔断；主动发送每目标每天 100 条保留。§3.2–3.4 的票据、`#n` 序号与 settle 改为会话绑定的 Outbox（行键 `<threadKey>:<callKey>`）；第 6 步的 `DispatchDoc` 定时运行改为向会话投定时输入。D1–D3、D5–D8、D10、授权表（§4.2）与定时工具（§6）仍有效。

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
3. **已实现，待部署验收（见 §4）**：回合令牌扩展、授权表 `GrantsDoc`、`auth_*` 工具、`send_message.target`；owner 在群里读取全部范围，但仍使用来源群线程。§4.4 的部署后实测尚未执行。
4. `ScheduleDoc` 与管理 API（RRULE 校验、revision、面板增删改）。
5. 排程器 `cs.schedule`（wait / fire 两阶段，持久化 `next_fire_at`，`runtime.sleep` 只负责进程存活期间的等待）。
6. admit 与运行（`DispatchDoc` 的 `kind: "scheduled"`、输入外壳、record、连续失败自停），pi 与 codex 的 thread / fork。
7. **已实现，待部署验收**：`schedule_create/list/update/pause/resume/delete/run_now` 与 `schedule_control`（pi 逐轮扩展；codex 复用独立 `im` MCP 和回环端点，见 §6）。
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
- 生图路由（前缀分流的 `cs.image` 任务）不变，仍由网关直接回复。（2026-10：生图前缀路由与 `cs.image` 已移除。）

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
| `proactive` | 显式 target 不同于来源会话，或票据 origin=scheduled 时为 true；旧行迁移为 false |
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
1. 迟到图片（包含已 done 但可能未将路径交给模型的任务）：保留与已发图片哈希不重复的完成图片，以 `#late` 发一条（文字用 `IMAGE_SUCCESS_REPLY`），附件收取失败或生图超时的提示也放在这条里。（2026-10：随本地生图移除。）
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

## 4. 第 3 步：授权表、owner 全域、send_message.target

### 4.1 回合身份
- 每个入站回合的"发言人"只取 Channel 给出的真实发送者 QQ 号（票据 `user_id`），不看消息内容。回合令牌 / `PiRequestDoc` 增加 `actor`（`qq:<user_id>`）与 `actorIsOwner`。
- **owner 全域（D9）**：发言人是 owner 时，无论私聊还是群聊，读取范围都是全部（`access = all`）。
- **owner 在群里的回合仍跑在该群线程里**（`threadKey = group:<id>`），仅将读取范围放宽为 `access = all`，回复仍发回来源群。线程键独立于读取范围，按来源决定：owner 私聊 → `owner`，群消息 → `group:<id>`，其他私聊 → `private:<qq>`；codex 与 pi 保持一致。用户接受群线程历史中可能留有 owner 回合读取的别处内容，后续群成员的回合可能从线程历史中看到这些内容（2026-10-20 用户决定，覆盖原隔离方案）。
- 非 owner 的读取范围不变（群 → 本群，私聊 → 本人）。

### 4.2 授权表 GrantsDoc
派发 harness 的 Session 级文档，键为 `user`（`qq:<qq号>`）：
```ts
type Grant = {
  user: string;                    // "qq:10001"
  caps: ("send" | "schedule")[];   // schedule 本步只存储，第 4 步起生效
  targets: string[];               // send 可发往的 ref；空 = 不能主动发往别处
  scopes?: string[];               // 在哪些来源会话里生效（"group:1" / "private:2"）；缺省 = 任何会话
  expires_at?: number;             // ms
  granted_by: string; created_at: number; updated_at: number;
};
```
- 只能由 owner 修改：面板（设置页新增"授权"一节：列表、添加、撤销）或 owner 发起的回合里的工具。
- 过期的授权在判定时视为不存在，面板显示为已过期。

### 4.3 工具
- `send_message` 增加可选参数 `target`：`<channel>:<scope>` 字符串，本步只支持 `qq:group:<id>`、`qq:private:<qq>`。
  - 省略或等于本回合会话 → 与第 2 步相同。
  - 指向别处 → 校验：(1) 格式合法；(2) 发言人是 owner，或持有未过期且 scopes 允许本会话的 `send` 授权、target 在其 `targets` 内；(3) 目标群必须在 `QQ_ALLOW_GROUPS` 内且 bot 确实在该群；私聊对方必须是好友（`Channel.listChats`，结果缓存 5 分钟）；(4) 该 ref 当天（Asia/Shanghai）主动发送 < 100 条（仅按 Outbox 中 `proactive=true` 的模型行计，含 pending / sending / uncertain 预留；普通入站回合回复来源会话不计，定时回合所有消息均计）。不通过返回错误文本。
  - 主动发送不 @ 任何人；计入本回合 3 条额度；Outbox 行的目标是 target；发出的消息作为 bot 行写入**目标会话**的消息库。
  - 工具参数说明里只有在本回合有权使用 target 时才出现 `target`（pi 按回合配置工具；codex 的 im MCP 子进程按令牌声明决定是否在 schema 中列出）。
- `auth_grant({ user, caps, targets?, scopes?, expires_in_hours? })` / `auth_revoke({ user, caps? })` / `auth_list()`：仅 owner 发起的交互回合可用，包括群聊（其他回合不列出、调用也拒绝；`origin=scheduled` 即使创建者是 owner 也禁止，发送 target 仍按创建者权限判断）。pi 进程内；codex 放在 `im` MCP（回环端点同样按令牌校验 owner）。
- trace：`send_message` 增加 `target`；新增 `auth_changed`（来源 panel / tool、前后差异）。

### 4.4 验收
- 单元测试：owner 群消息 access=all 且 threadKey=group:<id>，owner 私聊 threadKey=owner；非 owner 不变；target 四项校验；@ 规则；额度共享；目标会话 bot 行；授权过期、scopes；auth 工具对非 owner 不可见且拒绝；面板增删与 CSRF。
- 部署后 owner 私聊实测：`qq_chats` 查群 → 指定 target 发到 owner 自己的另一个私聊 / 测试用群（不在真实群里测试）。

## 5. 后续步骤要点（第 4–8 步，实现前再细化）

- `ScheduleDoc` 字段：`id`、`revision`、`name`、`prompt`、`conversation`（来源，不可改）、`rule`（`rrule` 或 `at`，Asia/Shanghai）、`status`（active / paused / completed）、`mode`、`options`（`stale_after_ms` 默认 10 分钟、`timeout_ms` 默认 300 s 上限 900 s）、`next_fire_at`、`runs`（最近 20 次）、`failures`、`created_by`。
- 排程任务 fire 阶段一次提交：判定（去重 `fire_key = id@fire_at`、迟到、暂停 / revision、重叠）→ admit 或记跳过 → 计算晚于 now 的下一次 → 写检查点。
- 定时回合输入外壳：`[定时任务] 名称 · 计划时间 · 第 n 次`、提示词、最近 3 次运行记录、"需要通知就调用 send_message，不需要就直接结束，要停止调用 schedule_control"。
- `schedule_create` 时由模型把"发到家庭群"解析成具体 ref 写进保存的提示词。


## 6. 第 7 步：模型定时工具

- 管理工具仅在当前发言人通过 `canSchedule` 的交互回合出现；owner 可见并管理全部定义，其他授权人只管理自己创建的定义。pi 每轮切换固定扩展，codex 的 `im` 子进程启动时通过 `/im-info` 读取令牌权限；工具执行与 HTTP 端点仍逐次复核票据、来源和实时授权。
- `schedule_create({ name, prompt, rule })` 的来源不可由模型指定：owner 私聊 → `owner`，群 → `group:<id>`，其他私聊 → `private:<qq>`；创建者固定为真实 actor。`rule` 为 `{ rrule, start? }` 或 `{ at }`，日期严格使用北京时间 `YYYY-MM-DD HH:mm`，start 缺省为现在。创建与更新复用 ScheduleService 的 RRULE、间隔、数量校验。
- 工具说明要求 prompt 写清每次动作、通知对象和发送方式；“家庭群”等目的地先用 `qq_chats` 查为具体 ref 后写入 prompt。按需静默的监控必须注明“无新内容则静默（silent if nothing new）”。工具结果包含 id、状态和下次北京时间。
- 定时运行只开放 `schedule_control({ action: "pause" | "complete", reason })`，不开放管理工具；目标从当前票据对应的持久 admission / ScheduledRunDoc 读取，不接受 id。complete 经 ScheduleService 设置 completed、清空下次触发并使旧排程失效；不打断当前运行，结果仍正常回写。暂停/完成的同义重放不重复增加 revision；已失去 schedule grant 的在途运行仍可停止自身。
- 成功调用记录 `schedule_tool`，字段包括 action、id（list 为 null）、actor、tool，控制调用另记 reason。修改类 pi 工具采用 unsafe replay，避免崩溃重放产生额外定义或运行。
- 自动测试覆盖 pi 与真实 im 子进程的可见性矩阵、服务端越权/撤权/过期令牌、来源绑定、只控制自身、完整中文 prompt 和北京时间解析；部署实测留到第 8 步 owner 私聊验收。
