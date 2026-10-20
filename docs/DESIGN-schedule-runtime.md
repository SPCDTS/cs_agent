# 定时任务运行时（第 4–6 步，2026-10-20）

> 总体设计与已定决策见 DESIGN-scheduled-tasks.md（§1 决策 D1–D11）。本文件是第 4–6 步的实现依据；共用类型在 `src/agent/schedule/types.ts`，两边都以它为契约。
> 任务拆分：**A = 第 4+5 步**（定义、校验、管理接口、排程任务），**B = 第 6 步**（触发后的执行）。两边并行开发，互不实现对方的部分。

## 1. 存储
- 派发 harness（pi-durable，`src/agent/harness.ts`）的 Session 级文档 `SchedulesDoc`（kind `cs.schedules`，形状 `SchedulesState`），由 A 定义。
- 运行结果回写 `Schedule.runs`（最近 20 条）与 `failures`，经 `ScheduleRunRecorder.recordRun`（A 实现，B 调用）。

## 2. A：定义、校验、管理接口（第 4 步）
模块：`src/agent/schedule/`（`model.ts` 校验与下次时刻计算、`service.ts` ScheduleService）。

- 字段见 `Schedule`。默认 `options`：`stale_after_ms = 10 分钟`，`timeout_ms = 300 s`（上限 900 s）。
- 校验：name 1–64 字；prompt 1–8000 字；conversation 为合法会话键；rule：
  - `rrule`：用 `rrule@2.8.1`（已在 package.json），`DTSTART;TZID=Asia/Shanghai`。**rrule.js 带 TZID 时返回"把北京墙钟时间放进 UTC 字段"的 Date，必须减 8 小时得到真实时刻**（Asia/Shanghai 无夏令时）；写 `nextFireAt(rule, afterMs)` 统一处理并用测试锁定（如每天 08:30 → 真实 00:30Z）。
  - 最小间隔：owner 5 分钟、被授权人 30 分钟（用连续两次触发的间隔判断）。
  - `at`：必须在未来。
- 数量：被授权人最多 5 条 active；owner 不限。创建者必须是 owner 或持有 `schedule` 授权（第 3 步的 GrantsDoc；若第 3 步代码尚未合入，用一个可注入的 `canSchedule(actor)` 函数，默认只允许 owner）。
- `ScheduleService`：`create / update / pause / resume / remove / runNow / list / get / recordRun`。
  - 每个修改在**一次提交**里改 `SchedulesDoc` 并创建或中止对应的排程任务；revision+1。
  - `resume`：从"现在"往后算 `next_fire_at`。
  - `runNow`：不改 `next_fire_at`，直接经 `ScheduledRunAdmitter.admit` 触发一次（fire_at = now）。
  - `recordRun`：按 fire_key 覆盖或追加 run；sent / silent 清零 failures；failed 累加，达到 3 置 paused（`pause_reason = "连续 3 次失败"`）并发 trace `schedule_paused`、走现有告警通道。
- JSON 接口（供第 8 步面板与第 7 步工具复用，本步只做服务端）：在面板服务下 `GET /api/schedules`、`POST /api/schedules`（create）、`POST /api/schedules/:id/{update,pause,resume,run,delete}`，同源 + CSRF 规则沿用 `src/obs/dashboard-post.ts`。

## 3. A：排程任务（第 5 步）
- 每条 active 定义一个 background 的 durable 任务 `cs.schedule`，属于一个专用 ownerless 会话（启动时确保存在）。输入 `{ id, revision }`。
- 阶段 `wait`：检查点 `{ phase: "wait", next_fire_at }`；`runtime.sleep(next_fire_at)`（内存等待；持久性靠检查点，重启后重跑本阶段继续睡到同一时刻，已过点立即返回）。
- 阶段 `fire`（一次提交内完成）：
  1. 重读定义：不存在、非 active、revision 不等 → 任务以 completed 结束（被新任务取代）。
  2. 迟到 `now - next_fire_at > stale_after_ms` → 记 skipped(stale)，与上一条连续的 stale 合并计数（`skipped_count`）。
  3. 上一轮运行仍为 queued / running → 记 skipped(overlap)。
  4. 否则 `admitter.admit(tx, fire)`，记 run(queued, ticket)。
  5. `next = nextFireAt(rule, now)`；没有下一次（一次性已执行、UNTIL/COUNT 到期）→ completed；否则写回 `next_fire_at` 与检查点 `{ phase: "wait", next_fire_at: next }`。
- 测试用 `HarnessOptions.now` 注入假时钟：正常触发、重启后续睡、停机多天合并跳过且下一次从现在算、改定义使旧任务退出、暂停 / 恢复、一次性任务。

