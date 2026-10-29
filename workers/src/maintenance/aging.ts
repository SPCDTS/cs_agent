import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { summaryLabel, type SummaryRow } from "../context";
import { completeWithin, type ExtractComplete } from "../memory/extractor";
import { formatBeijingTime } from "../memory/time";
import { cleanName } from "../policy";
import type { MaintenanceContext } from "./index";

export const AGING_LAST_RUN_KEY = "maint:aging_last_run";
const DAY = 86400;
/** 日界与周界都按北京时间；SQL 与 JS 两侧共用这一个偏移。 */
const TZ = 8 * 3600;
const SUMMARY_MAX = 400;
const MIN_MESSAGES = 5;
const INPUT_MAX_CHARS = 12_000;
const MODEL_TIMEOUT_MS = 120_000;

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

type Period = { scope: string; start: number; end: number };
type Week = Period & { days: SummaryRow[] };
type MessageRow = { time: number; user_id: string; nickname: string; is_self: number; text: string };

const dayIndex = (sec: number) => Math.floor((sec + TZ) / DAY);
const dayStart = (day: number) => day * DAY - TZ;
/** 1970-01-01 是周四，回退到周一。 */
const weekOf = (day: number) => day - ((day + 3) % 7);
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + "…" : text;

function messageLine(row: MessageRow): string {
  const time = new Date((row.time + TZ) * 1000).toISOString().slice(11, 16);
  const name = row.is_self ? "[我]" : cleanName(row.nickname).slice(0, 40) || row.user_id;
  return `${time} ${clip(`${name}: ${row.text.replace(/\s+/g, " ").trim()}`, 120)}`;
}

/** 保留末尾：一天里越晚的讨论越可能是结论。 */
function tail(lines: readonly string[]): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    used += lines[i]!.length + 1;
    if (used > INPUT_MAX_CHARS - 20) break;
    kept.unshift(lines[i]!);
  }
  return [...kept.length < lines.length ? [`（更早的 ${lines.length - kept.length} 条已省略）`] : [], ...kept].join("\n");
}

async function summarize(complete: ExtractComplete, prompt: string, input: string, tokens: { input: number; output: number }): Promise<string> {
  const result = await completeWithin(complete, `${prompt}\n\n${input}`, MODEL_TIMEOUT_MS);
  tokens.input += result.usage?.input ?? 0;
  tokens.output += result.usage?.output ?? 0;
  const text = result.text.trim();
  if (!text) throw new Error("empty_summary");
  return clip(text, SUMMARY_MAX);
}

/** 今天之前、≥5 条且没有被日或周摘要覆盖的 (scope, 日)。 */
async function pendingDays(db: SqliteDatabase, nowSec: number): Promise<Period[]> {
  const rows = await db.all<{ scope: string; day: number }>(`SELECT scope, day FROM (
      SELECT scope, CAST((time + ?) / ${DAY} AS INTEGER) AS day, COUNT(*) AS n FROM messages WHERE time < ? GROUP BY scope, day HAVING n >= ?) d
    WHERE NOT EXISTS (SELECT 1 FROM summaries s WHERE s.scope = d.scope AND s.period_start <= d.day * ${DAY} - ? AND s.period_end > d.day * ${DAY} - ?)
    ORDER BY day, scope`, TZ, dayStart(dayIndex(nowSec)), MIN_MESSAGES, TZ, TZ);
  return rows.map(row => ({ scope: row.scope, start: dayStart(row.day), end: dayStart(row.day + 1) }));
}

/** 已结束的自然周里的日摘要，按 (scope, 周) 分组。 */
async function foldableWeeks(db: SqliteDatabase, nowSec: number): Promise<Week[]> {
  const days = await db.all<SummaryRow>("SELECT * FROM summaries WHERE kind = 'day' AND period_start < ? ORDER BY scope, period_start",
    dayStart(weekOf(dayIndex(nowSec))));
  const weeks = new Map<string, Week>();
  for (const day of days) {
    const week = weekOf(dayIndex(day.period_start)), key = `${day.scope}|${week}`;
    const group = weeks.get(key) ?? { scope: day.scope, start: dayStart(week), end: dayStart(week + 7), days: [] };
    group.days.push(day);
    weeks.set(key, group);
  }
  return [...weeks.values()];
}

