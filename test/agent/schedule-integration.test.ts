import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { GrantsService } from "../../src/agent/grants.js";
import { SendService } from "../../src/agent/send-service.js";
import { Inbox } from "../../src/agent/inbox.js";
import { ThreadHost } from "../../src/agent/host/thread-host.js";
import type { HostCallbacks, InputRef, ThreadAdapter, ThreadKey, TurnContext } from "../../src/agent/host/types.js";
import { TurnMonitor } from "../../src/agent/turns.js";
import { SchedulesDoc, ScheduleRuntimeDoc } from "../../src/agent/schedule/docs.js";
import { createScheduledRuntime, readScheduledRun, scheduledInputKey } from "../../src/agent/schedule/run.js";
import { ScheduleService } from "../../src/agent/schedule/service.js";
import { createScheduleTask } from "../../src/agent/schedule/task.js";
import type { Schedule, ScheduledRunLauncher } from "../../src/agent/schedule/types.js";
import { sendFixture } from "./send-fixture.js";
import { ctx, flush, input, START } from "./schedule-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(START); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });

type Outcome = "sent" | "silent" | "failed";

/**
 * 假后端：模拟模型在回合里调用 send_message（真实会话绑定、身份、Outbox 与 QQ 序列化全部执行）。
 * hold 时回合挂起，直到 release()。
 */
class FakeAdapter implements ThreadAdapter {
  host!: HostCallbacks;
  outcome: Outcome = "sent";
  hold = false;
  turns: { threadKey: ThreadKey; keys: string[]; ctx: TurnContext; turnId: string }[] = [];
  private held: (() => void)[] = [];
  private n = 0;
  constructor(private readonly send: (threadKey: ThreadKey, turnId: string) => Promise<unknown>) {}
  async startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], ctx: TurnContext) {
    const turnId = `fake:${++this.n}`;
    this.turns.push({ threadKey, keys: inputs.map(i => i.inboundKey), ctx, turnId });
    const outcome = this.outcome;
    const run = async () => {
      if (this.hold) await new Promise<void>(resolve => this.held.push(resolve));
      if (outcome === "failed") { this.host.onTurnCompleted(threadKey, turnId, { status: "failed", error: "假后端失败" }); return; }
      if (outcome === "sent") await this.send(threadKey, turnId);
      this.host.onTurnCompleted(threadKey, turnId, { status: "completed" });
    };
    setImmediate(() => { void run(); });
    return { turnId };
  }
  async steer() { return "no_active_turn" as const; }
  async interrupt() {}
  async recoverTurn() { return "lost" as const; }
  release() { this.hold = false; for (const resolve of this.held.splice(0)) resolve(); }
}

