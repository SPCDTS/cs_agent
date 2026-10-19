import { randomUUID } from "node:crypto";
import type { SummaryObserver } from "./observer.js";
import type { SummarySource } from "./observer.js";
import { cleanupMedia } from "./media.js";
import path from "node:path";
import { usageFields } from "../shared/usage.js";
import { trace } from "../shared/trace.js";
/**
 * 聊天记录衰老任务（设计 §2.2）：每天本地 HISTORY_SUMMARY_HOUR 点（容器默认 UTC，设 TZ 可改）执行：
 * 1. 日摘要：每个 scope 今天之前、≥5 条且未被摘要覆盖的日子 → ≤400 字摘要（意图模型，pi-ai 直调）；
 * 2. 周摘要：已结束的自然周（周一起）内的日摘要合并为一条周摘要并删除日摘要；
 * 3. 清理：原始消息 > HISTORY_RAW_DAYS 且所在日已被日/周摘要覆盖（未覆盖的保留到 HISTORY_RAW_HARD_MAX_DAYS，
 *    摘要失败的日子下次重试）、摘要 > HISTORY_SUMMARY_DAYS。
 * 启动时若上次运行（meta.aging_last_run）早于 24h 立即补跑一次。任何错误只记日志，绝不使进程崩溃。
 */
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { log } from "../shared/log.js";
import { formatMessage, formatSummary, joinCapped, withoutImagePaths } from "./format.js";
import { SUMMARY_MAX, type ContextStore, type SummaryRow } from "./store.js";

export const AGING_LAST_RUN_KEY = "aging_last_run";
const MODEL_TIMEOUT_MS = 120_000;
/** 单次摘要输入上限（字符），避免极活跃的群一次请求过大 */
const INPUT_MAX_CHARS = 12_000;

const DAY_SUMMARY_PROMPT = `你是聊天记录归档助手。下面是一个 QQ 会话某一天的聊天记录（"[我]"是机器人自己的动作）。
请用中文写一段不超过 400 字的纯文本摘要，依次覆盖：
1. 参与者（昵称）；
2. 讨论的主题与结论；
3. 待办与承诺（谁答应了什么）；
4. 机器人做过的事（画了什么、回答了什么）。
只输出摘要正文，不要 Markdown、标题、列表符号以外的格式，不要编造记录中没有的内容。`;

const WEEK_SUMMARY_PROMPT = `你是聊天记录归档助手。下面是一个 QQ 会话一周内每天的摘要。
请合并为一段不超过 400 字的中文纯文本周摘要，保留：参与者、主要主题与结论、仍未完成的待办与承诺、机器人做过的重要事情。
只输出摘要正文，不要 Markdown，不要编造。`;

export interface AgingOptions {
  store: ContextStore;
  instrumentation?: SummaryObserver;
  models: Models;
  model: () => Model<Api>;
  rawDays: number;
  summaryDays: number;
  /** 未被摘要覆盖的原始消息最长保留天数（默认 90） */
  rawHardMaxDays?: number;
  /** 每日运行的本地小时（0-23） */
  hour: number;
  minMessages?: number;
  /** 当前时间（毫秒），测试可注入 */
  now?: () => number;
  cleanup?: () => Promise<unknown>;
}

export interface AgingReport {
  day_summaries: number;
  week_summaries: number;
  failed: number;
  purged_messages: number;
  purged_summaries: number;
  ms: number;
}

function textOf(msg: AssistantMessage): string {
  if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || `model ${msg.stopReason}`);
  const text = msg.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error("model returned empty summary");
  return text;
}

async function summarize(opts: AgingOptions, systemPrompt: string, input: string): Promise<{ text: string; model: string; provider: string; usage: AssistantMessage["usage"] }> {
  const msg = await opts.models.completeSimple(
    opts.model(),
    { systemPrompt, messages: [{ role: "user", content: input, timestamp: Date.now() }] },
    { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS), maxTokens: 2000 },
  );
  trace.event("@aging", "model_turn", { status: msg.stopReason === "error" ? "failed" : "ok", detail: {
    provider: msg.provider, model: msg.model, ...usageFields(msg.usage) } });
  return { text: textOf(msg).slice(0, SUMMARY_MAX + 100), model: msg.model, provider: msg.provider, usage: msg.usage };
}

