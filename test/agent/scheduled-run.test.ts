import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createScheduledRuntime, ScheduledRunDoc, scheduledInput, scheduledTicket, type ScheduledRuntimeOptions } from "../../src/agent/schedule/run.js";
import type { Schedule, ScheduledFire, ScheduleRun, ScheduleRunRecorder } from "../../src/agent/schedule/types.js";
import { createTasks } from "../../src/agent/tasks.js";
import { DispatchDoc, TicketDoc } from "../../src/agent/docs.js";
import { createBackendSelector } from "../../src/agent/backends/select.js";
import { BackendTimeoutError, type AgentBackend, type AgentRequest } from "../../src/agent/backends/types.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { Dispatcher } from "../../src/agent/dispatch.js";
import { openHarness } from "../../src/agent/harness.js";
import { trace } from "../../src/shared/trace.js";
import { sendFixture } from "./send-fixture.js";

const ctx = BACKGROUND_CONTEXT, cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fire(patch: Partial<Schedule> = {}, ordinal = 1): ScheduledFire {
  const at = Date.parse("2026-10-20T00:30:00Z");
  const schedule: Schedule = {
    id: "morning", revision: 1, name: "早间摘要", prompt: "检查今天的消息，需要时通知。", conversation: "group:7",
    rule: { kind: "at", at }, status: "active", mode: "thread",
    options: { stale_after_ms: 600_000, timeout_ms: 300_000 }, created_by: "qq:1",
    created_at: at - 1000, updated_at: at - 1000, next_fire_at: at, failures: 0, runs: [], ...patch,
  };
  return { schedule, fire_at: at + ordinal, fire_key: `${schedule.id}@${at + ordinal}`, ordinal };
}

/** 只模拟 fire_key 幂等回写，不实现定义服务或连续失败策略。 */
class RecorderStub implements ScheduleRunRecorder {
  runs = new Map<string, ScheduleRun>();
  recordRun = vi.fn(async (_id: string, run: ScheduleRun) => { this.runs.set(run.fire_key, structuredClone(run)); });
}

async function rig(handle: AgentBackend["handle"] = async () => ({ text: "无需通知" }),
  opts: Partial<Pick<ScheduledRuntimeOptions, "owner" | "canSchedule">> & { concurrency?: number; backend?: "pi" | "codex" } = {}) {
  const f = sendFixture();
  // fixture 的入站票据不参与定时恢复；FIFO 测试另建真实入站票据。
  f.store.markSending(f.ticket); f.store.markSent(f.ticket, "old");
  const recorder = new RecorderStub(), pauseSchedule = vi.fn(async () => {});
  const requests: AgentRequest[] = [], events: { stage: string; ticket: string; detail: Record<string, unknown> }[] = [];
  cleanup.push(trace.tap(event => events.push(event)));
  const recordDeliveryNote = vi.fn<NonNullable<AgentBackend["recordDeliveryNote"]>>().mockResolvedValue();
  const backend: AgentBackend = { name: opts.backend ?? "codex", recordDeliveryNote, handle: async (...args) => {
    requests.push(args[0]); return handle(...args);
  } };
  const tasks = createTasks({ owner: "1", getBridge: () => f.bridge, sendService: f.service,
    imagesDir: path.join(f.dir, "images"), replyRetryDelayMs: 1,
    imageBackend: { name: "test", submit: async () => "p", collect: async () => [],
      reconcile: async () => ({ images: [] }), clearReferences: async () => {} },
    backends: createBackendSelector({ defaultBackend: backend.name, overrides: {}, backends: { [backend.name]: backend } }),
  });
  const scheduled = createScheduledRuntime({ getChannel: () => f.bridge, tasks, recorder, pauseSchedule, owner: "1", ...opts });
  const dbFile = path.join(f.dir, "scheduled.sqlite");
  const open = () => openHarness({ models: createModels(), extension: createCsAgentExtension(tasks, [scheduled.ScheduledTask]), dbFile }, ctx);
  let harness = await open();
  const dispatch = () => new Dispatcher({ harness, tasks, scheduled, bridge: f.bridge, concurrency: opts.concurrency ?? 2, retryDelayMs: 1 });
  let dispatcher = dispatch();
  cleanup.push(() => harness.close(ctx));
  return { ...f, tasks, scheduled, recorder, pauseSchedule, requests, events, recordDeliveryNote,
    get harness() { return harness; }, get dispatcher() { return dispatcher; },
    async reopen() {
      await harness.close(ctx); await dispatcher.idle();
      harness = await open(); dispatcher = dispatch();
    },
    async admit(value = fire()) {
      const prepared = await scheduled.prepare(value);
      const { ticket } = await harness.commit(tx => prepared.admit(tx, value), ctx);
      const entry = (await harness.snapshot(DispatchDoc, ctx))?.pending[ticket];
      return { ticket, id: entry?.conversationId as ConversationId, prepared };
    },
    async run(value = fire()) {
      const admitted = await this.admit(value);
      await dispatcher.dispatchScheduled(admitted.ticket);
      return admitted;
    },
    async message(text: string, id: string, group: string | null = "7") {
      const msg = { ...f.msg, text, route_text: text, message_id: id, group_id: group,
        message_type: group ? "group" as const : "private" as const };
      const ticket = f.store.createTicket(msg);
      return { msg, ticket };
    },
  };
}