async function rig() {
  const f = sendFixture();
  // 装置自带的入站输入不参与定时用例（恢复时不重新投递）
  f.store.markInbound([f.key], "done");
  let harness!: Harness, service!: ScheduleService, host!: ThreadHost, monitor!: TurnMonitor;
  let launchEnabled = true;
  const reports: unknown[] = [];
  const grants = new GrantsService({ getHarness: () => harness, owner: "1", owners: ["1"] });
  const canSchedule = grants.canSchedule.bind(grants);
  const send = new SendService({ getChannel: () => f.bridge, dataDir: f.dir, store: f.history, grants,
    mention: key => host.takeMention(key as ThreadKey) });
  const inbox = new Inbox({ getChannel: () => f.bridge, getHost: () => host, owners: ["1"], store: f.history, dataDir: f.dir });
  const adapter = new FakeAdapter((threadKey, turnId) => send.send({ ...inbox.binding(threadKey),
    access: { kind: "scope", scope: inbox.binding(threadKey).scope }, workdir: f.workdir }, { text: "定时通知" }, `${turnId}#1`));
  const scheduled = createScheduledRuntime({ getChannel: () => f.bridge, getHarness: () => harness, owner: "1", owners: ["1"], canSchedule,
    deliver: key => inbox.deliverScheduled(key), inputState: key => host.inputState(key),
    recorder: { recordRun: (id, run) => service.recordRun(id, run) },
    pauseSchedule: (id, reason) => service.pauseWithReason(id, reason),
  });
  const pendingLaunches = new Set<Promise<void>>();
  const launcher: ScheduledRunLauncher = {
    prepare: fire => scheduled.prepare(fire),
    launch: key => {
      if (!launchEnabled) return;
      const p = scheduled.launch(key).finally(() => pendingLaunches.delete(p));
      pendingLaunches.add(p);
    },
  };
  const scheduleTask = createScheduleTask({ admitter: launcher });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "schedule-integration", tasks: [scheduleTask] }));
  const open = async () => {
    harness = await Harness.open(await openNodeSqliteStorage(path.join(f.dir, "dispatch.sqlite")), {
      models: createModels(), registry, now: () => Date.now(), onReport: error => reports.push(error),
    }, ctx);
    service = new ScheduleService({ harness, task: scheduleTask, admitter: launcher, owner: "1", canSchedule });
    monitor = new TurnMonitor({ inbox, sendService: send, scheduled, getHost: () => host });
    host = new ThreadHost({ store: harness, adapter, concurrency: 2, owners: ["1"], events: monitor.events });
    adapter.host = host;
  };
  await open();
  await service.start();
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await Promise.allSettled([...pendingLaunches]);
      await host.idle();
      await monitor.idle();
      await flush();
      const open = f.store.listInbound("queued").length + f.store.listInbound("delivered").length;
      if (!host.status().busy.length && !pendingLaunches.size && !open) return;
    }
  };
  cleanup.push(async () => { service.stop(); await settle(); await harness.close(ctx); });
  return { ...f, send, grants, scheduled, scheduleTask, reports, launcher, adapter, inbox, settle,
    get service() { return service; }, get harness() { return harness; }, get host() { return host; },
    get launchEnabled() { return launchEnabled; },
    set launchEnabled(value: boolean) { launchEnabled = value; },
    async restart() { service.stop(); await settle(); await harness.close(ctx); await open(); },
    async recover() { await host.recover(); await service.start(); harness.resume(); await inbox.recover(); await scheduled.recover(); },
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
    async fire(schedule: Schedule, at: number, settled = true) {
      await this.waiting(schedule, at);
      await vi.advanceTimersByTimeAsync(at - Date.now());
      await flush(async () => (await service.get(schedule.id))!.runs.some(run => run.fire_at === at));
      if (settled) {
        await settle();
        await flush(async () => ["sent", "silent", "failed", "skipped"].includes((await service.get(schedule.id))!.runs.at(-1)!.status));
      }
      return (await service.get(schedule.id))!;
    },
  };
}

it.each(["sent", "silent", "failed"] as const)("创建 → 到点 → 定时输入交给会话宿主 → %s → Schedule.runs 回写", async outcome => {
  const r = await rig(); r.adapter.outcome = outcome;
  const s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  await r.recover();
  const result = await r.fire(s, START + 300_000), run = result.runs[0]!;
  expect(run).toMatchObject({ status: outcome, fire_at: START + 300_000, sent: outcome === "sent" ? 1 : 0 });
  expect(run.ticket).toBe(scheduledInputKey(run.fire_key));
  expect(result.failures).toBe(outcome === "failed" ? 1 : 0);
  expect(result.next_fire_at).toBe(START + 600_000);
  expect(r.adapter.turns).toHaveLength(1);
  expect(r.adapter.turns[0]).toMatchObject({ threadKey: "group:7", keys: [run.ticket], ctx: { kind: "scheduled", sender: "1" } });
  const rec = r.store.getInbound(run.ticket!)!;
  expect(rec).toMatchObject({ kind: "scheduled", scope: "group:7", thread_key: "group:7", user_id: "1", state: "done" });
  expect(rec.text).toContain("[定时任务]");
  const rows = r.store.listOutboxByTurn(r.adapter.turns[0]!.turnId);
  expect(rows).toHaveLength(outcome === "sent" ? 1 : 0);
  if (outcome === "sent") {
    expect(rows[0]).toMatchObject({ status: "sent", target_id: "7", message_type: "group", mention_user_id: null, proactive: true, text: "定时通知" });
    const calls = r.call.mock.calls.filter(call => call[0] === "send_group_msg");
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]!.message).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "at" })]));
  }
  // 定时回合失败不向会话发出错提示（§8.1 只对用户与唤醒回合）
  if (outcome !== "sent") expect(r.call.mock.calls.some(call => call[0].startsWith("send_"))).toBe(false);
  expect(r.reports).toEqual([]);
});

it("定时输入排队等会话空闲：用户回合进行中时不插话，回合结束后单独开一轮", async () => {
  const r = await rig();
  const s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  await r.recover();
  r.adapter.hold = true; r.adapter.outcome = "silent";
  await r.host.deliver("group:7", { inboundKey: r.key, kind: "user", sender: "1" });
  await r.host.idle();
  r.adapter.outcome = "sent";
  const queued = await r.fire(s, START + 300_000, false);
  await r.settle().catch(() => undefined);
  expect(queued.runs[0]!.status).toBe("queued");
  expect(r.host.thread("group:7")).toMatchObject({ busy: true, turnKind: "user", pending: [{ kind: "scheduled" }] });
  expect(r.adapter.turns).toHaveLength(1);
  // 上一次运行尚未结束：下一次到点按重叠跳过
  const overlapped = await r.fire(s, START + 600_000, false);
  expect(overlapped.runs.at(-1)).toMatchObject({ status: "skipped", reason: "overlap" });
  r.adapter.release();
  await r.settle();
  await flush(async () => (await r.service.get(s.id))!.runs[0]!.status === "sent");
  expect(r.adapter.turns.map(t => t.ctx.kind)).toEqual(["user", "scheduled"]);
});