const md = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 执行一次衰老任务。单个 scope/日 的模型失败只计数并跳过（下次再试）。 */
export async function runAging(opts: AgingOptions): Promise<AgingReport> {
  const started = Date.now();
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const { store, instrumentation } = opts;
  const batch_id = randomUUID();
  const report: AgingReport = { day_summaries: 0, week_summaries: 0, failed: 0, purged_messages: 0, purged_summaries: 0, ms: 0 };

  // 1. 日摘要
  for (const day of store.pendingDaySummaries(nowSec, opts.minMessages ?? 5)) {
    try {
      const rows = store.messagesBetween(day.scope, day.period_start, day.period_end);
      const lines = rows.map((r) => formatMessage({ ...r, text: withoutImagePaths(r.text), detail: r.detail ? withoutImagePaths(r.detail) : r.detail }, { now: day.period_start }));
      const body = joinCapped(lines, INPUT_MAX_CHARS, "last");
      const input = `会话：${day.scope}\n日期：${md(day.period_start)}\n\n${body}`;
      const result = await summarize(opts, DAY_SUMMARY_PROMPT, input);
      // 从实际保留的尾部逐行匹配，重复文本仍保留各自的消息 ID。
      const input_message_ids: string[] = [];
      let end = body.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (body.slice(end - lines[i].length, end) !== lines[i]) break;
        input_message_ids.unshift(rows[i].message_id); end -= lines[i].length + 1;
      }
      const written = store.writeSummary({ scope: day.scope, level: "day", period_start: day.period_start,
        period_end: day.period_end, text: result.text, msg_count: rows.length });
      instrumentation?.recordSummaryVersion(written, { ...result, batch_id, input_message_ids, input_chars: input.length });
      report.day_summaries++;
    } catch (err) {
      report.failed++;
      log.warn("day summary failed", { scope: day.scope, day: md(day.period_start), error: err });
    }
  }

  // 2. 周摘要（仍有日子未摘要成功的周先不折叠，等下次补齐）
  const stillPending = store.pendingDaySummaries(nowSec, opts.minMessages ?? 5);
  for (const week of store.foldableWeeks(nowSec)) {
    if (stillPending.some((p) => p.scope === week.scope && p.period_start >= week.period_start && p.period_start < week.period_end)) continue;
    try {
      const input = `会话：${week.scope}\n\n${week.days.map((d: SummaryRow) => formatSummary(d)).join("\n")}`;
      // 只有一条日摘要时沿用原文，没有调用模型，不虚构模型与 usage。
      const result = week.days.length === 1 ? { text: week.days[0]!.text } : await summarize(opts, WEEK_SUMMARY_PROMPT, input);
      const source: SummarySource = { ...result, batch_id, input_summary_ids: week.days.map(d => d.id),
        input_chars: week.days.length === 1 ? 0 : input.length };
      const fold = () => {
        const replaced = week.days.map(d => instrumentation?.snapshotReplaced(d, { batch_id }))
          .filter((id): id is number => id !== undefined);
        const written = store.replaceWithWeek(week, result.text);
        instrumentation?.recordSummaryVersion(written, source, replaced);
      };
      if (instrumentation) instrumentation.transaction(fold); else fold();
      report.week_summaries++;
    } catch (err) {
      report.failed++;
      log.warn("week summary failed", { scope: week.scope, week: md(week.period_start), error: err });
    }
  }

  // 3. 清理
  const purged = store.purge(nowSec, opts.rawDays, opts.summaryDays, opts.rawHardMaxDays ?? 90);
  report.purged_messages = purged.messages;
  report.purged_summaries = purged.summaries;
  await cleanupMedia(path.dirname(store.file), store, nowSec * 1000);
  store.setMeta(AGING_LAST_RUN_KEY, String(nowSec));
  report.ms = Date.now() - started;
  return report;
}

/** 距离下一个本地 hour:00 的毫秒数（恰好在整点时取下一天）。 */
export function msUntilNextRun(hour: number, nowMs: number): number {
  const next = new Date(nowMs);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
  return next.getTime() - nowMs;
}

export function needsCatchUp(store: ContextStore, nowMs: number): boolean {
  const last = Number(store.getMeta(AGING_LAST_RUN_KEY) ?? 0);
  return !Number.isFinite(last) || nowMs / 1000 - last >= 86400;
}

/** 启动调度：上次运行早于 24h 时立即补跑，之后每天 hour 点运行。返回 stop()。 */
export function startAgingScheduler(opts: AgingOptions): { stop(): void; runNow(): Promise<AgingReport | undefined>; running(): boolean } {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<AgingReport | undefined> | undefined;
  let stopped = false;
  const now = () => opts.now?.() ?? Date.now();

  const runSafe = (): Promise<AgingReport | undefined> => {
    if (running) return running;
    running = Promise.resolve().then(() => opts.cleanup?.()).then(() => runAging(opts))
      .then((r) => {
        trace.event("@aging", "aging", { status: r.failed ? "failed" : "ok", durationMs: r.ms, detail: r });
        log.info("history aging done", { ...r });
        return r;
      })
      .catch((err: unknown) => {
        trace.event("@aging", "aging", { status: "failed", detail: { error: err } });
        log.error("history aging failed", { error: err });
        return undefined;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void runSafe().finally(schedule), msUntilNextRun(opts.hour, now()));
    timer.unref();
  };

  try {
    if (needsCatchUp(opts.store, now())) void runSafe();
  } catch (err) {
    log.error("history aging check failed", { error: err });
  }
  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runNow: runSafe,
    running: () => running !== undefined,
  };
}