it("输入外壳固定北京时间、运行序号与最近三条记录", () => {
  const value = fire({ runs: [1, 2, 3, 4].map(n => ({
    fire_key: `old-${n}`, fire_at: Date.parse(`2026-10-${10 + n}T00:30:00Z`), status: "sent", note: `记录${n}`,
  })) }, 8);
  expect(scheduledTicket(value.fire_key)).toBe("run_" + createHash("sha256").update(value.fire_key).digest("hex").slice(0, 40));
  expect(scheduledInput(value)).toBe(
    "[定时任务] 早间摘要 · 计划时间 10-20 08:30（北京时间）· 第 8 次\n" +
    "检查今天的消息，需要时通知。\n[最近运行] 10-12 08:30 sent 记录2；10-13 08:30 sent 记录3；10-14 08:30 sent 记录4\n" +
    "[说明] 这是定时任务，不是用户消息。需要通知就调用 send_message（可带 target），不需要就直接结束。",
  );
});

it("预备票据与事务 admission 幂等，回滚不遗留会话，终结后再次 admit 不重跑", async () => {
  const f = await rig(), value = fire(), prepared = await f.scheduled.prepare(value);
  const ticket = scheduledTicket(value.fire_key), seq = f.store.get(ticket)!.seq;
  expect((await f.harness.snapshot(DispatchDoc, ctx))?.pending ?? {}).toEqual({});
  await expect(f.harness.commit(async tx => {
    await prepared.admit(tx, value); throw new Error("回滚");
  }, ctx)).rejects.toThrow("回滚");
  expect((await f.harness.snapshot(DispatchDoc, ctx))?.pending ?? {}).toEqual({});
  const a = await f.admit(value), b = await f.admit(value);
  expect(b.id).toBe(a.id);
  await expect(f.harness.commit(tx => a.prepared.admit(tx, {
    ...value, schedule: { ...value.schedule, runs: [{ fire_key: value.fire_key, fire_at: value.fire_at, status: "queued", ticket }] },
  }), ctx)).resolves.toEqual({ ticket });
  await expect(f.harness.commit(tx => a.prepared.admit(tx, fire({}, 2)), ctx)).rejects.toThrow("触发标识不一致");
  expect(f.store.get(ticket)).toMatchObject({ origin: "scheduled", seq, message_type: "group", target_id: "7", user_id: "1" });
  expect((await f.harness.conversation(a.id, ctx))?.id).toBe(a.id);
  expect(await f.harness.snapshot(TicketDoc, a.id, ctx)).toMatchObject({ ticket, text: scheduledInput(value), source: { user_id: "1", group_id: "7" } });
  expect((await f.harness.snapshot(DispatchDoc, ctx))!.pending[ticket]).toMatchObject({ kind: "scheduled", scope: "group:7", ticketSeq: seq });
  await f.dispatcher.dispatchScheduled(ticket);
  await f.admit(value);
  expect((await f.harness.snapshot(DispatchDoc, ctx))!.pending).toEqual({});
  expect(f.requests).toHaveLength(1);
});

