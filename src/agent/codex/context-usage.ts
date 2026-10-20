import { promises as fs } from "node:fs";
import type { ContextUsageHistory } from "../context-usage.js";

export const ROLLOUT_USAGE_MAX_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const count = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** rollout 与上下文占用条共用实测 token 字段解析，不把缓存再次加入 input。 */
export function parseRolloutTokenUsage(record: unknown): { input: number; output: number; cached?: number; reasoning?: number; measured: true } | undefined {
  const row = object(record);
  if (!row) return undefined;
  const payload = row.type === "event_msg" || row.type === "token_usage_record" ? object(row.payload) : row;
  const raw = payload?.type === "token_count" ? object(object(payload.info)?.last_token_usage)
    : row.type === "token_usage_record" || payload?.type === "turn.completed" ? object(payload?.usage) : undefined;
  if (!raw || !count(raw.input_tokens)) return undefined;
  return { input: raw.input_tokens, output: count(raw.output_tokens) ? raw.output_tokens : 0,
    ...(count(raw.cached_input_tokens) ? { cached: raw.cached_input_tokens } : {}),
    ...(count(raw.reasoning_output_tokens) ? { reasoning: raw.reasoning_output_tokens } : {}), measured: true };
}

/** 倒序按块读取末尾至多 2 MiB；跳过边界半行及损坏行，文件消失也不影响启动。 */
export async function readRolloutContextUsage(file: string, compactedAfter?: number): Promise<(ContextUsageHistory & { truncated: boolean }) | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - ROLLOUT_USAGE_MAX_BYTES);
    let position = size;
    let suffix = Buffer.alloc(0);
    let turns = 0;
    let waitingForUsage = false;
    let effectiveWindowTokens: number | undefined;
    let latest: Omit<ContextUsageHistory, "turns"> | undefined;
    let compactUsage: typeof latest;
    let sawCompaction = false;
    const consume = (line: Buffer) => {
      try {
        const record = object(JSON.parse(line.toString("utf8")));
        if (!record) return;
        const payload = record.type === "event_msg" ? object(record.payload) : record;
        const type = payload?.type;
        // 手动压缩不一定有 task_complete；只接受本次 compacted 标记之后的快照。
        // 此快照 input_tokens 可为 0，total_tokens 才是摘要与保留消息的上下文估算。
        if (compactedAfter !== undefined) {
          if (latest || sawCompaction) return;
          const updatedAt = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
          if (record.type === "compacted") {
            sawCompaction = true;
            if (count(updatedAt) && updatedAt >= compactedAfter && compactUsage && compactUsage.updatedAt >= updatedAt) {
              latest = { ...compactUsage, lastCompactionAt: updatedAt };
            }
          } else if (type === "task_started" || type === "turn.started" || type === "task_complete" || type === "turn.completed") {
            compactUsage = undefined;
          } else if (type === "token_count" && !compactUsage && count(updatedAt) && updatedAt >= compactedAfter) {
            const info = object(payload?.info);
            const total = object(info?.last_token_usage)?.total_tokens;
            if (count(total)) {
              compactUsage = { usedTokens: total, updatedAt,
                ...(count(info?.model_context_window) && info.model_context_window > 0 ? { effectiveWindowTokens: info.model_context_window } : {}) };
            }
          }
          return;
        }
        if (type === "task_complete" || type === "turn.completed") {
          turns++;
          waitingForUsage = true;
        }
        if (type === "task_started" || type === "turn.started") waitingForUsage = false;
        // 与已完成回合的快照对齐，忽略尾部尚未完成的回合；缺省时向前寻找最近有效记录。
        if (type === "token_count" && (waitingForUsage || latest) && effectiveWindowTokens === undefined) {
          const window = object(payload?.info)?.model_context_window;
          if (count(window) && window > 0) effectiveWindowTokens = window;
        }
        if (latest || !waitingForUsage) return;
        // turn.completed.usage 是线程累计量，只能用于识别回合结束，不能作为上下文占用；只取 token_count.last_token_usage。
        const parsed = type === "token_count" ? parseRolloutTokenUsage(record) : undefined;
        const tokens = parsed ? { usedTokens: parsed.input, cachedTokens: parsed.cached } : undefined;
        const updatedAt = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
        if (tokens && count(updatedAt)) latest = { ...tokens, updatedAt };
      } catch { /* 损坏或尚未写完的行只影响该行 */ }
    };
    while (position > start) {
      const length = Math.min(64 * 1024, position - start);
      position -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = Buffer.concat([buffer.subarray(0, bytesRead), suffix]);
      let end = chunk.length;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 10) continue;
        consume(chunk.subarray(i + 1, end));
        end = i;
      }
      suffix = chunk.subarray(0, end);
    }
    if (start === 0) consume(suffix);
    return latest && { ...latest, ...(effectiveWindowTokens !== undefined ? { effectiveWindowTokens } : {}), turns, truncated: start > 0 };
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}
