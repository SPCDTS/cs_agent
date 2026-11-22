import type { Env } from "../env";
import { containsSecret } from "../memory/secrets";

export type DiagLevel = "warn" | "error";
export type DiagDetailValue = string | number | boolean | null;

export type DiagErrorInfo = {
  errorName?: string;
  code?: string;
  status?: number;
};

export type DiagRecord = {
  seq?: number;
  at: number;
  level: DiagLevel;
  event: string;
  thread?: string;
  turnId?: string;
  actor?: string;
  stage?: string;
  code?: string;
  errorName?: string;
  status?: number;
  detail?: Record<string, DiagDetailValue>;
};

export type DiagQuery = {
  since?: number;
  until?: number;
  level?: DiagLevel;
  event?: string;
  thread?: string;
  turnId?: string;
  before?: number;
  limit?: number;
};

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/;
const SAFE_MACHINE_MESSAGE = /^[a-z][a-z0-9_:-]{0,79}$/;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeToken(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value < 0) return String(value);
  if (typeof value !== "string" || !SAFE_TOKEN.test(value) || containsSecret(value)) return undefined;
  return value;
}

/**
 * 从未知异常提取安全的分类信息（错误类型名、机器错误码、HTTP 状态码），
 * 绝不拼入自由文本、堆栈、上游响应正文或任何潜在凭据。
 */
export function classifyError(error: unknown): DiagErrorInfo {
  if (!error || typeof error !== "object") {
    return typeof error === "string" && SAFE_MACHINE_MESSAGE.test(error) && !containsSecret(error) ? { code: error } : {};
  }
  const raw = error as Record<string, unknown>;
  const errorName = typeof raw.name === "string" && SAFE_ERROR_NAME.test(raw.name) ? raw.name : undefined;
  const rawStatus = typeof raw.status === "number" ? raw.status : typeof raw.statusCode === "number" ? raw.statusCode : undefined;
  const status = rawStatus !== undefined && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  let code = safeToken(raw.code) ?? safeToken(raw.kind) ?? safeToken(raw.reason);
  if (code === "-32001" || !code && errorName === "TimeoutError") code = "timeout";
  else if (!code && errorName === "AbortError") code = "aborted";
  if (!code && typeof raw.message === "string" && !raw.message.includes("://")) {
    const head = raw.message.split(":")[0]?.trim() ?? "";
    if (SAFE_MACHINE_MESSAGE.test(raw.message) && raw.message !== "http" && raw.message !== "https" && !containsSecret(raw.message)) code = raw.message;
    else if (raw.message.includes(":") && SAFE_MACHINE_MESSAGE.test(head) && head !== "http" && head !== "https" && !containsSecret(head)) code = head;
  }
  return {
    ...(errorName ? { errorName } : {}),
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function cleanDetail(detail?: Record<string, unknown>): Record<string, DiagDetailValue> | undefined {
  if (!detail) return undefined;
  const entries: [string, DiagDetailValue][] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (!SAFE_TOKEN.test(key) || value === undefined) continue;
    if (value === null || typeof value === "boolean") entries.push([key, value]);
    else if (typeof value === "number" && Number.isFinite(value)) entries.push([key, value]);
    else if (typeof value === "string") {
      entries.push([key, containsSecret(value) ? "[redacted]" : value.slice(0, 160)]);
    } else if (object(value)) {
      const nestedStatus = typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : undefined;
      const nested = safeToken(value.code) ?? safeToken(value.kind) ?? nestedStatus ?? safeToken(value.status);
      if (nested !== undefined) entries.push([key, nested]);
    }
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export type LogDiagInput = {
  event: string;
  level?: DiagLevel;
  at?: number;
  thread?: string;
  turnId?: string;
  actor?: string;
  stage?: string;
  code?: string;
  errorName?: string;
  status?: number;
  error?: unknown;
  detail?: Record<string, unknown>;
};

type WaitUntilLike = { waitUntil(promise: Promise<unknown>): void };

/**
 * 统一结构化诊断入口：同步输出到平台日志，并异步双写至 RequestsDO("main") 环形缓冲表供管理台与 Agent 自省。
 */
export function logDiag(env: Pick<Env, "REQUESTS"> | undefined, ctx: WaitUntilLike | undefined, input: LogDiagInput): DiagRecord {
  const classified = input.error !== undefined ? classifyError(input.error) : {};
  const level: DiagLevel = input.level ?? "error";
  const detail = cleanDetail(input.detail);
  const record: DiagRecord = {
    at: input.at ?? Date.now(),
    level,
    event: SAFE_TOKEN.test(input.event) ? input.event : "diagnostic_event",
    ...(input.thread && !containsSecret(input.thread) ? { thread: input.thread.slice(0, 120) } : {}),
    ...(input.turnId && !containsSecret(input.turnId) ? { turnId: input.turnId.slice(0, 180) } : {}),
    ...(input.actor && !containsSecret(input.actor) ? { actor: input.actor.slice(0, 120) } : {}),
    ...(input.stage && SAFE_TOKEN.test(input.stage) ? { stage: input.stage } : {}),
    ...classified,
    ...(input.errorName && SAFE_ERROR_NAME.test(input.errorName) ? { errorName: input.errorName } : {}),
    ...(input.code && SAFE_TOKEN.test(input.code) && !containsSecret(input.code) ? { code: input.code } : {}),
    ...(input.status !== undefined && Number.isInteger(input.status) ? { status: input.status } : {}),
    ...(detail ? { detail } : {}),
  };
  if (level === "warn") console.warn(record);
  else console.error(record);
  if (env && !record.event.startsWith("diag_")) {
    const write = env.REQUESTS.getByName("main").recordDiag(record).catch(() => {});
    if (ctx) ctx.waitUntil(write);
  }
  return record;
}