it.each(["pi", "codex"] as const)("%s 定时回合静默结束，最终答案留存，不发送图片或兜底", async backend => {
  const f = await rig(async () => ({ text: "😀".repeat(220), images: ["/不应发送的图片"] }), { backend });
  const { ticket, id } = await f.run();
  expect(f.recorder.runs.get(fire().fire_key)).toMatchObject({ status: "silent", sent: 0, note: "😀".repeat(200) });
  expect(f.service.rows(ticket)).toEqual([]);
  expect(f.call.mock.calls.filter(c => c[0].startsWith("send_"))).toEqual([]);
  expect(f.store.get(ticket)?.status).toBe("sent");
  expect((await f.harness.snapshot(TicketDoc, id, ctx))?.replyCompleted).toBe(true);
  expect(f.events.find(e => e.stage === "schedule_run")?.detail).toMatchObject({ fire_key: fire().fire_key, ordinal: 1, status: "silent", sent: 0 });
  expect(f.events.some(e => e.stage === "no_send_fallback")).toBe(false);
  expect(f.events.some(e => e.stage === "delivery_note")).toBe(false);
  expect(f.recordDeliveryNote).not.toHaveBeenCalled();
});

it("send_message 复用 Outbox，最多五条且每条都不 @，附件和历史仍可用", async () => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async req => {
    const binding = { ...f.binding, ticket: req.ticket, source: req.source };
    for (let n = 1; n <= 5; n++) await f.service.send(binding, { text: `定时通知${n}`,
      ...(n === 1 ? { images: [path.join(f.workdir, "image.png")], files: [{ path: path.join(f.workdir, "file.txt") }] } : {}),
    }, { callId: `send-${n}` });
    await expect(f.service.send(binding, { text: "第六条" }, { callId: "send-6" })).rejects.toThrow("最多发送 5 条");
    return { text: "已通知" };
  });
  const { ticket } = await f.run();
  const sends = f.call.mock.calls.filter(c => c[0] === "send_group_msg");
  expect(sends).toHaveLength(5);
  expect(sends.every(call => !(call[1]!.message as { type: string }[]).some(segment => segment.type === "at"))).toBe(true);
  expect(f.service.rows(ticket).every(row => row.mention_user_id === null)).toBe(true);
  expect(f.service.rows(ticket)[0]!.files[0]?.status).toBe("sent");
  expect(f.history.message(f.binding.access, f.service.rows(ticket)[0]!.message_id!)?.row.text).toBe("定时通知1");
  expect(f.recorder.runs.get(fire().fire_key)).toMatchObject({ status: "sent", sent: 5 });
  await expect(f.service.system(ticket, "fallback", "不得发送")).rejects.toThrow("不发送系统补发");
});

it.each(["failed", "timeout", "sent-then-failed"] as const)("%s 记失败，不补兜底", async outcome => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async req => {
    if (outcome === "sent-then-failed") await f.service.send({ ...f.binding, ticket: req.ticket, source: req.source }, { text: "已发" }, { callId: "sent" });
    throw outcome === "timeout" ? new BackendTimeoutError("超时") : new Error("后端失败");
  });
  const { ticket } = await f.run();
  expect(f.recorder.runs.get(fire().fire_key)).toMatchObject({
    status: "failed", reason: outcome === "timeout" ? "timeout" : "backend_failed", sent: outcome === "sent-then-failed" ? 1 : 0,
  });
  expect(f.service.rows(ticket).some(row => row.key.endsWith("#fallback"))).toBe(false);
  expect(f.store.get(ticket)?.status).toBe("sent");
});

