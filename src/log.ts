/** 极简结构化日志：一行一个 JSON，写 stderr。绝不传入 token 等敏感值。 */
import { redact } from './obs/redact.js';
export type LogLine = { t: string; level: Level; msg: string; [key: string]: unknown };
const ring: LogLine[] = [];
const sinks = new Set<(line: LogLine) => void>();
export const logBuffer = {
  recent: () => [...ring],
  subscribe(fn: (line: LogLine) => void): () => void { sinks.add(fn); return () => { sinks.delete(fn); }; },
};
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < order[threshold]) return;
  const line = redact({ ...fields, t: new Date().toISOString(), level, msg }) as LogLine;
  ring.push(line);
  if (ring.length > 1000) ring.shift();
  for (const sink of sinks) { try { sink(line); } catch { /* 观测出口不能阻断日志 */ } }
  process.stderr.write(`${JSON.stringify(line, (_k, v) => (v instanceof Error ? v.message : v))}\n`);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
