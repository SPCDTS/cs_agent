import { promises as fs } from "node:fs";
import type { ContextUsageHistory } from "./context-usage.js";

export const ROLLOUT_USAGE_MAX_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const count = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function usage(v: unknown): Pick<ContextUsageHistory, "usedTokens" | "cachedTokens"> | undefined {
  const u = object(v);
  if (!u || !count(u.input_tokens)) return undefined;
  // Codex 的 input_tokens 已包含缓存，total_tokens 包含输出，不可用作上下文占用。
  return { usedTokens: u.input_tokens, cachedTokens: count(u.cached_input_tokens) ? u.cached_input_tokens : undefined };
}

/** 倒序按块读取末尾至多 2 MiB；跳过边界半行及损坏行，文件消失也不影响启动。 */
export async function readRolloutContextUsage(file: string): Promise<(ContextUsageHistory & { truncated: boolean }) | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - ROLLOUT_USAGE_MAX_BYTES);
    let position = size;
    let suffix = Buffer.alloc(0);
    let turns = 0;
    let waitingForUsage = false;
    let latest: Omit<ContextUsageHistory, "turns"> | undefined;
    const consume = (line: Buffer) => {
      try {
        const record = object(JSON.parse(line.toString("utf8")));
        if (!record) return;
        const payload = record.type === "event_msg" ? object(record.payload) : record;
        const type = payload?.type;
        if (type === "task_complete" || type === "turn.completed") {
          turns++;
          waitingForUsage = true;
        }
        if (type === "task_started" || type === "turn.started") waitingForUsage = false;
        if (latest || !waitingForUsage) return;
        const tokens = type === "token_count" ? usage(object(payload?.info)?.last_token_usage)
          : type === "turn.completed" ? usage(payload?.usage) : undefined;
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
    return latest && { ...latest, turns, truncated: start > 0 };
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}