it("按每条定时定义的 timeout_ms 中止后端并记录 timeout", async () => {
  const f = await rig(async (_req, context) => new Promise((_resolve, reject) => {
    context.signal.throwIfAborted();
    context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
  }));
  const value = fire({ options: { timeout_ms: 30, stale_after_ms: 600_000 } });
  await f.run(value);
  expect(f.recorder.runs.get(value.fire_key)).toMatchObject({ status: "failed", reason: "timeout" });
});

it("连续后端失败逐次交给 recorder，不在执行侧实现失败计数策略", async () => {
  const f = await rig(async () => { throw new Error("后端失败"); });
  for (let ordinal = 1; ordinal <= 3; ordinal++) await f.run(fire({}, ordinal));
  expect([...f.recorder.runs.values()].map(run => run.status)).toEqual(["failed", "failed", "failed"]);
  expect(f.pauseSchedule).not.toHaveBeenCalled();
});

it.each([
  { conversation: "owner", creator: "qq:1", scope: "private:1", access: "all" },
  { conversation: "group:7", creator: "qq:1", scope: "group:7", access: "all" },
  { conversation: "group:7", creator: "qq:9", scope: "group:7", access: "group:7" },
  { conversation: "private:1", creator: "qq:9", scope: "private:1", access: "private:1" },
] as const)("线程与读取范围：$conversation / $creator", async ({ conversation, creator, scope, access }) => {
  const canSchedule = vi.fn(async () => true), f = await rig(undefined, { canSchedule });
  await f.run(fire({ conversation, created_by: creator }));
  expect(f.requests[0]).toMatchObject({ scope, access, threadKey: conversation,
    actor: creator, actorIsOwner: creator === "qq:1", senderIsOwner: creator === "qq:1", source: { user_id: creator.slice(3) } });
  expect(canSchedule).toHaveBeenCalledWith(creator, conversation);
});

it("非 owner 创建者的私聊目标独立于身份，默认发送到来源会话", async () => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async req => {
    await f.service.send({ ...f.binding, ticket: req.ticket, source: req.source }, { text: "定时私聊" }, { callId: "private" });
    return { text: "已发送" };
  }, { canSchedule: async () => true });
  const { ticket } = await f.run(fire({ conversation: "private:1", created_by: "qq:9" }));
  expect(f.store.get(ticket)).toMatchObject({ user_id: "9", target_id: "1" });
  expect(f.call.mock.calls.find(call => call[0] === "send_private_msg")?.[1]?.user_id).toBe(1);
});

it("默认仅 owner 有权，授权在排队后实际执行时重查；无权调用暂停回调", async () => {
  const f = await rig();
  const { ticket } = await f.run(fire({ created_by: "qq:9" }));
  expect(f.requests).toEqual([]);
  expect(f.recorder.runs.get(fire().fire_key)).toMatchObject({ status: "failed", note: expect.stringContaining("无权") });
  expect(f.pauseSchedule).toHaveBeenCalledWith("morning", expect.stringContaining("无权"));
  expect(f.service.rows(ticket)).toEqual([]);
  let allowed = true;
  const g = await rig(undefined, { canSchedule: () => allowed });
  const admitted = await g.admit();
  allowed = false;
  await g.dispatcher.dispatchScheduled(admitted.ticket);
  expect(g.requests).toEqual([]);
  expect(g.pauseSchedule).toHaveBeenCalledTimes(1);
});

it("同群消息与定时任务共用 FIFO，其他 scope 使用同一并发槽位", async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await rig(async req => {
    started.push(req.text.startsWith("[定时任务]") ? "定时" : req.text);
    if (req.text === "第一条") await gate;
    return { text: "结束" };
  });
  const first = await f.message("第一条", "101");
  const p1 = f.dispatcher.dispatch(first.msg, first.ticket);
  await vi.waitFor(() => expect(started).toEqual(["第一条"]));
  const scheduled = await f.admit();
  const p2 = f.dispatcher.dispatchScheduled(scheduled.ticket);
  await vi.waitFor(() => expect(f.dispatcher.status().waiting).toBe(1));
  const second = await f.message("第二条", "102"), other = await f.message("其他会话", "103", null);
  const p3 = f.dispatcher.dispatch(second.msg, second.ticket), p4 = f.dispatcher.dispatch(other.msg, other.ticket);
  await vi.waitFor(() => expect(started).toContain("其他会话"));
  expect(started).not.toContain("定时");
  expect(started).not.toContain("第二条");
  release(); await Promise.all([p1, p2, p3, p4]);
  expect(started.filter(value => value !== "其他会话")).toEqual(["第一条", "定时", "第二条"]);
});

