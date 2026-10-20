import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { GrantsService } from "../../src/agent/grants.js";
import { SendService } from "../../src/agent/send-service.js";
import { createTasks } from "../../src/agent/tasks.js";
import { createBackendSelector } from "../../src/agent/backends/select.js";
import type { AgentBackend, AgentRequest } from "../../src/agent/backends/types.js";
import { parseAccess } from "../../src/context/access.js";
import { Dispatcher } from "../../src/agent/dispatch.js";
import { DispatchDoc } from "../../src/agent/docs.js";
import { SchedulesDoc, ScheduleRuntimeDoc } from "../../src/agent/schedule/docs.js";
import { createScheduledRuntime, scheduledTicket } from "../../src/agent/schedule/run.js";
import { ScheduleService } from "../../src/agent/schedule/service.js";
import { createScheduleTask } from "../../src/agent/schedule/task.js";
import type { Schedule, ScheduledRunLauncher } from "../../src/agent/schedule/types.js";
import { sendFixture } from "./send-fixture.js";
import { ctx, flush, input, START } from "./schedule-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(START); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });

async function rig() {
  const f = sendFixture();
  f.store.markSending(f.ticket); f.store.markSent(f.ticket, "old");
  let harness!: Harness, service!: ScheduleService, dispatcher!: Dispatcher;
  let outcome: "sent" | "silent" | "failed" = "sent", dispatchEnabled = true;
  const requests: AgentRequest[] = [], reports: unknown[] = [];
  const grants = new GrantsService({ getHarness: () => harness, getChannel: () => f.bridge, owner: "1" });
  const canSchedule = grants.canSchedule.bind(grants);
  const send = new SendService({ getChannel: () => f.bridge, dataDir: f.dir, store: f.history, grants });
  // 假后端模拟模型的 send_message 工具调用，真实身份检查、Outbox 与 QQ 序列化仍全部执行。
  const backend: AgentBackend = { name: "codex", handle: async req => {
    requests.push(req);
    if (outcome === "failed") throw new Error("假后端失败");
    if (outcome === "sent") await send.send({
      ticket: req.ticket, source: req.source, actor: req.actor, actorIsOwner: req.actorIsOwner,
      access: parseAccess(req.access)!, workdir: f.workdir,
    }, { text: "定时通知" }, { callId: "send_message-1" });
    return { text: outcome === "sent" ? "已通知" : "无需通知" };
  } };
  const tasks = createTasks({ owner: "1", getBridge: () => f.bridge, sendService: send,
    imagesDir: path.join(f.dir, "images"),
    imageBackend: { name: "test", submit: async () => "p", collect: async () => [],
      reconcile: async () => ({ images: [] }), clearReferences: async () => {} },
    backends: createBackendSelector({ defaultBackend: "codex", overrides: {}, backends: { codex: backend } }),
  });
  const scheduled = createScheduledRuntime({ getChannel: () => f.bridge, tasks, owner: "1", canSchedule,
    recorder: { recordRun: (id, run) => service.recordRun(id, run) },
    pauseSchedule: (id, reason) => service.pauseWithReason(id, reason),
  });
  const launcher: ScheduledRunLauncher = {
    prepare: fire => scheduled.prepare(fire),
    dispatchScheduled: ticket => { if (dispatchEnabled) void dispatcher.dispatchScheduled(ticket); },
  };
  const scheduleTask = createScheduleTask({ admitter: launcher });
  const registry = createRegistry();
  registry.install(createCsAgentExtension(tasks, [scheduleTask, scheduled.ScheduledTask]));
  const open = async () => {
    harness = await Harness.open(await openNodeSqliteStorage(path.join(f.dir, "dispatch.sqlite")), {
      models: createModels(), registry, now: () => Date.now(), onReport: error => reports.push(error),
    }, ctx);
    service = new ScheduleService({ harness, task: scheduleTask, admitter: launcher, owner: "1", canSchedule });
    dispatcher = new Dispatcher({ harness, bridge: f.bridge, tasks, scheduled, concurrency: 2, retryDelayMs: 1 });
  };
  await open();
  await service.start();
  cleanup.push(async () => { service.stop(); await harness.close(ctx); await dispatcher.idle(); });
  return { ...f, send, grants, tasks, scheduled, scheduleTask, requests, reports, launcher,
    get service() { return service; }, get harness() { return harness; }, get dispatcher() { return dispatcher; },
    get outcome() { return outcome; },
    set outcome(value: typeof outcome) { outcome = value; },
    get dispatchEnabled() { return dispatchEnabled; },
    set dispatchEnabled(value: boolean) { dispatchEnabled = value; },
    async restart() { service.stop(); await harness.close(ctx); await dispatcher.idle(); await open(); },
    async recover() { await dispatcher.recover(); await service.start(); harness.resume(); },
    async waiting(schedule: Schedule, at: number) {
      const id = (await harness.snapshot(ScheduleRuntimeDoc, ctx))!.tasks[schedule.id] as TaskId;
      await flush(async () => {
        const task = await harness.getTask(id, ctx);
        return task?.state.status === "running" && "checkpoint" in task.state &&
          (task.state.checkpoint as { phase: string }).phase === "wait" &&
          (task.state.checkpoint as { next_fire_at: number }).next_fire_at === at;
      });
      for (let i = 0; i < 5; i++) await flush();
    },
    async fire(schedule: Schedule, at: number) {
      await this.waiting(schedule, at);
      await vi.advanceTimersByTimeAsync(at - Date.now());
      await flush(async () => (await service.get(schedule.id))!.runs.some(run => run.fire_at === at));
      if (dispatchEnabled) {
        await flush(async () => ["sent", "silent", "failed", "skipped"].includes((await service.get(schedule.id))!.runs.at(-1)!.status));
        await dispatcher.idle();
      }
      return (await service.get(schedule.id))!;
    },
  };
}

