# Pi 定时任务（heartbeat）接收侧设计（草案 v1，2026-10-20）

> 范围：只设计**收到一次触发之后**的处理。触发怎么生成（rrule、调度器、定义的增删改、面板编辑、让模型创建定时任务的工具）不在本稿；两侧只通过 §2 的接口交互。
> 后端：只走 pi（pi-durable）。目标会话当前路由到 codex 时，本轮跳过（§3.1）。

## 1. 参照：Codex heartbeat 的行为

依据是本机 `~/.codex/automations/*/automation.toml`（7 条，`kind = "heartbeat"`）和对应的 `memory.md`：

| Codex 的做法 | 本设计要保留的语义 |
|---|---|
| 定义 = `prompt` + `rrule` + `status`(ACTIVE/PAUSED) + `target_thread_id` | 投到目标会话，带着该会话的上下文工作 |
| 触发时把 prompt 作为一轮输入投进目标线程；线程忙时排在后面 | 不打断进行中的回合 |
| prompt 约定"状态没变就保持安静，不重复播报" | 可以**静默**，不出站 |
| 模型调用 `automation_update` 自行暂停（"全部完成后暂停这条监测"） | 可以**自停** |
| 每条 automation 有 `memory.md`，每轮追加运行记录，下轮"与上次快照比较" | **跨轮记忆**，不受会话压缩影响 |
| 错过的触发不补跑 | 迟到太久的触发直接跳过 |

## 2. 接口

```ts
/** 生成侧投递的一次触发。同一 fire 可重复投递，接收侧按 fire_key 去重。 */
type HeartbeatFire = {
  heartbeat_id: string;   // 定义 id，/^[A-Za-z0-9_-]{1,64}$/
  revision: number;       // 定义版本；生成侧每次修改（含用户手动恢复）+1
  fire_at: number;        // 计划触发时刻（ms），同一定义内唯一
  target: string;         // 会话键："owner" | "group:<id>" | "private:<qq>"，与 pi 会话键一致
  name: string;           // 显示名，≤ 64 字
  prompt: string;         // ≤ 8000 字
  options?: {
    mode?: "fork" | "thread";   // §3.3，默认 fork
    stale_after_ms?: number;    // 迟到阈值，默认 10 分钟
    timeout_ms?: number;        // 回合超时，默认 300 s，上限 900 s
  };
};

type HeartbeatOutcome = {
  fire_key: string;       // `${heartbeat_id}@${fire_at}`，全链路幂等键
  heartbeat_id: string; revision: number; fire_at: number;
  status: "sent" | "quiet" | "skipped" | "failed";
  reason?: "stale" | "overlap" | "paused" | "unsupported_backend" | "timeout" | "backend_failed" | "send_failed";
  control?: { action: "pause" | "complete"; reason: string };   // 模型自停，或连续失败后接收侧自停
  message_id?: string;
  note?: string;          // 本轮运行记录，≤ 500 字
};

interface Heartbeats {            // 接收侧入口
  fire(f: HeartbeatFire): Promise<{ fire_key: string; admitted: boolean; reason?: HeartbeatOutcome["reason"] }>;
}
interface HeartbeatSink {         // 生成侧实现；至少投递一次，按 fire_key 去重
  outcome(o: HeartbeatOutcome): Promise<void>;
}
```

## 3. 处理流程

```
fire() ─ admit（一次 commit）→ DispatchDoc 条目(kind=heartbeat) + 本轮会话 + HeartbeatRunDoc
       └─ 与 QQ 消息同一个 scope FIFO、同一组并发槽位
HeartbeatTask `cs.heartbeat`（派发 harness）：gate → turn → deliver → record → notify
```

用到的 pi-durable 能力：

| 能力 | 用途 |
|---|---|
| `defineTask` 分阶段检查点 + `runtime.commit` | 每阶段结果和检查点同一次提交，崩溃后从检查点继续 |
| `submit({ requestId })` 去重 | `requestId = "hb:" + fire_key`，重启或重投都不会重复提问 |
| `submit({ entry: { kind, data } })` | 心跳输入在 transcript 里记为 `cs.heartbeat`，面板可区分；模型仍看到 `content` |
| `fork(entryId, { ownership: task })` + `scanConversations({ ownerTaskId })` | fork 模式：在会话副本里运行，重跑时找回同一个副本 |
| `submit({ type: "write", entry: { kind, data, model } })` | fork 模式：把发出的内容回写主会话，在下一个边界放置 |
| Session 级 `defineDoc` | 去重索引、跨轮状态（相当于 Codex 的 memory.md） |
| `runtime.sleep(until)` | notify 失败后的退避 |