it("定时唤醒的异步 scope 读取不会被紧接着派发的消息插队", async () => {
  const f = await rig(), { ticket } = await f.admit();
  const scheduled = f.dispatcher.dispatchScheduled(ticket);
  const msg = { ...f.msg, message_id: "immediate", text: "紧接着的消息", route_text: "紧接着的消息" };
  const inbound = f.store.createTicket(msg);
  await Promise.all([scheduled, f.dispatcher.dispatch(msg, inbound)]);
  expect(f.requests.map(req => req.ticket)).toEqual([ticket, inbound]);
});

it("当前 owner 变更后，即使旧创建者还有 schedule 授权，也不能进入 owner 私有线程", async () => {
  let owner = "1";
  const f = await rig(undefined, { owner: () => owner, canSchedule: () => true });
  const { ticket } = await f.admit(fire({ conversation: "owner" }));
  owner = "9";
  await f.dispatcher.dispatchScheduled(ticket);
  expect(f.requests).toEqual([]);
  expect(f.pauseSchedule).toHaveBeenCalledTimes(1);
});

it("开票后未提交的崩溃恢复关闭孤儿定时票据，绝不转为消息或重跑", async () => {
  const f = await rig(), value = fire();
  await f.scheduled.prepare(value);
  await f.reopen();
  expect(await f.dispatcher.recover()).toBe(1);
  await f.dispatcher.idle();
  expect(f.store.get(scheduledTicket(value.fire_key))?.status).toBe("sent");
  await f.admit(value);
  expect((await f.harness.snapshot(DispatchDoc, ctx))?.pending ?? {}).toEqual({});
  expect(f.requests).toEqual([]);
  expect(f.recorder.recordRun).not.toHaveBeenCalled();
  expect(f.call.mock.calls.some(c => c[0].startsWith("send_"))).toBe(false);
});

it("排程提交后崩溃恢复按票据 seq 混合排序，定时会话从 cs.scheduled 运行", async () => {
  const f = await rig(), scheduled = await f.admit();
  const message = await f.message("后来的消息", "201");
  await f.reopen();
  expect(await f.dispatcher.recover()).toBe(2);
  await f.dispatcher.idle();
  expect(f.requests.map(req => req.ticket)).toEqual([scheduled.ticket, message.ticket]);
  expect(f.recorder.runs.get(fire().fire_key)?.status).toBe("silent");
});

it("运行中崩溃后恢复回合标记与 Outbox；同一工具调用不重复发送", async () => {
  let calls = 0, f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async (req, context) => {
    calls++;
    const binding = { ...f.binding, ticket: req.ticket, source: req.source };
    if (calls === 1) {
      await context.persistTurn!({ outFile: "durable-output", attempts: 1 });
      await f.service.send(binding, { text: "只发一次" }, { callId: "stable" });
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    }
    expect(context.turn).toEqual({ outFile: "durable-output", attempts: 1 });
    expect((await f.service.send(binding, { text: "只发一次" }, { callId: "stable" })).already_sent).toBe(true);
    return { text: "恢复完成" };
  });
  const { ticket } = await f.admit();
  const first = f.dispatcher.dispatchScheduled(ticket);
  await vi.waitFor(() => expect(f.service.rows(ticket)[0]?.status).toBe("sent"));
  await f.reopen(); await first;
  await f.dispatcher.recover(); await f.dispatcher.idle();
  expect(calls).toBe(2);
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(1);
  expect(f.recorder.runs.get(fire().fire_key)).toMatchObject({ status: "sent", sent: 1 });
});