## 4. B：触发后的执行（第 6 步）
模块：`src/agent/schedule/run.ts` 等；实现 `ScheduledRunAdmitter`，调用 `ScheduleRunRecorder`。

- **运行票据**：`run_` + sha256(fire_key) 前 40 位。需要 Channel 能为它开一张出站票据：`ReplyStore` 增加 `openOutbound(ticket, { message_type, target_id, origin: "scheduled", user_id: <创建者 QQ> })`，幂等；票据行 `origin = "scheduled"`，`seq` 取同一序列。`send_message` 不带 target 时发往该会话，**不 @ 任何人**（以 origin 判断）。
- **admit（在排程任务的提交里）**：建 ownerless 运行会话 + `TicketDoc`（source 取自 conversation 与创建者；`text` 为输入外壳）+ `DispatchDoc` 条目（`kind: "scheduled"`、`scope` = conversation 对应的队列 scope、`ticketSeq`）。出站票据行由 admit 之前调用 `openOutbound` 建好（幂等，崩溃后 recover 把没有派发条目的 scheduled 票据置为终态，不重跑）。
- **派发**：与消息同一 scope FIFO 和并发槽位；`kind: "scheduled"` 创建任务 `cs.scheduled`（阶段 handle → settle，复用 `cs.agent` 的 handle 逻辑与 send_message / Outbox，不跑 lateImages 也可，视实现简单而定）。
- **跑一轮**：后端按 conversation 选线程（owner → owner 线程；群 → 该群线程），读取范围：创建者是 owner → all，否则 conversation 的 scope。授权按创建者**当时**的身份与 GrantsDoc（同 A 的 `canSchedule` 注入方式）；不再有权 → 本次记 failed(reason 无权) 并暂停。
- **输入外壳**：
  ```
  [定时任务] <name> · 计划时间 <MM-DD HH:mm>（北京时间）· 第 <ordinal> 次
  <prompt>
  [最近运行] <最多 3 条：时间 状态 note>
  [说明] 这是定时任务，不是用户消息。需要通知就调用 send_message（可带 target），不需要就直接结束。
  ```
- **settle**：不发兜底（D5）。按 Outbox 记 sent（条数）或 silent；后端失败 / 超时记 failed；note = 最终回答前 200 字。调 `recordRun`；票据置终态。
- trace：`schedule_run`（fire_key、ordinal、status、sent）。
- 测试：admit 幂等、与消息同队列、无 @、无兜底、silent / sent / failed 记录、连续失败交给 recordRun、重启恢复（排程提交后崩溃、运行中崩溃）、无权暂停。

## 5. 合并顺序
B 先于 A 合入也可：A 依赖 `ScheduledRunAdmitter` 接口，测试中用桩；B 依赖 `ScheduleRunRecorder`，测试中用桩。最终在 `src/main.ts` 接线（后合入的一方负责）。


## 6. A/B 集成接线

- `main.ts` 先创建 grants、发送服务和通用任务，再创建 `createScheduledRuntime` 与 `cs.schedule`。扩展同时注册 `cs.image`、`cs.agent`、`cs.schedule`、`cs.scheduled`。recorder、暂停和派发回调延迟读取已构造的服务，避免构造时互相调用。
- 定义服务与执行器共用 `GrantsService.canSchedule(actor, conversation)`：当前 owner 始终有权；其他创建者须持有未过期且含 `schedule` 的 grant，并满足 grant 的来源 scopes。非 owner 不得进入 owner 线程；owner 代操作已有定义也会重新检查原创建者权限。
- 自动触发和 `runNow` 共用 `ScheduledRunLauncher`：事务外 `prepare(fire)` 开票并冻结后端设置；事务内复核定义 revision、运行 ordinal、重叠与幂等状态，然后调用预备结果的 `admit(tx, fire)`；提交成功后调用 `dispatchScheduled(ticket)`，不阻塞等待后端结束。准备期间定义或序号变化时，自动触发重新准备，手动运行返回冲突供调用方重试。
- B 的运行回写直接调用 A 的 `ScheduleService.recordRun`。无权时通过 `pauseWithReason` 使用与手动暂停相同的事务逻辑；同一原因的重放不再增加 revision，定义已删除时不重建。
- 启动时依次执行 `dispatcher.recover()`、`schedules.start()`、`harness.resume()`。恢复先接管普通消息和定时运行的 FIFO，随后补齐排程任务并继续检查点。开票后、admit 提交前崩溃留下的孤儿票据不重跑；若该触发再次到达排程阶段，将其记为失败并释放占用，避免永久 queued。
- `test/agent/schedule-integration.test.ts` 使用假时钟、真实 durable/SQLite 文档、真实 dispatcher/SendService/Outbox 与假后端，验证发送不 @、静默、失败计数、失权暂停、恢复与准备期间的定义变更。
