import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import type { Env } from "../env";
import type { ExtractComplete } from "../memory/extractor";
import type { MemoryStore } from "../memory/store";
import { AGING_LAST_RUN_KEY, runAging } from "./aging";
import { CONSOLIDATE_LAST_RUN_KEY, runConsolidate } from "./consolidate";
import { runRetention } from "./retention";

/** UTC 19:30，即北京时间 03:30，与 Docker 版的凌晨维护同一时段。 */
export const MAINTENANCE_CRON = "30 19 * * *";
export const MAINTENANCE_KINDS = ["aging", "consolidate", "retention"] as const;
/** now 为毫秒；各 job 的“今天”“过期”都按它算，不读运行时时钟。 */
export type MaintenanceJob = { kind: typeof MAINTENANCE_KINDS[number]; now: number };

/** 天数；0 表示不清理。 */
export type MaintenanceConfig = { rawDays: number; rawHardMaxDays: number; summaryDays: number; eventsDays: number };
export type MaintenanceContext = {
  db: SqliteDatabase; kv: Pick<DurableObjectStorage, "get" | "put">; store: MemoryStore;
  complete: ExtractComplete; config: MaintenanceConfig; now: number;
};

const JOBS = { aging: runAging, consolidate: runConsolidate, retention: runRetention } satisfies Record<MaintenanceJob["kind"], (context: MaintenanceContext) => Promise<object>>;
export type MaintenanceReport = Awaited<ReturnType<typeof JOBS[MaintenanceJob["kind"]]>>;
export const runMaintenanceJob = (kind: MaintenanceJob["kind"], context: MaintenanceContext): Promise<MaintenanceReport> => JOBS[kind](context);

type DayVars = Partial<Record<"HISTORY_RAW_DAYS" | "HISTORY_RAW_HARD_MAX_DAYS" | "HISTORY_SUMMARY_DAYS" | "EVENTS_RETENTION_DAYS", string | number>>;
export function maintenanceConfig(env: DayVars): MaintenanceConfig {
  const days = (value: string | number | undefined, fallback: number) => {
    const n = typeof value === "string" && value.trim() ? Number(value) : value;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return { rawDays: days(env.HISTORY_RAW_DAYS, 30), rawHardMaxDays: days(env.HISTORY_RAW_HARD_MAX_DAYS, 90),
    summaryDays: days(env.HISTORY_SUMMARY_DAYS, 365), eventsDays: days(env.EVENTS_RETENTION_DAYS, 30) };
}

export async function maintenanceStatus(db: SqliteDatabase, kv: Pick<DurableObjectStorage, "get">) {
  const summaries = { day: 0, week: 0 };
  for (const row of await db.all<{ kind: "day" | "week"; n: number }>("SELECT kind, COUNT(*) AS n FROM summaries GROUP BY kind")) summaries[row.kind] = row.n;
  return { agingLastRun: await kv.get<number>(AGING_LAST_RUN_KEY) ?? null, consolidateLastRun: await kv.get<number>(CONSOLIDATE_LAST_RUN_KEY) ?? null, summaries };
}

/** 逐线程、逐 job 串行 RPC；任何一次失败只记分类，不影响其他线程与后续 job。 */
export async function runMaintenance(env: Env, now: number): Promise<void> {
  for (const key of await env.BRIDGE.getByName("napcat").threadKeys()) {
    const thread = env.THREAD.getByName(key);
    for (const kind of MAINTENANCE_KINDS) {
      try {
        console.log({ event: "maintenance", thread: key, ...await thread.maintain({ kind, now }) });
      } catch (error) {
        console.error({ event: "maintenance_failed", thread: key, kind, error: error instanceof Error ? error.name : typeof error });
      }
    }
  }
}
