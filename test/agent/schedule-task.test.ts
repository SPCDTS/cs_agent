import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskId } from "@earendil-works/pi-durable";
import { ScheduleRuntimeDoc, SchedulesDoc } from "../../src/agent/schedule/docs.js";
import { ctx, flush, input, owner, rig, START } from "./schedule-fixture.js";

const clean: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(START); });
afterEach(async () => { for (const close of clean.splice(0)) await close(); vi.useRealTimers(); });
const setup = async () => { const r = await rig(); clean.push(() => r.close()); return r; };
type Rig = Awaited<ReturnType<typeof rig>>;
async function taskId(r: Rig, id: string) {
  return (await r.harness.snapshot(ScheduleRuntimeDoc, ctx))!.tasks[id] as TaskId;
}
async function waiting(r: Rig, id: TaskId, at: number) {
  await flush(async () => {
    const task = await r.harness.getTask(id, ctx);
    return task?.state.status === "running" && "checkpoint" in task.state &&
      (task.state.checkpoint as { next_fire_at?: number }).next_fire_at === at &&
      (task.state.checkpoint as { phase?: string }).phase === "wait";
  });
  // 让 wait 阶段安装 sleep / watcher，随后推进计时器。
  for (let i = 0; i < 5; i++) await flush();
}

describe("cs.schedule 假时钟与持久恢复", () => {
  it("正常触发、queued 与下一检查点一起提交；上一轮 queued/running 都阻止重叠", async () => {
    const r = await setup(), s = await r.service.create(owner, input()), id = await taskId(r, s.id);
    r.harness.resume();
    await waiting(r, id, START + 300_000);
    await vi.advanceTimersByTimeAsync(300_000);
    await flush(async () => (await r.service.get(s.id))?.runs.length === 1);
    expect(r.admitter.calls).toHaveLength(1);
    expect(r.admitter.calls[0]).toMatchObject({ ordinal: 1, fire_key: `${s.id}@${START + 300_000}`, fire_at: START + 300_000 });
    await waiting(r, id, START + 600_000);
    await vi.advanceTimersByTimeAsync(300_000);
    await flush(async () => (await r.service.get(s.id))?.runs.length === 2);
    const first = (await r.service.get(s.id))!.runs[0];
    await r.service.recordRun(s.id, { ...first, status: "running" });
    await waiting(r, id, START + 900_000);
    await vi.advanceTimersByTimeAsync(300_000);
    await flush(async () => (await r.service.get(s.id))?.runs.length === 3);
    expect((await r.service.get(s.id))!.runs.slice(1).map(run => run.reason)).toEqual(["overlap", "overlap"]);
    await r.service.recordRun(s.id, { ...first, status: "sent", sent: 1 });
    await waiting(r, id, START + 1_200_000);
    await vi.advanceTimersByTimeAsync(300_000);
    await flush(() => r.admitter.calls.length === 2);
    expect(r.admitter.calls[1].ordinal).toBe(2);
    expect(r.reports).toEqual([]);
  });

  it("重启继续睡到同一时刻；已提交 fire 不重跑", async () => {
    const r = await setup(), s = await r.service.create(owner, input()), id = await taskId(r, s.id);
    r.harness.resume();
    await waiting(r, id, START + 300_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await r.restart();
    expect(await taskId(r, s.id)).toBe(id);
    r.harness.resume();
    await waiting(r, id, START + 300_000);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(r.admitter.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush(async () => (await r.service.get(s.id))?.runs.length === 1);
    await r.restart();
    r.harness.resume();
    await waiting(r, id, START + 600_000);
    expect(r.admitter.calls).toHaveLength(1);
    expect((await r.service.get(s.id))?.runs).toHaveLength(1);
    expect(r.reports).toEqual([]);
  });

  it("停机多天只记一条 stale 并累计次数；下次从现在算，再次停机合并", async () => {
    const r = await setup(), s = await r.service.create(owner, input()), id = await taskId(r, s.id);
    r.harness.resume();
    await waiting(r, id, START + 300_000);
    await r.restart();
    vi.setSystemTime(START + 3 * 86400_000 + 60_000);
    r.harness.resume();
    await flush(async () => (await r.service.get(s.id))?.runs.length === 1);
    expect((await r.service.get(s.id))?.runs[0]).toMatchObject({ status: "skipped", reason: "stale", skipped_count: 864 });
    const next = START + 3 * 86400_000 + 300_000;
    expect((await r.service.get(s.id))?.next_fire_at).toBe(next);
    await waiting(r, id, next);
    await r.restart();
    vi.setSystemTime(START + 5 * 86400_000 + 60_000);
    r.harness.resume();
    await waiting(r, id, START + 5 * 86400_000 + 300_000);
    expect((await r.service.get(s.id))?.runs).toHaveLength(1);
    expect((await r.service.get(s.id))?.runs[0].skipped_count).toBe(1440);
    expect(r.admitter.calls).toHaveLength(0);
  });

  it("改定义唤醒并结束旧任务，新 revision 按新时间触发", async () => {
    const r = await setup(), s = await r.service.create(owner, input()), oldId = await taskId(r, s.id);
    r.harness.resume();
    await waiting(r, oldId, START + 300_000);
    const update = await r.service.update(owner, s.id, {
      rule: { kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=10", dtstart: START },
    });
    expect(update.revision).toBe(2);
    const newId = await taskId(r, s.id);
    expect(newId).not.toBe(oldId);
    await flush(async () => (await r.harness.getTask(oldId, ctx))?.state.status === "terminal");
    expect((await r.harness.getTask(oldId, ctx))?.state.outcome?.status).toBe("completed");
    await waiting(r, newId, START + 600_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(r.admitter.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300_000);
    await flush(() => r.admitter.calls.length === 1);
    expect(r.admitter.calls[0].schedule.revision).toBe(2);
  });

  it("暂停 / 恢复从现在向后算，删除结束等待任务", async () => {
    const r = await setup(), s = await r.service.create(owner, input()), oldId = await taskId(r, s.id);
    r.harness.resume();
    await waiting(r, oldId, START + 300_000);
    expect(await r.service.pause(owner, s.id)).toMatchObject({ next_fire_at: null, revision: 2 });
    await flush(async () => (await r.harness.getTask(oldId, ctx))?.state.status === "terminal");
    await vi.advanceTimersByTimeAsync(700_000);
    expect(r.admitter.calls).toHaveLength(0);
    expect(await r.service.resume(owner, s.id)).toMatchObject({ next_fire_at: START + 900_000, revision: 3 });
    const newId = await taskId(r, s.id);
    await waiting(r, newId, START + 900_000);
    await r.service.remove(owner, s.id);
    await flush(async () => (await r.harness.getTask(newId, ctx))?.state.status === "terminal");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(r.admitter.calls).toHaveLength(0);
  });

  it.each(["at", "count", "until"])("一次性 / 有限规则 %s 执行后 completed", async kind => {
    const r = await setup(), at = START + 300_000;
    const rule = kind === "at" ? { kind: "at", at } : {
      kind: "rrule", dtstart: at, rrule: "FREQ=DAILY;" + (kind === "count" ? "COUNT=1" : "UNTIL=20261020T000500Z"),
    };
    const s = await r.service.create(owner, input({ rule })), id = await taskId(r, s.id);
    r.harness.resume(); await waiting(r, id, at);
    await vi.advanceTimersByTimeAsync(300_000);
    await flush(async () => (await r.service.get(s.id))?.status === "completed");
    expect((await r.service.get(s.id))?.next_fire_at).toBeNull();
    expect(r.admitter.calls).toHaveLength(1);
    await r.restart(); r.harness.resume(); await flush();
    expect(r.admitter.calls).toHaveLength(1);
  });

  it("过期的一次性任务 skipped 后 completed，不补跑", async () => {
    const r = await setup(), s = await r.service.create(owner, input({ rule: { kind: "at", at: START + 1000 } }));
    vi.setSystemTime(START + 86400_000);
    r.harness.resume();
    await flush(async () => (await r.service.get(s.id))?.status === "completed");
    expect((await r.service.get(s.id))?.runs[0]).toMatchObject({ status: "skipped", reason: "stale", skipped_count: 1 });
    expect(r.admitter.calls).toEqual([]);
  });

  it("fire 重读 revision：恢复在 fire 阶段的旧检查点安全退出", async () => {
    const r = await setup(), s = await r.service.create(owner, input()), id = await taskId(r, s.id);
    // 旧输入仍留在存储，定义 revision 已变；直接调用实际 fire handler 模拟阶段边界恢复。
    await r.harness.commit(async tx => { (await tx.doc(SchedulesDoc)).schedules[s.id].revision++; }, ctx);
    const commit = vi.fn(async change => r.harness.commit(tx => change(tx), ctx));
    await r.task.definition.phases.fire({
      input: { id: s.id, revision: 1 }, state: { status: "running", checkpoint: { phase: "fire", next_fire_at: START } },
    } as never, { commit, snapshot: r.harness.snapshot.bind(r.harness), now: () => START } as never, ctx);
    expect(commit.mock.results).toHaveLength(1);
    expect(await commit.mock.results[0].value).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
    expect(r.admitter.calls).toEqual([]);
    expect((await r.harness.getTask(id, ctx))?.input).toEqual({ id: s.id, revision: 1 });
  });

  it("占位 admitter 同事务写 failed，连续三轮自动暂停、终结任务并告警", async () => {
    const r = await setup(), s = await r.service.create(owner, input()), id = await taskId(r, s.id);
    r.admitter.fail = true; r.harness.resume();
    for (let n = 1; n <= 3; n++) {
      await waiting(r, id, START + n * 300_000);
      await vi.advanceTimersByTimeAsync(300_000);
      await flush(async () => (await r.service.get(s.id))?.runs.length === n);
    }
    await flush(async () => (await r.harness.getTask(id, ctx))?.state.status === "terminal");
    expect(await r.service.get(s.id)).toMatchObject({ status: "paused", failures: 3, next_fire_at: null });
    expect((await r.service.get(s.id))?.runs.map(run => run.status)).toEqual(["failed", "failed", "failed"]);
    expect(r.event).toHaveBeenCalledTimes(1);
    expect(r.reports).toEqual([]);
  });
});
