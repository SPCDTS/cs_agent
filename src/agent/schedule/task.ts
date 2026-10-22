import { defineTask, type Tx } from "@earendil-works/pi-durable";
import { ScheduleRuntimeDoc, SchedulesDoc } from "./docs.js";
import { missedFires, nextFireAt } from "./model.js";
import { recordRunInTransaction, reportPaused } from "./records.js";
import type { Schedule, ScheduledFire, ScheduledRunAdmitter, ScheduledRunLauncher, ScheduleRun } from "./types.js";
import type { Trace } from "../../shared/trace.js";

export type ScheduleTaskInput = { id: string; revision: number };
export type ScheduleCheckpoint = { phase: "wait"; next_fire_at: number | null } | { phase: "fire"; next_fire_at: number };
const completed = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const current = (schedule: Schedule | undefined, input: ScheduleTaskInput) =>
  schedule?.status === "active" && schedule.revision === input.revision;

type AdmissionState = { ordinals: Record<string, number>; in_flight: Record<string, string> };
type PreparedRun = { fire: ScheduledFire; admitter: ScheduledRunAdmitter };
const overlapping = (schedule: Schedule, meta: AdmissionState | undefined) =>
  !!meta?.in_flight[schedule.id] || schedule.runs.some(run => run.status === "queued" || run.status === "running");

/** 定时输入在事务外写入；提交时仍需复核 revision、序号和重叠状态。 */
export async function prepareRun(schedule: Schedule, meta: AdmissionState | undefined, fireAt: number,
  launcher: ScheduledRunLauncher): Promise<PreparedRun | undefined> {
  const fireKey = `${schedule.id}@${fireAt}`;
  if (schedule.runs.some(run => run.fire_key === fireKey) || overlapping(schedule, meta)) return undefined;
  const fire = { schedule: structuredClone(schedule), fire_at: fireAt, fire_key: fireKey,
    ordinal: (meta?.ordinals[schedule.id] ?? 0) + 1 };
  return { fire, admitter: await launcher.prepare(fire) };
}

/** runNow 和到点触发共用事务内的幂等、重叠检查与排队记录。返回 undefined 表示需重新准备。 */
export async function admitRun(tx: Tx, schedule: Schedule, fireAt: number, now: number, prepared: PreparedRun | undefined): Promise<ScheduleRun | undefined> {
  const fireKey = `${schedule.id}@${fireAt}`;
  const existing = schedule.runs.find(run => run.fire_key === fireKey);
  if (existing) return existing;
  const meta = await tx.doc(ScheduleRuntimeDoc);
  if (overlapping(schedule, meta)) {
    const skipped: ScheduleRun = { fire_key: fireKey, fire_at: fireAt, status: "skipped", reason: "overlap", ended_at: now };
    await recordRunInTransaction(tx, schedule.id, skipped, now);
    return skipped;
  }
  const ordinal = (meta.ordinals[schedule.id] ?? 0) + 1;
  if (!prepared || prepared.fire.schedule.revision !== schedule.revision || prepared.fire.ordinal !== ordinal) return undefined;
  await recordRunInTransaction(tx, schedule.id, { fire_key: fireKey, fire_at: fireAt, status: "queued" }, now);
  const { key, skipped } = await prepared.admitter.admit(tx, prepared.fire);
  if (skipped) await recordRunInTransaction(tx, schedule.id, {
    fire_key: fireKey, fire_at: fireAt, input_key: key, status: "skipped", reason: "interrupted", ended_at: now,
    note: "定时输入已结束，未重新执行",
  }, now);
  meta.ordinals[schedule.id] = ordinal;
  // admitter 可能拒绝已结束的孤儿输入，保留事务内写入的终态。
  const row = schedule.runs.find(run => run.fire_key === fireKey)!;
  row.input_key = key;
  return row;
}

