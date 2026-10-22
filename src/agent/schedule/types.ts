/**
 * 定时任务共用类型（设计 docs/ARCHITECTURE.md §6）。
 * 定义与排程（第 4、5 步）和触发后的执行（第 6 步）都以本文件为契约，改动须两边同步。
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
  /** skipped 的原因：stale（迟到/停机）、overlap（上一轮未完）、interrupted（输入写入后提交前中断）、paused、revision */
  reason?: "stale" | "overlap" | "interrupted" | "paused" | "revision" | "timeout" | "backend_failed";
  /** 停机合并跳过的次数 */
  skipped_count?: number;
  started_at?: number;
  ended_at?: number;
  /** 本次运行经 send_message 发出的条数 */
  sent?: number;
  /** 最终回答前 200 字，作为运行记录（相当于 Codex 的 memory.md） */
  note?: string;
  /** 定时输入的入站键（run_ 开头），用于 trace 与运行记录 */
  input_key?: string;
}

export interface Schedule {
  id: string;
  /** 每次修改（含暂停 / 恢复）+1；排程任务以它判断自己是否过期 */
  revision: number;
  name: string;
  prompt: string;
  /** 创建时的来源会话，不可修改：决定在哪个线程里跑、读取范围、不带 target 时发到哪 */
  conversation: ScheduleConversation;
  rule: ScheduleRule;
  status: ScheduleStatus;
  pause_reason?: string;
  mode: "thread";
  options: { stale_after_ms: number; timeout_ms: number };
  /** 创建者 "qq:<号>"；每次运行按创建者当时的授权判定 */
  created_by: string;
  created_at: number;
  updated_at: number;
  /** 下一次计划触发时刻；暂停 / 完成时为 null */
  next_fire_at: number | null;
  /** 连续失败次数，达到 3 自动暂停 */
  failures: number;
  /** 最近 20 次运行，新的在后；queued/running 不裁剪，在途超过上限时全部保留。 */
  runs: ScheduleRun[];
}

export interface SchedulesState {
  schedules: Record<string, Schedule>;
}

/** 一次已通过判定、要执行的触发。由排程任务在 fire 阶段的同一次提交里交给执行侧。 */
export interface ScheduledFire {
  schedule: Readonly<Schedule>;
  fire_at: number;
  fire_key: string;
  /** 本次是第几次运行（从 1 起） */
  ordinal: number;
}

/**
 * 执行侧实现、排程侧调用的接口（设计 docs/ARCHITECTURE.md §6）。
 * admit 必须只用传入的 tx 读写，并在同一次提交里登记运行文档；同一 fire_key 重复调用返回同一个输入键（幂等）。
 */
export interface ScheduledRunAdmitter {
  /** 未采用预备结果时结束预备的定时输入；必须先检查同一输入是否已被另一提交接管。 */
  discard?(tx: unknown): Promise<void>;
  /** skipped 表示已结束的孤儿输入不能重跑；排程侧须记 skipped(interrupted) 并解除 in_flight，不累计失败。 */
  admit(tx: unknown, fire: ScheduledFire): Promise<{ key: string; skipped?: boolean }>;
}

/**
 * 排程与执行的接线：prepare 在事务外冻结并写入定时输入，admit 在事务内登记；
 * launch 只在提交成功后把输入交给会话宿主，不等待回合结束。
 */
export interface ScheduledRunLauncher {
  prepare(fire: ScheduledFire): Promise<ScheduledRunAdmitter>;
  launch(key: string): void;
}

/** 执行结束后回写运行结果（第 6 步调用，第 4 步的 ScheduleService 实现）。 */
export interface ScheduleRunRecorder {
  recordRun(scheduleId: string, run: ScheduleRun): Promise<void>;
}