const UPSERT_SUMMARY = `INSERT INTO summaries (scope, kind, period_start, period_end, text, msg_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (scope, kind, period_start) DO UPDATE SET period_end = excluded.period_end, text = excluded.text,
    msg_count = excluded.msg_count, created_at = excluded.created_at`;

/** 日摘要 → 周摘要 → 清理；单个日或周的模型失败只计数，留到下次运行重试。 */
export async function runAging({ db, kv, complete, config, now }: MaintenanceContext) {
  const last = await kv.get<number>(AGING_LAST_RUN_KEY);
  // Cron 偶有重复投递；同一个北京日只跑一次，避免重复花模型额度。
  if (last !== undefined && formatBeijingTime(last).slice(0, 10) === formatBeijingTime(now).slice(0, 10)) return { kind: "aging" as const, status: "skipped" as const };
  const started = Date.now(), nowSec = Math.floor(now / 1000), tokens = { input: 0, output: 0 };
  const report = { kind: "aging" as const, status: "ok" as const, day: 0, week: 0, failed: 0, purgedMessages: 0, purgedSummaries: 0, tokens, ms: 0 };

  for (const day of await pendingDays(db, nowSec)) {
    try {
      const rows = await db.all<MessageRow & { id: number }>("SELECT * FROM messages WHERE scope = ? AND time >= ? AND time < ? ORDER BY time, id", day.scope, day.start, day.end);
      const date = formatBeijingTime(day.start * 1000).slice(0, 10);
      const text = await summarize(complete, DAY_SUMMARY_PROMPT, `会话：${day.scope}\n日期：${date}\n\n${tail(rows.map(messageLine))}`, tokens);
      await db.run(UPSERT_SUMMARY, day.scope, "day", day.start, day.end, text, rows.length, nowSec);
      report.day++;
    } catch { report.failed++; }
  }

  // 仍有日子没摘要成功的周先不折叠，否则缺的那天以后再也进不了周摘要。
  const stillPending = await pendingDays(db, nowSec);
  for (const week of await foldableWeeks(db, nowSec)) {
    if (stillPending.some(day => day.scope === week.scope && day.start >= week.start && day.start < week.end)) continue;
    try {
      const text = week.days.length === 1 ? week.days[0]!.text
        : await summarize(complete, WEEK_SUMMARY_PROMPT, `会话：${week.scope}\n\n${week.days.map(day => `${summaryLabel(day)} ${day.text}`).join("\n")}`, tokens);
      await db.transaction(async tx => {
        await tx.run(UPSERT_SUMMARY, week.scope, "week", week.start, week.end, text, week.days.reduce((n, day) => n + day.msg_count, 0), nowSec);
        for (const day of week.days) await tx.run("DELETE FROM summaries WHERE id = ? AND kind = 'day'", day.id);
      });
      report.week++;
    } catch { report.failed++; }
  }

  await db.transaction(async tx => {
    // 已被摘要覆盖的原文过保留期即删；没覆盖的（摘要失败或不足 5 条）留到硬上限。
    if (config.rawDays > 0) report.purgedMessages = (await tx.all(`DELETE FROM messages WHERE time < ? AND (time < ? OR EXISTS (
        SELECT 1 FROM summaries s WHERE s.scope = messages.scope AND s.period_start <= messages.time AND s.period_end > messages.time)) RETURNING id`,
      nowSec - config.rawDays * DAY, nowSec - Math.max(config.rawHardMaxDays, config.rawDays) * DAY)).length;
    if (config.summaryDays > 0) report.purgedSummaries = (await tx.all("DELETE FROM summaries WHERE period_end < ? RETURNING id", nowSec - config.summaryDays * DAY)).length;
  });
  await kv.put(AGING_LAST_RUN_KEY, now);
  report.ms = Date.now() - started;
  return report;
}
