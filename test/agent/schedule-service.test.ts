import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleRuntimeDoc, SchedulesDoc } from "../../src/agent/schedule/docs.js";
import { ctx, input, owner, rig, START } from "./schedule-fixture.js";
import { ScheduleService } from "../../src/agent/schedule/service.js";
import type { ScheduleRun } from "../../src/agent/schedule/types.js";

const clean: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(START); });
afterEach(async () => { for (const close of clean.splice(0)) await close(); vi.useRealTimers(); });
const setup = async (options: Parameters<typeof rig>[0] = {}) => { const r = await rig(options); clean.push(() => r.close()); return r; };

describe("ScheduleService", () => {
  it("创建默认值、单独 ownerless 会话、后台任务与重复启动", async () => {
    const r = await setup(), s = await r.service.create(owner, input());
    expect(s).toMatchObject({ revision: 1, status: "active", mode: "thread", created_by: owner,
      next_fire_at: START + 300_000, options: { stale_after_ms: 600_000, timeout_ms: 300_000 } });
    const before = await r.harness.snapshot(ScheduleRuntimeDoc, ctx);
    await r.service.start();
    expect(await r.harness.snapshot(ScheduleRuntimeDoc, ctx)).toEqual(before);
    const inspection = await r.harness.inspect(ctx);
    expect(inspection.tasks).toHaveLength(1);
    expect(inspection.tasks[0].record).toMatchObject({ kind: "cs.schedule", background: true, input: { id: s.id, revision: 1 } });
    const conv = await r.harness.commit(tx => tx.conversation(inspection.tasks[0].record.conversationId), ctx);
    expect(conv).toBeDefined();
    expect(conv?.owner).toBeUndefined();
    const read = (await r.service.get(s.id))!; read.name = "篡改快照";
    expect((await r.service.get(s.id))?.name).toBe("日报");
  });

  it("owner 默认独占；授权人限 5 条 active，暂停后释放额度，恢复再次检查", async () => {
    const r = await setup({ canSchedule: actor => actor === "qq:2" });
    await expect(r.service.create("qq:3", input())).rejects.toMatchObject({ status: 403 });
    await expect(r.service.create("qq:2", input())).rejects.toThrow("30");
    const delegated = input({ rule: { kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=30", dtstart: START } });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => r.service.create("qq:2", delegated)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const first = (await r.service.list("qq:2"))[0];
    await r.service.pause("qq:2", first.id);
    await r.service.create("qq:2", delegated);
    await expect(r.service.resume("qq:2", first.id)).rejects.toMatchObject({ status: 409 });
    for (let n = 0; n < 6; n++) await r.service.create(owner, input());
    expect(await r.service.list("qq:2")).toHaveLength(6);
    expect(await r.service.list(owner)).toHaveLength(12);
  });

  it("权限、不可改会话、更新 revision 与回滚", async () => {
    const r = await setup(), s = await r.service.create(owner, input());
    await expect(r.service.update("qq:2", s.id, { name: "越权" })).rejects.toMatchObject({ status: 403 });
    await expect(r.service.remove("qq:2", s.id)).rejects.toMatchObject({ status: 403 });
    await expect(r.service.update(owner, s.id, { conversation: "group:2" })).rejects.toThrow();
    const updated = await r.service.update(owner, s.id, { name: "新名字", options: { timeout_ms: 500_000 } });
    expect(updated).toMatchObject({ revision: 2, conversation: "owner", options: { stale_after_ms: 600_000, timeout_ms: 500_000 } });
    await expect(r.service.update(owner, s.id, { rule: { kind: "at", at: START - 1 } })).rejects.toThrow();
    expect(await r.service.get(s.id)).toEqual(updated);
    await r.service.remove(owner, s.id);
    expect(await r.service.get(s.id)).toBeUndefined();
    await expect(r.service.pause(owner, s.id)).rejects.toMatchObject({ status: 404 });
    await expect(r.service.pause(owner, "__proto__")).rejects.toMatchObject({ status: 404 });
  });

  it("授权回调可以读取同一 harness；授权撤回后禁止恢复/手动运行，仍允许暂停删除", async () => {
    let allowed = true;
    const r = await setup({ canSchedule: async actor => {
      await r.harness.snapshot(SchedulesDoc, ctx);
      return allowed && actor === "qq:2";
    } });
    const s = await r.service.create("qq:2", input({
      rule: { kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=30", dtstart: START },
    }));
    await r.service.update("qq:2", s.id, { name: "已授权" });
    allowed = false;
    await r.service.pause("qq:2", s.id);
    await expect(r.service.resume("qq:2", s.id)).rejects.toMatchObject({ status: 403 });
    await expect(r.service.runNow(owner, s.id)).rejects.toMatchObject({ status: 403 });
    await r.service.remove("qq:2", s.id);
  });

  it("runNow 保持下次时刻；同 fire_key 幂等、未完成运行阻止重叠", async () => {
    const r = await setup(), s = await r.service.create(owner, input());
    const first = await r.service.runNow(owner, s.id);
    expect(await r.service.runNow(owner, s.id)).toEqual(first);
    expect(r.admitter.calls).toHaveLength(1);
    vi.setSystemTime(START + 1);
    expect(await r.service.runNow(owner, s.id)).toMatchObject({ status: "skipped", reason: "overlap" });
    await r.service.recordRun(s.id, { ...first, status: "silent" });
    vi.setSystemTime(START + 2);
    await r.service.runNow(owner, s.id);
    expect(r.admitter.calls.map(call => call.ordinal)).toEqual([1, 2]);
    expect(await r.service.get(s.id)).toMatchObject({ next_fire_at: s.next_fire_at, revision: 1 });
  });

  it("admit 失败时整个事务回滚，不留下 queued 或占用序号", async () => {
    const r = await setup(), s = await r.service.create(owner, input());
    r.admitter.reject = true;
    await expect(r.service.runNow(owner, s.id)).rejects.toThrow("admission failed");
    expect(await r.service.get(s.id)).toEqual(s);
    expect((await r.harness.snapshot(ScheduleRuntimeDoc, ctx))?.ordinals).toEqual({});
  });

  it("recordRun 覆盖、去重计数、sent/silent 清零；三次失败暂停并只发一次 trace", async () => {
    const r = await setup(), s = await r.service.create(owner, input());
    const record = (n: number, status: ScheduleRun["status"]) =>
      r.service.recordRun(s.id, { fire_key: `${s.id}@${START + n}`, fire_at: START + n, status, note: "文".repeat(250) });
    await record(1, "failed"); await record(1, "failed"); await record(1, "running");
    expect(await r.service.get(s.id)).toMatchObject({ failures: 1, runs: [{ status: "failed", note: "文".repeat(200) }] });
    await record(2, "sent"); expect((await r.service.get(s.id))?.failures).toBe(0);
    await record(3, "failed"); await record(4, "silent"); expect((await r.service.get(s.id))?.failures).toBe(0);
    await record(5, "failed"); await record(6, "failed"); await record(7, "failed"); await record(7, "failed");
    expect(await r.service.get(s.id)).toMatchObject({ status: "paused", revision: 2, failures: 3,
      next_fire_at: null, pause_reason: "连续 3 次失败" });
    expect(r.event).toHaveBeenCalledTimes(1);
    expect(r.event.mock.calls[0][1]).toBe("schedule_paused");
    await r.service.resume(owner, s.id);
    expect(await r.service.get(s.id)).toMatchObject({ failures: 0, status: "active", revision: 3 });
    await expect(record(8, "queued")).resolves.toBeUndefined();
    await expect(r.service.recordRun(s.id, { fire_key: "other@1", fire_at: 1, status: "failed" })).rejects.toThrow("fire_key");
  });

  it("保留 20 条、ordinal 持续递增；删除后的迟到记录不重建任务", async () => {
    const r = await setup(), s = await r.service.create(owner, input());
    for (let n = 0; n < 23; n++) {
      vi.setSystemTime(START + n);
      const run = await r.service.runNow(owner, s.id);
      await r.service.recordRun(s.id, { ...run, status: "silent" });
    }
    expect((await r.service.get(s.id))?.runs).toHaveLength(20);
    expect(r.admitter.calls.at(-1)?.ordinal).toBe(23);
    await r.service.recordRun(s.id, { fire_key: `${s.id}@${START}`, fire_at: START, status: "failed" });
    expect((await r.service.get(s.id))?.failures).toBe(0);
    expect((await r.service.get(s.id))?.runs[0].fire_at).toBe(START + 3);
    await r.service.remove(owner, s.id);
    await r.service.recordRun(s.id, { fire_key: `${s.id}@${START}`, fire_at: START, status: "failed" });
    expect(await r.service.list()).toEqual([]);
  });

  it("排队运行不会被 20 条 overlap 挤出历史，结算后解除占用", async () => {
    const r = await setup(), s = await r.service.create(owner, input());
    const first = await r.service.runNow(owner, s.id);
    for (let n = 1; n <= 22; n++) {
      vi.setSystemTime(START + n);
      expect((await r.service.runNow(owner, s.id)).reason).toBe("overlap");
    }
    expect(r.admitter.calls).toHaveLength(1);
    expect((await r.service.get(s.id))?.runs).toContainEqual(first);
    expect((await r.service.get(s.id))?.runs).toHaveLength(20);
    await r.service.recordRun(s.id, { ...first, status: "silent" });
    vi.setSystemTime(START + 23);
    expect((await r.service.runNow(owner, s.id)).status).toBe("queued");
    expect(r.admitter.calls).toHaveLength(2);
  });
});


it("未配置 owner 时拒绝 owner 会话；更新也检查已有会话的长度", async () => {
  const r = await setup();
  const service = new ScheduleService({ harness: r.harness, task: r.task, admitter: r.admitter, canSchedule: () => true });
  await expect(service.create("qq:1", input())).rejects.toThrow("owner");
  const s = await r.service.create(owner, input());
  await r.harness.commit(async tx => { (await tx.doc(SchedulesDoc)).schedules[s.id].conversation = `group:${"1".repeat(21)}`; }, ctx);
  await expect(r.service.update(owner, s.id, { name: "更新" })).rejects.toThrow("conversation");
});

it("completed 的失败计数仍累加，但三次失败或失权都不能改成 paused", async () => {
  const r = await setup(), s = await r.service.create(owner, input());
  await r.harness.commit(async tx => {
    const schedule = (await tx.doc(SchedulesDoc)).schedules[s.id];
    schedule.status = "completed"; schedule.next_fire_at = null;
  }, ctx);
  for (let n = 1; n <= 3; n++) await r.service.recordRun(s.id, {
    fire_key: `${s.id}@${START + n}`, fire_at: START + n, status: "failed",
  });
  await r.service.pauseWithReason(s.id, "失权");
  expect(await r.service.get(s.id)).toMatchObject({ status: "completed", failures: 3, revision: 1, next_fire_at: null });
  expect(r.event).not.toHaveBeenCalled();
});

it.each(["queued", "running"] as const)("裁剪只删除终态记录，保留 %s", async status => {
  const r = await setup(), s = await r.service.create(owner, input());
  const first = { fire_key: `${s.id}@${START}`, fire_at: START, status };
  await r.service.recordRun(s.id, first);
  for (let n = 1; n <= 25; n++) await r.service.recordRun(s.id, {
    fire_key: `${s.id}@${START + n}`, fire_at: START + n, status: "skipped", reason: "overlap",
  });
  const runs = (await r.service.get(s.id))!.runs;
  expect(runs).toHaveLength(20); expect(runs[0]).toEqual(first);
  expect(runs[1].fire_at).toBe(START + 7);
});

it("第二 owner 可管理全部任务，享有五分钟规则且不受五条额度限制", async () => {
  const r = await setup({ owners: ["1", "2"], canSchedule: actor => actor === "qq:3" });
  const primary = await r.service.create(owner, input());
  const other = await r.service.create("qq:3", input({ conversation: "group:7",
    rule: { kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=30", dtstart: START } }));
  const secondary = [];
  for (let n = 0; n < 6; n++) secondary.push(await r.service.create("qq:2", input()));
  expect(await r.service.list("qq:2")).toHaveLength(8);
  expect(await r.service.list("qq:3")).toHaveLength(1);
  expect(await r.service.get(primary.id, "qq:2")).toEqual(primary);
  await r.service.update("qq:2", primary.id, { name: "第二账号修改" });
  await r.service.update(owner, secondary[0].id, { name: "主账号修改" });
  await r.service.pause(owner, secondary[0].id);
  await expect(r.service.resume("qq:2", secondary[0].id)).resolves.toMatchObject({ status: "active" });
  await expect(r.service.runNow("qq:2", primary.id)).resolves.toHaveProperty("ticket");
  await r.service.pause("qq:2", other.id);
  await expect(r.service.resume("qq:2", other.id)).resolves.toMatchObject({ status: "active" });
  await r.service.remove("qq:2", other.id);
  await expect(r.service.remove("qq:3", primary.id)).rejects.toMatchObject({ status: 403 });
  await r.service.complete("qq:2", primary.id);
  expect(await r.service.get(primary.id)).toMatchObject({ status: "completed" });
});