it("handle 已落盘、运行任务尚未完成时重启，跳过后端并恢复 settle", async () => {
  const f = await rig(), admitted = await f.admit();
  await f.harness.commit(async tx => {
    (await tx.doc(TicketDoc, admitted.id)).agentResult = { ok: true, backend: "codex", text: "已完成后端", images: [] };
    const taskId = await tx.createTask(f.scheduled.ScheduledTask, { ticket: admitted.ticket }, {
      ownership: { kind: "conversation" }, conversationId: admitted.id,
    });
    (await tx.doc(DispatchDoc)).pending[admitted.ticket]!.taskId = taskId;
  }, ctx);
  await f.reopen();
  await f.dispatcher.recover(); await f.dispatcher.idle();
  expect(f.requests).toEqual([]);
  expect(f.recorder.runs.get(fire().fire_key)).toMatchObject({ status: "silent", note: "已完成后端" });
});

it("recordRun 失败后重试只回写同一结果，不重跑后端或发送兜底", async () => {
  const f = await rig();
  const original = f.recorder.recordRun.getMockImplementation()!;
  let failed = false;
  f.recorder.recordRun.mockImplementation(async (...args) => {
    if (args[1].status === "silent" && !failed) { failed = true; throw new Error("回写暂不可用"); }
    await original(...args);
  });
  const { ticket } = await f.run();
  expect(f.requests).toHaveLength(1);
  const finalCalls = f.recorder.recordRun.mock.calls.filter(call => call[1].status === "silent");
  expect(finalCalls).toHaveLength(2);
  expect(finalCalls[0]![1]).toEqual(finalCalls[1]![1]);
  expect(f.service.rows(ticket)).toEqual([]);
});

it.each(["sending", "uncertain", "pending"] as const)("恢复 %s Outbox 记失败，永不重发或兜底", async status => {
  const f = await rig(), { ticket, id } = await f.admit();
  const row = f.store.reserveOutbox({ ticket, call_id: "uncertain", message_type: "group", target_id: "7",
    mention_user_id: null, text: "可能发出", images: [], files: [] });
  if (status !== "pending") f.store.markOutboxSending(row.key);
  if (status === "uncertain") f.store.markOutboxUncertain(row.key);
  await f.harness.commit(async tx => {
    (await tx.doc(TicketDoc, id)).agentResult = { ok: true, backend: "codex", text: "无法确认投递", images: [] };
  }, ctx);
  await f.reopen(); await f.dispatcher.recover(); await f.dispatcher.idle();
  expect(f.recorder.runs.get(fire().fire_key)).toMatchObject({ status: "failed", sent: 0 });
  expect(f.service.rows(ticket)).toHaveLength(1);
  expect(f.call.mock.calls.some(c => c[0].startsWith("send_"))).toBe(false);
});

it("派发器尝试耗尽也记录失败，释放队列且不走消息兜底", async () => {
  const f = await rig(), { ticket, id } = await f.admit();
  await f.harness.commit(async tx => {
    (await tx.doc(DispatchDoc)).pending[ticket]!.attempts = 3;
  }, ctx);
  await f.dispatcher.recover(); await f.dispatcher.idle();
  expect(f.requests).toEqual([]);
  expect(f.recorder.runs.get(fire().fire_key)).toMatchObject({ status: "failed", reason: "backend_failed" });
  expect((await f.harness.snapshot(ScheduledRunDoc, id, ctx))?.recorded).toBe(true);
  expect((await f.harness.snapshot(DispatchDoc, ctx))?.pending).toEqual({});
  expect(f.service.rows(ticket)).toEqual([]);
});


it("准备后票据被冲突清理终结，admit 重查票据状态并跳过", async () => {
  const r = await rig(), value = fire();
  const first = await r.scheduled.prepare(value), second = await r.scheduled.prepare(value);
  await r.harness.commit(tx => first.discard!(tx), ctx);
  const result = await r.harness.commit(tx => second.admit(tx, value), ctx);
  expect(result).toMatchObject({ ticket: scheduledTicket(value.fire_key), skipped: true });
  expect((await r.harness.snapshot(DispatchDoc, ctx))?.pending ?? {}).toEqual({});
  expect(r.store.get(result.ticket)?.status).toBe("sent");
});