### 3.1 admit（`Heartbeats.fire`）

按顺序判定，命中即返回 `admitted: false` 并经 sink 报告 `skipped`（同样按 fire_key 只报一次）：

1. **去重**：Session 级 `HeartbeatIndexDoc.fires[fire_key]` 已存在时返回原结果。
2. **校验**：id、target、长度不合法时抛错，不落盘。
3. **迟到**：`now - fire_at > stale_after_ms` → `stale`。错过的触发不补跑，停机期间积压的触发在这里被挡住。
4. **自停**：`HeartbeatStateDoc[id].status` 为 paused 或 completed，且 `revision` 没变 → `paused`。生成侧 revision 变大表示用户重新启用，接收侧据此清除自停状态。
5. **重叠**：同一定义已有未终态的一轮 → `overlap`。新一轮合并掉，不在后面排第二轮。
6. **后端**：目标 scope 当前路由到 codex → `unsupported_backend`。

通过后：先由 Channel 建出站票据（§4），再在**同一次 commit** 里写入 ownerless 会话、`HeartbeatRunDoc`（fire 原文、票据、状态）、`DispatchDoc` 条目（`kind: "heartbeat"`、`scope`、`ticketSeq`）和 `HeartbeatIndexDoc`，然后进入 scope 队列。

### 3.2 gate

- 票据仍为 pending，条目未被 givenUp；与消息任务的 `blockedReason` 相同。
- 再查一次自停状态：排队期间同一定义的上一轮可能刚自停，此时本轮以 `paused` 跳过，票据置 `void`。

### 3.3 turn（新方法 `PiBackend.heartbeat()`）

与消息共用 `lock(key)`，所以总是排在该会话进行中的回合之后，不打断它。

**输入外壳**（`content`，模型看到的文本）：

```
[定时任务] 名称：MOUZ 投稿监测 · 计划时间：2026-10-20 08:30（北京时间）· 第 17 次
<prompt 原文>
[最近运行] 08:25 静默：xelex 仍在压缩，无变化
          08:20 已发送：xertioN 录制完成（消息 1815813396）
[规则] 没有需要告知的内容时，第一行只写 HEARTBEAT_OK，后面可以写给自己的运行记录，这些不会发出。
      需要停止本任务时调用 heartbeat_control。
```

最近运行最多 3 条，取自 `HeartbeatStateDoc`。会话被压缩或 fork 后也读得到。

**两种模式：**

- **fork（默认推荐）**：在该键主会话的最新条目处 fork 出副本，副本归 HeartbeatTask 所有，本轮在副本里运行。只有发出了内容时，才向主会话回写一条 `write`：`kind: "cs.heartbeat.report"`，`model` 内容为 `[定时任务「名称」已在本会话发出] <正文>`。这样主会话知道群里刚说过什么；静默轮在主会话里不留痕。
  代价：副本拿到新的 provider session id，前缀缓存不命中；副本会话占用存储，随归档清理。
- **thread（与 Codex 一致）**：直接 submit 到主会话，用 `entry: { kind: "cs.heartbeat", data: { heartbeat_id, fire_at, name } }`。上下文最连续，但每轮（包括静默轮）都留在历史里。5 分钟一次的监测一天约 288 轮，会明显加快压缩。

**授权：**

- `PiRequestDoc` 绑定本轮的出站票据和 `access = target`（owner 为 `all`）。现有工具（qq_context、发图、发文件）按原逻辑校验，不需要改。
- `senderIsOwner` 只在 target 为 owner 时为 true，群目标的心跳不能写技能。
- `PiRequestDoc` 新增 `heartbeat?: { fire_key; control? }`。

**新工具 `heartbeat_control({ action: "pause" | "complete", reason })`：**

- 只在 `PiRequestDoc.heartbeat` 存在时可用，其他回合调用直接返回错误。
- 结果写进 `PiRequestDoc.heartbeat.control`，由 deliver 阶段读取。
- 不终止回合：模型仍可以给出最后一条报告。

**超时**：取 `timeout_ms`（默认 300 s），与消息回合同一个 `bounded()` 中止逻辑。

### 3.4 deliver

1. 判定静默：回复 trim 后为空，或第一行恰为 `HEARTBEAT_OK` → `quiet`，其余行作为 `note`（截到 500 字），票据置 `void`。这一步只决定发不发，不改正文格式，与"原文照发"的约定不冲突。
2. 否则走 `channel.reply(出站票据, fitReply(text), images)`，与消息相同：4000 字保护、最多 4 张图、票据幂等。群目标**不 @ 任何人**、不引用。
3. 后端失败或超时：**不发兜底**（避免定时任务在群里反复说"处理失败"），结果记为 `failed`，出站票据置 `void`。
4. 连续失败计数：同一定义连续 3 轮 `failed` → 接收侧自停（`control = { action: "pause", reason: "连续 3 次失败" }`），并发面板告警。

