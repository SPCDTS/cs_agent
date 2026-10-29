export const formatBeijingTime = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

export function parseMemoryTime(value: string, field = "时间"): number {
  const full = value.length === 10 ? value + " 00:00" : value;
  const ms = Date.parse(full.replace(" ", "T") + ":00+08:00");
  // Date.parse 会把二月三十日折到三月，必须往返核对才能拒绝无效日期。
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(full) || !Number.isFinite(ms)
    || Number(full.slice(0, 4)) < 1970 || Number(full.slice(0, 4)) > 9998 || formatBeijingTime(ms) !== full) {
    throw new Error(`${field} 的北京时间日期或时分无效；请使用有效的 YYYY-MM-DD 或 YYYY-MM-DD HH:mm（年份 1970～9998）。`);
  }
  return Math.floor(ms / 1000);
}
export const parseClearableTime = (value: string | undefined, field: string) => value === undefined ? undefined : value === "" ? null : parseMemoryTime(value, field);