it.each(["sent", "silent", "failed"] as const)("创建 → 到点 → 派发 → %s → Schedule.runs 回写", async outcome => {
  const r = await rig(); r.outcome = outcome;
  const s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  await r.recover();
  const result = await r.fire(s, START + 300_000), run = result.runs[0];
  expect(run).toMatchObject({ status: outcome, fire_at: START + 300_000, sent: outcome === "sent" ? 1 : 0 });
  expect(run.ticket).toBe(scheduledTicket(run.fire_key));
  expect(result.failures).toBe(outcome === "failed" ? 1 : 0);
  expect(result.next_fire_at).toBe(START + 600_000);
  expect(r.requests).toHaveLength(1);
  expect(r.requests[0]).toMatchObject({ actor: "qq:1", actorIsOwner: true, scope: "group:7", threadKey: "group:7", access: "all" });
  expect(r.requests[0].text).toContain("[定时任务]");
  expect(r.store.get(run.ticket!)?.status).toBe("sent");
  const rows = r.send.rows(run.ticket!);
  expect(rows).toHaveLength(outcome === "sent" ? 1 : 0);
  if (outcome === "sent") {
    expect(rows[0]).toMatchObject({ status: "sent", target_id: "7", message_type: "group", mention_user_id: null, text: "定时通知" });
    const calls = r.call.mock.calls.filter(call => call[0] === "send_group_msg");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ group_id: 7 });
    expect(calls[0][1]!.message).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "at" })]));
  } else expect(r.call.mock.calls.some(call => call[0].startsWith("send_"))).toBe(false);
  expect((await r.harness.snapshot(DispatchDoc, ctx))?.pending).toEqual({});
  expect(r.reports).toEqual([]);
});

it("真实 schedule 授权允许非 owner 创建并发送，线程与读取权限仍绑定创建者", async () => {
  const r = await rig();
  await r.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], scopes: ["group:7"], expires_in_hours: 1 });
  const s = await r.service.create("qq:9", input({ conversation: "group:7", rule: { kind: "at", at: START + 1000 } }));
  await r.recover();
  const result = await r.fire(s, START + 1000);
  expect(result).toMatchObject({ status: "completed", failures: 0, runs: [{ status: "sent" }] });
  expect(r.requests[0]).toMatchObject({ actor: "qq:9", actorIsOwner: false, access: "group:7", threadKey: "group:7" });
  expect(r.send.rows(result.runs[0].ticket!)[0]).toMatchObject({ target_id: "7", mention_user_id: null });
  await expect(r.service.create("qq:9", input({ conversation: "group:8" }))).rejects.toMatchObject({ status: 403 });
  await expect(r.service.create("qq:9", input({ conversation: "owner" }))).rejects.toMatchObject({ status: 403 });
});

