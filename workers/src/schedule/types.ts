/**
 * 云端定时任务契约，供 ScheduleDO、工具与管理接口共用。
 * ScheduleDO 的表、聊天工具与 ThreadDO 的回写都以本文件为准，改动须各处同步。
 */

/** 会话键：与线程键一致；owner 私聊为 "owner"。 */
export type ScheduleConversation = "owner" | `group:${string}` | `private:${string}`;

export type ScheduleRule =
  /** RRULE 正文（不含 DTSTART），如 "FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=8;BYMINUTE=30"；dtstart 为首次计算的起点（ms）。时区固定 Asia/Shanghai。 */
  | { kind: "rrule"; rrule: string; dtstart: number }
  /** 一次性：at 为触发时刻（ms）。 */
  | { kind: "at"; at: number };

export type ScheduleStatus = "active" | "paused" | "completed";

export type ScheduleRunStatus = "queued" | "running" | "sent" | "silent" | "failed" | "skipped";

export interface ScheduleRun {
  /** `${schedule_id}@${fire_at}`，全链路幂等键 */
  fire_key: string;
  fire_at: number;
  status: ScheduleRunStatus;
  /** skipped 的原因：stale（迟到/停机）、overlap（上一轮未完）、interrupted（输入丢失）；failed 的原因：backend_failed */
  reason?: "stale" | "overlap" | "interrupted" | "paused" | "revision" | "timeout" | "backend_failed";
  /** 停机合并跳过的次数 */
  skipped_count?: number;
  started_at?: number;
  ended_at?: number;
  /** 本次运行经 send_message 发出的条数 */
  sent?: number;
  /** 最终回答前 200 字，作为运行记录 */
  note?: string;
  /** 定时输入的入站键（run_<fire_key>） */
  input_key?: string;
}

export interface Schedule {
  id: string;
  /** 每次修改（含暂停 / 恢复）+1 */
  revision: number;
  name: string;
  prompt: string;
  /** 创建时的来源会话，不可修改：决定在哪个线程里跑、send_message 发到哪 */
  conversation: ScheduleConversation;
  rule: ScheduleRule;
  status: ScheduleStatus;
  pause_reason?: string;
  mode: "thread";
  options: { stale_after_ms: number; timeout_ms: number };
  /** 创建者 "qq:<号>" */
  created_by: string;
  created_at: number;
  updated_at: number;
  /** 下一次计划触发时刻；暂停 / 完成时为 null */
  next_fire_at: number | null;
  /** 连续失败次数，达到 3 自动暂停 */
  failures: number;
  /** 最近 20 次已结束的运行加全部在途运行，新的在后 */
  runs: ScheduleRun[];
}

export type CreateSchedule = Pick<Schedule, "name" | "prompt" | "conversation" | "rule">;
export type UpdateSchedule = Partial<Pick<Schedule, "name" | "prompt" | "rule">>;
