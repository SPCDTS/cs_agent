import type { Tx } from "@earendil-works/pi-durable";
import { ScheduleRuntimeDoc, SchedulesDoc } from "./docs.js";
import { ScheduleError } from "./model.js";
import type { Schedule, ScheduleRun } from "./types.js";
import { trace, type Trace } from "../../shared/trace.js";

const settled = (run: ScheduleRun) => ["sent", "silent", "failed", "skipped"].includes(run.status);

/** 允许 admitter 在同一事务内记录终态；不能从 admit 中嵌套调用 service.recordRun。 */
export async function recordRunInTransaction(tx: Tx, scheduleId: string, run: ScheduleRun, now: number): Promise<Schedule | undefined> {
  if (run.fire_key !== `${scheduleId}@${run.fire_at}`) throw new ScheduleError(400, "fire_key 与定时任务不匹配");
  const doc = await tx.doc(SchedulesDoc), schedule = doc.schedules[scheduleId];
  if (!Object.hasOwn(doc.schedules, scheduleId)) return undefined; // 删除后迟到的执行结果不得重建定义。
  const index = schedule.runs.findIndex(r => r.fire_key === run.fire_key);
  const previous = index < 0 ? undefined : schedule.runs[index];
  // 终态重放仅补充字段；迟到的 queued/running 不能把已完成的运行倒退。
  if (previous && settled(previous) && !settled(run)) return undefined;
  const runtime = await tx.doc(ScheduleRuntimeDoc);
  const last = runtime.last_result[scheduleId];
  const inFlight = runtime.in_flight[scheduleId] === run.fire_key;
  if (run.status === "queued" || run.status === "running") runtime.in_flight[scheduleId] = run.fire_key;
  else if (runtime.in_flight[scheduleId] === run.fire_key) delete runtime.in_flight[scheduleId];
  const row = { ...previous, ...run, ...(run.note === undefined ? {} : { note: run.note.slice(0, 200) }) };
  if (index < 0) {
    schedule.runs.push(row);
    schedule.runs.sort((a, b) => a.fire_at - b.fire_at);
  } else schedule.runs[index] = row;
  // 在途记录必须保留；超过上限时只裁剪最早的终态记录。
  while (schedule.runs.length > 20) {
    const oldest = schedule.runs.findIndex(settled);
    if (oldest < 0) break;
    schedule.runs.splice(oldest, 1);
  }
  if (run.status === "sent" || run.status === "silent" || run.status === "failed") {
    // 历史只有 20 条，保留最后结算水位，防止旧 fire_key 重放再次累计失败或清零新失败。
    if (inFlight || !last || run.fire_at > last.fire_at || run.fire_at === last.fire_at && run.status !== last.status) {
      if (run.status === "failed") schedule.failures++; else schedule.failures = 0;
      if (!last || run.fire_at >= last.fire_at) runtime.last_result[scheduleId] = { fire_at: run.fire_at, status: run.status };
    }
  }
  schedule.updated_at = now;
  if (schedule.failures >= 3 && schedule.status === "active") {
    schedule.status = "paused";
    schedule.pause_reason = "连续 3 次失败";
    schedule.next_fire_at = null;
    schedule.revision++;
    delete runtime.tasks[scheduleId];
    return JSON.parse(JSON.stringify(schedule)) as Schedule;
  }
  return undefined;
}

export function reportPaused(schedule: Schedule | undefined, tracer: Pick<Trace, "event"> = trace): void {
  if (schedule) tracer.event(`@schedule:${schedule.id}`, "schedule_paused", {
    status: "failed", scope: schedule.conversation,
    detail: { schedule_id: schedule.id, reason: schedule.pause_reason, failures: schedule.failures },
  });
}