it("立即运行也在提交后自动派发，后端失败累计三次暂停且成功/静默清零", async () => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  const record = async (outcome: "sent" | "silent" | "failed") => {
    r.outcome = outcome;
    vi.setSystemTime(Date.now() + 1);
    const run = await r.service.runNow("qq:1", s.id);
    await r.dispatcher.idle();
    expect((await r.service.get(s.id))!.runs.at(-1)?.status).toBe(outcome);
    expect(r.store.get(run.ticket!)?.status).toBe("sent");
    return (await r.service.get(s.id))!;
  };
  expect((await record("failed")).failures).toBe(1);
  expect((await record("sent")).failures).toBe(0);
  expect((await record("failed")).failures).toBe(1);
  expect((await record("silent")).failures).toBe(0);
  await record("failed"); await record("failed");
  expect(await record("failed")).toMatchObject({ status: "paused", pause_reason: "连续 3 次失败", failures: 3, next_fire_at: null });
  expect(r.requests).toHaveLength(7);
  expect(r.reports).toEqual([]);
});

it.each(["expired", "revoked"] as const)("排队后授权 %s：执行前按创建者重查并暂停，owner 不能代替创建者权限", async kind => {
  const r = await rig(); r.dispatchEnabled = false;
  await r.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], scopes: ["group:7"], expires_in_hours: 1 });
  const s = await r.service.create("qq:9", input({ conversation: "group:7", rule: { kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=30", dtstart: START } }));
  await r.recover();
  const queued = (await r.fire(s, START + 1_800_000)).runs[0];
  if (kind === "expired") vi.setSystemTime(START + 3_600_000);
  else await r.grants.panel("auth_revoke", { user: "qq:9", caps: ["schedule"] });
  await r.dispatcher.dispatchScheduled(queued.ticket!);
  const paused = (await r.service.get(s.id))!;
  expect(paused).toMatchObject({ status: "paused", failures: 1, pause_reason: expect.stringContaining("无权"),
    runs: [{ status: "failed", note: expect.stringContaining("无权") }] });
  expect(r.requests).toEqual([]);
  await r.service.pauseWithReason(s.id, paused.pause_reason!);
  expect((await r.service.get(s.id))!.revision).toBe(paused.revision);
  await expect(r.service.runNow("qq:1", s.id)).rejects.toMatchObject({ status: 403 });
  await expect(r.service.resume("qq:1", s.id)).rejects.toMatchObject({ status: 403 });
  await expect(r.service.update("qq:1", s.id, { name: "不能绕过" })).rejects.toMatchObject({ status: 403 });
});

it("启动恢复已提交的定时运行与普通消息，同时继续排程任务", async () => {
  const r = await rig(); r.dispatchEnabled = false;
  const s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  await r.recover();
  const queued = (await r.fire(s, START + 300_000)).runs[0];
  const message = { ...r.msg, message_id: "recovery-message", text: "恢复普通消息", route_text: "恢复普通消息" };
  const inbound = r.store.createTicket(message);
  await r.restart();
  r.dispatchEnabled = true;
  await r.recover();
  await r.dispatcher.idle();
  expect(r.requests.map(req => req.ticket)).toEqual([queued.ticket, inbound]);
  expect((await r.service.get(s.id))?.runs[0].status).toBe("sent");
  const next = await r.fire(s, START + 600_000);
  expect(next.runs.map(run => run.status)).toEqual(["sent", "sent"]);
  expect(r.requests).toHaveLength(3);
  expect(r.reports).toEqual([]);
});

it("开票后提交前崩溃：孤儿票据不重跑，也不让 Schedule 永久 queued", async () => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  const at = s.next_fire_at!;
  await r.scheduled.prepare({ schedule: s, fire_at: at, fire_key: `${s.id}@${at}`, ordinal: 1 });
  await r.restart();
  await r.recover();
  const skipped = await r.fire(s, at);
  expect(skipped.runs[0]).toMatchObject({ status: "skipped", reason: "interrupted", note: expect.stringContaining("未重新执行") });
  expect(skipped.failures).toBe(0);
  expect(r.requests).toEqual([]);
  expect((await r.harness.snapshot(ScheduleRuntimeDoc, ctx))?.in_flight).toEqual({});
  expect((await r.fire(s, at + 300_000)).runs.map(run => run.status)).toEqual(["skipped", "sent"]);
  expect(r.requests).toHaveLength(1);
});

it("prepare 不占提交锁；准备期间定义变更，立即运行拒绝旧快照且不派发", async () => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  const prepare = r.launcher.prepare;
  r.launcher.prepare = async fire => {
    const result = await prepare(fire);
    await r.service.update("qq:1", s.id, { prompt: "新的任务内容" });
    return result;
  };
  await expect(r.service.runNow("qq:1", s.id)).rejects.toMatchObject({ status: 409 });
  expect(r.requests).toEqual([]);
  expect(r.store.get(scheduledTicket(`${s.id}@${START}`))?.status).toBe("sent");
  expect((await r.service.get(s.id))?.runs).toEqual([]);
  expect((await r.harness.snapshot(DispatchDoc, ctx))?.pending ?? {}).toEqual({});
});