### 3.5 record → notify

- **record**：在一次 commit 里更新 `HeartbeatStateDoc[id]`：
  - 字段：`revision`、`status`、`pause_reason`、`failures`；
  - `runs`：最近 10 轮的 `{ fire_at, status, note | 已发正文前 200 字, message_id }`；
  - 释放重叠占位，删除 `DispatchDoc` 条目。
- **notify**：调用 `sink.outcome()`。失败时用 `runtime.sleep` 退避重试（5 s、30 s、5 min，之后每 30 min 一次，24 h 后放弃并记日志）。生成侧按 fire_key 去重。

## 4. Channel 需要的最小改动

心跳没有入站消息，现有票据由入站消息决定性生成，因此给 ReplyStore 加出站票据（可视为 §10.5 Outbox 的前置）：

- `openOutbound(ticket_id, { type, target_id, origin: "heartbeat" })`：
  - `ticket_id = sha256("hb:" + fire_key)`，重复调用返回同一行；
  - `seq` 取同一 rowid 序列，所以心跳与 QQ 消息按到达顺序统一排队和恢复。
- `ReplyTicketRecord` 新增 `origin?: "inbound" | "heartbeat"`，新增终态 `void`（未发送且不会再发：静默、跳过、失败）。
- `reply()` 遇到 `origin = heartbeat`：群里不加 @ 段，不引用。其余状态机（pending → sending → sent / uncertain）不变。
- `recover()` 对账：没有派发条目的 heartbeat 票据（admit 时建了票据、commit 前崩溃）直接置 `void`，不重跑。生成侧重投时会因 fire 已过期或仍在迟到阈值内而得到正确处理。

## 5. 崩溃恢复

| 崩溃点 | 恢复 |
|---|---|
| 建票据后、admit commit 前 | 悬空票据在 recover 时置 void；生成侧重投时按 §3.1 重新判定 |
| turn 中 | 同一 `requestId` 找回原 submission；fork 模式经 `scanConversations({ ownerTaskId })` 找回同一副本；被中止的回执沿用消息路径的一次补提 |
| deliver 中 | Channel 票据幂等：sent 不重发，sending / uncertain 不重发 |
| record / notify 中 | 检查点推进；notify 重放由生成侧按 fire_key 去重 |

## 6. 可观测

- trace 以出站票据为 ticket。时间线标签为"定时任务 · 名称"，事件为 `heartbeat_admit` / `heartbeat_skip` / `heartbeat_quiet` / `heartbeat_sent` / `heartbeat_paused`。
- 首页队列显示心跳条目；pi 会话页显示 thread 模式的 `cs.heartbeat` 条目，以及 fork 副本（标注所属心跳）。
- 自停和连续失败进入现有告警通道。

## 7. 不在本稿

- 生成侧：定义存储、rrule 计算、面板 CRUD、让模型创建或修改定时任务的工具。
- codex 后端的心跳。
- 心跳回合内多条消息（等 §10.5 中途消息）。

## 8. 待用户决定

1. 默认模式用 **fork**（推荐，主会话不被静默轮淹没）还是 **thread**（与 Codex 一致）？
2. 失败时是否给 owner 私聊发一条简短失败提示？草案是不发，只在面板告警。
3. 群目标是否允许？定时在群里主动发言有打扰风险。建议 v1 只开放 owner 私聊和面板里明确登记的群。
4. 静默标记用文本 `HEARTBEAT_OK`（草案，零工具开销）还是专用工具？

## 9. 实现拆分（确认后交 Codex，逐步验收）

1. Channel 出站票据：`openOutbound`、`origin`、`void`、`reply` 不 @、recover 对账，并补测试。
2. Doc 与 admit：`HeartbeatIndexDoc` / `HeartbeatStateDoc` / `HeartbeatRunDoc`，`Heartbeats.fire()` 的判定与原子提交，派发器识别 `kind: "heartbeat"`，并补测试。
3. `PiBackend.heartbeat()`：输入外壳、fork / thread 两模式、`heartbeat_control` 工具、`PiRequestDoc.heartbeat`，并补测试（用 faux 模型）。
4. `HeartbeatTask` 五个阶段与崩溃恢复测试（每个阶段中途重启）。
5. 可观测与面板显示，最后在 owner 私聊实测（不在真实群里测试）。
