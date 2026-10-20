import { defineTask, type Tx } from "@earendil-works/pi-durable";
import { ScheduleRuntimeDoc, SchedulesDoc } from "./docs.js";
import { missedFires, nextFireAt } from "./model.js";
import { recordRunInTransaction, reportPaused } from "./records.js";
import type { Schedule, ScheduledRunAdmitter, ScheduleRun } from "./types.js";
import type { Trace } from "../../shared/trace.js";

export type ScheduleTaskInput = { id: string; revision: number };
export type ScheduleCheckpoint = { phase: "wait"; next_fire_at: number | null } | { phase: "fire"; next_fire_at: number };
const completed = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const current = (schedule: Schedule | undefined, input: ScheduleTaskInput) =>
  schedule?.status === "active" && schedule.revision === input.revision;

/** runNow 和到点触发共用事务内的幂等、重叠检查与排队记录。 */
export async function admitRun(tx: Tx, schedule: Schedule, fireAt: number, now: number, admitter: ScheduledRunAdmitter): Promise<ScheduleRun> {
  const fireKey = `${schedule.id}@${fireAt}`;
  const existing = schedule.runs.find(run => run.fire_key === fireKey);
  if (existing) return existing;
  const meta = await tx.doc(ScheduleRuntimeDoc);
  if (meta.in_flight[schedule.id] || schedule.runs.some(run => run.status === "queued" || run.status === "running")) {
    const skipped: ScheduleRun = { fire_key: fireKey, fire_at: fireAt, status: "skipped", reason: "overlap", ended_at: now };
    await recordRunInTransaction(tx, schedule.id, skipped, now);
    return skipped;
  }
  const ordinal = (meta.ordinals[schedule.id] ?? 0) + 1;
  const fire = { schedule: JSON.parse(JSON.stringify(schedule)) as Schedule, fire_at: fireAt, fire_key: fireKey, ordinal };
  await recordRunInTransaction(tx, schedule.id, { fire_key: fireKey, fire_at: fireAt, status: "queued" }, now);
  const { ticket } = await admitter.admit(tx, fire);
  meta.ordinals[schedule.id] = ordinal;
  // 占位 admitter 可以在同一事务内写 failed，不能再覆盖回 queued。
  const row = schedule.runs.find(run => run.fire_key === fireKey)!;
  row.ticket = ticket;
  return row;
}

export function createScheduleTask(opts: { admitter: ScheduledRunAdmitter; trace?: Pick<Trace, "event"> }) {
  return defineTask<ScheduleTaskInput, ScheduleCheckpoint, null>({
    name: "cs.schedule", version: 1,
    initial: () => ({ phase: "wait", next_fire_at: null }),
    phases: {
      async wait(task, runtime, context) {
        // Tx 没有公开 abort API：同一提交中的 revision/status 撤销即为取消凭据，
        // 监听让旧任务立即结束；即使监听丢失，fire 仍在事务内复核。
        const watch = await runtime.watchDoc(SchedulesDoc, context);
        if (!watch) { await runtime.commit(() => completed, context); return; }
        try {
          const schedule = watch.value?.schedules[task.input.id];
          if (!current(schedule, task.input)) { await runtime.commit(() => completed, context); return; }
          const at = task.state.checkpoint.next_fire_at;
          if (at === null) {
            await runtime.commit(async tx => {
              const latest = (await tx.doc(SchedulesDoc)).schedules[task.input.id];
              return current(latest, task.input) && latest.next_fire_at !== null
                ? { status: "running", checkpoint: { phase: "wait", next_fire_at: latest.next_fire_at } }
                : completed;
            }, context);
            return;
          }
          let changed!: () => void;
          const invalidated = new Promise<void>(resolve => { changed = resolve; });
          watch.start(async value => { if (!current(value?.schedules[task.input.id], task.input)) changed(); });
          await Promise.race([runtime.sleep(at, context), invalidated]);
          await runtime.commit(async tx => current((await tx.doc(SchedulesDoc)).schedules[task.input.id], task.input)
            ? { status: "running", checkpoint: { phase: "fire", next_fire_at: at } } : completed, context);
        } finally { await watch.stop(); }
      },
      async fire(task, runtime, context) {
        let paused: Schedule | undefined;
        await runtime.commit(async tx => {
          const schedule = (await tx.doc(SchedulesDoc)).schedules[task.input.id];
          if (!current(schedule, task.input)) return completed;
          const now = runtime.now(), fireAt = task.state.checkpoint.next_fire_at;
          if (now < fireAt) return { status: "running", checkpoint: { phase: "wait", next_fire_at: fireAt } };
          const fireKey = `${schedule.id}@${fireAt}`;
          if (!schedule.runs.some(run => run.fire_key === fireKey)) {
            if (now - fireAt > schedule.options.stale_after_ms) {
              const count = missedFires(schedule.rule, fireAt, now);
              const previous = schedule.runs.at(-1);
              if (previous?.status === "skipped" && previous.reason === "stale") {
                previous.skipped_count = (previous.skipped_count ?? 1) + count;
                previous.ended_at = now;
              } else await recordRunInTransaction(tx, schedule.id, {
                fire_key: fireKey, fire_at: fireAt, status: "skipped", reason: "stale", skipped_count: count, ended_at: now,
              }, now);
            } else {
              await admitRun(tx, schedule, fireAt, now, opts.admitter);
              if (schedule.status === "paused" && schedule.pause_reason === "连续 3 次失败") {
                paused = JSON.parse(JSON.stringify(schedule)) as Schedule;
              }
            }
          }
          if (!current(schedule, task.input)) return completed;
          const next = nextFireAt(schedule.rule, now);
          schedule.next_fire_at = next;
          schedule.updated_at = now;
          if (next === null) {
            schedule.status = "completed";
            delete (await tx.doc(ScheduleRuntimeDoc)).tasks[schedule.id];
            return completed;
          }
          return { status: "running", checkpoint: { phase: "wait", next_fire_at: next } };
        }, context);
        reportPaused(paused, opts.trace);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

export type ScheduleTask = ReturnType<typeof createScheduleTask>;