it.each(["login", "settings", "binding", "admit"] as const)("真实 %s 异常不会终结排程，也不会留下待处理票据或部分 admission", async stage => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  if (stage === "binding") await r.harness.commit(async tx => {
    (await tx.doc(SchedulesDoc)).schedules[s.id].conversation = "group:invalid";
  }, ctx);
  if (stage === "login") vi.spyOn(r.bridge, "openOutbound").mockRejectedValueOnce(new Error("NapCat 离线"));
  if (stage === "settings") vi.spyOn(r.tasks, "snapshotSettings").mockRejectedValueOnce(new Error("读取设置失败"));
  if (stage === "admit") {
    const prepare = r.launcher.prepare;
    r.launcher.prepare = async fire => {
      const prepared = await prepare(fire);
      r.launcher.prepare = prepare;
      return { ...prepared, admit: async (tx, fire) => {
        await prepared.admit(tx, fire);
        throw new Error("admission 写入后失败");
      } };
    };
  }
  await r.recover();
  const result = await r.fire(s, START + 300_000);
  expect(result).toMatchObject({ status: "active", failures: 1, next_fire_at: START + 600_000,
    runs: [{ status: "failed", reason: "backend_failed", note: expect.stringContaining("失败") }] });
  expect((await r.harness.snapshot(DispatchDoc, ctx))?.pending ?? {}).toEqual({});
  expect(r.store.listPending()).toEqual([]);
  if (stage === "binding") await r.harness.commit(async tx => {
    (await tx.doc(SchedulesDoc)).schedules[s.id].conversation = "group:7";
  }, ctx);
  expect((await r.fire(s, START + 600_000)).runs.map(run => run.status)).toEqual(["failed", "sent"]);
  expect(r.requests).toHaveLength(1);
  expect(r.reports).toEqual([]);
});

it.each(["revision", "stale", "overlap"] as const)("自动 fire 在准备后判定 %s 时结算未采用的票据", async conflict => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  const at = s.next_fire_at!, prepare = r.launcher.prepare;
  vi.setSystemTime(at);
  r.launcher.prepare = async fire => {
    const result = await prepare(fire);
    if (conflict === "revision") await r.service.update("qq:1", s.id, { prompt: "新版" });
    if (conflict === "stale") vi.setSystemTime(at + s.options.stale_after_ms + 1);
    if (conflict === "overlap") await r.service.recordRun(s.id, {
      fire_key: `${s.id}@${at - 1}`, fire_at: at - 1, status: "running",
    });
    return result;
  };
  await r.scheduleTask.definition.phases.fire({
    input: { id: s.id, revision: s.revision }, state: { status: "running", checkpoint: { phase: "fire", next_fire_at: at } },
  } as never, { snapshot: r.harness.snapshot.bind(r.harness), now: Date.now,
    commit: (change: Parameters<typeof r.harness.commit>[0]) => r.harness.commit(change, ctx),
  } as never, ctx);
  expect(r.store.get(scheduledTicket(`${s.id}@${at}`))?.status).toBe("sent");
  expect((await r.harness.snapshot(DispatchDoc, ctx))?.pending ?? {}).toEqual({});
  expect(r.requests).toEqual([]);
});

it("同一 fire 并发 runNow 的清理不会结算已被另一次提交接管的票据", async () => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  r.dispatchEnabled = false;
  const results = await Promise.all([r.service.runNow("qq:1", s.id), r.service.runNow("qq:1", s.id)]);
  expect(results[0]).toEqual(results[1]);
  expect(r.store.get(results[0].ticket!)?.status).toBe("pending");
  expect(Object.keys((await r.harness.snapshot(DispatchDoc, ctx))!.pending)).toEqual([results[0].ticket]);
  await r.dispatcher.dispatchScheduled(results[0].ticket!);
  expect(r.requests).toHaveLength(1);
});