export function createScheduleTask(opts: { admitter: ScheduledRunLauncher; trace?: Pick<Trace, "event"> }) {
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
        const fireAt = task.state.checkpoint.next_fire_at;
        const snapshot = (await runtime.snapshot(SchedulesDoc, context))?.schedules[task.input.id];
        const now = runtime.now();
        let prepared: PreparedRun | undefined, failure: string | undefined;
        try {
          if (snapshot && current(snapshot, task.input) && now >= fireAt && now - fireAt <= snapshot.options.stale_after_ms) {
            prepared = await prepareRun(snapshot, await runtime.snapshot(ScheduleRuntimeDoc, context), fireAt, opts.admitter);
          }
        } catch (error) {
          runtime.signal?.throwIfAborted();
          failure = error instanceof Error ? error.message : String(error);
        }
        let paused: Schedule | undefined, admitted: ScheduleRun | undefined;
        const commitFire = async () => runtime.commit(async tx => {
          paused = undefined; admitted = undefined;
          const decide = async () => {
            const schedule = (await tx.doc(SchedulesDoc)).schedules[task.input.id];
            if (!current(schedule, task.input)) return completed;
            const now = runtime.now(), fireAt = task.state.checkpoint.next_fire_at;
            if (now < fireAt) return { status: "running" as const, checkpoint: { phase: "wait" as const, next_fire_at: fireAt } };
            const fireKey = `${schedule.id}@${fireAt}`;
            if (!schedule.runs.some(run => run.fire_key === fireKey)) {
              if (now - fireAt > schedule.options.stale_after_ms) {
                const count = missedFires(schedule.rule, fireAt, now);
                const previous = schedule.runs.at(-1);
                const interval = (nextFireAt(schedule.rule, fireAt) ?? fireAt) - fireAt;
                if (previous?.status === "skipped" && previous.reason === "stale" && previous.ended_at !== undefined &&
                    fireAt >= previous.ended_at && fireAt - previous.ended_at <= interval) {
                  previous.skipped_count = (previous.skipped_count ?? 1) + count;
                  previous.ended_at = now;
                } else await recordRunInTransaction(tx, schedule.id, {
                  fire_key: fireKey, fire_at: fireAt, status: "skipped", reason: "stale", skipped_count: count, ended_at: now,
                }, now);
              } else {
                const meta = await tx.doc(ScheduleRuntimeDoc);
                if (failure !== undefined && !overlapping(schedule, meta)) {
                  paused = await recordRunInTransaction(tx, schedule.id, {
                    fire_key: fireKey, fire_at: fireAt, status: "failed", reason: "backend_failed", ended_at: now,
                    note: "准备或入队失败：" + failure,
                  }, now);
                  meta.ordinals[schedule.id] = (meta.ordinals[schedule.id] ?? 0) + 1;
                } else {
                  const result = await admitRun(tx, schedule, fireAt, now, prepared);
                  admitted = result ? JSON.parse(JSON.stringify(result)) as ScheduleRun : undefined;
                  if (!admitted) return { status: "running" as const, checkpoint: { phase: "fire" as const, next_fire_at: fireAt } };
                  if (schedule.status === "paused" && schedule.pause_reason === "连续 3 次失败") {
                    paused = JSON.parse(JSON.stringify(schedule)) as Schedule;
                  }
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
            return { status: "running" as const, checkpoint: { phase: "wait" as const, next_fire_at: next } };
          };
          const transition = await decide();
          // discard 会核对持久 admission：另一提交已接管的输入不能结束。
          await prepared?.admitter.discard?.(tx);
          return transition;
        }, context);
        try { await commitFire(); }
        catch (error) {
          // admit 的局部写入先随整个提交回滚，再用新事务记录失败并推进检查点。
          runtime.signal?.throwIfAborted();
          failure = error instanceof Error ? error.message : String(error);
          await commitFire();
        }
        reportPaused(paused, opts.trace);
        if (admitted?.input_key && (admitted.status === "queued" || admitted.status === "running")) {
          opts.admitter.launch(admitted.input_key);
        }
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

export type ScheduleTask = ReturnType<typeof createScheduleTask>;
