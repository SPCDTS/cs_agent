import { defineDoc } from "@earendil-works/pi-durable";
import type { SchedulesState } from "./types.js";

/** 接口映射为 durable 要求的 JSON 结构，不改变共用契约。 */
type JsonShape<T> = T extends object ? { [K in keyof T]: JsonShape<T[K]> } : T;
export const SchedulesDoc = defineDoc<JsonShape<SchedulesState>>({
  kind: "cs.schedules", version: 1, scope: "session",
  initial: () => ({ schedules: {} }),
});

/** 调度基础设施独立存放，避免给 Schedule 共用契约添加任务 id / 累计序号。 */
export const ScheduleRuntimeDoc = defineDoc<{
  conversation_id: number | null;
  tasks: Record<string, number>;
  ordinals: Record<string, number>;
  in_flight: Record<string, string>;
  last_result: Record<string, { fire_at: number; status: "sent" | "silent" | "failed" }>;
}>({
  kind: "cs.schedule.runtime", version: 1, scope: "session",
  initial: () => ({ conversation_id: null, tasks: {}, ordinals: {}, in_flight: {}, last_result: {} }),
});