it("真实 schedule 授权允许非 owner 创建并发送，身份与读取范围仍是创建者", async () => {
  const r = await rig();
  await r.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], scopes: ["group:7"], expires_in_hours: 1 });
  const s = await r.service.create("qq:9", input({ conversation: "group:7", rule: { kind: "at", at: START + 1000 } }));
  await r.recover();
  const result = await r.fire(s, START + 1000);
  expect(result).toMatchObject({ status: "completed", failures: 0, runs: [{ status: "sent" }] });
  expect(r.adapter.turns[0]!.ctx).toEqual({ kind: "scheduled", sender: "9" });
  expect(r.store.listOutboxByTurn(r.adapter.turns[0]!.turnId)[0]).toMatchObject({ target_id: "7", mention_user_id: null });
  await expect(r.service.create("qq:9", input({ conversation: "group:8" }))).rejects.toMatchObject({ status: 403 });
  await expect(r.service.create("qq:9", input({ conversation: "owner" }))).rejects.toMatchObject({ status: 403 });
});

it("立即运行也在提交后自动投递，后端失败累计三次暂停且成功/静默清零", async () => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  await r.recover();
  const record = async (outcome: Outcome) => {
    r.adapter.outcome = outcome;
    vi.setSystemTime(Date.now() + 1);
    await r.service.runNow("qq:1", s.id);
    await r.settle();
    await flush(async () => (await r.service.get(s.id))!.runs.at(-1)?.status === outcome);
    return (await r.service.get(s.id))!;
  };
  expect((await record("failed")).failures).toBe(1);
  expect((await record("sent")).failures).toBe(0);
  expect((await record("failed")).failures).toBe(1);
  expect((await record("silent")).failures).toBe(0);
  await record("failed"); await record("failed");
  expect(await record("failed")).toMatchObject({ status: "paused", pause_reason: "连续 3 次失败", failures: 3, next_fire_at: null });
  expect(r.adapter.turns).toHaveLength(7);
  expect(r.reports).toEqual([]);
});

