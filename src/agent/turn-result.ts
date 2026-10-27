import type { OutboxRow } from "../channel/outbox.js";
import type { TurnStatus } from "./host/types.js";

/** 定时与外部事件使用同一判定；不确定发送及附件失败不能算静默成功。 */
export function turnResult(status: TurnStatus, rows: readonly OutboxRow[]) {
  const modelRows = rows.filter(row => !row.system);
  const sent = modelRows.filter(row => row.status === "sent").length;
  const deliveryFailed = modelRows.some(row => row.status !== "sent" || row.files.some(file => file.status !== "sent"));
  const turnFailed = status !== "completed";
  return { status: turnFailed || deliveryFailed ? "failed" as const : sent ? "sent" as const : "silent" as const,
    sent, deliveryFailed, turnFailed };
}
