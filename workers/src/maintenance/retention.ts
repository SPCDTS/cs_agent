import type { MaintenanceContext } from "./index";
import { RETENTION_MS } from "../subagent/model";

const DAY_MS = 86400_000;
const INBOUND_DAYS = 30;
const OUTBOX_DAYS = 30;
const EXTRACT_QUEUE_DAYS = 7;

/** events、outbox.sent_at、extract_queue.enqueued_at 是毫秒，inbound.received_at 是 QQ 消息的秒级时间。 */
export async function runRetention({ db, config, now }: MaintenanceContext) {
  return db.transaction(async tx => {
    const count = async (sql: string, cutoff: number) => (await tx.all(sql + " RETURNING 1", cutoff)).length;
    return {
      kind: "retention" as const,
      events: config.eventsDays > 0 ? await count("DELETE FROM events WHERE at < ?", now - config.eventsDays * DAY_MS) : 0,
      // queued 行还等着 Pi 接纳或恢复，不能按时间删。
      inbound: await count("DELETE FROM inbound WHERE status IN ('done', 'failed') AND received_at < ?", Math.floor((now - INBOUND_DAYS * DAY_MS) / 1000)),
      outbox: await count("DELETE FROM outbox WHERE sent_at < ?", now - OUTBOX_DAYS * DAY_MS),
      extractQueue: await count("DELETE FROM extract_queue WHERE enqueued_at < ?", now - EXTRACT_QUEUE_DAYS * DAY_MS),
      // 与子 DO 自删同一期限：结束 14 天后登记一并删除。
      subagents: await count("DELETE FROM subagents WHERE status != 'running' AND ended_at < ?", now - RETENTION_MS),
    };
  });
}