it.each(["expired", "revoked"] as const)("排队后授权 %s：投递前按创建者重查并暂停，不开回合", async kind => {
  const r = await rig(); r.launchEnabled = false;
  await r.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], scopes: ["group:7"], expires_in_hours: 1 });
  const s = await r.service.create("qq:9", input({ conversation: "group:7", rule: { kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=30", dtstart: START } }));
  await r.recover();
  const queued = (await r.fire(s, START + 1_800_000, false)).runs[0]!;
  if (kind === "expired") vi.setSystemTime(START + 3_600_000);
  else await r.grants.panel("auth_revoke", { user: "qq:9", caps: ["schedule"] });
  await r.scheduled.launch(queued.ticket!);
  const paused = (await r.service.get(s.id))!;
  expect(paused).toMatchObject({ status: "paused", failures: 1, pause_reason: expect.stringContaining("无权"),
    runs: [{ status: "failed", note: expect.stringContaining("无权") }] });
  expect(r.adapter.turns).toEqual([]);
  expect(r.store.getInbound(queued.ticket!)!.state).toBe("done");
  await expect(r.service.runNow("qq:1", s.id)).rejects.toMatchObject({ status: 403 });
});

it("启动恢复已提交但未投递的定时运行与普通消息，同时继续排程任务", async () => {
  const r = await rig(); r.launchEnabled = false;
  const s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  await r.recover();
  const queued = (await r.fire(s, START + 300_000, false)).runs[0]!;
  const message = r.store.admit({ ...r.msg, message_id: "recovery-message", text: "恢复普通消息", route_text: "恢复普通消息" }, "group:7")!;
  await r.restart();
  r.launchEnabled = true;
  await r.recover();
  await r.settle();
  await flush(async () => (await r.service.get(s.id))?.runs[0]!.status === "sent");
  // 未投递的普通消息与定时输入都被重新投递
  expect(r.adapter.turns.flatMap(t => t.keys).sort()).toEqual([queued.ticket, message].sort());
  const next = await r.fire(s, START + 600_000);
  expect(next.runs.map(run => run.status)).toEqual(["sent", "sent"]);
  expect(r.reports).toEqual([]);
});

it("回合已结束、结果尚未回写时重启：恢复只回写同一结果，不重新执行", async () => {
  const r = await rig();
  const s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  await r.recover();
  const record = vi.spyOn(r.service, "recordRun");
  record.mockImplementation(async (id, run) => { if (run.status === "sent") throw new Error("回写失败"); return ScheduleService.prototype.recordRun.call(r.service, id, run); });
  await r.fire(s, START + 300_000, false);
  await r.settle();
  expect((await r.service.get(s.id))!.runs[0]!.status).toBe("running");
  record.mockRestore();
  await r.restart();
  await r.recover();
  await r.settle();
  await flush(async () => (await r.service.get(s.id))!.runs[0]!.status === "sent");
  expect(r.adapter.turns).toHaveLength(1);
  const run = await readScheduledRun(r.harness, scheduledInputKey(`${s.id}@${START + 300_000}`));
  expect(run).toMatchObject({ recorded: true, result: { status: "sent", sent: 1 } });
});

it("预备后提交前崩溃：孤儿输入不重跑，也不让 Schedule 永久 queued", async () => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  const at = s.next_fire_at!;
  const prepared = await r.scheduled.prepare({ schedule: s, fire_at: at, fire_key: `${s.id}@${at}`, ordinal: 1 });
  expect(prepared).toBeDefined();
  r.store.markInbound([scheduledInputKey(`${s.id}@${at}`)], "done");
  await r.restart();
  await r.recover();
  const skipped = await r.fire(s, at);
  expect(skipped.runs[0]).toMatchObject({ status: "skipped", reason: "interrupted", note: expect.stringContaining("未重新执行") });
  expect(skipped.failures).toBe(0);
  expect((await r.harness.snapshot(ScheduleRuntimeDoc, ctx))?.in_flight).toEqual({});
  expect((await r.fire(s, at + 300_000)).runs.map(run => run.status)).toEqual(["skipped", "sent"]);
});

it("prepare 不占提交锁；准备期间定义变更，立即运行拒绝旧快照，预备输入结束且不投递", async () => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  const prepare = r.launcher.prepare;
  r.launcher.prepare = async fire => {
    const result = await prepare(fire);
    await r.service.update("qq:1", s.id, { prompt: "新的任务内容" });
    return result;
  };
  await expect(r.service.runNow("qq:1", s.id)).rejects.toMatchObject({ status: 409 });
  expect(r.adapter.turns).toEqual([]);
  expect(r.store.getInbound(scheduledInputKey(`${s.id}@${START}`))?.state).toBe("done");
  expect((await r.service.get(s.id))?.runs).toEqual([]);
});

it.each(["binding", "admit"] as const)("真实 %s 异常不会终结排程，也不留下待投递输入或部分 admission", async stage => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  if (stage === "binding") await r.harness.commit(async tx => {
    (await tx.doc(SchedulesDoc)).schedules[s.id]!.conversation = "group:invalid" as never;
  }, ctx);
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
  expect(r.store.listInbound("queued").filter(rec => rec.kind === "scheduled")).toEqual([]);
  if (stage === "binding") await r.harness.commit(async tx => {
    (await tx.doc(SchedulesDoc)).schedules[s.id]!.conversation = "group:7";
  }, ctx);
  expect((await r.fire(s, START + 600_000)).runs.map(run => run.status)).toEqual(["failed", "sent"]);
  expect(r.adapter.turns.filter(t => t.ctx.kind === "scheduled")).toHaveLength(1);
  expect(r.reports).toEqual([]);
});

it.each(["revision", "stale", "overlap"] as const)("自动 fire 在准备后判定 %s 时结束未采用的预备输入", async conflict => {
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
  expect(r.store.getInbound(scheduledInputKey(`${s.id}@${at}`))?.state).toBe("done");
  expect(r.adapter.turns).toEqual([]);
});

it("同一 fire 并发 runNow 的清理不会结束已被另一次提交接管的输入", async () => {
  const r = await rig(), s = await r.service.create("qq:1", input({ conversation: "group:7" }));
  r.launchEnabled = false;
  const results = await Promise.all([r.service.runNow("qq:1", s.id), r.service.runNow("qq:1", s.id)]);
  expect(results[0]).toEqual(results[1]);
  expect(r.store.getInbound(results[0]!.ticket!)?.state).toBe("queued");
  await r.recover();
  await r.scheduled.launch(results[0]!.ticket!);
  await r.settle();
  expect(r.adapter.turns.filter(t => t.ctx.kind === "scheduled")).toHaveLength(1);
});
